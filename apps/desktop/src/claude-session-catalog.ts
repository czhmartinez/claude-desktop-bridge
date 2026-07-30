import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, win32 as windowsPath } from "node:path";
import { promisify } from "node:util";
import type { BridgeProjectInfo, BridgeSessionInfo } from "@bridge/protocol";
import {
  listClaudeDesktopSessions,
  type ClaudeDesktopProfile,
  type ClaudeSessionEffort,
} from "./claude-desktop-sessions.js";
import { findClaudeTranscriptFile } from "./claude-history.js";
import type { ClaudeRuntimePaths } from "./platform.js";

interface ActiveSessionFile {
  pid?: unknown;
  sessionId?: unknown;
  cwd?: unknown;
  startedAt?: unknown;
  entrypoint?: unknown;
  peerProtocol?: unknown;
}

export interface ActiveClaudeProcess {
  pid?: number;
  cwd?: string;
  startedAt: number;
  processAlive: boolean;
  entrypoint: string;
  peerProtocol?: string;
  source: "registration" | "process";
}

export interface ObservedClaudeSession extends BridgeSessionInfo {
  transcriptPath?: string;
  transcriptMtimeMs: number;
  processAlive: boolean;
  desktopProcessAlive: boolean;
  bridgeProcessAlive: boolean;
  processOverlap: boolean;
  activeProcesses: ActiveClaudeProcess[];
  activeTask: boolean;
  hostModel?: string;
  hostEffort?: ClaudeSessionEffort;
  sourceProfile?: ClaudeDesktopProfile;
  hostUltracode?: boolean;
}

export interface ClaudeCatalogSnapshot {
  projects: BridgeProjectInfo[];
  sessions: ObservedClaudeSession[];
  observedAt: number;
}

export function projectIdForCwd(cwd: string, platform = process.platform): string {
  const key = platform === "win32" ? windowsPath.normalize(cwd).toLowerCase() : cwd;
  return createHash("sha256").update(key).digest("base64url").slice(0, 18);
}

const execFile = promisify(execFileCallback);
const WINDOWS_PROCESS_QUERY = [
  "Get-CimInstance Win32_Process |",
  "Select-Object ProcessId,ParentProcessId,Name,CommandLine |",
  "ConvertTo-Json -Compress",
].join(" ");

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function entrypointFromAncestors(
  pid: number,
  processes: Map<number, { ppid: number; command: string }>,
  platform = process.platform,
): string {
  let current = processes.get(pid);
  const visited = new Set<number>();
  while (current && !visited.has(current.ppid)) {
    visited.add(current.ppid);
    const command = current.command;
    if (platform === "win32"
      ? /(?:\\|\/)(?:Programs[\\/])?(?:Claude|AnthropicClaude)[\\/]Claude\.exe(?:\s|$)/iu.test(command)
      : /\/Applications\/Claude\.app\/Contents\/MacOS\/Claude(?:\s|$)/u.test(command)) {
      return "claude-desktop-3p";
    }
    if (platform === "win32"
      ? /(?:Bridge|claude-bridge)(?:\.exe)?/iu.test(command)
      : /Claude Bridge|\/Bridge\.app\/|claude-bridge/iu.test(command)) {
      return "claude-bridge";
    }
    current = processes.get(current.ppid);
  }
  return "unknown";
}

interface ProcessRow {
  pid: number;
  ppid: number;
  command: string;
}

function isStreamJsonProcess(command: string): boolean {
  return /--output-format(?:=|\s+)"?stream-json"?/iu.test(command) &&
    /--input-format(?:=|\s+)"?stream-json"?/iu.test(command) &&
    !/[\\/]Contents[\\/]Helpers[\\/]disclaimer(?:\s|$)/iu.test(command);
}

function parseWindowsProcessRows(stdout: string): ProcessRow[] {
  let values: unknown;
  try {
    values = JSON.parse(stdout.replace(/^\uFEFF/u, ""));
  } catch {
    return [];
  }
  const rows = Array.isArray(values) ? values : values ? [values] : [];
  return rows.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const record = value as Record<string, unknown>;
    const pid = Number(record.ProcessId);
    const ppid = Number(record.ParentProcessId);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || pid <= 0 || ppid < 0) return [];
    const name = typeof record.Name === "string" ? record.Name : "";
    const commandLine = typeof record.CommandLine === "string" ? record.CommandLine : "";
    return [{ pid, ppid, command: `${name}${commandLine ? ` ${commandLine}` : ""}` }];
  });
}

export function parseWindowsClaudeProcessSessions(stdout: string): Map<string, ActiveClaudeProcess[]> {
  const rows = parseWindowsProcessRows(stdout);
  const processes = new Map(rows.map((row) => [row.pid, row]));
  const result = new Map<string, ActiveClaudeProcess[]>();
  for (const [pid, processInfo] of processes) {
    const command = processInfo.command;
    if (!isStreamJsonProcess(command)) continue;
    const sessionMatch = /--(?:resume|session-id)(?:=|\s+)"?([0-9a-f-]{36})"?(?:\s|$)/iu.exec(command);
    if (!sessionMatch) continue;
    const sessionId = sessionMatch[1]!;
    const values = result.get(sessionId) ?? [];
    values.push({
      pid,
      startedAt: Date.now(),
      processAlive: true,
      entrypoint: entrypointFromAncestors(pid, processes, "win32"),
      source: "process",
    });
    result.set(sessionId, values);
  }
  return result;
}

async function listProcessSessions(platform = process.platform): Promise<Map<string, ActiveClaudeProcess[]>> {
  if ((platform !== "darwin" && platform !== "win32") || process.env.BRIDGE_DISABLE_PROCESS_SCAN === "1") {
    return new Map();
  }
  let stdout: string;
  try {
    if (platform === "win32") {
      ({ stdout } = await execFile("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        WINDOWS_PROCESS_QUERY,
      ], {
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
      }));
    } else {
      ({ stdout } = await execFile("/bin/ps", ["-axo", "pid=,ppid=,command="], {
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
      }));
    }
  } catch {
    return new Map();
  }
  if (platform === "win32") return parseWindowsClaudeProcessSessions(stdout);
  const processes = new Map<number, { ppid: number; command: string }>();
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
    if (!match) continue;
    processes.set(Number(match[1]), { ppid: Number(match[2]), command: match[3]! });
  }
  const result = new Map<string, ActiveClaudeProcess[]>();
  for (const [pid, processInfo] of processes) {
    const command = processInfo.command;
    if (!isStreamJsonProcess(command)) continue;
    const sessionMatch = /--(?:resume|session-id)(?:=|\s+)([0-9a-f-]{36})(?:\s|$)/iu.exec(command);
    if (!sessionMatch) continue;
    const sessionId = sessionMatch[1]!;
    const values = result.get(sessionId) ?? [];
    values.push({
      pid,
      startedAt: Date.now(),
      processAlive: true,
      entrypoint: entrypointFromAncestors(pid, processes, platform),
      source: "process",
    });
    result.set(sessionId, values);
  }
  return result;
}

async function listActiveSessions(
  path: string,
  platform = process.platform,
): Promise<Map<string, ActiveClaudeProcess[]>> {
  let names: string[];
  try {
    names = await readdir(path);
  } catch {
    names = [];
  }
  const result = await listProcessSessions(platform);
  await Promise.all(names.filter((name) => name.endsWith(".json")).map(async (name) => {
    try {
      const value = JSON.parse(await readFile(join(path, name), "utf8")) as ActiveSessionFile;
      if (
        typeof value.sessionId !== "string" ||
        typeof value.cwd !== "string" ||
        typeof value.startedAt !== "number"
      ) return;
      const pid = typeof value.pid === "number" && Number.isInteger(value.pid) ? value.pid : undefined;
      const active: ActiveClaudeProcess = {
        ...(pid !== undefined ? { pid } : {}),
        cwd: value.cwd,
        startedAt: value.startedAt,
        processAlive: pid !== undefined && processExists(pid),
        entrypoint: typeof value.entrypoint === "string" ? value.entrypoint : "unknown",
        ...(typeof value.peerProtocol === "string" ? { peerProtocol: value.peerProtocol } : {}),
        source: "registration",
      };
      const existing = result.get(value.sessionId) ?? [];
      if (!existing.some((candidate) => candidate.pid !== undefined && candidate.pid === active.pid)) {
        existing.push(active);
      }
      result.set(value.sessionId, existing);
    } catch {
      // Session discovery is best effort; malformed files are ignored.
    }
  }));
  return result;
}

export async function scanClaudeSessionProcesses(
  paths: ClaudeRuntimePaths,
  sessionId: string,
  platform = process.platform,
): Promise<ActiveClaudeProcess[]> {
  return (await listActiveSessions(paths.sessions, platform)).get(sessionId) ?? [];
}

function processSummary(processes: ActiveClaudeProcess[]): {
  processAlive: boolean;
  desktopProcessAlive: boolean;
  bridgeProcessAlive: boolean;
  processOverlap: boolean;
} {
  const live = processes.filter((candidate) => candidate.processAlive);
  const desktopProcessAlive = live.some((candidate) => candidate.entrypoint.startsWith("claude-desktop"));
  const bridgeProcessAlive = live.some((candidate) => candidate.entrypoint === "claude-bridge");
  return {
    processAlive: live.length > 0,
    desktopProcessAlive,
    bridgeProcessAlive,
    processOverlap: desktopProcessAlive && bridgeProcessAlive,
  };
}

async function hasActiveTask(tasksRoot: string, sessionId: string): Promise<boolean> {
  let names: string[];
  try {
    names = await readdir(join(tasksRoot, sessionId));
  } catch {
    return false;
  }
  for (const name of names.filter((candidate) => candidate.endsWith(".json"))) {
    try {
      const value = JSON.parse(await readFile(join(tasksRoot, sessionId, name), "utf8")) as { status?: unknown };
      if (value.status === "in_progress") return true;
    } catch {
      // Ignore incomplete task state writes.
    }
  }
  return false;
}

export async function scanClaudeCatalog(
  paths: ClaudeRuntimePaths,
  platform = process.platform,
): Promise<ClaudeCatalogSnapshot> {
  const [desktopSessions, activeSessions] = await Promise.all([
    listClaudeDesktopSessions(paths.desktopSessions),
    listActiveSessions(paths.sessions, platform),
  ]);
  const observedAt = Date.now();
  const seen = new Set<string>();
  const sessions: ObservedClaudeSession[] = [];
  for (const desktopSession of desktopSessions) {
    if (seen.has(desktopSession.cliSessionId)) continue;
    seen.add(desktopSession.cliSessionId);
    const activeProcesses = activeSessions.get(desktopSession.cliSessionId) ?? [];
    const active = activeProcesses.find((candidate) => candidate.cwd);
    const processState = processSummary(activeProcesses);
    const cwd = active?.cwd ?? desktopSession.cwd;
    const projectName = basename(cwd) || cwd;
    const transcriptPath = await findClaudeTranscriptFile(paths.projects, desktopSession.cliSessionId, cwd);
    const transcriptMtimeMs = transcriptPath
      ? await stat(transcriptPath).then((metadata) => metadata.mtimeMs, () => 0)
      : 0;
    const activeTask = processState.processAlive
      ? await hasActiveTask(paths.tasks, desktopSession.cliSessionId)
      : false;
    sessions.push({
      sessionId: desktopSession.cliSessionId,
      desktopSessionId: desktopSession.sessionId,
      projectId: projectIdForCwd(cwd, platform),
      projectName,
      cwd,
      title: desktopSession.title || projectName,
      source: "desktop",
      ownership: "DESKTOP_OBSERVED",
      transport: "bridge-host",
      turnState: activeTask ? "running" : "idle",
      lastActivityAt: Math.max(
        desktopSession.lastActivityAt,
        desktopSession.lastFocusedAt,
        desktopSession.createdAt,
        transcriptMtimeMs,
      ),
      pendingCount: 0,
      transcriptMtimeMs,
      ...processState,
      activeProcesses,
      activeTask,
      ...(desktopSession.model ? { hostModel: desktopSession.model } : {}),
      ...(desktopSession.effort ? { hostEffort: desktopSession.effort } : {}),
      ...(desktopSession.profile !== "unknown" ? { sourceProfile: desktopSession.profile } : {}),
      ...(desktopSession.ultracode !== undefined ? { hostUltracode: desktopSession.ultracode } : {}),
      ...(transcriptPath ? { transcriptPath } : {}),
    });
  }
  for (const [sessionId, activeProcesses] of activeSessions) {
    if (seen.has(sessionId)) continue;
    const active = activeProcesses.find((candidate) => candidate.cwd);
    if (!active?.cwd) continue;
    const processState = processSummary(activeProcesses);
    const projectName = basename(active.cwd) || active.cwd;
    const transcriptPath = await findClaudeTranscriptFile(paths.projects, sessionId, active.cwd);
    const transcriptMtimeMs = transcriptPath
      ? await stat(transcriptPath).then((metadata) => metadata.mtimeMs, () => 0)
      : 0;
    const activeTask = await hasActiveTask(paths.tasks, sessionId);
    sessions.push({
      sessionId,
      projectId: projectIdForCwd(active.cwd, platform),
      projectName,
      cwd: active.cwd,
      title: projectName,
      source: "desktop",
      ownership: "DESKTOP_OBSERVED",
      transport: "bridge-host",
      turnState: activeTask ? "running" : "idle",
      lastActivityAt: Math.max(active.startedAt, transcriptMtimeMs),
      pendingCount: 0,
      transcriptMtimeMs,
      ...processState,
      activeProcesses,
      activeTask,
      ...(transcriptPath ? { transcriptPath } : {}),
    });
  }
  sessions.sort((left, right) => right.lastActivityAt - left.lastActivityAt);
  const grouped = new Map<string, BridgeProjectInfo>();
  for (const session of sessions) {
    const current = grouped.get(session.projectId);
    if (current) {
      current.sessionCount += 1;
      current.runningCount += Number(session.turnState === "running");
      current.lastActivityAt = Math.max(current.lastActivityAt, session.lastActivityAt);
    } else {
      grouped.set(session.projectId, {
        projectId: session.projectId,
        name: session.projectName,
        cwd: session.cwd,
        sessionCount: 1,
        runningCount: Number(session.turnState === "running"),
        pendingCount: 0,
        lastActivityAt: session.lastActivityAt,
      });
    }
  }
  return {
    projects: [...grouped.values()].sort((left, right) => right.lastActivityAt - left.lastActivityAt),
    sessions,
    observedAt,
  };
}
