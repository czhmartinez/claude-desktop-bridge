import type { BridgeEvent, BridgePermissionInfo } from "@bridge/protocol";
import { describe, expect, it } from "vitest";
import { conversationItems, permissionPresentation } from "./MobileWorkspace.js";

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
