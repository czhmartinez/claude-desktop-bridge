import { EventEmitter } from "node:events";
import {
  BridgeCrypto,
  BridgeSocket,
  buildPairingUrl,
  type BridgePayload,
  type DecryptedEnvelope,
  type EncryptedEnvelope,
  type HistoryRequestPayload,
  type SocketState,
} from "@bridge/protocol";
import type { App } from "electron";
import {
  BRIDGE_HOOK_URL,
  connectorInstallationState,
  installConnector,
  type ConnectorHookSpec,
  type ConnectorLaunchSpec,
  type ConnectorPaths,
} from "./connector.js";
import { bridgeLocalToken, DesktopConfigRepository, type LoadedDesktopConfig } from "./config.js";
import { isLaunchAtLoginEnabled, setLaunchAtLogin } from "./platform.js";

export interface ClaudeSessionSnapshot {
  sessionId: string;
  desktopSessionId?: string;
  pid?: number;
  cwd: string;
  projectName: string;
  name: string;
  startedAt: number;
  lastActivityAt: number;
  state: "running" | "idle";
  completedTasks: number;
  totalTasks: number;
  pendingTasks: number;
  currentTask?: string;
}

export interface PendingBridgeCommand {
  id: string;
  text: string;
  receivedAt: string;
  targetSessionId?: string;
}

export interface ClaudeTransportSnapshot {
  state: "waiting" | "ready" | "working" | "auth-required" | "unavailable";
  detail: string;
  lastSeenAt?: number;
  version?: string;
}

export interface ClaudeBridgeActivity {
  id: string;
  sessionId: string;
  projectName: string;
  sessionTitle: string;
  state: "queued" | "working" | "completed" | "retrying";
  command: string;
  summary?: string;
  updatedAt: number;
}

interface StoredPendingCommand extends PendingBridgeCommand {
  encrypted: EncryptedEnvelope;
  message: DecryptedEnvelope;
}

export interface DesktopSnapshot {
  desktopName: string;
  relayUrl: string;
  connection: SocketState;
  mobileOnline: boolean;
  mobilePaired: boolean;
  mobilePairedAt?: number;
  mobileLastSeenAt?: number;
  agentOnline: boolean;
  pairingUrl: string;
  connector: "not-installed" | "installed" | "needs-repair";
  claudeTransport: ClaudeTransportSnapshot;
  claudeSessions: ClaudeSessionSnapshot[];
  claudeActivities: ClaudeBridgeActivity[];
  pendingCommands: number;
  launchAtLogin: boolean;
  version: string;
}

export class DesktopController extends EventEmitter {
  private config: LoadedDesktopConfig | undefined;
  private crypto: BridgeCrypto | undefined;
  private socket: BridgeSocket | undefined;
  private connection: SocketState = "idle";
  private mobileOnline = false;
  private relayAgentOnline = false;
  private claudeSessions: ClaudeSessionSnapshot[] = [];
  private claudeTransport: ClaudeTransportSnapshot = {
    state: "waiting",
    detail: "等待 Claude 连接器建立后台续写通道。",
  };
  private claudeActivities: ClaudeBridgeActivity[] = [];
  private readonly pendingCommands = new Map<string, StoredPendingCommand>();
  private readonly acknowledgedCommandIds = new Set<string>();

  constructor(
    private readonly app: App,
    private readonly repository: DesktopConfigRepository,
    private readonly pairingBaseUrl: string,
    private readonly paths: ConnectorPaths,
    private readonly launchSpec: ConnectorLaunchSpec,
  ) { super(); }

  async initialize(): Promise<void> {
    this.config = await this.repository.loadOrCreate();
    this.config.launchAtLogin = await isLaunchAtLoginEnabled(this.app);
    await this.repository.save(this.config);
    await this.connect();
  }

  async snapshot(): Promise<DesktopSnapshot> {
    if (!this.config) throw new Error("Desktop controller is not initialized");
    return {
      desktopName: this.config.pairing.desktopName,
      relayUrl: this.config.pairing.relayUrl,
      connection: this.connection,
      mobileOnline: this.mobileOnline,
      mobilePaired: Boolean(this.config.mobilePairedAt),
      ...(this.config.mobilePairedAt !== undefined ? { mobilePairedAt: this.config.mobilePairedAt } : {}),
      ...(this.config.mobileLastSeenAt !== undefined ? { mobileLastSeenAt: this.config.mobileLastSeenAt } : {}),
      agentOnline: this.relayAgentOnline
        || this.claudeSessions.length > 0
        || this.claudeTransport.state === "ready"
        || this.claudeTransport.state === "working",
      pairingUrl: buildPairingUrl(this.pairingBaseUrl, this.config.pairing),
      connector: await connectorInstallationState(this.paths, this.launchSpec, this.connectorHookSpec()),
      claudeTransport: this.claudeTransport,
      claudeSessions: this.claudeSessions,
      claudeActivities: this.claudeActivities,
      pendingCommands: this.pendingCommands.size,
      launchAtLogin: this.config.launchAtLogin,
      version: this.app.getVersion(),
    };
  }

  async regeneratePairing(): Promise<DesktopSnapshot> {
    const launchAtLogin = this.config?.launchAtLogin ?? false;
    const connectorState = this.config
      ? await connectorInstallationState(this.paths, this.launchSpec, this.connectorHookSpec())
      : "not-installed";
    this.socket?.close();
    this.config = await this.repository.regenerate(launchAtLogin);
    this.mobileOnline = false;
    this.relayAgentOnline = false;
    this.pendingCommands.clear();
    this.acknowledgedCommandIds.clear();
    this.claudeActivities = [];
    if (connectorState !== "not-installed") {
      await installConnector(this.paths, this.launchSpec, this.connectorHookSpec());
    }
    await this.connect();
    return this.publish();
  }

  async installConnector(): Promise<DesktopSnapshot> {
    await installConnector(this.paths, this.launchSpec, this.connectorHookSpec());
    return this.publish();
  }

  async repairConnectorIfNeeded(): Promise<void> {
    if (!this.config) return;
    const state = await connectorInstallationState(this.paths, this.launchSpec, this.connectorHookSpec());
    if (state === "needs-repair") {
      await installConnector(this.paths, this.launchSpec, this.connectorHookSpec());
      await this.publish();
    }
  }

  async setLaunchAtLogin(enabled: boolean): Promise<DesktopSnapshot> {
    if (!this.config) throw new Error("Desktop controller is not initialized");
    await setLaunchAtLogin(this.app, enabled);
    this.config.launchAtLogin = enabled;
    await this.repository.save(this.config);
    return this.publish();
  }

  async sendTestUpdate(): Promise<void> {
    await this.sendMobile({ kind: "status", message: "Bridge 连接正常", progress: 100, step: "连接测试", level: "success" });
  }

  async sendMobile(payload: BridgePayload): Promise<void> {
    if (!this.socket) throw new Error("Bridge is not initialized");
    await this.socket.send(payload, "mobile");
  }

  localAuthorization(): string {
    return this.connectorHookSpec().authorization;
  }

  setClaudeSessions(sessions: ClaudeSessionSnapshot[]): void {
    const sorted = [...sessions].sort((left, right) => (
      right.lastActivityAt - left.lastActivityAt || right.startedAt - left.startedAt
    ));
    if (JSON.stringify(sorted) === JSON.stringify(this.claudeSessions)) return;
    this.claudeSessions = sorted;
    void this.publish();
  }

  setClaudeTransport(transport: ClaudeTransportSnapshot): void {
    if (JSON.stringify(transport) === JSON.stringify(this.claudeTransport)) return;
    this.claudeTransport = transport;
    void this.publish();
  }

  setClaudeActivity(activity: ClaudeBridgeActivity): void {
    const activities = [
      activity,
      ...this.claudeActivities.filter((candidate) => candidate.id !== activity.id),
    ]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, 20);
    if (JSON.stringify(activities) === JSON.stringify(this.claudeActivities)) return;
    this.claudeActivities = activities;
    void this.publish();
  }

  assignPendingCommands(primarySessionId: string | undefined, knownSessionIds: Set<string>): void {
    for (const command of this.pendingCommands.values()) {
      if (command.targetSessionId && knownSessionIds.has(command.targetSessionId)) continue;
      if (primarySessionId) command.targetSessionId = primarySessionId;
      else if (command.targetSessionId) delete command.targetSessionId;
    }
  }

  peekPendingCommands(limit: number, sessionId?: string): PendingBridgeCommand[] {
    const result: PendingBridgeCommand[] = [];
    for (const command of this.pendingCommands.values()) {
      if (result.length >= limit) break;
      if (sessionId && command.targetSessionId && command.targetSessionId !== sessionId) continue;
      if (sessionId && !command.targetSessionId) command.targetSessionId = sessionId;
      result.push({
        id: command.id,
        text: command.text,
        receivedAt: command.receivedAt,
        ...(command.targetSessionId ? { targetSessionId: command.targetSessionId } : {}),
      });
    }
    return result;
  }

  ackPendingCommands(ids: string[]): string[] {
    const acknowledged: string[] = [];
    for (const id of ids) {
      if (!this.pendingCommands.delete(id)) continue;
      acknowledged.push(id);
      this.acknowledgedCommandIds.add(id);
      if (this.acknowledgedCommandIds.size > 500) {
        const oldest = this.acknowledgedCommandIds.values().next().value as string | undefined;
        if (oldest) this.acknowledgedCommandIds.delete(oldest);
      }
    }
    this.socket?.ack(acknowledged);
    if (acknowledged.length > 0) void this.publish();
    return acknowledged;
  }

  close(): void { this.socket?.close(); }

  private async connect(): Promise<void> {
    if (!this.config) return;
    this.crypto = await BridgeCrypto.fromPairing(this.config.pairing, this.config.deviceId);
    const socket = new BridgeSocket({ crypto: this.crypto, role: "desktop", createRoom: true });
    this.socket = socket;
    socket.onState((connection) => { this.connection = connection; void this.publish(); });
    socket.onFrame((frame) => {
      const wasMobileOnline = this.mobileOnline;
      if (frame.type === "ready") {
        this.mobileOnline = frame.online.includes("mobile");
        this.relayAgentOnline = frame.online.includes("agent");
      }
      if (frame.type === "presence") {
        if (frame.role === "mobile") {
          this.mobileOnline = frame.online;
          this.rememberMobile(frame.online);
        }
        if (frame.role === "agent") this.relayAgentOnline = frame.online;
      }
      if (frame.type === "ready" && this.mobileOnline) this.rememberMobile(true);
      if (!wasMobileOnline && this.mobileOnline) this.emit("mobile-online");
      void this.publish();
    });
    socket.onMessage((message, encrypted) => this.receiveMessage(message, encrypted));
    socket.connect();
  }

  private receiveMessage(message: DecryptedEnvelope, encrypted: EncryptedEnvelope): void {
    if (message.header.from === "mobile") this.rememberMobile(true);
    if (message.header.from === "mobile" && message.payload.kind === "history-request") {
      this.socket?.ack([encrypted.id]);
      this.emit("history-request", message.payload satisfies HistoryRequestPayload);
      return;
    }
    if (message.header.from !== "mobile" || message.payload.kind !== "command") {
      this.socket?.ack([encrypted.id]);
      return;
    }
    if (this.acknowledgedCommandIds.has(encrypted.id)) {
      this.socket?.ack([encrypted.id]);
      return;
    }
    if (this.pendingCommands.has(encrypted.id)) return;
    const command: StoredPendingCommand = {
      id: encrypted.id,
      text: message.payload.text,
      receivedAt: new Date(message.header.sentAt).toISOString(),
      ...(message.payload.sessionId ? { targetSessionId: message.payload.sessionId } : {}),
      encrypted,
      message,
    };
    this.pendingCommands.set(encrypted.id, command);
    this.emit("command", command);
    void this.publish();
  }

  private rememberMobile(online: boolean): void {
    if (!this.config) return;
    const now = Date.now();
    const firstPairing = this.config.mobilePairedAt === undefined;
    const shouldPersist = firstPairing
      || !online
      || this.config.mobileLastSeenAt === undefined
      || now - this.config.mobileLastSeenAt > 30_000;
    if (firstPairing) this.config.mobilePairedAt = now;
    this.config.mobileLastSeenAt = now;
    if (shouldPersist) void this.repository.save(this.config).catch(() => undefined);
  }

  private connectorHookSpec(): ConnectorHookSpec {
    if (!this.config) throw new Error("Desktop controller is not initialized");
    return {
      url: BRIDGE_HOOK_URL,
      authorization: `Bearer ${bridgeLocalToken(this.config.pairing.secret)}`,
    };
  }

  private async publish(): Promise<DesktopSnapshot> {
    const snapshot = await this.snapshot();
    this.emit("snapshot", snapshot);
    return snapshot;
  }
}
