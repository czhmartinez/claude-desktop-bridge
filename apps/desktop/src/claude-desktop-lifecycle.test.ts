import { describe, expect, it, vi } from "vitest";
import { ClaudeDesktopLifecycle } from "./claude-desktop-lifecycle.js";

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
