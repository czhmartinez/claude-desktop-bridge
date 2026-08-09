import { randomUUID } from "node:crypto";
import type {
  BridgeDesktopRuntimeId,
  BridgeEvent,
  BridgeRuntimeGoalInfo,
  BridgeRuntimeHandoff,
  BridgeRuntimeHandoffPreview,
  BridgeRuntimeRelayLink,
  BridgeSessionInfo,
} from "@bridge/protocol";
import type {
  ConversationStateStore,
  StoredRuntimeGoal,
  StoredRuntimeHandoff,
} from "./conversation-state-store.js";
import {
  EXECUTABLE_PROMPT_LIMIT,
  captureWorkspace,
  compact,
  extractConstraints,
  extractLatestGoal,
  handoffContextBlock,
  normalizeConversation,
  packageHash,
  redact,
  type HandoffArtifactSummary,
  type RuntimeHandoffPackage,
} from "./handoff-package.js";
import type { EvidenceManager } from "./evidence-manager.js";
import type { RuntimeAdapterGoal, RuntimeAdapterRegistry } from "./runtime-adapter.js";
import { parseRuntimeSessionId, type RuntimeSessionBroker } from "./runtime-session-broker.js";
import type { SessionBroker } from "./session-broker.js";
import type { SessionEventLog } from "./session-event-log.js";

const PREVIEW_TTL_MS = 30 * 60 * 1_000;
const SOURCE_INTERRUPT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_CONTINUATIONS = 20;
const PLAN_TEXT_LIMIT = 24_000;
const RUNTIME_IDS: BridgeDesktopRuntimeId[] = ["claude-desktop", "codex-desktop", "hermes-desktop"];

const GOAL_MARKER_PATTERN = /GOAL_STATUS:\s*(continue|done|blocked)\b\s*[:\-–]?\s*([^\n]*)/iu;

interface NormalizedHistoryItem {
  role: "user" | "assistant" | "tool" | "system";
  text: string;
  createdAt: number;
  toolName?: string;
}

interface RuntimeHandoffEndpoint {
  readonly runtimeId: BridgeDesktopRuntimeId;
  available(): boolean;
  sessionInfo(sessionId: string): BridgeSessionInfo | undefined;
  hasActiveOrPending(sessionId: string): boolean;
  interrupt(sessionId: string): Promise<boolean>;
  history(sessionId: string): Promise<NormalizedHistoryItem[]>;
  toolsAndArtifacts(sessionId: string): Promise<{ tools: string[]; artifacts: HandoffArtifactSummary[] }>;
  createSession(cwd: string, title: string): Promise<BridgeSessionInfo>;
  startTurn(sessionId: string, text: string, idempotencyKey: string): Promise<void>;
  setPlanMode?(sessionId: string, enabled: boolean): Promise<boolean>;
  goalSet?(sessionId: string, objective: string): Promise<boolean>;
  goalGet?(sessionId: string): Promise<RuntimeAdapterGoal | undefined>;
  goalPause?(sessionId: string): Promise<boolean>;
  goalResume?(sessionId: string): Promise<boolean>;
}

export interface RuntimeHandoffServiceOptions {
  state: ConversationStateStore;
  broker: SessionBroker;
  eventLog: SessionEventLog;
  evidence: EvidenceManager;
  runtimeRegistry: RuntimeAdapterRegistry;
  runtimeSessions: RuntimeSessionBroker;
  now?: () => number;
  maxContinuations?: number;
  interruptTimeoutMs?: number;
}

function boundText(value: string, limit: number): string {
  return value.length <= limit ? value : value.slice(0, limit);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class RuntimeHandoffService {
  private readonly now: () => number;
  private readonly maxContinuations: number;
  private readonly interruptTimeoutMs: number;
  private readonly endpoints = new Map<BridgeDesktopRuntimeId, RuntimeHandoffEndpoint>();
  private eventQueue: Promise<void> = Promise.resolve();
  private initialized = false;

  constructor(private readonly options: RuntimeHandoffServiceOptions) {
    this.now = options.now ?? Date.now;
    this.maxContinuations = options.maxContinuations ?? DEFAULT_MAX_CONTINUATIONS;
    this.interruptTimeoutMs = options.interruptTimeoutMs ?? SOURCE_INTERRUPT_TIMEOUT_MS;
    this.endpoints.set("claude-desktop", this.claudeEndpoint());
    for (const runtimeId of ["codex-desktop", "hermes-desktop"] as const) {
      this.endpoints.set(runtimeId, this.adapterEndpoint(runtimeId));
    }
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    this.options.eventLog.on("event", this.handleEvent);
    this.options.runtimeRegistry.on("event", this.handleRegistryEvent);
    for (const handoff of this.options.state.listActiveRuntimeHandoffs()) {
      await this.recoverHandoff(handoff).catch(() => undefined);
    }
    for (const goal of this.options.state.listRuntimeGoals(["active"])) {
      await this.reconcileGoal(goal).catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    this.options.eventLog.off("event", this.handleEvent);
    this.options.runtimeRegistry.off("event", this.handleRegistryEvent);
    await this.eventQueue.catch(() => undefined);
  }

  get(handoffId: string): StoredRuntimeHandoff {
    const handoff = this.options.state.runtimeHandoff(handoffId);
    if (!handoff) throw new Error("Runtime handoff not found");
    return handoff;
  }

  list(sessionId: string): { handoffs: StoredRuntimeHandoff[] } {
    return { handoffs: this.options.state.runtimeHandoffsForSession(sessionId) };
  }

  relayMetadata(sessionId: string): BridgeSessionInfo["relay"] | undefined {
    const handoffs = this.options.state.runtimeHandoffsForSession(sessionId)
      .filter((handoff) => handoff.targetSessionId && handoff.state !== "cancelled" && handoff.state !== "failed");
    if (!handoffs.length) return undefined;
    const inboundRow = handoffs.filter((handoff) => handoff.targetSessionId === sessionId).at(-1);
    const outboundRows = handoffs
      .filter((handoff) => handoff.sourceSessionId === sessionId)
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, 5);
    const link = (handoff: StoredRuntimeHandoff, counterpartSessionId: string, runtimeId: BridgeDesktopRuntimeId): BridgeRuntimeRelayLink => ({
      handoffId: handoff.handoffId,
      sessionId: counterpartSessionId,
      runtimeId,
      title: this.endpointForSession(counterpartSessionId)?.endpoint.sessionInfo(counterpartSessionId)?.title
        ?? "未知会话",
      at: handoff.updatedAt,
    });
    return {
      ...(inboundRow ? { inbound: link(inboundRow, inboundRow.sourceSessionId, inboundRow.sourceRuntimeId) } : {}),
      ...(outboundRows.length
        ? { outbound: outboundRows.map((handoff) => link(handoff, handoff.targetSessionId!, handoff.targetRuntimeId)) }
        : {}),
    };
  }

  goalInfo(sessionId: string): BridgeRuntimeGoalInfo | undefined {
    const goal = this.options.state.runtimeGoal(sessionId);
    if (!goal) return undefined;
    const { objective, status, native, continuations, detail, updatedAt } = goal;
    return { objective, status, native, continuations, ...(detail ? { detail } : {}), updatedAt };
  }

  /**
   * Snapshot enrichment for the full session list. Reads the store once and
   * resolves everything through in-memory maps — per-session broker lookups
   * here previously made every publish O(N²) and wedged the main process.
   */
  enrichSessions(sessions: BridgeSessionInfo[]): BridgeSessionInfo[] {
    const handoffs = this.options.state.listRuntimeHandoffs();
    const goals = this.options.state.listRuntimeGoals();
    const available = new Map<BridgeDesktopRuntimeId, boolean>(
      RUNTIME_IDS.map((runtimeId) => [runtimeId, this.endpoints.get(runtimeId)?.available() ?? false]),
    );
    const titles = new Map(sessions.map((session) => [session.sessionId, session.title]));
    const goalsBySession = new Map(goals.map((goal) => [goal.sessionId, goal]));
    const activeBySource = new Map<string, StoredRuntimeHandoff>();
    const inboundByTarget = new Map<string, StoredRuntimeHandoff>();
    const outboundBySource = new Map<string, StoredRuntimeHandoff[]>();
    for (const handoff of handoffs) {
      const terminal = ["applied", "cancelled", "failed"].includes(handoff.state);
      if (!terminal) {
        const current = activeBySource.get(handoff.sourceSessionId);
        if (!current || current.createdAt < handoff.createdAt) activeBySource.set(handoff.sourceSessionId, handoff);
      }
      if (handoff.targetSessionId && handoff.state !== "cancelled" && handoff.state !== "failed") {
        const current = inboundByTarget.get(handoff.targetSessionId);
        if (!current || current.updatedAt < handoff.updatedAt) inboundByTarget.set(handoff.targetSessionId, handoff);
        const list = outboundBySource.get(handoff.sourceSessionId) ?? [];
        list.push(handoff);
        outboundBySource.set(handoff.sourceSessionId, list);
      }
    }
    const toLink = (
      handoff: StoredRuntimeHandoff,
      counterpartSessionId: string,
      runtimeId: BridgeDesktopRuntimeId,
    ): BridgeRuntimeRelayLink => ({
      handoffId: handoff.handoffId,
      sessionId: counterpartSessionId,
      runtimeId,
      title: titles.get(counterpartSessionId) ?? "未知会话",
      at: handoff.updatedAt,
    });
    return sessions.map((session) => {
      const runtimeId = parseRuntimeSessionId(session.sessionId)?.runtimeId
        ?? session.runtimeId
        ?? "claude-desktop";
      const pending = activeBySource.get(session.sessionId);
      const canRelay = !pending
        && RUNTIME_IDS.some((candidate) => candidate !== runtimeId && available.get(candidate));
      const inbound = inboundByTarget.get(session.sessionId);
      const outbound = (outboundBySource.get(session.sessionId) ?? [])
        .sort((left, right) => right.createdAt - left.createdAt)
        .slice(0, 5);
      const goal = goalsBySession.get(session.sessionId);
      if (!pending && !inbound && !outbound.length && !goal && !canRelay) return session;
      const base = session.allowedActions;
      return {
        ...session,
        allowedActions: {
          canSend: base?.canSend ?? true,
          canSteer: base?.canSteer ?? true,
          canInterrupt: base?.canInterrupt ?? true,
          canSwitchProvider: base?.canSwitchProvider ?? false,
          canContinueOfficial: base?.canContinueOfficial ?? false,
          canConfigure: base?.canConfigure ?? false,
          ...(base?.reason ? { reason: base.reason } : {}),
          canRelay,
        },
        ...(inbound || outbound.length
          ? {
              relay: {
                ...(inbound ? { inbound: toLink(inbound, inbound.sourceSessionId, inbound.sourceRuntimeId) } : {}),
                ...(outbound.length
                  ? { outbound: outbound.map((handoff) => toLink(handoff, handoff.targetSessionId!, handoff.targetRuntimeId)) }
                  : {}),
              },
            }
          : {}),
        ...(pending ? { pendingRuntimeHandoff: this.publicHandoff(pending) } : {}),
        ...(goal ? { goal: this.publicGoal(goal) } : {}),
      };
    });
  }

  /**
   * Snapshot-facing pending handoff for the source session. Native IDs and
   * the plan body stay host-side; clients fetch the plan on demand.
   */
  pendingHandoff(sessionId: string): BridgeRuntimeHandoff | undefined {
    const handoff = this.options.state.runtimeHandoffsForSession(sessionId)
      .filter((candidate) => (
        candidate.sourceSessionId === sessionId &&
        !["applied", "cancelled", "failed"].includes(candidate.state)
      ))
      .sort((left, right) => right.createdAt - left.createdAt)[0];
    if (!handoff) return undefined;
    return this.publicHandoff(handoff);
  }

  private publicHandoff(handoff: StoredRuntimeHandoff): BridgeRuntimeHandoff {
    const {
      planText: _planText,
      sourceNativeSessionId: _sourceNative,
      targetNativeSessionId: _targetNative,
      ...publicHandoff
    } = handoff;
    return publicHandoff;
  }

  private publicGoal(goal: StoredRuntimeGoal): BridgeRuntimeGoalInfo {
    const { objective, status, native, continuations, detail, updatedAt } = goal;
    return { objective, status, native, continuations, ...(detail ? { detail } : {}), updatedAt };
  }


  canRelay(sessionId: string): boolean {
    const found = this.endpointForSession(sessionId);
    if (!found?.endpoint.sessionInfo(sessionId)) return false;
    const active = this.options.state.runtimeHandoffsForSession(sessionId).some((handoff) => (
      handoff.sourceSessionId === sessionId &&
      !["applied", "cancelled", "failed"].includes(handoff.state)
    ));
    if (active) return false;
    return RUNTIME_IDS.some((runtimeId) => (
      runtimeId !== found.runtimeId && this.endpoints.get(runtimeId)?.available()
    ));
  }

  async preview(input: {
    sessionId: string;
    targetRuntimeId: BridgeDesktopRuntimeId;
  }): Promise<BridgeRuntimeHandoffPreview> {
    const found = this.endpointForSession(input.sessionId);
    if (!found) throw new Error("Session not found");
    const { endpoint, runtimeId: sourceRuntimeId } = found;
    if (sourceRuntimeId === input.targetRuntimeId) {
      throw new Error("目标运行时需要与当前会话不同；同运行切换请使用提供方接力");
    }
    if (!RUNTIME_IDS.includes(input.targetRuntimeId)) throw new Error("Unknown target runtime");
    const target = this.endpoints.get(input.targetRuntimeId);
    if (!target?.available()) throw new Error("目标 Desktop 运行时未就绪，请先在 Bridge 中连接");
    if (!this.canRelay(input.sessionId)) {
      throw new Error("当前会话已有未完成的跨 Desktop 接力");
    }
    const session = endpoint.sessionInfo(input.sessionId);
    if (!session) throw new Error("Session not found");
    const handoffId = randomUUID();
    const built = await this.buildPackage(handoffId, sourceRuntimeId, input.sessionId, input.targetRuntimeId);
    if (!built.package.recentConversation.length) {
      throw new Error("当前会话还没有可接力的可见上下文");
    }
    const planPrompt = this.planPrompt(built.package);
    const summary = compact(built.package.objective, 240);
    const handoff = this.options.state.saveRuntimeHandoff({
      handoffId,
      state: "previewed",
      sourceRuntimeId,
      sourceSessionId: input.sessionId,
      ...(session.nativeSessionId ? { sourceNativeSessionId: session.nativeSessionId } : {}),
      targetRuntimeId: input.targetRuntimeId,
      objective: built.package.objective,
      summary,
      expiresAt: this.now() + PREVIEW_TTL_MS,
      package: built.package,
      planPrompt,
    });
    return {
      handoff,
      objectiveDraft: built.package.objective,
      recentItemCount: built.package.recentConversation.length,
      artifactCount: built.package.artifacts.length,
      ...(built.package.workspace.gitBranch ? { gitBranch: built.package.workspace.gitBranch } : {}),
      workspaceDirty: built.package.workspace.dirty,
      promptBytes: planPrompt.length,
    };
  }

  async commit(input: { handoffId: string }): Promise<{ handoff: StoredRuntimeHandoff }> {
    let handoff = this.get(input.handoffId);
    if (handoff.state !== "previewed") throw new Error(`接力当前状态为 ${handoff.state}，不能确认`);
    if (handoff.expiresAt && this.now() > handoff.expiresAt) {
      await this.fail(handoff, "接力预览已过期，请重新发起");
      throw new Error("接力预览已过期，请重新发起");
    }
    handoff = this.saveState(handoff, "preparing");
    await this.emitHandoff("runtime.handoff.started", handoff);
    try {
      const found = this.endpointForSession(handoff.sourceSessionId);
      if (!found) throw new Error("源会话已不存在");
      const source = found.endpoint;
      if (source.hasActiveOrPending(handoff.sourceSessionId)) {
        await source.interrupt(handoff.sourceSessionId);
        const settled = await this.waitForQuiesce(source, handoff.sourceSessionId, this.interruptTimeoutMs);
        if (!settled) {
          throw new Error(`源任务在 ${Math.round(this.interruptTimeoutMs / 1000)} 秒内未能停止，接力已取消；源任务保持原状`);
        }
      }
      // Rebuild the package so it includes everything up to the interruption.
      const rebuilt = await this.buildPackage(
        handoff.handoffId,
        handoff.sourceRuntimeId,
        handoff.sourceSessionId,
        handoff.targetRuntimeId,
      );
      const stored = this.options.state.runtimeHandoffPackage(handoff.handoffId);
      const objective = stored?.package
        ? (stored.package as RuntimeHandoffPackage).objective
        : rebuilt.package.objective;
      rebuilt.package.objective = objective;
      rebuilt.package.integrityHash = packageHash(JSON.stringify({ ...rebuilt.package, integrityHash: undefined }));
      const planPrompt = this.planPrompt(rebuilt.package);
      handoff = this.options.state.saveRuntimeHandoff({
        ...handoff,
        updatedAt: this.now(),
        package: rebuilt.package,
        planPrompt,
      });

      const target = this.endpoints.get(handoff.targetRuntimeId);
      if (!target?.available()) throw new Error("目标 Desktop 运行时未就绪");
      const sourceInfo = source.sessionInfo(handoff.sourceSessionId);
      const title = `接力自 ${compact(sourceInfo?.title ?? handoff.sourceSessionId, 60)}`;
      const targetSession = await target.createSession(rebuilt.package.workspace.cwd, title);
      handoff = this.options.state.saveRuntimeHandoff({
        ...handoff,
        state: "planning",
        targetSessionId: targetSession.sessionId,
        ...(targetSession.nativeSessionId ? { targetNativeSessionId: targetSession.nativeSessionId } : {}),
        updatedAt: this.now(),
      });
      await target.setPlanMode?.(targetSession.sessionId, true).catch(() => false);
      await target.startTurn(targetSession.sessionId, planPrompt, `runtime-handoff-plan:${handoff.handoffId}`);
      return { handoff };
    } catch (error) {
      await this.fail(handoff, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async confirm(input: { handoffId: string; objective?: string }): Promise<{
    handoff: StoredRuntimeHandoff;
    goal: StoredRuntimeGoal;
  }> {
    let handoff = this.get(input.handoffId);
    if (handoff.state !== "plan-ready") throw new Error(`接力当前状态为 ${handoff.state}，不能确认执行`);
    if (!handoff.targetSessionId) throw new Error("接力目标会话缺失");
    const objective = input.objective?.trim() || handoff.objective;
    const targetSessionId = handoff.targetSessionId;
    handoff = this.options.state.saveRuntimeHandoff({
      ...handoff,
      state: "executing",
      objective,
      updatedAt: this.now(),
    });
    try {
      const target = this.endpoints.get(handoff.targetRuntimeId);
      if (!target) throw new Error("目标运行时未注册");
      const stored = this.options.state.runtimeHandoffPackage(handoff.handoffId);
      const pkg = stored?.package as RuntimeHandoffPackage | undefined;
      if (!pkg) throw new Error("接力包已丢失");
      await target.setPlanMode?.(targetSessionId, false).catch(() => false);
      const nativeGoal = await target.goalSet?.(targetSessionId, objective).catch(() => false) ?? false;
      const executionPrompt = this.executionPrompt(pkg, handoff.planText ?? "", objective, !nativeGoal);
      this.options.state.saveRuntimeHandoff({
        ...handoff,
        executionPrompt,
        updatedAt: this.now(),
      });
      await target.startTurn(targetSessionId, executionPrompt, `runtime-handoff-exec:${handoff.handoffId}`);
      const goal = this.options.state.saveRuntimeGoal({
        sessionId: targetSessionId,
        handoffId: handoff.handoffId,
        runtimeId: handoff.targetRuntimeId,
        nativeSessionId: handoff.targetNativeSessionId ?? targetSessionId,
        objective,
        status: "active",
        native: nativeGoal,
        continuations: 0,
        updatedAt: this.now(),
      });
      handoff = this.options.state.saveRuntimeHandoff({
        ...handoff,
        state: "applied",
        updatedAt: this.now(),
      });
      await this.emitHandoff("runtime.handoff.applied", handoff);
      await this.emitGoal(goal);
      return { handoff, goal };
    } catch (error) {
      await this.fail(handoff, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async cancel(handoffId: string): Promise<{ handoff: StoredRuntimeHandoff }> {
    const handoff = this.get(handoffId);
    if (["applied", "executing"].includes(handoff.state)) {
      throw new Error("接力已进入执行阶段，请在目标会话中停止任务或暂停目标");
    }
    if (["cancelled", "failed"].includes(handoff.state)) return { handoff };
    if (handoff.state === "planning" && handoff.targetSessionId) {
      const target = this.endpoints.get(handoff.targetRuntimeId);
      await target?.interrupt(handoff.targetSessionId).catch(() => false);
    }
    const cancelled = this.options.state.saveRuntimeHandoff({
      ...handoff,
      state: "cancelled",
      updatedAt: this.now(),
    });
    await this.emitHandoff("runtime.handoff.cancelled", cancelled);
    return { handoff: cancelled };
  }

  async pauseGoal(sessionId: string): Promise<{ goal?: StoredRuntimeGoal }> {
    const goal = this.options.state.runtimeGoal(sessionId);
    if (!goal || goal.status !== "active") return { ...(goal ? { goal } : {}) };
    const endpoint = this.endpoints.get(goal.runtimeId);
    if (goal.native) await endpoint?.goalPause?.(sessionId).catch(() => false);
    const saved = this.options.state.saveRuntimeGoal({
      ...goal,
      status: "paused",
      updatedAt: this.now(),
    });
    await this.emitGoal(saved);
    return { goal: saved };
  }

  async resumeGoal(sessionId: string): Promise<{ goal: StoredRuntimeGoal }> {
    const goal = this.options.state.runtimeGoal(sessionId);
    if (!goal) throw new Error("当前会话没有接力目标");
    if (goal.status === "complete") throw new Error("目标已完成，不能恢复");
    if (goal.status === "active") return { goal };
    const endpoint = this.endpoints.get(goal.runtimeId);
    if (!endpoint) throw new Error("目标运行时未注册");
    if (goal.native) await endpoint.goalResume?.(sessionId).catch(() => false);
    const { detail: _cleared, ...goalWithoutDetail } = goal;
    const saved = this.options.state.saveRuntimeGoal({
      ...goalWithoutDetail,
      status: "active",
      updatedAt: this.now(),
    });
    await endpoint.startTurn(
      sessionId,
      this.continuationPrompt(saved),
      `runtime-goal-resume:${sessionId}:${this.now()}`,
    );
    await this.emitGoal(saved);
    return { goal: saved };
  }

  // ------------------------------------------------------------------
  // Event-driven plan capture and goal supervision
  // ------------------------------------------------------------------

  private readonly handleEvent = (event: BridgeEvent): void => {
    this.eventQueue = this.eventQueue
      .catch(() => undefined)
      .then(() => this.acceptEvent(event));
  };

  private readonly handleRegistryEvent = (runtimeId: BridgeDesktopRuntimeId, event: unknown): void => {
    this.eventQueue = this.eventQueue
      .catch(() => undefined)
      .then(() => this.acceptRegistryEvent(runtimeId, event));
  };

  private async acceptEvent(event: BridgeEvent): Promise<void> {
    if (!event.sessionId) return;
    if (!["turn.completed", "turn.failed", "turn.interrupted"].includes(event.type)) return;
    const sessionId = event.sessionId;

    const planning = this.options.state.listActiveRuntimeHandoffs().find((handoff) => (
      handoff.state === "planning" && handoff.targetSessionId === sessionId
    ));
    if (planning) {
      if (event.type === "turn.completed") await this.finishPlan(planning);
      else await this.fail(
        planning,
        event.type === "turn.interrupted"
          ? "计划阶段被中断"
          : `计划阶段失败：${typeof event.data.error === "string" ? event.data.error : "未知错误"}`,
      );
      return;
    }

    const goal = this.options.state.runtimeGoal(sessionId);
    if (!goal || goal.status !== "active") return;
    if (event.type === "turn.interrupted") {
      // A user-initiated stop must never fight the goal loop.
      await this.pauseGoal(sessionId);
      return;
    }
    if (event.type === "turn.failed") {
      const failed = this.options.state.saveRuntimeGoal({
        ...goal,
        status: "blocked",
        detail: `执行轮失败：${typeof event.data.error === "string" ? event.data.error : "未知错误"}`,
        updatedAt: this.now(),
      });
      await this.emitGoal(failed);
      return;
    }
    if (!goal.native) await this.superviseEmulatedGoal(goal);
  }

  private async acceptRegistryEvent(runtimeId: BridgeDesktopRuntimeId, value: unknown): Promise<void> {
    const event = value as { type?: string; nativeSessionId?: string; goal?: RuntimeAdapterGoal };
    if (event.type !== "goal.updated" && event.type !== "goal.cleared") return;
    if (!event.nativeSessionId) return;
    const goal = this.options.state.listRuntimeGoals().find((candidate) => (
      candidate.runtimeId === runtimeId &&
      candidate.nativeSessionId === event.nativeSessionId &&
      candidate.native
    ));
    if (!goal) return;
    if (event.type === "goal.cleared") {
      if (goal.status === "active") {
        await this.emitGoal(this.options.state.saveRuntimeGoal({
          ...goal,
          status: "complete",
          detail: "目标已被运行时清除",
          updatedAt: this.now(),
        }));
      }
      return;
    }
    const nativeGoal = event.goal!;
    await this.emitGoal(this.options.state.saveRuntimeGoal({
      ...goal,
      status: nativeGoal.status,
      ...(nativeGoal.detail ? { detail: nativeGoal.detail } : {}),
      updatedAt: this.now(),
    }));
  }

  private async finishPlan(handoff: StoredRuntimeHandoff): Promise<void> {
    try {
      if (!handoff.targetSessionId) throw new Error("接力目标会话缺失");
      const target = this.endpoints.get(handoff.targetRuntimeId);
      if (!target) throw new Error("目标运行时未注册");
      const history = await target.history(handoff.targetSessionId);
      const planText = boundText(
        [...history].reverse().find((item) => item.role === "assistant" && item.text.trim())?.text.trim() ?? "",
        PLAN_TEXT_LIMIT,
      );
      if (!planText) throw new Error("目标没有产出可读计划，请检查目标运行时后重试");
      const ready = this.options.state.saveRuntimeHandoff({
        ...handoff,
        state: "plan-ready",
        planText,
        updatedAt: this.now(),
      });
      await this.emitHandoff("runtime.handoff.plan-ready", ready);
    } catch (error) {
      await this.fail(handoff, error instanceof Error ? error.message : String(error));
    }
  }

  private async superviseEmulatedGoal(goal: StoredRuntimeGoal): Promise<void> {
    const endpoint = this.endpoints.get(goal.runtimeId);
    if (!endpoint) return;
    const history = await endpoint.history(goal.sessionId).catch(() => []);
    const lastAssistant = [...history].reverse().find((item) => item.role === "assistant" && item.text.trim());
    const marker = lastAssistant ? GOAL_MARKER_PATTERN.exec(lastAssistant.text) : undefined;
    const outcome = marker?.[1]?.toLowerCase();
    if (outcome === "done") {
      const { detail: _cleared, ...goalWithoutDetail } = goal;
      await this.emitGoal(this.options.state.saveRuntimeGoal({
        ...goalWithoutDetail,
        status: "complete",
        updatedAt: this.now(),
      }));
      return;
    }
    if (outcome === "blocked") {
      await this.emitGoal(this.options.state.saveRuntimeGoal({
        ...goal,
        status: "blocked",
        detail: marker?.[2]?.trim() || "目标报告无法继续",
        updatedAt: this.now(),
      }));
      return;
    }
    if (goal.continuations >= this.maxContinuations) {
      await this.emitGoal(this.options.state.saveRuntimeGoal({
        ...goal,
        status: "blocked",
        detail: `已达到 ${this.maxContinuations} 次自动续跑上限`,
        updatedAt: this.now(),
      }));
      return;
    }
    const next = this.options.state.saveRuntimeGoal({
      ...goal,
      continuations: goal.continuations + 1,
      updatedAt: this.now(),
    });
    await endpoint.startTurn(
      goal.sessionId,
      this.continuationPrompt(next),
      `runtime-goal-continue:${goal.sessionId}:${next.continuations}`,
    );
    await this.emitGoal(next);
  }

  // ------------------------------------------------------------------
  // Crash recovery
  // ------------------------------------------------------------------

  private async recoverHandoff(handoff: StoredRuntimeHandoff): Promise<void> {
    if (handoff.state === "previewed") {
      if (handoff.expiresAt && this.now() > handoff.expiresAt) {
        await this.fail(handoff, "接力预览在 Bridge 重启前已过期");
      }
      return;
    }
    if (handoff.state === "preparing") {
      await this.fail(handoff, "Bridge 在接力准备阶段重新启动；为避免重复执行，本次接力已停止");
      return;
    }
    if (handoff.state === "planning") {
      // A plan turn may have completed while Bridge was down; recover it
      // from the target history, otherwise fail closed.
      if (!handoff.targetSessionId) {
        await this.fail(handoff, "Bridge 在计划阶段重新启动，且目标会话缺失");
        return;
      }
      const target = this.endpoints.get(handoff.targetRuntimeId);
      const info = target?.sessionInfo(handoff.targetSessionId);
      if (!target || !info || info.turnState === "running" || info.turnState === "queued") {
        await this.fail(handoff, "Bridge 在计划阶段重新启动；为避免重复执行，本次接力已停止");
        return;
      }
      await this.finishPlan(handoff);
      return;
    }
    if (handoff.state === "executing") {
      const goal = handoff.targetSessionId
        ? this.options.state.runtimeGoal(handoff.targetSessionId)
        : undefined;
      if (goal) {
        const applied = this.options.state.saveRuntimeHandoff({
          ...handoff,
          state: "applied",
          updatedAt: this.now(),
        });
        await this.emitHandoff("runtime.handoff.applied", applied);
      } else {
        await this.fail(handoff, "Bridge 在执行交接阶段重新启动；为避免重复执行，本次接力已停止");
      }
    }
  }

  private async reconcileGoal(goal: StoredRuntimeGoal): Promise<void> {
    const endpoint = this.endpoints.get(goal.runtimeId);
    if (!endpoint) return;
    if (goal.native) {
      const native = await endpoint.goalGet?.(goal.sessionId).catch(() => undefined);
      if (native && native.status !== goal.status) {
        await this.emitGoal(this.options.state.saveRuntimeGoal({
          ...goal,
          status: native.status,
          ...(native.detail ? { detail: native.detail } : {}),
          updatedAt: this.now(),
        }));
      }
      return;
    }
    const info = endpoint.sessionInfo(goal.sessionId);
    if (!info || info.turnState === "running" || info.turnState === "queued") return;
    // The target went idle while Bridge was down; pick the loop back up
    // only when the latest assistant output is newer than our record.
    if (info.lastActivityAt > goal.updatedAt) {
      await this.superviseEmulatedGoal(goal);
    }
  }

  // ------------------------------------------------------------------
  // Package and prompts
  // ------------------------------------------------------------------

  private async buildPackage(
    handoffId: string,
    sourceRuntimeId: BridgeDesktopRuntimeId,
    sourceSessionId: string,
    targetRuntimeId: BridgeDesktopRuntimeId,
  ): Promise<{ package: RuntimeHandoffPackage }> {
    const endpoint = this.endpoints.get(sourceRuntimeId);
    const session = endpoint?.sessionInfo(sourceSessionId);
    if (!endpoint || !session) throw new Error("Session not found");
    const cwd = session.cwd;
    const history = await endpoint.history(sourceSessionId);
    const recentConversation = normalizeConversation(history, cwd);
    const objective = redact(compact(
      extractLatestGoal(recentConversation, [session.currentSummary, session.title]),
      2_000,
    ), cwd);
    const constraints = extractConstraints(recentConversation);
    const { tools, artifacts } = await endpoint.toolsAndArtifacts(sourceSessionId);
    const workspace = await captureWorkspace(cwd);
    const unsigned: Omit<RuntimeHandoffPackage, "integrityHash"> = {
      version: 1,
      handoffId,
      sourceRuntimeId,
      sourceSessionId,
      ...(session.nativeSessionId ? { sourceNativeSessionId: session.nativeSessionId } : {}),
      targetRuntimeId,
      objective,
      recentConversation,
      constraints,
      incompleteItems: [
        ...(session.pendingCount ? [`仍有 ${session.pendingCount} 个待处理任务（未迁移，保留在源会话）`] : []),
        ...(session.currentSummary ? [redact(compact(session.currentSummary, 500), cwd)] : []),
      ],
      toolsAndCommands: tools,
      artifacts,
      workspace,
      sourceEventSeq: this.options.eventLog.latestSeq(),
    };
    return {
      package: {
        ...unsigned,
        integrityHash: packageHash(JSON.stringify(unsigned)),
      },
    };
  }

  private planPrompt(pkg: RuntimeHandoffPackage): string {
    const prompt = [
      handoffContextBlock(pkg),
      "",
      "你现在是接手此任务的计划者。请先阅读工作区与以上可见上下文，只进行分析与规划：",
      "不要修改任何文件，不要执行有副作用的命令，不要声称继承了隐藏思维或原生运行态。",
      "输出一份可执行计划：目标理解、关键步骤、验证方式、风险与回退。计划完成后等待确认，不要开始实施。",
    ].filter(Boolean).join("\n\n");
    return boundText(prompt, EXECUTABLE_PROMPT_LIMIT);
  }

  private executionPrompt(
    pkg: RuntimeHandoffPackage,
    planText: string,
    objective: string,
    emulatedGoal: boolean,
  ): string {
    const prompt = [
      handoffContextBlock({ ...pkg, objective }),
      "",
      `已确认的计划：\n${planText}`,
      "",
      `执行目标：${objective}`,
      "请按确认的计划执行，直到目标完成；不要声称继承了隐藏思维或原生运行态。",
      emulatedGoal
        ? "执行约定：每个工作轮结束时，在回复最后一行单独输出 GOAL_STATUS: continue|done|blocked"
          + "（done=目标已达成；blocked=无法继续，并在标记后说明原因；continue=仍需继续）。"
        : "",
    ].filter(Boolean).join("\n\n");
    return boundText(prompt, EXECUTABLE_PROMPT_LIMIT);
  }

  private continuationPrompt(goal: StoredRuntimeGoal): string {
    const base = `继续执行目标：${compact(goal.objective, 500)}`;
    return goal.native
      ? base
      : `${base}\n\n结束时按约定在最后一行单独输出 GOAL_STATUS: continue|done|blocked。`;
  }

  // ------------------------------------------------------------------
  // Endpoints
  // ------------------------------------------------------------------

  private endpointForSession(sessionId: string): {
    endpoint: RuntimeHandoffEndpoint;
    runtimeId: BridgeDesktopRuntimeId;
  } | undefined {
    const parsed = parseRuntimeSessionId(sessionId);
    const runtimeId: BridgeDesktopRuntimeId = parsed?.runtimeId ?? "claude-desktop";
    const endpoint = this.endpoints.get(runtimeId);
    return endpoint ? { endpoint, runtimeId } : undefined;
  }

  private claudeEndpoint(): RuntimeHandoffEndpoint {
    const broker = this.options.broker;
    const evidence = this.options.evidence;
    return {
      runtimeId: "claude-desktop",
      available: () => {
        const state = broker.runtimeStatus().state;
        return state === "ready" || state === "working";
      },
      sessionInfo: (sessionId) => broker.session(sessionId),
      hasActiveOrPending: (sessionId) => broker.hasActiveOrPending(sessionId),
      interrupt: (sessionId) => broker.interruptTurn(sessionId, undefined, true),
      history: async (sessionId) => {
        const page = await broker.history(sessionId, undefined, 50);
        return page.items.map((item) => ({
          role: item.role,
          text: item.text,
          createdAt: item.createdAt,
          ...(item.toolName ? { toolName: item.toolName } : {}),
        }));
      },
      toolsAndArtifacts: async (sessionId) => {
        const cwd = broker.session(sessionId)?.cwd;
        const bundles = evidence.list(sessionId, undefined, 12).items;
        return {
          tools: bundles
            .flatMap((bundle) => bundle.tools.map((tool) => redact(compact(tool.summary, 300), cwd)))
            .slice(0, 100),
          artifacts: bundles
            .flatMap((bundle) => bundle.artifacts.map((artifact) => ({
              path: artifact.relativePath,
              change: artifact.changeKind,
              size: artifact.size,
              ...(artifact.sha256 ? { sha256: artifact.sha256 } : {}),
            })))
            .filter((artifact, index, all) => all.findIndex((candidate) => candidate.path === artifact.path) === index)
            .slice(0, 200),
        };
      },
      createSession: (cwd, title) => broker.createSession(cwd, title),
      startTurn: async (sessionId, text, idempotencyKey) => {
        await broker.startTurn({
          requestId: randomUUID(),
          idempotencyKey,
        sessionId,
          text,
          attachments: [],
          origin: "desktop",
        });
      },
    };
  }

  private adapterEndpoint(runtimeId: BridgeDesktopRuntimeId): RuntimeHandoffEndpoint {
    const registry = this.options.runtimeRegistry;
    const runtimeSessions = this.options.runtimeSessions;
    const adapter = () => registry.adapter(runtimeId);
    // Native plan/goal hooks are only invoked when the adapter explicitly
    // declares the capability; everything else gets prompt contracts.
    const goalNative = () => adapter()?.status().capabilities.includes("goal.native") === true;
    const nativeOf = (sessionId: string): string => {
      const parsed = parseRuntimeSessionId(sessionId);
      if (!parsed) throw new Error("Invalid runtime session id");
      return parsed.nativeSessionId;
    };
    return {
      runtimeId,
      available: () => {
        const status = adapter()?.status();
        return status?.state === "ready"
          && status.capabilities.includes("session.create")
          && status.capabilities.includes("turn.start");
      },
      sessionInfo: (sessionId) => runtimeSessions.session(sessionId),
      hasActiveOrPending: (sessionId) => {
        const state = runtimeSessions.session(sessionId)?.turnState;
        return state === "running" || state === "queued" || state === "waiting";
      },
      interrupt: (sessionId) => runtimeSessions.interruptTurn(sessionId),
      history: async (sessionId) => {
        const page = await runtimeSessions.history(sessionId);
        return page.items.map((item) => ({
          role: item.role,
          text: item.text,
          createdAt: item.createdAt,
          ...(item.toolName ? { toolName: item.toolName } : {}),
        }));
      },
      toolsAndArtifacts: async (sessionId) => {
        const cwd = runtimeSessions.session(sessionId)?.cwd;
        const page = await runtimeSessions.history(sessionId).catch(() => undefined);
        const tools = (page?.items ?? [])
          .filter((item) => item.role === "tool")
          .map((item) => redact(compact(`${item.toolName ?? "Tool"}: ${item.text}`, 300), cwd))
          .slice(-100);
        return { tools, artifacts: [] };
      },
      createSession: (cwd, title) => runtimeSessions.createSession(runtimeId, cwd, title),
      startTurn: async (sessionId, text, idempotencyKey) => {
        await runtimeSessions.startTurn({
          sessionId,
          text,
          commandId: idempotencyKey,
          requestId: randomUUID(),
        });
      },
      setPlanMode: async (sessionId, enabled) => (
        goalNative()
          ? adapter()?.setCollaborationMode(nativeOf(sessionId), enabled ? "plan" : "default") ?? false
          : false
      ),
      goalSet: async (sessionId, objective) => (
        goalNative() ? adapter()?.goalSet(nativeOf(sessionId), objective) ?? false : false
      ),
      goalGet: (sessionId) => (
        goalNative() ? adapter()?.goalGet(nativeOf(sessionId)) ?? Promise.resolve(undefined) : Promise.resolve(undefined)
      ),
      goalPause: async (sessionId) => (
        goalNative() ? adapter()?.goalPause(nativeOf(sessionId)) ?? false : false
      ),
      goalResume: async (sessionId) => (
        goalNative() ? adapter()?.goalResume(nativeOf(sessionId)) ?? false : false
      ),
    };
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  private async waitForQuiesce(
    endpoint: RuntimeHandoffEndpoint,
    sessionId: string,
    timeoutMs: number,
  ): Promise<boolean> {
    const deadline = this.now() + timeoutMs;
    while (this.now() < deadline) {
      if (!endpoint.hasActiveOrPending(sessionId)) return true;
      await sleep(250);
    }
    return !endpoint.hasActiveOrPending(sessionId);
  }

  private saveState(
    handoff: StoredRuntimeHandoff,
    state: StoredRuntimeHandoff["state"],
  ): StoredRuntimeHandoff {
    return this.options.state.saveRuntimeHandoff({ ...handoff, state, updatedAt: this.now() });
  }

  private async fail(handoff: StoredRuntimeHandoff, error: string): Promise<void> {
    const failed = this.options.state.saveRuntimeHandoff({
      ...handoff,
      state: "failed",
      error: compact(error, 1_000),
      updatedAt: this.now(),
    });
    await this.emitHandoff("runtime.handoff.failed", failed, { error: failed.error });
  }

  private async emitHandoff(
    type:
      | "runtime.handoff.started"
      | "runtime.handoff.plan-ready"
      | "runtime.handoff.applied"
      | "runtime.handoff.failed"
      | "runtime.handoff.cancelled",
    handoff: StoredRuntimeHandoff,
    data: Record<string, unknown> = {},
  ): Promise<void> {
    await this.options.eventLog.append({
      sessionId: handoff.sourceSessionId,
      itemId: handoff.handoffId,
      origin: "system",
      type,
      data: { handoff, ...data },
    });
  }

  private async emitGoal(goal: StoredRuntimeGoal): Promise<void> {
    const { objective, status, native, continuations, detail, updatedAt } = goal;
    await this.options.eventLog.append({
      sessionId: goal.sessionId,
      itemId: goal.handoffId,
      origin: "system",
      type: "runtime.goal.updated",
      data: {
        goal: { objective, status, native, continuations, ...(detail ? { detail } : {}), updatedAt },
        handoffId: goal.handoffId,
      },
    });
  }
}
