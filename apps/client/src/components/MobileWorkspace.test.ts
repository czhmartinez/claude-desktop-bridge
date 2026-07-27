import type {
  BridgeEvent,
  BridgeEvidenceBundle,
  BridgeHistoryItem,
  BridgePermissionInfo,
  BridgeSessionInfo,
} from "@bridge/protocol";
import { describe, expect, it } from "vitest";
import {
  canStopBridgeTask,
  conversationItems,
  conversationTimeline,
  ownershipLabel,
  permissionPresentation,
  stoppableBridgeTask,
} from "./MobileWorkspace.js";

function evidence(
  id: string,
  turnId: string,
  state: BridgeEvidenceBundle["state"],
  startedAt: number,
): BridgeEvidenceBundle {
  return {
    id,
    sessionId: "session-1",
    turnId,
    source: "claude-desktop",
    confidence: "inferred",
    state,
    startedAt,
    ...(state === "collecting" ? {} : { completedAt: startedAt + 1 }),
    toolCount: 1,
    changeCount: 0,
    artifactCount: 0,
    tools: [],
    artifacts: [],
    warnings: [],
  };
}

describe("ownershipLabel", () => {
  it("identifies an active observed Claude session as Desktop running", () => {
    const session: BridgeSessionInfo = {
      sessionId: "session-1",
      projectId: "project-1",
      projectName: "Project",
      cwd: "/tmp/project",
      title: "Task",
      source: "desktop",
      ownership: "DESKTOP_OBSERVED",
      transport: "bridge-host",
      turnState: "running",
      lastActivityAt: 1,
      pendingCount: 0,
    };

    expect(ownershipLabel(session)).toBe("桌面运行中");
  });

  it("identifies a Bridge-created session without implying Desktop visibility", () => {
    const session: BridgeSessionInfo = {
      sessionId: "bridge-session-1",
      projectId: "project-1",
      projectName: "Project",
      cwd: "/tmp/project",
      title: "Task",
      source: "bridge",
      ownership: "BRIDGE_IDLE",
      transport: "bridge-host",
      turnState: "idle",
      lastActivityAt: 1,
      pendingCount: 0,
    };

    expect(ownershipLabel(session)).toBe("Bridge 待机");
    expect(ownershipLabel({
      ...session,
      ownership: "BRIDGE_RUNNING",
      turnState: "running",
    })).toBe("Bridge 运行中");
    expect(ownershipLabel({
      ...session,
      transport: "claude-desktop-managed",
      desktopSessionId: "local_bridge-session-1",
      desktopRegistration: {
        state: "registered",
        detail: "Registered",
        updatedAt: 2,
      },
    })).toBe("Bridge 待机");
  });
});

describe("canStopBridgeTask", () => {
  const session = (overrides: Partial<BridgeSessionInfo>): BridgeSessionInfo => ({
    sessionId: "session-1",
    projectId: "project-1",
    projectName: "Project",
    cwd: "/tmp/project",
    title: "Task",
    source: "desktop",
    ownership: "DESKTOP_OBSERVED",
    transport: "bridge-host",
    turnState: "idle",
    lastActivityAt: 1,
    pendingCount: 0,
    ...overrides,
  });

  it("keeps stop available for queued and uncertain Bridge work", () => {
    expect(canStopBridgeTask(session({
      turnState: "queued",
      pendingCount: 1,
    }))).toBe(true);
    expect(canStopBridgeTask(session({
      ownership: "DESKTOP_MANAGED_RUNNING",
      transport: "claude-desktop-managed",
      turnState: "waiting",
      pendingCount: 1,
    }))).toBe(true);
  });

  it("does not offer Bridge stop for an idle or native observed Desktop turn", () => {
    expect(canStopBridgeTask(session({}))).toBe(false);
    expect(canStopBridgeTask(session({
      ownership: "DESKTOP_OBSERVED",
      turnState: "running",
    }))).toBe(false);
  });

  it("finds a recovered blocker even when a native Desktop turn is selected", () => {
    const native = session({
      sessionId: "desktop-current",
      ownership: "DESKTOP_OBSERVED",
      turnState: "running",
    });
    const recovered = session({
      sessionId: "recovered-queue",
      source: "bridge",
      ownership: "BRIDGE_IDLE",
      turnState: "queued",
      pendingCount: 1,
    });

    expect(stoppableBridgeTask([native, recovered], native.sessionId)?.sessionId)
      .toBe(recovered.sessionId);
  });
});

describe("conversationTimeline", () => {
  it("anchors archived Desktop evidence to its completed turn instead of the active tail", () => {
    const items: BridgeHistoryItem[] = [
      {
        id: "desktop-user-1",
        sessionId: "session-1",
        role: "user",
        text: "First task",
        createdAt: 1,
        origin: "claude-desktop",
      },
      {
        id: "desktop-assistant-1",
        sessionId: "session-1",
        role: "assistant",
        text: "First result",
        createdAt: 2,
        origin: "claude-desktop",
      },
      {
        id: "desktop-user-2",
        sessionId: "session-1",
        role: "user",
        text: "Current task",
        createdAt: 3,
        origin: "claude-desktop",
      },
      {
        id: "current-tool",
        sessionId: "session-1",
        role: "tool",
        text: "Running",
        createdAt: 4,
        origin: "claude-host",
      },
    ];

    const timeline = conversationTimeline(items, [
      evidence("current", "desktop-user-2", "collecting", 4),
      evidence("archived", "desktop-user-1", "ready", 2),
      evidence("unmatched", "not-loaded", "ready", 0),
    ]);

    expect(timeline.map((entry) => (
      entry.kind === "message" ? entry.item.id : `evidence:${entry.evidence.id}`
    ))).toEqual([
      "desktop-user-1",
      "desktop-assistant-1",
      "evidence:archived",
      "desktop-user-2",
      "current-tool",
    ]);
  });

  it("uses the newest terminal summary when a Bridge turn has duplicate evidence", () => {
    const items: BridgeHistoryItem[] = [
      {
        id: "user-1",
        sessionId: "session-1",
        turnId: "turn-1",
        role: "user",
        text: "Run",
        createdAt: 1,
        origin: "mobile",
      },
      {
        id: "assistant-1",
        sessionId: "session-1",
        turnId: "turn-1",
        role: "assistant",
        text: "Done",
        createdAt: 2,
        origin: "claude-host",
      },
    ];

    const timeline = conversationTimeline(items, [
      evidence("older", "turn-1", "failed", 1),
      evidence("newer", "turn-1", "ready", 3),
    ]);

    expect(timeline.at(-1)).toMatchObject({
      kind: "evidence",
      evidence: { id: "newer" },
    });
  });
});

describe("conversationItems", () => {
  it("does not render Claude interruption and resume sentinels from cached history or events", () => {
    const events: BridgeEvent[] = [
      {
        eventId: "event-1",
        seq: 1,
        timestamp: 3,
        origin: "claude-desktop",
        type: "session.observed",
        sessionId: "session-1",
        itemId: "observed-synthetic",
        data: { role: "assistant", text: "No response requested." },
      },
      {
        eventId: "event-2",
        seq: 2,
        timestamp: 4,
        origin: "claude-desktop",
        type: "session.observed",
        sessionId: "session-1",
        itemId: "observed-answer",
        data: { role: "assistant", text: "继续处理 P2。" },
      },
    ];
    const items = conversationItems("session-1", {
      status: "ready",
      hasMore: false,
      items: [
        {
          id: "history-interrupted",
          sessionId: "session-1",
          role: "user",
          text: "[Request interrupted by user]",
          createdAt: 1,
          origin: "claude-desktop",
        },
        {
          id: "history-user",
          sessionId: "session-1",
          role: "user",
          text: "继续推进 P2",
          createdAt: 2,
          origin: "mobile",
        },
      ],
    }, events, []);

    expect(items.map((item) => item.text)).toEqual(["继续推进 P2", "继续处理 P2。"]);
  });
});

describe("permissionPresentation", () => {
  it("summarizes a large Write request without rendering the full content", () => {
    const content = "const value = 1;\n".repeat(2_000);
    const permission: BridgePermissionInfo = {
      requestId: "permission-1",
      sessionId: "session-1",
      toolUseId: "tool-1",
      toolName: "Write",
      input: {
        file_path: "/Users/test/project/src/demo.ts",
        content,
      },
      createdAt: 1,
      canAllowAlways: true,
    };

    const presentation = permissionPresentation(permission);
    expect(presentation.mutating).toBe(true);
    expect(presentation.facts).toContainEqual({
      label: "目标",
      value: "/Users/test/project/src/demo.ts",
      code: true,
    });
    expect(presentation.preview?.value.length).toBeLessThan(content.length);
    expect(presentation.raw.length).toBeLessThan(content.length);
    expect(presentation.raw).toContain("已省略");
  });

  it("shows command and working directory for Bash approval", () => {
    const permission: BridgePermissionInfo = {
      requestId: "permission-2",
      sessionId: "session-1",
      toolUseId: "tool-2",
      toolName: "Bash",
      input: {
        command: "npm test",
        cwd: "/Users/test/project",
      },
      createdAt: 2,
      canAllowAlways: false,
    };

    expect(permissionPresentation(permission).facts).toEqual([
      { label: "命令", value: "npm test", code: true },
      { label: "目录", value: "/Users/test/project", code: true },
    ]);
  });
});
