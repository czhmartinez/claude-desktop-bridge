import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFile as execFileCallback, spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import type {
  BridgeRuntimeStatus,
  ClaudeDesktopIntegrationState,
} from "@bridge/protocol";
import type {
  ManagedDesktopHelperEvent,
  ManagedDesktopHelperRequest,
  ManagedDesktopHelperResponse,
  ManagedDesktopHelperStatus,
} from "./claude-desktop-helper-protocol.js";
import { findClaudeDesktopExecutable, parseClaudeDesktopTasklist } from "./claude-desktop-lifecycle.js";

const execFile = promisify(execFileCallback);
const CLAUDE_EXECUTABLE = "/Applications/Claude.app/Contents/MacOS/Claude";
const CLAUDE_BUNDLE = "/Applications/Claude.app";
const CLAUDE_ASAR = `${CLAUDE_BUNDLE}/Contents/Resources/app.asar`;
const EXPECTED_IDENTIFIER = "com.anthropic.claudefordesktop";
const EXPECTED_TEAM = "Q6L2SF6YDW";
const HELPER_CONNECTION_VERSION = 2 as const;
const SIGNED_CDP_MARKERS = [
  "CLAUDE_CDP_AUTH",
  "CLAUDE_USER_DATA_DIR",
  "remote-debugging-pipe",
] as const;

interface HelperConnectionFile {
  version: typeof HELPER_CONNECTION_VERSION;
  socketPath: string;
  token: string;
  helperPid: number;
  createdAt: number;
}

export interface ClaudeDesktopManagerOptions {
  userDataPath: string;
  helperEntryPath: string;
  enabled: boolean;
  hasActiveDesktopTask(): boolean;
  executablePath?: string;
  bridgeExecutablePath?: string;
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
}

export interface ClaudeDesktopIntegrationSnapshot {
  state: ClaudeDesktopIntegrationState;
  detail: string;
  enabled: boolean;
  canRestart: boolean;
  appVersion?: string;
  buildFingerprint?: string;
  lastError?: string;
}

type ManagerHelperRequest =
  | { method: "status" }
  | { method: "launch"; params: { executablePath: string; appVersion: string } }
  | { method: "call"; params: { name: string; args: unknown[] } }
  | { method: "stop" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStatus(value: unknown): ManagedDesktopHelperStatus {
  if (!isRecord(value) || typeof value.state !== "string" || typeof value.detail !== "string") {
    throw new Error("Managed Claude helper returned an invalid status");
  }
  return value as unknown as ManagedDesktopHelperStatus;
}

export function requiresAnthropicSignedCdpAuthorization(appAsar: Uint8Array): boolean {
  const contents = Buffer.from(appAsar.buffer, appAsar.byteOffset, appAsar.byteLength);
  return SIGNED_CDP_MARKERS.every((marker) => contents.includes(Buffer.from(marker)));
}

export class ClaudeDesktopManager extends EventEmitter {
  private enabledValue: boolean;
  private helper: HelperConnectionFile | undefined;
  private subscription: Socket | undefined;
  private statusValue: ManagedDesktopHelperStatus = {
    state: "not-managed",
    detail: "实验性 Claude Desktop 同步控制尚未启用。",
  };

  constructor(private readonly options: ClaudeDesktopManagerOptions) {
    super();
    this.enabledValue = options.enabled;
  }

  get ready(): boolean {
    return this.enabledValue && this.statusValue.state === "ready";
  }

  get enabled(): boolean {
    return this.enabledValue;
  }

  status(): ClaudeDesktopIntegrationSnapshot {
    const platform = this.options.platform ?? process.platform;
    return {
      state: this.enabledValue ? this.statusValue.state : "not-managed",
      detail: this.enabledValue
        ? this.statusValue.detail
        : "实验性 Claude Desktop 同步控制尚未启用。",
      enabled: this.enabledValue,
      canRestart: (platform === "darwin" || platform === "win32") && !this.options.hasActiveDesktopTask(),
      ...(this.statusValue.appVersion ? { appVersion: this.statusValue.appVersion } : {}),
      ...(this.statusValue.buildFingerprint ? { buildFingerprint: this.statusValue.buildFingerprint } : {}),
      ...(this.statusValue.lastError ? { lastError: this.statusValue.lastError } : {}),
    };
  }

  async initialize(): Promise<void> {
    if (!this.enabledValue) return;
    this.helper = await this.loadHelperFile();
    if (!this.helper) {
      if (await this.updateSignedCdpIncompatibility()) return;
      this.updateStatus({
        state: "disconnected",
        detail: "需要在本机点击“重启并连接”才能启用同步控制。",
      });
      return;
    }
    try {
      this.updateStatus(parseStatus(await this.request({ method: "status" })));
      this.subscribe();
    } catch {
      await this.clearStaleHelper();
      this.updateStatus({
        state: "disconnected",
        detail: "上次受管连接已经失效，请重新连接。",
      });
    }
  }

  async setEnabled(enabled: boolean): Promise<void> {
    this.enabledValue = enabled;
    if (!enabled) {
      this.subscription?.destroy();
      this.subscription = undefined;
      this.updateStatus({
        state: "not-managed",
        detail: "实验性 Claude Desktop 同步控制尚未启用。",
      });
    } else {
      await this.initialize();
    }
  }

  async restartManaged(): Promise<ClaudeDesktopIntegrationSnapshot> {
    if (!this.enabledValue) throw new Error("请先启用 Claude Desktop 同步控制实验功能。");
    const platform = this.options.platform ?? process.platform;
    if (platform !== "darwin" && platform !== "win32") {
      throw new Error("当前平台不支持 Claude Desktop 同步控制。");
    }
    if (this.options.hasActiveDesktopTask()) {
      throw new Error("Claude Desktop 仍有任务正在执行。请等待完成或在 Claude 中停止后再重启。");
    }
    const appVersion = await this.verifyClaudeApplication();
    if (await this.requiresSignedCdpAuthorization()) {
      this.updateStatus({
        state: "incompatible",
        detail: "当前 Claude Desktop 要求 Anthropic 签名授权的受管通道，Bridge 不会绕过签名或启动第二个会话进程。",
        appVersion,
        lastError: "Claude Desktop rejected unsigned --remote-debugging-pipe access (CLAUDE_CDP_AUTH required).",
      });
      return this.status();
    }
    await this.ensureOrdinaryClaudeStopped();
    await this.ensureHelper();
    this.updateStatus({
      state: "starting",
      detail: "正在启动受管 Claude Desktop。",
    });
    const status = parseStatus(await this.request({
      method: "launch",
      params: {
        executablePath: this.options.executablePath ?? this.defaultExecutablePath(platform),
        appVersion,
      },
    }, 45_000));
    this.updateStatus(status);
    this.subscribe();
    return this.status();
  }

  async stopClaudeForFallback(): Promise<void> {
    if (this.options.hasActiveDesktopTask()) {
      throw new Error("Claude Desktop 仍有任务正在执行。请等待全部任务完成或手动停止后再切换通道。");
    }
    if (this.helper) {
      await this.request({ method: "stop" }, 20_000);
      return;
    }
    await this.ensureOrdinaryClaudeStopped();
  }

  async call(method: string, args: unknown[] = []): Promise<unknown> {
    if (!this.ready) throw new Error("Claude Desktop 同步控制当前不可用");
    return this.request({ method: "call", params: { name: method, args } }, 30_000);
  }

  applyToRuntimeStatus(status: Omit<BridgeRuntimeStatus, "desktopIntegration">): BridgeRuntimeStatus {
    return { ...status, desktopIntegration: this.status() };
  }

  async close(): Promise<void> {
    this.subscription?.destroy();
    this.subscription = undefined;
  }

  private helperFilePath(): string {
    return join(this.options.userDataPath, "managed-claude", "helper.json");
  }

  private async loadHelperFile(): Promise<HelperConnectionFile | undefined> {
    try {
      const value = JSON.parse(await readFile(this.helperFilePath(), "utf8")) as Partial<HelperConnectionFile>;
      if (
        value.version !== HELPER_CONNECTION_VERSION ||
        typeof value.socketPath !== "string" ||
        typeof value.token !== "string" ||
        typeof value.helperPid !== "number" ||
        typeof value.createdAt !== "number"
      ) return undefined;
      return value as HelperConnectionFile;
    } catch {
      return undefined;
    }
  }

  private async ensureHelper(): Promise<void> {
    if (this.helper) {
      try {
        await this.request({ method: "status" }, 2_000);
        return;
      } catch {
        await this.clearStaleHelper();
      }
    }
    const platform = this.options.platform ?? process.platform;
    const directory = join(this.options.userDataPath, "managed-claude");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const token = randomBytes(32).toString("base64url");
    // macOS limits AF_UNIX paths to roughly 104 bytes. Application Support plus
    // a UUID exceeds that on a normal user account, so keep only the protected
    // connection file there and place the 0600 socket in a short 0700 temp dir.
    const socketDirectory = join(
      tmpdir(),
      `bridge-${createHash("sha256").update(this.options.userDataPath).digest("hex").slice(0, 10)}`,
    );
    const socketPath = platform === "win32"
      ? `\\\\.\\pipe\\bridge-${createHash("sha256")
          .update(this.options.userDataPath)
          .digest("hex")
          .slice(0, 10)}-${randomBytes(8).toString("hex")}`
      : join(socketDirectory, `h-${randomBytes(8).toString("hex")}.sock`);
    if (platform !== "win32") {
      await mkdir(socketDirectory, { recursive: true, mode: 0o700 });
      await chmod(socketDirectory, 0o700);
    }
    const bridgeExecutable = this.options.bridgeExecutablePath ?? process.execPath;
    const child = spawn(bridgeExecutable, [
      this.options.helperEntryPath,
      `--socket=${socketPath}`,
      `--token=${token}`,
    ], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...(this.options.environment ?? process.env), ELECTRON_RUN_AS_NODE: "1" },
    });
    if (!child.pid) throw new Error("无法启动 Claude Desktop 受管 helper");
    child.unref();
    this.helper = {
      version: HELPER_CONNECTION_VERSION,
      socketPath,
      token,
      helperPid: child.pid,
      createdAt: Date.now(),
    };
    await writeFile(this.helperFilePath(), `${JSON.stringify(this.helper, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(this.helperFilePath(), 0o600);
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      try {
        await this.request({ method: "status" }, 1_000);
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    throw new Error("Claude Desktop 受管 helper 启动超时");
  }

  private async clearStaleHelper(): Promise<void> {
    this.subscription?.destroy();
    this.subscription = undefined;
    const helper = this.helper;
    this.helper = undefined;
    await rm(this.helperFilePath(), { force: true });
    if (helper && !helper.socketPath.startsWith("\\\\.\\pipe\\")) {
      await rm(helper.socketPath, { force: true });
    }
  }

  private request(
    input: ManagerHelperRequest,
    timeoutMs = 10_000,
  ): Promise<unknown> {
    if (!this.helper) return Promise.reject(new Error("Managed Claude helper is unavailable"));
    const request = {
      ...input,
      id: randomUUID(),
      token: this.helper.token,
    } as ManagedDesktopHelperRequest;
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.helper!.socketPath);
      socket.setEncoding("utf8");
      let buffer = "";
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Managed Claude helper request timed out: ${input.method}`));
      }, timeoutMs);
      const finish = (error?: Error, value?: unknown) => {
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error);
        else resolve(value);
      };
      socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
      socket.once("error", (error) => finish(error));
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        try {
          const response = JSON.parse(buffer.slice(0, newline)) as ManagedDesktopHelperResponse;
          if (response.id !== request.id) throw new Error("Managed Claude helper response mismatch");
          if (!response.ok) throw new Error(response.error ?? "Managed Claude helper request failed");
          finish(undefined, response.result);
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
  }

  private subscribe(): void {
    if (!this.helper || this.subscription && !this.subscription.destroyed) return;
    const helper = this.helper;
    const socket = createConnection(helper.socketPath);
    this.subscription = socket;
    socket.setEncoding("utf8");
    let buffer = "";
    const request: ManagedDesktopHelperRequest = {
      id: randomUUID(),
      token: helper.token,
      method: "subscribe",
    };
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const raw = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        this.handleSubscriptionLine(raw, request.id);
        newline = buffer.indexOf("\n");
      }
    });
    socket.on("error", (error) => {
      this.updateStatus({
        state: "disconnected",
        detail: "Claude Desktop 受管 helper 已断开。",
        lastError: error.message,
      });
    });
    socket.on("close", () => {
      if (this.subscription === socket) this.subscription = undefined;
    });
  }

  private handleSubscriptionLine(raw: string, subscriptionId: string): void {
    try {
      const value = JSON.parse(raw) as ManagedDesktopHelperResponse | ManagedDesktopHelperEvent;
      if ("id" in value) {
        if (value.id !== subscriptionId || !value.ok) {
          throw new Error(value.error ?? "Managed Claude helper subscription failed");
        }
        this.updateStatus(parseStatus(value.result));
        return;
      }
      if (value.type === "status") this.updateStatus(parseStatus(value.data));
      else if (value.type === "session-event") this.emit("session-event", value.data);
      else if (value.type === "permission-request") this.emit("permission-request", value.data);
    } catch (error) {
      this.emit("protocol-error", error);
    }
  }

  private updateStatus(status: ManagedDesktopHelperStatus): void {
    this.statusValue = status;
    this.emit("status", this.status());
  }

  private async verifyClaudeApplication(): Promise<string> {
    const platform = this.options.platform ?? process.platform;
    const executable = this.options.executablePath ?? this.defaultExecutablePath(platform);
    if (platform === "win32") return this.verifyWindowsClaudeApplication(executable);
    if (executable !== CLAUDE_EXECUTABLE) throw new Error("Claude Desktop 必须安装在 /Applications。");
    const [{ stdout: identifier }, { stdout: version }, signature] = await Promise.all([
      execFile("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", `${CLAUDE_BUNDLE}/Contents/Info.plist`], {
        encoding: "utf8",
      }),
      execFile("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", `${CLAUDE_BUNDLE}/Contents/Info.plist`], {
        encoding: "utf8",
      }),
      execFile("/usr/bin/codesign", ["-dv", "--verbose=4", CLAUDE_BUNDLE], {
        encoding: "utf8",
      }),
    ]);
    if (identifier.trim() !== EXPECTED_IDENTIFIER) throw new Error("Claude Desktop Bundle ID 不匹配");
    if (!signature.stderr.includes(`TeamIdentifier=${EXPECTED_TEAM}`)) {
      throw new Error("Claude Desktop 签名不是受信任的 Anthropic 应用");
    }
    const appVersion = version.trim();
    if (!appVersion) throw new Error("无法读取 Claude Desktop 版本");
    return appVersion;
  }

  private async requiresSignedCdpAuthorization(): Promise<boolean> {
    const asarPath = this.claudeAsarPath();
    try {
      return requiresAnthropicSignedCdpAuthorization(await readFile(asarPath));
    } catch (readError) {
      // Electron's patched fs treats a path ending in .asar as a virtual
      // directory. Use the system grep as a read-only raw archive fallback.
      try {
        const matches = await Promise.all(SIGNED_CDP_MARKERS.map(async (marker) => {
          try {
            if ((this.options.platform ?? process.platform) === "win32") {
              const contents = await readFile(asarPath, "utf8");
              if (!contents.includes(marker)) throw Object.assign(new Error("marker missing"), { code: 1 });
              return true;
            }
            await execFile("/usr/bin/grep", ["-a", "-F", "-q", marker, asarPath]);
            return true;
          } catch (error) {
            if (isRecord(error) && (error.code === 1 || error.code === "1")) return false;
            throw error;
          }
        }));
        return matches.every(Boolean);
      } catch (grepError) {
        throw new Error(
          `无法检查 Claude Desktop 受管通道兼容性：${
            grepError instanceof Error
              ? grepError.message
              : readError instanceof Error
                ? readError.message
                : String(grepError)
          }`,
        );
      }
    }
  }

  private async updateSignedCdpIncompatibility(): Promise<boolean> {
    try {
      const appVersion = await this.verifyClaudeApplication();
      if (!await this.requiresSignedCdpAuthorization()) return false;
      this.updateStatus({
        state: "incompatible",
        detail: "当前 Claude Desktop 要求 Anthropic 签名授权的受管通道，Bridge 不会绕过签名或启动第二个会话进程。",
        appVersion,
        lastError: "Claude Desktop rejected unsigned --remote-debugging-pipe access (CLAUDE_CDP_AUTH required).",
      });
      return true;
    } catch (error) {
      this.updateStatus({
        state: "incompatible",
        detail: "无法验证当前 Claude Desktop 的受管通道兼容性。",
        lastError: error instanceof Error ? error.message : String(error),
      });
      return true;
    }
  }

  private async ordinaryClaudePids(): Promise<number[]> {
    const platform = this.options.platform ?? process.platform;
    if (platform === "win32") {
      try {
        const executable = this.options.executablePath ?? this.defaultExecutablePath(platform);
        const { stdout } = await execFile("tasklist", [
          "/FI",
          `IMAGENAME eq ${basename(executable)}`,
          "/FO",
          "CSV",
          "/NH",
        ], {
          encoding: "utf8",
          windowsHide: true,
        });
        const managedPid = this.statusValue.claudePid;
        return parseClaudeDesktopTasklist(stdout).filter((pid) => pid !== managedPid);
      } catch {
        return [];
      }
    }
    let stdout = "";
    try {
      ({ stdout } = await execFile("/bin/ps", ["-axo", "pid=,command="], { encoding: "utf8" }));
    } catch {
      return [];
    }
    const managedPid = this.statusValue.claudePid;
    return stdout.split("\n").flatMap((line) => {
      const match = /^\s*(\d+)\s+(.+)$/u.exec(line);
      if (!match) return [];
      const pid = Number(match[1]);
      const command = match[2]!.trim();
      return command.startsWith(CLAUDE_EXECUTABLE) && pid !== managedPid ? [pid] : [];
    });
  }

  private async ensureOrdinaryClaudeStopped(): Promise<void> {
    const pids = await this.ordinaryClaudePids();
    if (!pids.length) return;
    for (const pid of pids) {
      try {
        if ((this.options.platform ?? process.platform) === "win32") {
          const result = spawnSync("taskkill", ["/PID", String(pid), "/T"], {
            stdio: "ignore",
            windowsHide: true,
          });
          if (result.error) throw result.error;
        } else {
          process.kill(pid, "SIGTERM");
        }
      } catch {
        // A process that exited between discovery and signalling is already stopped.
      }
    }
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const remaining = await this.ordinaryClaudePids();
      if (!remaining.length) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("Claude Desktop 未能正常退出，请在电脑上手动关闭；Bridge 不会强制结束它。");
  }

  private defaultExecutablePath(platform: NodeJS.Platform): string {
    if (platform === "win32") {
      const executable = findClaudeDesktopExecutable(
        this.options.environment ?? process.env,
        undefined,
        platform,
      );
      if (!executable) throw new Error("未找到 Claude Desktop 可执行文件。");
      return executable;
    }
    return CLAUDE_EXECUTABLE;
  }

  private claudeAsarPath(): string {
    const platform = this.options.platform ?? process.platform;
    if (platform === "win32") {
      const executable = this.options.executablePath ?? this.defaultExecutablePath(platform);
      return join(dirname(executable), "resources", "app.asar");
    }
    return CLAUDE_ASAR;
  }

  private async verifyWindowsClaudeApplication(executable: string): Promise<string> {
    if (basename(executable).toLowerCase() !== "claude.exe") {
      throw new Error("Claude Desktop 必须使用 Claude.exe。");
    }
    const environment = this.options.environment ?? process.env;
    const resources = join(dirname(executable), "resources");
    const asarPath = join(resources, "app.asar");
    const contents = await readFile(asarPath);
    if (!contents.length) throw new Error("Claude Desktop resources/app.asar 为空。");
    const version = /"version"\s*:\s*"([0-9A-Za-z.+-]+)"/u.exec(contents.toString("utf8"))?.[1];
    if (!version) throw new Error("无法读取 Claude Desktop 版本。");
    try {
      const { stdout } = await execFile("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "$s = Get-AuthenticodeSignature -LiteralPath $env:BRIDGE_CLAUDE_PATH; [pscustomobject]@{Status=$s.Status; Subject=$s.SignerCertificate.Subject} | ConvertTo-Json -Compress",
      ], {
        encoding: "utf8",
        windowsHide: true,
        env: { ...environment, BRIDGE_CLAUDE_PATH: executable },
      });
      const signature = JSON.parse(stdout) as { Status?: unknown; Subject?: unknown };
      if (signature.Status !== "Valid" || typeof signature.Subject !== "string" || !signature.Subject.trim()) {
        throw new Error("Claude Desktop Authenticode 签名无效");
      }
    } catch (error) {
      throw new Error(`无法验证 Claude Desktop Authenticode 签名：${error instanceof Error ? error.message : String(error)}`);
    }
    return version;
  }
}
