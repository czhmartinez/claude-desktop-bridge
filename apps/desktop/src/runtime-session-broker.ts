import { EventEmitter } from "node:events";
import { basename } from "node:path";
import type {
  BridgeDesktopRuntime,
  BridgeDesktopRuntimeId,
  BridgeEventType,
  BridgeHistoryItem,
  BridgeHistoryPage,
  BridgePermissionDecision,
  BridgePermissionInfo,
  BridgeProjectInfo,
  BridgeSessionAllowedActions,
  BridgeSessionConfiguration,
  BridgeSessionInfo,
  BridgeTurnState,
} from "@bridge/protocol";
import type { SessionEventLog } from "./session-event-log.js";
import {
  type DesktopRuntimeAdapter,
  type RuntimeAdapterEvent,
  type RuntimeAdapterConfiguration,
  type RuntimeAdapterConfigurationChange,
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

export class RuntimeSessionBroker extends EventEmitter {
  private readonly sessionsByRuntime = new Map<BridgeDesktopRuntimeId, Map<string, RuntimeAdapterSession>>();
  private readonly permissions = new Map<string, StoredPermission>();
  private eventQueue: Promise<void> = Promise.resolve();
  private initialized = false;

  constructor(
    readonly registry: RuntimeAdapterRegistry,
    private readonly eventLog: SessionEventLog,
  ) {
    super();
    registry.on("changed", () => {
      this.syncCachedSessions();
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
    await this.registry.initialize();
    this.syncCachedSessions();
    this.emit("changed");
  }

  async refresh(runtimeId?: BridgeDesktopRuntimeId): Promise<BridgeDesktopRuntime[]> {
    const runtimes = await this.registry.refresh(runtimeId);
    this.syncCachedSessions();
    this.emit("changed");
    return runtimes;
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

  async startTurn(input: {
    sessionId: string;
    text: string;
    commandId: string;
    requestId: string;
    sourceDeviceId?: string;
    steer?: boolean;
  }): Promise<{ commandId: string; state: "queued" | "running" }> {
    const { adapter, nativeSessionId } = this.requireSession(input.sessionId);
    const capabilities = adapter.status().capabilities;
    const operation = input.steer ? "turn.steer" : "turn.start";
    if (!capabilities.includes(operation)) throw new Error(`${adapter.status().name} 暂不支持该操作`);
    const payload = {
      nativeSessionId,
      text: input.text,
      commandId: input.commandId,
      requestId: input.requestId,
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
      data: { text: input.text, commandId: input.commandId, requestId: input.requestId, runtimeId: adapter.id },
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
    await this.registry.close();
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
    };
  }

  private async handleAdapterEvent(runtimeId: BridgeDesktopRuntimeId, event: RuntimeAdapterEvent): Promise<void> {
    if (event.type === "session.updated") {
      this.upsert(runtimeId, event.session);
      this.emit("changed");
      return;
    }
    if (event.type === "permission.requested") {
      await this.handlePermission(runtimeId, event.permission);
      return;
    }
    const nativeSessionId = event.nativeSessionId;
    const sessionId = runtimeSessionId(runtimeId, nativeSessionId);
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
    this.permissions.set(requestId, {
      adapter,
      nativeRequestId: permission.requestId,
      nativeSessionId: permission.nativeSessionId,
      info,
    });
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
    this.emit("changed");
  }

  private toBridgeEvent(event: Exclude<RuntimeAdapterEvent, { type: "session.updated" } | { type: "permission.requested" }>): {
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
          data: { toolName: event.toolName, ...(event.input !== undefined ? { input: event.input } : {}) },
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
          data: { toolName: event.toolName, ...(event.output !== undefined ? { output: event.output } : {}) },
        };
      case "permission.resolved":
        return { type: "permission.resolved", itemId: event.requestId, data: { requestId: event.requestId, decision: event.decision } };
    }
  }
}
