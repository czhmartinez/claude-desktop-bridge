import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, normalize } from "node:path";
import type {
  BridgeAttachment,
  BridgeConfigurationSource,
  BridgeDesktopRegistrationInfo,
  BridgeEffort,
  BridgeHistoryItem,
  BridgeHistoryPage,
  BridgeModelInfo,
  BridgeOwnershipState,
  BridgePermissionMode,
  BridgePermissionPolicy,
  BridgeProjectInfo,
  BridgeRuntimeStatus,
  BridgeSessionConfiguration,
  BridgeSessionContextUsage,
  BridgeSessionInfo,
  BridgeTurnState,
} from "@bridge/protocol";
import type {
  ClaudeDesktopSessionRegistrar,
  DesktopSessionRegistrationInput,
  StoredDesktopRegistration,
} from "./claude-desktop-session-registrar.js";
import {
  ClaudeDesktopManagedTransport,
  ManagedDeliveryUncertainError,
  type ManagedDeliveryUncertain,
} from "./claude-desktop-managed-transport.js";
import { ClaudeDesktopManager } from "./claude-desktop-manager.js";
import { ClaudeSessionHost, type ClaudeSessionHostOptions, type SessionHostEvent } from "./claude-session-host.js";
import {
  claudeDesktopProfileForPath,
  type ClaudeDesktopProfile,
} from "./claude-desktop-sessions.js";
import {
  findClaudeTranscriptFile,
  readClaudeSessionContextEstimate,
  readClaudeSessionHistory,
} from "./claude-history.js";
import {
  projectIdForCwd,
  scanClaudeSessionProcesses,
  type ClaudeCatalogSnapshot,
} from "./claude-session-catalog.js";
import { PermissionBroker, type PermissionDecision } from "./permission-broker.js";
import type { ClaudeRuntimePaths } from "./platform.js";
import { prepareClaudeRuntime } from "./claude-runtime-discovery.js";
import type { BridgeEventDraft, SessionEventLog } from "./session-event-log.js";
import {
  ANTHROPIC_API_PROFILE_ID,
  CLAUDE_3P_PROFILE_ID,
  CLAUDE_OFFICIAL_PROFILE_ID,
  ConversationStateStore,
  legacyClaudeLaneId,
} from "./conversation-state-store.js";
import type { BridgeConversationRoute, BridgeExecutionLane } from "@bridge/protocol";
import type { ProviderRuntimePool } from "./provider-runtime-pool.js";

interface StoredBridgeSession {
  sessionId: string;
  cwd: string;
  title: string;
  createdAt: number;
  desktopSessionId?: string;
  desktopRegistration?: StoredDesktopRegistration;
  fallbackConfirmedAt?: number;
}

interface StoredSessionConfiguration {
  sessionId: string;
  model?: string;
  effort?: BridgeEffort;
  permissionMode?: BridgePermissionMode;
  updatedAt: number;
}

interface BridgeSessionsFile {
  version: 2;
  sessions: StoredBridgeSession[];
  configurations?: StoredSessionConfiguration[];
}

export interface QueuedTurn {
  commandId: string;
  requestId: string;
  idempotencyKey: string;
  sessionId: string;
  laneId: string;
  text: string;
  attachments: BridgeAttachment[];
  origin: "desktop" | "mobile" | "system";
  sourceDeviceId?: string;
  requestedAt: number;
  priority: number;
  attempts: number;
  state: "queued" | "running" | "uncertain";
  mode?: "start" | "steer" | "handoff";
  transport?: "claude-desktop-managed" | "bridge-host";
  turnId?: string;
  evidenceId?: string;
  sessionAcceptedAt?: number;
  uncertainResolved?: "confirmed";
  sessionCwd?: string;
  sessionTitle?: string;
  desktopSessionId?: string;
  recoveryBlocked?: boolean;
}

interface TurnQueueFile {
  version: 2;
  pending: QueuedTurn[];
  completedIdempotencyKeys: string[];
  terminalTurns?: TerminalTurnReceipt[];
}

type TerminalTurnState = "completed" | "failed" | "cancelled";

interface TerminalTurnReceipt {
  idempotencyKey: string;
  commandId: string;
  requestId: string;
  sessionId: string;
  state: TerminalTurnState;
}

export interface TurnReceipt {
  commandId: string;
  requestId: string;
  idempotencyKey: string;
  sessionId: string;
  state: QueuedTurn["state"] | TerminalTurnState;
}

interface SessionRuntimeState {
  ownership: BridgeOwnershipState;
  turnState: BridgeTurnState;
  host?: SessionHostRuntime;
  hostLaneId?: string;
  active?: QueuedTurn;
  externalWriteVersion?: number;
  configurationPending?: boolean;
  managed?: boolean;
  releaseTimer?: ReturnType<typeof setTimeout>;
}

export interface SessionHostRuntime {
  start(): void;
  send(
    input: Parameters<ClaudeSessionHost["send"]>[0],
    origin: Parameters<ClaudeSessionHost["send"]>[1],
  ): ReturnType<ClaudeSessionHost["send"]>;
  setModel(model?: string): Promise<void>;
  setEffort(effort?: BridgeEffort): Promise<void>;
  supportedModels(): ReturnType<ClaudeSessionHost["supportedModels"]>;
  contextUsage(): ReturnType<ClaudeSessionHost["contextUsage"]>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
  onEvent(listener: (event: SessionHostEvent) => void): () => void;
}

export interface TranscriptObserverRuntime {
  readonly catalog: ClaudeCatalogSnapshot;
  isDesktopBusy(sessionId: string, now?: number): boolean;
  externalWriteVersion(sessionId: string): number;
  canStartBridgeHost(sessionId: string): Promise<boolean>;
  onCatalog(listener: (catalog: ClaudeCatalogSnapshot) => void): () => void;
}

export interface ManagedDesktopTransportRuntime {
  readonly ready: boolean;
  updateCatalog(catalog: ClaudeCatalogSnapshot): void;
  desktopSessionId(sessionId: string): string | undefined;
  send(input: Parameters<ClaudeDesktopManagedTransport["send"]>[0]): ReturnType<ClaudeDesktopManagedTransport["send"]>;
  interrupt(sessionId: string): Promise<void>;
  setModel(sessionId: string, model: string): Promise<void>;
  setEffort(sessionId: string, effort?: BridgeEffort): Promise<void>;
  getContextUsage(sessionId: string): Promise<BridgeSessionContextUsage | undefined>;
  clearIntent(sessionId: string): void;
  onEvent(listener: (event: SessionHostEvent) => void): () => void;
  onDeliveryUncertain(listener: (event: ManagedDeliveryUncertain) => void): () => void;
  close(): void;
}

export interface ManagedDesktopRuntime {
  readonly ready: boolean;
  readonly enabled: boolean;
  status(): BridgeRuntimeStatus["desktopIntegration"];
  applyToRuntimeStatus(status: Omit<BridgeRuntimeStatus, "desktopIntegration">): BridgeRuntimeStatus;
  stopClaudeForFallback(): Promise<void>;
  on(event: "status", listener: () => void): unknown;
  off(event: "status", listener: () => void): unknown;
}

export interface SessionBrokerOptions {
  paths: ClaudeRuntimePaths;
  eventLog: SessionEventLog;
  observer: TranscriptObserverRuntime;
  sessionsPath: string;
  queuePath: string;
  conversationState?: ConversationStateStore;
  runtimePool?: ProviderRuntimePool;
  maxParallelTurns?: number;
  hostFactory?: (options: ClaudeSessionHostOptions) => SessionHostRuntime;
  prepareRuntime?: typeof prepareClaudeRuntime;
  scanSessionProcesses?: typeof scanClaudeSessionProcesses;
  runtimeRetryDelayMs?: number;
  managedDesktop?: ManagedDesktopRuntime;
  managedTransport?: ManagedDesktopTransportRuntime;
  desktopRegistrar?: Pick<
    ClaudeDesktopSessionRegistrar,
    "register" | "publicInfo" | "changed"
  >;
  evidence?: {
    startBridgeTurn(input: {
      sessionId: string;
      cwd: string;
      commandId: string;
      laneId?: string;
      providerProfileId?: string;
      startedAt?: number;
    }): Promise<string>;
    attachTurn(evidenceId: string, turnId: string): Promise<void>;
    recordToolStarted(input: {
      sessionId: string;
      turnId?: string;
      itemId: string;
      toolName: string;
      toolInput: unknown;
      at: number;
    }): Promise<void>;
    recordToolCompleted(input: {
      sessionId: string;
      turnId?: string;
      itemId: string;
      output: unknown;
      at: number;
    }): Promise<void>;
    finalizeBridgeTurn(input: {
      sessionId: string;
      turnId?: string;
      failed?: boolean;
      error?: string;
      completedAt?: number;
    }): Promise<unknown>;
  };
}

export interface StartTurnInput {
  requestId: string;
  idempotencyKey: string;
  sessionId: string;
  text: string;
  attachments?: BridgeAttachment[];
  origin: "desktop" | "mobile";
  sourceDeviceId?: string;
  priority?: number;
  mode?: "start" | "steer";
}

export interface ConfigureSessionInput {
  sessionId: string;
  model?: string | null;
  effort?: BridgeEffort | null;
}

interface EffectiveSessionProfile {
  model?: string;
  effort?: BridgeEffort;
  ultracode?: boolean;
  inheritedModel?: string;
  inheritedEffort?: BridgeEffort;
  modelSource: BridgeConfigurationSource;
  effortSource: BridgeConfigurationSource;
}

const EFFORT_LEVELS: BridgeEffort[] = ["low", "medium", "high", "xhigh", "max"];
const DEFAULT_CONTEXT_TOKENS = 262_144;
const LONG_CONTEXT_TOKENS = 1_000_000;
const MODEL_DISCOVERY_TIMEOUT_MS = 8_000;
const RUNTIME_RETRY_DELAY_MS = 2_000;
const SESSION_RELEASE_DELAY_MS = 15_000;

function compact(value: string, max = 160): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

async function transcriptCwd(path: string): Promise<string | undefined> {
  const handle = await open(path, "r").catch(() => undefined);
  if (!handle) return undefined;
  try {
    const buffer = Buffer.alloc(512 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
    for (const line of buffer.subarray(0, bytesRead).toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line) as { cwd?: unknown };
        if (typeof value.cwd === "string" && isAbsolute(value.cwd)) return value.cwd;
      } catch {
        // A partial final line is expected when the bounded read stops mid-record.
      }
    }
  } finally {
    await handle.close();
  }
  return undefined;
}

function encodeCursor(item: BridgeHistoryItem): string {
  return Buffer.from(JSON.stringify({ at: item.createdAt, id: item.id }), "utf8").toString("base64url");
}

function decodeCursor(value: string | undefined): { at: number; id: string } | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { at?: unknown; id?: unknown };
    if (typeof parsed.at === "number" && typeof parsed.id === "string") return { at: parsed.at, id: parsed.id };
  } catch {
    return undefined;
  }
  return undefined;
}

function historyOrder(left: BridgeHistoryItem, right: BridgeHistoryItem): number {
  return left.createdAt - right.createdAt || left.id.localeCompare(right.id);
}

export class SessionBroker extends EventEmitter {
  readonly permissionBroker: PermissionBroker;
  private readonly maxParallelTurns: number;
  private readonly hostFactory: NonNullable<SessionBrokerOptions["hostFactory"]>;
  private readonly runtimeFactory: typeof prepareClaudeRuntime;
  private readonly sessionProcessScanner: typeof scanClaudeSessionProcesses;
  private readonly managedTransport: ManagedDesktopTransportRuntime | undefined;
  private readonly runtimeStates = new Map<string, SessionRuntimeState>();
  private readonly bridgeSessions = new Map<string, StoredBridgeSession>();
  private readonly sessionConfigurations = new Map<string, StoredSessionConfiguration>();
  private readonly modelCache = new Map<string, BridgeModelInfo>();
  private readonly hostStarts = new Map<string, Promise<SessionHostRuntime>>();
  private readonly conflictTasks = new Map<string, Promise<void>>();
  private readonly registrationTasks = new Map<string, Promise<void>>();
  private readonly pending: QueuedTurn[] = [];
  private readonly completedKeys = new Set<string>();
  private readonly terminalTurns = new Map<string, TerminalTurnReceipt>();
  private catalog: ClaudeCatalogSnapshot = { projects: [], sessions: [], observedAt: 0 };
  private runtime: Awaited<ReturnType<typeof prepareClaudeRuntime>> | undefined;
  private modelCatalogComplete = false;
  private modelCatalogDiscoveryAttempted = false;
  private defaultPermissionMode: BridgePermissionMode = "standard";
  private activeTurns = 0;
  private initialized = false;
  private closed = false;
  private runtimeRetryTimer: NodeJS.Timeout | undefined;
  private readonly takeoverRetryTimers = new Map<string, NodeJS.Timeout>();
  private runtimeRefresh: Promise<boolean> | undefined;
  private writeQueue: Promise<void> = Promise.resolve();
  private eventQueue: Promise<void> = Promise.resolve();
  private pumpQueue: Promise<void> = Promise.resolve();
  private readonly toolNames = new Map<string, string>();
  private readonly forceStoppedTurnIds = new Set<string>();
  private evidenceFailureReported = false;
  private readonly managedStatusListener = () => {
    const status = this.options.managedDesktop?.status();
    if (status) {
      void this.record({
        origin: "system",
        type: "runtime.compatibility",
        data: status,
      });
    }
    this.emit("changed");
    void this.pump();
  };

  constructor(private readonly options: SessionBrokerOptions) {
    super();
    this.permissionBroker = new PermissionBroker(
      (sessionId) => this.permissionPolicy(sessionId).effectiveMode,
    );
    this.maxParallelTurns = options.maxParallelTurns ?? 2;
    this.hostFactory = options.hostFactory ?? ((hostOptions) => new ClaudeSessionHost(hostOptions));
    this.runtimeFactory = options.prepareRuntime ?? prepareClaudeRuntime;
    this.sessionProcessScanner = options.scanSessionProcesses ?? scanClaudeSessionProcesses;
    this.managedTransport = options.managedTransport
      ?? (options.managedDesktop instanceof ClaudeDesktopManager
        ? new ClaudeDesktopManagedTransport({
            manager: options.managedDesktop,
            permissionBroker: this.permissionBroker,
          })
        : undefined);
  }

  private async evidenceCall<T>(action: () => Promise<T>): Promise<T | undefined> {
    try {
      return await action();
    } catch {
      if (!this.evidenceFailureReported) {
        this.evidenceFailureReported = true;
        process.stderr.write("Bridge evidence capture failed; the Claude task will continue.\n");
      }
      return undefined;
    }
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    if (this.options.conversationState) {
      await Promise.all([
        this.options.eventLog.initialize(),
        this.options.conversationState.initialize(),
      ]);
      await this.loadConversationState();
    } else {
      await Promise.all([
        this.options.eventLog.initialize(),
        this.loadSessions(),
        this.loadQueue(),
      ]);
    }
    this.catalog = this.options.observer.catalog;
    this.managedTransport?.updateCatalog(this.catalog);
    this.refreshRecoveryBlocks();
    this.rememberCatalogModels();
    this.options.observer.onCatalog((catalog) => {
      this.catalog = catalog;
      this.managedTransport?.updateCatalog(catalog);
      this.refreshRecoveryBlocks();
      this.rememberCatalogModels();
      this.refreshObservedOwnership();
      this.emit("changed");
      this.reconcileDesktopRegistrations();
      void this.pump();
    });
    this.managedTransport?.onEvent((event) => {
      this.eventQueue = this.eventQueue
        .catch(() => undefined)
        .then(() => this.handleHostEvent(event, "claude-desktop"));
    });
    this.managedTransport?.onDeliveryUncertain((event) => {
      this.eventQueue = this.eventQueue
        .catch(() => undefined)
        .then(() => this.handleManagedUncertain(event));
    });
    this.options.managedDesktop?.on("status", this.managedStatusListener);
    this.permissionBroker.on("requested", (request) => {
      const type = request.toolName === "AskUserQuestion" ? "question.requested" : "permission.requested";
      const state = this.runtimeStates.get(request.sessionId);
      if (state?.active) state.turnState = "waiting";
      this.eventQueue = this.eventQueue
        .catch(() => undefined)
        .then(() => this.record({
          sessionId: request.sessionId,
          itemId: request.requestId,
          timestamp: request.createdAt,
          origin: "claude-host",
          type,
          data: {
            requestId: request.requestId,
            toolUseId: request.toolUseId,
            toolName: request.toolName,
            title: request.title ?? "",
            displayName: request.displayName ?? "",
            description: request.description ?? "",
            input: request.input,
            createdAt: request.createdAt,
            canAllowAlways: request.suggestions.some(
              (suggestion: { destination?: string }) => suggestion.destination === "localSettings",
            ),
          },
        }));
      this.emit("changed");
    });
    this.permissionBroker.on("resolved", (request, result, resolution) => {
      const type = request.toolName === "AskUserQuestion" ? "question.resolved" : "permission.resolved";
      const state = this.runtimeStates.get(request.sessionId);
      if (state?.turnState === "waiting" && this.permissionBroker.list(request.sessionId).length === 0) {
        state.turnState = state.active ? "running" : "idle";
      }
      this.eventQueue = this.eventQueue
        .catch(() => undefined)
        .then(() => this.record({
          sessionId: request.sessionId,
          itemId: request.requestId,
          timestamp: resolution.resolvedAt,
          origin: "system",
          type,
          data: {
            requestId: request.requestId,
            toolUseId: request.toolUseId,
            toolName: request.toolName,
            input: request.input,
            decision: resolution.decision,
            resolvedByDeviceId: resolution.resolvedByDeviceId,
            resolvedByName: resolution.resolvedByName,
            resolvedAt: resolution.resolvedAt,
            behavior: result.behavior,
            ...(resolution.automatic ? { automatic: true } : {}),
            ...(resolution.reason ? { reason: resolution.reason } : {}),
          },
        }));
      this.emit("changed");
    });
    await this.refreshRuntime();
    this.reconcileDesktopRegistrations();
    await this.pump();
  }

  async refreshRuntime(): Promise<boolean> {
    if (this.closed) return false;
    if (this.runtimeRefresh) return this.runtimeRefresh;
    const refresh = (async () => {
      const previous = this.runtime;
      const next = await this.runtimeFactory(process.env, previous);
      if (this.closed) return false;
      this.runtime = next;
      const changed = (
        previous?.executablePath !== next.executablePath ||
        previous?.credentialPath !== next.credentialPath ||
        previous?.version !== next.version
      );
      if (next.executablePath && next.credentialPath) this.clearRuntimeRetry();
      else this.scheduleRuntimeRetry();
      if (changed) {
        this.emit("changed");
        void this.pump();
      }
      return changed;
    })().finally(() => {
      if (this.runtimeRefresh === refresh) this.runtimeRefresh = undefined;
    });
    this.runtimeRefresh = refresh;
    return refresh;
  }

  runtimeStatus(): BridgeRuntimeStatus {
    const withDesktop = (status: Omit<BridgeRuntimeStatus, "desktopIntegration">): BridgeRuntimeStatus => (
      this.options.managedDesktop?.applyToRuntimeStatus(status) ?? {
        ...status,
        desktopIntegration: {
          state: "not-managed",
          detail: "实验性 Claude Desktop 同步控制尚未启用。",
          enabled: false,
          canRestart: process.platform === "darwin" || process.platform === "win32",
        },
      }
    );
    if (!this.runtime?.executablePath) {
      return withDesktop({
        state: "unavailable",
        detail: "未找到 Claude CLI Host 运行时。",
        activeTurns: this.activeTurns,
        maxParallelTurns: this.maxParallelTurns,
      });
    }
    if (!this.runtime.credentialPath) {
      return withDesktop({
        state: "auth-required",
        detail: "未找到 Claude Desktop 第三方 Host 凭据。Bridge 不提供官方账号登录。",
        ...(this.runtime.version ? { version: this.runtime.version } : {}),
        activeTurns: this.activeTurns,
        maxParallelTurns: this.maxParallelTurns,
      });
    }
    return withDesktop({
      state: this.activeTurns > 0 ? "working" : "ready",
      detail: this.activeTurns > 0
        ? `${this.activeTurns} 个会话正在处理。`
        : this.managedTransport?.ready
          ? "Claude Desktop 同步通道已就绪。"
          : "Bridge Agent SDK 会话通道已就绪。",
      ...(this.runtime.version ? { version: this.runtime.version } : {}),
      credentialSource: "third-party-host",
      activeTurns: this.activeTurns,
      maxParallelTurns: this.maxParallelTurns,
    });
  }

  listProjects(): BridgeProjectInfo[] {
    const sessions = this.listSessions();
    const grouped = new Map<string, BridgeProjectInfo>();
    for (const session of sessions) {
      const current = grouped.get(session.projectId);
      if (current) {
        current.sessionCount += 1;
        current.runningCount += Number(session.turnState === "running" || session.turnState === "waiting");
        current.pendingCount += session.pendingCount;
        current.lastActivityAt = Math.max(current.lastActivityAt, session.lastActivityAt);
      } else {
        grouped.set(session.projectId, {
          projectId: session.projectId,
          name: session.projectName,
          cwd: session.cwd,
          sessionCount: 1,
          runningCount: Number(session.turnState === "running" || session.turnState === "waiting"),
          pendingCount: session.pendingCount,
          lastActivityAt: session.lastActivityAt,
          runtimeId: "claude-desktop",
        });
      }
    }
    return [...grouped.values()].sort((left, right) => right.lastActivityAt - left.lastActivityAt);
  }

  listSessions(projectId?: string, search?: string): BridgeSessionInfo[] {
    const observed = new Map(this.catalog.sessions.map((session) => [session.sessionId, session]));
    const queued = new Map<string, QueuedTurn>();
    for (const turn of this.pending) {
      if (!queued.has(turn.sessionId)) queued.set(turn.sessionId, turn);
    }
    const ids = new Set([
      ...observed.keys(),
      ...this.bridgeSessions.keys(),
      ...this.runtimeStates.keys(),
      ...queued.keys(),
    ]);
    const sessions: BridgeSessionInfo[] = [];
    for (const sessionId of ids) {
      const source = observed.get(sessionId);
      const associatedLane = source && this.options.conversationState
        ? this.options.conversationState.findLanesByNativeSessionId(sessionId).find((lane) => (
            (source.sourceProfile === "claude" && lane.providerKind === "claude-official") ||
            (source.sourceProfile === "claude-3p" && lane.providerKind === "claude-3p") ||
            source.sourceProfile === "unknown"
          ))
        : undefined;
      if (associatedLane && associatedLane.conversationId !== sessionId) continue;
      const bridge = this.bridgeSessions.get(sessionId);
      const queuedTurn = queued.get(sessionId);
      if (!source && !bridge && !queuedTurn) continue;
      const recoveredQueue = !source && !bridge;
      const cwd = source?.cwd
        ?? bridge?.cwd
        ?? queuedTurn?.sessionCwd
        ?? this.options.paths.projects;
      const state = this.runtimeStates.get(sessionId);
      const pendingCount = this.pending.filter((turn) => (
        turn.sessionId === sessionId && (turn.state === "queued" || turn.state === "uncertain")
      )).length;
      const desktopSessionId = source?.desktopSessionId
        ?? bridge?.desktopSessionId
        ?? queuedTurn?.desktopSessionId
        ?? this.managedTransport?.desktopSessionId(sessionId);
      const managed = Boolean(
        this.managedTransport?.ready &&
        (desktopSessionId || state?.managed || bridge),
      );
      const ownership = this.hasConfirmedOwnershipConflict(sessionId, state)
        ? "OWNERSHIP_CONFLICT"
        : state?.ownership
          ?? (recoveredQueue
            ? queuedTurn?.transport === "claude-desktop-managed"
              ? "DESKTOP_MANAGED_IDLE"
              : "BRIDGE_IDLE"
            : undefined)
          ?? (managed
            ? this.options.observer.isDesktopBusy(sessionId)
              ? "DESKTOP_MANAGED_RUNNING"
              : "DESKTOP_MANAGED_IDLE"
            : source
              ? "DESKTOP_OBSERVED"
              : "BRIDGE_IDLE");
      const turnState = state?.turnState
        ?? (source && this.options.observer.isDesktopBusy(sessionId) ? "running" : "idle");
      const profile = this.effectiveProfile(sessionId, cwd);
      const route = this.options.conversationState?.route(sessionId);
      const item: BridgeSessionInfo = {
        sessionId,
        runtimeId: "claude-desktop",
        nativeSessionId: sessionId,
        ...(desktopSessionId ? { desktopSessionId } : {}),
        projectId: projectIdForCwd(cwd),
        projectName: basename(cwd) || cwd,
        cwd,
        title: source?.title
          ?? bridge?.title
          ?? queuedTurn?.sessionTitle
          ?? `未完成任务：${compact(queuedTurn?.text ?? "", 72)}`,
        source: bridge || recoveredQueue ? "bridge" : "desktop",
        transport: recoveredQueue
          ? queuedTurn?.transport ?? "bridge-host"
          : managed
            ? "claude-desktop-managed"
            : "bridge-host",
        ownership,
        turnState: pendingCount > 0 && turnState === "idle" ? "queued" : turnState,
        lastActivityAt: Math.max(
          source?.lastActivityAt ?? 0,
          bridge?.createdAt ?? 0,
          queuedTurn?.requestedAt ?? 0,
        ),
        pendingCount,
        ...(state?.active?.turnId ? { activeTurnId: state.active.turnId } : {}),
        ...(state?.active?.text
          ? { currentSummary: compact(state.active.text) }
          : recoveredQueue && queuedTurn
            ? { currentSummary: `恢复的未完成任务 · ${compact(queuedTurn.text)}` }
            : {}),
        ...(profile.model ? { model: profile.model } : {}),
        ...(profile.effort ? { effort: profile.effort } : {}),
        ...(state?.configurationPending ? { configurationPending: true } : {}),
        ...(bridge?.fallbackConfirmedAt ? { fallbackConfirmed: true } : {}),
        ...(bridge?.desktopRegistration && this.options.desktopRegistrar
          ? { desktopRegistration: this.options.desktopRegistrar.publicInfo(bridge.desktopRegistration) }
          : {}),
        ...(route ? {
          activeLaneId: route.activeLaneId,
          activeProviderProfileId: route.activeProviderProfileId,
          routeState: route.state,
          allowedActions: route.allowedActions,
          ...(route.pendingHandoff ? { pendingHandoff: route.pendingHandoff } : {}),
        } : {}),
      };
      if (projectId && item.projectId !== projectId) continue;
      if (search) {
        const query = search.toLocaleLowerCase();
        if (!`${item.title}\n${item.projectName}\n${item.cwd}`.toLocaleLowerCase().includes(query)) continue;
      }
      sessions.push(item);
    }
    const priority = (state: BridgeTurnState) => (
      state === "waiting" ? 3 : state === "running" ? 2 : state === "queued" ? 1 : 0
    );
    return sessions.sort((left, right) => (
      priority(right.turnState) - priority(left.turnState)
      || right.lastActivityAt - left.lastActivityAt
    ));
  }

  session(sessionId: string): BridgeSessionInfo | undefined {
    return this.listSessions().find((candidate) => candidate.sessionId === sessionId);
  }

  conversationRoute(sessionId: string): BridgeConversationRoute {
    const store = this.options.conversationState;
    if (!store) throw new Error("Conversation routing is unavailable");
    const existing = store.route(sessionId);
    if (existing) return existing;
    const session = this.session(sessionId);
    if (!session) throw new Error("Session not found");
    const observed = this.catalog.sessions.find((candidate) => candidate.sessionId === sessionId);
    const official = observed?.sourceProfile === "claude";
    return store.ensureConversation({
      conversationId: sessionId,
      cwd: session.cwd,
      title: session.title,
      source: session.source,
      providerProfileId: official ? CLAUDE_OFFICIAL_PROFILE_ID : CLAUDE_3P_PROFILE_ID,
      providerKind: official ? "claude-official" : "claude-3p",
      nativeSessionId: sessionId,
      access: official ? "read-only" : "read-write",
      createdAt: session.lastActivityAt,
    });
  }

  activeLane(sessionId: string): BridgeExecutionLane | undefined {
    return this.options.conversationState?.activeLane(sessionId);
  }

  hasActiveOrPending(sessionId: string): boolean {
    const state = this.runtimeStates.get(sessionId);
    return Boolean(state?.active) || this.pending.some((turn) => (
      turn.sessionId === sessionId &&
      (turn.state === "queued" || turn.state === "running" || turn.state === "uncertain")
    ));
  }

  async configuration(sessionId: string, discoverModels = true): Promise<BridgeSessionConfiguration> {
    await this.initialize();
    const session = this.session(sessionId);
    if (!session) throw new Error("Session not found");
    const state = this.runtimeStates.get(sessionId);
    let host = state?.host;
    let modelsComplete = this.modelCatalogComplete;
    let context: BridgeSessionContextUsage | undefined;
    const managed = Boolean(
      this.managedTransport?.ready &&
      (session.desktopSessionId || this.managedTransport.desktopSessionId(sessionId)),
    );

    if (
      discoverModels &&
      !host &&
      !this.modelCatalogComplete &&
      !this.modelCatalogDiscoveryAttempted
    ) {
      this.modelCatalogDiscoveryAttempted = true;
      const models = await this.discoverModelsWithoutAttaching(session).catch(() => undefined);
      if (models?.length) {
        modelsComplete = true;
        this.modelCatalogComplete = true;
        this.rememberModels(models);
      }
    }
    if (host && discoverModels) {
      const [modelsResult, contextResult] = await Promise.allSettled([
        host.supportedModels(),
        host.contextUsage(),
      ]);
      if (modelsResult.status === "fulfilled" && modelsResult.value.length > 0) {
        modelsComplete = true;
        this.modelCatalogComplete = true;
        this.rememberModels(modelsResult.value);
      }
      if (contextResult.status === "fulfilled") {
        const usage = contextResult.value;
        context = {
          totalTokens: usage.totalTokens,
          maxTokens: usage.maxTokens,
          percentage: usage.percentage,
          model: usage.model,
          estimated: false,
        };
      }
      this.scheduleRelease(sessionId);
    }
    if (managed) {
      context = await this.managedTransport?.getContextUsage(sessionId).catch(() => undefined);
    }
    context ??= await this.estimatedContext(session);

    const profile = this.effectiveProfile(sessionId, session.cwd);
    const stored = this.sessionConfigurations.get(sessionId);
    const availableModels = this.availableModels(profile.model);
    const selectedModel = this.findModelInfo(profile.model, availableModels);
    return {
      sessionId,
      ...(profile.model ? { model: profile.model } : {}),
      ...(profile.effort ? { effort: profile.effort } : {}),
      ...(profile.inheritedModel ? { inheritedModel: profile.inheritedModel } : {}),
      ...(profile.inheritedEffort ? { inheritedEffort: profile.inheritedEffort } : {}),
      ...(stored?.model ? { overrideModel: stored.model } : {}),
      ...(stored?.effort ? { overrideEffort: stored.effort } : {}),
      modelSource: profile.modelSource,
      effortSource: profile.effortSource,
      availableModels,
      availableEffortLevels: selectedModel?.supportedEffortLevels?.length
        ? [...selectedModel.supportedEffortLevels]
        : [...EFFORT_LEVELS],
      modelsComplete,
      appliesAfterTurn: Boolean(state?.configurationPending),
      permissionPolicy: this.permissionPolicy(sessionId),
      ...(context ? { context } : {}),
    };
  }

  permissionPolicy(sessionId: string): BridgePermissionPolicy {
    const sessionMode = this.sessionConfigurations.get(sessionId)?.permissionMode;
    return {
      hostMode: this.defaultPermissionMode,
      ...(sessionMode ? { sessionMode } : {}),
      effectiveMode: sessionMode ?? this.defaultPermissionMode,
      source: sessionMode ? "session" : "host",
    };
  }

  setDefaultPermissionMode(mode: BridgePermissionMode): number {
    if (mode !== "standard" && mode !== "full-access") throw new Error("Invalid permission mode");
    this.defaultPermissionMode = mode;
    const resolved = this.permissionBroker.applyPolicy();
    this.emit("changed");
    return resolved;
  }

  async configurePermissionPolicy(
    sessionId: string,
    mode: BridgePermissionMode | null,
  ): Promise<{ configuration: BridgeSessionConfiguration; resolvedPending: number }> {
    await this.initialize();
    if (!this.session(sessionId)) throw new Error("Session not found");
    if (mode !== null && mode !== "standard" && mode !== "full-access") {
      throw new Error("Invalid permission mode");
    }
    const previous = this.sessionConfigurations.get(sessionId);
    const proposed: StoredSessionConfiguration = {
      sessionId,
      ...(previous?.model ? { model: previous.model } : {}),
      ...(previous?.effort ? { effort: previous.effort } : {}),
      ...(mode ? { permissionMode: mode } : {}),
      updatedAt: Date.now(),
    };
    if (proposed.model || proposed.effort || proposed.permissionMode) {
      this.sessionConfigurations.set(sessionId, proposed);
    } else {
      this.sessionConfigurations.delete(sessionId);
    }
    await this.saveSessions();
    const resolvedPending = this.permissionBroker.applyPolicy(sessionId);
    this.emit("changed");
    return {
      configuration: await this.configuration(sessionId, false),
      resolvedPending,
    };
  }

  async configureSession(input: ConfigureSessionInput): Promise<BridgeSessionConfiguration> {
    await this.initialize();
    const session = this.session(input.sessionId);
    if (!session) throw new Error("Session not found");
    const route = this.options.conversationState?.route(input.sessionId);
    if (route && !route.allowedActions.canConfigure) {
      throw new Error(route.allowedActions.reason ?? "当前通道不能修改执行配置");
    }
    const changesModel = Object.prototype.hasOwnProperty.call(input, "model");
    const changesEffort = Object.prototype.hasOwnProperty.call(input, "effort");
    if (!changesModel && !changesEffort) throw new Error("No configuration changes were provided");
    if (typeof input.model === "string") {
      if (
        input.model.length > 160 ||
        !input.model.trim() ||
        /[\u0000-\u001f\u007f]/u.test(input.model)
      ) throw new Error("Invalid model");
    }
    if (input.effort !== undefined && input.effort !== null && !EFFORT_LEVELS.includes(input.effort)) {
      throw new Error("Invalid effort");
    }

    const previous = this.sessionConfigurations.get(input.sessionId);
    const proposed: StoredSessionConfiguration = {
      sessionId: input.sessionId,
      ...(previous?.model ? { model: previous.model } : {}),
      ...(previous?.effort ? { effort: previous.effort } : {}),
      ...(previous?.permissionMode ? { permissionMode: previous.permissionMode } : {}),
      updatedAt: Date.now(),
    };
    if (changesModel) {
      if (typeof input.model === "string") proposed.model = input.model.trim();
      else delete proposed.model;
    }
    if (changesEffort) {
      if (input.effort) proposed.effort = input.effort;
      else delete proposed.effort;
    }
    const profile = this.effectiveProfile(input.sessionId, session.cwd, proposed);
    const modelInfo = this.findModelInfo(profile.model, this.availableModels(profile.model));
    if (
      profile.effort &&
      modelInfo?.supportedEffortLevels?.length &&
      !modelInfo.supportedEffortLevels.includes(profile.effort)
    ) {
      throw new Error(`${modelInfo.displayName} 不支持 ${profile.effort} effort`);
    }
    if (profile.effort && modelInfo?.supportsEffort === false) {
      throw new Error(`${modelInfo.displayName} 不支持 effort 调节`);
    }
    if (changesModel && profile.model) await this.assertContextFits(session, profile.model);

    const state = this.runtimeStates.get(input.sessionId);
    const managed = Boolean(
      this.managedTransport?.ready &&
      (session.desktopSessionId || this.managedTransport.desktopSessionId(input.sessionId)),
    );
    if (managed) {
      if (changesModel && profile.model) {
        await this.managedTransport!.setModel(input.sessionId, profile.model);
      }
      if (changesEffort) {
        await this.managedTransport!.setEffort(input.sessionId, profile.effort);
      }
      if (state) delete state.configurationPending;
    } else if (state?.host && !state.active) {
      await this.applyHostConfiguration(state.host, profile);
      delete state.configurationPending;
    } else if (state?.active) {
      state.configurationPending = true;
    }

    if (proposed.model || proposed.effort || proposed.permissionMode) this.sessionConfigurations.set(input.sessionId, proposed);
    else this.sessionConfigurations.delete(input.sessionId);
    await this.saveSessions();
    await this.record({
      sessionId: input.sessionId,
      origin: "system",
      type: "session.configuration",
      data: {
        ...(profile.model ? { model: profile.model } : {}),
        ...(profile.effort ? { effort: profile.effort } : {}),
        appliesAfterTurn: Boolean(state?.active),
      },
    });
    this.emit("changed");
    return this.configuration(input.sessionId, false);
  }

  async createSession(cwd: string, title?: string): Promise<BridgeSessionInfo> {
    if (!isAbsolute(cwd)) throw new Error("Project path must be absolute");
    const normalizedCwd = normalize(cwd);
    const knownProject = this.catalog.sessions.some((session) => normalize(session.cwd) === normalizedCwd)
      || [...this.bridgeSessions.values()].some((session) => normalize(session.cwd) === normalizedCwd);
    if (!knownProject) {
      throw new Error("Project path must be selected from a discovered Claude project");
    }
    const session: StoredBridgeSession = {
      sessionId: randomUUID(),
      cwd: normalizedCwd,
      title: compact(title?.trim() || basename(normalizedCwd) || normalizedCwd, 140),
      createdAt: Date.now(),
    };
    this.bridgeSessions.set(session.sessionId, session);
    this.runtimeStates.set(session.sessionId, {
      ownership: this.managedTransport?.ready ? "DESKTOP_MANAGED_IDLE" : "BRIDGE_IDLE",
      turnState: "idle",
      ...(this.managedTransport?.ready ? { managed: true } : {}),
    });
    this.options.conversationState?.ensureConversation({
      conversationId: session.sessionId,
      cwd: session.cwd,
      title: session.title,
      source: "bridge",
      providerProfileId: CLAUDE_3P_PROFILE_ID,
      providerKind: "claude-3p",
      nativeSessionId: session.sessionId,
      access: "read-write",
      createdAt: session.createdAt,
    });
    await this.saveSessions();
    await this.record({
      sessionId: session.sessionId,
      origin: "system",
      type: "session.created",
      data: { cwd: session.cwd, title: session.title },
    });
    await this.reconcileDesktopRegistration(session.sessionId, true);
    this.emit("changed");
    return this.session(session.sessionId)!;
  }

  async registerDesktopSession(sessionId: string): Promise<BridgeSessionInfo> {
    await this.initialize();
    if (!this.bridgeSessions.has(sessionId)) {
      throw new Error("Only Bridge-created sessions can be registered in Claude Desktop");
    }
    await this.reconcileDesktopRegistration(sessionId, true);
    return this.session(sessionId)!;
  }

  async startTurn(input: StartTurnInput): Promise<QueuedTurn | TurnReceipt> {
    await this.initialize();
    const text = input.text.trim();
    const attachments = input.attachments ?? [];
    if (!text && attachments.length === 0) throw new Error("Message cannot be empty");
    const session = this.session(input.sessionId);
    if (!session) throw new Error("Session not found");
    const route = this.options.conversationState
      ? this.conversationRoute(input.sessionId)
      : undefined;
    if (route && !route.allowedActions.canSend) {
      throw new Error(
        route.allowedActions.reason
        ?? "当前提供方通道不能接收消息，请升级 Bridge 并切换到可执行通道。",
      );
    }
    const existing = this.pending.find((turn) => turn.idempotencyKey === input.idempotencyKey);
    if (existing) return existing;
    if (this.completedKeys.has(input.idempotencyKey)) {
      return this.terminalTurns.get(input.idempotencyKey) ?? {
        commandId: `completed:${input.idempotencyKey}`,
        requestId: input.requestId,
        idempotencyKey: input.idempotencyKey,
        sessionId: input.sessionId,
        state: "completed",
      };
    }
    const queued: QueuedTurn = {
      commandId: randomUUID(),
      requestId: input.requestId,
      idempotencyKey: input.idempotencyKey,
      sessionId: input.sessionId,
      laneId: route?.activeLaneId ?? legacyClaudeLaneId(input.sessionId),
      text,
      attachments,
      origin: input.origin,
      ...(input.sourceDeviceId ? { sourceDeviceId: input.sourceDeviceId } : {}),
      requestedAt: Date.now(),
      priority: input.priority ?? 0,
      attempts: 0,
      state: "queued",
      mode: input.mode ?? "start",
      sessionCwd: session.cwd,
      sessionTitle: session.title,
      ...(session.desktopSessionId ? { desktopSessionId: session.desktopSessionId } : {}),
    };
    this.pending.push(queued);
    this.sortPending();
    await this.saveQueue();
    await this.record({
      sessionId: queued.sessionId,
      itemId: queued.commandId,
      origin: queued.origin,
      type: "turn.queued",
      data: {
        commandId: queued.commandId,
        requestId: queued.requestId,
        delivery: "host-received",
        text: queued.text,
      },
    });
    this.emit("changed");
    void this.pump();
    return queued;
  }

  async startHandoffTurn(input: {
    handoffId: string;
    sessionId: string;
    laneId: string;
    text: string;
  }): Promise<QueuedTurn | TurnReceipt> {
    await this.initialize();
    if (this.hasActiveOrPending(input.sessionId)) {
      throw new Error("当前对话仍有运行中或待发送任务，请先完成或停止");
    }
    const session = this.session(input.sessionId);
    if (!session) throw new Error("Session not found");
    const lane = this.options.conversationState?.lane(input.laneId);
    if (!lane || lane.conversationId !== input.sessionId || lane.access !== "read-write") {
      throw new Error("Handoff target lane is invalid");
    }
    const idempotencyKey = `handoff:${input.handoffId}`;
    const existing = this.pending.find((turn) => turn.idempotencyKey === idempotencyKey);
    if (existing) return existing;
    if (this.completedKeys.has(idempotencyKey)) {
      return this.terminalTurns.get(idempotencyKey) ?? {
        commandId: `completed:${idempotencyKey}`,
        requestId: input.handoffId,
        idempotencyKey,
        sessionId: input.sessionId,
        state: "completed",
      };
    }
    const queued: QueuedTurn = {
      commandId: randomUUID(),
      requestId: input.handoffId,
      idempotencyKey,
      sessionId: input.sessionId,
      laneId: input.laneId,
      text: input.text.trim(),
      attachments: [],
      origin: "system",
      requestedAt: Date.now(),
      priority: 200,
      attempts: 0,
      state: "queued",
      mode: "handoff",
      sessionCwd: session.cwd,
      sessionTitle: session.title,
    };
    this.pending.push(queued);
    this.sortPending();
    await this.saveQueue();
    await this.record({
      sessionId: queued.sessionId,
      itemId: queued.commandId,
      origin: "system",
      type: "turn.queued",
      data: {
        commandId: queued.commandId,
        requestId: queued.requestId,
        delivery: "host-received",
        handoffId: input.handoffId,
      },
    });
    this.emit("changed");
    void this.pump();
    return queued;
  }

  async steerTurn(input: StartTurnInput): Promise<QueuedTurn | TurnReceipt> {
    const state = this.runtimeStates.get(input.sessionId);
    if (state?.active && state.host) await state.host.interrupt();
    const turn = await this.startTurn({ ...input, priority: 100, mode: "steer" });
    if (
      "attempts" in turn &&
      turn.state === "queued" &&
      this.managedTransport?.ready &&
      state?.active &&
      state.managed
    ) {
      await this.acquireManaged(turn, true);
    }
    return turn;
  }

  async interruptTurn(sessionId: string, commandId?: string, force = false): Promise<boolean> {
    const state = this.runtimeStates.get(sessionId);
    const active = state?.active;
    const activeMatches = Boolean(active && (!commandId || active.commandId === commandId));
    if (state?.managed && active && activeMatches) {
      this.permissionBroker.cancelSession(sessionId, "turn-interrupted");
      if (force) {
        if (this.managedTransport?.ready) {
          void this.managedTransport.interrupt(sessionId).catch(() => undefined);
        }
        this.managedTransport?.clearIntent(sessionId);
        await this.forceCancelActive(sessionId, active);
        return true;
      }
      if (!this.managedTransport?.ready) return false;
      await this.managedTransport.interrupt(sessionId);
      return true;
    }
    if (active && activeMatches && state.host) {
      this.permissionBroker.cancelSession(sessionId, "turn-interrupted");
      if (force) {
        await this.forceCancelActive(sessionId, active);
        return true;
      }
      await state.host.interrupt();
      return true;
    }
    if (force && active && activeMatches) {
      await this.forceCancelActive(sessionId, active);
      return true;
    }
    const index = this.pending.findIndex((turn) => (
      turn.sessionId === sessionId &&
      (turn.state === "queued" || (force && turn.state === "uncertain")) &&
      (!commandId || turn.commandId === commandId)
    ));
    if (index < 0) return false;
    const [cancelled] = this.pending.splice(index, 1);
    this.rememberTerminal(cancelled!, "cancelled");
    this.clearTakeoverRetry(sessionId);
    const remainingForSession = this.pending.some((turn) => (
      turn.sessionId === sessionId && (turn.state === "queued" || turn.state === "uncertain")
    ));
    if (state && !state.active) {
      state.ownership = "DESKTOP_OBSERVED";
      state.turnState = remainingForSession
        ? "queued"
        : this.options.observer.isDesktopBusy(sessionId)
          ? "running"
          : "idle";
    }
    await this.saveQueue();
    await this.record({
      sessionId,
      ...(cancelled!.turnId ? { turnId: cancelled!.turnId } : {}),
      itemId: cancelled!.commandId,
      origin: "system",
      type: "turn.interrupted",
      data: {
        commandId: cancelled!.commandId,
        requestId: cancelled!.requestId,
        idempotencyKey: cancelled!.idempotencyKey,
        delivery: "cancelled",
        wasQueued: true,
      },
    });
    if (this.options.evidence) {
      void this.evidenceCall(() => this.options.evidence!.finalizeBridgeTurn({
        sessionId,
        ...(cancelled!.turnId ? { turnId: cancelled!.turnId } : {}),
        failed: true,
        error: "任务已停止",
      }));
    }
    this.emit("changed");
    await this.pump();
    return true;
  }

  private async forceCancelActive(sessionId: string, turn: QueuedTurn): Promise<void> {
    const state = this.runtimeStates.get(sessionId);
    if (!state?.active || state.active.commandId !== turn.commandId) return;
    this.permissionBroker.cancelSession(sessionId, "turn-interrupted");
    this.clearTakeoverRetry(sessionId);
    if (turn.turnId) {
      this.forceStoppedTurnIds.add(turn.turnId);
      while (this.forceStoppedTurnIds.size > 2_000) {
        const oldest = this.forceStoppedTurnIds.values().next().value;
        if (typeof oldest !== "string") break;
        this.forceStoppedTurnIds.delete(oldest);
      }
    }
    const host = state.host;
    delete state.host;
    delete state.hostLaneId;
    delete state.active;
    if (state.releaseTimer) {
      clearTimeout(state.releaseTimer);
      delete state.releaseTimer;
    }
    const index = this.pending.findIndex((candidate) => candidate.commandId === turn.commandId);
    if (index >= 0) this.pending.splice(index, 1);
    this.activeTurns = Math.max(0, this.activeTurns - 1);
    this.rememberTerminal(turn, "cancelled");
    const managedReady = Boolean(state.managed && this.managedTransport?.ready);
    const desktopBusy = !managedReady && this.options.observer.isDesktopBusy(sessionId);
    state.turnState = desktopBusy ? "running" : "idle";
    state.ownership = managedReady
      ? "DESKTOP_MANAGED_IDLE"
      : this.catalog.sessions.some((session) => session.sessionId === sessionId)
        ? "DESKTOP_OBSERVED"
        : "BRIDGE_IDLE";
    if (!managedReady) delete state.managed;
    await host?.close().catch(() => undefined);
    this.managedTransport?.clearIntent(sessionId);
    await this.saveQueue();
    await this.options.eventLog.flushDeltas(sessionId);
    await this.record({
      sessionId,
      ...(turn.turnId ? { turnId: turn.turnId } : {}),
      itemId: turn.commandId,
      origin: "system",
      type: "turn.interrupted",
      data: {
        commandId: turn.commandId,
        requestId: turn.requestId,
        idempotencyKey: turn.idempotencyKey,
        delivery: "cancelled",
        forced: true,
      },
    });
    if (this.options.evidence) {
      void this.evidenceCall(() => this.options.evidence!.finalizeBridgeTurn({
        sessionId,
        ...(turn.turnId ? { turnId: turn.turnId } : {}),
        failed: true,
        error: "任务已强制停止",
      }));
    }
    this.emit("changed");
    await this.pump();
  }

  async confirmFallback(sessionId: string): Promise<BridgeSessionInfo> {
    await this.initialize();
    const session = this.session(sessionId);
    if (!session) throw new Error("Session not found");
    if (!await this.options.observer.canStartBridgeHost(sessionId)) {
      throw new Error("Claude Desktop 仍在执行当前会话，结束后 Bridge 会自动接管");
    }
    const stored = this.bridgeSessions.get(sessionId) ?? {
      sessionId,
      cwd: session.cwd,
      title: session.title,
      createdAt: session.lastActivityAt || Date.now(),
    };
    stored.fallbackConfirmedAt = Date.now();
    if (session.desktopSessionId) stored.desktopSessionId = session.desktopSessionId;
    this.bridgeSessions.set(sessionId, stored);
    const state = this.runtimeStates.get(sessionId) ?? {
      ownership: "BRIDGE_IDLE" as const,
      turnState: "queued" as const,
    };
    state.ownership = "BRIDGE_IDLE";
    delete state.managed;
    this.runtimeStates.set(sessionId, state);
    await this.saveSessions();
    await this.record({
      sessionId,
      origin: "desktop",
      type: "session.transport",
      data: {
        transport: "bridge-host",
        confirmedFallback: true,
        detail: "Bridge 使用相同 sessionId 和 transcript 接管",
      },
    });
    this.emit("changed");
    setTimeout(() => void this.pump(), 500);
    return this.session(sessionId)!;
  }

  async activateManagedTransport(): Promise<void> {
    if (!this.managedTransport?.ready) throw new Error("Claude Desktop 同步通道尚未就绪");
    let changed = false;
    for (const session of this.bridgeSessions.values()) {
      if (!session.fallbackConfirmedAt) continue;
      delete session.fallbackConfirmedAt;
      changed = true;
    }
    if (changed) await this.saveSessions();
    this.managedTransport.updateCatalog(this.catalog);
    this.refreshObservedOwnership();
    await this.record({
      origin: "desktop",
      type: "session.transport",
      data: {
        transport: "claude-desktop-managed",
        activatedLocally: true,
      },
    });
    this.emit("changed");
    void this.pump();
  }

  async resolveUncertainDelivery(commandId: string, action: "confirm" | "retry"): Promise<TurnReceipt> {
    const turn = this.pending.find((candidate) => candidate.commandId === commandId);
    if (!turn || turn.state !== "uncertain") throw new Error("Uncertain delivery was not found");
    if (turn.mode === "handoff") {
      throw new Error("接力首条消息结果不确定时禁止确认或重发；请取消后重新预览接力");
    }
    const state = this.runtimeStates.get(turn.sessionId);
    if (action === "confirm") {
      turn.uncertainResolved = "confirmed";
      turn.sessionAcceptedAt = Date.now();
      if (state) {
        state.active = turn;
        state.managed = true;
        state.ownership = "DESKTOP_MANAGED_RUNNING";
        state.turnState = "running";
      }
      await this.record({
        sessionId: turn.sessionId,
        ...(turn.turnId ? { turnId: turn.turnId } : {}),
        itemId: turn.commandId,
        origin: "desktop",
        type: "message.delivery",
        data: {
          commandId: turn.commandId,
          requestId: turn.requestId,
          idempotencyKey: turn.idempotencyKey,
          delivery: "session-received",
          manuallyConfirmed: true,
        },
      });
    } else {
      if (!this.managedTransport?.ready) throw new Error("请先恢复 Claude Desktop 同步通道，再检查并重发");
      turn.state = "queued";
      turn.attempts = 0;
      delete turn.turnId;
      delete turn.sessionAcceptedAt;
      delete turn.uncertainResolved;
      this.managedTransport.clearIntent(turn.sessionId);
      if (state?.active?.commandId === turn.commandId) {
        delete state.active;
        state.turnState = "queued";
        state.ownership = "DESKTOP_MANAGED_IDLE";
        this.activeTurns = Math.max(0, this.activeTurns - 1);
      }
      await this.record({
        sessionId: turn.sessionId,
        itemId: turn.commandId,
        origin: "desktop",
        type: "message.delivery",
        data: {
          commandId: turn.commandId,
          requestId: turn.requestId,
          delivery: "host-received",
          manualRetry: true,
        },
      });
      void this.pump();
    }
    await this.saveQueue();
    this.emit("changed");
    return turn;
  }

  resolvePermission(
    requestId: string,
    decision: PermissionDecision,
    message?: string,
    updatedInput?: Record<string, unknown>,
    resolver?: {
      deviceId: string;
      name: string;
    },
  ): boolean {
    return this.permissionBroker.resolveRequest(requestId, decision, message, updatedInput, resolver);
  }

  async history(sessionId: string, cursor?: string, limit = 50): Promise<BridgeHistoryPage> {
    const session = this.session(sessionId);
    if (!session) throw new Error("Session not found");
    const before = decodeCursor(cursor);
    const pageSize = Math.max(1, Math.min(limit, 100));
    const route = this.options.conversationState?.route(sessionId);
    const transcriptSources = route
      ? route.lanes.flatMap((lane) => lane.nativeSessionId ? [lane] : [])
      : [{
          laneId: legacyClaudeLaneId(sessionId),
          conversationId: sessionId,
          providerProfileId: CLAUDE_3P_PROFILE_ID,
          providerKind: "claude-3p" as const,
          status: "active" as const,
          access: "read-write" as const,
          nativeSessionId: sessionId,
          createdAt: session.lastActivityAt,
          updatedAt: session.lastActivityAt,
        }];
    const transcripts = await Promise.all(transcriptSources.map(async (lane) => ({
      lane,
      transcript: await readClaudeSessionHistory(
        this.options.paths.projects,
        lane.nativeSessionId!,
        session.cwd,
        {
          limit: Math.min(10_000, pageSize * 3),
          ...(before ? { before: { createdAt: before.at, id: before.id } } : {}),
        },
      ),
    })));
    const transcriptItems: BridgeHistoryItem[] = transcripts.flatMap(({ lane, transcript }) => (
      transcript.messages.map((message) => ({
        id: message.id,
        sessionId,
        role: message.role,
        text: message.text,
        createdAt: message.createdAt,
        origin: lane.providerKind === "claude-official"
          ? "claude-desktop" as const
          : "claude-host" as const,
      }))
    ));
    const eventSessionIds = new Set([
      sessionId,
      ...transcriptSources.map((lane) => lane.nativeSessionId!).filter(Boolean),
    ]);
    const eventItems = [...eventSessionIds].flatMap((eventSessionId) => (
      this.options.eventLog.history(eventSessionId, undefined, 10_000).items
        .map((item) => ({ ...item, sessionId }))
    ))
      .filter((item) => (
        !before ||
        item.createdAt < before.at ||
        (item.createdAt === before.at && item.id < before.id)
      ));
    const merged = new Map<string, BridgeHistoryItem>();
    for (const item of transcriptItems) merged.set(item.id, item);
    for (const item of eventItems) {
      const existing = merged.get(item.id);
      if (!existing || item.origin !== "claude-desktop") merged.set(item.id, item);
    }
    const all = [...merged.values()]
      .sort(historyOrder)
      .filter((item) => !before || item.createdAt < before.at || (item.createdAt === before.at && item.id < before.id));
    const items = all.slice(-pageSize);
    const hasMore = transcripts.some(({ transcript }) => transcript.truncated) || all.length > items.length;
    return {
      sessionId,
      items,
      hasMore,
      ...(hasMore && items[0] ? { nextCursor: encodeCursor(items[0]) } : {}),
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.clearRuntimeRetry();
    for (const timer of this.takeoverRetryTimers.values()) clearTimeout(timer);
    this.takeoverRetryTimers.clear();
    for (const state of this.runtimeStates.values()) {
      if (state.releaseTimer) clearTimeout(state.releaseTimer);
      await state.host?.close();
    }
    this.options.managedDesktop?.off("status", this.managedStatusListener);
    this.managedTransport?.close();
    await this.eventQueue.catch(() => undefined);
    await Promise.allSettled(this.registrationTasks.values());
    await this.pumpQueue.catch(() => undefined);
    await this.saveQueue();
  }

  private async acquireManaged(turn: QueuedTurn, allowConcurrentSteer = false): Promise<void> {
    const session = this.session(turn.sessionId);
    if (!session || !this.managedTransport?.ready) return;
    const state = this.runtimeStates.get(turn.sessionId) ?? {
      ownership: "DESKTOP_MANAGED_IDLE" as const,
      turnState: "idle" as const,
      managed: true,
    };
    this.runtimeStates.set(turn.sessionId, state);
    const isSteer = turn.mode === "steer";
    if (state.active && !(isSteer && allowConcurrentSteer)) return;

    turn.state = "running";
    turn.transport = "claude-desktop-managed";
    turn.turnId ??= randomUUID();
    turn.attempts += 1;
    state.managed = true;
    state.ownership = "DESKTOP_MANAGED_RUNNING";
    state.turnState = "running";
    if (!isSteer || !state.active) {
      state.active = turn;
      this.activeTurns += 1;
    }
    await this.saveQueue();
    await this.recordOwnership(turn.sessionId, state.ownership);
    await this.record({
      sessionId: turn.sessionId,
      turnId: turn.turnId,
      itemId: turn.commandId,
      origin: "system",
      type: "session.transport",
      data: { transport: "claude-desktop-managed" },
    });
    this.emit("changed");

    const profile = this.effectiveProfile(turn.sessionId, session.cwd);
    try {
      if (session.desktopSessionId || this.managedTransport.desktopSessionId(turn.sessionId)) {
        if (profile.model) await this.managedTransport.setModel(turn.sessionId, profile.model);
        await this.managedTransport.setEffort(turn.sessionId, profile.effort);
      }
      const accepted = await this.managedTransport.send({
        session,
        text: turn.text,
        attachments: turn.attachments,
        origin: turn.origin,
        mode: isSteer ? "steer" : "start",
        ...(profile.model ? { model: profile.model } : {}),
        ...(profile.effort ? { effort: profile.effort } : {}),
        messageId: turn.commandId,
        turnId: turn.turnId,
      });
      const stored = this.bridgeSessions.get(turn.sessionId);
      if (stored) {
        stored.desktopSessionId = accepted.desktopSessionId;
        delete stored.fallbackConfirmedAt;
        await this.saveSessions();
      }
    } catch (error) {
      if (error instanceof ManagedDeliveryUncertainError) {
        await this.handleManagedUncertain(error.intent);
        return;
      }
      if (state.active?.commandId === turn.commandId) {
        delete state.active;
        this.activeTurns = Math.max(0, this.activeTurns - 1);
      }
      state.turnState = "queued";
      state.ownership = "DESKTOP_OBSERVED";
      await this.failQueuedTurn(turn, error instanceof Error ? error.message : String(error));
      await this.recordOwnership(turn.sessionId, state.ownership);
    }
  }

  private async acquire(turn: QueuedTurn): Promise<void> {
    const session = this.session(turn.sessionId);
    if (!session || !this.runtime?.executablePath) return;
    const lane = this.options.conversationState?.lane(turn.laneId);
    const providerKind = lane?.providerKind ?? "claude-3p";
    if (providerKind === "claude-official") {
      await this.failQueuedTurn(turn, "Claude 官方通道为只读，请升级 Bridge 并在 Claude 官方继续");
      return;
    }
    if (providerKind === "claude-3p" && !this.runtime.credentialPath) return;
    const observed = this.catalog.sessions.find((candidate) => candidate.sessionId === turn.sessionId);
    const state = this.runtimeStates.get(turn.sessionId) ?? {
      ownership: "DESKTOP_OBSERVED" as const,
      turnState: "idle" as const,
    };
    this.runtimeStates.set(turn.sessionId, state);
    if (providerKind === "claude-3p" && this.hasConfirmedOwnershipConflict(turn.sessionId, state)) {
      await this.containOwnershipConflict(turn.sessionId, observed?.activeProcesses ?? []);
      return;
    }
    const externalWriteVersion = this.options.observer.externalWriteVersion(turn.sessionId);
    if (
      providerKind === "claude-3p" &&
      !await this.options.observer.canStartBridgeHost(turn.sessionId)
    ) {
      state.ownership = "DESKTOP_OBSERVED";
      state.turnState = "queued";
      await this.recordOwnership(turn.sessionId, state.ownership);
      this.scheduleTakeoverRetry(turn.sessionId);
      return;
    }
    if (!state.host && providerKind === "claude-3p") state.externalWriteVersion = externalWriteVersion;
    if (state.releaseTimer) {
      clearTimeout(state.releaseTimer);
      delete state.releaseTimer;
    }
    const liveWriters = providerKind === "claude-3p"
      ? (await this.sessionProcessScanner(this.options.paths, turn.sessionId))
          .filter((candidate) => candidate.processAlive)
      : [];
    const desktopWriter = liveWriters.some((candidate) => candidate.entrypoint.startsWith("claude-desktop"));
    const foreignBridgeWriter = (
      !state.host &&
      liveWriters.some((candidate) => candidate.entrypoint === "claude-bridge")
    );
    if (foreignBridgeWriter) {
      await this.containOwnershipConflict(turn.sessionId, liveWriters);
      return;
    }
    if (desktopWriter && !observed?.desktopProcessAlive) {
      state.ownership = "DESKTOP_OBSERVED";
      state.turnState = "queued";
      await this.recordOwnership(turn.sessionId, state.ownership);
      this.scheduleTakeoverRetry(turn.sessionId);
      this.emit("changed");
      return;
    }
    try {
      if (providerKind === "claude-3p") {
        await this.assertBridgeHostCompatible(session, state.host);
      }
    } catch (error) {
      const incompatibleHost = state.host;
      delete state.host;
      delete state.hostLaneId;
      await incompatibleHost?.close().catch(() => undefined);
      state.ownership = observed ? "DESKTOP_OBSERVED" : "BRIDGE_IDLE";
      state.turnState = "idle";
      await this.failQueuedTurn(turn, error instanceof Error ? error.message : String(error));
      await this.recordOwnership(turn.sessionId, state.ownership);
      return;
    }
    let accepted: ReturnType<SessionHostRuntime["send"]>;
    let evidenceId: string | undefined;
    try {
      const host = await this.ensureHost(turn.sessionId, turn.laneId);
      const effective = this.effectiveProfile(turn.sessionId, session.cwd);
      await this.applyHostConfiguration(host, {
        ...effective,
        ...(lane?.model ? { model: lane.model, ultracode: false } : {}),
      });
      delete state.configurationPending;
      if (this.options.evidence) {
        evidenceId = await this.evidenceCall(() => this.options.evidence!.startBridgeTurn({
          sessionId: turn.sessionId,
          cwd: session.cwd,
          commandId: turn.commandId,
          laneId: turn.laneId,
          ...(lane ? { providerProfileId: lane.providerProfileId } : {}),
          startedAt: Date.now(),
        }));
      }
      turn.state = "running";
      turn.transport = "bridge-host";
      accepted = host.send({
        text: turn.text,
        attachments: turn.attachments,
      }, turn.origin);
    } catch (error) {
      if (evidenceId) {
        void this.evidenceCall(() => this.options.evidence!.finalizeBridgeTurn({
          sessionId: turn.sessionId,
          failed: true,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
      await state.host?.close().catch(() => undefined);
      delete state.host;
      delete state.hostLaneId;
      state.ownership = "DESKTOP_OBSERVED";
      state.turnState = "queued";
      turn.attempts += 1;
      await this.saveQueue();
      await this.record({
        sessionId: turn.sessionId,
        itemId: turn.commandId,
        origin: "system",
        type: "runtime.error",
        data: {
          error: error instanceof Error ? error.message : String(error),
          retrying: turn.attempts < 5,
        },
      });
      if (turn.mode === "handoff") {
        await this.failQueuedTurn(turn, error instanceof Error ? error.message : String(error));
      } else if (turn.attempts < 5) setTimeout(() => void this.pump(), 3_000);
      else await this.failQueuedTurn(turn, error instanceof Error ? error.message : String(error));
      return;
    }
    turn.attempts += 1;
    turn.turnId = accepted.turnId;
    if (evidenceId) {
      turn.evidenceId = evidenceId;
      await this.evidenceCall(() => this.options.evidence!.attachTurn(evidenceId, accepted.turnId));
    }
    state.active = turn;
    state.ownership = "BRIDGE_RUNNING";
    state.turnState = "running";
    this.activeTurns += 1;
    await this.saveQueue();
    this.emit("changed");
  }

  private async ensureHost(sessionId: string, laneId: string): Promise<SessionHostRuntime> {
    const state = this.runtimeStates.get(sessionId);
    const existing = state?.host;
    if (existing && state.hostLaneId === laneId) return existing;
    if (existing) {
      await existing.close().catch(() => undefined);
      delete state.host;
      delete state.hostLaneId;
    }
    const starting = this.hostStarts.get(laneId);
    if (starting) return starting;
    const promise = this.createHost(sessionId, laneId);
    this.hostStarts.set(laneId, promise);
    try {
      return await promise;
    } finally {
      this.hostStarts.delete(laneId);
    }
  }

  private async createHost(sessionId: string, laneId: string): Promise<SessionHostRuntime> {
    const session = this.session(sessionId);
    if (!session) throw new Error("Session not found");
    if (!this.runtime?.executablePath) {
      throw new Error("Claude Host runtime is unavailable");
    }
    const lane = this.options.conversationState?.lane(laneId);
    if (this.options.conversationState && (!lane || lane.conversationId !== sessionId)) {
      throw new Error("Conversation lane is invalid");
    }
    const providerKind = lane?.providerKind ?? "claude-3p";
    if (providerKind === "claude-3p" && !this.runtime.credentialPath) {
      throw new Error("Claude-3p Host Credentials are unavailable");
    }
    const state = this.runtimeStates.get(sessionId) ?? {
      ownership: "DESKTOP_OBSERVED" as const,
      turnState: "idle" as const,
    };
    this.runtimeStates.set(sessionId, state);
    if (state.host && state.hostLaneId === laneId) return state.host;
    if (providerKind === "claude-3p") {
      state.externalWriteVersion ??= this.options.observer.externalWriteVersion(sessionId);
    }
    if (state.releaseTimer) {
      clearTimeout(state.releaseTimer);
      delete state.releaseTimer;
    }
    state.ownership = "ACQUIRING";
    await this.recordOwnership(sessionId, state.ownership);
    try {
      const plan = lane && this.options.runtimePool
        ? await this.options.runtimePool.hostPlan(sessionId, lane, this.runtime)
        : {
            logicalSessionId: sessionId,
            nativeSessionId: sessionId,
            executablePath: this.runtime.executablePath,
            environment: this.runtime.environment,
            providerKind: "claude-3p" as const,
          };
      const transcript = await findClaudeTranscriptFile(
        this.options.paths.projects,
        plan.nativeSessionId,
        session.cwd,
      );
      const profile = this.effectiveProfile(sessionId, session.cwd);
      const hostModel = lane?.model ?? this.modelForHost(profile);
      const host = this.hostFactory({
        sessionId: plan.nativeSessionId,
        eventSessionId: sessionId,
        cwd: session.cwd,
        executablePath: plan.executablePath,
        environment: plan.environment,
        permissionBroker: this.permissionBroker,
        resume: Boolean(transcript),
        ...(hostModel ? { model: hostModel } : {}),
        ...(profile.effort ? { effort: profile.effort } : {}),
      });
      host.onEvent((event) => {
        this.eventQueue = this.eventQueue
          .catch(() => undefined)
          .then(() => this.handleHostEvent(event));
      });
      state.host = host;
      state.hostLaneId = laneId;
      state.ownership = "BRIDGE_IDLE";
      state.turnState = "idle";
      await this.recordOwnership(sessionId, state.ownership);
      this.emit("changed");
      return host;
    } catch (error) {
      await state.host?.close().catch(() => undefined);
      delete state.host;
      delete state.hostLaneId;
      state.ownership = this.catalog.sessions.some((candidate) => candidate.sessionId === sessionId)
        ? "DESKTOP_OBSERVED"
        : "BRIDGE_IDLE";
      await this.recordOwnership(sessionId, state.ownership);
      this.emit("changed");
      throw error;
    }
  }

  private effectiveProfile(
    sessionId: string,
    cwd: string,
    configuration = this.sessionConfigurations.get(sessionId),
  ): EffectiveSessionProfile {
    const observed = this.catalog.sessions.find((candidate) => candidate.sessionId === sessionId);
    const projectModel = this.catalog.sessions.find((candidate) => (
      candidate.cwd === cwd && Boolean(candidate.hostModel)
    ));
    const projectEffort = this.catalog.sessions.find((candidate) => (
      candidate.cwd === cwd && Boolean(candidate.hostEffort)
    ));
    const inheritedModel = observed?.hostModel ?? projectModel?.hostModel;
    const inheritedEffort = observed?.hostEffort ?? projectEffort?.hostEffort;
    const ultracode = !configuration?.model && observed?.hostUltracode === true;
    const inheritedModelSource: BridgeConfigurationSource = observed?.hostModel
      ? "claude-desktop"
      : projectModel?.hostModel
        ? "project"
        : "default";
    const inheritedEffortSource: BridgeConfigurationSource = observed?.hostEffort
      ? "claude-desktop"
      : projectEffort?.hostEffort
        ? "project"
        : "default";
    return {
      ...(configuration?.model ? { model: configuration.model } : inheritedModel ? { model: inheritedModel } : {}),
      ...(configuration?.effort ? { effort: configuration.effort } : inheritedEffort ? { effort: inheritedEffort } : {}),
      ...(ultracode ? { ultracode: true } : {}),
      ...(inheritedModel ? { inheritedModel } : {}),
      ...(inheritedEffort ? { inheritedEffort } : {}),
      modelSource: configuration?.model ? "bridge" : inheritedModelSource,
      effortSource: configuration?.effort ? "bridge" : inheritedEffortSource,
    };
  }

  private async applyHostConfiguration(
    host: SessionHostRuntime,
    profile: Pick<EffectiveSessionProfile, "model" | "effort" | "ultracode">,
  ): Promise<void> {
    await host.setModel(this.modelForHost(profile));
    await host.setEffort(profile.effort);
  }

  private modelForHost(
    profile: Pick<EffectiveSessionProfile, "model" | "ultracode">,
  ): string | undefined {
    if (!profile.model || !profile.ultracode || /\[1m\]/iu.test(profile.model)) return profile.model;
    return `${profile.model}[1m]`;
  }

  private rememberCatalogModels(): void {
    if (this.modelCatalogComplete) return;
    for (const session of this.catalog.sessions) {
      if (!session.hostModel) continue;
      this.modelCache.set(session.hostModel, {
        value: session.hostModel,
        displayName: this.modelDisplayName(session.hostModel),
      });
    }
  }

  private rememberModels(models: Awaited<ReturnType<SessionHostRuntime["supportedModels"]>>): void {
    if (models.length > 0) this.modelCache.clear();
    for (const model of models) {
      if (!model.value) continue;
      this.modelCache.set(model.value, {
        value: model.value,
        displayName: model.displayName || this.modelDisplayName(model.value),
        ...(model.description ? { description: model.description } : {}),
        ...(model.resolvedModel ? { resolvedModel: model.resolvedModel } : {}),
        ...(model.supportsEffort !== undefined ? { supportsEffort: model.supportsEffort } : {}),
        ...(model.supportedEffortLevels?.length
          ? { supportedEffortLevels: [...model.supportedEffortLevels] }
          : {}),
      });
    }
  }

  private async discoverModelsWithoutAttaching(
    session: BridgeSessionInfo,
  ): ReturnType<SessionHostRuntime["supportedModels"]> {
    if (!this.runtime?.executablePath || !this.runtime.credentialPath) return [];
    const profile = this.effectiveProfile(session.sessionId, session.cwd);
    const host = this.hostFactory({
      sessionId: randomUUID(),
      cwd: dirname(this.options.sessionsPath),
      executablePath: this.runtime.executablePath,
      environment: this.runtime.environment,
      permissionBroker: this.permissionBroker,
      resume: false,
      ...(profile.model ? { model: profile.model } : {}),
      ...(profile.effort ? { effort: profile.effort } : {}),
      settingSources: [],
      persistSession: false,
    });
    let discoveryTimer: NodeJS.Timeout | undefined;
    try {
      host.start();
      return await Promise.race([
        host.supportedModels(),
        new Promise<never>((_resolve, reject) => {
          discoveryTimer = setTimeout(
            () => reject(new Error("Claude model discovery timed out")),
            MODEL_DISCOVERY_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      if (discoveryTimer) clearTimeout(discoveryTimer);
      await host.close().catch(() => undefined);
    }
  }

  private availableModels(selected?: string): BridgeModelInfo[] {
    const models = new Map(this.modelCache);
    if (selected && !models.has(selected)) {
      models.set(selected, {
        value: selected,
        displayName: this.modelDisplayName(selected),
      });
    }
    const longContextAvailable = [...models.keys()].some((value) => /\[1m\]/iu.test(value));
    if (longContextAvailable) {
      for (const model of [...models.values()]) {
        if (
          /\[1m\]/iu.test(model.value) ||
          !/^claude-(?:fable|sonnet|opus)-/iu.test(model.value)
        ) continue;
        const value = `${model.value}[1m]`;
        if (models.has(value)) continue;
        models.set(value, {
          ...model,
          value,
          displayName: `${model.displayName} · 1M`,
          ...(model.resolvedModel ? { resolvedModel: `${model.resolvedModel}[1m]` } : {}),
        });
      }
    }
    return [...models.values()].sort((left, right) => (
      Number(right.value === selected) - Number(left.value === selected)
      || left.displayName.localeCompare(right.displayName, "zh-CN")
    ));
  }

  private findModelInfo(model: string | undefined, models: BridgeModelInfo[]): BridgeModelInfo | undefined {
    if (!model) return undefined;
    return models.find((candidate) => candidate.value === model)
      ?? models.find((candidate) => candidate.resolvedModel === model);
  }

  private modelDisplayName(value: string): string {
    const longContext = /\[1m\]/iu.test(value);
    const normalized = value
      .replace(/\[1m\]/giu, "")
      .replace(/^claude-/iu, "")
      .split("-")
      .filter(Boolean)
      .map((part) => part.length <= 2 ? part.toLocaleUpperCase() : `${part[0]!.toLocaleUpperCase()}${part.slice(1)}`)
      .join(" ");
    return `${normalized || value}${longContext ? " · 1M" : ""}`;
  }

  private modelContextLimit(model: string | undefined, ultracode = false): number {
    return ultracode || (model !== undefined && /\[1m\]|(?:^|[-_])1m(?:$|[-_])/iu.test(model))
      ? LONG_CONTEXT_TOKENS
      : DEFAULT_CONTEXT_TOKENS;
  }

  private async estimatedContext(session: BridgeSessionInfo): Promise<BridgeSessionContextUsage | undefined> {
    const estimate = await readClaudeSessionContextEstimate(
      this.options.paths.projects,
      session.sessionId,
      session.cwd,
    );
    if (!estimate) return undefined;
    const profile = this.effectiveProfile(session.sessionId, session.cwd);
    const maxTokens = this.modelContextLimit(profile.model, profile.ultracode);
    return {
      totalTokens: estimate.totalTokens,
      maxTokens,
      percentage: Math.min(100, (estimate.totalTokens / maxTokens) * 100),
      ...(estimate.model ? { model: estimate.model } : {}),
      estimated: true,
    };
  }

  private async assertContextFits(session: BridgeSessionInfo, model: string): Promise<void> {
    const estimate = await readClaudeSessionContextEstimate(
      this.options.paths.projects,
      session.sessionId,
      session.cwd,
    );
    if (!estimate) return;
    const maxTokens = this.modelContextLimit(model);
    if (estimate.totalTokens <= maxTokens) return;
    throw new Error(
      `当前会话约 ${estimate.totalTokens.toLocaleString("zh-CN")} tokens，所选模型仅提供约 `
      + `${maxTokens.toLocaleString("zh-CN")} tokens 上下文。请先压缩或新建会话，或选择 1M 模型。`,
    );
  }

  private sessionSourceProfile(sessionId: string): ClaudeDesktopProfile {
    const observed = this.catalog.sessions.find((candidate) => candidate.sessionId === sessionId);
    if (observed?.sourceProfile) return observed.sourceProfile;
    const registrationRoot = this.bridgeSessions.get(sessionId)?.desktopRegistration?.profileSessionsRoot;
    return registrationRoot ? claudeDesktopProfileForPath(registrationRoot) : "unknown";
  }

  private runtimeProfile(): ClaudeDesktopProfile {
    return this.runtime?.credentialPath
      ? claudeDesktopProfileForPath(this.runtime.credentialPath)
      : "unknown";
  }

  private profileLabel(profile: ClaudeDesktopProfile): string {
    return profile === "claude" ? "Claude 官方" : profile === "claude-3p" ? "Claude-3p" : "未知";
  }

  private async assertBridgeHostCompatible(
    session: BridgeSessionInfo,
    host?: SessionHostRuntime,
  ): Promise<void> {
    const transcript = await findClaudeTranscriptFile(
      this.options.paths.projects,
      session.sessionId,
      session.cwd,
    );
    if (!transcript) return;

    const sourceProfile = this.sessionSourceProfile(session.sessionId);
    const targetProfile = this.runtimeProfile();
    if (
      sourceProfile !== "unknown" &&
      targetProfile !== "unknown" &&
      sourceProfile !== targetProfile
    ) {
      throw new Error(
        `为保护原会话，Bridge 已在发送前阻止本次操作：该会话来自${this.profileLabel(sourceProfile)}，`
        + `当前 Bridge Host 使用${this.profileLabel(targetProfile)}，Bridge 不允许跨 profile 直接续接。`
        + "原会话未写入新消息；请在原 Claude Desktop 会话继续，或新建 Bridge 会话。",
      );
    }

    const profile = this.effectiveProfile(session.sessionId, session.cwd);
    const estimate = await readClaudeSessionContextEstimate(
      this.options.paths.projects,
      session.sessionId,
      session.cwd,
    );
    const liveUsage = host
      ? await host.contextUsage().catch(() => undefined)
      : undefined;
    const totalTokens = Math.max(estimate?.totalTokens ?? 0, liveUsage?.totalTokens ?? 0);
    const maxTokens = liveUsage?.maxTokens ?? this.modelContextLimit(profile.model, profile.ultracode);
    if (totalTokens <= maxTokens) return;
    throw new Error(
      `为保护原会话，Bridge 已在发送前阻止本次操作：当前会话约 `
      + `${totalTokens.toLocaleString("zh-CN")} tokens，目标模型仅提供约 `
      + `${maxTokens.toLocaleString("zh-CN")} tokens 上下文。原会话未写入新消息；`
      + "请新建 Bridge 会话，或选择兼容的 1M 模型。",
    );
  }

  private scheduleRelease(sessionId: string): void {
    const state = this.runtimeStates.get(sessionId);
    if (
      !state?.host ||
      state.active ||
      state.releaseTimer ||
      this.pending.some((turn) => turn.sessionId === sessionId)
    ) return;
    state.releaseTimer = setTimeout(() => {
      void this.releaseSession(sessionId);
    }, SESSION_RELEASE_DELAY_MS);
  }

  private async handleManagedUncertain(event: ManagedDeliveryUncertain): Promise<void> {
    const state = this.runtimeStates.get(event.sessionId) ?? {
      ownership: "DESKTOP_MANAGED_RUNNING" as const,
      turnState: "waiting" as const,
      managed: true,
    };
    this.runtimeStates.set(event.sessionId, state);
    const turn = this.pending.find((candidate) => (
      candidate.sessionId === event.sessionId &&
      (candidate.turnId === event.turnId || candidate.commandId === event.messageId)
    )) ?? state.active;
    if (!turn) return;
    const alreadyUncertain = turn.state === "uncertain";
    turn.state = "uncertain";
    state.managed = true;
    state.ownership = "DESKTOP_MANAGED_RUNNING";
    state.turnState = "waiting";
    if (!state.active && turn.mode !== "steer") {
      state.active = turn;
      this.activeTurns += 1;
    }
    await this.saveQueue();
    if (!alreadyUncertain) {
      await this.record({
        sessionId: event.sessionId,
        turnId: event.turnId,
        itemId: turn.commandId,
        timestamp: event.at,
        origin: "system",
        type: "message.delivery",
        data: {
          commandId: turn.commandId,
          requestId: turn.requestId,
          idempotencyKey: turn.idempotencyKey,
          delivery: "uncertain",
          error: event.error,
        },
      });
    }
    this.emit("changed");
  }

  private async handleHostEvent(
    event: SessionHostEvent,
    eventOrigin: "claude-host" | "claude-desktop" = "claude-host",
  ): Promise<void> {
    if (
      "turnId" in event &&
      typeof event.turnId === "string" &&
      this.forceStoppedTurnIds.has(event.turnId)
    ) return;
    const state = this.runtimeStates.get(event.sessionId);
    const active = (
      state?.active && state.active.turnId === ("turnId" in event ? event.turnId : undefined)
        ? state.active
        : this.pending.find((turn) => (
            turn.sessionId === event.sessionId &&
            turn.state === "running" &&
            (!("turnId" in event) || !event.turnId || turn.turnId === event.turnId)
          ))
    ) ?? state?.active;
    if (event.type === "assistant.delta") {
      // SDK stream event UUIDs identify chunks, not the assistant response stream.
      const itemId = event.turnId ? `assistant:${event.turnId}` : event.itemId;
      this.options.eventLog.appendCoalescedDelta({
        sessionId: event.sessionId,
        ...(event.turnId ? { turnId: event.turnId } : {}),
        itemId,
        timestamp: event.at,
        origin: eventOrigin,
        type: "assistant.delta",
      }, event.text);
      return;
    }
    if (event.type === "runtime.started" || event.type === "runtime.stopped") return;
    if (event.type === "turn.started") {
      await this.record({
        sessionId: event.sessionId,
        turnId: event.turnId,
        timestamp: event.at,
        origin: eventOrigin,
        type: "turn.started",
        data: {
          delivery: "running",
          ...(active ? {
            commandId: active.commandId,
            requestId: active.requestId,
            idempotencyKey: active.idempotencyKey,
          } : {}),
        },
      });
      return;
    }
    if (event.type === "user.accepted") {
      if (this.options.eventLog.hasItem(event.sessionId, "user.message.accepted", event.messageId)) return;
      if (active) {
        active.sessionAcceptedAt = event.at;
        await this.saveQueue();
      }
      await this.record({
        sessionId: event.sessionId,
        turnId: event.turnId,
        itemId: event.messageId,
        timestamp: event.at,
        origin: event.origin,
        type: "user.message.accepted",
        data: {
          text: event.text,
          attachments: event.attachments,
          delivery: "session-received",
          ...(active ? {
            commandId: active.commandId,
            requestId: active.requestId,
            idempotencyKey: active.idempotencyKey,
          } : {}),
        },
      });
      if (active?.mode === "steer") {
        const index = this.pending.findIndex((candidate) => candidate.commandId === active.commandId);
        if (index >= 0) this.pending.splice(index, 1);
        this.rememberTerminal(active, "completed");
        await this.saveQueue();
        this.emit("changed");
      }
      return;
    }
    if (event.type === "assistant.completed") {
      if (this.options.eventLog.hasItem(event.sessionId, "assistant.completed", event.itemId)) return;
      await this.options.eventLog.flushDeltas(event.sessionId);
      await this.record({
        sessionId: event.sessionId,
        ...(event.turnId ? { turnId: event.turnId } : {}),
        itemId: event.itemId,
        timestamp: event.at,
        origin: eventOrigin,
        type: "assistant.completed",
        data: { text: event.text },
      });
      return;
    }
    if (event.type === "tool.started") {
      if (this.options.eventLog.hasItem(event.sessionId, "tool.started", event.itemId)) return;
      this.toolNames.set(event.itemId, event.toolName);
      if (this.options.evidence) {
        await this.evidenceCall(() => this.options.evidence!.recordToolStarted({
          sessionId: event.sessionId,
          ...(event.turnId ? { turnId: event.turnId } : {}),
          itemId: event.itemId,
          toolName: event.toolName,
          toolInput: event.input,
          at: event.at,
        }));
      }
      await this.record({
        sessionId: event.sessionId,
        ...(event.turnId ? { turnId: event.turnId } : {}),
        itemId: event.itemId,
        timestamp: event.at,
        origin: eventOrigin,
        type: "tool.started",
        data: {
          toolName: event.toolName,
          input: event.input,
          summary: this.toolSummary(event.toolName, event.input),
        },
      });
      return;
    }
    if (event.type === "tool.progress") {
      await this.record({
        sessionId: event.sessionId,
        ...(event.turnId ? { turnId: event.turnId } : {}),
        itemId: event.itemId,
        timestamp: event.at,
        origin: eventOrigin,
        type: "tool.progress",
        data: { text: event.text, toolName: this.toolNames.get(event.itemId) ?? "" },
      });
      return;
    }
    if (event.type === "tool.completed") {
      if (this.options.eventLog.hasItem(event.sessionId, "tool.completed", event.itemId)) return;
      const toolName = this.toolNames.get(event.itemId) ?? "";
      if (this.options.evidence) {
        await this.evidenceCall(() => this.options.evidence!.recordToolCompleted({
          sessionId: event.sessionId,
          ...(event.turnId ? { turnId: event.turnId } : {}),
          itemId: event.itemId,
          output: event.output,
          at: event.at,
        }));
      }
      await this.record({
        sessionId: event.sessionId,
        ...(event.turnId ? { turnId: event.turnId } : {}),
        itemId: event.itemId,
        timestamp: event.at,
        origin: eventOrigin,
        type: "tool.completed",
        data: { toolName, summary: toolName ? `${toolName} completed` : "Tool completed" },
      });
      return;
    }
    if (event.type === "turn.completed") {
      await this.options.eventLog.flushDeltas(event.sessionId);
      await this.record({
        sessionId: event.sessionId,
        ...(event.turnId ? { turnId: event.turnId } : {}),
        timestamp: event.at,
        origin: eventOrigin,
        type: "turn.completed",
        data: {
          result: event.result,
          delivery: "completed",
          ...(active ? {
            commandId: active.commandId,
            requestId: active.requestId,
            idempotencyKey: active.idempotencyKey,
          } : {}),
        },
      });
      if (this.options.evidence) {
        void this.evidenceCall(() => this.options.evidence!.finalizeBridgeTurn({
          sessionId: event.sessionId,
          ...(event.turnId ? { turnId: event.turnId } : {}),
          completedAt: event.at,
        }));
      }
      await this.finishTurn(event.sessionId, "completed");
      return;
    }
    if (event.type === "turn.failed" || event.type === "runtime.error") {
      await this.options.eventLog.flushDeltas(event.sessionId);
      const failedTurnId = "turnId" in event && typeof event.turnId === "string"
        ? event.turnId
        : undefined;
      const shouldRetry = event.type === "runtime.error"
        && Boolean(state?.active)
        && state?.active?.mode !== "handoff"
        && !state?.active?.sessionAcceptedAt
        && this.transientRuntimeError(event.error)
        && (state?.active?.attempts ?? 0) < 5;
      await this.record({
        sessionId: event.sessionId,
        ...("turnId" in event && event.turnId ? { turnId: event.turnId } : {}),
        timestamp: event.at,
        origin: eventOrigin,
        type: event.type === "turn.failed" ? "turn.failed" : "runtime.error",
        data: {
          error: event.error,
          retrying: shouldRetry,
          delivery: shouldRetry ? "host-received" : "failed",
          ...(active ? {
            commandId: active.commandId,
            requestId: active.requestId,
            idempotencyKey: active.idempotencyKey,
          } : {}),
        },
      });
      if (shouldRetry) {
        if (this.options.evidence) {
          void this.evidenceCall(() => this.options.evidence!.finalizeBridgeTurn({
            sessionId: event.sessionId,
            ...(failedTurnId ? { turnId: failedTurnId } : {}),
            failed: true,
            error: event.error,
            completedAt: event.at,
          }));
        }
        await this.requeueActive(event.sessionId);
      } else if (state?.active) {
        if (this.options.evidence) {
          void this.evidenceCall(() => this.options.evidence!.finalizeBridgeTurn({
            sessionId: event.sessionId,
            ...(failedTurnId ? { turnId: failedTurnId } : {}),
            failed: true,
            error: event.error,
            completedAt: event.at,
          }));
        }
        await this.finishTurn(event.sessionId, "failed");
      }
      return;
    }
    if (event.type === "turn.interrupted") {
      await this.options.eventLog.flushDeltas(event.sessionId);
      await this.record({
        sessionId: event.sessionId,
        ...(event.turnId ? { turnId: event.turnId } : {}),
        timestamp: event.at,
        origin: "system",
        type: "turn.interrupted",
        data: {
          delivery: "cancelled",
          ...(active ? {
            commandId: active.commandId,
            requestId: active.requestId,
            idempotencyKey: active.idempotencyKey,
          } : {}),
        },
      });
      if (this.options.evidence) {
        void this.evidenceCall(() => this.options.evidence!.finalizeBridgeTurn({
          sessionId: event.sessionId,
          ...(event.turnId ? { turnId: event.turnId } : {}),
          failed: true,
          error: "任务已停止",
          completedAt: event.at,
        }));
      }
      await this.finishTurn(event.sessionId, "interrupted");
    }
  }

  private async finishTurn(sessionId: string, terminal: "completed" | "failed" | "interrupted"): Promise<void> {
    const state = this.runtimeStates.get(sessionId);
    const turn = state?.active;
    if (!state || !turn) return;
    this.permissionBroker.cancelSession(
      sessionId,
      terminal === "interrupted" ? "turn-interrupted" : "turn-finished",
    );
    state.turnState = terminal;
    state.ownership = state.managed ? "DESKTOP_MANAGED_IDLE" : "BRIDGE_IDLE";
    delete state.active;
    this.activeTurns = Math.max(0, this.activeTurns - 1);
    const index = this.pending.findIndex((candidate) => candidate.commandId === turn.commandId);
    if (index >= 0) this.pending.splice(index, 1);
    this.rememberTerminal(turn, terminal === "interrupted" ? "cancelled" : terminal);
    await this.saveQueue();
    state.turnState = "idle";
    if (!state.managed) {
      state.releaseTimer = setTimeout(() => {
        void this.releaseSession(sessionId);
      }, SESSION_RELEASE_DELAY_MS);
    }
    this.emit("changed");
    void this.reconcileDesktopRegistration(sessionId);
    await this.pump();
  }

  private reconcileDesktopRegistrations(): void {
    if (!this.options.desktopRegistrar || this.closed) return;
    for (const sessionId of this.bridgeSessions.keys()) {
      void this.reconcileDesktopRegistration(sessionId);
    }
  }

  private async reconcileDesktopRegistration(
    sessionId: string,
    force = false,
  ): Promise<void> {
    const registrar = this.options.desktopRegistrar;
    const bridge = this.bridgeSessions.get(sessionId);
    if (!registrar || !bridge || this.closed) return;
    if (!force && bridge.desktopRegistration?.state === "failed") return;
    const active = this.registrationTasks.get(sessionId);
    if (active) return active;
    const task = (async () => {
      const profile = this.effectiveProfile(sessionId, bridge.cwd);
      const observed = this.catalog.sessions.find((session) => session.sessionId === sessionId);
      const input: DesktopSessionRegistrationInput = {
        sessionId,
        cwd: bridge.cwd,
        title: bridge.title,
        createdAt: bridge.createdAt,
        lastActivityAt: Math.max(bridge.createdAt, observed?.lastActivityAt ?? 0),
        ...(profile.model ? { model: profile.model } : {}),
        ...(profile.effort ? { effort: profile.effort } : {}),
      };
      let next: StoredDesktopRegistration;
      try {
        next = await registrar.register(input, bridge.desktopRegistration);
      } catch {
        const previous = bridge.desktopRegistration;
        next = {
          ...(previous?.metadataPath ? { metadataPath: previous.metadataPath } : {}),
          ...(previous?.metadataSha256 ? { metadataSha256: previous.metadataSha256 } : {}),
          ...(previous?.profileSessionsRoot
            ? { profileSessionsRoot: previous.profileSessionsRoot }
            : {}),
          ...(previous?.desktopSessionId
            ? { desktopSessionId: previous.desktopSessionId }
            : {}),
          ...(previous?.registeredAt ? { registeredAt: previous.registeredAt } : {}),
          ...(previous?.claudePidAtRegistration
            ? { claudePidAtRegistration: previous.claudePidAtRegistration }
            : {}),
          state: "failed",
          detail: "Claude Desktop 会话登记失败，Bridge 会话仍可正常使用。",
          updatedAt: Date.now(),
        };
      }
      if (!registrar.changed(bridge.desktopRegistration, next)) return;
      bridge.desktopRegistration = next;
      if (next.state === "registered" && next.desktopSessionId) {
        bridge.desktopSessionId = next.desktopSessionId;
      }
      await this.saveSessions();
      const info: BridgeDesktopRegistrationInfo = registrar.publicInfo(next);
      await this.record({
        sessionId,
        origin: "system",
        type: "session.desktop-registration",
        data: { ...info },
      });
      this.emit("changed");
    })().finally(() => {
      if (this.registrationTasks.get(sessionId) === task) {
        this.registrationTasks.delete(sessionId);
      }
    });
    this.registrationTasks.set(sessionId, task);
    return task;
  }

  private transientRuntimeError(error: string): boolean {
    return /(already.{0,24}(active|running|use)|session.{0,24}(lock|busy|active)|locked|resource busy|in use)/iu.test(error);
  }

  private async requeueActive(sessionId: string): Promise<void> {
    const state = this.runtimeStates.get(sessionId);
    const turn = state?.active;
    if (!state || !turn) return;
    const host = state.host;
    delete state.active;
    delete state.host;
    delete state.hostLaneId;
    turn.state = "queued";
    delete turn.turnId;
    delete turn.sessionAcceptedAt;
    state.ownership = "DESKTOP_OBSERVED";
    state.turnState = "queued";
    this.activeTurns = Math.max(0, this.activeTurns - 1);
    await host?.close().catch(() => undefined);
    await this.saveQueue();
    await this.recordOwnership(sessionId, state.ownership);
    await this.record({
      sessionId,
      itemId: turn.commandId,
      origin: "system",
      type: "turn.queued",
      data: {
        commandId: turn.commandId,
        requestId: turn.requestId,
        delivery: "host-received",
        retrying: true,
        attempt: turn.attempts,
      },
    });
    this.emit("changed");
    setTimeout(() => void this.pump(), 3_000);
  }

  private async failQueuedTurn(turn: QueuedTurn, error: string): Promise<void> {
    const index = this.pending.findIndex((candidate) => candidate.commandId === turn.commandId);
    if (index >= 0) this.pending.splice(index, 1);
    this.rememberTerminal(turn, "failed");
    await this.saveQueue();
    await this.record({
      sessionId: turn.sessionId,
      itemId: turn.commandId,
      origin: "system",
      type: "turn.failed",
      data: {
        commandId: turn.commandId,
        requestId: turn.requestId,
        error,
        delivery: "failed",
      },
    });
    this.emit("changed");
  }

  private async releaseSession(sessionId: string): Promise<void> {
    const state = this.runtimeStates.get(sessionId);
    if (!state?.host || state.active || this.pending.some((turn) => turn.sessionId === sessionId)) return;
    state.ownership = "RELEASING";
    await this.recordOwnership(sessionId, state.ownership);
    await state.host.close();
    delete state.host;
    delete state.hostLaneId;
    delete state.releaseTimer;
    state.ownership = this.catalog.sessions.some((session) => session.sessionId === sessionId)
      ? "DESKTOP_OBSERVED"
      : "BRIDGE_IDLE";
    await this.recordOwnership(sessionId, state.ownership);
    this.emit("changed");
  }

  private pump(): Promise<void> {
    const next = this.pumpQueue
      .catch(() => undefined)
      .then(() => this.pumpOnce());
    this.pumpQueue = next;
    return next;
  }

  private async pumpOnce(): Promise<void> {
    if (this.closed || !this.initialized) return;
    if (!this.managedTransport?.ready && !this.runtime?.executablePath) {
      await this.refreshRuntime();
    }
    this.sortPending();
    for (const turn of this.pending) {
      if (this.activeTurns >= this.maxParallelTurns) break;
      if (turn.state !== "queued") continue;
      if (turn.recoveryBlocked) continue;
      const state = this.runtimeStates.get(turn.sessionId);
      // Conflict containment owns the session until the old host is closed and the turn is persisted.
      const conflictSettling = this.conflictTasks.has(turn.sessionId) || (
        state?.ownership === "OWNERSHIP_CONFLICT" &&
        this.takeoverRetryTimers.has(turn.sessionId)
      );
      if (state?.active || conflictSettling) continue;
      const lane = this.options.conversationState?.lane(turn.laneId);
      const providerKind = lane?.providerKind ?? "claude-3p";
      const observed = this.catalog.sessions.find((candidate) => candidate.sessionId === turn.sessionId);
      if (providerKind === "claude-3p" && this.hasConfirmedOwnershipConflict(turn.sessionId, state)) {
        await this.containOwnershipConflict(turn.sessionId, observed?.activeProcesses ?? []);
        continue;
      }
      const fallbackConfirmed = Boolean(this.bridgeSessions.get(turn.sessionId)?.fallbackConfirmedAt);
      if (
        turn.mode !== "handoff" &&
        providerKind === "claude-3p" &&
        this.managedTransport?.ready &&
        !fallbackConfirmed
      ) {
        await this.acquireManaged(turn);
        continue;
      }
      if (
        providerKind === "claude-3p" &&
        !await this.options.observer.canStartBridgeHost(turn.sessionId)
      ) {
        const waiting = state ?? {
          ownership: "DESKTOP_OBSERVED" as const,
          turnState: "queued" as const,
        };
        waiting.ownership = "DESKTOP_OBSERVED";
        waiting.turnState = "queued";
        this.runtimeStates.set(turn.sessionId, waiting);
        this.scheduleTakeoverRetry(turn.sessionId);
        continue;
      }
      this.clearTakeoverRetry(turn.sessionId);
      if (
        !this.runtime?.executablePath ||
        (providerKind === "claude-3p" && !this.runtime.credentialPath)
      ) continue;
      await this.acquire(turn);
    }
    this.emit("changed");
  }

  private scheduleRuntimeRetry(): void {
    if (this.runtimeRetryTimer || this.closed) return;
    this.runtimeRetryTimer = setTimeout(() => {
      this.runtimeRetryTimer = undefined;
      void this.refreshRuntime();
    }, this.options.runtimeRetryDelayMs ?? RUNTIME_RETRY_DELAY_MS);
    this.runtimeRetryTimer.unref?.();
  }

  private scheduleTakeoverRetry(sessionId: string): void {
    if (this.closed || this.takeoverRetryTimers.has(sessionId)) return;
    const timer = setTimeout(() => {
      this.takeoverRetryTimers.delete(sessionId);
      void this.pump();
    }, 1_500);
    timer.unref?.();
    this.takeoverRetryTimers.set(sessionId, timer);
  }

  private clearTakeoverRetry(sessionId: string): void {
    const timer = this.takeoverRetryTimers.get(sessionId);
    if (!timer) return;
    clearTimeout(timer);
    this.takeoverRetryTimers.delete(sessionId);
  }

  private clearRuntimeRetry(): void {
    if (!this.runtimeRetryTimer) return;
    clearTimeout(this.runtimeRetryTimer);
    this.runtimeRetryTimer = undefined;
  }

  private hasConfirmedOwnershipConflict(
    sessionId: string,
    state = this.runtimeStates.get(sessionId),
  ): boolean {
    return Boolean(
      state?.host &&
      state.externalWriteVersion !== undefined &&
      this.options.observer.externalWriteVersion(sessionId) > state.externalWriteVersion
    );
  }

  private refreshObservedOwnership(): void {
    for (const observed of this.catalog.sessions) {
      const state = this.runtimeStates.get(observed.sessionId);
      if (this.hasConfirmedOwnershipConflict(observed.sessionId, state)) {
        void this.containOwnershipConflict(observed.sessionId, observed.activeProcesses);
        continue;
      }
      if (!state) continue;
      if (!state.host && !state.active) {
        const fallbackConfirmed = Boolean(this.bridgeSessions.get(observed.sessionId)?.fallbackConfirmedAt);
        const managed = Boolean(this.managedTransport?.ready && !fallbackConfirmed);
        state.managed = managed;
        state.ownership = managed
          ? this.options.observer.isDesktopBusy(observed.sessionId)
            ? "DESKTOP_MANAGED_RUNNING"
            : "DESKTOP_MANAGED_IDLE"
          : "DESKTOP_OBSERVED";
        state.turnState = this.options.observer.isDesktopBusy(observed.sessionId) ? "running" : "idle";
      }
    }
  }

  private async containOwnershipConflict(
    sessionId: string,
    processes: ClaudeCatalogSnapshot["sessions"][number]["activeProcesses"],
  ): Promise<void> {
    const existing = this.conflictTasks.get(sessionId);
    if (existing) return existing;
    const task = this.resolveOwnershipConflict(sessionId, processes)
      .finally(() => {
        if (this.conflictTasks.get(sessionId) === task) this.conflictTasks.delete(sessionId);
      });
    this.conflictTasks.set(sessionId, task);
    return task;
  }

  private async resolveOwnershipConflict(
    sessionId: string,
    processes: ClaudeCatalogSnapshot["sessions"][number]["activeProcesses"],
  ): Promise<void> {
    const existingState = this.runtimeStates.get(sessionId);
    const state = existingState ?? {
      ownership: "DESKTOP_OBSERVED" as const,
      turnState: "waiting" as const,
    };
    const wasConflict = existingState?.ownership === "OWNERSHIP_CONFLICT";
    const host = state.host;
    const active = state.active;
    if (state.releaseTimer) {
      clearTimeout(state.releaseTimer);
      delete state.releaseTimer;
    }
    delete state.host;
    delete state.hostLaneId;
    state.ownership = "OWNERSHIP_CONFLICT";
    state.turnState = active?.transport === "bridge-host"
      || this.pending.some((turn) => turn.sessionId === sessionId && turn.state === "queued")
      ? "queued"
      : "waiting";
    this.runtimeStates.set(sessionId, state);

    if (active?.transport === "bridge-host") {
      this.permissionBroker.cancelSession(sessionId);
      delete state.active;
      active.state = "queued";
      delete active.turnId;
      delete active.sessionAcceptedAt;
      this.activeTurns = Math.max(0, this.activeTurns - 1);
      await this.saveQueue();
      await host?.close().catch(() => undefined);
      await this.record({
        sessionId,
        itemId: active.commandId,
        origin: "system",
        type: "turn.queued",
        data: {
          commandId: active.commandId,
          requestId: active.requestId,
          idempotencyKey: active.idempotencyKey,
          delivery: "host-received",
          retrying: true,
          reason: "ownership-conflict",
          attempt: active.attempts,
        },
      });
    } else {
      await host?.close().catch(() => undefined);
    }

    if (!wasConflict) {
      await this.record({
        sessionId,
        origin: "system",
        type: "session.ownership-conflict",
        data: {
          ownership: "OWNERSHIP_CONFLICT",
          writers: processes
            .filter((candidate) => candidate.processAlive)
            .map((candidate) => ({
              pid: candidate.pid,
              entrypoint: candidate.entrypoint,
              protocol: candidate.peerProtocol,
            })),
        },
      });
      await this.recordOwnership(sessionId, state.ownership);
    }
    this.emit("changed");
    this.scheduleTakeoverRetry(sessionId);
  }

  private async recordOwnership(sessionId: string, ownership: BridgeOwnershipState): Promise<void> {
    await this.record({
      sessionId,
      origin: "system",
      type: "session.ownership",
      data: { ownership },
    });
  }

  private async record(draft: BridgeEventDraft): Promise<void> {
    await this.options.eventLog.append(draft);
  }

  private toolSummary(toolName: string, input: unknown): string {
    if (input && typeof input === "object") {
      const value = input as Record<string, unknown>;
      const target = value.command ?? value.file_path ?? value.path ?? value.query;
      if (typeof target === "string") return `${toolName}: ${compact(target, 120)}`;
    }
    return `${toolName} started`;
  }

  private sortPending(): void {
    this.pending.sort((left, right) => right.priority - left.priority || left.requestedAt - right.requestedAt);
  }

  private rememberTerminal(turn: Pick<QueuedTurn, "idempotencyKey" | "commandId" | "requestId" | "sessionId">, state: TerminalTurnState): void {
    const receipt: TerminalTurnReceipt = {
      idempotencyKey: turn.idempotencyKey,
      commandId: turn.commandId,
      requestId: turn.requestId,
      sessionId: turn.sessionId,
      state,
    };
    this.completedKeys.delete(turn.idempotencyKey);
    this.completedKeys.add(turn.idempotencyKey);
    this.terminalTurns.set(turn.idempotencyKey, receipt);
    while (this.completedKeys.size > 2_000) {
      const oldest = this.completedKeys.values().next().value as string | undefined;
      if (!oldest) break;
      this.completedKeys.delete(oldest);
      this.terminalTurns.delete(oldest);
    }
  }

  private async loadSessions(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.options.sessionsPath, "utf8")) as Partial<BridgeSessionsFile>;
      if (parsed.version !== 2 || !Array.isArray(parsed.sessions)) throw new Error("Unsupported Bridge session file");
      for (const session of parsed.sessions) this.bridgeSessions.set(session.sessionId, session);
      for (const configuration of parsed.configurations ?? []) {
        if (
          !configuration ||
          typeof configuration.sessionId !== "string" ||
          typeof configuration.updatedAt !== "number" ||
          (configuration.model !== undefined && typeof configuration.model !== "string") ||
          (configuration.effort !== undefined && !EFFORT_LEVELS.includes(configuration.effort)) ||
          (
            configuration.permissionMode !== undefined &&
            configuration.permissionMode !== "standard" &&
            configuration.permissionMode !== "full-access"
          )
        ) continue;
        this.sessionConfigurations.set(configuration.sessionId, configuration);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      await rename(this.options.sessionsPath, `${this.options.sessionsPath}.archive-${Date.now()}`).catch(() => undefined);
    }
  }

  private async saveSessions(): Promise<void> {
    if (this.options.conversationState) {
      this.options.conversationState.saveBrokerSessions(
        [...this.bridgeSessions.values()],
        [...this.sessionConfigurations.values()],
      );
      return;
    }
    const contents = `${JSON.stringify({
      version: 2,
      sessions: [...this.bridgeSessions.values()],
      configurations: [...this.sessionConfigurations.values()],
    } satisfies BridgeSessionsFile, null, 2)}\n`;
    await this.atomicWrite(this.options.sessionsPath, contents);
  }

  private async loadQueue(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.options.queuePath, "utf8")) as Partial<TurnQueueFile>;
      if (parsed.version !== 2 || !Array.isArray(parsed.pending) || !Array.isArray(parsed.completedIdempotencyKeys)) {
        throw new Error("Unsupported Bridge queue file");
      }
      for (const turn of parsed.pending) {
        const state = turn.mode === "handoff" || turn.state === "uncertain" || (
          turn.state === "running" && turn.transport === "claude-desktop-managed"
        )
          ? "uncertain"
          : "queued";
        const restored: QueuedTurn = {
          ...turn,
          laneId: typeof turn.laneId === "string"
            ? turn.laneId
            : legacyClaudeLaneId(turn.sessionId),
          state,
          priority: turn.priority ?? 0,
          attempts: turn.attempts ?? 0,
          mode: turn.mode ?? "start",
          sessionTitle: turn.sessionTitle ?? `未完成任务：${compact(turn.text, 72)}`,
        };
        if (!restored.sessionCwd) {
          const transcriptPath = await findClaudeTranscriptFile(
            this.options.paths.projects,
            restored.sessionId,
          );
          if (transcriptPath) {
            const recoveredCwd = await transcriptCwd(transcriptPath);
            if (recoveredCwd) restored.sessionCwd = recoveredCwd;
          }
        }
        this.pending.push(restored);
        if (state === "uncertain" && restored.mode !== "steer" && restored.mode !== "handoff") {
          this.runtimeStates.set(restored.sessionId, {
            ownership: "DESKTOP_MANAGED_RUNNING",
            turnState: "waiting",
            active: restored,
            managed: true,
          });
          this.activeTurns += 1;
        }
      }
      for (const key of parsed.completedIdempotencyKeys) this.completedKeys.add(key);
      if (Array.isArray(parsed.terminalTurns)) {
        for (const receipt of parsed.terminalTurns) {
          if (
            !receipt ||
            typeof receipt.idempotencyKey !== "string" ||
            typeof receipt.commandId !== "string" ||
            typeof receipt.requestId !== "string" ||
            typeof receipt.sessionId !== "string" ||
            !["completed", "failed", "cancelled"].includes(receipt.state)
          ) continue;
          this.terminalTurns.set(receipt.idempotencyKey, receipt);
          this.completedKeys.add(receipt.idempotencyKey);
        }
      }
      this.sortPending();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      await rename(this.options.queuePath, `${this.options.queuePath}.archive-${Date.now()}`).catch(() => undefined);
    }
  }

  private refreshRecoveryBlocks(): void {
    const observedIds = new Set(this.catalog.sessions.map((session) => session.sessionId));
    for (const turn of this.pending) {
      if (turn.state !== "queued" && turn.state !== "uncertain") continue;
      const blocked = !observedIds.has(turn.sessionId) && !this.bridgeSessions.has(turn.sessionId);
      turn.recoveryBlocked = blocked;
      if (!blocked || turn.state !== "uncertain") continue;
      if (turn.mode === "handoff") continue;
      if (turn.mode !== "steer") this.activeTurns = Math.max(0, this.activeTurns - 1);
      turn.state = "queued";
      this.runtimeStates.delete(turn.sessionId);
    }
  }

  private async saveQueue(): Promise<void> {
    if (this.options.conversationState) {
      this.options.conversationState.saveBrokerQueue(
        this.pending.map((turn) => ({ ...turn })),
        [...this.completedKeys].slice(-2_000),
        [...this.terminalTurns.values()].slice(-2_000),
      );
      return;
    }
    const contents = `${JSON.stringify({
      version: 2,
      pending: this.pending,
      completedIdempotencyKeys: [...this.completedKeys].slice(-2_000),
      terminalTurns: [...this.terminalTurns.values()].slice(-2_000),
    } satisfies TurnQueueFile, null, 2)}\n`;
    await this.atomicWrite(this.options.queuePath, contents);
  }

  private async atomicWrite(path: string, contents: string): Promise<void> {
    this.writeQueue = this.writeQueue.catch(() => undefined).then(async () => {
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${process.pid}.tmp`;
      await writeFile(temporary, contents, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, path);
    });
    await this.writeQueue;
  }

  private async loadConversationState(): Promise<void> {
    const persisted = this.options.conversationState!.loadBrokerState();
    for (const session of persisted.sessions) {
      this.bridgeSessions.set(session.sessionId, session as StoredBridgeSession);
    }
    for (const configuration of persisted.configurations) {
      if (
        typeof configuration.sessionId !== "string" ||
        typeof configuration.updatedAt !== "number" ||
        (configuration.model !== undefined && typeof configuration.model !== "string") ||
        (configuration.effort !== undefined && !EFFORT_LEVELS.includes(configuration.effort as BridgeEffort)) ||
        (
          configuration.permissionMode !== undefined &&
          configuration.permissionMode !== "standard" &&
          configuration.permissionMode !== "full-access"
        )
      ) continue;
      this.sessionConfigurations.set(
        configuration.sessionId,
        configuration as StoredSessionConfiguration,
      );
    }
    await this.restoreQueue(
      persisted.pending as unknown as QueuedTurn[],
      persisted.completedIdempotencyKeys,
      persisted.terminalTurns as TerminalTurnReceipt[],
    );
  }

  private async restoreQueue(
    pending: QueuedTurn[],
    completedKeys: string[],
    terminalTurns: TerminalTurnReceipt[],
  ): Promise<void> {
    for (const turn of pending) {
      const state = turn.mode === "handoff" || turn.state === "uncertain" || (
        turn.state === "running" && turn.transport === "claude-desktop-managed"
      )
        ? "uncertain"
        : "queued";
      const restored: QueuedTurn = {
        ...turn,
        laneId: turn.laneId ?? legacyClaudeLaneId(turn.sessionId),
        state,
        priority: turn.priority ?? 0,
        attempts: turn.attempts ?? 0,
        mode: turn.mode ?? "start",
        sessionTitle: turn.sessionTitle ?? `未完成任务：${compact(turn.text, 72)}`,
      };
      if (!restored.sessionCwd) {
        const transcriptPath = await findClaudeTranscriptFile(
          this.options.paths.projects,
          restored.sessionId,
        );
        if (transcriptPath) {
          const recoveredCwd = await transcriptCwd(transcriptPath);
          if (recoveredCwd) restored.sessionCwd = recoveredCwd;
        }
      }
      this.pending.push(restored);
      if (state === "uncertain" && restored.mode !== "steer" && restored.mode !== "handoff") {
        this.runtimeStates.set(restored.sessionId, {
          ownership: "DESKTOP_MANAGED_RUNNING",
          turnState: "waiting",
          active: restored,
          managed: true,
        });
        this.activeTurns += 1;
      }
    }
    for (const key of completedKeys) this.completedKeys.add(key);
    for (const receipt of terminalTurns) {
      this.terminalTurns.set(receipt.idempotencyKey, receipt);
      this.completedKeys.add(receipt.idempotencyKey);
    }
    this.sortPending();
  }
}
