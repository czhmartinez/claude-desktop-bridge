import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  BridgeEventType,
  BridgeHistoryItem,
  BridgeHistoryPage,
  BridgeRuntimeHandoffState,
  BridgeSessionInfo,
} from "@bridge/protocol";
import { ConversationStateStore } from "./conversation-state-store.js";
import type { EvidenceManager } from "./evidence-manager.js";
import type { RuntimeHandoffPackage } from "./handoff-package.js";
import {
  DesktopRuntimeAdapter,
  RuntimeAdapterRegistry,
  type RuntimeAdapterConfiguration,
  type RuntimeAdapterConfigurationChange,
  type RuntimeAdapterEvent,
  type RuntimeAdapterGoal,
  type RuntimeAdapterHistoryItem,
  type RuntimeAdapterPermission,
  type RuntimeAdapterSession,
  type RuntimeAdapterTurnInput,
} from "./runtime-adapter.js";
import { RuntimeHandoffService } from "./runtime-handoff-service.js";
import { RuntimeSessionBroker, runtimeSessionId } from "./runtime-session-broker.js";
import type { SessionBroker } from "./session-broker.js";
import { SessionEventLog } from "./session-event-log.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

async function waitFor(check: () => boolean, label = "condition"): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

class FakeAdapter extends DesktopRuntimeAdapter {
  readonly sessionMap = new Map<string, RuntimeAdapterSession>();
  readonly historyMap = new Map<string, RuntimeAdapterHistoryItem[]>();
  readonly turns: Array<{ nativeSessionId: string; text: string; commandId: string }> = [];
  readonly interrupts: string[] = [];
  readonly collaborationModes: Array<{ nativeSessionId: string; mode: string }> = [];
  readonly goals = new Map<string, RuntimeAdapterGoal>();
  goalUnsupported = false;

  constructor(
    id: "codex-desktop" | "hermes-desktop",
    name: string,
    goalNative: boolean,
  ) {
    super(id, name, [
      "session.list",
      "session.create",
      "session.history",
      "session.configure",
      "turn.start",
      "turn.steer",
      "turn.interrupt",
      "permission.resolve",
      "tool.events",
      ...(goalNative ? ["goal.native" as const] : []),
    ]);
  }

  addSession(nativeSessionId: string, cwd: string, title: string, history: RuntimeAdapterHistoryItem[] = []): void {
    this.sessionMap.set(nativeSessionId, {
      nativeSessionId,
      cwd,
      title,
      source: "bridge",
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      turnState: "idle",
      transport: this.id === "codex-desktop" ? "codex-app-server" : "hermes-gateway",
    });
    this.historyMap.set(nativeSessionId, [...history]);
    const session = this.sessionMap.get(nativeSessionId)!;
    this.emitRuntimeEvent({ type: "session.updated", session: { ...session } });
  }

  async initialize(): Promise<void> {
    this.setStatus("ready", "fake ready", { sessionCount: this.sessionMap.size });
  }

  async refresh(): Promise<void> {}

  sessions(): RuntimeAdapterSession[] {
    return [...this.sessionMap.values()];
  }

  async createSession(input: { cwd: string; title?: string }): Promise<RuntimeAdapterSession> {
    const nativeSessionId = `${this.id}-native-${this.sessionMap.size + 1}`;
    this.addSession(nativeSessionId, input.cwd, input.title ?? "untitled");
    const session = this.sessionMap.get(nativeSessionId)!;
    this.emitRuntimeEvent({ type: "session.updated", session: { ...session } });
    return session;
  }

  async history(nativeSessionId: string): Promise<RuntimeAdapterHistoryItem[]> {
    return [...(this.historyMap.get(nativeSessionId) ?? [])];
  }

  async configuration(): Promise<RuntimeAdapterConfiguration> {
    return {
      availableModels: [],
      availableProviders: [],
      availableReasoningEfforts: [],
      modelsComplete: true,
      supportsFastMode: false,
      appliesAfterTurn: false,
    };
  }

  async configureSession(_id: string, _change: RuntimeAdapterConfigurationChange): Promise<RuntimeAdapterConfiguration> {
    return this.configuration();
  }

  async startTurn(input: RuntimeAdapterTurnInput): Promise<{ turnId: string; state: "running" }> {
    this.turns.push({
      nativeSessionId: input.nativeSessionId,
      text: input.text,
      commandId: input.commandId,
    });
    const items = this.historyMap.get(input.nativeSessionId) ?? [];
    items.push({
      id: `user-${items.length}`,
      role: "user",
      text: input.text,
      createdAt: Date.now(),
    });
    this.historyMap.set(input.nativeSessionId, items);
    const session = this.sessionMap.get(input.nativeSessionId);
    if (session) {
      session.turnState = "running";
      this.emitRuntimeEvent({ type: "session.updated", session: { ...session } });
    }
    this.emitRuntimeEvent({ type: "turn.started", nativeSessionId: input.nativeSessionId, turnId: "turn-1", at: Date.now() });
    return { turnId: "turn-1", state: "running" };
  }

  async steerTurn(input: RuntimeAdapterTurnInput): Promise<{ turnId: string; state: "running" }> {
    return this.startTurn(input);
  }

  async interruptTurn(nativeSessionId: string): Promise<boolean> {
    this.interrupts.push(nativeSessionId);
    const session = this.sessionMap.get(nativeSessionId);
    if (session) {
      session.turnState = "interrupted";
      this.emitRuntimeEvent({ type: "session.updated", session: { ...session } });
    }
    this.emitRuntimeEvent({ type: "turn.interrupted", nativeSessionId, turnId: "turn-1", at: Date.now() });
    return true;
  }

  async resolvePermission(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {}

  publish(event: RuntimeAdapterEvent): void {
    this.emitRuntimeEvent(event);
  }

  override async setCollaborationMode(nativeSessionId: string, mode: "plan" | "default"): Promise<boolean> {
    this.collaborationModes.push({ nativeSessionId, mode });
    return true;
  }

  override async goalSet(nativeSessionId: string, objective: string): Promise<boolean> {
    if (this.goalUnsupported) return false;
    this.goals.set(nativeSessionId, { objective, status: "active", updatedAt: Date.now() });
    return true;
  }

  override async goalGet(nativeSessionId: string): Promise<RuntimeAdapterGoal | undefined> {
    return this.goals.get(nativeSessionId);
  }

  override async goalPause(nativeSessionId: string): Promise<boolean> {
    const goal = this.goals.get(nativeSessionId);
    if (!goal) return false;
    this.goals.set(nativeSessionId, { ...goal, status: "paused" });
    return true;
  }

  override async goalResume(nativeSessionId: string): Promise<boolean> {
    const goal = this.goals.get(nativeSessionId);
    if (!goal) return false;
    this.goals.set(nativeSessionId, { ...goal, status: "active" });
    return true;
  }

  completeTurn(nativeSessionId: string, assistantText: string): void {
    const items = this.historyMap.get(nativeSessionId) ?? [];
    items.push({
      id: `assistant-${items.length}`,
      role: "assistant",
      text: assistantText,
      createdAt: Date.now(),
    });
    this.historyMap.set(nativeSessionId, items);
    const session = this.sessionMap.get(nativeSessionId);
    if (session) {
      session.turnState = "completed";
      session.lastActivityAt = Date.now();
      this.emitRuntimeEvent({ type: "session.updated", session: { ...session } });
    }
    this.emitRuntimeEvent({ type: "assistant.completed", nativeSessionId, itemId: `assistant-${items.length}`, text: assistantText, at: Date.now() });
    this.emitRuntimeEvent({ type: "turn.completed", nativeSessionId, turnId: "turn-1", at: Date.now() });
  }

  failTurn(nativeSessionId: string, error: string): void {
    this.emitRuntimeEvent({ type: "turn.failed", nativeSessionId, turnId: "turn-1", at: Date.now(), error });
  }
}

function claudeSession(sessionId: string, cwd: string, title = "Claude 会话"): BridgeSessionInfo {
  return {
    sessionId,
    projectId: "project",
    projectName: "project",
    cwd,
    title,
    source: "bridge",
    transport: "bridge-host",
    ownership: "BRIDGE_IDLE",
    turnState: "idle",
    lastActivityAt: Date.now(),
    pendingCount: 0,
  };
}

class FakeBroker {
  readonly sessions = new Map<string, BridgeSessionInfo>();
  readonly historyMap = new Map<string, BridgeHistoryItem[]>();
  readonly active = new Set<string>();
  readonly interrupts: string[] = [];
  readonly startedTurns: Array<{ sessionId: string; text: string; idempotencyKey: string }> = [];

  runtimeStatus(): { state: string } {
    return { state: "ready" };
  }

  session(sessionId: string): BridgeSessionInfo | undefined {
    return this.sessions.get(sessionId);
  }

  hasActiveOrPending(sessionId: string): boolean {
    return this.active.has(sessionId);
  }

  async interruptTurn(sessionId: string): Promise<boolean> {
    this.interrupts.push(sessionId);
    this.active.delete(sessionId);
    return true;
  }

  async history(sessionId: string): Promise<BridgeHistoryPage> {
    return { sessionId, items: [...(this.historyMap.get(sessionId) ?? [])], hasMore: false };
  }

  async createSession(cwd: string, title?: string): Promise<BridgeSessionInfo> {
    const sessionId = `claude-new-${this.sessions.size + 1}`;
    const session = claudeSession(sessionId, cwd, title ?? "untitled");
    this.sessions.set(sessionId, session);
    this.historyMap.set(sessionId, []);
    return session;
  }

  async startTurn(input: { sessionId: string; text: string; idempotencyKey: string }): Promise<void> {
    this.startedTurns.push(input);
    const items = this.historyMap.get(input.sessionId) ?? [];
    items.push({
      id: `user-${items.length}`,
      sessionId: input.sessionId,
      role: "user",
      text: input.text,
      createdAt: Date.now(),
      origin: "desktop",
    });
    this.historyMap.set(input.sessionId, items);
  }
}

interface Fixture {
  state: ConversationStateStore;
  eventLog: SessionEventLog;
  broker: FakeBroker;
  codex: FakeAdapter;
  hermes: FakeAdapter;
  registry: RuntimeAdapterRegistry;
  runtimeSessions: RuntimeSessionBroker;
  service: RuntimeHandoffService;
  cwd: string;
  events: Array<{ type: BridgeEventType; sessionId?: string; data: Record<string, unknown> }>;
}

async function createFixture(options: {
  maxContinuations?: number;
  interruptTimeoutMs?: number;
  now?: () => number;
} = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "bridge-runtime-handoff-"));
  directories.push(root);
  const cwd = join(root, "project");
  await mkdtemp(join(tmpdir(), "bridge-runtime-handoff-cwd-")).then((dir) => directories.push(dir));
  const { mkdir } = await import("node:fs/promises");
  await mkdir(cwd, { recursive: true });
  const state = new ConversationStateStore({
    databasePath: join(root, "state.sqlite"),
    sessionsPath: join(root, "sessions.json"),
    queuePath: join(root, "queue.json"),
    masterSecret: "runtime-handoff-test",
  });
  await state.initialize();
  const eventLog = new SessionEventLog(join(root, "events.jsonl"));
  await eventLog.initialize();
  const broker = new FakeBroker();
  const codex = new FakeAdapter("codex-desktop", "Codex Desktop", true);
  const hermes = new FakeAdapter("hermes-desktop", "Hermes Desktop", false);
  const registry = new RuntimeAdapterRegistry([codex, hermes]);
  const runtimeSessions = new RuntimeSessionBroker(registry, eventLog);
  await runtimeSessions.initialize();
  const evidence = { list: () => ({ items: [] }) } as unknown as EvidenceManager;
  const service = new RuntimeHandoffService({
    state,
    broker: broker as unknown as SessionBroker,
    eventLog,
    evidence,
    runtimeRegistry: registry,
    runtimeSessions,
    ...(options.now ? { now: options.now } : {}),
    ...(options.maxContinuations !== undefined ? { maxContinuations: options.maxContinuations } : {}),
    ...(options.interruptTimeoutMs !== undefined ? { interruptTimeoutMs: options.interruptTimeoutMs } : {}),
  });
  await service.initialize();
  const events: Fixture["events"] = [];
  eventLog.on("event", (event) => {
    events.push({ type: event.type, ...(event.sessionId ? { sessionId: event.sessionId } : {}), data: event.data });
  });
  return { state, eventLog, broker, codex, hermes, registry, runtimeSessions, service, cwd, events };
}

const CLAUDE_SOURCE = "claude-source-1";

function seedClaudeSource(fixture: Fixture, texts?: { user: string; assistant: string }): void {
  fixture.broker.sessions.set(CLAUDE_SOURCE, claudeSession(CLAUDE_SOURCE, fixture.cwd, "源任务"));
  fixture.broker.historyMap.set(CLAUDE_SOURCE, [
    {
      id: "u1",
      sessionId: CLAUDE_SOURCE,
      role: "user",
      text: texts?.user ?? "帮我重构这个模块，不要改变对外接口",
      createdAt: Date.now() - 2_000,
      origin: "desktop",
    },
    {
      id: "a1",
      sessionId: CLAUDE_SOURCE,
      role: "assistant",
      text: texts?.assistant ?? "已经开始分析，初步发现三个可改进点。",
      createdAt: Date.now() - 1_000,
      origin: "desktop",
    },
  ]);
}

describe("RuntimeHandoffService", () => {
  it("builds a bounded, redacted preview package from a Claude source", async () => {
    const fixture = await createFixture();
    seedClaudeSource(fixture, {
      user: "用这个 sk-ant-abcdef123456 调用，并读取 /etc/passwd 对比",
      assistant: "好的",
    });
    const preview = await fixture.service.preview({
      sessionId: CLAUDE_SOURCE,
      targetRuntimeId: "codex-desktop",
    });
    expect(preview.handoff.state).toBe("previewed");
    expect(preview.handoff.expiresAt).toBeGreaterThan(Date.now());
    expect(preview.recentItemCount).toBe(2);
    expect(preview.promptBytes).toBeGreaterThan(0);
    expect(preview.promptBytes).toBeLessThanOrEqual(48_000);
    const stored = fixture.state.runtimeHandoffPackage(preview.handoff.handoffId);
    const pkg = stored?.package as RuntimeHandoffPackage;
    expect(pkg.objective).toContain("[REDACTED_API_KEY]");
    const serialized = JSON.stringify(pkg) + (stored?.planPrompt ?? "");
    expect(serialized).not.toContain("abcdef123456");
    expect(serialized).not.toContain("/etc/passwd");
    expect(pkg.constraints.length).toBe(0);
    expect(preview.objectiveDraft).toBe(pkg.objective);
  });

  it("rejects invalid previews", async () => {
    const fixture = await createFixture();
    seedClaudeSource(fixture);
    await expect(fixture.service.preview({
      sessionId: CLAUDE_SOURCE,
      targetRuntimeId: "claude-desktop",
    })).rejects.toThrow("不同");
    fixture.broker.sessions.set("empty", claudeSession("empty", fixture.cwd));
    fixture.broker.historyMap.set("empty", []);
    await expect(fixture.service.preview({
      sessionId: "empty",
      targetRuntimeId: "codex-desktop",
    })).rejects.toThrow("可见上下文");
    const first = await fixture.service.preview({ sessionId: CLAUDE_SOURCE, targetRuntimeId: "codex-desktop" });
    expect(first.handoff.state).toBe("previewed");
    await expect(fixture.service.preview({
      sessionId: CLAUDE_SOURCE,
      targetRuntimeId: "hermes-desktop",
    })).rejects.toThrow("未完成");
  });

  it("runs the full Claude to Codex relay with a native goal", async () => {
    const fixture = await createFixture();
    seedClaudeSource(fixture);
    fixture.broker.active.add(CLAUDE_SOURCE);
    const preview = await fixture.service.preview({
      sessionId: CLAUDE_SOURCE,
      targetRuntimeId: "codex-desktop",
    });
    const { handoff: committed } = await fixture.service.commit({ handoffId: preview.handoff.handoffId });
    expect(committed.state).toBe("planning");
    expect(fixture.broker.interrupts).toEqual([CLAUDE_SOURCE]);
    expect(committed.targetSessionId).toBe(runtimeSessionId("codex-desktop", committed.targetNativeSessionId!));
    const targetNative = committed.targetNativeSessionId!;
    expect(fixture.codex.collaborationModes).toEqual([{ nativeSessionId: targetNative, mode: "plan" }]);
    expect(fixture.codex.turns).toHaveLength(1);
    expect(fixture.codex.turns[0]!.text).toContain("计划者");
    expect(fixture.codex.turns[0]!.text).not.toContain("GOAL_STATUS");
    const targetInfo = fixture.codex.sessionMap.get(targetNative)!;
    expect(targetInfo.title).toContain("接力自");
    expect(targetInfo.cwd).toBe(fixture.cwd);
    expect(fixture.events.some((event) => event.type === "runtime.handoff.started")).toBe(true);

    fixture.codex.completeTurn(targetNative, "计划：1. 梳理模块边界\n2. 提取纯函数\n3. 补充测试");
    await waitFor(() => fixture.service.get(committed.handoffId).state === "plan-ready", "plan-ready");
    const ready = fixture.service.get(committed.handoffId);
    expect(ready.planText).toContain("提取纯函数");
    expect(fixture.events.some((event) => event.type === "runtime.handoff.plan-ready")).toBe(true);

    const { handoff: applied, goal } = await fixture.service.confirm({
      handoffId: committed.handoffId,
      objective: "在不改对外接口的前提下完成模块重构",
    });
    expect(applied.state).toBe("applied");
    expect(fixture.codex.collaborationModes.at(-1)).toEqual({ nativeSessionId: targetNative, mode: "default" });
    expect(fixture.codex.goals.get(targetNative)).toMatchObject({
      objective: "在不改对外接口的前提下完成模块重构",
      status: "active",
    });
    expect(fixture.codex.turns).toHaveLength(2);
    expect(fixture.codex.turns[1]!.text).toContain("提取纯函数");
    expect(fixture.codex.turns[1]!.text).not.toContain("GOAL_STATUS");
    expect(goal.native).toBe(true);
    expect(fixture.service.goalInfo(applied.targetSessionId!)).toMatchObject({
      status: "active",
      native: true,
    });
    expect(fixture.events.some((event) => event.type === "runtime.handoff.applied")).toBe(true);
    expect(fixture.events.some((event) => event.type === "runtime.goal.updated")).toBe(true);

    // Relay chain metadata links both directions.
    const sourceRelay = fixture.service.relayMetadata(CLAUDE_SOURCE);
    expect(sourceRelay?.outbound?.[0]).toMatchObject({
      sessionId: applied.targetSessionId,
      runtimeId: "codex-desktop",
    });
    const targetRelay = fixture.service.relayMetadata(applied.targetSessionId!);
    expect(targetRelay?.inbound).toMatchObject({
      sessionId: CLAUDE_SOURCE,
      runtimeId: "claude-desktop",
      title: "源任务",
    });
    // Pending handoff exposure never leaks plan text or native IDs.
    expect(fixture.service.pendingHandoff(CLAUDE_SOURCE)).toBeUndefined();
  });

  it("keeps the source untouched and fails when it will not stop", async () => {
    const fixture = await createFixture({ interruptTimeoutMs: 300 });
    seedClaudeSource(fixture);
    fixture.broker.active.add(CLAUDE_SOURCE);
    fixture.broker.interruptTurn = async () => false; // source refuses to settle
    const preview = await fixture.service.preview({
      sessionId: CLAUDE_SOURCE,
      targetRuntimeId: "codex-desktop",
    });
    await expect(fixture.service.commit({ handoffId: preview.handoff.handoffId })).rejects.toThrow("未能停止");
    expect(fixture.service.get(preview.handoff.handoffId).state).toBe("failed");
    expect(fixture.codex.turns).toHaveLength(0);
    expect(fixture.events.some((event) => event.type === "runtime.handoff.failed")).toBe(true);
  });

  it("expires previews", async () => {
    let now = 1_000_000;
    const fixture = await createFixture({ now: () => now });
    seedClaudeSource(fixture);
    const preview = await fixture.service.preview({
      sessionId: CLAUDE_SOURCE,
      targetRuntimeId: "codex-desktop",
    });
    now += 31 * 60 * 1_000;
    await expect(fixture.service.commit({ handoffId: preview.handoff.handoffId })).rejects.toThrow("已过期");
    expect(fixture.service.get(preview.handoff.handoffId).state).toBe("failed");
  });

  it("fails when the plan turn produces no readable plan", async () => {
    const fixture = await createFixture();
    seedClaudeSource(fixture);
    const preview = await fixture.service.preview({
      sessionId: CLAUDE_SOURCE,
      targetRuntimeId: "codex-desktop",
    });
    const { handoff } = await fixture.service.commit({ handoffId: preview.handoff.handoffId });
    fixture.codex.completeTurn(handoff.targetNativeSessionId!, "   ");
    await waitFor(() => fixture.service.get(handoff.handoffId).state === "failed", "failed");
    expect(fixture.service.get(handoff.handoffId).error).toContain("计划");
  });

  it("runs an emulated goal loop for Hermes with status markers", async () => {
    const fixture = await createFixture({ maxContinuations: 2 });
    fixture.codex.addSession("codex-source", fixture.cwd, "Codex 源", [
      { id: "u1", role: "user", text: "实现一个速率限制器", createdAt: Date.now() - 1_000 },
      { id: "a1", role: "assistant", text: "先看了现有中间件结构。", createdAt: Date.now() - 500 },
    ]);
    await waitFor(
      () => fixture.runtimeSessions.session(runtimeSessionId("codex-desktop", "codex-source")) !== undefined,
      "codex source visible",
    );
    const preview = await fixture.service.preview({
      sessionId: runtimeSessionId("codex-desktop", "codex-source"),
      targetRuntimeId: "hermes-desktop",
    });
    const { handoff } = await fixture.service.commit({ handoffId: preview.handoff.handoffId });
    const hermesNative = handoff.targetNativeSessionId!;
    expect(fixture.hermes.turns).toHaveLength(1);
    expect(fixture.hermes.turns[0]!.text).toContain("不要修改任何文件");

    fixture.hermes.completeTurn(hermesNative, "计划：先写令牌桶，再接入中间件。");
    await waitFor(() => fixture.service.get(handoff.handoffId).state === "plan-ready", "plan-ready");
    const { handoff: applied, goal } = await fixture.service.confirm({ handoffId: handoff.handoffId });
    expect(applied.state).toBe("applied");
    expect(goal.native).toBe(false);
    expect(fixture.hermes.turns).toHaveLength(2);
    expect(fixture.hermes.turns[1]!.text).toContain("GOAL_STATUS: continue|done|blocked");

    // continue -> automatic follow-up turn with persisted counter.
    fixture.hermes.completeTurn(hermesNative, "令牌桶写了一半。\nGOAL_STATUS: continue");
    await waitFor(() => fixture.state.runtimeGoal(applied.targetSessionId!)!.continuations === 1, "continuation 1");
    expect(fixture.hermes.turns).toHaveLength(3);
    expect(fixture.hermes.turns[2]!.text).toContain("继续执行目标");

    fixture.hermes.completeTurn(hermesNative, "还差测试。\nGOAL_STATUS: continue");
    await waitFor(() => fixture.state.runtimeGoal(applied.targetSessionId!)!.continuations === 2, "continuation 2");
    expect(fixture.hermes.turns).toHaveLength(4);

    // Continuation cap blocks instead of looping forever.
    fixture.hermes.completeTurn(hermesNative, "仍在进行。\nGOAL_STATUS: continue");
    await waitFor(
      () => fixture.state.runtimeGoal(applied.targetSessionId!)!.status === "blocked",
      "blocked at cap",
    );
    expect(fixture.hermes.turns).toHaveLength(4);
    expect(fixture.state.runtimeGoal(applied.targetSessionId!)!.detail).toContain("上限");

    // Resume kicks the loop again.
    await fixture.service.resumeGoal(applied.targetSessionId!);
    expect(fixture.hermes.turns).toHaveLength(5);
    expect(fixture.state.runtimeGoal(applied.targetSessionId!)!.status).toBe("active");

    fixture.hermes.completeTurn(hermesNative, "全部完成。\nGOAL_STATUS: done");
    await waitFor(
      () => fixture.state.runtimeGoal(applied.targetSessionId!)!.status === "complete",
      "complete",
    );
  });

  it("surfaces blocked markers with detail", async () => {
    const fixture = await createFixture();
    seedClaudeSource(fixture);
    const preview = await fixture.service.preview({
      sessionId: CLAUDE_SOURCE,
      targetRuntimeId: "hermes-desktop",
    });
    const { handoff } = await fixture.service.commit({ handoffId: preview.handoff.handoffId });
    const hermesNative = handoff.targetNativeSessionId!;
    fixture.hermes.completeTurn(hermesNative, "计划文本");
    await waitFor(() => fixture.service.get(handoff.handoffId).state === "plan-ready", "plan-ready");
    const { handoff: applied } = await fixture.service.confirm({ handoffId: handoff.handoffId });
    fixture.hermes.completeTurn(hermesNative, "依赖装不上。\nGOAL_STATUS: blocked: 网络不可用");
    await waitFor(
      () => fixture.state.runtimeGoal(applied.targetSessionId!)!.status === "blocked",
      "blocked",
    );
    expect(fixture.state.runtimeGoal(applied.targetSessionId!)!.detail).toContain("网络不可用");
    expect(fixture.hermes.turns).toHaveLength(2);
  });

  it("pauses on user stop and never fights it; resume restarts the loop", async () => {
    const fixture = await createFixture();
    seedClaudeSource(fixture);
    const preview = await fixture.service.preview({
      sessionId: CLAUDE_SOURCE,
      targetRuntimeId: "hermes-desktop",
    });
    const { handoff } = await fixture.service.commit({ handoffId: preview.handoff.handoffId });
    const hermesNative = handoff.targetNativeSessionId!;
    fixture.hermes.completeTurn(hermesNative, "计划文本");
    await waitFor(() => fixture.service.get(handoff.handoffId).state === "plan-ready", "plan-ready");
    const { handoff: applied } = await fixture.service.confirm({ handoffId: handoff.handoffId });
    const targetSessionId = applied.targetSessionId!;

    await fixture.service.pauseGoal(targetSessionId);
    expect(fixture.state.runtimeGoal(targetSessionId)!.status).toBe("paused");

    // A continue marker arriving while paused must not trigger a new turn.
    fixture.hermes.completeTurn(hermesNative, "中间产物\nGOAL_STATUS: continue");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fixture.hermes.turns).toHaveLength(2);
    expect(fixture.state.runtimeGoal(targetSessionId)!.status).toBe("paused");

    await fixture.service.resumeGoal(targetSessionId);
    expect(fixture.state.runtimeGoal(targetSessionId)!.status).toBe("active");
    expect(fixture.hermes.turns).toHaveLength(3);

    // Simulated turn.interrupted event pauses the goal (user stop path).
    await fixture.eventLog.append({
      sessionId: targetSessionId,
      origin: "hermes-host",
      type: "turn.interrupted",
      data: {},
    });
    await waitFor(() => fixture.state.runtimeGoal(targetSessionId)!.status === "paused", "paused on interrupt");
  });

  it("mirrors native Codex goal notifications", async () => {
    const fixture = await createFixture();
    seedClaudeSource(fixture);
    const preview = await fixture.service.preview({
      sessionId: CLAUDE_SOURCE,
      targetRuntimeId: "codex-desktop",
    });
    const { handoff } = await fixture.service.commit({ handoffId: preview.handoff.handoffId });
    const codexNative = handoff.targetNativeSessionId!;
    fixture.codex.completeTurn(codexNative, "计划文本");
    await waitFor(() => fixture.service.get(handoff.handoffId).state === "plan-ready", "plan-ready");
    const { handoff: applied } = await fixture.service.confirm({ handoffId: handoff.handoffId });
    const targetSessionId = applied.targetSessionId!;

    fixture.codex.publish({
      type: "goal.updated",
      nativeSessionId: codexNative,
      goal: { objective: "目标", status: "blocked", detail: "usageLimited", updatedAt: Date.now() },
    });
    await waitFor(() => fixture.state.runtimeGoal(targetSessionId)!.status === "blocked", "native blocked");

    fixture.codex.publish({ type: "goal.cleared", nativeSessionId: codexNative, at: Date.now() });
    // Cleared while blocked (already terminal-ish) keeps status; cleared while active completes.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fixture.state.runtimeGoal(targetSessionId)!.status).toBe("blocked");

    fixture.codex.publish({
      type: "goal.updated",
      nativeSessionId: codexNative,
      goal: { objective: "目标", status: "active", updatedAt: Date.now() },
    });
    await waitFor(() => fixture.state.runtimeGoal(targetSessionId)!.status === "active", "native active");
    fixture.codex.publish({ type: "goal.cleared", nativeSessionId: codexNative, at: Date.now() });
    await waitFor(() => fixture.state.runtimeGoal(targetSessionId)!.status === "complete", "native complete");
  });

  it("falls back to emulated goals when the target rejects native goal RPCs", async () => {
    const fixture = await createFixture();
    seedClaudeSource(fixture);
    fixture.codex.goalUnsupported = true;
    const preview = await fixture.service.preview({
      sessionId: CLAUDE_SOURCE,
      targetRuntimeId: "codex-desktop",
    });
    const { handoff } = await fixture.service.commit({ handoffId: preview.handoff.handoffId });
    const codexNative = handoff.targetNativeSessionId!;
    fixture.codex.completeTurn(codexNative, "计划文本");
    await waitFor(() => fixture.service.get(handoff.handoffId).state === "plan-ready", "plan-ready");
    const { goal } = await fixture.service.confirm({ handoffId: handoff.handoffId });
    expect(goal.native).toBe(false);
    expect(fixture.codex.turns[1]!.text).toContain("GOAL_STATUS");
  });

  it("supports cancel at preview and planning, but not after applying", async () => {
    const fixture = await createFixture();
    seedClaudeSource(fixture);
    const preview = await fixture.service.preview({
      sessionId: CLAUDE_SOURCE,
      targetRuntimeId: "codex-desktop",
    });
    const { handoff: cancelledPreview } = await fixture.service.cancel(preview.handoff.handoffId);
    expect(cancelledPreview.state).toBe("cancelled");

    const second = await fixture.service.preview({
      sessionId: CLAUDE_SOURCE,
      targetRuntimeId: "codex-desktop",
    });
    const { handoff } = await fixture.service.commit({ handoffId: second.handoff.handoffId });
    const { handoff: cancelledPlanning } = await fixture.service.cancel(handoff.handoffId);
    expect(cancelledPlanning.state).toBe("cancelled");
    expect(fixture.codex.interrupts).toEqual([handoff.targetNativeSessionId!]);

    const third = await fixture.service.preview({
      sessionId: CLAUDE_SOURCE,
      targetRuntimeId: "codex-desktop",
    });
    const { handoff: thirdCommitted } = await fixture.service.commit({ handoffId: third.handoff.handoffId });
    fixture.codex.completeTurn(thirdCommitted.targetNativeSessionId!, "计划文本");
    await waitFor(() => fixture.service.get(thirdCommitted.handoffId).state === "plan-ready", "plan-ready");
    const { handoff: applied } = await fixture.service.confirm({ handoffId: thirdCommitted.handoffId });
    await expect(fixture.service.cancel(applied.handoffId)).rejects.toThrow("执行阶段");
  });

  it("recovers from a restart: planning recovers to plan-ready, executing to applied, preparing fails", async () => {
    const fixture = await createFixture();
    seedClaudeSource(fixture);
    const preview = await fixture.service.preview({
      sessionId: CLAUDE_SOURCE,
      targetRuntimeId: "codex-desktop",
    });
    const { handoff } = await fixture.service.commit({ handoffId: preview.handoff.handoffId });
    // Simulate the plan finishing while Bridge was down: history has the plan
    // but no turn.completed event was processed.
    const codexNative = handoff.targetNativeSessionId!;
    const items = fixture.codex.historyMap.get(codexNative)!;
    items.push({ id: "plan", role: "assistant", text: "重启期间完成的计划", createdAt: Date.now() });
    fixture.codex.sessionMap.get(codexNative)!.turnState = "idle";
    fixture.codex.publish({
      type: "session.updated",
      session: { ...fixture.codex.sessionMap.get(codexNative)! },
    });
    await waitFor(
      () => fixture.runtimeSessions.session(handoff.targetSessionId!)?.turnState === "idle",
      "target idle visible",
    );

    fixture.state.saveRuntimeHandoff({ ...handoff, state: "planning", updatedAt: Date.now() });
    await fixture.service.close();

    // Restart recovery: a fresh service over the same store and live runtime
    // plumbing picks up in-flight handoffs without re-sending anything.
    const recovered = new RuntimeHandoffService({
      state: fixture.state,
      broker: fixture.broker as unknown as SessionBroker,
      eventLog: fixture.eventLog,
      evidence: { list: () => ({ items: [] }) } as unknown as EvidenceManager,
      runtimeRegistry: fixture.registry,
      runtimeSessions: fixture.runtimeSessions,
    });
    // planning recovery reads the target history and lands on plan-ready.
    await (recovered as unknown as { recoverHandoff(h: unknown): Promise<void> })
      .recoverHandoff(fixture.state.runtimeHandoff(handoff.handoffId));
    expect(fixture.service.get(handoff.handoffId).state).toBe("plan-ready");
    expect(fixture.service.get(handoff.handoffId).planText).toContain("重启期间完成的计划");

    fixture.state.saveRuntimeHandoff({
      ...fixture.service.get(handoff.handoffId),
      state: "preparing",
      updatedAt: Date.now(),
    });
    await (recovered as unknown as { recoverHandoff(h: unknown): Promise<void> })
      .recoverHandoff(fixture.state.runtimeHandoff(handoff.handoffId));
    expect(fixture.service.get(handoff.handoffId).state).toBe("failed");
  });
});
