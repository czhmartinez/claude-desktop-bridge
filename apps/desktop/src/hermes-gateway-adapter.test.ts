import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { HermesGatewayAdapter } from "./hermes-gateway-adapter.js";

interface GatewayEvent {
  type?: string;
  session_id?: string;
  payload?: unknown;
}

class FakeHermesClient extends EventEmitter {
  readonly requests: Array<{ method: string; params?: Record<string, unknown> }> = [];
  private settings = {
    model: "claude-sonnet",
    provider: "anthropic",
    reasoning: "medium",
    fast: "normal",
  };
  private running = false;
  private pendingModel?: string;
  private pendingProvider?: string;

  on(event: "event", listener: (value: GatewayEvent) => void): this {
    return super.on(event, listener);
  }

  async request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    this.requests.push({ method, ...(params === undefined ? {} : { params }) });
    if (method === "session.list") {
      return {
        sessions: [{
          id: "hermes-1",
          title: "Existing Hermes task",
          started_at: 1,
          source: "desktop",
        }],
      } as T;
    }
    if (method === "session.resume") {
      const model = this.running ? this.pendingModel ?? this.settings.model : this.settings.model;
      const provider = this.running ? this.pendingProvider ?? this.settings.provider : this.settings.provider;
      return {
        status: "ok",
        info: {
          model,
          provider,
          reasoning_effort: this.settings.reasoning,
          fast: this.settings.fast === "fast",
        },
      } as T;
    }
    if (method === "model.options") {
      return {
        model: this.settings.model,
        provider: this.settings.provider,
        providers: [{
          slug: "anthropic",
          name: "Anthropic",
          models: ["claude-sonnet", "claude-haiku"],
          capabilities: {
            "claude-sonnet": { fast: true, reasoning: true },
            "claude-haiku": { fast: false, reasoning: true },
          },
        }],
      } as T;
    }
    if (method === "config.get") {
      const key = params?.key;
      if (key === "provider") return { provider: this.settings.provider, providers: [{ slug: "anthropic", name: "Anthropic" }] } as T;
      if (key === "reasoning") return { value: this.settings.reasoning } as T;
      if (key === "fast") return { value: this.settings.fast } as T;
    }
    if (method === "config.set") {
      const key = params?.key;
      const value = String(params?.value ?? "");
      if (key === "model") {
        const model = value.split(" --provider ")[0] ?? value;
        const provider = value.match(/ --provider ([^ ]+)/)?.[1] ?? this.settings.provider;
        if (this.running) {
          this.pendingModel = model;
          this.pendingProvider = provider;
        } else {
          this.settings.model = model;
          this.settings.provider = provider;
        }
      } else if (key === "reasoning") {
        this.settings.reasoning = value;
      } else if (key === "fast") {
        this.settings.fast = value;
      }
      return { key, value, status: "ok" } as T;
    }
    if (method === "session.history") return { messages: [] } as T;
    if (method === "prompt.submit") {
      this.running = true;
      return { status: "streaming" } as T;
    }
    return { status: "ok", resolved: true } as T;
  }

  close(): void {}
}

const previousGatewayUrl = process.env.BRIDGE_HERMES_GATEWAY_URL;

afterEach(() => {
  if (previousGatewayUrl === undefined) delete process.env.BRIDGE_HERMES_GATEWAY_URL;
  else process.env.BRIDGE_HERMES_GATEWAY_URL = previousGatewayUrl;
});

describe("HermesGatewayAdapter", () => {
  it("uses Hermes approval and clarify response contracts without sharing session state", async () => {
    process.env.BRIDGE_HERMES_GATEWAY_URL = "ws://127.0.0.1:8765/api/ws";
    const client = new FakeHermesClient();
    const adapter = new HermesGatewayAdapter({ clientFactory: async () => client });
    const events: unknown[] = [];
    adapter.on("event", (event) => events.push(event));

    await adapter.initialize();
    expect(adapter.status()).toMatchObject({ state: "ready", sessionCount: 1 });
    expect(adapter.sessions()).toEqual([
      expect.objectContaining({ nativeSessionId: "hermes-1", transport: "hermes-gateway" }),
    ]);

    client.emit("event", {
      type: "approval.request",
      session_id: "hermes-1",
      payload: { request_id: "approval-1", tool_id: "tool-1", choices: ["once", "always", "deny"] },
    } satisfies GatewayEvent);
    const approval = events.find((event) => (
      typeof event === "object" && event !== null && (event as { type?: string }).type === "permission.requested"
    )) as { permission: { requestId: string } } | undefined;
    expect(approval?.permission.requestId).toBe("approval-1");
    await expect(adapter.resolvePermission("approval-1", "allow-always")).resolves.toBe(true);
    expect(client.requests).toContainEqual({
      method: "approval.respond",
      params: { session_id: "hermes-1", choice: "always" },
    });

    client.emit("event", {
      type: "clarify.request",
      session_id: "hermes-1",
      payload: { request_id: "clarify-1", question: "Pick one", choices: ["A", "B"] },
    } satisfies GatewayEvent);
    await expect(adapter.resolvePermission("clarify-1", "allow-once", {
      answers: { "Pick one": "A" },
    })).resolves.toBe(true);
    expect(client.requests).toContainEqual({
      method: "clarify.respond",
      params: { session_id: "hermes-1", request_id: "clarify-1", answer: "A" },
    });

    await adapter.close();
  });

  it("uses session-scoped Hermes config.set for model, provider, reasoning and fast mode", async () => {
    process.env.BRIDGE_HERMES_GATEWAY_URL = "ws://127.0.0.1:8765/api/ws";
    const client = new FakeHermesClient();
    const adapter = new HermesGatewayAdapter({ clientFactory: async () => client });

    await adapter.initialize();
    await expect(adapter.configuration("hermes-1")).resolves.toMatchObject({
      model: "claude-sonnet",
      provider: "anthropic",
      reasoningEffort: "medium",
      fast: false,
      supportsFastMode: true,
      availableModels: expect.arrayContaining([
        expect.objectContaining({ value: "claude-sonnet", supportsFast: true }),
      ]),
    });

    await expect(adapter.configureSession("hermes-1", {
      model: "claude-haiku",
      provider: "anthropic",
      reasoningEffort: "high",
      fast: false,
    })).resolves.toMatchObject({
      model: "claude-haiku",
      provider: "anthropic",
      reasoningEffort: "high",
      fast: false,
    });
    expect(client.requests).toContainEqual({
      method: "config.set",
      params: {
        session_id: "hermes-1",
        key: "model",
        value: "claude-haiku --provider anthropic --session",
      },
    });
    expect(client.requests).toContainEqual({
      method: "config.set",
      params: { session_id: "hermes-1", key: "reasoning", value: "high" },
    });
    expect(client.requests).toContainEqual({
      method: "config.set",
      params: { session_id: "hermes-1", key: "fast", value: "normal" },
    });

    await adapter.configureSession("hermes-1", { reasoningEffort: null, fast: null });
    expect(client.requests).toContainEqual({
      method: "config.set",
      params: { session_id: "hermes-1", key: "reasoning", value: "none" },
    });

    await adapter.close();
  });

  it("keeps a running turn's pending native model ahead of the stale model catalog", async () => {
    process.env.BRIDGE_HERMES_GATEWAY_URL = "ws://127.0.0.1:8765/api/ws";
    const client = new FakeHermesClient();
    const adapter = new HermesGatewayAdapter({ clientFactory: async () => client });

    await adapter.initialize();
    await adapter.startTurn({
      nativeSessionId: "hermes-1",
      text: "Start the turn",
      commandId: "command-running",
      requestId: "request-running",
    });

    await expect(adapter.configureSession("hermes-1", {
      model: "claude-haiku",
      provider: "anthropic",
      reasoningEffort: "high",
      fast: false,
    })).resolves.toMatchObject({
      model: "claude-haiku",
      provider: "anthropic",
      reasoningEffort: "high",
      fast: false,
      appliesAfterTurn: true,
    });

    await adapter.close();
  });
});
