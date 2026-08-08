import { describe, expect, it } from "vitest";
import { CODEX_DESKTOP_APP, desktopAppPathCandidates } from "./desktop-app-definitions.js";

describe("desktop app definitions", () => {
  it("recognizes the ChatGPT macOS bundle as the primary Codex desktop application", () => {
    expect(CODEX_DESKTOP_APP.darwinExecutableName).toBe("ChatGPT");
    expect(CODEX_DESKTOP_APP.darwinExecutableCandidates).toContain("Codex");
    expect(desktopAppPathCandidates(CODEX_DESKTOP_APP, {}, "/Users/test", "darwin")).toEqual([
      "/Applications/ChatGPT.app",
      "/Applications/Codex.app",
    ]);
  });
});
