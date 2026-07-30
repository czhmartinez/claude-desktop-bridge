import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { claudeRuntimePaths, connectorPaths, supportsClaudeDesktop } from "./platform.js";

describe("Windows Claude paths", () => {
  it("treats Windows and macOS as Claude Desktop hosts", () => {
    expect(supportsClaudeDesktop("darwin")).toBe(true);
    expect(supportsClaudeDesktop("win32")).toBe(true);
    expect(supportsClaudeDesktop("linux")).toBe(false);
  });

  it("uses roaming AppData for connector configuration", () => {
    const home = "/tmp/bridge-windows-home";
    const appData = "/tmp/bridge-windows-appdata";
    expect(connectorPaths("win32", { APPDATA: appData }, home)).toEqual({
      claudeDesktop: [
        join(appData, "Claude", "claude_desktop_config.json"),
        join(appData, "Claude-3p", "claude_desktop_config.json"),
      ],
      claudeCode: join(home, ".claude.json"),
      claudeSettings: join(home, ".claude", "settings.json"),
    });
  });

  it("keeps Claude Code state in the user profile and Desktop sessions in AppData", () => {
    const home = "/tmp/bridge-windows-home";
    const appData = "/tmp/bridge-windows-appdata";
    expect(claudeRuntimePaths("win32", { APPDATA: appData }, home)).toEqual({
      sessions: join(home, ".claude", "sessions"),
      tasks: join(home, ".claude", "tasks"),
      projects: join(home, ".claude", "projects"),
      desktopSessions: [
        join(appData, "Claude", "claude-code-sessions"),
        join(appData, "Claude-3p", "claude-code-sessions"),
      ],
    });
  });
});
