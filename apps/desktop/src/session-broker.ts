import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute } from "node:path";
import type {
  BridgeAttachment,
  BridgeHistoryItem,
  BridgeHistoryPage,
  BridgeOwnershipState,
  BridgeProjectInfo,
  BridgeRuntimeStatus,
  BridgeSessionInfo,
  BridgeTurnState,
} from "@bridge/protocol";
import { ClaudeSessionHost, type ClaudeSessionHostOptions, type SessionHostEvent } from "./claude-session-host.js";
import { findClaudeTranscriptFile, readClaudeSessionHistory } from "./claude-history.js";
import { projectIdForCwd, type ClaudeCatalogSnapshot } from "./claude-session-catalog.js";
import { PermissionBroker, type PermissionDecision } from "./permission-broker.js";
import type { ClaudeRuntimePaths } from "./platform.js";
import { prepareClaudeRuntime } from "./claude-runtime-discovery.js";
import type { BridgeEventDraft, SessionEventLog } from "./session-event-log.js";

interface StoredBridgeSession {
  sessionId: string;
  cwd: string;
  title: string;
  createdAt: number;
}

interface BridgeSessionsFile {
  version: 2;
  sessions: StoredBridgeSession[];
}

export interface QueuedTurn {
  commandId: string;
  requestId: string;
  idempotencyKey: string;
  sessionId: string;
  text: string;
  attachments: BridgeAttachment[];
  origin: "desktop" | "mobile";
  sourceDeviceId?: string;
  requestedAt: number;
  priority: number;
  attempts: number;
  state: "queued" | "running";
  turnId?: string;
  sessionAcceptedAt?: number;
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
  active?: QueuedTurn;
  releaseTimer?: ReturnType<typeof setTimeout>;
}

export interface SessionHostRuntime {
  start(): void;
  send(
    input: Parameters<ClaudeSessionHost["send"]>[0],
    origin: Parameters<ClaudeSessionHost["send"]>[1],
  ): ReturnType<ClaudeSessionHost["send"]>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
  onEvent(listener: (event: SessionHostEvent) => void): () => void;
}

export interface TranscriptObserverRuntime {
  readonly catalog: ClaudeCatalogSnapshot;
  isDesktopBusy(sessionId: string, now?: number): boolean;
  onCatalog(listener: (catalog: ClaudeCatalogSnapshot) => void): () => void;
}

export interface SessionBrokerOptions {
  paths: ClaudeRuntimePaths;
  eventLog: SessionEventLog;
  observer: TranscriptObserverRuntime;
  sessionsPath: string;
  queuePath: string;
  maxParallelTurns?: number;
  hostFactory?: (options: ClaudeSessionHostOptions) => SessionHostRuntime;
  prepareRuntime?: typeof prepareClaudeRuntime;
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
}

function compact(value: string, max = 160): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
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
  readonly permissionBroker = new PermissionBroker();
  private readonly maxParallelTurns: number;
  private readonly hostFactory: NonNullable<SessionBrokerOptions["hostFactory"]>;
  private readonly runtimeFactory: typeof prepareClaudeRuntime;
  private readonly runtimeStates = new Map<string, SessionRuntimeState>();
  private readonly bridgeSessions = new Map<string, StoredBridgeSession>();
  private readonly pending: QueuedTurn[] = [];
  private readonly completedKeys = new Set<string>();
  private readonly terminalTurns = new Map<string, TerminalTurnReceipt>();
  private catalog: ClaudeCatalogSnapshot = { projects: [], sessions: [], observedAt: 0 };
  private runtime: Awaited<ReturnType<typeof prepareClaudeRuntime>> | undefined;
  private activeTurns = 0;
  private initialized = false;
  private closed = false;
  private writeQueue: Promise<void> = Promise.resolve();
  private eventQueue: Promise<void> = Promise.resolve();
  private pumpQueue: Promise<void> = Promise.resolve();
  private readonly toolNames = new Map<string, string>();

  constructor(private readonly options: SessionBrokerOptions) {
    super();
    this.maxParallelTurns = options.maxParallelTurns ?? 2;
    this.hostFactory = options.hostFactory ?? ((hostOptions) => new ClaudeSessionHost(hostOptions));
    this.runtimeFactory = options.prepareRuntime ?? prepareClaudeRuntime;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    await Promise.all([
      this.options.eventLog.initialize(),
      this.loadSessions(),
      this.loadQueue(),
    ]);
    this.catalog = this.options.observer.catalog;
    this.options.observer.onCatalog((catalog) => {
      this.catalog = catalog;
      this.refreshObservedOwnership();
      this.emit("changed");
      void this.pump();
    });
    this.permissionBroker.on("requested", (request) => {
      const type = request.toolName === "AskUserQuestion" ? "question.requested" : "permission.requested";
      void this.record({
        sessionId: request.sessionId,
        itemId: request.requestId,
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
        },
      });
      this.emit("changed");
    });
    this.permissionBroker.on("resolved", (request, result) => {
      const type = request.toolName === "AskUserQuestion" ? "question.resolved" : "permission.resolved";
      void this.record({
        sessionId: request.sessionId,
        itemId: request.requestId,
        origin: "system",
        type,
        data: { requestId: request.requestId, behavior: result.behavior },
      });
      this.emit("changed");
    });
    this.runtime = await this.runtimeFactory();
    await this.pump();
  }

  runtimeStatus(): BridgeRuntimeStatus {
    if (!this.runtime?.executablePath) {
      return {
        state: "unavailable",
        detail: "未找到 Claude CLI Host 运行时。",
        activeTurns: this.activeTurns,
        maxParallelTurns: this.maxParallelTurns,
      };
    }
    if (!this.runtime.credentialPath) {
      return {
        state: "auth-required",
        detail: "未找到 Claude Desktop 第三方 Host 凭据。Bridge 不提供官方账号登录。",
        ...(this.runtime.version ? { version: this.runtime.version } : {}),
        activeTurns: this.activeTurns,
        maxParallelTurns: this.maxParallelTurns,
      };
    }
    return {
      state: this.activeTurns > 0 ? "working" : "ready",
      detail: this.activeTurns > 0
        ? `${this.activeTurns} 个会话正在由 Bridge 托管。`
        : "第三方 Claude Host 通道已就绪。",
      ...(this.runtime.version ? { version: this.runtime.version } : {}),
      credentialSource: "third-party-host",
      activeTurns: this.activeTurns,
      maxParallelTurns: this.maxParallelTurns,
    };
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
        });
      }
    }
    return [...grouped.values()].sort((left, right) => right.lastActivityAt - left.lastActivityAt);
  }

  listSessions(projectId?: string, search?: string): BridgeSessionInfo[] {
    const observed = new Map(this.catalog.sessions.map((session) => [session.sessionId, session]));
    const ids = new Set([...observed.keys(), ...this.bridgeSessions.keys(), ...this.runtimeStates.keys()]);
    const sessions: BridgeSessionInfo[] = [];
    for (const sessionId of ids) {
      const source = observed.get(sessionId);
      const bridge = this.bridgeSessions.get(sessionId);
      if (!source && !bridge) continue;
      const cwd = source?.cwd ?? bridge!.cwd;
      const state = this.runtimeStates.get(sessionId);
      const pendingCount = this.pending.filter((turn) => turn.sessionId === sessionId && turn.state === "queued").length;
      const ownership = state?.ownership ?? "DESKTOP_OBSERVED";
      const turnState = state?.turnState
        ?? (source && this.options.observer.isDesktopBusy(sessionId) ? "running" : "idle");
      const item: BridgeSessionInfo = {
        sessionId,
        ...(source?.desktopSessionId ? { desktopSessionId: source.desktopSessionId } : {}),
        projectId: projectIdForCwd(cwd),
        projectName: basename(cwd) || cwd,
        cwd,
        title: source?.title ?? bridge?.title ?? (basename(cwd) || cwd),
        source: bridge ? "bridge" : "desktop",
        ownership,
        turnState: pendingCount > 0 && turnState === "idle" ? "queued" : turnState,
        lastActivityAt: Math.max(source?.lastActivityAt ?? 0, bridge?.createdAt ?? 0),
        pendingCount,
        ...(state?.active?.turnId ? { activeTurnId: state.active.turnId } : {}),
        ...(state?.active?.text ? { currentSummary: compact(state.active.text) } : {}),
      };
      if (projectId && item.projectId !== projectId) continue;
      if (search) {
        const query = search.toLocaleLowerCase();
        if (!`${item.title}\n${item.projectName}\n${item.cwd}`.toLocaleLowerCase().includes(query)) continue;
      }
      sessions.push(item);
    }
    return sessions.sort((left, right) => (
      Number(right.turnState === "running") - Number(left.turnState === "running")
      || right.lastActivityAt - left.lastActivityAt
    ));
  }

  session(sessionId: string): BridgeSessionInfo | undefined {
    return this.listSessions().find((candidate) => candidate.sessionId === sessionId);
  }

  async createSession(cwd: string, title?: string): Promise<BridgeSessionInfo> {
    if (!isAbsolute(cwd)) throw new Error("Project path must be absolute");
    await access(cwd);
    const session: StoredBridgeSession = {
      sessionId: randomUUID(),
      cwd,
      title: compact(title?.trim() || basename(cwd) || cwd, 140),
      createdAt: Date.now(),
    };
    this.bridgeSessions.set(session.sessionId, session);
    this.runtimeStates.set(session.sessionId, {
      ownership: "BRIDGE_IDLE",
      turnState: "idle",
    });
    await this.saveSessions();
    await this.record({
      sessionId: session.sessionId,
      origin: "system",
      type: "session.created",
      data: { cwd: session.cwd, title: session.title },
    });
    this.emit("changed");
    return this.session(session.sessionId)!;
  }

  async startTurn(input: StartTurnInput): Promise<QueuedTurn | TurnReceipt> {
    await this.initialize();
    const text = input.text.trim();
    const attachments = input.attachments ?? [];
    if (!text && attachments.length === 0) throw new Error("Message cannot be empty");
    if (!this.session(input.sessionId)) throw new Error("Session not found");
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
      text,
      attachments,
      origin: input.origin,
      ...(input.sourceDeviceId ? { sourceDeviceId: input.sourceDeviceId } : {}),
      requestedAt: Date.now(),
      priority: input.priority ?? 0,
      attempts: 0,
      state: "queued",
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

  async steerTurn(input: StartTurnInput): Promise<QueuedTurn | TurnReceipt> {
    const state = this.runtimeStates.get(input.sessionId);
    if (state?.active && state.host) await state.host.interrupt();
    return this.startTurn({ ...input, priority: 100 });
  }

  async interruptTurn(sessionId: string, commandId?: string): Promise<boolean> {
    const state = this.runtimeStates.get(sessionId);
    if (state?.active && (!commandId || state.active.commandId === commandId) && state.host) {
      await state.host.interrupt();
      return true;
    }
    const index = this.pending.findIndex((turn) => (
      turn.sessionId === sessionId &&
      turn.state === "queued" &&
      (!commandId || turn.commandId === commandId)
    ));
    if (index < 0) return false;
    const [cancelled] = this.pending.splice(index, 1);
    this.rememberTerminal(cancelled!, "cancelled");
    await this.saveQueue();
    await this.record({
      sessionId,
      itemId: cancelled!.commandId,
      origin: "system",
      type: "turn.interrupted",
      data: {
        commandId: cancelled!.commandId,
        requestId: cancelled!.requestId,
        idempotencyKey: cancelled!.idempotencyKey,
        delivery: "cancelled",
      },
    });
    this.emit("changed");
    return true;
  }

  resolvePermission(
    requestId: string,
    decision: PermissionDecision,
    message?: string,
    updatedInput?: Record<string, unknown>,
  ): boolean {
    return this.permissionBroker.resolveRequest(requestId, decision, message, updatedInput);
  }

  async history(sessionId: string, cursor?: string, limit = 50): Promise<BridgeHistoryPage> {
    const session = this.session(sessionId);
    if (!session) throw new Error("Session not found");
    const before = decodeCursor(cursor);
    const pageSize = Math.max(1, Math.min(limit, 100));
    const transcript = await readClaudeSessionHistory(
      this.options.paths.projects,
      sessionId,
      session.cwd,
      {
        limit: Math.min(10_000, pageSize * 3),
        ...(before ? { before: { createdAt: before.at, id: before.id } } : {}),
      },
    );
    const transcriptItems: BridgeHistoryItem[] = transcript.messages.map((message) => ({
      id: message.id,
      sessionId,
      role: message.role,
      text: message.text,
      createdAt: message.createdAt,
      origin: "claude-desktop",
    }));
    const eventItems = this.options.eventLog.history(sessionId, undefined, 10_000).items
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
    const hasMore = transcript.truncated || all.length > items.length;
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
    for (const state of this.runtimeStates.values()) {
      if (state.releaseTimer) clearTimeout(state.releaseTimer);
      await state.host?.close();
    }
    await this.eventQueue.catch(() => undefined);
    await this.pumpQueue.catch(() => undefined);
    await this.saveQueue();
  }

  private async acquire(turn: QueuedTurn): Promise<void> {
    const session = this.session(turn.sessionId);
    if (!session || !this.runtime?.executablePath || !this.runtime.credentialPath) return;
    const state = this.runtimeStates.get(turn.sessionId) ?? {
      ownership: "DESKTOP_OBSERVED" as const,
      turnState: "idle" as const,
    };
    this.runtimeStates.set(turn.sessionId, state);
    if (state.releaseTimer) {
      clearTimeout(state.releaseTimer);
      delete state.releaseTimer;
    }
    if (!state.host) {
      state.ownership = "ACQUIRING";
      await this.recordOwnership(turn.sessionId, state.ownership);
      const transcript = await findClaudeTranscriptFile(this.options.paths.projects, turn.sessionId, session.cwd);
      const host = this.hostFactory({
        sessionId: turn.sessionId,
        cwd: session.cwd,
        executablePath: this.runtime.executablePath,
        environment: this.runtime.environment,
        permissionBroker: this.permissionBroker,
        resume: Boolean(transcript),
      });
      host.onEvent((event) => {
        this.eventQueue = this.eventQueue
          .catch(() => undefined)
          .then(() => this.handleHostEvent(event));
      });
      state.host = host;
      host.start();
      state.ownership = "BRIDGE_IDLE";
      await this.recordOwnership(turn.sessionId, state.ownership);
    }
    turn.state = "running";
    let accepted: ReturnType<SessionHostRuntime["send"]>;
    try {
      accepted = state.host.send({
        text: turn.text,
        attachments: turn.attachments,
      }, turn.origin);
    } catch (error) {
      await state.host.close().catch(() => undefined);
      delete state.host;
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
      if (turn.attempts < 5) setTimeout(() => void this.pump(), 3_000);
      else await this.failQueuedTurn(turn, error instanceof Error ? error.message : String(error));
      return;
    }
    turn.attempts += 1;
    turn.turnId = accepted.turnId;
    state.active = turn;
    state.ownership = "BRIDGE_RUNNING";
    state.turnState = "running";
    this.activeTurns += 1;
    await this.saveQueue();
    this.emit("changed");
  }

  private async handleHostEvent(event: SessionHostEvent): Promise<void> {
    const state = this.runtimeStates.get(event.sessionId);
    const active = state?.active ?? this.pending.find((turn) => (
      turn.sessionId === event.sessionId && turn.state === "running"
    ));
    if (event.type === "assistant.delta") {
      this.options.eventLog.appendCoalescedDelta({
        sessionId: event.sessionId,
        ...(event.turnId ? { turnId: event.turnId } : {}),
        itemId: event.itemId,
        timestamp: event.at,
        origin: "claude-host",
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
        origin: "claude-host",
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
      return;
    }
    if (event.type === "assistant.completed") {
      await this.options.eventLog.flushDeltas(event.sessionId);
      await this.record({
        sessionId: event.sessionId,
        ...(event.turnId ? { turnId: event.turnId } : {}),
        itemId: event.itemId,
        timestamp: event.at,
        origin: "claude-host",
        type: "assistant.completed",
        data: { text: event.text },
      });
      return;
    }
    if (event.type === "tool.started") {
      this.toolNames.set(event.itemId, event.toolName);
      await this.record({
        sessionId: event.sessionId,
        ...(event.turnId ? { turnId: event.turnId } : {}),
        itemId: event.itemId,
        timestamp: event.at,
        origin: "claude-host",
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
        origin: "claude-host",
        type: "tool.progress",
        data: { text: event.text, toolName: this.toolNames.get(event.itemId) ?? "" },
      });
      return;
    }
    if (event.type === "tool.completed") {
      const toolName = this.toolNames.get(event.itemId) ?? "";
      await this.record({
        sessionId: event.sessionId,
        ...(event.turnId ? { turnId: event.turnId } : {}),
        itemId: event.itemId,
        timestamp: event.at,
        origin: "claude-host",
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
        origin: "claude-host",
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
      await this.finishTurn(event.sessionId, "completed");
      return;
    }
    if (event.type === "turn.failed" || event.type === "runtime.error") {
      await this.options.eventLog.flushDeltas(event.sessionId);
      const shouldRetry = event.type === "runtime.error"
        && Boolean(state?.active)
        && !state?.active?.sessionAcceptedAt
        && this.transientRuntimeError(event.error)
        && (state?.active?.attempts ?? 0) < 5;
      await this.record({
        sessionId: event.sessionId,
        ...("turnId" in event && event.turnId ? { turnId: event.turnId } : {}),
        timestamp: event.at,
        origin: "claude-host",
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
        await this.requeueActive(event.sessionId);
      } else if (state?.active) {
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
      await this.finishTurn(event.sessionId, "interrupted");
    }
  }

  private async finishTurn(sessionId: string, terminal: "completed" | "failed" | "interrupted"): Promise<void> {
    const state = this.runtimeStates.get(sessionId);
    const turn = state?.active;
    if (!state || !turn) return;
    state.turnState = terminal;
    state.ownership = "BRIDGE_IDLE";
    delete state.active;
    this.activeTurns = Math.max(0, this.activeTurns - 1);
    const index = this.pending.findIndex((candidate) => candidate.commandId === turn.commandId);
    if (index >= 0) this.pending.splice(index, 1);
    this.rememberTerminal(turn, terminal === "interrupted" ? "cancelled" : terminal);
    await this.saveQueue();
    state.turnState = "idle";
    state.releaseTimer = setTimeout(() => {
      void this.releaseSession(sessionId);
    }, 10 * 60_000);
    this.emit("changed");
    await this.pump();
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
    if (this.closed || !this.initialized || !this.runtime?.executablePath || !this.runtime.credentialPath) return;
    this.sortPending();
    for (const turn of this.pending) {
      if (this.activeTurns >= this.maxParallelTurns) break;
      if (turn.state !== "queued") continue;
      const state = this.runtimeStates.get(turn.sessionId);
      if (state?.active) continue;
      if (!state?.host && this.options.observer.isDesktopBusy(turn.sessionId)) continue;
      await this.acquire(turn);
    }
  }

  private refreshObservedOwnership(): void {
    for (const observed of this.catalog.sessions) {
      const state = this.runtimeStates.get(observed.sessionId);
      if (!state) continue;
      if (!state.host && !state.active) {
        state.ownership = "DESKTOP_OBSERVED";
        state.turnState = this.options.observer.isDesktopBusy(observed.sessionId) ? "running" : "idle";
      }
    }
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
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      await rename(this.options.sessionsPath, `${this.options.sessionsPath}.archive-${Date.now()}`).catch(() => undefined);
    }
  }

  private async saveSessions(): Promise<void> {
    const contents = `${JSON.stringify({
      version: 2,
      sessions: [...this.bridgeSessions.values()],
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
        this.pending.push({ ...turn, state: "queued", priority: turn.priority ?? 0, attempts: turn.attempts ?? 0 });
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

  private async saveQueue(): Promise<void> {
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
}
