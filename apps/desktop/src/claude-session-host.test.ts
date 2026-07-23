import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ModelInfo, Query, SDKControlGetContextUsageResponse, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeSessionHost, type SessionHostEvent } from "./claude-session-host.js";
import { PermissionBroker } from "./permission-broker.js";

class FakeQuery implements AsyncGenerator<SDKMessage, void> {
  private readonly messages: SDKMessage[] = [];
  private resolveNext: (() => void) | undefined;
  interrupted = false;
  closed = false;
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
    return { still_queued: [] };
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

  it("uses first-writer-wins permission resolution", async () => {
    const broker = new PermissionBroker();
    const controller = new AbortController();
    const pending = broker.request("session", "Bash", { command: "npm test" }, {
      signal: controller.signal,
      toolUseId: "tool-1",
    });
    const [request] = broker.list();
    expect(request?.toolName).toBe("Bash");
    expect(broker.resolveRequest(request!.requestId, "allow-once")).toBe(true);
    expect(broker.resolveRequest(request!.requestId, "deny")).toBe(false);
    await expect(pending).resolves.toMatchObject({ behavior: "allow" });
  });
});
