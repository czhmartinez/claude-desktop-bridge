import { describe, expect, it } from "vitest";
import {
  CLAUDE_INTERRUPTED_USER_MESSAGE,
  CLAUDE_SYNTHETIC_NO_RESPONSE_MESSAGE,
  isClaudeTranscriptControlMessage,
} from "./transcript.js";

describe("Claude transcript control messages", () => {
  it("recognizes interruption and synthetic no-response sentinels", () => {
    expect(isClaudeTranscriptControlMessage("user", CLAUDE_INTERRUPTED_USER_MESSAGE)).toBe(true);
    expect(isClaudeTranscriptControlMessage("assistant", CLAUDE_SYNTHETIC_NO_RESPONSE_MESSAGE)).toBe(true);
    expect(isClaudeTranscriptControlMessage("assistant", ` ${CLAUDE_SYNTHETIC_NO_RESPONSE_MESSAGE}\n`)).toBe(true);
  });

  it("does not hide ordinary conversation text", () => {
    expect(isClaudeTranscriptControlMessage("user", "继续推进 P2")).toBe(false);
    expect(isClaudeTranscriptControlMessage("assistant", "继续处理。")).toBe(false);
    expect(isClaudeTranscriptControlMessage("user", CLAUDE_SYNTHETIC_NO_RESPONSE_MESSAGE)).toBe(false);
  });
});
