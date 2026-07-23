import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  BridgeCrypto,
  BridgeSocket,
  buildPairingUrl,
  type BridgeAttachment,
  type BridgeDeviceInfo,
  type BridgeEvent,
  type BridgeHostSnapshot,
  type BridgePayload,
  type BridgeRequest,
  type BridgeResponse,
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
import type { SessionEventLog } from "./session-event-log.js";
import { isLaunchAtLoginEnabled, setLaunchAtLogin } from "./platform.js";

export interface LocalBridgeRequest {
  method: BridgeRequest["method"];
  params?: Record<string, unknown>;
  idempotencyKey?: string;
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

function pairingForDevice(config: LoadedDesktopConfig, device: LoadedDeviceConfig): PairingBundle {
  return {
    version: 2,
    roomId: config.roomId,
    deviceId: device.deviceId,
    secret: device.secret,
    relayUrl: config.relayUrl,
    desktopName: config.desktopName,
    createdAt: device.createdAt,
    expiresAt: device.expiresAt,
    singleUse: true,
  };
}

function errorResponse(requestId: string, error: unknown): BridgeResponse {
  const message = error instanceof Error ? error.message : String(error);
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
  private socket: BridgeSocket | undefined;
  private connection: SocketState = "idle";
  private currentPairingDeviceId: string | undefined;
  private readonly deviceCryptos = new Map<string, BridgeCrypto>();
  private readonly onlineDevices = new Set<string>();
  private readonly responseCache = new Map<string, BridgeResponse>();
  private lastSeenAt = Date.now();

  constructor(
    private readonly app: App,
    private readonly repository: DesktopConfigRepository,
    private readonly pairingBaseUrl: string,
    private readonly broker: SessionBroker,
    private readonly eventLog: SessionEventLog,
  ) {
    super();
  }

  async initialize(): Promise<void> {
    this.config = await this.repository.loadOrCreate();
    this.config.launchAtLogin = await isLaunchAtLoginEnabled(this.app);
    await this.repository.save(this.config);
    this.hostCrypto = await BridgeCrypto.fromHostSecret({
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
    await this.connect();
  }

  async snapshot(): Promise<DesktopControlSnapshot> {
    if (!this.config) throw new Error("Desktop controller is not initialized");
    const currentPairing = this.currentPairingDeviceId
      ? this.config.devices.find((device) => device.deviceId === this.currentPairingDeviceId && !device.revokedAt)
      : undefined;
    return {
      host: {
        hostId: this.config.hostDeviceId,
        name: this.config.desktopName,
        relayUrl: this.config.relayUrl,
        online: this.connection === "connected",
        lastSeenAt: this.lastSeenAt,
        version: this.app.getVersion(),
      },
      projects: this.broker.listProjects(),
      sessions: this.broker.listSessions(),
      devices: this.deviceSnapshots(),
      runtime: this.broker.runtimeStatus(),
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
      })),
      latestSeq: this.eventLog.latestSeq(),
      connection: this.connection,
      launchAtLogin: this.config.launchAtLogin,
      ...(currentPairing ? {
        pairingUrl: buildPairingUrl(this.pairingBaseUrl, pairingForDevice(this.config, currentPairing)),
        pairingExpiresAt: currentPairing.expiresAt,
      } : {}),
    };
  }

  async createPairing(): Promise<DesktopControlSnapshot> {
    if (!this.config) throw new Error("Desktop controller is not initialized");
    const created = await BridgeCrypto.createDevicePairing({
      roomId: this.config.roomId,
      relayUrl: this.config.relayUrl,
      desktopName: this.config.desktopName,
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
      protocolVersion: 2,
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      relay: {
        endpoint: new URL(this.config.relayUrl).host,
        connection: this.connection,
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

  close(): void {
    this.socket?.close();
  }

  pauseForSleep(): void {
    this.socket?.close();
    this.socket = undefined;
    this.connection = "closed";
    void this.publish();
  }

  async reconnect(): Promise<void> {
    this.socket?.close();
    this.socket = undefined;
    this.connection = "reconnecting";
    await this.publish();
    await this.connect();
  }

  private async connect(): Promise<void> {
    if (!this.config || !this.hostCrypto) return;
    const socket = new BridgeSocket({
      crypto: this.hostCrypto,
      role: "desktop",
      createRoom: true,
      resolveCrypto: (envelope) => this.deviceCryptos.get(envelope.fromDeviceId),
    });
    this.socket = socket;
    socket.onState((connection) => {
      this.connection = connection;
      if (connection === "connected") {
        this.lastSeenAt = Date.now();
        this.registerPendingDevices();
      }
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
    this.cacheResponse(response);
    await this.sendToDevice(response, message.header.fromDeviceId).catch(() => undefined);
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
    if (request.method === "project.list") return { projects: this.broker.listProjects() };
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
        ),
      };
    }
    if (request.method === "permission.resolve") {
      const decision = stringParam(params, "decision")!;
      if (!["allow-once", "allow-always", "deny"].includes(decision)) throw new Error("Invalid permission decision");
      return {
        resolved: this.broker.resolvePermission(
          stringParam(params, "requestId")!,
          decision as "allow-once" | "allow-always" | "deny",
          stringParam(params, "message", false),
          params.updatedInput && typeof params.updatedInput === "object" && !Array.isArray(params.updatedInput)
            ? params.updatedInput as Record<string, unknown>
            : undefined,
        ),
      };
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

  private async sendToDevice(payload: BridgePayload, deviceId: string): Promise<string> {
    if (!this.socket || this.connection !== "connected") throw new Error("Bridge is not connected");
    const crypto = this.deviceCryptos.get(deviceId);
    if (!crypto) throw new Error("Device key is unavailable");
    return this.socket.send(payload, "mobile", {
      toDeviceId: deviceId,
      crypto,
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
      if (device.revokedAt || device.expiresAt <= now || device.pairedAt) continue;
      const crypto = this.deviceCryptos.get(device.deviceId);
      if (!crypto) continue;
      try {
        this.socket.registerDevice(device.deviceId, crypto.identity.authToken, device.expiresAt);
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
