import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  ModelInfo,
  Query,
  SDKControlGetContextUsageResponse,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { ClaudeSessionHost, type SessionHostEvent } from "./claude-session-host.js";
import { PermissionBroker } from "./permission-broker.js";

class FakeQuery implements AsyncGenerator<SDKMessage, void> {
  private readonly messages: SDKMessage[] = [];
  private resolveNext: (() => void) | undefined;
  interrupted = false;
  closed = false;
  holdClose = false;
  interruptStillQueued: string[] = [];
  readonly cancelledMessages: string[] = [];
  selectedModel: string | undefined;
  selectedEffort: string | null | undefined;

  push(message: SDKMessage): void {
    this.messages.push(message);
    this.resolveNext?.();
    this.resolveNext = undefined;
  }

  async next(): Promise<IteratorResult<SDKMessage, void>> {
    while (!this.closed && this.messages.length === 0) {
      await new Promise<void>((resolve) => { this.resolveNext = resolve; });
    }
    const message = this.messages.shift();
    return message ? { done: false, value: message } : { done: true, value: undefined };
  }

  async return(): Promise<IteratorResult<SDKMessage, void>> {
    this.close();
    return { done: true, value: undefined };
  }

  async throw(error?: unknown): Promise<IteratorResult<SDKMessage, void>> {
    throw error;
  }

  [Symbol.asyncIterator](): AsyncGenerator<SDKMessage, void> {
    return this;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.close();
  }

  async interrupt(): Promise<{ still_queued: string[] }> {
    this.interrupted = true;
    return { still_queued: this.interruptStillQueued };
  }

  async cancelAsyncMessage(messageId: string): Promise<boolean> {
    this.cancelledMessages.push(messageId);
    return true;
  }

  async setPermissionMode(): Promise<void> {}
  async setModel(model?: string): Promise<void> { this.selectedModel = model; }
  async setMaxThinkingTokens(): Promise<void> {}
  async setThinking(): Promise<void> {}
  async setEffort(): Promise<void> {}
  async setFastMode(): Promise<void> {}
  async setFastModeVolume(): Promise<void> {}
  async setMcpServerPermissionMode(): Promise<Record<string, unknown>> { return {}; }
  async setSandboxSettings(): Promise<void> {}
  async setAdditionalDirectories(): Promise<void> {}
  async setPlugins(): Promise<void> {}
  async setTools(): Promise<void> {}
  async setSkills(): Promise<void> {}
  async applyFlagSettings(settings: { effortLevel?: string | null }): Promise<void> {
    this.selectedEffort = settings.effortLevel;
  }
  async supportedModels(): Promise<ModelInfo[]> {
    return [{
      value: "claude-fable-5[1m]",
      displayName: "Fable 5 · 1M",
      description: "Long context",
    }];
  }
  async getContextUsage(): Promise<SDKControlGetContextUsageResponse> {
    return {
      categories: [],
      totalTokens: 300_000,
      maxTokens: 1_000_000,
      rawMaxTokens: 1_000_000,
      percentage: 30,
      gridRows: [],
      model: "claude-fable-5[1m]",
      memoryFiles: [],
      mcpTools: [],
      agents: [],
      isAutoCompactEnabled: true,
      apiUsage: null,
    };
  }
  async supportedCommands(): Promise<never[]> { return []; }
  async mcpServerStatus(): Promise<never[]> { return []; }
  async accountInfo(): Promise<undefined> { return undefined; }
  async rewindFiles(): Promise<void> {}
  async reconnectMcpServer(): Promise<void> {}
  async toggleMcpServer(): Promise<void> {}
  async stopTask(): Promise<void> {}
  async backgroundTasks(): Promise<boolean> { return false; }

  close(): void {
    this.closed = true;
    if (this.holdClose) return;
    this.releaseClose();
  }

  releaseClose(): void {
    this.resolveNext?.();
    this.resolveNext = undefined;
  }
}

function waitForEvent(events: SessionHostEvent[], type: SessionHostEvent["type"]): Promise<SessionHostEvent> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), 1_000);
    const poll = () => {
      const match = events.find((event) => event.type === type);
      if (match) {
        clearTimeout(timeout);
        resolve(match);
      } else {
        setTimeout(poll, 1);
      }
    };
    poll();
  });
}

describe("ClaudeSessionHost", () => {
  it("keeps one streaming query alive across turns and never forks", async () => {
    const fake = new FakeQuery();
    let queryCalls = 0;
    let captured: Parameters<typeof import("@anthropic-ai/claude-agent-sdk").query>[0] | undefined;
    const sessionId = randomUUID();
    const host = new ClaudeSessionHost({
      sessionId,
      cwd: "/tmp/bridge-project",
      executablePath: "/tmp/claude",
      environment: { PATH: "/usr/bin" },
      permissionBroker: new PermissionBroker(),
      resume: true,
      model: "claude-fable-5[1m]",
      effort: "high",
      queryFactory: ((params) => {
        queryCalls += 1;
        captured = params;
        return fake as unknown as Query;
      }) as typeof import("@anthropic-ai/claude-agent-sdk").query,
    });
    const events: SessionHostEvent[] = [];
    host.onEvent((event) => events.push(event));

    host.send("first", "mobile");
    fake.push({
      type: "result",
      subtype: "success",
      duration_ms: 1,
      duration_api_ms: 1,
      is_error: false,
      num_turns: 1,
      result: "one",
      stop_reason: "end_turn",
      total_cost_usd: 0,
      usage: {} as never,
      modelUsage: {},
      permission_denials: [],
      uuid: randomUUID(),
      session_id: sessionId,
    });
    await waitForEvent(events, "turn.completed");
    await host.setModel("claude-opus-4-8[1m]");
    await host.setEffort("xhigh");
    expect(fake.selectedModel).toBe("claude-opus-4-8[1m]");
    expect(fake.selectedEffort).toBe("xhigh");
    await expect(host.supportedModels()).resolves.toEqual([
      expect.objectContaining({ value: "claude-fable-5[1m]" }),
    ]);
    await expect(host.contextUsage()).resolves.toMatchObject({
      totalTokens: 300_000,
      maxTokens: 1_000_000,
    });
    host.send("second", "desktop");
    expect(queryCalls).toBe(1);
    expect(captured?.options).toMatchObject({
      resume: sessionId,
      forkSession: false,
      cwd: "/tmp/bridge-project",
      includePartialMessages: true,
      permissionMode: "default",
      model: "claude-fable-5[1m]",
      effort: "high",
    });

    await host.interrupt();
    expect(fake.interrupted).toBe(true);
    await host.close();
  });

  it("withdraws an unconsumed prompt when query startup fails", async () => {
    const fake = new FakeQuery();
    const sessionId = randomUUID();
    let queryCalls = 0;
    let retryPrompt: AsyncIterable<SDKUserMessage> | undefined;
    const host = new ClaudeSessionHost({
      sessionId,
      cwd: "/tmp/bridge-project",
      executablePath: "/tmp/claude",
      environment: { PATH: "/usr/bin" },
      permissionBroker: new PermissionBroker(),
      resume: true,
      queryFactory: ((params) => {
        queryCalls += 1;
        if (queryCalls === 1) throw new Error("query startup failed");
        retryPrompt = params.prompt as AsyncIterable<SDKUserMessage>;
        return fake as unknown as Query;
      }) as typeof import("@anthropic-ai/claude-agent-sdk").query,
    });
    const events: SessionHostEvent[] = [];
    host.onEvent((event) => events.push(event));

    expect(() => host.send("stale prompt", "mobile")).toThrow("query startup failed");
    expect(host.busy).toBe(false);
    const retry = host.send("retry prompt", "mobile");
    expect(queryCalls).toBe(2);
    if (!retryPrompt) throw new Error("Retry query did not receive a prompt iterable");
    const queued = await retryPrompt[Symbol.asyncIterator]().next();
    expect(queued.done).toBe(false);
    expect((queued.value.message.content as Array<{ type: string; text?: string }>))
      .toEqual([{ type: "text", text: "retry prompt" }]);

    fake.push({
      type: "result",
      subtype: "success",
      duration_ms: 1,
      duration_api_ms: 1,
      is_error: false,
      num_turns: 1,
      result: "Recovered",
      stop_reason: "end_turn",
      total_cost_usd: 0,
      usage: {} as never,
      modelUsage: {},
      permission_denials: [],
      uuid: randomUUID(),
      session_id: sessionId,
    });
    await expect(waitForEvent(events, "turn.completed")).resolves.toMatchObject({
      type: "turn.completed",
      turnId: retry.turnId,
      result: "Recovered",
    });
    await host.close();
  });

  it("reports provider API errors as failed turns", async () => {
    const fake = new FakeQuery();
    const sessionId = randomUUID();
    const host = new ClaudeSessionHost({
      sessionId,
      cwd: "/tmp/bridge-project",
      executablePath: "/tmp/claude",
      environment: { PATH: "/usr/bin" },
      permissionBroker: new PermissionBroker(),
      resume: true,
      queryFactory: (() => fake as unknown as Query) as typeof import("@anthropic-ai/claude-agent-sdk").query,
    });
    const events: SessionHostEvent[] = [];
    host.onEvent((event) => events.push(event));

    host.send("continue", "mobile");
    fake.push({
      type: "result",
      subtype: "success",
      duration_ms: 1,
      duration_api_ms: 1,
      is_error: true,
      num_turns: 1,
      result: "API Error: request exceeded model token limit",
      stop_reason: null,
      total_cost_usd: 0,
      usage: {} as never,
      modelUsage: {},
      permission_denials: [],
      uuid: randomUUID(),
      session_id: sessionId,
    });

    await expect(waitForEvent(events, "turn.failed")).resolves.toMatchObject({
      type: "turn.failed",
      error: "API Error: request exceeded model token limit",
    });
    await host.close();
  });

  it("emits one visible failure for a synthetic SDK error and keeps normal assistant text", async () => {
    const fake = new FakeQuery();
    const sessionId = randomUUID();
    const host = new ClaudeSessionHost({
      sessionId,
      cwd: "/tmp/bridge-project",
      executablePath: "/tmp/claude",
      environment: { PATH: "/usr/bin" },
      permissionBroker: new PermissionBroker(),
      resume: true,
      queryFactory: (() => fake as unknown as Query) as typeof import("@anthropic-ai/claude-agent-sdk").query,
    });
    const events: SessionHostEvent[] = [];
    host.onEvent((event) => events.push(event));

    host.send("continue", "mobile");
    fake.push({
      type: "assistant",
      uuid: randomUUID(),
      session_id: sessionId,
      parent_tool_use_id: null,
      message: {
        id: randomUUID(),
        type: "message",
        role: "assistant",
        model: "<synthetic>",
        content: [{ type: "text", text: "Prompt is too long", citations: [] }],
        stop_reason: "model_context_window_exceeded",
        stop_sequence: null,
        usage: {} as never,
      } as never,
    });
    fake.push({
      type: "result",
      subtype: "success",
      duration_ms: 1,
      duration_api_ms: 1,
      is_error: true,
      num_turns: 1,
      result: "Prompt is too long",
      stop_reason: "model_context_window_exceeded",
      total_cost_usd: 0,
      usage: {} as never,
      modelUsage: {},
      permission_denials: [],
      uuid: randomUUID(),
      session_id: sessionId,
    });
    await waitForEvent(events, "turn.failed");
    expect(events.filter((event) => event.type === "turn.failed")).toHaveLength(1);
    expect(events.some((event) => event.type === "assistant.completed")).toBe(false);

    host.send("retry in a new context", "mobile");
    const normalAssistantId = randomUUID();
    fake.push({
      type: "assistant",
      uuid: normalAssistantId,
      session_id: sessionId,
      parent_tool_use_id: null,
      message: {
        id: randomUUID(),
        type: "message",
        role: "assistant",
        model: "claude-opus-5",
        content: [{ type: "text", text: "正常回复", citations: [] }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {} as never,
      } as never,
    });
    fake.push({
      type: "result",
      subtype: "success",
      duration_ms: 1,
      duration_api_ms: 1,
      is_error: false,
      num_turns: 1,
      result: "正常回复",
      stop_reason: "end_turn",
      total_cost_usd: 0,
      usage: {} as never,
      modelUsage: {},
      permission_denials: [],
      uuid: randomUUID(),
      session_id: sessionId,
    });
    await waitForEvent(events, "turn.completed");
    expect(events).toContainEqual(expect.objectContaining({
      type: "assistant.completed",
      itemId: normalAssistantId,
      text: "正常回复",
    }));
    await host.close();
  });

  it("drains an interrupted result before settling an immediate retry", async () => {
    const fake = new FakeQuery();
    const sessionId = randomUUID();
    let prompt: AsyncIterable<SDKUserMessage> | undefined;
    const host = new ClaudeSessionHost({
      sessionId,
      cwd: "/tmp/bridge-project",
      executablePath: "/tmp/claude",
      environment: { PATH: "/usr/bin" },
      permissionBroker: new PermissionBroker(),
      resume: true,
      queryFactory: ((params) => {
        prompt = params.prompt as AsyncIterable<SDKUserMessage>;
        return fake as unknown as Query;
      }) as typeof import("@anthropic-ai/claude-agent-sdk").query,
    });
    const events: SessionHostEvent[] = [];
    host.onEvent((event) => events.push(event));

    const interrupted = host.send("continue P2", "mobile");
    if (!prompt) throw new Error("Query did not receive a prompt iterable");
    const promptIterator = prompt[Symbol.asyncIterator]();
    await expect(promptIterator.next()).resolves.toMatchObject({
      done: false,
      value: { uuid: interrupted.messageId },
    });
    await host.interrupt();
    const retry = host.send("retry P2", "mobile");
    let retrySubmitted = false;
    const retryPrompt = promptIterator.next().then((value) => {
      retrySubmitted = true;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(retrySubmitted).toBe(false);
    fake.push({
      type: "assistant",
      uuid: randomUUID(),
      session_id: sessionId,
      parent_tool_use_id: null,
      message: {
        id: randomUUID(),
        type: "message",
        role: "assistant",
        model: "<synthetic>",
        content: [{ type: "text", text: "No response requested.", citations: [] }],
        stop_reason: "stop_sequence",
        stop_sequence: "",
        usage: {} as never,
      } as never,
    });
    fake.push({
      type: "result",
      subtype: "error_during_execution",
      duration_ms: 1,
      duration_api_ms: 1,
      is_error: true,
      num_turns: 0,
      errors: ["[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null"],
      total_cost_usd: 0,
      usage: {} as never,
      modelUsage: {},
      permission_denials: [],
      stop_reason: null,
      uuid: randomUUID(),
      session_id: sessionId,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(events.filter((event) => event.type === "turn.interrupted")).toEqual([
      expect.objectContaining({ turnId: interrupted.turnId }),
    ]);
    expect(events.some((event) => event.type === "assistant.completed")).toBe(false);
    expect(events.some((event) => event.type === "turn.failed")).toBe(false);
    expect(host.busy).toBe(true);
    await expect(retryPrompt).resolves.toMatchObject({
      done: false,
      value: { uuid: retry.messageId },
    });

    fake.push({
      type: "result",
      subtype: "success",
      duration_ms: 1,
      duration_api_ms: 1,
      is_error: false,
      num_turns: 1,
      result: "Done",
      stop_reason: "end_turn",
      total_cost_usd: 0,
      usage: {} as never,
      modelUsage: {},
      permission_denials: [],
      uuid: randomUUID(),
      session_id: sessionId,
    });
    await expect(waitForEvent(events, "turn.completed")).resolves.toMatchObject({
      type: "turn.completed",
      turnId: retry.turnId,
      result: "Done",
    });
    expect(host.busy).toBe(false);
    await host.close();
  });

  it("retires the writer when an interrupted prompt would otherwise still run", async () => {
    const firstQuery = new FakeQuery();
    const secondQuery = new FakeQuery();
    const prompts: AsyncIterable<SDKUserMessage>[] = [];
    const queryOptions: Array<Parameters<typeof import("@anthropic-ai/claude-agent-sdk").query>[0]["options"]> = [];
    let queryCalls = 0;
    const sessionId = randomUUID();
    const host = new ClaudeSessionHost({
      sessionId,
      cwd: "/tmp/bridge-project",
      executablePath: "/tmp/claude",
      environment: { PATH: "/usr/bin" },
      permissionBroker: new PermissionBroker(),
      resume: false,
      queryFactory: ((params) => {
        prompts.push(params.prompt as AsyncIterable<SDKUserMessage>);
        queryOptions.push(params.options);
        return (queryCalls++ === 0 ? firstQuery : secondQuery) as unknown as Query;
      }) as typeof import("@anthropic-ai/claude-agent-sdk").query,
    });
    const events: SessionHostEvent[] = [];
    host.onEvent((event) => events.push(event));

    const interrupted = host.send("queued old prompt", "mobile");
    await expect(prompts[0]![Symbol.asyncIterator]().next()).resolves.toMatchObject({
      done: false,
      value: { uuid: interrupted.messageId },
    });
    firstQuery.interruptStillQueued = [interrupted.messageId];
    await host.interrupt();

    expect(firstQuery.cancelledMessages).toEqual([interrupted.messageId]);
    expect(firstQuery.closed).toBe(true);
    expect(queryCalls).toBe(1);
    expect(queryOptions[0]).toMatchObject({ sessionId });
    expect(queryOptions[0]?.resume).toBeUndefined();
    expect(events).toContainEqual(expect.objectContaining({
      type: "turn.interrupted",
      turnId: interrupted.turnId,
    }));

    const retry = host.send("safe retry", "mobile");
    expect(queryCalls).toBe(2);
    expect(queryOptions[1]).toMatchObject({ resume: sessionId, forkSession: false });
    expect(queryOptions[1]?.sessionId).toBeUndefined();
    await expect(prompts[1]![Symbol.asyncIterator]().next()).resolves.toMatchObject({
      done: false,
      value: { uuid: retry.messageId },
    });
    secondQuery.push({
      type: "result",
      subtype: "success",
      duration_ms: 1,
      duration_api_ms: 1,
      is_error: false,
      num_turns: 1,
      result: "Retried safely",
      stop_reason: "end_turn",
      total_cost_usd: 0,
      usage: {} as never,
      modelUsage: {},
      permission_denials: [],
      uuid: randomUUID(),
      session_id: sessionId,
    });
    await expect(waitForEvent(events, "turn.completed")).resolves.toMatchObject({
      type: "turn.completed",
      turnId: retry.turnId,
      result: "Retried safely",
    });
    await host.close();
  });

  it("does not start a configuration writer while an interrupted writer retires", async () => {
    const firstQuery = new FakeQuery();
    const secondQuery = new FakeQuery();
    firstQuery.holdClose = true;
    let queryCalls = 0;
    let prompt: AsyncIterable<SDKUserMessage> | undefined;
    const sessionId = randomUUID();
    const host = new ClaudeSessionHost({
      sessionId,
      cwd: "/tmp/bridge-project",
      executablePath: "/tmp/claude",
      environment: { PATH: "/usr/bin" },
      permissionBroker: new PermissionBroker(),
      resume: true,
      queryFactory: ((params) => {
        prompt = params.prompt as AsyncIterable<SDKUserMessage>;
        return (queryCalls++ === 0 ? firstQuery : secondQuery) as unknown as Query;
      }) as typeof import("@anthropic-ai/claude-agent-sdk").query,
    });

    const interrupted = host.send("queued prompt", "mobile");
    if (!prompt) throw new Error("Query did not receive a prompt iterable");
    await expect(prompt[Symbol.asyncIterator]().next()).resolves.toMatchObject({
      value: { uuid: interrupted.messageId },
    });
    firstQuery.interruptStillQueued = [interrupted.messageId];
    const interrupting = host.interrupt();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(firstQuery.closed).toBe(true);
    expect(() => host.start()).toThrow(/retiring its previous writer/u);
    await expect(host.supportedModels()).rejects.toThrow(/retiring its previous writer/u);
    expect(queryCalls).toBe(1);

    firstQuery.releaseClose();
    await interrupting;
    host.send("safe retry", "mobile");
    expect(queryCalls).toBe(2);
    await host.close();
  });

  it("uses first-writer-wins permission resolution", async () => {
    const broker = new PermissionBroker();
    const controller = new AbortController();
    let resolution: { decision?: string; resolvedByDeviceId?: string } | undefined;
    broker.on("resolved", (_request, _result, resolved) => {
      resolution = resolved;
    });
    const pending = broker.request("session", "Bash", { command: "npm test" }, {
      signal: controller.signal,
      toolUseId: "tool-1",
    });
    const [request] = broker.list();
    expect(request?.toolName).toBe("Bash");
    expect(broker.resolveRequest(
      request!.requestId,
      "allow-always",
      undefined,
      undefined,
      { deviceId: "phone-1", name: "Android 手机" },
    )).toBe(true);
    expect(broker.resolveRequest(request!.requestId, "deny")).toBe(false);
    await expect(pending).resolves.toMatchObject({ behavior: "allow" });
    expect(resolution).toMatchObject({
      decision: "allow-once",
      resolvedByDeviceId: "phone-1",
    });
  });
});
