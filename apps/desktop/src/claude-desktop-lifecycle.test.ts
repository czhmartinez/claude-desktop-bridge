import { describe, expect, it, vi } from "vitest";
import {
  ClaudeDesktopLifecycle,
  findClaudeDesktopExecutable,
  parseClaudeDesktopTasklist,
} from "./claude-desktop-lifecycle.js";

describe("Claude Desktop lifecycle", () => {
  it("launches the installed app and reports its running state", async () => {
    let running = false;
    const launchApplication = vi.fn(async () => {
      running = true;
    });
    const lifecycle = new ClaudeDesktopLifecycle({
      platform: "darwin",
      applicationInstalled: async () => true,
      listMainProcessIds: async () => running ? [42] : [],
      launchApplication,
      sleep: async () => undefined,
      cacheTtlMs: 0,
    });

    await expect(lifecycle.status()).resolves.toMatchObject({
      state: "stopped",
      canLaunch: true,
      canQuit: false,
    });
    await expect(lifecycle.launch()).resolves.toMatchObject({
      state: "running",
      canLaunch: false,
      canQuit: true,
    });
    await lifecycle.launch();
    expect(launchApplication).toHaveBeenCalledTimes(1);
  });

  it("gracefully terminates only the Claude Desktop main process", async () => {
    let running = true;
    const signalProcess = vi.fn((pid: number) => {
      expect(pid).toBe(73);
      running = false;
    });
    const lifecycle = new ClaudeDesktopLifecycle({
      platform: "darwin",
      applicationInstalled: async () => true,
      listMainProcessIds: async () => running ? [73] : [],
      signalProcess,
      sleep: async () => undefined,
      cacheTtlMs: 0,
    });

    await expect(lifecycle.quit()).resolves.toMatchObject({
      state: "stopped",
      canLaunch: true,
      canQuit: false,
    });
    expect(signalProcess).toHaveBeenCalledOnce();
  });

  it("supports ordinary Claude Desktop launch and quit on Windows", async () => {
    let running = false;
    const launchApplication = vi.fn(async () => {
      running = true;
    });
    const signalProcess = vi.fn((pid: number) => {
      expect(pid).toBe(9136);
      running = false;
    });
    const lifecycle = new ClaudeDesktopLifecycle({
      platform: "win32",
      applicationInstalled: async () => true,
      listMainProcessIds: async () => running ? [9136] : [],
      launchApplication,
      signalProcess,
      sleep: async () => undefined,
      cacheTtlMs: 0,
    });

    await expect(lifecycle.launch()).resolves.toMatchObject({ state: "running" });
    await expect(lifecycle.quit()).resolves.toMatchObject({ state: "stopped" });
    expect(launchApplication).toHaveBeenCalledOnce();
    expect(signalProcess).toHaveBeenCalledOnce();
  });

  it("parses tasklist CSV rows without treating the summary line as a process", () => {
    expect(parseClaudeDesktopTasklist([
      '"Claude.exe","9136","Console","1","123,456 K"',
      '"other.exe","42","Console","1","8,192 K"',
      "INFO: No tasks are running which match the specified criteria.",
    ].join("\r\n"))).toEqual([9136]);
  });

  it("resolves the per-user Windows Claude Desktop install", () => {
    expect(findClaudeDesktopExecutable({
      LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
      ProgramFiles: "C:\\Program Files",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
    }, "C:\\Users\\me", "win32")).toBe(
      "C:\\Users\\me\\AppData\\Local\\Programs\\Claude\\Claude.exe",
    );
  });

  it("does not expose controls when Claude Desktop is unavailable", async () => {
    const lifecycle = new ClaudeDesktopLifecycle({
      platform: "linux",
      applicationInstalled: async () => true,
      cacheTtlMs: 0,
    });

    await expect(lifecycle.status()).resolves.toMatchObject({
      state: "unavailable",
      canLaunch: false,
      canQuit: false,
    });
    await expect(lifecycle.launch()).rejects.toThrow("当前平台暂不支持");
    await expect(lifecycle.quit()).rejects.toThrow("当前平台暂不支持");
  });

  it("does not guess that Claude Desktop is stopped when process inspection fails", async () => {
    const lifecycle = new ClaudeDesktopLifecycle({
      platform: "darwin",
      applicationInstalled: async () => true,
      listMainProcessIds: async () => {
        throw new Error("ps failed");
      },
      cacheTtlMs: 0,
    });

    await expect(lifecycle.status()).resolves.toMatchObject({
      state: "unavailable",
      canLaunch: false,
      canQuit: false,
    });
  });
});
