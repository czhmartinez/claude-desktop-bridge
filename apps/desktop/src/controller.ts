import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  BridgeCrypto,
  ARTIFACT_TRANSFER_TTL_MS,
  PAIRING_SCHEMA_VERSION,
  PROTOCOL_VERSION,
  RelayTransport,
  TransportRouter,
  WebRtcTransport,
  bridgeIceServers,
  buildPairingUrl,
  cryptoWithRelayEndpoint,
  relayPathForUrl,
  type BridgeAttachment,
  type BridgeDeviceInfo,
  type BridgeEndpoint,
  type BridgeEffort,
  type BridgeEvent,
  type BridgePermissionMode,
  type BridgePayload,
  type BridgeRequest,
  type BridgeResponse,
  type BridgeTransport,
  type BridgeTransportCandidate,
  type BridgeTransportMetrics,
  type DesktopControlSnapshot,
  type DecryptedEnvelope,
  type EncryptedEnvelope,
  type PairingBundle,
  type SocketState,
} from "@bridge/protocol";
import type { App } from "electron";
import {
  DesktopConfigRepository,
  type LoadedDesktopConfig,
  type LoadedDeviceConfig,
} from "./config.js";
import type { SessionBroker } from "./session-broker.js";
import type { EvidenceManager } from "./evidence-manager.js";
import type { SessionEventLog } from "./session-event-log.js";
import type { ClaudeDesktopLifecycle } from "./claude-desktop-lifecycle.js";
import { isLaunchAtLoginEnabled, setLaunchAtLogin } from "./platform.js";
import type { ProviderRegistry } from "./provider-registry.js";
import type { HandoffService } from "./handoff-service.js";

export interface LocalBridgeRequest {
  method: BridgeRequest["method"];
  params?: Record<string, unknown>;
  idempotencyKey?: string;
}

class BridgeRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "BridgeRequestError";
  }
}

function stringParam(params: Record<string, unknown>, key: string, required = true): string | undefined {
  const value = params[key];
  if (typeof value === "string" && value.trim()) return value;
  if (required) throw new Error(`${key} is required`);
  return undefined;
}

function numberParam(params: Record<string, unknown>, key: string, fallback: number): number {
  const value = params[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function integerParam(params: Record<string, unknown>, key: string): number {
  const value = params[key];
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`${key} must be an integer`);
  return value;
}

function nullableStringParam(params: Record<string, unknown>, key: string): string | null | undefined {
  if (!Object.prototype.hasOwnProperty.call(params, key)) return undefined;
  const value = params[key];
  if (value === null) return null;
  if (typeof value === "string" && value.trim()) return value.trim();
  throw new Error(`${key} must be a non-empty string or null`);
}

function effortParam(params: Record<string, unknown>, key: string): BridgeEffort | null | undefined {
  const value = nullableStringParam(params, key);
  if (value === undefined || value === null) return value;
  if (["low", "medium", "high", "xhigh", "max"].includes(value)) return value as BridgeEffort;
  throw new Error("Invalid effort");
}

function permissionModeParam(
  params: Record<string, unknown>,
  key: string,
): BridgePermissionMode | null | undefined {
  const value = nullableStringParam(params, key);
  if (value === undefined || value === null) return value;
  if (value === "standard" || value === "full-access") return value;
  throw new Error("Invalid permission mode");
}

function attachmentsParam(params: Record<string, unknown>): BridgeAttachment[] {
  if (params.attachments === undefined) return [];
  if (!Array.isArray(params.attachments)) throw new Error("attachments must be an array");
  let total = 0;
  return params.attachments.map((value) => {
    if (!value || typeof value !== "object") throw new Error("Invalid attachment");
    const attachment = value as Partial<BridgeAttachment>;
    if (
      typeof attachment.id !== "string" ||
      typeof attachment.name !== "string" ||
      typeof attachment.mimeType !== "string" ||
      !["image/jpeg", "image/png", "image/gif", "image/webp"].includes(attachment.mimeType) ||
      typeof attachment.size !== "number" ||
      typeof attachment.data !== "string"
    ) throw new Error("Invalid image attachment");
    total += attachment.size;
    if (attachment.size > 4 * 1024 * 1024 || total > 6 * 1024 * 1024) {
      throw new Error("Image attachments exceed the 6 MB limit");
    }
    return attachment as BridgeAttachment;
  });
}

function relayReadyUrl(endpoint: string): string {
  const url = new URL(endpoint);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "/ready";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function redactedEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  const fingerprint = createHash("sha256").update(url.host).digest("hex").slice(0, 10);
  return `${url.protocol}//relay-${fingerprint}${url.pathname}`;
}

function pairingForDevice(config: LoadedDesktopConfig, device: LoadedDeviceConfig): PairingBundle {
  return {
    version: PAIRING_SCHEMA_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    hostId: config.hostDeviceId,
    pairingEpoch: config.pairingEpoch,
    roomId: config.roomId,
    deviceId: device.deviceId,
    secret: device.secret,
    relayUrl: config.relayUrl,
    serviceOrigin: config.serviceOrigin,
    relayEndpoints: config.relayEndpoints,
    activeEndpoint: config.activeEndpoint,
    iceServers: config.iceServers,
    desktopName: config.desktopName,
    createdAt: device.createdAt,
    expiresAt: device.expiresAt,
    singleUse: true,
  };
}

function errorResponse(requestId: string, error: unknown): BridgeResponse {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof BridgeRequestError) {
    return {
      kind: "response",
      requestId,
      ok: false,
      error: {
        code: error.code,
        message,
        retryable: error.retryable,
      },
    };
  }
  const retryable = /unavailable|busy|offline|connect|runtime/iu.test(message);
  return {
    kind: "response",
    requestId,
    ok: false,
    error: {
      code: message.toLocaleUpperCase().replace(/[^A-Z0-9]+/gu, "_").slice(0, 80) || "REQUEST_FAILED",
      message,
      retryable,
    },
  };
}

export class DesktopController extends EventEmitter {
  private config: LoadedDesktopConfig | undefined;
  private hostCrypto: BridgeCrypto | undefined;
  private socket: BridgeTransport | undefined;
  private connection: SocketState = "idle";
  private currentPairingDeviceId: string | undefined;
  private readonly deviceCryptos = new Map<string, BridgeCrypto>();
  private readonly onlineDevices = new Set<string>();
  private readonly responseCache = new Map<string, BridgeResponse>();
  private lastSeenAt = Date.now();
  private transportMetrics: BridgeTransportMetrics | undefined;
  private relayHealthy = false;

  constructor(
    private readonly app: App,
    private readonly repository: DesktopConfigRepository,
    private readonly pairingBaseUrl: string,
    private readonly relayConnectUrl: string,
    private readonly broker: SessionBroker,
    private readonly eventLog: SessionEventLog,
    private readonly evidence: EvidenceManager,
    private readonly claudeDesktop: ClaudeDesktopLifecycle,
    private readonly RTCPeerConnectionImpl?: typeof RTCPeerConnection,
    private readonly providers?: ProviderRegistry,
    private readonly handoffs?: HandoffService,
  ) {
    super();
  }

  async initialize(): Promise<void> {
    this.config = await this.repository.loadOrCreate();
    this.config.managedDesktopEnabled = false;
    this.config.launchAtLogin = await isLaunchAtLoginEnabled(this.app);
    await this.repository.save(this.config);
    this.broker.setDefaultPermissionMode(this.config.defaultPermissionMode);
    this.hostCrypto = await BridgeCrypto.fromHostSecret({
      hostId: this.config.hostDeviceId,
      pairingEpoch: this.config.pairingEpoch,
      roomId: this.config.roomId,
      relayUrl: this.config.relayUrl,
      desktopName: this.config.desktopName,
      deviceId: this.config.hostDeviceId,
      secret: this.config.hostSecret,
    });
    for (const device of this.config.devices.filter((candidate) => !candidate.revokedAt)) {
      const crypto = await BridgeCrypto.fromPairing(pairingForDevice(this.config, device), {
        deviceId: this.config.hostDeviceId,
        ignoreExpiry: true,
      });
      this.deviceCryptos.set(device.deviceId, crypto);
    }
    this.eventLog.on("event", (event: BridgeEvent) => {
      this.emit("event", event);
      void this.broadcast({ kind: "event", event });
      void this.publish();
    });
    this.broker.on("changed", () => void this.publish());
    await this.broker.initialize();
    if (this.providers) {
      this.providers.on("updated", (profile) => {
        void this.eventLog.append({
          origin: "system",
          type: "provider.updated",
          data: { profile },
        });
        void this.publish();
      });
      await this.providers.initialize();
    }
    await this.handoffs?.initialize();
    await this.connect();
    if (!this.config.devices.some((device) => (
      !device.revokedAt && (Boolean(device.pairedAt) || device.expiresAt > Date.now())
    ))) {
      await this.createPairing();
    }
  }

  async snapshot(): Promise<DesktopControlSnapshot> {
    if (!this.config) throw new Error("Desktop controller is not initialized");
    const currentPairing = this.currentPairingDeviceId
      ? this.config.devices.find((device) => device.deviceId === this.currentPairingDeviceId && !device.revokedAt)
      : undefined;
    return {
      host: {
        hostId: this.config.hostDeviceId,
        pairingEpoch: this.config.pairingEpoch,
        name: this.config.desktopName,
        relayUrl: this.config.relayUrl,
        online: this.connection === "connected",
        lastSeenAt: this.lastSeenAt,
        version: this.app.getVersion(),
        capabilities: [
          "evidence.v1",
          "artifact.preview.v1",
          "artifact.transfer.v1",
          "provider.profile.v1",
          "conversation.lanes.v1",
          "conversation.handoff.v1",
          "permission.policy.v1",
        ],
        defaultPermissionMode: this.config.defaultPermissionMode,
      },
      projects: this.broker.listProjects(),
      sessions: this.broker.listSessions(),
      devices: this.deviceSnapshots(),
      runtime: this.broker.runtimeStatus(),
      transport: {
        path: this.socket?.path ?? relayPathForUrl(this.config.relayUrl),
        state: this.connection,
        pendingCount: 0,
        relayHealthy: this.relayHealthy,
        ...(this.transportMetrics?.rttMs !== undefined ? { rttMs: this.transportMetrics.rttMs } : {}),
        ...(this.transportMetrics?.lastConnectedAt !== undefined
          ? { lastConnectedAt: this.transportMetrics.lastConnectedAt }
          : {}),
      },
      permissions: this.broker.permissionBroker.list().map((request) => ({
        requestId: request.requestId,
        sessionId: request.sessionId,
        toolUseId: request.toolUseId,
        toolName: request.toolName,
        input: request.input,
        createdAt: request.createdAt,
        ...(request.title ? { title: request.title } : {}),
        ...(request.displayName ? { displayName: request.displayName } : {}),
        ...(request.description ? { description: request.description } : {}),
        canAllowAlways: request.suggestions.some((suggestion) => suggestion.destination === "localSettings"),
      })),
      ...(this.providers ? { providers: this.providers.list() } : {}),
      latestSeq: this.eventLog.latestSeq(),
      connection: this.connection,
      launchAtLogin: this.config.launchAtLogin,
      managedDesktopEnabled: this.config.managedDesktopEnabled,
      claudeDesktop: await this.claudeDesktop.status(),
      ...(currentPairing ? {
        pairingUrl: buildPairingUrl(this.pairingBaseUrl, pairingForDevice(this.config, currentPairing)),
        pairingExpiresAt: currentPairing.expiresAt,
      } : {}),
    };
  }

  async createPairing(): Promise<DesktopControlSnapshot> {
    if (!this.config) throw new Error("Desktop controller is not initialized");
    const created = await BridgeCrypto.createDevicePairing({
      hostId: this.config.hostDeviceId,
      pairingEpoch: this.config.pairingEpoch,
      roomId: this.config.roomId,
      relayUrl: this.config.relayUrl,
      desktopName: this.config.desktopName,
      serviceOrigin: this.config.serviceOrigin,
      relayEndpoints: this.config.relayEndpoints,
      activeEndpoint: this.config.activeEndpoint,
      iceServers: this.config.iceServers,
    });
    const device: LoadedDeviceConfig = {
      deviceId: created.pairing.deviceId,
      name: "手机 Bridge",
      platform: "unknown",
      secret: created.pairing.secret,
      createdAt: created.pairing.createdAt,
      expiresAt: created.pairing.expiresAt,
    };
    this.config.devices = [
      device,
      ...this.config.devices.filter((candidate) => candidate.pairedAt || candidate.expiresAt > Date.now()),
    ];
    this.currentPairingDeviceId = device.deviceId;
    this.deviceCryptos.set(device.deviceId, created.desktopCrypto.withSenderDevice(this.config.hostDeviceId));
    await this.repository.save(this.config);
    this.registerPendingDevices();
    return this.publish();
  }

  async setAnthropicApiKey(value: string): Promise<DesktopControlSnapshot> {
    if (!this.providers) throw new Error("Provider registry is unavailable");
    await this.providers.setAnthropicApiKey(value);
    return this.snapshot();
  }

  async removeAnthropicApiKey(): Promise<DesktopControlSnapshot> {
    if (!this.providers) throw new Error("Provider registry is unavailable");
    await this.providers.removeAnthropicApiKey();
    return this.snapshot();
  }

  async revokeDevice(deviceId: string): Promise<DesktopControlSnapshot> {
    if (!this.config) throw new Error("Desktop controller is not initialized");
    const device = this.config.devices.find((candidate) => candidate.deviceId === deviceId);
    if (!device || device.revokedAt) return this.snapshot();
    device.revokedAt = Date.now();
    this.onlineDevices.delete(deviceId);
    this.deviceCryptos.delete(deviceId);
    if (this.currentPairingDeviceId === deviceId) this.currentPairingDeviceId = undefined;
    await this.repository.save(this.config);
    if (this.connection === "connected") this.socket?.revokeDevice(deviceId);
    await this.eventLog.append({
      itemId: deviceId,
      origin: "desktop",
      type: "device.revoked",
      data: { deviceId },
    });
    return this.publish();
  }

  async setLaunchAtLogin(enabled: boolean): Promise<DesktopControlSnapshot> {
    if (!this.config) throw new Error("Desktop controller is not initialized");
    await setLaunchAtLogin(this.app, enabled);
    this.config.launchAtLogin = enabled;
    await this.repository.save(this.config);
    return this.publish();
  }

  async launchClaudeDesktop(): Promise<DesktopControlSnapshot> {
    await this.claudeDesktop.launch();
    const snapshot = await this.publish();
    await this.broadcast({ kind: "snapshot", snapshot });
    return snapshot;
  }

  async quitClaudeDesktop(): Promise<DesktopControlSnapshot> {
    await this.claudeDesktop.quit();
    const snapshot = await this.publish();
    await this.broadcast({ kind: "snapshot", snapshot });
    return snapshot;
  }

  async dispatchLocal(input: LocalBridgeRequest): Promise<BridgeResponse> {
    const request: BridgeRequest = {
      kind: "request",
      requestId: randomUUID(),
      idempotencyKey: input.idempotencyKey ?? randomUUID(),
      method: input.method,
      params: input.params ?? {},
    };
    try {
      const result = await this.handleRequest(request, "desktop");
      return { kind: "response", requestId: request.requestId, ok: true, result };
    } catch (error) {
      return errorResponse(request.requestId, error);
    }
  }

  diagnostics(): Record<string, unknown> {
    if (!this.config) throw new Error("Desktop controller is not initialized");
    return {
      generatedAt: new Date().toISOString(),
      bridgeVersion: this.app.getVersion(),
      protocolVersion: PROTOCOL_VERSION,
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      relay: {
        endpoint: redactedEndpoint(this.config.relayUrl),
        connectionEndpoint: redactedEndpoint(this.relayConnectUrl),
        connection: this.connection,
        path: this.socket?.path,
        rttMs: this.transportMetrics?.rttMs,
        healthy: this.relayHealthy,
      },
      runtime: this.broker.runtimeStatus(),
      counts: {
        projects: this.broker.listProjects().length,
        sessions: this.broker.listSessions().length,
        devices: this.config.devices.filter((device) => !device.revokedAt).length,
        pendingPermissions: this.broker.permissionBroker.list().length,
      },
      latestEventSeq: this.eventLog.latestSeq(),
    };
  }

  async close(): Promise<void> {
    this.socket?.close();
    await this.handoffs?.close();
  }

  pauseForSleep(): void {
    this.socket?.close();
    this.socket = undefined;
    this.connection = "closed";
    this.relayHealthy = false;
    void this.publish();
  }

  async reconnect(): Promise<void> {
    this.socket?.close();
    this.socket = undefined;
    this.connection = "reconnecting";
    await this.publish();
    await this.broker.refreshRuntime();
    await this.connect();
  }

  async refreshRuntime(): Promise<void> {
    await this.broker.refreshRuntime();
    await this.publish();
  }

  private async connect(): Promise<void> {
    if (!this.config || !this.hostCrypto) return;
    const localConnectUrl = relayPathForUrl(this.relayConnectUrl) === "lan-relay"
      ? this.relayConnectUrl
      : undefined;
    const candidateEndpoints = this.config.relayEndpoints
      .filter((endpoint): endpoint is BridgeEndpoint & {
        kind: "public-relay" | "lan-relay";
      } => endpoint.kind !== "direct")
      .map((endpoint) => ({
        endpoint,
        connectUrl: endpoint.kind === "lan-relay" && localConnectUrl
          ? localConnectUrl
          : endpoint.url,
      }));
    const candidates: BridgeTransportCandidate[] = candidateEndpoints.map(({ endpoint, connectUrl }) => ({
      id: endpoint.id,
      path: endpoint.kind,
      endpoint: connectUrl,
      priority: endpoint.priority,
      create: () => new RelayTransport({
        crypto: cryptoWithRelayEndpoint(this.hostCrypto!, connectUrl),
        role: "desktop",
        createRoom: true,
        reconnect: false,
        path: endpoint.kind,
        resolveCrypto: (envelope) => this.deviceCryptos.get(envelope.fromDeviceId),
      }),
    }));
    const relay = new TransportRouter(candidates);
    const socket: BridgeTransport = this.RTCPeerConnectionImpl
      ? new WebRtcTransport({
          relay,
          crypto: this.hostCrypto,
          role: "desktop",
          RTCPeerConnectionImpl: this.RTCPeerConnectionImpl,
          iceServers: bridgeIceServers(this.config.iceServers),
          resolveCrypto: (envelope) => this.deviceCryptos.get(envelope.fromDeviceId),
          resolvePeerCrypto: (deviceId) => this.deviceCryptos.get(deviceId),
        })
      : relay;
    this.socket = socket;
    socket.onState((connection) => {
      this.connection = connection;
      if (connection === "connected") {
        this.lastSeenAt = Date.now();
        const active = candidateEndpoints.find((candidate) => candidate.connectUrl === socket.endpoint);
        if (active && this.config && this.config.activeEndpoint !== active.endpoint.id) {
          this.config.activeEndpoint = active.endpoint.id;
          this.config.relayUrl = active.endpoint.url;
          this.config.migratedAt = Date.now();
          void this.repository.save(this.config);
        }
        this.registerPendingDevices();
        void this.checkRelayHealth(socket.endpoint);
      } else if (connection === "closed" || connection === "reconnecting") {
        this.relayHealthy = false;
      }
      void this.publish();
    });
    socket.onMetrics((metrics) => {
      this.transportMetrics = metrics;
      void this.publish();
    });
    socket.onFrame((frame) => {
      if (frame.type === "ready") {
        this.onlineDevices.clear();
        for (const device of frame.onlineDevices) {
          if (device.role === "mobile") this.onlineDevices.add(device.deviceId);
        }
        this.registerPendingDevices();
      }
      if (frame.type === "presence" && frame.role === "mobile") {
        if (frame.online) {
          this.onlineDevices.add(frame.deviceId);
          void this.rememberDevice(frame.deviceId);
          void this.sendSnapshot(frame.deviceId);
        } else {
          this.onlineDevices.delete(frame.deviceId);
          void this.rememberDevice(frame.deviceId);
        }
      }
      void this.publish();
    });
    socket.onMessage((message, encrypted) => {
      void this.receiveMessage(message, encrypted);
    });
    socket.connect();
  }

  private async checkRelayHealth(endpoint: string): Promise<void> {
    try {
      const response = await fetch(relayReadyUrl(endpoint), {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(4_000),
      });
      if (this.socket?.endpoint !== endpoint) return;
      this.relayHealthy = response.ok;
    } catch {
      if (this.socket?.endpoint !== endpoint) return;
      this.relayHealthy = false;
    }
    await this.publish();
  }

  private async receiveMessage(message: DecryptedEnvelope, encrypted: EncryptedEnvelope): Promise<void> {
    if (message.header.from !== "mobile" || message.payload.kind !== "request") {
      this.socket?.ack([encrypted.id]);
      return;
    }
    await this.rememberDevice(message.header.fromDeviceId, message.payload.params);
    const cached = this.responseCache.get(message.payload.requestId);
    if (cached) {
      await this.sendToDevice(cached, message.header.fromDeviceId);
      this.socket?.ack([encrypted.id]);
      return;
    }
    let response: BridgeResponse;
    try {
      const result = await this.handleRequest(message.payload, "mobile", message.header.fromDeviceId);
      response = { kind: "response", requestId: message.payload.requestId, ok: true, result };
    } catch (error) {
      response = errorResponse(message.payload.requestId, error);
    }
    if (
      message.payload.method !== "artifact.preview" &&
      message.payload.method !== "artifact.transfer.read"
    ) this.cacheResponse(response);
    await this.sendToDevice(
      response,
      message.header.fromDeviceId,
      message.payload.method.startsWith("artifact.") ? ARTIFACT_TRANSFER_TTL_MS : undefined,
      message.payload.method.startsWith("artifact."),
    ).catch(() => undefined);
    this.socket?.ack([encrypted.id]);
    if (
      message.payload.method === "device.revoke" &&
      response.ok &&
      stringParam(message.payload.params, "deviceId") === message.header.fromDeviceId
    ) {
      setTimeout(() => void this.revokeDevice(message.header.fromDeviceId), 250);
    }
  }

  private async handleRequest(
    request: BridgeRequest,
    origin: "desktop" | "mobile",
    sourceDeviceId?: string,
  ): Promise<unknown> {
    const params = request.params;
    if (request.method === "claude.desktop.status") {
      return { claudeDesktop: await this.claudeDesktop.status(true) };
    }
    if (request.method === "claude.desktop.launch") {
      return { claudeDesktop: (await this.launchClaudeDesktop()).claudeDesktop };
    }
    if (request.method === "claude.desktop.quit") {
      return { claudeDesktop: (await this.quitClaudeDesktop()).claudeDesktop };
    }
    if (request.method === "project.list") return { projects: this.broker.listProjects() };
    if (request.method === "provider.list") {
      if (!this.providers) throw new Error("Provider registry is unavailable");
      return { providers: this.providers.list() };
    }
    if (request.method === "provider.refresh") {
      if (!this.providers) throw new Error("Provider registry is unavailable");
      return {
        providers: await this.providers.refresh(stringParam(params, "profileId", false)),
      };
    }
    if (request.method === "conversation.route.get") {
      return {
        route: this.broker.conversationRoute(stringParam(params, "sessionId")!),
      };
    }
    if (request.method === "conversation.switch.preview") {
      if (!this.handoffs) throw new Error("Conversation handoff is unavailable");
      const model = stringParam(params, "model", false);
      return this.handoffs.preview({
        sessionId: stringParam(params, "sessionId")!,
        targetProviderProfileId: stringParam(params, "targetProviderProfileId")!,
        ...(model ? { model } : {}),
      });
    }
    if (request.method === "conversation.switch.commit") {
      if (!this.handoffs) throw new Error("Conversation handoff is unavailable");
      const targetNativeSessionId = stringParam(params, "targetNativeSessionId", false);
      const model = stringParam(params, "model", false);
      return this.handoffs.commit({
        handoffId: stringParam(params, "handoffId")!,
        ...(targetNativeSessionId ? { targetNativeSessionId } : {}),
        ...(model ? { model } : {}),
      });
    }
    if (request.method === "conversation.switch.cancel") {
      if (!this.handoffs) throw new Error("Conversation handoff is unavailable");
      return this.handoffs.cancel(stringParam(params, "handoffId")!);
    }
    if (request.method === "handoff.get") {
      if (!this.handoffs) throw new Error("Conversation handoff is unavailable");
      return { handoff: this.handoffs.get(stringParam(params, "handoffId")!) };
    }
    if (request.method === "session.list") {
      return {
        sessions: this.broker.listSessions(
          stringParam(params, "projectId", false),
          stringParam(params, "search", false),
        ),
      };
    }
    if (request.method === "session.open") {
      const sessionId = stringParam(params, "sessionId")!;
      const session = this.broker.session(sessionId);
      if (!session) throw new Error("Session not found");
      return {
        session,
        history: await this.broker.history(sessionId, undefined, 50),
        latestSeq: this.eventLog.latestSeq(),
      };
    }
    if (request.method === "session.create") {
      return {
        session: await this.broker.createSession(
          stringParam(params, "cwd")!,
          stringParam(params, "title", false),
        ),
      };
    }
    if (request.method === "session.history") {
      return {
        history: await this.broker.history(
          stringParam(params, "sessionId")!,
          stringParam(params, "cursor", false),
          numberParam(params, "limit", 50),
        ),
      };
    }
    if (request.method === "session.configuration") {
      return {
        configuration: await this.broker.configuration(stringParam(params, "sessionId")!),
      };
    }
    if (request.method === "session.configure") {
      const sessionId = stringParam(params, "sessionId")!;
      const input: Parameters<SessionBroker["configureSession"]>[0] = { sessionId };
      if (Object.prototype.hasOwnProperty.call(params, "model")) {
        const model = nullableStringParam(params, "model");
        if (model !== undefined) input.model = model;
      }
      if (Object.prototype.hasOwnProperty.call(params, "effort")) {
        const effort = effortParam(params, "effort");
        if (effort !== undefined) input.effort = effort;
      }
      const configuration = await this.broker.configureSession(input);
      return { configuration, session: this.broker.session(sessionId) };
    }
    if (request.method === "session.desktop.register") {
      return {
        session: await this.broker.registerDesktopSession(
          stringParam(params, "sessionId")!,
        ),
      };
    }
    if (request.method === "session.fallback.confirm") {
      return {
        session: await this.broker.confirmFallback(stringParam(params, "sessionId")!),
      };
    }
    if (request.method === "message.delivery.resolve") {
      const action = stringParam(params, "action")!;
      if (action !== "confirm" && action !== "retry") throw new Error("Invalid uncertain delivery action");
      const turn = await this.broker.resolveUncertainDelivery(
        stringParam(params, "commandId")!,
        action,
      );
      return { commandId: turn.commandId, state: turn.state };
    }
    if (request.method === "turn.start" || request.method === "turn.steer") {
      const input = {
        requestId: request.requestId,
        idempotencyKey: request.idempotencyKey,
        sessionId: stringParam(params, "sessionId")!,
        text: stringParam(params, "text", false) ?? "",
        attachments: attachmentsParam(params),
        origin,
        ...(sourceDeviceId ? { sourceDeviceId } : {}),
      };
      const turn = request.method === "turn.steer"
        ? await this.broker.steerTurn(input)
        : await this.broker.startTurn(input);
      return { commandId: turn.commandId, state: turn.state };
    }
    if (request.method === "turn.interrupt") {
      return {
        interrupted: await this.broker.interruptTurn(
          stringParam(params, "sessionId")!,
          stringParam(params, "commandId", false),
          params.force === true,
        ),
      };
    }
    if (request.method === "permission.resolve") {
      const decision = stringParam(params, "decision")!;
      if (!["allow-once", "allow-always", "deny"].includes(decision)) throw new Error("Invalid permission decision");
      const resolver = origin === "mobile"
        ? {
            deviceId: sourceDeviceId ?? "mobile",
            name: this.config?.devices.find((device) => device.deviceId === sourceDeviceId)?.name ?? "手机 Bridge",
          }
        : {
            deviceId: this.config?.hostDeviceId ?? "desktop",
            name: this.config?.desktopName ?? "电脑端 Bridge",
          };
      const resolved = this.broker.resolvePermission(
        stringParam(params, "requestId")!,
        decision as "allow-once" | "allow-always" | "deny",
        stringParam(params, "message", false),
        params.updatedInput && typeof params.updatedInput === "object" && !Array.isArray(params.updatedInput)
          ? params.updatedInput as Record<string, unknown>
          : undefined,
        resolver,
      );
      if (!resolved) {
        throw new BridgeRequestError(
          "ALREADY_RESOLVED",
          "这项授权已由其他设备处理。",
        );
      }
      return {
        resolved: true,
      };
    }
    if (request.method === "permission.policy.configure") {
      const scope = stringParam(params, "scope")!;
      if (scope !== "host" && scope !== "session") throw new Error("Invalid permission policy scope");
      const mode = permissionModeParam(params, "mode");
      const sessionId = stringParam(params, "sessionId", false);
      const actor = origin === "mobile"
        ? {
            deviceId: sourceDeviceId ?? "mobile",
            name: this.config?.devices.find((device) => device.deviceId === sourceDeviceId)?.name ?? "手机 Bridge",
          }
        : {
            deviceId: this.config?.hostDeviceId ?? "desktop",
            name: this.config?.desktopName ?? "电脑端 Bridge",
          };
      if (scope === "host") {
        if (!mode) throw new Error("Host permission mode is required");
        if (!this.config) throw new Error("Desktop controller is not initialized");
        this.config.defaultPermissionMode = mode;
        await this.repository.save(this.config);
        await this.eventLog.append({
          ...(sessionId ? { sessionId } : {}),
          origin,
          type: "permission.policy.changed",
          data: {
            scope,
            mode,
            effectiveMode: mode,
            source: "host",
            changedByDeviceId: actor.deviceId,
            changedByName: actor.name,
          },
        });
        const resolvedPending = this.broker.setDefaultPermissionMode(mode);
        const configuration = sessionId && this.broker.session(sessionId)
          ? await this.broker.configuration(sessionId, false)
          : undefined;
        return {
          defaultPermissionMode: mode,
          resolvedPending,
          ...(configuration ? { configuration } : {}),
        };
      }
      if (!sessionId) throw new Error("sessionId is required");
      if (mode === undefined) throw new Error("mode is required");
      const configured = await this.broker.configurePermissionPolicy(sessionId, mode);
      await this.eventLog.append({
        sessionId,
        origin,
        type: "permission.policy.changed",
        data: {
          scope,
          mode,
          effectiveMode: configured.configuration.permissionPolicy?.effectiveMode ?? "standard",
          source: configured.configuration.permissionPolicy?.source ?? "host",
          changedByDeviceId: actor.deviceId,
          changedByName: actor.name,
        },
      });
      return configured;
    }
    if (request.method === "events.resume") {
      const afterSeq = numberParam(params, "afterSeq", 0);
      const bootstrap = params.bootstrap === true && afterSeq === 0;
      if (bootstrap) {
        const latestSeq = this.eventLog.latestSeq();
        return {
          events: [],
          latestSeq,
          nextSeq: latestSeq,
          hasMore: false,
        };
      }
      const events = this.eventLog.replay(
        afterSeq,
        numberParam(params, "limit", 500),
        stringParam(params, "sessionId", false),
      );
      const latestSeq = this.eventLog.latestSeq();
      const nextSeq = events.at(-1)?.seq ?? afterSeq;
      return {
        events,
        latestSeq,
        nextSeq,
        hasMore: nextSeq < latestSeq,
      };
    }
    if (request.method === "evidence.list") {
      const sessionId = stringParam(params, "sessionId")!;
      if (!this.broker.session(sessionId)) throw new Error("Session not found");
      return {
        evidence: this.evidence.list(
          sessionId,
          stringParam(params, "cursor", false),
          numberParam(params, "limit", 30),
        ),
      };
    }
    if (request.method === "evidence.get") {
      const evidence = this.evidence.get(stringParam(params, "evidenceId")!);
      if (!evidence) throw new Error("Evidence not found");
      return { evidence };
    }
    if (request.method === "artifact.preview") {
      return {
        preview: await this.evidence.preview(stringParam(params, "artifactId")!),
      };
    }
    if (request.method === "artifact.transfer.open") {
      return {
        transfer: await this.evidence.openTransfer(
          stringParam(params, "artifactId")!,
          sourceDeviceId ?? "desktop",
        ),
      };
    }
    if (request.method === "artifact.transfer.read") {
      return {
        chunk: this.evidence.readTransfer(
          stringParam(params, "transferId")!,
          integerParam(params, "index"),
          sourceDeviceId ?? "desktop",
        ),
      };
    }
    if (request.method === "artifact.transfer.close") {
      return {
        closed: this.evidence.closeTransfer(
          stringParam(params, "transferId")!,
          sourceDeviceId ?? "desktop",
        ),
      };
    }
    if (request.method === "device.revoke") {
      const deviceId = stringParam(params, "deviceId")!;
      if (origin === "mobile" && sourceDeviceId !== deviceId) throw new Error("A phone can only revoke itself");
      return { scheduled: true, deviceId };
    }
    throw new Error("Unsupported request method");
  }

  private async sendSnapshot(deviceId: string): Promise<void> {
    await this.sendToDevice({ kind: "snapshot", snapshot: await this.snapshot() }, deviceId).catch(() => undefined);
  }

  private async sendToDevice(
    payload: BridgePayload,
    deviceId: string,
    ttlMs?: number,
    temporary = false,
  ): Promise<string> {
    if (!this.socket || this.connection !== "connected") throw new Error("Bridge is not connected");
    const crypto = this.deviceCryptos.get(deviceId);
    if (!crypto) throw new Error("Device key is unavailable");
    return this.socket.send(payload, "mobile", {
      toDeviceId: deviceId,
      crypto,
      ...(ttlMs !== undefined ? { ttlMs } : {}),
      ...(temporary ? { temporary: true } : {}),
    });
  }

  private async broadcast(payload: BridgePayload): Promise<void> {
    const devices = this.config?.devices.filter((device) => device.pairedAt && !device.revokedAt) ?? [];
    await Promise.allSettled(devices.map((device) => this.sendToDevice(payload, device.deviceId)));
  }

  private registerPendingDevices(): void {
    if (!this.config || !this.socket || this.connection !== "connected") return;
    const now = Date.now();
    for (const device of this.config.devices) {
      if (device.revokedAt) {
        try {
          this.socket.revokeDevice(device.deviceId);
        } catch {
          // Revocation is replayed whenever another endpoint becomes active.
        }
        continue;
      }
      const crypto = this.deviceCryptos.get(device.deviceId);
      if (!crypto) continue;
      try {
        if (device.pairedAt && this.socket.path === "public-relay") {
          this.socket.registerDevice(
            device.deviceId,
            crypto.identity.authToken,
            now + 7 * 24 * 60 * 60 * 1_000,
            { migrate: true, pairedAt: device.pairedAt },
          );
        } else if (!device.pairedAt && device.expiresAt > now) {
          this.socket.registerDevice(device.deviceId, crypto.identity.authToken, device.expiresAt);
        }
      } catch {
        // Registration will be retried on the next reconnect.
      }
    }
  }

  private async rememberDevice(deviceId: string, metadata?: Record<string, unknown>): Promise<void> {
    if (!this.config) return;
    const device = this.config.devices.find((candidate) => candidate.deviceId === deviceId && !candidate.revokedAt);
    if (!device) return;
    const now = Date.now();
    device.pairedAt ??= now;
    device.lastSeenAt = now;
    if (this.socket?.path === "public-relay") device.publicRelayClaimedAt ??= now;
    const client = metadata?.client;
    if (client && typeof client === "object") {
      const value = client as Record<string, unknown>;
      if (typeof value.name === "string" && value.name.trim()) device.name = value.name.trim().slice(0, 80);
      if (value.platform === "android" || value.platform === "ios" || value.platform === "web") {
        device.platform = value.platform;
      }
    }
    if (this.currentPairingDeviceId === deviceId) this.currentPairingDeviceId = undefined;
    await this.repository.save(this.config);
  }

  private deviceSnapshots(): BridgeDeviceInfo[] {
    return (this.config?.devices ?? [])
      .filter((device) => device.pairedAt || device.expiresAt > Date.now())
      .map((device) => ({
        deviceId: device.deviceId,
        name: device.name,
        platform: device.platform,
        online: this.onlineDevices.has(device.deviceId),
        createdAt: device.pairedAt ?? device.createdAt,
        ...(device.lastSeenAt !== undefined ? { lastSeenAt: device.lastSeenAt } : {}),
        ...(device.revokedAt !== undefined ? { revokedAt: device.revokedAt } : {}),
      }))
      .sort((left, right) => Number(right.online) - Number(left.online) || right.createdAt - left.createdAt);
  }

  private cacheResponse(response: BridgeResponse): void {
    this.responseCache.set(response.requestId, response);
    while (this.responseCache.size > 500) {
      const oldest = this.responseCache.keys().next().value as string | undefined;
      if (oldest) this.responseCache.delete(oldest);
    }
  }

  private async publish(): Promise<DesktopControlSnapshot> {
    const snapshot = await this.snapshot();
    this.emit("snapshot", snapshot);
    return snapshot;
  }
}
