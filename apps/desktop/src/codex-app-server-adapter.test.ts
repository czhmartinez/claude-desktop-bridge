import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  CodexAppServerAdapter,
  type CodexRpcClient,
} from "./codex-app-server-adapter.js";

class FakeCodexClient extends EventEmitter implements CodexRpcClient {
  readonly requests: Array<{ method: string; params?: unknown }> = [];
  readonly responses: Array<{ id: string | number; result: unknown }> = [];

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, ...(params === undefined ? {} : { params }) });
    if (method === "initialize") return { userAgent: "codex-test" } as T;
    if (method === "thread/list") {
      return {
        data: [{
          id: "thread-1",
          cwd: "/workspace/codex",
          name: "Existing task",
          createdAt: 1,
          updatedAt: 2,
          status: { type: "idle" },
        }],
      } as T;
    }
    if (method === "thread/resume") return { thread: { id: "thread-1" } } as T;
    if (method === "turn/start") return { turn: { id: "turn-1" } } as T;
    if (method === "thread/read") return { thread: { turns: [] } } as T;
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
});
