import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type {
  BridgeDesktopRegistrationInfo,
  BridgeEffort,
} from "@bridge/protocol";
import { findClaudeTranscriptFile } from "./claude-history.js";
import type { ClaudeRuntimePaths } from "./platform.js";

const execFile = promisify(execFileCallback);
const CLAUDE_MAIN = "/Applications/Claude.app/Contents/MacOS/Claude";
const CLAUDE_HELPER = "/Applications/Claude.app/Contents/Frameworks/Claude Helper";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TRANSCRIPT_PROBE_BYTES = 1024 * 1024;

interface ProcessRow {
  pid: number;
  ppid: number;
  command: string;
}

export interface ClaudeDesktopProfileProcess {
  pid: number;
  userDataDir: string;
}

export interface StoredDesktopRegistration extends BridgeDesktopRegistrationInfo {
  metadataPath?: string;
  metadataSha256?: string;
  profileSessionsRoot?: string;
  claudePidAtRegistration?: number;
}

export interface DesktopSessionRegistrationInput {
  sessionId: string;
  cwd: string;
  title: string;
  createdAt: number;
  lastActivityAt: number;
  model?: string;
  effort?: BridgeEffort;
}

export interface DesktopSessionRegistrationResult extends StoredDesktopRegistration {}

export interface ClaudeDesktopSessionRegistrarOptions {
  paths: ClaudeRuntimePaths;
  platform?: NodeJS.Platform;
  now?(): number;
  listProfiles?(): Promise<ClaudeDesktopProfileProcess[]>;
  findTranscript?(
    projectsRoot: string,
    sessionId: string,
    cwd?: string,
  ): Promise<string | undefined>;
}

class RegistrationUnavailableError extends Error {}

function parseRows(stdout: string): ProcessRow[] {
  return stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
    if (!match) return [];
    return [{
      pid: Number(match[1]),
      ppid: Number(match[2]),
      command: match[3]!,
    }];
  });
}

function userDataDirFromCommand(command: string): string | undefined {
  const match = /--user-data-dir=(.+?)(?=\s--|$)/u.exec(command);
  const value = match?.[1]?.trim();
  if (!value) return undefined;
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) return value.slice(1, -1);
  return value;
}

export function parseClaudeDesktopProfiles(stdout: string): ClaudeDesktopProfileProcess[] {
  const rows = parseRows(stdout);
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const mainPids = new Set(rows
    .filter((row) => row.command === CLAUDE_MAIN || row.command.startsWith(`${CLAUDE_MAIN} `))
    .map((row) => row.pid));
  const profiles = new Map<string, ClaudeDesktopProfileProcess>();
  for (const row of rows) {
    if (!row.command.includes(CLAUDE_HELPER)) continue;
    const userDataDir = userDataDirFromCommand(row.command);
    if (!userDataDir || !isAbsolute(userDataDir)) continue;
    let ancestor = row.ppid;
    const visited = new Set<number>();
    while (ancestor > 0 && !visited.has(ancestor) && !mainPids.has(ancestor)) {
      visited.add(ancestor);
      ancestor = byPid.get(ancestor)?.ppid ?? 0;
    }
    if (!mainPids.has(ancestor)) continue;
    profiles.set(`${ancestor}\0${normalize(userDataDir)}`, {
      pid: ancestor,
      userDataDir: normalize(userDataDir),
    });
  }
  return [...profiles.values()];
}

async function listRunningProfiles(): Promise<ClaudeDesktopProfileProcess[]> {
  if (process.platform !== "darwin") return [];
  const { stdout } = await execFile("/bin/ps", ["-axo", "pid=,ppid=,command="], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  return parseClaudeDesktopProfiles(stdout);
}

function isWithin(path: string, root: string): boolean {
  const value = relative(root, path);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function sha256(contents: string | Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

function publicRegistration(
  value: StoredDesktopRegistration,
): BridgeDesktopRegistrationInfo {
  return {
    state: value.state,
    detail: value.detail,
    updatedAt: value.updatedAt,
    ...(value.desktopSessionId ? { desktopSessionId: value.desktopSessionId } : {}),
    ...(value.registeredAt ? { registeredAt: value.registeredAt } : {}),
  };
}

function registrationChanged(
  left: StoredDesktopRegistration | undefined,
  right: StoredDesktopRegistration,
): boolean {
  return JSON.stringify(left) !== JSON.stringify(right);
}

export class ClaudeDesktopSessionRegistrar {
  private readonly now: () => number;
  private readonly profiles: () => Promise<ClaudeDesktopProfileProcess[]>;
  private readonly transcriptFinder: NonNullable<ClaudeDesktopSessionRegistrarOptions["findTranscript"]>;

  constructor(private readonly options: ClaudeDesktopSessionRegistrarOptions) {
    this.now = options.now ?? Date.now;
    this.profiles = options.listProfiles ?? listRunningProfiles;
    this.transcriptFinder = options.findTranscript ?? findClaudeTranscriptFile;
  }

  async register(
    input: DesktopSessionRegistrationInput,
    previous?: StoredDesktopRegistration,
  ): Promise<DesktopSessionRegistrationResult> {
    this.assertInput(input);
    const now = this.now();
    if ((this.options.platform ?? process.platform) !== "darwin") {
      return this.stableStatus(previous, {
        state: "unavailable",
        detail: "当前平台暂不支持登记 Claude Desktop 侧边栏。",
        updatedAt: now,
      });
    }

    if (previous?.metadataPath && previous.desktopSessionId) {
      const restored = await this.restoreExisting(input, previous);
      if (restored) return restored;
    }

    const transcriptPath = await this.transcriptFinder(
      this.options.paths.projects,
      input.sessionId,
      input.cwd,
    );
    if (!transcriptPath) {
      return this.stableStatus(previous, {
        state: "waiting-transcript",
        detail: "首轮消息写入后会自动登记到 Claude Desktop。",
        updatedAt: now,
      });
    }
    await this.validateTranscript(transcriptPath, input);

    let target: Awaited<ReturnType<ClaudeDesktopSessionRegistrar["activeTarget"]>>;
    try {
      target = await this.activeTarget();
    } catch (error) {
      if (error instanceof RegistrationUnavailableError) {
        return this.stableStatus(previous, {
          state: "unavailable",
          detail: error.message,
          updatedAt: now,
        });
      }
      throw error;
    }

    const desktopSessionId = `local_${input.sessionId}`;
    const existing = await this.findByCliSessionId(target.accountDir, input.sessionId);
    if (existing) {
      return {
        state: "registered",
        detail: "Claude Desktop 已登记这条 Bridge 会话。",
        desktopSessionId: existing.sessionId,
        registeredAt: previous?.registeredAt ?? now,
        updatedAt: now,
        metadataPath: existing.path,
        metadataSha256: existing.hash,
        profileSessionsRoot: target.sessionsRoot,
      };
    }

    const metadataPath = join(target.accountDir, `${desktopSessionId}.json`);
    const conflict = await this.readMetadata(metadataPath);
    if (conflict && (
      conflict.sessionId !== desktopSessionId ||
      conflict.cliSessionId !== input.sessionId
    )) {
      throw new Error("Claude Desktop 已存在同名但指向其他 transcript 的会话元数据");
    }
    if (conflict) {
      return {
        state: "registered",
        detail: "Claude Desktop 已登记这条 Bridge 会话。",
        desktopSessionId,
        registeredAt: previous?.registeredAt ?? now,
        updatedAt: now,
        metadataPath,
        metadataSha256: conflict.hash,
        profileSessionsRoot: target.sessionsRoot,
      };
    }

    const transcriptMetadata = await stat(transcriptPath);
    const lastActivityAt = Math.max(input.lastActivityAt, transcriptMetadata.mtimeMs);
    const metadata = {
      sessionId: desktopSessionId,
      cliSessionId: input.sessionId,
      cwd: input.cwd,
      originCwd: input.cwd,
      title: input.title,
      titleSource: "custom",
      createdAt: input.createdAt,
      lastActivityAt,
      lastFocusedAt: lastActivityAt,
      isArchived: false,
      ...(input.model ? { model: input.model } : {}),
      ...(input.effort ? { effort: input.effort } : {}),
      remoteMcpServersConfig: [],
    };
    const contents = `${JSON.stringify(metadata, null, 2)}\n`;
    await this.writeNewMetadata(target.accountDir, metadataPath, contents);
    return {
      state: "restart-required",
      detail: "已写入 Claude Desktop 会话清单，重启后可见。",
      desktopSessionId,
      registeredAt: now,
      updatedAt: now,
      metadataPath,
      metadataSha256: sha256(contents),
      profileSessionsRoot: target.sessionsRoot,
      claudePidAtRegistration: target.pid,
    };
  }

  async removeOwned(
    sessionId: string,
    registration: StoredDesktopRegistration,
  ): Promise<boolean> {
    if (
      !isUuid(sessionId) ||
      !registration.metadataPath ||
      registration.desktopSessionId !== `local_${sessionId}`
    ) return false;
    if (!await this.isTrustedMetadataPath(sessionId, registration.metadataPath)) return false;
    const current = await this.readMetadata(registration.metadataPath);
    if (
      !current ||
      current.sessionId !== registration.desktopSessionId ||
      current.cliSessionId !== sessionId
    ) return false;
    await unlink(registration.metadataPath);
    return true;
  }

  publicInfo(value: StoredDesktopRegistration): BridgeDesktopRegistrationInfo {
    return publicRegistration(value);
  }

  changed(
    left: StoredDesktopRegistration | undefined,
    right: StoredDesktopRegistration,
  ): boolean {
    return registrationChanged(left, right);
  }

  private assertInput(input: DesktopSessionRegistrationInput): void {
    if (!isUuid(input.sessionId)) throw new Error("Bridge session ID must be a UUID");
    if (!isAbsolute(input.cwd)) throw new Error("Bridge session cwd must be absolute");
    if (!input.title.trim()) throw new Error("Bridge session title is required");
    if (!Number.isFinite(input.createdAt) || !Number.isFinite(input.lastActivityAt)) {
      throw new Error("Bridge session timestamps are invalid");
    }
  }

  private async restoreExisting(
    input: DesktopSessionRegistrationInput,
    previous: StoredDesktopRegistration,
  ): Promise<DesktopSessionRegistrationResult | undefined> {
    if (!await this.isTrustedMetadataPath(input.sessionId, previous.metadataPath!)) {
      return undefined;
    }
    const current = await this.readMetadata(previous.metadataPath!);
    if (
      !current ||
      current.sessionId !== previous.desktopSessionId ||
      current.cliSessionId !== input.sessionId
    ) return undefined;
    const profiles = await this.profiles().catch(() => []);
    const active = profiles.find((profile) => (
      previous.profileSessionsRoot === join(profile.userDataDir, "claude-code-sessions")
    ));
    const stillNeedsRestart = previous.state === "restart-required" && (
      !active ||
      active.pid === previous.claudePidAtRegistration
    );
    const now = this.now();
    if (
      stillNeedsRestart &&
      previous.metadataSha256 === current.hash
    ) return previous;
    const restored: DesktopSessionRegistrationResult = {
      ...previous,
      state: stillNeedsRestart ? "restart-required" : "registered",
      detail: stillNeedsRestart
        ? "已写入 Claude Desktop 会话清单，重启后可见。"
        : "Claude Desktop 已登记这条 Bridge 会话。",
      updatedAt: now,
      metadataSha256: current.hash,
    };
    if (!stillNeedsRestart) delete restored.claudePidAtRegistration;
    return restored;
  }

  private stableStatus(
    previous: StoredDesktopRegistration | undefined,
    next: StoredDesktopRegistration,
  ): StoredDesktopRegistration {
    if (
      previous &&
      previous.state === next.state &&
      previous.detail === next.detail &&
      !previous.metadataPath
    ) return previous;
    return next;
  }

  private async activeTarget(): Promise<{
    pid: number;
    sessionsRoot: string;
    accountDir: string;
  }> {
    const profiles = await this.profiles().catch(() => []);
    const configuredRoots = new Map(this.options.paths.desktopSessions.map((root) => [
      resolve(root),
      root,
    ]));
    const candidates = profiles.flatMap((profile) => {
      const sessionsRoot = join(profile.userDataDir, "claude-code-sessions");
      return configuredRoots.has(resolve(sessionsRoot))
        ? [{ ...profile, sessionsRoot }]
        : [];
    });
    if (candidates.length === 0) {
      throw new RegistrationUnavailableError("启动 Claude Desktop 后将自动登记这条会话。");
    }
    const uniqueRoots = new Set(candidates.map((candidate) => resolve(candidate.sessionsRoot)));
    if (uniqueRoots.size !== 1) {
      throw new RegistrationUnavailableError("检测到多个 Claude Desktop 登录态，暂不自动写入。");
    }
    if (candidates.length !== 1) {
      throw new RegistrationUnavailableError("检测到多个 Claude Desktop 实例，暂不自动写入。");
    }
    const selected = candidates[0]!;
    const accountDir = await this.activeAccountDir(selected.sessionsRoot);
    return {
      pid: selected.pid,
      sessionsRoot: selected.sessionsRoot,
      accountDir,
    };
  }

  private async activeAccountDir(sessionsRoot: string): Promise<string> {
    const sessionRootReal = await realpath(sessionsRoot).catch(() => undefined);
    if (!sessionRootReal) {
      throw new RegistrationUnavailableError("Claude Desktop 尚未初始化本地会话目录。");
    }
    const candidates: Array<{ path: string; metadataFiles: string[] }> = [];
    for (const device of await readdir(sessionRootReal, { withFileTypes: true })) {
      if (!device.isDirectory() || device.isSymbolicLink()) continue;
      const devicePath = join(sessionRootReal, device.name);
      for (const account of await readdir(devicePath, { withFileTypes: true }).catch(() => [])) {
        if (!account.isDirectory() || account.isSymbolicLink()) continue;
        const path = join(devicePath, account.name);
        const metadataFiles = (await readdir(path).catch(() => []))
          .filter((name) => name.startsWith("local_") && name.endsWith(".json"));
        candidates.push({ path, metadataFiles });
      }
    }
    const withSessions = candidates.filter((candidate) => candidate.metadataFiles.length > 0);
    const eligible = withSessions.length > 0 ? withSessions : candidates;
    if (eligible.length !== 1) {
      throw new RegistrationUnavailableError(
        eligible.length === 0
          ? "Claude Desktop 尚未创建可识别的本地账号会话目录。"
          : "Claude Desktop 存在多个账号会话目录，暂不自动写入。",
      );
    }
    const selected = eligible[0]!;
    await this.assertMetadataSchema(selected.path, selected.metadataFiles);
    return selected.path;
  }

  private async assertMetadataSchema(accountDir: string, files: string[]): Promise<void> {
    if (files.length === 0) {
      throw new RegistrationUnavailableError("请先在 Claude Desktop 中创建一个本地会话以初始化元数据格式。");
    }
    let valid = false;
    for (const name of files.slice(-16)) {
      const metadata = await this.readMetadata(join(accountDir, name));
      if (
        metadata &&
        metadata.sessionId.startsWith("local_") &&
        isAbsolute(metadata.cwd) &&
        Boolean(metadata.cliSessionId && isUuid(metadata.cliSessionId)) &&
        typeof metadata.title === "string" &&
        typeof metadata.titleSource === "string" &&
        typeof metadata.createdAt === "number" &&
        typeof metadata.lastActivityAt === "number"
      ) {
        valid = true;
        break;
      }
    }
    if (!valid) {
      throw new RegistrationUnavailableError("当前 Claude Desktop 元数据格式无法安全识别。");
    }
  }

  private async validateTranscript(
    transcriptPath: string,
    input: DesktopSessionRegistrationInput,
  ): Promise<void> {
    const projectsRoot = await realpath(this.options.paths.projects).catch(() => undefined);
    const transcriptReal = await realpath(transcriptPath).catch(() => undefined);
    if (!projectsRoot || !transcriptReal || !isWithin(transcriptReal, projectsRoot)) {
      throw new Error("Claude transcript 不在受信任的 projects 目录内");
    }
    const metadata = await lstat(transcriptReal);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("Claude transcript 不是普通文件");
    }
    const handle = await open(transcriptReal, "r");
    const probe = Buffer.alloc(TRANSCRIPT_PROBE_BYTES);
    let bytesRead = 0;
    try {
      ({ bytesRead } = await handle.read(probe, 0, probe.byteLength, 0));
    } finally {
      await handle.close();
    }
    const text = probe.subarray(0, bytesRead).toString("utf8");
    let hasSessionId = false;
    let hasCwd = false;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line) as {
          sessionId?: unknown;
          session_id?: unknown;
          cwd?: unknown;
        };
        if (value.sessionId === input.sessionId || value.session_id === input.sessionId) {
          hasSessionId = true;
        }
        if (
          typeof value.cwd === "string" &&
          normalize(value.cwd) === normalize(input.cwd)
        ) {
          hasCwd = true;
        }
      } catch {
        // Ignore a bounded final record that may end mid-line.
      }
      if (hasSessionId && hasCwd) break;
    }
    if (!hasSessionId || !hasCwd) {
      throw new Error("Claude transcript 与 Bridge 会话标识或项目目录不一致");
    }
  }

  private async findByCliSessionId(
    accountDir: string,
    cliSessionId: string,
  ): Promise<{
    path: string;
    sessionId: string;
    hash: string;
  } | undefined> {
    const names = await readdir(accountDir);
    for (const name of names) {
      if (!name.startsWith("local_") || !name.endsWith(".json")) continue;
      const path = join(accountDir, name);
      const metadata = await this.readMetadata(path);
      if (metadata?.cliSessionId === cliSessionId) {
        return { path, sessionId: metadata.sessionId, hash: metadata.hash };
      }
    }
    return undefined;
  }

  private async readMetadata(path: string): Promise<{
    sessionId: string;
    cliSessionId?: string;
    cwd: string;
    title?: string;
    titleSource?: string;
    createdAt?: number;
    lastActivityAt?: number;
    hash: string;
  } | undefined> {
    try {
      const metadata = await lstat(path);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 2 * 1024 * 1024) {
        return undefined;
      }
      const contents = await readFile(path, "utf8");
      const value = JSON.parse(contents) as {
        sessionId?: unknown;
        cliSessionId?: unknown;
        cwd?: unknown;
        title?: unknown;
        titleSource?: unknown;
        createdAt?: unknown;
        lastActivityAt?: unknown;
      };
      if (
        typeof value.sessionId !== "string" ||
        typeof value.cwd !== "string" ||
        (value.cliSessionId !== undefined && typeof value.cliSessionId !== "string")
      ) return undefined;
      return {
        sessionId: value.sessionId,
        ...(value.cliSessionId ? { cliSessionId: value.cliSessionId } : {}),
        cwd: value.cwd,
        ...(typeof value.title === "string" ? { title: value.title } : {}),
        ...(typeof value.titleSource === "string"
          ? { titleSource: value.titleSource }
          : {}),
        ...(typeof value.createdAt === "number" ? { createdAt: value.createdAt } : {}),
        ...(typeof value.lastActivityAt === "number"
          ? { lastActivityAt: value.lastActivityAt }
          : {}),
        hash: sha256(contents),
      };
    } catch {
      return undefined;
    }
  }

  private async isTrustedMetadataPath(
    sessionId: string,
    metadataPath: string,
  ): Promise<boolean> {
    if (
      !isAbsolute(metadataPath) ||
      basename(metadataPath) !== `local_${sessionId}.json`
    ) return false;
    const parent = await realpath(join(metadataPath, "..")).catch(() => undefined);
    if (!parent) return false;
    const allowedRoots = await Promise.all(
      this.options.paths.desktopSessions.map(async (root) => (
        realpath(root).catch(() => resolve(root))
      )),
    );
    return allowedRoots.some((root) => isWithin(parent, root));
  }

  private async writeNewMetadata(
    accountDir: string,
    metadataPath: string,
    contents: string,
  ): Promise<void> {
    const rootReal = await realpath(accountDir);
    const parentReal = await realpath(join(metadataPath, ".."));
    if (rootReal !== parentReal) throw new Error("Claude Desktop 元数据目标目录校验失败");
    await mkdir(accountDir, { recursive: true, mode: 0o700 });
    const temporary = join(accountDir, `.bridge-${randomUUID()}.tmp`);
    await writeFile(temporary, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
    try {
      await link(temporary, metadataPath);
      await chmod(metadataPath, 0o600);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
}
