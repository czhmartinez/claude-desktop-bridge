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
    if (method === "session.resume") return { status: "ok" } as T;
    if (method === "session.history") return { messages: [] } as T;
    if (method === "prompt.submit") return { status: "streaming" } as T;
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
});
