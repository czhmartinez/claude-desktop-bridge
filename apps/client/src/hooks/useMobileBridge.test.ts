import type { BridgeEvent, BridgeHostSnapshot } from "@bridge/protocol";
import { describe, expect, it } from "vitest";
import {
  applyEventToTurns,
  applyEventToSnapshot,
  applyPermissionEvent,
  mergeBridgeEvents,
  type LocalTurn,
} from "./useMobileBridge.js";

function event(seq: number, eventId = `event-${seq}`): BridgeEvent {
  return {
    eventId,
    seq,
    timestamp: seq,
    origin: "claude-host",
    type: "assistant.delta",
    data: { text: String(seq) },
  };
}

describe("mergeBridgeEvents", () => {
  it("deduplicates replayed events and restores sequence order", () => {
    expect(mergeBridgeEvents([event(2), event(1)], [event(2), event(3)]).map((item) => item.seq))
      .toEqual([1, 2, 3]);
  });

  it("applies a terminal event only to its matching queued turn", () => {
    const turns: LocalTurn[] = ["one", "two"].map((id) => ({
      requestId: `request-${id}`,
      idempotencyKey: `key-${id}`,
      sessionId: "session-1",
      text: id,
      attachments: [],
      createdAt: 1,
      delivery: "host-received",
      commandId: `command-${id}`,
    }));
    const completed: BridgeEvent = {
      eventId: "completed-one",
      seq: 4,
      timestamp: 4,
      origin: "claude-host",
      type: "turn.completed",
      sessionId: "session-1",
      data: {
        requestId: "request-one",
        commandId: "command-one",
        delivery: "completed",
      },
    };
    expect(applyEventToTurns(turns, completed).map((turn) => turn.delivery))
      .toEqual(["completed", "host-received"]);
  });

  it("upserts permission requests from events and removes them when resolved", () => {
    const requested: BridgeEvent = {
      eventId: "permission-requested",
      seq: 5,
      timestamp: 100,
      origin: "claude-host",
      type: "permission.requested",
      sessionId: "session-1",
      itemId: "permission-1",
      data: {
        requestId: "permission-1",
        toolUseId: "tool-1",
        toolName: "Write",
        input: { file_path: "/tmp/demo.ts", content: "hello" },
        canAllowAlways: true,
        createdAt: 100,
      },
    };
    const replayed = { ...requested, eventId: "permission-replayed", seq: 6 };
    const pending = applyPermissionEvent(applyPermissionEvent([], requested), replayed);
    expect(pending).toEqual([
      expect.objectContaining({
        requestId: "permission-1",
        sessionId: "session-1",
        toolName: "Write",
        canAllowAlways: true,
      }),
    ]);

    const resolved: BridgeEvent = {
      eventId: "permission-resolved",
      seq: 7,
      timestamp: 120,
      origin: "system",
      type: "permission.resolved",
      sessionId: "session-1",
      itemId: "permission-1",
      data: {
        requestId: "permission-1",
        decision: "allow-once",
        resolvedByDeviceId: "phone-1",
        resolvedByName: "Android 手机",
        resolvedAt: 120,
      },
    };
    expect(applyPermissionEvent(pending, resolved)).toEqual([]);
  });

  it("moves the shared session between running, waiting, and idle from events", () => {
    const snapshot: BridgeHostSnapshot = {
      host: {
        hostId: "desktop-1",
        name: "Test Mac",
        relayUrl: "wss://relay.example/ws",
        online: true,
        lastSeenAt: 1,
        version: "0.2.3",
      },
      projects: [],
      sessions: [{
        sessionId: "session-1",
        projectId: "project-1",
        projectName: "project",
        cwd: "/tmp/project",
        title: "Session",
        source: "bridge",
        transport: "bridge-host",
        ownership: "BRIDGE_IDLE",
        turnState: "queued",
        lastActivityAt: 1,
        pendingCount: 1,
      }],
      devices: [],
      runtime: {
        state: "working",
        detail: "Working",
        activeTurns: 1,
        maxParallelTurns: 2,
        desktopIntegration: {
          state: "not-managed",
          detail: "未启用",
          enabled: false,
          canRestart: true,
        },
      },
      permissions: [],
      latestSeq: 1,
    };
    const started: BridgeEvent = {
      eventId: "started",
      seq: 2,
      timestamp: 2,
      origin: "claude-host",
      type: "turn.started",
      sessionId: "session-1",
      turnId: "turn-1",
      data: {},
    };
    const running = applyEventToSnapshot(snapshot, started, []);
    expect(running?.sessions[0]).toMatchObject({
      ownership: "BRIDGE_RUNNING",
      turnState: "running",
      pendingCount: 0,
      activeTurnId: "turn-1",
    });

    const requested: BridgeEvent = {
      eventId: "requested",
      seq: 3,
      timestamp: 3,
      origin: "claude-host",
      type: "permission.requested",
      sessionId: "session-1",
      data: {
        requestId: "permission-1",
        toolUseId: "tool-1",
        toolName: "Write",
        input: { file_path: "/tmp/project/demo.ts" },
      },
    };
    const permissions = applyPermissionEvent([], requested);
    expect(applyEventToSnapshot(running, requested, permissions)?.sessions[0]?.turnState).toBe("waiting");

    const completed: BridgeEvent = {
      eventId: "completed",
      seq: 4,
      timestamp: 4,
      origin: "claude-host",
      type: "turn.completed",
      sessionId: "session-1",
      turnId: "turn-1",
      data: {},
    };
    expect(applyEventToSnapshot(running, completed, [])?.sessions[0]).toMatchObject({
      ownership: "BRIDGE_IDLE",
      turnState: "idle",
    });
  });
});
