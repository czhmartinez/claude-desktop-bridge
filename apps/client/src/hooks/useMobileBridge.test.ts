import type { DecryptedEnvelope } from "@bridge/protocol";
import { describe, expect, it } from "vitest";
import { compactTimeline, type TimelineEntry } from "./useMobileBridge.js";

function entry(
  id: string,
  sentAt: number,
  payload: DecryptedEnvelope["payload"],
): TimelineEntry {
  return {
    direction: payload.kind === "command" ? "outgoing" : "incoming",
    header: {
      version: 1,
      id,
      roomId: "room",
      from: payload.kind === "command" ? "mobile" : "desktop",
      fromDeviceId: "device",
      to: payload.kind === "command" ? "desktop" : "mobile",
      sentAt,
      expiresAt: sentAt + 60_000,
    },
    payload,
  };
}

describe("mobile timeline compaction", () => {
  it("removes catalogs, transcript transport messages, and legacy repeated end notices", () => {
    const timeline = compactTimeline([
      entry("catalog", 1, {
        kind: "sessions",
        sessions: [{
          sessionId: "session-1",
          title: "EGA PMS",
          projectName: "ega-pms",
          state: "idle",
          lastActivityAt: 1,
        }],
      }),
      entry("history-request", 2, { kind: "history-request", sessionId: "session-1" }),
      entry("history", 3, {
        kind: "history",
        sessionId: "session-1",
        messages: [{ id: "assistant-1", role: "assistant", text: "历史回复", createdAt: 2 }],
        syncedAt: 3,
        available: true,
        truncated: false,
      }),
      entry("ended-1", 4, { kind: "status", message: "Claude 会话已结束。", sessionId: "session-1" }),
      entry("ended-2", 5, { kind: "status", message: "Claude 会话已结束!", sessionId: "session-1" }),
      entry("reply", 6, { kind: "status", message: "任务已经完成。", sessionId: "session-1" }),
    ]);

    expect(timeline.map((item) => item.header.id)).toEqual(["reply"]);
  });

  it("replaces only true snapshots for the same session and preserves normal replies", () => {
    const timeline = compactTimeline([
      entry("snapshot-old", 1, {
        kind: "status",
        step: "ega-pms",
        message: "当前：任务 A；已完成 1/3 项",
        progress: 33,
        sessionId: "session-1",
      }),
      entry("normal", 2, {
        kind: "status",
        step: "ega-pms",
        message: "已收到手机指令。",
        sessionId: "session-1",
      }),
      entry("snapshot-new", 3, {
        kind: "status",
        step: "ega-pms",
        message: "当前：任务 B；已完成 2/3 项",
        progress: 67,
        sessionId: "session-1",
      }),
      entry("other-session", 4, {
        kind: "status",
        step: "ega-pms",
        message: "已读取 Claude Desktop 历史，可从手机在 Bridge 后台继续。",
        sessionId: "session-2",
      }),
    ]);

    expect(timeline.map((item) => item.header.id)).toEqual([
      "normal",
      "snapshot-new",
      "other-session",
    ]);
  });

  it("collapses repeated desktop delivery notices while preserving the phone command", () => {
    const timeline = compactTimeline([
      entry("command", 1, {
        kind: "command",
        text: "调整项目进展入口",
        sessionId: "session-1",
      }),
      entry("delivery-1", 2, {
        kind: "status",
        step: "ega-pms",
        message: "已打开「ega-pms-1d」，指令正在发送。",
        sessionId: "session-1",
      }),
      entry("delivery-2", 3, {
        kind: "status",
        step: "ega-pms",
        message: "已打开「ega-pms-1d」，指令正在发送。",
        sessionId: "session-1",
      }),
      entry("delivery-other", 4, {
        kind: "status",
        step: "ega-pms",
        message: "已打开「ega-pms-1d」，指令正在发送。",
        sessionId: "session-2",
      }),
    ]);

    expect(timeline.map((item) => item.header.id)).toEqual([
      "command",
      "delivery-2",
      "delivery-other",
    ]);
  });
});
