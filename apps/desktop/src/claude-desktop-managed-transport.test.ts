import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { BridgeSessionInfo } from "@bridge/protocol";
import {
  ClaudeDesktopManagedTransport,
  ManagedDeliveryUncertainError,
} from "./claude-desktop-managed-transport.js";
import { PermissionBroker } from "./permission-broker.js";

class FakeManager extends EventEmitter {
  ready = true;
  running = true;
  readonly calls: Array<{ name: string; args: unknown[] }> = [];
  failure: Error | undefined;

  status() {
    return {
      state: this.ready ? "ready" as const : "disconnected" as const,
      detail: this.ready ? "Ready" : "Disconnected",
      enabled: true,
      canRestart: true,
    };
  }

  async call(name: string, args: unknown[] = []): Promise<unknown> {
    this.calls.push({ name, args });
    if (this.failure && name === "sendMessage") throw this.failure;
    if (name === "getSession") {
      return { sessionId: "desktop-1", cwd: "/tmp/project", isRunning: this.running };
    }
    if (name === "getAll") {
      return [{ sessionId: "desktop-1", cwd: "/tmp/project", isRunning: this.running }];
    }
    if (name === "getContextUsage") {
      return { total_tokens: 120_000, context_window: 1_000_000, model: "claude-fable-5[1m]" };
    }
    if (name === "start") return { sessionId: "desktop-new" };
    return undefined;
  }
}

function session(overrides: Partial<BridgeSessionInfo> = {}): BridgeSessionInfo {
  return {
    sessionId: "cli-1",
    desktopSessionId: "desktop-1",
    projectId: "project-1",
    projectName: "project",
    cwd: "/tmp/project",
    title: "Session",
    source: "desktop",
    transport: "claude-desktop-managed",
    ownership: "DESKTOP_MANAGED_IDLE",
    turnState: "idle",
    lastActivityAt: 1,
    pendingCount: 0,
    ...overrides,
  };
}

describe("ClaudeDesktopManagedTransport", () => {
  it("queues normal input, steers immediately, and forwards the shared ordered event stream once", async () => {
    const manager = new FakeManager();
    const permissions = new PermissionBroker();
    const transport = new ClaudeDesktopManagedTransport({ manager, permissionBroker: permissions });
    transport.updateCatalog({
      projects: [],
      sessions: [{
        ...session(),
        transcriptMtimeMs: 0,
        processAlive: true,
        desktopProcessAlive: true,
        bridgeProcessAlive: false,
        processOverlap: false,
        activeProcesses: [],
        activeTask: true,
      }],
      observedAt: 1,
    });
    const events: Array<{ type: string; text?: string; itemId?: string }> = [];
    transport.onEvent((event) => events.push(event));

    await transport.send({
      session: session(),
      text: "继续修改",
      attachments: [],
      origin: "mobile",
      mode: "start",
      messageId: "message-1",
      turnId: "turn-1",
    });
    expect(manager.calls.find((call) => call.name === "sendMessage")?.args[5]).toBe("later");

    manager.emit("session-event", {
      type: "session_updated",
      sessionId: "desktop-1",
      userMessageUuid: "message-1",
      session: { sessionId: "desktop-1", cwd: "/tmp/project", isRunning: true },
      message: {
        type: "user",
        uuid: "message-1",
        session_id: "cli-1",
        message: { content: [{ type: "text", text: "继续修改" }] },
      },
    });
    manager.emit("session-event", {
      type: "message",
      sessionId: "desktop-1",
      message: {
        type: "assistant",
        uuid: "assistant-1",
        session_id: "cli-1",
        message: {
          content: [
            { type: "text", text: "开始处理" },
            { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "npm test" } },
          ],
        },
      },
    });
    manager.emit("session-event", {
      type: "message",
      sessionId: "desktop-1",
      message: {
        type: "user",
        uuid: "tool-result-1",
        session_id: "cli-1",
        parent_tool_use_id: "tool-1",
        tool_use_result: "passed",
        message: { content: [] },
      },
    });
    manager.emit("session-event", {
      type: "message",
      sessionId: "desktop-1",
      message: {
        type: "result",
        uuid: "result-1",
        session_id: "cli-1",
        subtype: "success",
        is_error: false,
        result: "完成",
      },
    });
    manager.emit("session-event", {
      type: "message",
      sessionId: "desktop-1",
      message: {
        type: "assistant",
        uuid: "assistant-1",
        session_id: "cli-1",
        message: { content: [{ type: "text", text: "开始处理" }] },
      },
    });

    expect(events.map((event) => event.type)).toEqual([
      "turn.started",
      "user.accepted",
      "assistant.completed",
      "tool.started",
      "tool.completed",
      "turn.completed",
    ]);

    manager.running = true;
    await transport.send({
      session: session(),
      text: "先修复登录页",
      attachments: [],
      origin: "mobile",
      mode: "steer",
      messageId: "message-steer",
      turnId: "turn-steer",
    });
    const steer = manager.calls.filter((call) => call.name === "sendMessage").at(-1);
    expect(steer?.args[5]).toBe("now");
    expect(steer?.args[6]).toEqual({ ccdSteering: true, queuedMessageBar: true });

    await expect(transport.getContextUsage("cli-1")).resolves.toMatchObject({
      totalTokens: 120_000,
      maxTokens: 1_000_000,
      percentage: 12,
      estimated: false,
    });
    transport.close();
  });

  it("marks a disconnected send as uncertain and never treats a validation rejection as delivered", async () => {
    const manager = new FakeManager();
    const transport = new ClaudeDesktopManagedTransport({
      manager,
      permissionBroker: new PermissionBroker(),
    });
    transport.updateCatalog({
      projects: [],
      sessions: [{
        ...session(),
        transcriptMtimeMs: 0,
        processAlive: true,
        desktopProcessAlive: true,
        bridgeProcessAlive: false,
        processOverlap: false,
        activeProcesses: [],
        activeTask: false,
      }],
      observedAt: 1,
    });
    const uncertain: unknown[] = [];
    transport.onDeliveryUncertain((event) => uncertain.push(event));
    manager.failure = new Error("socket closed before reply");
    await expect(transport.send({
      session: session(),
      text: "发送一次",
      attachments: [],
      origin: "mobile",
      mode: "start",
      messageId: "message-uncertain",
      turnId: "turn-uncertain",
    })).rejects.toBeInstanceOf(ManagedDeliveryUncertainError);
    expect(uncertain).toHaveLength(1);

    manager.failure = new Error("Invalid argument");
    await expect(transport.send({
      session: session(),
      text: "不会发送",
      attachments: [],
      origin: "mobile",
      mode: "start",
      messageId: "message-invalid",
      turnId: "turn-invalid",
    })).rejects.toThrow("Invalid argument");
    expect(uncertain).toHaveLength(1);
    transport.close();
  });

  it("routes Claude Desktop tool approval through the first Bridge resolver", async () => {
    const manager = new FakeManager();
    const permissions = new PermissionBroker();
    const transport = new ClaudeDesktopManagedTransport({ manager, permissionBroker: permissions });
    transport.updateCatalog({
      projects: [],
      sessions: [{
        ...session(),
        transcriptMtimeMs: 0,
        processAlive: true,
        desktopProcessAlive: true,
        bridgeProcessAlive: false,
        processOverlap: false,
        activeProcesses: [],
        activeTask: true,
      }],
      observedAt: 1,
    });
    manager.emit("permission-request", {
      request: {
        requestId: "permission-1",
        sessionId: "desktop-1",
        toolUseId: "tool-1",
        toolName: "Write",
        input: { file_path: "/tmp/project/demo.ts" },
      },
    });
    expect(permissions.list()).toEqual([
      expect.objectContaining({ requestId: "permission-1", sessionId: "cli-1", toolName: "Write" }),
    ]);
    expect(permissions.resolveRequest("permission-1", "allow-once")).toBe(true);
    expect(permissions.resolveRequest("permission-1", "deny")).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(manager.calls.find((call) => call.name === "respondToToolPermission")).toEqual({
      name: "respondToToolPermission",
      args: ["permission-1", "once", { file_path: "/tmp/project/demo.ts" }],
    });
    transport.close();
  });
});
