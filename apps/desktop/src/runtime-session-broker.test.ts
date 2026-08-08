import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BridgeDesktopRuntimeId, BridgePermissionDecision } from "@bridge/protocol";
import { SessionEventLog } from "./session-event-log.js";
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
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

class FakeRuntimeAdapter extends DesktopRuntimeAdapter {
  readonly turnInputs: RuntimeAdapterTurnInput[] = [];
  readonly resolved: Array<{ requestId: string; decision: BridgePermissionDecision }> = [];
  private readonly rows = new Map<string, RuntimeAdapterSession>();

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
    return [{ id: `history:${nativeSessionId}`, role: "assistant", text: this.id, createdAt: 3 }];
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
    await expect(broker.history(codexSessionId)).resolves.toMatchObject({
      sessionId: codexSessionId,
      items: [{ role: "assistant", text: "codex-desktop" }],
    });

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
});
