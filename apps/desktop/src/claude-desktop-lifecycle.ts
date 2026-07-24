import { execFile as execFileCallback } from "node:child_process";
import { access } from "node:fs/promises";
import { promisify } from "node:util";
import type { ClaudeDesktopAppStatus } from "@bridge/protocol";

const execFile = promisify(execFileCallback);
const CLAUDE_BUNDLE = "/Applications/Claude.app";
const CLAUDE_EXECUTABLE = `${CLAUDE_BUNDLE}/Contents/MacOS/Claude`;

export interface ClaudeDesktopLifecycleOptions {
  platform?: NodeJS.Platform;
  applicationInstalled?(): Promise<boolean>;
  listMainProcessIds?(): Promise<number[]>;
  launchApplication?(): Promise<void>;
  signalProcess?(pid: number): void;
  sleep?(durationMs: number): Promise<void>;
  launchPollAttempts?: number;
  quitPollAttempts?: number;
  cacheTtlMs?: number;
}

interface CachedStatus {
  value: ClaudeDesktopAppStatus;
  observedAt: number;
}

async function applicationInstalled(): Promise<boolean> {
  try {
    await access(CLAUDE_BUNDLE);
    return true;
  } catch {
    return false;
  }
}

async function listMainProcessIds(): Promise<number[]> {
  const { stdout } = await execFile("/bin/ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  return stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(.+)$/u.exec(line);
    if (!match) return [];
    const command = match[2]!.trim();
    return command === CLAUDE_EXECUTABLE || command.startsWith(`${CLAUDE_EXECUTABLE} `)
      ? [Number(match[1])]
      : [];
  });
}

async function launchApplication(): Promise<void> {
  await execFile("/usr/bin/open", [CLAUDE_BUNDLE], { encoding: "utf8" });
}

export class ClaudeDesktopLifecycle {
  private cached: CachedStatus | undefined;

  constructor(private readonly options: ClaudeDesktopLifecycleOptions = {}) {}

  async status(force = false): Promise<ClaudeDesktopAppStatus> {
    const cacheTtlMs = this.options.cacheTtlMs ?? 1_000;
    if (!force && this.cached && Date.now() - this.cached.observedAt < cacheTtlMs) {
      return this.cached.value;
    }
    const value = await this.readStatus();
    this.cached = { value, observedAt: Date.now() };
    return value;
  }

  async launch(): Promise<ClaudeDesktopAppStatus> {
    const current = await this.status(true);
    if (current.state === "unavailable") throw new Error(current.detail);
    if (current.state === "running") return current;

    await (this.options.launchApplication ?? launchApplication)();
    return this.waitForState("running", this.options.launchPollAttempts ?? 40);
  }

  async quit(): Promise<ClaudeDesktopAppStatus> {
    const current = await this.status(true);
    if (current.state === "unavailable") throw new Error(current.detail);
    if (current.state === "stopped") return current;

    const pids = await (this.options.listMainProcessIds ?? listMainProcessIds)();
    for (const pid of pids) {
      try {
        (this.options.signalProcess ?? ((target) => process.kill(target, "SIGTERM")))(pid);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    return this.waitForState("stopped", this.options.quitPollAttempts ?? 60);
  }

  private async readStatus(): Promise<ClaudeDesktopAppStatus> {
    if ((this.options.platform ?? process.platform) !== "darwin") {
      return {
        state: "unavailable",
        detail: "当前平台暂不支持控制 Claude Desktop。",
        canLaunch: false,
        canQuit: false,
      };
    }
    if (!await (this.options.applicationInstalled ?? applicationInstalled)()) {
      return {
        state: "unavailable",
        detail: "未在“应用程序”文件夹中找到 Claude Desktop。",
        canLaunch: false,
        canQuit: false,
      };
    }
    let running: boolean;
    try {
      running = (await (this.options.listMainProcessIds ?? listMainProcessIds)()).length > 0;
    } catch {
      return {
        state: "unavailable",
        detail: "无法检查 Claude Desktop 的运行状态。",
        canLaunch: false,
        canQuit: false,
      };
    }
    return running
      ? {
          state: "running",
          detail: "Claude Desktop 正在运行。",
          canLaunch: false,
          canQuit: true,
        }
      : {
          state: "stopped",
          detail: "Claude Desktop 已退出，Bridge 仍可继续处理远程会话。",
          canLaunch: true,
          canQuit: false,
        };
  }

  private async waitForState(
    expected: "running" | "stopped",
    attempts: number,
  ): Promise<ClaudeDesktopAppStatus> {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const status = await this.status(true);
      if (status.state === expected) return status;
      await (this.options.sleep ?? ((durationMs) => (
        new Promise((resolve) => setTimeout(resolve, durationMs))
      )))(250);
    }
    throw new Error(expected === "running"
      ? "Claude Desktop 启动超时，请检查应用是否可以正常打开。"
      : "Claude Desktop 未能正常退出，请在应用中手动退出。");
  }
}
