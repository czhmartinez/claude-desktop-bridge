import type { BridgeRuntimeHandoff } from "@bridge/protocol";
import { describe, expect, it } from "vitest";
import { runtimeHandoffPhase, selectPreviewHandoff } from "./RuntimeHandoffDialog.js";

function handoff(state: BridgeRuntimeHandoff["state"]): BridgeRuntimeHandoff {
  return {
    handoffId: `handoff-${state}`,
    state,
    sourceRuntimeId: "claude-desktop",
    sourceSessionId: "session-1",
    targetRuntimeId: "codex-desktop",
    objective: "继续维护个人主页",
    summary: "继续维护个人主页",
    createdAt: 1,
    updatedAt: 2,
  };
}

describe("runtimeHandoffPhase", () => {
  it("keeps the confirm UI reachable when the snapshot attaches a previewed handoff", () => {
    // Regression: a previewed handoff mapped to "progress" stranded the dialog
    // on 等待确认接力 with only 取消接力 and no way to accept the relay.
    expect(runtimeHandoffPhase(handoff("previewed"), true)).toBe("preview");
    expect(runtimeHandoffPhase(handoff("previewed"), false)).toBe("preview");
  });

  it("maps each server state to its dialog phase", () => {
    expect(runtimeHandoffPhase(undefined, false)).toBe("choose");
    expect(runtimeHandoffPhase(undefined, true)).toBe("preview");
    expect(runtimeHandoffPhase(handoff("preparing"), false)).toBe("progress");
    expect(runtimeHandoffPhase(handoff("planning"), false)).toBe("progress");
    expect(runtimeHandoffPhase(handoff("executing"), false)).toBe("progress");
    expect(runtimeHandoffPhase(handoff("plan-ready"), false)).toBe("plan");
    expect(runtimeHandoffPhase(handoff("applied"), false)).toBe("done");
    expect(runtimeHandoffPhase(handoff("failed"), false)).toBe("failed");
    expect(runtimeHandoffPhase(handoff("cancelled"), false)).toBe("choose");
  });
});

describe("selectPreviewHandoff", () => {
  it("prefers the rich local preview and falls back to the server handoff", () => {
    const server = handoff("previewed");
    expect(selectPreviewHandoff(undefined, server)).toBe(server);
    expect(selectPreviewHandoff(undefined, handoff("planning"))).toBeUndefined();
    const local = {
      handoff: handoff("previewed"),
      objectiveDraft: "draft",
      recentItemCount: 4,
      artifactCount: 1,
      workspaceDirty: false,
      promptBytes: 128,
    };
    expect(selectPreviewHandoff(local, server)).toBe(local.handoff);
  });
});
