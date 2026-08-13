import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type {
  BridgeAttachment,
  BridgeDesktopRuntime,
  BridgeDesktopRuntimeId,
  BridgeEventType,
  BridgeHistoryItem,
  BridgeHistoryPage,
  BridgePermissionDecision,
  BridgePermissionInfo,
  BridgePermissionMode,
  BridgePermissionPolicy,
  BridgeProjectInfo,
  BridgeSessionAllowedActions,
  BridgeSessionConfiguration,
  BridgeSessionInfo,
  BridgeTurnState,
} from "@bridge/protocol";
import type { SessionEventLog } from "./session-event-log.js";
import type { ConversationStateStore } from "./conversation-state-store.js";
import {
  type DesktopRuntimeAdapter,
  type RuntimeAdapterEvent,
  type RuntimeAdapterConfiguration,
  type RuntimeAdapterConfigurationChange,
  type RuntimeAdapterHistoryItem,
  type RuntimeAdapterPermission,
  type RuntimeAdapterSession,
  RuntimeAdapterRegistry,
} from "./runtime-adapter.js";

interface StoredPermission {
  adapter: DesktopRuntimeAdapter;
  nativeRequestId: string;
  nativeSessionId: string;
  info: BridgePermissionInfo;
}

function compact(value: string, max = 160): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}...`;
}

export function runtimeSessionId(runtimeId: BridgeDesktopRuntimeId, nativeSessionId: string): string {
  return `${runtimeId}:${encodeURIComponent(nativeSessionId)}`;
}

export function parseRuntimeSessionId(sessionId: string): { runtimeId: BridgeDesktopRuntimeId; nativeSessionId: string } | undefined {
  const separator = sessionId.indexOf(":");
  if (separator < 1) return undefined;
  const runtimeId = sessionId.slice(0, separator);
  if (runtimeId !== "codex-desktop" && runtimeId !== "hermes-desktop") return undefined;
  try {
    const nativeSessionId = decodeURIComponent(sessionId.slice(separator + 1));
    return nativeSessionId ? { runtimeId, nativeSessionId } : undefined;
  } catch {
    return undefined;
  }
}

function originFor(runtimeId: BridgeDesktopRuntimeId): "codex-host" | "hermes-host" {
  return runtimeId === "codex-desktop" ? "codex-host" : "hermes-host";
}

function ownershipFor(state: BridgeTurnState): BridgeSessionInfo["ownership"] {
  return state === "running" || state === "waiting" || state === "queued"
    ? "BRIDGE_RUNNING"
    : "BRIDGE_IDLE";
}

function allowedActions(adapter: DesktopRuntimeAdapter): BridgeSessionAllowedActions {
  const capabilities = adapter.status().capabilities;
  return {
    canSend: capabilities.includes("turn.start"),
    canSteer: capabilities.includes("turn.steer"),
    canInterrupt: capabilities.includes("turn.interrupt"),
    canSwitchProvider: false,
    canContinueOfficial: false,
    canConfigure: capabilities.includes("session.configure"),
  };
}

function safeTimestamp(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : Date.now();
}

function historySignature(item: RuntimeAdapterHistoryItem): string {
  return JSON.stringify({
    role: item.role,
    text: item.text,
    toolName: item.toolName,
    state: item.state,
    fileChanges: item.fileChanges,
    attachments: item.attachments,
  });
}

function sessionFingerprint(session: BridgeSessionInfo): string {
  return JSON.stringify({
    title: session.title,
    lastActivityAt: session.lastActivityAt,
    turnState: session.turnState,
    activeTurnId: session.activeTurnId,
    model: session.model,
    provider: session.provider,
    reasoningEffort: session.reasoningEffort,
    fast: session.fast,
  });
}

export interface RuntimeSessionBrokerOptions {
  liveSyncIntervalMs?: number;
}

export class RuntimeSessionBroker extends EventEmitter {
  private readonly sessionsByRuntime = new Map<BridgeDesktopRuntimeId, Map<string, RuntimeAdapterSession>>();
  private readonly imageDirs = new Map<string, string>();
  private readonly permissions = new Map<string, StoredPermission>();
  private readonly hostPermissionModes = new Map<BridgeDesktopRuntimeId, BridgePermissionMode>();
  private readonly sessionPermissionModes = new Map<string, BridgePermissionMode>();
  private readonly observedHistory = new Map<string, Map<string, string>>();
  private readonly historySyncPending = new Set<string>();
  private readonly publishedSessionFingerprints = new Map<string, string>();
  private readonly liveSyncIntervalMs: number;
  private liveSyncTimer: ReturnType<typeof setTimeout> | undefined;
  private eventQueue: Promise<void> = Promise.resolve();
  private initialized = false;

  constructor(
    readonly registry: RuntimeAdapterRegistry,
    private readonly eventLog: SessionEventLog,
    private readonly state?: ConversationStateStore,
    options: RuntimeSessionBrokerOptions = {},
  ) {
    super();
    this.liveSyncIntervalMs = Math.max(500, options.liveSyncIntervalMs ?? 1_200);
    registry.on("changed", () => {
      const before = this.sessionFingerprints();
      this.syncCachedSessions();
      this.queueChangedHistories(before);
      this.eventQueue = this.eventQueue
        .catch(() => undefined)
        .then(async () => {
          await this.publishChangedRuntimeSessions(before);
        });
      this.emit("changed");
    });
    registry.on("adapter-error", (runtimeId: BridgeDesktopRuntimeId, error: Error) => {
      this.eventQueue = this.eventQueue.catch(() => undefined).then(async () => {
        await this.eventLog.append({
          origin: "system",
          type: "runtime.error",
          data: { runtimeId, message: error.message },
        });
      });
      this.emit("changed");
    });
    registry.on("event", (runtimeId: BridgeDesktopRuntimeId, event: RuntimeAdapterEvent) => {
      this.eventQueue = this.eventQueue.catch(() => undefined).then(() => this.handleAdapterEvent(runtimeId, event));
    });
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    if (this.state) {
      for (const row of this.state.listRuntimeSessionPermissions()) {
        if (parseRuntimeSessionId(row.sessionId)) this.sessionPermissionModes.set(row.sessionId, row.permissionMode);
      }
    }
    await this.registry.initialize();
    this.syncCachedSessions();
    this.seedPublishedSessionFingerprints();
    this.emit("changed");
    this.scheduleLiveSync();
  }

  async refresh(runtimeId?: BridgeDesktopRuntimeId): Promise<BridgeDesktopRuntime[]> {
    const before = this.sessionFingerprints();
    const runtimes = await this.registry.refresh(runtimeId);
    this.syncCachedSessions();
    this.queueChangedHistories(before);
    await this.publishChangedRuntimeSessions(before);
    this.emit("changed");
    return runtimes;
  }

  /**
   * Lightweight native-session re-discovery: only polls adapters that are
   * already ready (never respawns errored runtimes), so it is cheap enough to
   * run on mobile-originated sync requests. This is how sessions created
   * directly inside Codex/Hermes Desktop reach the phone without waiting for
   * a window activation or reconnect.
   */
  async refreshDiscoveredSessions(): Promise<void> {
    const before = this.sessionFingerprints();
    for (const runtime of this.registry.runtimes()) {
      if (runtime.state !== "ready") continue;
      const adapter = this.registry.adapter(runtime.id);
      if (!adapter) continue;
      try {
        await adapter.refresh();
      } catch {
        // Keep the last known session set; the next sync retries.
      }
    }
    this.syncCachedSessions();
    const historiesChanged = this.queueChangedHistories(before);
    const runtimeChanged = await this.publishChangedRuntimeSessions(before);
    if (historiesChanged || runtimeChanged) this.emit("changed");
  }

  /**
   * Reconcile native histories into the shared event log. Native desktop apps
   * do not all emit the same live notifications, so this is the common
   * fallback that keeps Bridge desktop and phones current without a manual
   * refresh or changing the selected session.
   */
  async syncLiveHistories(): Promise<void> {
    const active = this.listSessions()
      .filter((session) => (
        session.turnState === "running" || session.turnState === "waiting" || session.turnState === "queued"
      ))
      .map((session) => session.sessionId);
    const candidates = [...new Set([...this.historySyncPending, ...active])].slice(0, 18);
    for (const sessionId of candidates) {
      const synced = await this.syncSessionHistory(sessionId).then(() => true, () => false);
      if (synced) this.historySyncPending.delete(sessionId);
    }
  }

  runtimes(): BridgeDesktopRuntime[] {
    return this.registry.runtimes();
  }

  listSessions(runtimeId?: BridgeDesktopRuntimeId): BridgeSessionInfo[] {
    const rows: BridgeSessionInfo[] = [];
    for (const [id, sessions] of this.sessionsByRuntime) {
      if (runtimeId && runtimeId !== id) continue;
      const adapter = this.registry.adapter(id);
      if (!adapter) continue;
      for (const session of sessions.values()) rows.push(this.toBridgeSession(adapter, session));
    }
    return rows.sort((left, right) => right.lastActivityAt - left.lastActivityAt || left.sessionId.localeCompare(right.sessionId));
  }

  listProjects(): BridgeProjectInfo[] {
    const grouped = new Map<string, BridgeProjectInfo>();
    for (const session of this.listSessions()) {
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
          ...(session.runtimeId ? { runtimeId: session.runtimeId } : {}),
        });
      }
    }
    return [...grouped.values()].sort((left, right) => right.lastActivityAt - left.lastActivityAt);
  }

  session(sessionId: string): BridgeSessionInfo | undefined {
    const parsed = parseRuntimeSessionId(sessionId);
    if (!parsed) return undefined;
    const adapter = this.registry.adapter(parsed.runtimeId);
    const native = this.sessionsByRuntime.get(parsed.runtimeId)?.get(parsed.nativeSessionId);
    return adapter && native ? this.toBridgeSession(adapter, native) : undefined;
  }

  async createSession(runtimeId: BridgeDesktopRuntimeId, cwd: string, title?: string): Promise<BridgeSessionInfo> {
    const adapter = this.requireAdapter(runtimeId, "session.create");
    const native = await adapter.createSession({ cwd, ...(title ? { title } : {}) });
    this.upsert(runtimeId, native);
    await this.eventLog.append({
      sessionId: runtimeSessionId(runtimeId, native.nativeSessionId),
      origin: originFor(runtimeId),
      type: "session.created",
      data: { runtimeId, nativeSessionId: native.nativeSessionId, title: native.title, cwd: native.cwd },
    });
    this.emit("changed");
    return this.toBridgeSession(adapter, native);
  }

  async history(sessionId: string): Promise<BridgeHistoryPage> {
    const { adapter, nativeSessionId } = this.requireSession(sessionId);
    const history = await adapter.history(nativeSessionId);
    const items: BridgeHistoryItem[] = history.map((item) => ({
      ...item,
      sessionId,
      origin: originFor(adapter.id),
    }));
    return { sessionId, items, hasMore: false };
  }

  async configuration(sessionId: string): Promise<BridgeSessionConfiguration> {
    const { adapter, nativeSessionId } = this.requireSession(sessionId);
    if (!adapter.status().capabilities.includes("session.configure")) {
      throw new Error(`${adapter.status().name} 暂不支持模型配置`);
    }
    return this.toBridgeConfiguration(sessionId, await adapter.configuration(nativeSessionId));
  }

  async configureSession(
    sessionId: string,
    change: RuntimeAdapterConfigurationChange,
  ): Promise<BridgeSessionConfiguration> {
    const { adapter, nativeSessionId } = this.requireSession(sessionId);
    if (!adapter.status().capabilities.includes("session.configure")) {
      throw new Error(`${adapter.status().name} 暂不支持模型配置`);
    }
    const configuration = await adapter.configureSession(nativeSessionId, change);
    const nextSession = adapter.sessions().find((session) => session.nativeSessionId === nativeSessionId);
    if (nextSession) this.upsert(adapter.id, nextSession);
    await this.eventLog.append({
      sessionId,
      origin: originFor(adapter.id),
      type: "session.configuration",
      data: {
        runtimeId: adapter.id,
        ...(configuration.provider ? { provider: configuration.provider } : {}),
        ...(configuration.model ? { model: configuration.model } : {}),
        ...(configuration.reasoningEffort ? { reasoningEffort: configuration.reasoningEffort } : {}),
        ...(configuration.fast !== undefined ? { fast: configuration.fast } : {}),
        appliesAfterTurn: configuration.appliesAfterTurn,
      },
    });
    this.emit("changed");
    return this.toBridgeConfiguration(sessionId, configuration);
  }

  /**
   * Host-level defaults are per runtime: flipping Codex into full-access must
   * never silently auto-approve Hermes or Claude sessions on the same machine.
   */
  setHostPermissionModes(modes: Partial<Record<BridgeDesktopRuntimeId, BridgePermissionMode>>): void {
    this.hostPermissionModes.clear();
    for (const [runtimeId, mode] of Object.entries(modes)) {
      if (runtimeId !== "codex-desktop" && runtimeId !== "hermes-desktop") continue;
      if (mode !== "standard" && mode !== "full-access") continue;
      this.hostPermissionModes.set(runtimeId, mode);
    }
  }

  async setHostPermissionMode(runtimeId: BridgeDesktopRuntimeId, mode: BridgePermissionMode): Promise<number> {
    if (mode !== "standard" && mode !== "full-access") throw new Error("Invalid permission mode");
    this.hostPermissionModes.set(runtimeId, mode);
    const resolved = await this.applyPolicy({ runtimeId });
    this.emit("changed");
    return resolved;
  }

  permissionPolicy(sessionId: string): BridgePermissionPolicy | undefined {
    const parsed = parseRuntimeSessionId(sessionId);
    if (!parsed) return undefined;
    const hostMode = this.hostPermissionModes.get(parsed.runtimeId) ?? "standard";
    const sessionMode = this.sessionPermissionModes.get(sessionId);
    return {
      hostMode,
      ...(sessionMode ? { sessionMode } : {}),
      effectiveMode: sessionMode ?? hostMode,
      source: sessionMode ? "session" : "host",
    };
  }

  async configurePermissionPolicy(
    sessionId: string,
    mode: BridgePermissionMode | null,
  ): Promise<{ configuration: BridgeSessionConfiguration; resolvedPending: number }> {
    this.requireSession(sessionId);
    if (mode !== null && mode !== "standard" && mode !== "full-access") {
      throw new Error("Invalid permission mode");
    }
    if (mode) this.sessionPermissionModes.set(sessionId, mode);
    else this.sessionPermissionModes.delete(sessionId);
    this.state?.saveRuntimeSessionPermission(sessionId, mode);
    const resolvedPending = await this.applyPolicy({ sessionId });
    this.emit("changed");
    return { configuration: await this.configuration(sessionId), resolvedPending };
  }

  /**
   * Auto-approve every pending non-question approval covered by a full-access
   * policy; mirrors the Claude permission broker's policy sweep. Questions
   * (AskUserQuestion / clarify) always wait for a human answer.
   */
  async applyPolicy(filter: { sessionId?: string; runtimeId?: BridgeDesktopRuntimeId } = {}): Promise<number> {
    let resolved = 0;
    for (const [requestId, pending] of [...this.permissions]) {
      if (filter.sessionId && pending.info.sessionId !== filter.sessionId) continue;
      if (filter.runtimeId && pending.adapter.id !== filter.runtimeId) continue;
      if (pending.info.toolName === "AskUserQuestion") continue;
      if (this.permissionPolicy(pending.info.sessionId)?.effectiveMode !== "full-access") continue;
      if (await this.autoResolve(requestId, pending)) resolved += 1;
    }
    if (resolved > 0) this.emit("changed");
    return resolved;
  }

  /**
   * Drop Bridge-side records for a deleted runtime session. The native app
   * still owns the real session; the controller's tombstone keeps the
   * re-discovered native copy hidden from Bridge.
   */
  removeSessionRecords(sessionId: string): void {
    void this.cleanupImages(sessionId);
    if (this.sessionPermissionModes.delete(sessionId)) {
      this.state?.saveRuntimeSessionPermission(sessionId, null);
    }
    for (const [requestId, pending] of [...this.permissions]) {
      if (pending.info.sessionId === sessionId) this.permissions.delete(requestId);
    }
    this.emit("changed");
  }

  async startTurn(input: {
    sessionId: string;
    text: string;
    commandId: string;
    requestId: string;
    attachments?: BridgeAttachment[];
    sourceDeviceId?: string;
    steer?: boolean;
  }): Promise<{ commandId: string; state: "queued" | "running" }> {
    const { adapter, nativeSessionId } = this.requireSession(input.sessionId);
    const capabilities = adapter.status().capabilities;
    const operation = input.steer ? "turn.steer" : "turn.start";
    if (!capabilities.includes(operation)) throw new Error(`${adapter.status().name} 暂不支持该操作`);
    const images = await this.materializeImages(input.sessionId, adapter, input.attachments ?? []);
    const payload = {
      nativeSessionId,
      text: input.text,
      commandId: input.commandId,
      requestId: input.requestId,
      ...(images.length ? { images } : {}),
      ...(input.sourceDeviceId ? { sourceDeviceId: input.sourceDeviceId } : {}),
    };
    const result = input.steer ? await adapter.steerTurn(payload) : await adapter.startTurn(payload);
    const session = this.sessionsByRuntime.get(adapter.id)?.get(nativeSessionId);
    if (session) {
      session.turnState = result.state === "queued" ? "queued" : "running";
      session.lastActivityAt = Date.now();
      if (result.turnId) session.activeTurnId = result.turnId;
      this.upsert(adapter.id, session);
    }
    await this.eventLog.append({
      sessionId: input.sessionId,
      ...(result.turnId ? { turnId: result.turnId } : {}),
      itemId: input.commandId,
      origin: originFor(adapter.id),
      type: "user.message.accepted",
      data: {
        text: input.text,
        commandId: input.commandId,
        requestId: input.requestId,
        runtimeId: adapter.id,
        ...(input.attachments?.length ? { attachments: input.attachments } : {}),
      },
    });
    await this.eventLog.append({
      sessionId: input.sessionId,
      ...(result.turnId ? { turnId: result.turnId } : {}),
      itemId: input.commandId,
      origin: originFor(adapter.id),
      type: "turn.started",
      data: { commandId: input.commandId, runtimeId: adapter.id },
    });
    this.emit("changed");
    return { commandId: input.commandId, state: result.state };
  }

  async interruptTurn(sessionId: string): Promise<boolean> {
    const { adapter, nativeSessionId } = this.requireSession(sessionId);
    if (!adapter.status().capabilities.includes("turn.interrupt")) return false;
    const interrupted = await adapter.interruptTurn(nativeSessionId);
    if (interrupted) {
      const session = this.sessionsByRuntime.get(adapter.id)?.get(nativeSessionId);
      if (session) {
        session.turnState = "interrupted";
        session.lastActivityAt = Date.now();
        delete session.activeTurnId;
        this.upsert(adapter.id, session);
      }
      await this.eventLog.append({
        sessionId,
        origin: originFor(adapter.id),
        type: "turn.interrupted",
        data: { runtimeId: adapter.id },
      });
      this.emit("changed");
    }
    return interrupted;
  }

  listPermissions(): BridgePermissionInfo[] {
    return [...this.permissions.values()]
      .map((permission) => permission.info)
      .sort((left, right) => left.createdAt - right.createdAt);
  }

  async resolvePermission(
    requestId: string,
    decision: BridgePermissionDecision,
    updatedInput?: Record<string, unknown>,
  ): Promise<boolean> {
    const pending = this.permissions.get(requestId);
    if (!pending) return false;
    const resolved = await pending.adapter.resolvePermission(
      pending.nativeRequestId,
      decision,
      updatedInput,
    );
    if (!resolved) return false;
    this.permissions.delete(requestId);
    const session = this.sessionsByRuntime.get(pending.adapter.id)?.get(pending.nativeSessionId);
    if (session && session.turnState === "waiting") {
      session.turnState = "running";
      this.upsert(pending.adapter.id, session);
    }
    await this.eventLog.append({
      sessionId: pending.info.sessionId,
      itemId: requestId,
      origin: originFor(pending.adapter.id),
      type: pending.info.toolName === "AskUserQuestion" ? "question.resolved" : "permission.resolved",
      data: { requestId, decision, runtimeId: pending.adapter.id, resolvedAt: Date.now() },
    });
    this.emit("changed");
    return true;
  }

  async close(): Promise<void> {
    if (this.liveSyncTimer) clearTimeout(this.liveSyncTimer);
    this.liveSyncTimer = undefined;
    this.initialized = false;
    await Promise.allSettled([...this.imageDirs.keys()].map((sessionId) => this.cleanupImages(sessionId)));
    await this.registry.close();
  }

  private scheduleLiveSync(): void {
    if (!this.initialized || this.liveSyncTimer) return;
    this.liveSyncTimer = setTimeout(() => {
      this.liveSyncTimer = undefined;
      this.eventQueue = this.eventQueue
        .catch(() => undefined)
        .then(async () => {
          await this.refreshDiscoveredSessions();
          await this.syncLiveHistories();
        })
        .finally(() => this.scheduleLiveSync());
    }, this.liveSyncIntervalMs);
    this.liveSyncTimer.unref?.();
  }

  private async syncSessionHistory(sessionId: string): Promise<void> {
    const { adapter, nativeSessionId } = this.requireSession(sessionId);
    const history = await adapter.history(nativeSessionId);
    const known = this.observedHistory.get(sessionId) ?? new Map<string, string>();
    for (const item of history) {
      const signature = historySignature(item);
      const previous = known.get(item.id);
      if (previous === signature) continue;
      if (item.role === "user" || item.role === "assistant") {
        if (item.role === "assistant" && this.hasLiveAssistantStream(sessionId, item.turnId)) {
          continue;
        }
        if (this.hasRecordedMessage(sessionId, item)) {
          known.set(item.id, signature);
          continue;
        }
        await this.eventLog.append({
          sessionId,
          ...(item.turnId ? { turnId: item.turnId } : {}),
          itemId: item.id,
          timestamp: safeTimestamp(item.createdAt),
          origin: originFor(adapter.id),
          type: "session.observed",
          data: {
            role: item.role,
            text: item.text,
            runtimeId: adapter.id,
            ...(item.attachments?.length ? { attachments: item.attachments } : {}),
          },
        });
        known.set(item.id, signature);
        continue;
      }
      if (item.role !== "tool") {
        known.set(item.id, signature);
        continue;
      }
      const type: BridgeEventType = item.state === "running" ? "tool.started" : "tool.completed";
      const existing = this.eventLog.latestItem(sessionId, type, item.id);
      if (
        existing &&
        existing.data.summary === item.text &&
        existing.data.toolName === (item.toolName ?? "Tool")
      ) {
        known.set(item.id, signature);
        continue;
      }
      await this.eventLog.append({
        sessionId,
        ...(item.turnId ? { turnId: item.turnId } : {}),
        itemId: item.id,
        timestamp: safeTimestamp(item.createdAt),
        origin: originFor(adapter.id),
        type,
        data: {
          toolName: item.toolName ?? "Tool",
          summary: item.text,
          runtimeId: adapter.id,
          ...(item.fileChanges?.length ? { fileChanges: item.fileChanges } : {}),
        },
      });
      known.set(item.id, signature);
    }
    this.observedHistory.set(sessionId, known);
  }

  private sessionFingerprints(): Map<string, string> {
    return new Map(this.listSessions().map((session) => [session.sessionId, sessionFingerprint(session)]));
  }

  private seedPublishedSessionFingerprints(): void {
    this.publishedSessionFingerprints.clear();
    for (const session of this.listSessions()) {
      this.publishedSessionFingerprints.set(session.sessionId, sessionFingerprint(session));
    }
  }

  private async publishChangedRuntimeSessions(before: Map<string, string>): Promise<boolean> {
    let changed = false;
    const current = this.listSessions();
    const currentIds = new Set(current.map((session) => session.sessionId));
    for (const session of current) {
      if (before.get(session.sessionId) === sessionFingerprint(session)) continue;
      if (await this.publishRuntimeSession(session)) changed = true;
    }
    for (const sessionId of this.publishedSessionFingerprints.keys()) {
      if (!currentIds.has(sessionId)) this.publishedSessionFingerprints.delete(sessionId);
    }
    return changed;
  }

  private async publishRuntimeSession(session: BridgeSessionInfo): Promise<boolean> {
    if (!session.runtimeId) return false;
    const fingerprint = sessionFingerprint(session);
    if (this.publishedSessionFingerprints.get(session.sessionId) === fingerprint) return false;
    this.publishedSessionFingerprints.set(session.sessionId, fingerprint);
    await this.eventLog.append({
      sessionId: session.sessionId,
      timestamp: safeTimestamp(session.lastActivityAt),
      origin: originFor(session.runtimeId),
      type: "runtime.updated",
      data: { runtimeId: session.runtimeId, session },
    });
    return true;
  }

  private hasRecordedMessage(sessionId: string, item: RuntimeAdapterHistoryItem): boolean {
    const observed = this.eventLog.latestItem(sessionId, "session.observed", item.id);
    if (observed?.data.text === item.text) return true;
    const type = item.role === "user" ? "user.message.accepted" : "assistant.completed";
    const recorded = this.eventLog.latestItem(sessionId, type, item.id);
    if (recorded?.data.text === item.text) return true;
    return this.eventLog.replay(Math.max(0, this.eventLog.latestSeq() - 1_000), 1_000, sessionId)
      .some((event) => (
        (event.type === "session.observed" || event.type === type) &&
        (event.itemId === item.id || (
          Boolean(item.turnId) && event.turnId === item.turnId && event.data.text === item.text
        )) &&
        event.data.text === item.text
      ));
  }

  private hasLiveAssistantStream(sessionId: string, turnId: string | undefined): boolean {
    if (!turnId) return false;
    const session = this.session(sessionId);
    if (!session || !["running", "waiting", "queued"].includes(session.turnState)) return false;
    const events = this.eventLog.replay(Math.max(0, this.eventLog.latestSeq() - 1_000), 1_000, sessionId);
    return events.some((event) => event.type === "assistant.delta" && event.turnId === turnId)
      && !events.some((event) => event.type === "assistant.completed" && event.turnId === turnId);
  }

  private queueChangedHistories(before: Map<string, string>): boolean {
    let changed = false;
    for (const session of this.listSessions()) {
      if (before.get(session.sessionId) === sessionFingerprint(session)) continue;
      this.historySyncPending.add(session.sessionId);
      changed = true;
    }
    return changed;
  }

  private requireAdapter(runtimeId: BridgeDesktopRuntimeId, capability: string): DesktopRuntimeAdapter {
    const adapter = this.registry.adapter(runtimeId);
    if (!adapter) throw new Error("未知 Desktop 运行时");
    const status = adapter.status();
    if (status.state !== "ready") throw new Error(`${status.name} 当前不可用：${status.detail}`);
    if (!status.capabilities.includes(capability as never)) throw new Error(`${status.name} 不支持 ${capability}`);
    return adapter;
  }

  private requireSession(sessionId: string): { adapter: DesktopRuntimeAdapter; nativeSessionId: string } {
    const parsed = parseRuntimeSessionId(sessionId);
    if (!parsed) throw new Error("Session does not belong to an external Desktop runtime");
    const adapter = this.requireAdapter(parsed.runtimeId, "session.history");
    if (!this.sessionsByRuntime.get(parsed.runtimeId)?.has(parsed.nativeSessionId)) throw new Error("Session not found");
    return { adapter, nativeSessionId: parsed.nativeSessionId };
  }

  private syncCachedSessions(): void {
    for (const runtime of this.registry.runtimes()) {
      const adapter = this.registry.adapter(runtime.id);
      if (!adapter) continue;
      const sessions = new Map(adapter.sessions().map((session) => [session.nativeSessionId, session]));
      this.sessionsByRuntime.set(runtime.id, sessions);
    }
  }

  private upsert(runtimeId: BridgeDesktopRuntimeId, session: RuntimeAdapterSession): void {
    const sessions = this.sessionsByRuntime.get(runtimeId) ?? new Map<string, RuntimeAdapterSession>();
    sessions.set(session.nativeSessionId, { ...session });
    this.sessionsByRuntime.set(runtimeId, sessions);
  }

  private toBridgeSession(adapter: DesktopRuntimeAdapter, session: RuntimeAdapterSession): BridgeSessionInfo {
    const sessionId = runtimeSessionId(adapter.id, session.nativeSessionId);
    const projectId = `${adapter.id}:${session.cwd}`;
    return {
      sessionId,
      runtimeId: adapter.id,
      nativeSessionId: session.nativeSessionId,
      projectId,
      projectName: basename(session.cwd) || adapter.status().name,
      cwd: session.cwd,
      title: session.title || "未命名任务",
      source: session.source,
      transport: session.transport,
      ownership: ownershipFor(session.turnState),
      turnState: session.turnState,
      lastActivityAt: safeTimestamp(session.lastActivityAt),
      pendingCount: 0,
      ...(session.activeTurnId ? { activeTurnId: session.activeTurnId } : {}),
      ...(session.provider ? { provider: session.provider } : {}),
      ...(session.model ? { model: session.model } : {}),
      ...(session.effort ? { effort: session.effort } : {}),
      ...(session.reasoningEffort ? { reasoningEffort: session.reasoningEffort } : {}),
      ...(session.fast !== undefined ? { fast: session.fast } : {}),
      allowedActions: allowedActions(adapter),
    };
  }

  private toBridgeConfiguration(
    sessionId: string,
    configuration: RuntimeAdapterConfiguration,
  ): BridgeSessionConfiguration {
    const permissionPolicy = this.permissionPolicy(sessionId);
    return {
      sessionId,
      ...(configuration.provider ? { provider: configuration.provider } : {}),
      ...(configuration.model ? { model: configuration.model } : {}),
      ...(configuration.reasoningEffort ? { reasoningEffort: configuration.reasoningEffort } : {}),
      ...(configuration.fast !== undefined ? { fast: configuration.fast } : {}),
      modelSource: "default",
      effortSource: "default",
      providerSource: "default",
      availableModels: configuration.availableModels,
      availableEffortLevels: configuration.availableReasoningEfforts,
      availableReasoningEfforts: configuration.availableReasoningEfforts,
      availableProviders: configuration.availableProviders,
      supportsFastMode: configuration.supportsFastMode,
      modelsComplete: configuration.modelsComplete,
      appliesAfterTurn: configuration.appliesAfterTurn,
      ...(permissionPolicy ? { permissionPolicy } : {}),
    };
  }


  /**
   * Codex consumes localImage turn items as host paths, but mobile uploads
   * arrive as base64 BridgeAttachments. Materialize them into a private temp
   * directory for the duration of the turn and remove it once the turn
   * settles (or the broker closes).
   */
  private async materializeImages(
    sessionId: string,
    adapter: DesktopRuntimeAdapter,
    attachments: BridgeAttachment[],
  ): Promise<string[]> {
    const images = attachments.filter((attachment) => (
      attachment.mimeType.startsWith("image/") && attachment.data.length > 0
    ));
    if (!images.length) return [];
    const directory = join(tmpdir(), `bridge-${adapter.id}-${randomUUID()}`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    this.imageDirs.set(sessionId, directory);
    const paths: string[] = [];
    for (const image of images) {
      const extension = image.mimeType.split("/")[1] ?? "bin";
      const safeName = basename(image.name).replace(/[^\w.\-]/gu, "_") || `image.${extension}`;
      const path = join(directory, `${randomUUID()}.${safeName}`);
      await writeFile(path, Buffer.from(image.data, "base64"), { mode: 0o600 });
      paths.push(path);
    }
    return paths;
  }

  private async cleanupImages(sessionId: string): Promise<void> {
    const directory = this.imageDirs.get(sessionId);
    if (!directory) return;
    this.imageDirs.delete(sessionId);
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }

  private async handleAdapterEvent(runtimeId: BridgeDesktopRuntimeId, event: RuntimeAdapterEvent): Promise<void> {
    if (event.type === "session.updated") {
      this.upsert(runtimeId, event.session);
      this.historySyncPending.add(runtimeSessionId(runtimeId, event.session.nativeSessionId));
      await this.publishRuntimeSession(
        this.toBridgeSession(this.requireAdapter(runtimeId, "session.history"), event.session),
      );
      this.emit("changed");
      return;
    }
    if (event.type === "permission.requested") {
      await this.handlePermission(runtimeId, event.permission);
      return;
    }
    if (event.type === "goal.updated" || event.type === "goal.cleared") {
      // Goal state is owned by the runtime handoff supervisor; it listens
      // to the registry directly and writes normalized runtime.goal events.
      return;
    }
    const nativeSessionId = event.nativeSessionId;
    const sessionId = runtimeSessionId(runtimeId, nativeSessionId);
    this.historySyncPending.add(sessionId);
    const session = this.sessionsByRuntime.get(runtimeId)?.get(nativeSessionId);
    if (session) {
      session.lastActivityAt = event.at;
      if (event.type === "turn.started") {
        session.turnState = "running";
        if (event.turnId) session.activeTurnId = event.turnId;
      } else if (event.type === "turn.completed") {
        session.turnState = "completed";
        delete session.activeTurnId;
      } else if (event.type === "turn.failed") {
        session.turnState = "failed";
        delete session.activeTurnId;
      } else if (event.type === "turn.interrupted") {
        session.turnState = "interrupted";
        delete session.activeTurnId;
      }
      if (event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.interrupted") {
        void this.cleanupImages(sessionId);
      }
      this.upsert(runtimeId, session);
    }

    const mapped = this.toBridgeEvent(event);
    await this.eventLog.append({
      sessionId,
      ...(mapped.turnId ? { turnId: mapped.turnId } : {}),
      ...(mapped.itemId ? { itemId: mapped.itemId } : {}),
      timestamp: event.at,
      origin: originFor(runtimeId),
      type: mapped.type,
      data: { ...mapped.data, runtimeId },
    });
    this.emit("changed");
  }

  private async handlePermission(runtimeId: BridgeDesktopRuntimeId, permission: RuntimeAdapterPermission): Promise<void> {
    const adapter = this.registry.adapter(runtimeId);
    if (!adapter) return;
    const sessionId = runtimeSessionId(runtimeId, permission.nativeSessionId);
    const requestId = `${runtimeId}:${encodeURIComponent(permission.requestId)}`;
    const info: BridgePermissionInfo = {
      requestId,
      sessionId,
      toolUseId: permission.toolUseId,
      toolName: permission.question ? "AskUserQuestion" : permission.toolName,
      input: permission.input,
      createdAt: permission.createdAt,
      canAllowAlways: permission.canAllowAlways,
      ...(permission.title ? { title: permission.title } : {}),
      ...(permission.displayName ? { displayName: permission.displayName } : {}),
      ...(permission.description ? { description: permission.description } : {}),
    };
    const stored: StoredPermission = {
      adapter,
      nativeRequestId: permission.requestId,
      nativeSessionId: permission.nativeSessionId,
      info,
    };
    this.permissions.set(requestId, stored);
    const session = this.sessionsByRuntime.get(runtimeId)?.get(permission.nativeSessionId);
    if (session) {
      session.turnState = "waiting";
      session.lastActivityAt = permission.createdAt;
      this.upsert(runtimeId, session);
    }
    await this.eventLog.append({
      sessionId,
      itemId: requestId,
      timestamp: permission.createdAt,
      origin: originFor(runtimeId),
      type: permission.question ? "question.requested" : "permission.requested",
      data: {
        requestId,
        toolUseId: permission.toolUseId,
        toolName: info.toolName,
        title: permission.title ?? "",
        displayName: permission.displayName ?? "",
        description: permission.description ?? "",
        input: permission.input,
        createdAt: permission.createdAt,
        canAllowAlways: permission.canAllowAlways,
        runtimeId,
      },
    });
    // Full-access sessions never surface an approval prompt: non-question
    // requests are approved immediately, exactly like Claude's policy sweep.
    if (
      !permission.question &&
      this.permissionPolicy(sessionId)?.effectiveMode === "full-access" &&
      (await this.autoResolve(requestId, stored))
    ) {
      this.emit("changed");
      return;
    }
    this.emit("changed");
  }

  private async autoResolve(requestId: string, pending: StoredPermission): Promise<boolean> {
    const resolved = await pending.adapter
      .resolvePermission(pending.nativeRequestId, "allow-once")
      .catch(() => false);
    if (!resolved) return false;
    this.permissions.delete(requestId);
    const session = this.sessionsByRuntime.get(pending.adapter.id)?.get(pending.nativeSessionId);
    if (session && session.turnState === "waiting") {
      session.turnState = "running";
      this.upsert(pending.adapter.id, session);
    }
    await this.eventLog.append({
      sessionId: pending.info.sessionId,
      itemId: requestId,
      origin: originFor(pending.adapter.id),
      type: "permission.resolved",
      data: {
        requestId,
        decision: "allow-once",
        runtimeId: pending.adapter.id,
        resolvedAt: Date.now(),
        automatic: true,
        resolvedByName: "Bridge 完全授权",
        reason: "policy-full-access",
      },
    });
    return true;
  }

  private toBridgeEvent(event: Exclude<RuntimeAdapterEvent, { type: "session.updated" } | { type: "permission.requested" } | { type: "goal.updated" } | { type: "goal.cleared" }>): {
    type: BridgeEventType;
    turnId?: string;
    itemId?: string;
    data: Record<string, unknown>;
  } {
    switch (event.type) {
      case "turn.started":
        return { type: "turn.started", ...(event.turnId ? { turnId: event.turnId } : {}), data: {} };
      case "turn.completed":
        return {
          type: "turn.completed",
          ...(event.turnId ? { turnId: event.turnId } : {}),
          data: event.result ? { result: event.result } : {},
        };
      case "turn.failed":
        return { type: "turn.failed", ...(event.turnId ? { turnId: event.turnId } : {}), data: { error: event.error } };
      case "turn.interrupted":
        return { type: "turn.interrupted", ...(event.turnId ? { turnId: event.turnId } : {}), data: {} };
      case "user.accepted":
        return {
          type: "user.message.accepted",
          ...(event.turnId ? { turnId: event.turnId } : {}),
          ...(event.itemId ? { itemId: event.itemId } : {}),
          data: { text: event.text },
        };
      case "assistant.delta":
        return {
          type: "assistant.delta",
          ...(event.turnId ? { turnId: event.turnId } : {}),
          ...(event.itemId ? { itemId: event.itemId } : {}),
          data: { text: event.text },
        };
      case "assistant.completed":
        return {
          type: "assistant.completed",
          ...(event.turnId ? { turnId: event.turnId } : {}),
          ...(event.itemId ? { itemId: event.itemId } : {}),
          data: { text: event.text },
        };
      case "tool.started":
        return {
          type: "tool.started",
          ...(event.turnId ? { turnId: event.turnId } : {}),
          itemId: event.itemId,
          data: {
            toolName: event.toolName,
            ...(event.input !== undefined ? { input: event.input } : {}),
            ...(event.fileChanges ? { fileChanges: event.fileChanges } : {}),
          },
        };
      case "tool.progress":
        return {
          type: "tool.progress",
          ...(event.turnId ? { turnId: event.turnId } : {}),
          itemId: event.itemId,
          data: { toolName: event.toolName, ...(event.text ? { text: event.text } : {}) },
        };
      case "tool.completed":
        return {
          type: "tool.completed",
          ...(event.turnId ? { turnId: event.turnId } : {}),
          itemId: event.itemId,
          data: {
            toolName: event.toolName,
            ...(event.output !== undefined ? { output: event.output } : {}),
            ...(event.fileChanges ? { fileChanges: event.fileChanges } : {}),
          },
        };
      case "permission.resolved":
        return { type: "permission.resolved", itemId: event.requestId, data: { requestId: event.requestId, decision: event.decision } };
    }
  }
}
