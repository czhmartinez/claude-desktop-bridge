import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  CodexAppServerAdapter,
  type CodexRpcClient,
} from "./codex-app-server-adapter.js";

class FakeCodexClient extends EventEmitter implements CodexRpcClient {
  readonly requests: Array<{ method: string; params?: unknown }> = [];
  readonly responses: Array<{ id: string | number; result: unknown }> = [];
  goal: Record<string, unknown> | undefined;
  unsupportedMethods = new Set<string>();
  readonly listedThreads: Array<Record<string, unknown>> = [{
    id: "thread-1",
    cwd: "/workspace/codex",
    name: "Existing task",
    createdAt: 1,
    updatedAt: 2,
    status: { type: "idle" },
  }];
  readonly noRollout = new Set<string>();
  private nextThreadId = 0;
  private settings = {
    model: "gpt-5.6-terra",
    provider: "custom",
    effort: "medium",
    serviceTier: "default",
  };

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, ...(params === undefined ? {} : { params }) });
    if (this.unsupportedMethods.has(method)) {
      throw new Error(`Unknown method: ${method}`);
    }
    if (method === "initialize") return { userAgent: "codex-test" } as T;
    if (method === "thread/list") {
      return { data: [...this.listedThreads] } as T;
    }
    if (method === "thread/start") {
      const options = (params ?? {}) as Record<string, unknown>;
      const id = `thread-new-${++this.nextThreadId}`;
      this.noRollout.add(id);
      return {
        thread: {
          id,
          cwd: typeof options.cwd === "string" ? options.cwd : "/workspace/codex",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          status: { type: "idle" },
        },
      } as T;
    }
    if (method === "model/list") {
      return {
        data: [{
          id: "terra",
          model: "gpt-5.6-terra",
          displayName: "GPT-5.6 Terra",
          description: "Codex test model",
          supportedReasoningEfforts: ["low", "medium", "high"].map((reasoningEffort) => ({ reasoningEffort, description: reasoningEffort })),
          serviceTiers: [{ id: "priority", name: "Fast", description: "Fast" }],
        }],
      } as T;
    }
    if (method === "thread/resume") {
      const options = (params ?? {}) as Record<string, unknown>;
      const threadId = typeof options.threadId === "string" ? options.threadId : "thread-1";
      if (this.noRollout.has(threadId)) {
        throw new Error(`no rollout found for thread id ${threadId}`);
      }
      if (typeof options.model === "string") this.settings.model = options.model;
      if ("modelProvider" in options) this.settings.provider = typeof options.modelProvider === "string" ? options.modelProvider : "custom";
      if ("serviceTier" in options) this.settings.serviceTier = typeof options.serviceTier === "string" ? options.serviceTier : "default";
      return {
        thread: { id: threadId },
        model: this.settings.model,
        modelProvider: this.settings.provider,
        reasoningEffort: this.settings.effort,
        serviceTier: this.settings.serviceTier,
      } as T;
    }
    if (method === "thread/settings/update") {
      const options = (params ?? {}) as Record<string, unknown>;
      if (typeof options.model === "string") this.settings.model = options.model;
      if ("effort" in options) this.settings.effort = typeof options.effort === "string" ? options.effort : "medium";
      if ("serviceTier" in options) this.settings.serviceTier = typeof options.serviceTier === "string" ? options.serviceTier : "default";
      return {} as T;
    }
    if (method === "turn/start") {
      const options = (params ?? {}) as Record<string, unknown>;
      const threadId = typeof options.threadId === "string" ? options.threadId : "thread-1";
      // The first turn persists the rollout, after which the thread lists.
      this.noRollout.delete(threadId);
      if (!this.listedThreads.some((thread) => thread.id === threadId)) {
        this.listedThreads.push({ id: threadId, cwd: "/workspace/codex", createdAt: 3, updatedAt: 4, status: { type: "idle" } });
      }
      return { turn: { id: "turn-1" } } as T;
    }
    if (method === "thread/read") {
      const options = (params ?? {}) as Record<string, unknown>;
      const threadId = typeof options.threadId === "string" ? options.threadId : "thread-1";
      if (this.noRollout.has(threadId)) {
        throw new Error(`thread ${threadId} is not materialized yet; includeTurns is unavailable before first user message`);
      }
      return { thread: { turns: [] } } as T;
    }
    if (method === "thread/goal/set") {
      const options = (params ?? {}) as Record<string, unknown>;
      this.goal = {
        threadId: options.threadId,
        objective: typeof options.objective === "string" ? options.objective : this.goal?.objective,
        status: typeof options.status === "string" ? options.status : "active",
        tokensUsed: 0,
        timeUsedSeconds: 0,
        updatedAt: Date.now(),
      };
      return {} as T;
    }
    if (method === "thread/goal/get") {
      return { goal: this.goal ?? null } as T;
    }
    return {} as T;
  }

  async respond(id: string | number, result: unknown): Promise<void> {
    this.responses.push({ id, result });
  }

  async fail(): Promise<void> {}

  async close(): Promise<void> {}
}

describe("CodexAppServerAdapter", () => {
  it("normalizes Codex threads and returns remote approval decisions over app-server", async () => {
    const client = new FakeCodexClient();
    const adapter = new CodexAppServerAdapter({
      findExecutable: async () => "/test/codex",
      clientFactory: async () => client,
    });
    const events: unknown[] = [];
    adapter.on("event", (event) => events.push(event));

    await adapter.initialize();
    expect(adapter.status()).toMatchObject({ state: "ready", sessionCount: 1, appVersion: "codex-test" });
    expect(adapter.sessions()).toEqual([
      expect.objectContaining({ nativeSessionId: "thread-1", transport: "codex-app-server" }),
    ]);

    const started = await adapter.startTurn({
      nativeSessionId: "thread-1",
      text: "Review this change",
      commandId: "command-1",
      requestId: "request-1",
    });
    expect(started).toEqual({ turnId: "turn-1", state: "running" });
    expect(client.requests.find((entry) => entry.method === "turn/start")).toMatchObject({
      params: {
        threadId: "thread-1",
        clientUserMessageId: "request-1",
        input: [{ type: "text", text: "Review this change", text_elements: [] }],
      },
    });

    client.emit("request", {
      id: 42,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "thread-1",
        itemId: "command-item-1",
        command: "git status",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const permission = events.find((event) => (
      typeof event === "object" && event !== null && (event as { type?: string }).type === "permission.requested"
    )) as { permission: { requestId: string } } | undefined;
    expect(permission?.permission.requestId).toBe("42");

    await expect(adapter.resolvePermission("42", "allow-once")).resolves.toBe(true);
    expect(client.responses).toContainEqual({ id: 42, result: { decision: "accept" } });

    await adapter.close();
  });

  it("sends native model, provider, effort and fast settings to the next Codex turn", async () => {
    const client = new FakeCodexClient();
    const adapter = new CodexAppServerAdapter({
      findExecutable: async () => "/test/codex",
      clientFactory: async () => client,
    });

    await adapter.initialize();
    await expect(adapter.configuration("thread-1")).resolves.toMatchObject({
      model: "gpt-5.6-terra",
      provider: "custom",
      reasoningEffort: "medium",
      fast: false,
      supportsFastMode: true,
      availableModels: [expect.objectContaining({ value: "gpt-5.6-terra", supportsFast: true })],
    });

    await expect(adapter.configureSession("thread-1", {
      model: "gpt-5.6-terra",
      provider: "codex",
      reasoningEffort: "high",
      fast: true,
    })).resolves.toMatchObject({
      model: "gpt-5.6-terra",
      provider: "codex",
      reasoningEffort: "high",
      fast: true,
    });

    const resume = client.requests.find((entry) => (
      entry.method === "thread/resume"
      && typeof entry.params === "object"
      && entry.params !== null
      && "modelProvider" in entry.params
    ));
    expect(resume).toMatchObject({
      params: expect.objectContaining({
        model: "gpt-5.6-terra",
        modelProvider: "codex",
        serviceTier: "priority",
      }),
    });
    expect(client.requests.find((entry) => entry.method === "thread/settings/update")).toMatchObject({
      params: expect.objectContaining({
        threadId: "thread-1",
        model: "gpt-5.6-terra",
        effort: "high",
        serviceTier: "priority",
      }),
    });

    await adapter.startTurn({
      nativeSessionId: "thread-1",
      text: "Use the selected settings",
      commandId: "command-settings",
      requestId: "request-settings",
    });
    expect(client.requests.find((entry) => entry.method === "turn/start")).toMatchObject({
      params: expect.objectContaining({
        model: "gpt-5.6-terra",
        effort: "high",
        serviceTier: "priority",
      }),
    });

    await adapter.close();
  });

  it("accepts settings updates initiated by Codex Desktop", async () => {
    const client = new FakeCodexClient();
    const adapter = new CodexAppServerAdapter({
      findExecutable: async () => "/test/codex",
      clientFactory: async () => client,
    });

    await adapter.initialize();
    client.emit("notification", {
      method: "thread/settings/updated",
      params: {
        threadId: "thread-1",
        threadSettings: {
          model: "gpt-5.6-terra",
          modelProvider: "codex",
          effort: "high",
          serviceTier: "priority",
        },
      },
    });
    expect(adapter.sessions()).toEqual([
      expect.objectContaining({
        nativeSessionId: "thread-1",
        model: "gpt-5.6-terra",
        provider: "codex",
        reasoningEffort: "high",
        fast: true,
      }),
    ]);

    client.emit("notification", {
      method: "thread/settings/updated",
      params: {
        threadId: "thread-1",
        threadSettings: {
          model: "gpt-5.6-terra",
          modelProvider: "codex",
          effort: null,
          serviceTier: null,
        },
      },
    });
    expect(adapter.sessions()[0]).toMatchObject({ nativeSessionId: "thread-1" });
    expect(adapter.sessions()[0]).not.toHaveProperty("reasoningEffort");
    expect(adapter.sessions()[0]).not.toHaveProperty("fast");

    await adapter.close();
  });

  it("drives native plan mode and goals, translating goal notifications", async () => {
    const client = new FakeCodexClient();
    const adapter = new CodexAppServerAdapter({
      findExecutable: async () => "/test/codex",
      clientFactory: async () => client,
    });
    const events: Array<{ type: string; goal?: { status: string; detail?: string } }> = [];
    adapter.on("event", (event) => events.push(event));
    await adapter.initialize();
    expect(adapter.status().capabilities).toContain("goal.native");

    expect(await adapter.setCollaborationMode("thread-1", "plan")).toBe(true);
    const planUpdate = client.requests.find((request) => (
      request.method === "thread/settings/update" &&
      Boolean((request.params as Record<string, unknown>).collaborationMode)
    ));
    expect(planUpdate?.params).toMatchObject({
      threadId: "thread-1",
      collaborationMode: {
        mode: "plan",
        settings: { developer_instructions: null },
      },
    });
    expect(await adapter.setCollaborationMode("thread-1", "default")).toBe(true);

    expect(await adapter.goalSet("thread-1", "完成接力目标")).toBe(true);
    expect(client.goal).toMatchObject({ threadId: "thread-1", objective: "完成接力目标", status: "active" });

    client.goal = { ...client.goal!, status: "usageLimited", updatedAt: 42 };
    expect(await adapter.goalGet("thread-1")).toMatchObject({
      objective: "完成接力目标",
      status: "blocked",
      detail: "usageLimited",
    });

    expect(await adapter.goalPause("thread-1")).toBe(true);
    expect(client.goal).toMatchObject({ status: "paused" });
    expect(await adapter.goalResume("thread-1")).toBe(true);
    expect(client.goal).toMatchObject({ status: "active" });

    client.emit("notification", {
      method: "thread/goal/updated",
      params: {
        threadId: "thread-1",
        turnId: null,
        goal: { threadId: "thread-1", objective: "完成接力目标", status: "complete", updatedAt: 43 },
      },
    });
    client.emit("notification", {
      method: "thread/goal/cleared",
      params: { threadId: "thread-1" },
    });
    expect(events.filter((event) => event.type === "goal.updated")).toEqual([
      expect.objectContaining({ goal: expect.objectContaining({ status: "complete" }) }),
    ]);
    expect(events.some((event) => event.type === "goal.cleared")).toBe(true);

    await adapter.close();
  });

  it("falls back when the app-server does not know plan/goal methods", async () => {
    const client = new FakeCodexClient();
    client.unsupportedMethods.add("thread/goal/set").add("thread/goal/get");
    const adapter = new CodexAppServerAdapter({
      findExecutable: async () => "/test/codex",
      clientFactory: async () => client,
    });
    await adapter.initialize();
    expect(await adapter.goalSet("thread-1", "目标")).toBe(false);
    expect(await adapter.goalGet("thread-1")).toBeUndefined();
    expect(await adapter.goalPause("thread-1")).toBe(false);
    await adapter.close();
  });

  it("keeps just-created threads usable before the app-server materializes them", async () => {
    const client = new FakeCodexClient();
    const adapter = new CodexAppServerAdapter({
      findExecutable: async () => "/test/codex",
      clientFactory: async () => client,
    });
    await adapter.initialize();

    const created = await adapter.createSession({ cwd: "/workspace/codex", title: "手机新建" });
    expect(created.nativeSessionId).toBe("thread-new-1");

    // The app-server does not list unmaterialized threads; a refresh must not
    // drop the session Bridge just created.
    await adapter.refresh();
    expect(adapter.sessions().map((session) => session.nativeSessionId)).toContain("thread-new-1");

    // Reading history must not call thread/read (which rejects unmaterialized
    // threads); it resolves to an empty history instead.
    const before = client.requests.length;
    await expect(adapter.history("thread-new-1")).resolves.toEqual([]);
    expect(client.requests.slice(before).some((entry) => entry.method === "thread/read")).toBe(false);

    // The first turn skips thread/resume and thread/settings/update, both of
    // which reject threads without a rollout, and goes straight to turn/start.
    await expect(adapter.startTurn({
      nativeSessionId: "thread-new-1",
      text: "第一条指令",
      commandId: "command-new",
      requestId: "request-new",
    })).resolves.toEqual({ turnId: "turn-1", state: "running" });
    const turnStartIndex = client.requests.findIndex((entry) => entry.method === "turn/start" && (
      (entry.params as Record<string, unknown>).threadId === "thread-new-1"
    ));
    expect(turnStartIndex).toBeGreaterThanOrEqual(0);
    expect(client.requests.slice(0, turnStartIndex).some((entry) => (
      (entry.method === "thread/resume" || entry.method === "thread/settings/update")
      && (entry.params as Record<string, unknown>).threadId === "thread-new-1"
    ))).toBe(false);

    // After the first turn the rollout exists: the thread lists normally and
    // later operations use the standard resume path again.
    await adapter.refresh();
    expect(adapter.sessions().map((session) => session.nativeSessionId)).toContain("thread-new-1");
    await adapter.history("thread-new-1");
    expect(client.requests.some((entry) => (
      entry.method === "thread/read"
      && (entry.params as Record<string, unknown>).threadId === "thread-new-1"
    ))).toBe(true);

    await adapter.close();
  });

  it("treats an unexpected not-materialized read as an empty history", async () => {
    const client = new FakeCodexClient();
    const adapter = new CodexAppServerAdapter({
      findExecutable: async () => "/test/codex",
      clientFactory: async () => client,
    });
    await adapter.initialize();
    // Simulate a thread the adapter believes is materialized (e.g. discovered
    // from a stale list) whose rollout was never written.
    client.noRollout.add("thread-1");
    await expect(adapter.history("thread-1")).resolves.toEqual([]);
    await adapter.close();
  });
});
