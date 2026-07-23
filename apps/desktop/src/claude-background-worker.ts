import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { constants } from "node:fs";
import { BRIDGE_LOCAL_BASE_URL } from "./connector.js";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 12 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 2 * 60 * 60 * 1_000;
const AUTHENTICATED_RECHECK_MS = 60_000;
const UNAUTHENTICATED_RECHECK_MS = 5_000;
const HOST_CREDENTIAL_SCAN_MS = 30_000;

export type ClaudeWorkerErrorKind =
  | "auth-required"
  | "session-not-found"
  | "permission-denied"
  | "timeout"
  | "unavailable"
  | "failed";

export interface ClaudeWorkerLease {
  commandId: string;
  text: string;
  sourceSessionId: string;
  resumeSessionId: string;
  cwd: string;
  projectName: string;
  forkSession: boolean;
}

export interface ClaudeWorkerResult {
  ok: boolean;
  summary?: string;
  sessionId?: string;
  errorKind?: ClaudeWorkerErrorKind;
  error?: string;
  resumedFromSource: boolean;
}

interface ClaudeJsonResult {
  result?: unknown;
  session_id?: unknown;
  is_error?: unknown;
  subtype?: unknown;
}

interface BackgroundWorkerOptions {
  authorization: string;
  baseUrl?: string;
  environment?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  executable?: string;
  runCommand?: typeof runClaudeBackgroundCommand;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function executable(path: string): Promise<boolean> {
  return access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK)
    .then(() => true, () => false);
}

function defaultHostCredentialRoots(home: string, environment: NodeJS.ProcessEnv): string[] {
  if (process.platform === "darwin") {
    return [
      join(home, "Library", "Application Support", "Claude-3p"),
      join(home, "Library", "Application Support", "Claude"),
    ];
  }
  if (process.platform === "win32") {
    const appData = environment.APPDATA ?? join(home, "AppData", "Roaming");
    return [join(appData, "Claude-3p"), join(appData, "Claude")];
  }
  const configHome = environment.XDG_CONFIG_HOME ?? join(home, ".config");
  return [join(configHome, "Claude-3p"), join(configHome, "Claude")];
}

async function secureCredentialFile(path: string): Promise<{ path: string; mtimeMs: number } | undefined> {
  try {
    const metadata = await stat(path);
    if (!metadata.isFile()) return undefined;
    if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) return undefined;
    await access(path, constants.R_OK);
    return { path, mtimeMs: metadata.mtimeMs };
  } catch {
    return undefined;
  }
}

export async function findClaudeHostCredentials(
  environment: NodeJS.ProcessEnv = process.env,
  home = homedir(),
  roots = defaultHostCredentialRoots(home, environment),
): Promise<string | undefined> {
  if (environment.CLAUDE_CODE_HOST_CREDS_FILE) {
    const explicit = await secureCredentialFile(environment.CLAUDE_CODE_HOST_CREDS_FILE);
    if (explicit) return explicit.path;
  }
  const candidates: Array<{ path: string; mtimeMs: number }> = [];
  for (const root of roots) {
    let names: string[];
    try { names = await readdir(root); } catch { continue; }
    for (const name of names) {
      if (!/^host-creds-[a-z0-9-]+\.json$/iu.test(name)) continue;
      const candidate = await secureCredentialFile(join(root, name));
      if (candidate) candidates.push(candidate);
    }
  }
  return candidates.sort((left, right) => right.mtimeMs - left.mtimeMs)[0]?.path;
}

export function applyClaudeHostCredentials(environment: NodeJS.ProcessEnv, path: string): void {
  environment.CLAUDE_CODE_HOST_CREDS_FILE = path;
  environment.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = "1";
  environment.CLAUDE_CODE_HOST_AUTH_ENV_VAR = "ANTHROPIC_AUTH_TOKEN";
  environment.CLAUDE_CODE_HOST_SESSION_ID ??= `bridge-${process.pid}`;
  environment.CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH = "1";
}

async function desktopBundledCandidates(home: string): Promise<string[]> {
  if (process.platform !== "darwin") return [];
  const roots = [
    join(home, "Library", "Application Support", "Claude-3p", "claude-code"),
    join(home, "Library", "Application Support", "Claude", "claude-code"),
  ];
  const candidates: string[] = [];
  for (const root of roots) {
    let versions: string[];
    try {
      versions = (await readdir(root)).sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
    } catch {
      continue;
    }
    for (const version of versions) {
      candidates.push(join(root, version, "claude.app", "Contents", "MacOS", "claude"));
    }
  }
  return candidates;
}

export async function findClaudeExecutable(
  environment: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): Promise<string | undefined> {
  const names = process.platform === "win32" ? ["claude.exe", "claude.cmd", "claude"] : ["claude"];
  const pathCandidates = (environment.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .flatMap((directory) => names.map((name) => join(directory, name)));
  const explicit = [environment.BRIDGE_CLAUDE_PATH, environment.CLAUDE_CODE_EXECUTABLE]
    .filter((value): value is string => Boolean(value));
  const local = process.platform === "win32"
    ? [join(home, ".local", "bin", "claude.exe"), join(home, ".local", "bin", "claude.cmd")]
    : [join(home, ".local", "bin", "claude"), join(home, ".claude", "local", "claude")];
  const bundled = await desktopBundledCandidates(home);
  for (const candidate of [...explicit, ...bundled, ...local, ...pathCandidates]) {
    if (await executable(candidate)) return candidate;
  }
  return undefined;
}

function classifyFailure(message: string): ClaudeWorkerErrorKind {
  if (/not logged in|run \/login|auth(?:entication)? required|invalid.*(?:token|api key)|unauthorized/iu.test(message)) {
    return "auth-required";
  }
  if (/session.*(?:not found|does not exist|unknown)|no conversation found|could not find.*session/iu.test(message)) {
    return "session-not-found";
  }
  if (/permission|not allowed|access denied/iu.test(message)) return "permission-denied";
  return "failed";
}

function parseClaudeResult(stdout: string, stderr: string, exitCode: number | null): ClaudeWorkerResult {
  const trimmed = stdout.trim();
  let value: ClaudeJsonResult | undefined;
  try {
    value = JSON.parse(trimmed) as ClaudeJsonResult;
  } catch {
    const lastJsonLine = trimmed.split(/\r?\n/u).reverse().find((line) => line.trim().startsWith("{"));
    if (lastJsonLine) {
      try { value = JSON.parse(lastJsonLine) as ClaudeJsonResult; } catch { value = undefined; }
    }
  }
  const result = typeof value?.result === "string" ? value.result.trim() : "";
  const sessionId = typeof value?.session_id === "string" ? value.session_id : undefined;
  if (exitCode === 0 && value?.is_error !== true) {
    return {
      ok: true,
      summary: result || "Claude 已完成这条指令。",
      ...(sessionId ? { sessionId } : {}),
      resumedFromSource: true,
    };
  }
  const message = [result, stderr.trim(), trimmed].filter(Boolean).join("\n").slice(0, 4_000);
  return {
    ok: false,
    errorKind: classifyFailure(message),
    error: message || `Claude Code exited with status ${exitCode ?? "unknown"}`,
    resumedFromSource: true,
  };
}

async function executeClaude(
  executablePath: string,
  lease: ClaudeWorkerLease,
  environment: NodeJS.ProcessEnv,
  resumeSessionId?: string,
  forkSession = false,
): Promise<ClaudeWorkerResult> {
  const args = buildClaudeCommandArgs(lease, resumeSessionId, forkSession);
  return new Promise((resolve) => {
    const child = spawn(executablePath, args, {
      cwd: lease.cwd,
      env: {
        ...environment,
        CLAUDE_CODE_ENTRYPOINT: "claude-bridge",
        BRIDGE_BACKGROUND_WORKER: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: ClaudeWorkerResult) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve(result);
    };
    const collect = (target: Buffer[]) => (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += buffer.byteLength;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        child.kill("SIGTERM");
        finish({
          ok: false,
          errorKind: "failed",
          error: "Claude Code produced more output than Bridge can safely retain.",
          resumedFromSource: true,
        });
        return;
      }
      target.push(buffer);
    };
    child.stdout?.on("data", collect(stdout));
    child.stderr?.on("data", collect(stderr));
    child.once("error", (error) => finish({
      ok: false,
      errorKind: error.message.includes("ENOENT") ? "unavailable" : "failed",
      error: error.message,
      resumedFromSource: true,
    }));
    child.once("close", (code) => finish(parseClaudeResult(
      Buffer.concat(stdout).toString("utf8"),
      Buffer.concat(stderr).toString("utf8"),
      code,
    )));
    timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish({
        ok: false,
        errorKind: "timeout",
        error: "Claude Code did not finish before the Bridge timeout.",
        resumedFromSource: true,
      });
    }, COMMAND_TIMEOUT_MS);
  });
}

export function buildClaudeWorkerEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const workerEnvironment: NodeJS.ProcessEnv = {
    ...environment,
    CLAUDE_CODE_ENTRYPOINT: "claude-bridge",
    BRIDGE_BACKGROUND_WORKER: "1",
  };
  // Claude Desktop launches MCP servers inside a Claude Code process. The
  // nested-session guard must not leak into Bridge's separate headless worker.
  delete workerEnvironment.CLAUDECODE;
  return workerEnvironment;
}

export function buildClaudeCommandArgs(
  lease: ClaudeWorkerLease,
  resumeSessionId: string | undefined = lease.resumeSessionId,
  forkSession = lease.forkSession,
): string[] {
  const args = [
    "-p",
    lease.text,
    "--output-format", "json",
    "--permission-mode", "acceptEdits",
  ];
  if (resumeSessionId) args.push("--resume", resumeSessionId);
  if (forkSession) args.push("--fork-session");
  return args;
}

export async function runClaudeBackgroundCommand(
  executablePath: string,
  lease: ClaudeWorkerLease,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ClaudeWorkerResult> {
  const resumed = await executeClaude(
    executablePath,
    lease,
    environment,
    lease.resumeSessionId,
    lease.forkSession,
  );
  if (resumed.ok || resumed.errorKind !== "session-not-found") return resumed;
  const fresh = await executeClaude(executablePath, lease, environment);
  return { ...fresh, resumedFromSource: false };
}

async function readClaudeVersion(executablePath: string, environment: NodeJS.ProcessEnv): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(executablePath, ["--version"], {
      env: environment,
      timeout: 8_000,
      maxBuffer: 64 * 1024,
    });
    return stdout.trim().slice(0, 100) || undefined;
  } catch {
    return undefined;
  }
}

export async function hasClaudeTransportAuthentication(environment: NodeJS.ProcessEnv): Promise<boolean> {
  if (
    environment.ANTHROPIC_API_KEY ||
    environment.ANTHROPIC_AUTH_TOKEN ||
    (environment.CLAUDE_CODE_HOST_CREDS_FILE
      && await access(environment.CLAUDE_CODE_HOST_CREDS_FILE, constants.R_OK).then(() => true, () => false))
  ) return true;
  return false;
}

export class ClaudeBackgroundWorker {
  private readonly workerId = randomUUID();
  private readonly authorization: string;
  private readonly baseUrl: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly fetchImpl: typeof fetch;
  private readonly configuredExecutable: string | undefined;
  private readonly runCommand: typeof runClaudeBackgroundCommand;
  private executablePath: string | undefined;
  private version: string | undefined;
  private authenticated = false;
  private lastAuthCheckAt = 0;
  private lastHostCredentialScanAt = 0;
  private autoHostCredentials = false;
  private stopped = false;
  private loop: Promise<void> | undefined;

  constructor(options: BackgroundWorkerOptions) {
    this.authorization = options.authorization;
    this.baseUrl = options.baseUrl ?? BRIDGE_LOCAL_BASE_URL;
    this.environment = buildClaudeWorkerEnvironment(options.environment ?? process.env);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.configuredExecutable = options.executable;
    this.runCommand = options.runCommand ?? runClaudeBackgroundCommand;
  }

  start(): void {
    if (this.loop) return;
    this.loop = this.run();
  }

  async close(): Promise<void> {
    this.stopped = true;
    await this.loop;
  }

  private async post(path: string, body: Record<string, unknown>, timeoutMs = 30_000): Promise<Response> {
    return this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: this.authorization,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      try {
        if (
          !this.environment.CLAUDE_CODE_HOST_CREDS_FILE
          && Date.now() - this.lastHostCredentialScanAt >= HOST_CREDENTIAL_SCAN_MS
        ) {
          this.lastHostCredentialScanAt = Date.now();
          const hostCredentials = await findClaudeHostCredentials(this.environment);
          if (hostCredentials) {
            applyClaudeHostCredentials(this.environment, hostCredentials);
            this.autoHostCredentials = true;
            this.lastAuthCheckAt = 0;
          }
        }
        this.executablePath ??= this.configuredExecutable ?? await findClaudeExecutable(this.environment);
        const authInterval = this.authenticated ? AUTHENTICATED_RECHECK_MS : UNAUTHENTICATED_RECHECK_MS;
        const authStale = Date.now() - this.lastAuthCheckAt >= authInterval;
        if (this.executablePath && (!this.version || authStale)) {
          const [version, authenticated] = await Promise.all([
            this.version ? Promise.resolve(this.version) : readClaudeVersion(this.executablePath, this.environment),
            hasClaudeTransportAuthentication(this.environment),
          ]);
          this.version = version;
          this.authenticated = authenticated;
          this.lastAuthCheckAt = Date.now();
        }
        const response = await this.post("/workers/lease", {
          workerId: this.workerId,
          available: Boolean(this.executablePath),
          authenticated: this.authenticated,
          ...(this.version ? { version: this.version } : {}),
        });
        if (!response.ok) throw new Error(`coordinator_${response.status}`);
        const value = await response.json() as { lease?: ClaudeWorkerLease | null };
        if (!value.lease || !this.executablePath) {
          await wait(1_500);
          continue;
        }
        const lease = value.lease;
        const heartbeat = setInterval(() => {
          void this.post("/workers/heartbeat", {
            workerId: this.workerId,
            commandId: lease.commandId,
          }, 8_000).catch(() => undefined);
        }, 20_000);
        let result: ClaudeWorkerResult;
        try {
          result = await this.runCommand(this.executablePath, lease, this.environment);
        } finally {
          clearInterval(heartbeat);
        }
        if (result.errorKind === "auth-required") {
          this.authenticated = false;
          this.lastAuthCheckAt = Date.now();
          if (this.autoHostCredentials) {
            delete this.environment.CLAUDE_CODE_HOST_CREDS_FILE;
            this.autoHostCredentials = false;
            this.lastHostCredentialScanAt = Date.now();
          }
        }
        await this.post("/workers/result", {
          workerId: this.workerId,
          commandId: lease.commandId,
          ...result,
        });
      } catch {
        await wait(2_500);
      }
    }
  }
}
