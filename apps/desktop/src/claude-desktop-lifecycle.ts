import { execFile as execFileCallback, spawn, spawnSync } from "node:child_process";
import { access } from "node:fs/promises";
import { basename } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import type { ClaudeDesktopAppStatus } from "@bridge/protocol";
import {
  CLAUDE_DESKTOP_APP,
  desktopAppPathCandidates,
  type DesktopAppDefinition,
} from "./desktop-app-definitions.js";

const execFile = promisify(execFileCallback);

export interface ClaudeDesktopLifecycleOptions {
  definition?: DesktopAppDefinition;
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  executablePath?: string;
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

function darwinExecutable(definition: DesktopAppDefinition): string {
  const baseName = definition.win32ExecutableName.replace(/\.exe$/iu, "");
  return `${definition.darwinBundle}/Contents/MacOS/${baseName}`;
}

/** Resolve the ordinary Claude Desktop executable without touching private app state. */
export function findClaudeDesktopExecutable(
  environment: NodeJS.ProcessEnv = process.env,
  home = homedir(),
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  return desktopAppPathCandidates(CLAUDE_DESKTOP_APP, environment, home, platform)[0];
}

async function applicationInstalled(
  definition: DesktopAppDefinition,
  platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  executablePath?: string,
): Promise<boolean> {
  const candidate = platform === "win32"
    ? executablePath ?? desktopAppPathCandidates(definition, environment, homedir(), platform)[0]
    : definition.darwinBundle;
  if (!candidate) return false;
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

function parseWindowsTasklist(stdout: string, executableName = "Claude.exe"): number[] {
  const expected = executableName.toLowerCase();
  return stdout.split(/\r?\n/u).flatMap((line) => {
    const match = /^"([^"]+)","(\d+)"/u.exec(line.trim());
    if (!match || match[1]!.toLowerCase() !== expected) return [];
    return [Number(match[2])];
  });
}

export function parseClaudeDesktopTasklist(stdout: string): number[] {
  return parseWindowsTasklist(stdout);
}

async function listMainProcessIds(
  definition: DesktopAppDefinition,
  platform = process.platform,
  executablePath?: string,
  _environment: NodeJS.ProcessEnv = process.env,
): Promise<number[]> {
  if (platform === "win32") {
    const executableName = basename(executablePath ?? definition.win32ExecutableName);
    const { stdout } = await execFile(
      "tasklist",
      ["/FI", `IMAGENAME eq ${executableName}`, "/FO", "CSV", "/NH"],
      { encoding: "utf8", windowsHide: true },
    );
    return parseWindowsTasklist(stdout, executableName);
  }
  const executable = darwinExecutable(definition);
  const { stdout } = await execFile("/bin/ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  return stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(.+)$/u.exec(line);
    if (!match) return [];
    const command = match[2]!.trim();
    return command === executable || command.startsWith(`${executable} `)
      ? [Number(match[1])]
      : [];
  });
}

async function launchApplication(
  definition: DesktopAppDefinition,
  platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  executablePath?: string,
): Promise<void> {
  if (platform === "win32") {
    const executable = executablePath ?? desktopAppPathCandidates(definition, environment, homedir(), platform)[0];
    if (!executable) throw new Error(`未找到 ${definition.displayName} 可执行文件。`);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(executable, [], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: environment,
      });
      child.once("error", reject);
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    });
    return;
  }
  await execFile("/usr/bin/open", [definition.darwinBundle], { encoding: "utf8" });
}

function signalProcess(
  pid: number,
  platform = process.platform,
  _environment: NodeJS.ProcessEnv = process.env,
): void {
  if (platform === "win32") {
    const result = spawnSync("taskkill", ["/PID", String(pid), "/T"], {
      stdio: "ignore",
      windowsHide: true,
    });
    if (result.error) throw result.error;
    return;
  }
  process.kill(pid, "SIGTERM");
}

export class ClaudeDesktopLifecycle {
  private cached: CachedStatus | undefined;
  readonly definition: DesktopAppDefinition;

  constructor(private readonly options: ClaudeDesktopLifecycleOptions = {}) {
    this.definition = options.definition ?? CLAUDE_DESKTOP_APP;
  }

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

    const platform = this.options.platform ?? process.platform;
    const environment = this.options.environment ?? process.env;
    await (this.options.launchApplication ?? (() => launchApplication(
      this.definition,
      platform,
      environment,
      this.options.executablePath,
    )))();
    return this.waitForState("running", this.options.launchPollAttempts ?? 40);
  }

  async quit(): Promise<ClaudeDesktopAppStatus> {
    const current = await this.status(true);
    if (current.state === "unavailable") throw new Error(current.detail);
    if (current.state === "stopped") return current;

    const platform = this.options.platform ?? process.platform;
    const pids = await (this.options.listMainProcessIds ?? (() => listMainProcessIds(
      this.definition,
      platform,
      this.options.executablePath,
      this.options.environment ?? process.env,
    )))();
    for (const pid of pids) {
      try {
        (this.options.signalProcess ?? ((target) => signalProcess(
          target,
          platform,
          this.options.environment ?? process.env,
        )))(pid);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    return this.waitForState("stopped", this.options.quitPollAttempts ?? 60);
  }

  private async readStatus(): Promise<ClaudeDesktopAppStatus> {
    const name = this.definition.displayName;
    const platform = this.options.platform ?? process.platform;
    if (platform !== "darwin" && platform !== "win32") {
      return {
        state: "unavailable",
        detail: `当前平台暂不支持控制 ${name}。`,
        canLaunch: false,
        canQuit: false,
      };
    }
    const environment = this.options.environment ?? process.env;
    if (!await (this.options.applicationInstalled ?? (() => applicationInstalled(
      this.definition,
      platform,
      environment,
      this.options.executablePath,
    )))()) {
      return {
        state: "unavailable",
        detail: platform === "win32"
          ? `未找到 ${name} 可执行文件。`
          : `未在“应用程序”文件夹中找到 ${name}。`,
        canLaunch: false,
        canQuit: false,
      };
    }
    let running: boolean;
    try {
      running = (await (this.options.listMainProcessIds ?? (() => listMainProcessIds(
        this.definition,
        platform,
        this.options.executablePath,
        environment,
      )))()).length > 0;
    } catch {
      return {
        state: "unavailable",
        detail: `无法检查 ${name} 的运行状态。`,
        canLaunch: false,
        canQuit: false,
      };
    }
    return running
      ? {
          state: "running",
          detail: `${name} 正在运行。`,
          canLaunch: false,
          canQuit: true,
        }
      : {
          state: "stopped",
          detail: `${name} 已退出，Bridge 仍可继续处理远程会话。`,
          canLaunch: true,
          canQuit: false,
        };
  }

  private async waitForState(
    expected: "running" | "stopped",
    attempts: number,
  ): Promise<ClaudeDesktopAppStatus> {
    const name = this.definition.displayName;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const status = await this.status(true);
      if (status.state === expected) return status;
      await (this.options.sleep ?? ((durationMs) => (
        new Promise((resolve) => setTimeout(resolve, durationMs))
      )))(250);
    }
    throw new Error(expected === "running"
      ? `${name} 启动超时，请检查应用是否可以正常打开。`
      : `${name} 未能正常退出，请在应用中手动退出。`);
  }
}
