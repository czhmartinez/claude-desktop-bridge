import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import {
  DshDesktopAdapter,
  listeningLoopbackPorts,
  type DshClientResponse,
  type DshServerFrame,
} from "./dsh-desktop-adapter.js";

class FakeDshClient extends EventEmitter {
  readonly requests: Array<{ method: string; payload?: Record<string, unknown> }> = [];
  readonly responses: DshClientResponse[] = [];
  closed = false;
  listedSessions: Array<Record<string, unknown>> = [{
    sessionId: "session-existing",
    updatedAt: 1_700_000_000_000,
    running: false,
    blank: false,
    cwd: "/workspace/dsh",
    projections: {
      asOfSeq: 10,
      values: { title: "既有 DSH 任务" },
    },
  }];
  historyEvents: Array<Record<string, unknown>> = [];
  modelsValue: Record<string, unknown> = {
    current: { provider: "deepseek-official", model: "deepseek-v4-pro", reasoningEffort: "max" },
    routable: true,
    groups: [{
      id: "deepseek-official",
      name: "DeepSeek",
      models: [{
        id: "deepseek-v4-pro",
        name: "DeepSeek-V4-Pro",
        reasoning: { efforts: [{ id: "off" }, { id: "high" }, { id: "max" }], defaultEffort: "high" },
      }],
    }],
    failures: [],
  };

  override on(event: "frame", listener: (frame: DshServerFrame) => void): this;
  override on(event: "dropped", listener: () => void): this;
  override on(event: "frame" | "dropped", listener: ((frame: DshServerFrame) => void) | (() => void)): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  async request<T = unknown>(method: string, payload: Record<string, unknown> = {}): Promise<T> {
    this.requests.push({ method, payload });
    if (method === "host.describe") {
      return { version: "2.0.0", cwd: "/Users/test", provider: "deepseek-official", attachedSessions: 1 } as T;
    }
    if (method === "session.list") return { items: [...this.listedSessions] } as T;
    if (method === "session.create") return { sessionId: "session-new", agentPreset: "cordis" } as T;
    if (method === "session.history") return { events: [...this.historyEvents], hasMore: false } as T;
    if (method === "session.models") return this.modelsValue as T;
    if (method === "session.prompt" || method === "session.selectModel" || method === "session.cancel") {
      return { accepted: true } as T;
    }
    throw new Error(`unexpected method ${method}`);
  }

  async respond(message: DshClientResponse): Promise<{ accepted: boolean; reason?: string }> {
    this.responses.push(message);
    return { accepted: true };
  }

  close(): void {
    this.closed = true;
  }

  emitFrame(frame: DshServerFrame): void {
    this.emit("frame", frame);
  }
}

function sessionEvent(sessionId: string, event: Record<string, unknown>): DshServerFrame {
  return {
    rpcId: crypto.randomUUID(),
    method: "session/event",
    payload: { type: "session/event", sessionId, event },
  };
}

async function createAdapter(client: FakeDshClient): Promise<DshDesktopAdapter> {
  const adapter = new DshDesktopAdapter({
    discoverGatewayUrl: async () => "http://127.0.0.1:60768",
    clientFactory: async () => client,
  });
  await adapter.initialize();
  return adapter;
}

describe("DshDesktopAdapter", () => {
  let adapter: DshDesktopAdapter | undefined;

  afterEach(async () => {
    await adapter?.close();
    adapter = undefined;
  });

  it("connects, lists sessions and reports ready", async () => {
    const client = new FakeDshClient();
    adapter = await createAdapter(client);
    const status = adapter.status();
    expect(status.state).toBe("ready");
    expect(status.appVersion).toBe("2.0.0");
    expect(status.capabilities).toContain("turn.start");
    expect(status.capabilities).toContain("attachment.image");
    const sessions = adapter.sessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toEqual(expect.objectContaining({
      nativeSessionId: "session-existing",
      title: "既有 DSH 任务",
      transport: "dsh-gateway",
      turnState: "idle",
    }));
  });

  it("stays unavailable with rediscovery scheduled when no gateway is found", async () => {
    adapter = new DshDesktopAdapter({
      discoverGatewayUrl: async () => undefined,
      rediscoveryIntervalMs: 60_000,
    });
    await adapter.initialize();
    expect(adapter.status().state).toBe("unavailable");
    expect(adapter.status().detail).toContain("BRIDGE_DSH_GATEWAY_URL");
  });

  it("creates sessions through session.create and marks them bridge-sourced", async () => {
    const client = new FakeDshClient();
    adapter = await createAdapter(client);
    const session = await adapter.createSession({ cwd: "/tmp/project", title: "桥接任务" });
    expect(session.nativeSessionId).toBe("session-new");
    expect(session.source).toBe("bridge");
    expect(client.requests.at(-1)).toEqual({
      method: "session.create",
      payload: { cwd: "/tmp/project" },
    });
  });

  it("runs a full turn: prompt, coalesced deltas, tool call and completion", async () => {
    const client = new FakeDshClient();
    adapter = await createAdapter(client);
    const events: Array<Record<string, unknown>> = [];
    adapter.on("event", (event) => events.push(event as Record<string, unknown>));

    const result = await adapter.startTurn({
      nativeSessionId: "session-existing",
      text: "你好",
      commandId: "cmd-1",
      requestId: "req-1",
    });
    expect(result).toEqual({ turnId: "dsh:cmd-1", state: "running" });
    expect(client.requests.at(-1)?.method).toBe("session.prompt");
    expect(client.requests.at(-1)?.payload).toEqual(expect.objectContaining({
      sessionId: "session-existing",
      mode: "queue",
    }));

    client.emitFrame(sessionEvent("session-existing", { type: "turn/start", seq: 1, time: 100, data: { turn: 1 } }));
    client.emitFrame(sessionEvent("session-existing", {
      type: "assistant/chunk",
      seq: 2,
      time: 101,
      data: { turn: 1, step: 1, chunk: { type: "block-start", index: 0, blockType: "text" } },
    }));
    client.emitFrame(sessionEvent("session-existing", {
      type: "assistant/chunk",
      seq: 3,
      time: 102,
      data: { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "你" } },
    }));
    client.emitFrame(sessionEvent("session-existing", {
      type: "assistant/chunk",
      seq: 4,
      time: 103,
      data: { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "好" } },
    }));
    client.emitFrame(sessionEvent("session-existing", {
      type: "assistant/chunk",
      seq: 5,
      time: 104,
      data: { turn: 1, step: 1, chunk: { type: "reasoning-delta", index: 1, text: "hidden" } },
    }));
    client.emitFrame(sessionEvent("session-existing", {
      type: "tool/call",
      seq: 6,
      time: 105,
      data: {
        turn: 1,
        step: 1,
        callId: "call-1",
        name: "str_replace_editor",
        arguments: JSON.stringify({ command: "create", path: "/tmp/project/a.html" }),
      },
    }));
    client.emitFrame(sessionEvent("session-existing", {
      type: "tool/result",
      seq: 7,
      time: 106,
      data: {
        turn: 1,
        step: 1,
        message: {
          source: { kind: "tool", callId: "call-1" },
          content: [{ type: "tool-result", toolCallId: "call-1", content: [{ type: "text", text: "File created" }] }],
        },
      },
    }));
    client.emitFrame(sessionEvent("session-existing", {
      type: "assistant/message",
      seq: 8,
      time: 107,
      data: {
        turn: 1,
        step: 2,
        message: {
          role: "assistant",
          id: "msg-1",
          content: [{ type: "reasoning", text: "hidden" }, { type: "text", text: "你好" }],
        },
      },
    }));
    client.emitFrame(sessionEvent("session-existing", {
      type: "turn/end",
      seq: 9,
      time: 108,
      data: { turn: 1, reason: { kind: "completed" } },
    }));

    const types = events.map((event) => event.type);
    expect(types).toContain("turn.started");
    expect(types).toContain("tool.started");
    expect(types).toContain("tool.completed");
    expect(types).toContain("assistant.completed");
    expect(types).toContain("turn.completed");

    const toolStarted = events.find((event) => event.type === "tool.started") as Record<string, unknown>;
    expect(toolStarted.toolName).toBe("str_replace_editor");
    expect(toolStarted.fileChanges).toEqual([{ path: "/tmp/project/a.html", kind: "add", additions: 0, deletions: 0 }]);

    // The pending deltas flush before the tool card and arrive as one coalesced event.
    const deltas = events.filter((event) => event.type === "assistant.delta");
    expect(deltas).toHaveLength(1);
    expect((deltas[0] as Record<string, unknown>).text).toBe("你好");

    const completed = events.find((event) => event.type === "turn.completed") as Record<string, unknown>;
    expect(completed.turnId).toBe("dsh:cmd-1");
    expect(adapter.sessions().find((session) => session.nativeSessionId === "session-existing")?.turnState).toBe("completed");
  });

  it("surfaces approvals and answers them through /api/respond", async () => {
    const client = new FakeDshClient();
    adapter = await createAdapter(client);
    const events: Array<Record<string, unknown>> = [];
    adapter.on("event", (event) => events.push(event as Record<string, unknown>));

    client.emitFrame({
      rpcId: "frame-rpc-1",
      method: "approval/requested",
      payload: {
        type: "approval/requested",
        sessionId: "session-existing",
        approvalId: "approval-1",
        toolName: "bash",
        callId: "call-9",
        reason: "需要执行 shell 命令",
      },
    });
    const requested = events.find((event) => event.type === "permission.requested") as
      { permission: Record<string, unknown> } | undefined;
    expect(requested?.permission).toEqual(expect.objectContaining({
      requestId: "approval-1",
      nativeSessionId: "session-existing",
      toolName: "bash",
      canAllowAlways: false,
    }));

    const resolved = await adapter.resolvePermission("approval-1", "allow-once");
    expect(resolved).toBe(true);
    expect(client.responses).toHaveLength(1);
    expect(client.responses[0]).toEqual({
      type: "client-response",
      rpcId: "frame-rpc-1",
      result: {
        ok: true,
        value: { sessionId: "session-existing", approvalId: "approval-1", outcome: "allowed-once" },
      },
    });
  });

  it("maps AskUserQuestion frames to question permissions and answers with custom text", async () => {
    const client = new FakeDshClient();
    adapter = await createAdapter(client);
    const events: Array<Record<string, unknown>> = [];
    adapter.on("event", (event) => events.push(event as Record<string, unknown>));

    client.emitFrame({
      rpcId: "question-rpc-1",
      method: "question/requested",
      payload: {
        type: "question/requested",
        sessionId: "session-existing",
        questions: [{ id: "q1", question: "选哪个方案？" }],
      },
    });
    const requested = events.find((event) => event.type === "permission.requested") as
      { permission: Record<string, unknown> } | undefined;
    expect(requested?.permission).toEqual(expect.objectContaining({
      requestId: "question-rpc-1",
      question: true,
      toolName: "AskUserQuestion",
    }));

    await adapter.resolvePermission("question-rpc-1", "allow-once", { answers: { q1: "方案 B" } });
    expect(client.responses[0]).toEqual({
      type: "client-response",
      rpcId: "question-rpc-1",
      result: {
        ok: true,
        value: {
          sessionId: "session-existing",
          answer: { answers: [{ id: "q1", selected: [], custom: "方案 B" }] },
        },
      },
    });
  });

  it("projects raw history events into user/assistant/tool items", async () => {
    const client = new FakeDshClient();
    client.historyEvents = [
      { event: { type: "permission/preset", seq: 0, time: 1, data: { preset: "danger-full-access" } } },
      {
        event: {
          type: "user/message",
          seq: 1,
          time: 10,
          data: {
            id: "u1",
            role: "user",
            source: { kind: "user" },
            content: [{ type: "text", text: "写个页面" }],
          },
        },
      },
      {
        event: {
          type: "user/message",
          seq: 2,
          time: 11,
          data: {
            id: "u2",
            role: "user",
            source: { kind: "system" },
            content: [{ type: "text", text: "<system-reminder>注入的上下文</system-reminder>" }],
          },
        },
      },
      {
        event: {
          type: "assistant/message",
          seq: 3,
          time: 12,
          data: {
            message: {
              id: "a1",
              role: "assistant",
              content: [{ type: "reasoning", text: "hidden" }, { type: "text", text: "好的" }],
            },
          },
        },
      },
      {
        event: {
          type: "tool/call",
          seq: 4,
          time: 13,
          data: { callId: "c1", name: "str_replace_editor", arguments: "{\"command\":\"str_replace\",\"path\":\"/tmp/a.ts\"}" },
        },
      },
      {
        event: {
          type: "tool/result",
          seq: 5,
          time: 14,
          data: {
            message: {
              source: { kind: "tool", callId: "c1" },
              content: [{ type: "tool-result", toolCallId: "c1", content: [{ type: "text", text: "done" }] }],
            },
          },
        },
      },
    ];
    adapter = await createAdapter(client);
    const items = await adapter.history("session-existing");
    expect(items.map((item) => item.role)).toEqual(["user", "assistant", "tool"]);
    expect(items[0]?.text).toBe("写个页面");
    expect(items[1]?.text).toBe("好的");
    expect(items[2]).toEqual(expect.objectContaining({
      toolName: "str_replace_editor",
      state: "completed",
      fileChanges: [{ path: "/tmp/a.ts", kind: "update", additions: 0, deletions: 0 }],
    }));
  });

  it("reads the model catalog and applies selections through session.selectModel", async () => {
    const client = new FakeDshClient();
    adapter = await createAdapter(client);
    const configuration = await adapter.configuration("session-existing");
    expect(configuration.model).toBe("deepseek-v4-pro");
    expect(configuration.provider).toBe("deepseek-official");
    expect(configuration.reasoningEffort).toBe("max");
    expect(configuration.availableReasoningEfforts).toEqual(["off", "high", "max"]);
    expect(configuration.availableModels[0]).toEqual(expect.objectContaining({
      value: "deepseek-v4-pro",
      provider: "deepseek-official",
      supportsEffort: true,
    }));

    await adapter.configureSession("session-existing", { model: "deepseek-v4-flash", reasoningEffort: "high" });
    expect(client.requests.find((request) => request.method === "session.selectModel")).toEqual({
      method: "session.selectModel",
      payload: {
        sessionId: "session-existing",
        provider: "deepseek-official",
        model: "deepseek-v4-flash",
        reasoningEffort: "high",
      },
    });
  });

  it("updates titles from live projections", async () => {
    const client = new FakeDshClient();
    adapter = await createAdapter(client);
    const events: Array<Record<string, unknown>> = [];
    adapter.on("event", (event) => events.push(event as Record<string, unknown>));
    client.emitFrame({
      rpcId: "p1",
      method: "session/projection",
      payload: { type: "session/projection", sessionId: "session-existing", key: "title", value: "新标题", seq: 42 },
    });
    expect(adapter.sessions()[0]?.title).toBe("新标题");
    expect(events.some((event) => event.type === "session.updated")).toBe(true);
  });

  it("interrupts through session.cancel only while a turn streams", async () => {
    const client = new FakeDshClient();
    adapter = await createAdapter(client);
    expect(await adapter.interruptTurn("session-existing")).toBe(false);
    client.emitFrame(sessionEvent("session-existing", { type: "turn/start", seq: 1, time: 100, data: { turn: 1 } }));
    expect(await adapter.interruptTurn("session-existing")).toBe(true);
    expect(client.requests.at(-1)).toEqual({
      method: "session.cancel",
      payload: { sessionId: "session-existing" },
    });
  });

  it("fails the live turn when the stream drops", async () => {
    const client = new FakeDshClient();
    adapter = await createAdapter(client);
    const events: Array<Record<string, unknown>> = [];
    adapter.on("event", (event) => events.push(event as Record<string, unknown>));
    client.emitFrame(sessionEvent("session-existing", { type: "turn/start", seq: 1, time: 100, data: { turn: 1 } }));
    client.emit("dropped");
    await new Promise((resolve) => setImmediate(resolve));
    expect(events.some((event) => event.type === "turn.interrupted")).toBe(true);
    expect(adapter.status().state).toBe("starting");
  });
});

describe("listeningLoopbackPorts", () => {
  it("parses lsof LISTEN rows and dedupes ports", () => {
    const output = [
      "COMMAND     PID      USER   FD   TYPE DEVICE SIZE/OFF NODE NAME",
      "DSH\\x20De 33195 martinez   37u  IPv4 0xbaa575 0t0  TCP 127.0.0.1:60768 (LISTEN)",
      "DSH\\x20De 33195 martinez   38u  IPv6 0xbaa576 0t0  TCP [::1]:60768 (LISTEN)",
      "node      1234 martinez   20u  IPv4 0xbaa577 0t0  TCP 192.168.1.2:3000 (LISTEN)",
    ].join("\n");
    expect(listeningLoopbackPorts(output)).toEqual([60768]);
  });
});
