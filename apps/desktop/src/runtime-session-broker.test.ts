import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BridgeDesktopRuntimeId, BridgePermissionDecision } from "@bridge/protocol";
import { SessionEventLog } from "./session-event-log.js";
import { ConversationStateStore } from "./conversation-state-store.js";
import {
  DesktopRuntimeAdapter,
  RuntimeAdapterRegistry,
  type RuntimeAdapterHistoryItem,
  type RuntimeAdapterConfiguration,
  type RuntimeAdapterConfigurationChange,
  type RuntimeAdapterSession,
  type RuntimeAdapterTurnInput,
  type RuntimeAdapterTurnResult,
} from "./runtime-adapter.js";
import { RuntimeSessionBroker, runtimeSessionId } from "./runtime-session-broker.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  )));
});

async function waitFor(check: () => boolean, label = "condition"): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

class FakeRuntimeAdapter extends DesktopRuntimeAdapter {
  readonly turnInputs: RuntimeAdapterTurnInput[] = [];
  readonly resolved: Array<{ requestId: string; decision: BridgePermissionDecision }> = [];
  private readonly rows = new Map<string, RuntimeAdapterSession>();
  private readonly historyRows = new Map<string, RuntimeAdapterHistoryItem[]>();

  constructor(id: Exclude<BridgeDesktopRuntimeId, "claude-desktop">, nativeSessionId: string) {
    super(id, id === "codex-desktop" ? "Codex Desktop" : "Hermes Desktop", [
      "session.list",
      "session.create",
      "session.history",
      "session.configure",
      "turn.start",
      "turn.steer",
      "turn.interrupt",
      "permission.resolve",
      "tool.events",
    ]);
    this.rows.set(nativeSessionId, {
      nativeSessionId,
      cwd: "/workspace/shared",
      title: `${id} task`,
      source: "desktop",
      createdAt: 1,
      lastActivityAt: 2,
      turnState: "idle",
      transport: id === "codex-desktop" ? "codex-app-server" : "hermes-gateway",
    });
    this.historyRows.set(nativeSessionId, []);
  }

  async initialize(): Promise<void> {
    this.setStatus("ready", "Ready", { sessionCount: this.rows.size });
  }

  async refresh(): Promise<void> {}

  sessions(): RuntimeAdapterSession[] {
    return [...this.rows.values()].map((session) => ({ ...session }));
  }

  async createSession(input: { cwd: string; title?: string }): Promise<RuntimeAdapterSession> {
    const nativeSessionId = `${this.id}-created`;
    const session: RuntimeAdapterSession = {
      nativeSessionId,
      cwd: input.cwd,
      title: input.title ?? "Untitled",
      source: "bridge",
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      turnState: "idle",
      transport: this.id === "codex-desktop" ? "codex-app-server" : "hermes-gateway",
    };
    this.rows.set(nativeSessionId, session);
    return { ...session };
  }

  async history(nativeSessionId: string): Promise<RuntimeAdapterHistoryItem[]> {
    return (this.historyRows.get(nativeSessionId) ?? []).map((item) => ({ ...item }));
  }

  async configuration(nativeSessionId: string): Promise<RuntimeAdapterConfiguration> {
    const session = this.rows.get(nativeSessionId);
    if (!session) throw new Error("Session not found");
    return {
      ...(session.provider ? { provider: session.provider } : {}),
      ...(session.model ? { model: session.model } : {}),
      availableModels: [],
      availableProviders: [],
      availableReasoningEfforts: [],
      modelsComplete: true,
      supportsFastMode: false,
      appliesAfterTurn: false,
    };
  }

  async configureSession(
    nativeSessionId: string,
    change: RuntimeAdapterConfigurationChange,
  ): Promise<RuntimeAdapterConfiguration> {
    const session = this.rows.get(nativeSessionId);
    if (!session) throw new Error("Session not found");
    if (change.model) session.model = change.model;
    if (change.provider) session.provider = change.provider;
    this.rows.set(nativeSessionId, session);
    return this.configuration(nativeSessionId);
  }

  async startTurn(input: RuntimeAdapterTurnInput): Promise<RuntimeAdapterTurnResult> {
    this.turnInputs.push(input);
    return { turnId: `${this.id}:turn`, state: "running" };
  }

  async steerTurn(input: RuntimeAdapterTurnInput): Promise<RuntimeAdapterTurnResult> {
    return this.startTurn(input);
  }

  async interruptTurn(): Promise<boolean> {
    return true;
  }

  async resolvePermission(requestId: string, decision: BridgePermissionDecision): Promise<boolean> {
    this.resolved.push({ requestId, decision });
    return true;
  }

  async close(): Promise<void> {}

  requestPermission(nativeSessionId: string, requestId: string): void {
    this.emitRuntimeEvent({
      type: "permission.requested",
      permission: {
        requestId,
        nativeSessionId,
        toolUseId: `${requestId}:tool`,
        toolName: "Command",
        input: { command: "pwd" },
        createdAt: Date.now(),
        canAllowAlways: true,
      },
    });
  }

  requestQuestion(nativeSessionId: string, requestId: string): void {
    this.emitRuntimeEvent({
      type: "permission.requested",
      permission: {
        requestId,
        nativeSessionId,
        toolUseId: requestId,
        toolName: "AskUserQuestion",
        input: { questions: [] },
        createdAt: Date.now(),
        canAllowAlways: false,
        question: true,
      },
    });
  }

  setHistory(nativeSessionId: string, items: RuntimeAdapterHistoryItem[]): void {
    this.historyRows.set(nativeSessionId, items.map((item) => ({ ...item })));
  }

  updateSession(nativeSessionId: string, change: Partial<RuntimeAdapterSession>): void {
    const session = this.rows.get(nativeSessionId);
    if (!session) throw new Error("Session not found");
    const next = { ...session, ...change };
    this.rows.set(nativeSessionId, next);
    this.emitRuntimeEvent({ type: "session.updated", session: { ...next } });
  }

  emitAssistantDelta(nativeSessionId: string, turnId: string, text: string): void {
    this.emitRuntimeEvent({
      type: "assistant.delta",
      nativeSessionId,
      turnId,
      itemId: `${turnId}:stream`,
      text,
      at: Date.now(),
    });
  }

  mutateSilently(nativeSessionId: string, change: Partial<RuntimeAdapterSession>): void {
    const session = this.rows.get(nativeSessionId);
    if (!session) throw new Error("Session not found");
    this.rows.set(nativeSessionId, { ...session, ...change });
  }
}

describe("RuntimeSessionBroker", () => {
  it("keeps identical native session IDs isolated by Desktop runtime", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-runtime-broker-"));
    directories.push(directory);
    const codex = new FakeRuntimeAdapter("codex-desktop", "same-native-id");
    const hermes = new FakeRuntimeAdapter("hermes-desktop", "same-native-id");
    const broker = new RuntimeSessionBroker(
      new RuntimeAdapterRegistry([codex, hermes]),
      new SessionEventLog(join(directory, "events.jsonl"), 1),
    );

    await broker.initialize();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(broker.listSessions()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sessionId: runtimeSessionId("codex-desktop", "same-native-id"),
        runtimeId: "codex-desktop",
        nativeSessionId: "same-native-id",
      }),
      expect.objectContaining({
        sessionId: runtimeSessionId("hermes-desktop", "same-native-id"),
        runtimeId: "hermes-desktop",
        nativeSessionId: "same-native-id",
      }),
    ]));
    expect(broker.listProjects()).toHaveLength(2);

    const codexSessionId = runtimeSessionId("codex-desktop", "same-native-id");
    await expect(broker.configuration(codexSessionId)).resolves.toMatchObject({
      sessionId: codexSessionId,
      availableModels: [],
    });
    expect(broker.session(codexSessionId)?.allowedActions?.canConfigure).toBe(true);
    await expect(broker.configureSession(codexSessionId, {
      model: "gpt-test",
      provider: "codex",
      reasoningEffort: "high",
      fast: true,
    })).resolves.toMatchObject({ model: "gpt-test", provider: "codex" });

    await broker.startTurn({
      sessionId: codexSessionId,
      text: "Inspect the repository",
      commandId: "command-1",
      requestId: "request-1",
    });
    expect(codex.turnInputs).toHaveLength(1);
    expect(hermes.turnInputs).toHaveLength(0);
    await expect(broker.history(codexSessionId)).resolves.toMatchObject({ sessionId: codexSessionId, items: [] });

    codex.requestPermission("same-native-id", "approval-1");
    await new Promise((resolve) => setTimeout(resolve, 10));
    const permission = broker.listPermissions()[0];
    expect(permission).toMatchObject({
      requestId: "codex-desktop:approval-1",
      sessionId: codexSessionId,
    });
    await expect(broker.resolvePermission(permission!.requestId, "allow-once")).resolves.toBe(true);
    expect(codex.resolved).toEqual([{ requestId: "approval-1", decision: "allow-once" }]);
    expect(hermes.resolved).toEqual([]);

    await broker.close();
  });

  it("publishes native history and session updates without an explicit client refresh", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-runtime-live-sync-"));
    directories.push(directory);
    const codex = new FakeRuntimeAdapter("codex-desktop", "native-live");
    const eventLog = new SessionEventLog(join(directory, "events.jsonl"), 1);
    const broker = new RuntimeSessionBroker(
      new RuntimeAdapterRegistry([codex]),
      eventLog,
      undefined,
      { liveSyncIntervalMs: 60_000 },
    );
    await broker.initialize();
    const sessionId = runtimeSessionId("codex-desktop", "native-live");
    const received: string[] = [];
    eventLog.on("event", (event) => received.push(event.type));

    codex.setHistory("native-live", [{
      id: "native-message-1",
      turnId: "native-turn-1",
      role: "assistant",
      text: "来自 Codex Desktop 的最新内容",
      createdAt: 10,
    }]);
    codex.updateSession("native-live", {
      turnState: "running",
      activeTurnId: "native-turn-1",
      lastActivityAt: 10,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await broker.syncLiveHistories();

    expect(received).toContain("runtime.updated");
    expect(eventLog.replay().filter((event) => event.sessionId === sessionId)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "session.observed",
        itemId: "native-message-1",
        data: expect.objectContaining({ text: "来自 Codex Desktop 的最新内容" }),
      }),
    ]));

    await broker.syncLiveHistories();
    expect(eventLog.replay().filter((event) => event.itemId === "native-message-1")).toHaveLength(1);
    await broker.close();
  });

  it("discovers a native-only update without an adapter notification", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-runtime-silent-sync-"));
    directories.push(directory);
    const codex = new FakeRuntimeAdapter("codex-desktop", "native-silent");
    const eventLog = new SessionEventLog(join(directory, "events.jsonl"), 1);
    const broker = new RuntimeSessionBroker(
      new RuntimeAdapterRegistry([codex]),
      eventLog,
      undefined,
      { liveSyncIntervalMs: 60_000 },
    );
    await broker.initialize();
    const sessionId = runtimeSessionId("codex-desktop", "native-silent");

    codex.setHistory("native-silent", [{
      id: "native-silent-message",
      turnId: "native-silent-turn",
      role: "assistant",
      text: "没有主动通知的原生更新",
      createdAt: 20,
    }]);
    codex.mutateSilently("native-silent", {
      title: "Native-only update",
      turnState: "running",
      activeTurnId: "native-silent-turn",
      lastActivityAt: 20,
    });
    await broker.refreshDiscoveredSessions();
    await broker.syncLiveHistories();

    expect(eventLog.replay().filter((event) => event.sessionId === sessionId)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "runtime.updated",
        data: expect.objectContaining({ session: expect.objectContaining({ title: "Native-only update" }) }),
      }),
      expect.objectContaining({
        type: "session.observed",
        itemId: "native-silent-message",
        data: expect.objectContaining({ text: "没有主动通知的原生更新" }),
      }),
    ]));
    await broker.close();
  });

  it("waits for an active native stream to finish before importing its final history", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-runtime-stream-history-"));
    directories.push(directory);
    const codex = new FakeRuntimeAdapter("codex-desktop", "native-stream");
    const eventLog = new SessionEventLog(join(directory, "events.jsonl"), 1);
    const broker = new RuntimeSessionBroker(
      new RuntimeAdapterRegistry([codex]),
      eventLog,
      undefined,
      { liveSyncIntervalMs: 60_000 },
    );
    await broker.initialize();
    const sessionId = runtimeSessionId("codex-desktop", "native-stream");

    codex.setHistory("native-stream", [{
      id: "native-final-message",
      turnId: "native-stream-turn",
      role: "assistant",
      text: "完成的原生回复",
      createdAt: 30,
    }]);
    codex.updateSession("native-stream", {
      turnState: "running",
      activeTurnId: "native-stream-turn",
      lastActivityAt: 30,
    });
    codex.emitAssistantDelta("native-stream", "native-stream-turn", "完成的");
    await new Promise((resolve) => setTimeout(resolve, 10));
    await broker.syncLiveHistories();

    expect(eventLog.replay().filter((event) => event.itemId === "native-final-message")).toHaveLength(0);

    codex.mutateSilently("native-stream", {
      turnState: "idle",
      lastActivityAt: 31,
    });
    await broker.refreshDiscoveredSessions();
    await broker.syncLiveHistories();

    expect(eventLog.replay().filter((event) => event.itemId === "native-final-message")).toEqual([
      expect.objectContaining({ type: "session.observed", data: expect.objectContaining({ text: "完成的原生回复" }) }),
    ]);
    expect(eventLog.replay().filter((event) => event.type === "assistant.delta")).toHaveLength(1);
    await broker.close();
  });

  it("materializes image attachments into temp files and echoes them on the accepted event", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-runtime-images-"));
    directories.push(directory);
    const codex = new FakeRuntimeAdapter("codex-desktop", "native-1");
    const eventLog = new SessionEventLog(join(directory, "events.jsonl"), 1);
    const broker = new RuntimeSessionBroker(
      new RuntimeAdapterRegistry([codex]),
      eventLog,
    );
    await broker.initialize();
    const sessionId = runtimeSessionId("codex-desktop", "native-1");
    const imageData = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64").toString("base64");

    await broker.startTurn({
      sessionId,
      text: "看这张图",
      commandId: "command-image",
      requestId: "request-image",
      attachments: [{
        id: "attach-1",
        name: "shot.png",
        mimeType: "image/png",
        size: imageData.length,
        data: imageData,
      }],
    });

    expect(codex.turnInputs).toHaveLength(1);
    const images = codex.turnInputs[0]!.images ?? [];
    expect(images).toHaveLength(1);
    const written = await readFile(images[0]!);
    expect(written.toString("base64")).toBe(imageData);

    const accepted = eventLog.replay().find((event) => event.type === "user.message.accepted");
    expect(accepted?.data.attachments).toEqual([expect.objectContaining({
      id: "attach-1",
      name: "shot.png",
      mimeType: "image/png",
      data: imageData,
    })]);
    await broker.close();
  });

  it("exposes a standard permission policy on runtime session configuration by default", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-runtime-broker-"));
    directories.push(directory);
    const codex = new FakeRuntimeAdapter("codex-desktop", "native-1");
    const broker = new RuntimeSessionBroker(
      new RuntimeAdapterRegistry([codex]),
      new SessionEventLog(join(directory, "events.jsonl"), 1),
    );
    await broker.initialize();

    const sessionId = runtimeSessionId("codex-desktop", "native-1");
    const configuration = await broker.configuration(sessionId);
    expect(configuration.permissionPolicy).toEqual({
      hostMode: "standard",
      effectiveMode: "standard",
      source: "host",
    });

    await broker.close();
  });

  it("auto-approves non-question approvals for full-access sessions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-runtime-broker-"));
    directories.push(directory);
    const codex = new FakeRuntimeAdapter("codex-desktop", "native-1");
    const hermes = new FakeRuntimeAdapter("hermes-desktop", "native-1");
    const broker = new RuntimeSessionBroker(
      new RuntimeAdapterRegistry([codex, hermes]),
      new SessionEventLog(join(directory, "events.jsonl"), 1),
    );
    await broker.initialize();

    const codexSessionId = runtimeSessionId("codex-desktop", "native-1");
    const hermesSessionId = runtimeSessionId("hermes-desktop", "native-1");
    const configured = await broker.configurePermissionPolicy(codexSessionId, "full-access");
    expect(configured.configuration.permissionPolicy).toEqual({
      hostMode: "standard",
      sessionMode: "full-access",
      effectiveMode: "full-access",
      source: "session",
    });
    expect(configured.resolvedPending).toBe(0);

    codex.requestPermission("native-1", "auto-1");
    await waitFor(() => codex.resolved.length === 1, "codex auto-approval");
    expect(codex.resolved).toEqual([{ requestId: "auto-1", decision: "allow-once" }]);
    expect(broker.listPermissions()).toHaveLength(0);

    // Hermes stays on the standard flow: the approval waits for a human.
    hermes.requestPermission("native-1", "manual-1");
    await waitFor(() => broker.listPermissions().length === 1, "hermes pending permission");
    expect(broker.listPermissions().map((permission) => permission.sessionId)).toEqual([hermesSessionId]);
    expect(hermes.resolved).toHaveLength(0);

    // Clearing the override falls back to the runtime host default.
    const reverted = await broker.configurePermissionPolicy(codexSessionId, null);
    expect(reverted.configuration.permissionPolicy).toEqual({
      hostMode: "standard",
      effectiveMode: "standard",
      source: "host",
    });

    await broker.close();
  });

  it("never auto-approves questions, even under full-access", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-runtime-broker-"));
    directories.push(directory);
    const codex = new FakeRuntimeAdapter("codex-desktop", "native-1");
    const broker = new RuntimeSessionBroker(
      new RuntimeAdapterRegistry([codex]),
      new SessionEventLog(join(directory, "events.jsonl"), 1),
    );
    await broker.initialize();

    const sessionId = runtimeSessionId("codex-desktop", "native-1");
    await broker.configurePermissionPolicy(sessionId, "full-access");
    codex.requestQuestion("native-1", "question-1");
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(codex.resolved).toHaveLength(0);
    expect(broker.listPermissions()).toEqual([
      expect.objectContaining({ requestId: "codex-desktop:question-1", toolName: "AskUserQuestion" }),
    ]);

    await broker.close();
  });

  it("applies per-runtime host defaults and sweeps pending approvals", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-runtime-broker-"));
    directories.push(directory);
    const codex = new FakeRuntimeAdapter("codex-desktop", "native-1");
    const hermes = new FakeRuntimeAdapter("hermes-desktop", "native-1");
    const broker = new RuntimeSessionBroker(
      new RuntimeAdapterRegistry([codex, hermes]),
      new SessionEventLog(join(directory, "events.jsonl"), 1),
    );
    await broker.initialize();

    hermes.requestPermission("native-1", "pending-1");
    codex.requestPermission("native-1", "pending-2");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(broker.listPermissions()).toHaveLength(2);

    // Host default for Hermes sweeps only Hermes pendings; Codex is untouched.
    const resolved = await broker.setHostPermissionMode("hermes-desktop", "full-access");
    expect(resolved).toBe(1);
    expect(hermes.resolved).toEqual([{ requestId: "pending-1", decision: "allow-once" }]);
    expect(codex.resolved).toHaveLength(0);
    expect(broker.listPermissions().map((permission) => permission.requestId)).toEqual([
      "codex-desktop:pending-2",
    ]);

    const configuration = await broker.configuration(runtimeSessionId("hermes-desktop", "native-1"));
    expect(configuration.permissionPolicy).toEqual({
      hostMode: "full-access",
      effectiveMode: "full-access",
      source: "host",
    });

    await broker.close();
  });

  it("persists session permission overrides in the conversation state store", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-runtime-broker-"));
    directories.push(directory);
    const store = new ConversationStateStore({
      databasePath: join(directory, "state.sqlite"),
      sessionsPath: join(directory, "sessions.json"),
      queuePath: join(directory, "queue.json"),
      masterSecret: "test-secret",
    });
    await store.initialize();

    const codex = new FakeRuntimeAdapter("codex-desktop", "native-1");
    const first = new RuntimeSessionBroker(
      new RuntimeAdapterRegistry([codex]),
      new SessionEventLog(join(directory, "events.jsonl"), 1),
      store,
    );
    await first.initialize();
    const sessionId = runtimeSessionId("codex-desktop", "native-1");
    await first.configurePermissionPolicy(sessionId, "full-access");
    await first.close();

    const reopened = new RuntimeSessionBroker(
      new RuntimeAdapterRegistry([codex]),
      new SessionEventLog(join(directory, "events-2.jsonl"), 1),
      store,
    );
    await reopened.initialize();
    const configuration = await reopened.configuration(sessionId);
    expect(configuration.permissionPolicy).toEqual({
      hostMode: "standard",
      sessionMode: "full-access",
      effectiveMode: "full-access",
      source: "session",
    });
    await reopened.close();
    store.close();
  });
});
