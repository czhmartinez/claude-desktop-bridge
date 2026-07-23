import { describe, expect, it } from "vitest";
import { requiresAnthropicSignedCdpAuthorization } from "./claude-desktop-manager.js";

describe("requiresAnthropicSignedCdpAuthorization", () => {
  it("detects the signed Claude Desktop debugging guard", () => {
    const contents = Buffer.from([
      "remote-debugging-pipe",
      "CLAUDE_CDP_AUTH",
      "CLAUDE_USER_DATA_DIR",
    ].join("\0"));

    expect(requiresAnthropicSignedCdpAuthorization(contents)).toBe(true);
  });

  it("does not block a build that only mentions Electron debugging", () => {
    expect(requiresAnthropicSignedCdpAuthorization(
      Buffer.from("remote-debugging-pipe"),
    )).toBe(false);
  });
});
