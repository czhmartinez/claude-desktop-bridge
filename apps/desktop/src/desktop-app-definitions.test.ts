import { describe, expect, it } from "vitest";
import {
  CODEX_DESKTOP_APP,
  DSH_DESKTOP_APP,
  HERMES_DESKTOP_APP,
  desktopAppPathCandidates,
} from "./desktop-app-definitions.js";

describe("desktop app definitions", () => {
  it("recognizes the ChatGPT macOS bundle as the primary Codex desktop application", () => {
    expect(CODEX_DESKTOP_APP.darwinExecutableName).toBe("ChatGPT");
    expect(CODEX_DESKTOP_APP.darwinExecutableCandidates).toContain("Codex");
    expect(desktopAppPathCandidates(CODEX_DESKTOP_APP, {}, "/Users/test", "darwin")).toEqual([
      "/Applications/ChatGPT.app",
      "/Applications/Codex.app",
    ]);
  });

  it("recognizes the local Hermes desktop release bundle used by the installed agent", () => {
    expect(desktopAppPathCandidates(HERMES_DESKTOP_APP, {}, "/Users/test", "darwin")).toContain(
      "/Users/test/.hermes/hermes-agent/apps/desktop/release/mac-arm64/Hermes.app",
    );
  });

  it("finds DSH Desktop system-wide or per-user, with an env override for the Windows layout", () => {
    expect(desktopAppPathCandidates(DSH_DESKTOP_APP, {}, "/Users/test", "darwin")).toEqual([
      "/Applications/DSH Desktop.app",
      "/Users/test/Applications/DSH Desktop.app",
    ]);
    expect(desktopAppPathCandidates(
      DSH_DESKTOP_APP,
      { BRIDGE_DSH_DESKTOP_PATH: "D:\\Tools\\DSH Desktop.exe" },
      "C:\\Users\\test",
      "win32",
    )[0]).toBe("D:\\Tools\\DSH Desktop.exe");
  });
});
