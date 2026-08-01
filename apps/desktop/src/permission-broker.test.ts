import { describe, expect, it, vi } from "vitest";
import type { BridgePermissionMode, BridgePermissionResolution } from "@bridge/protocol";
import { PermissionBroker } from "./permission-broker.js";

describe("PermissionBroker policy", () => {
  it("automatically approves tools in full access without publishing a pending request", async () => {
    const requested = vi.fn();
    const resolved: BridgePermissionResolution[] = [];
    const broker = new PermissionBroker(() => "full-access");
    broker.on("requested", requested);
    broker.on("resolved", (_request, _result, resolution) => resolved.push(resolution));

    const result = await broker.request("session-1", "Bash", { command: "npm test" }, {
      signal: new AbortController().signal,
      toolUseId: "tool-1",
    });

    expect(result).toMatchObject({ behavior: "allow", toolUseID: "tool-1" });
    expect(requested).not.toHaveBeenCalled();
    expect(broker.list()).toEqual([]);
    expect(resolved).toEqual([
      expect.objectContaining({
        decision: "allow-once",
        automatic: true,
        reason: "policy-full-access",
      }),
    ]);
  });

  it("keeps AskUserQuestion waiting even in full access", async () => {
    const broker = new PermissionBroker(() => "full-access");
    const pending = broker.request("session-1", "AskUserQuestion", { questions: [] }, {
      signal: new AbortController().signal,
      toolUseId: "question-1",
    });

    expect(broker.list()).toHaveLength(1);
    expect(broker.resolveRequest(broker.list()[0]!.requestId, "allow-once")).toBe(true);
    await expect(pending).resolves.toMatchObject({ behavior: "allow" });
  });

  it("keeps a standard-mode request pending while the phone is offline", async () => {
    const broker = new PermissionBroker(() => "standard");
    let settled = false;
    const pending = broker.request("session-1", "Bash", { command: "sleep 30" }, {
      signal: new AbortController().signal,
      toolUseId: "tool-offline",
    }).then((result) => {
      settled = true;
      return result;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    expect(broker.list("session-1")).toHaveLength(1);

    expect(broker.resolveRequest(broker.list("session-1")[0]!.requestId, "allow-once")).toBe(true);
    await expect(pending).resolves.toMatchObject({ behavior: "allow" });
  });

  it("drains existing requests immediately when a session switches to full access", async () => {
    let mode: BridgePermissionMode = "standard";
    const broker = new PermissionBroker(() => mode);
    const pending = broker.request("session-1", "Edit", { file_path: "/tmp/a" }, {
      signal: new AbortController().signal,
      toolUseId: "tool-1",
    });

    expect(broker.list()).toHaveLength(1);
    mode = "full-access";
    expect(broker.applyPolicy("session-1")).toBe(1);
    await expect(pending).resolves.toMatchObject({ behavior: "allow" });
  });

  it("honors the first response and records turn-finished cleanup as automatic", async () => {
    const resolutions: BridgePermissionResolution[] = [];
    const broker = new PermissionBroker();
    broker.on("resolved", (_request, _result, resolution) => resolutions.push(resolution));
    const first = broker.request("session-1", "Bash", {}, {
      signal: new AbortController().signal,
      toolUseId: "tool-1",
    });
    const requestId = broker.list()[0]!.requestId;
    expect(broker.resolveRequest(requestId, "allow-once")).toBe(true);
    expect(broker.resolveRequest(requestId, "deny")).toBe(false);
    await expect(first).resolves.toMatchObject({ behavior: "allow" });

    const cleanup = broker.request("session-1", "Edit", {}, {
      signal: new AbortController().signal,
      toolUseId: "tool-2",
    });
    broker.cancelSession("session-1", "turn-finished");
    await expect(cleanup).resolves.toMatchObject({ behavior: "deny" });
    expect(resolutions.at(-1)).toMatchObject({
      automatic: true,
      reason: "turn-finished",
      decision: "deny",
    });
  });

  it("automatically responds to managed Claude Desktop permission requests", async () => {
    const responder = vi.fn();
    const broker = new PermissionBroker(() => "full-access");

    expect(broker.registerExternal({
      requestId: "managed-1",
      sessionId: "session-1",
      toolName: "Write",
      input: { file_path: "/tmp/a" },
    }, responder)).toBe(true);

    await vi.waitFor(() => expect(responder).toHaveBeenCalledWith(
      "allow-once",
      { file_path: "/tmp/a" },
    ));
    expect(broker.list()).toEqual([]);
  });

  it("keeps managed Claude Desktop questions waiting in full access", async () => {
    const responder = vi.fn();
    const broker = new PermissionBroker(() => "full-access");

    expect(broker.registerExternal({
      requestId: "managed-question",
      sessionId: "session-1",
      toolName: "AskUserQuestion",
      input: { questions: [] },
    }, responder)).toBe(true);

    await Promise.resolve();
    expect(responder).not.toHaveBeenCalled();
    expect(broker.list()).toHaveLength(1);
  });
});
