import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { BridgeProjectInfo, BridgeSessionInfo } from "@bridge/protocol";
import {
  listClaudeDesktopSessions,
  type ClaudeSessionEffort,
} from "./claude-desktop-sessions.js";
import { findClaudeTranscriptFile } from "./claude-history.js";
import type { ClaudeRuntimePaths } from "./platform.js";

interface ActiveSessionFile {
  pid?: unknown;
  sessionId?: unknown;
  cwd?: unknown;
  startedAt?: unknown;
}

export interface ObservedClaudeSession extends BridgeSessionInfo {
  transcriptPath?: string;
  transcriptMtimeMs: number;
  processAlive: boolean;
  activeTask: boolean;
  hostModel?: string;
  hostEffort?: ClaudeSessionEffort;
}

export interface ClaudeCatalogSnapshot {
  projects: BridgeProjectInfo[];
  sessions: ObservedClaudeSession[];
  observedAt: number;
}

export function projectIdForCwd(cwd: string): string {
  return createHash("sha256").update(cwd).digest("base64url").slice(0, 18);
}

async function listActiveSessions(path: string): Promise<Map<string, { cwd: string; startedAt: number; processAlive: boolean }>> {
  let names: string[];
  try {
    names = await readdir(path);
  } catch {
    return new Map();
  }
  const result = new Map<string, { cwd: string; startedAt: number; processAlive: boolean }>();
  await Promise.all(names.filter((name) => name.endsWith(".json")).map(async (name) => {
    try {
      const value = JSON.parse(await readFile(join(path, name), "utf8")) as ActiveSessionFile;
      if (
        typeof value.sessionId !== "string" ||
        typeof value.cwd !== "string" ||
        typeof value.startedAt !== "number"
      ) return;
      let processAlive = false;
      if (typeof value.pid === "number" && Number.isInteger(value.pid)) {
        try {
          process.kill(value.pid, 0);
          processAlive = true;
        } catch (error) {
          processAlive = (error as NodeJS.ErrnoException).code === "EPERM";
        }
      }
      result.set(value.sessionId, { cwd: value.cwd, startedAt: value.startedAt, processAlive });
    } catch {
      // Session discovery is best effort; malformed files are ignored.
    }
  }));
  return result;
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

export async function scanClaudeCatalog(paths: ClaudeRuntimePaths): Promise<ClaudeCatalogSnapshot> {
  const [desktopSessions, activeSessions] = await Promise.all([
    listClaudeDesktopSessions(paths.desktopSessions),
    listActiveSessions(paths.sessions),
  ]);
  const observedAt = Date.now();
  const seen = new Set<string>();
  const sessions: ObservedClaudeSession[] = [];
  for (const desktopSession of desktopSessions) {
    if (seen.has(desktopSession.cliSessionId)) continue;
    seen.add(desktopSession.cliSessionId);
    const active = activeSessions.get(desktopSession.cliSessionId);
    const cwd = active?.cwd ?? desktopSession.cwd;
    const projectName = basename(cwd) || cwd;
    const transcriptPath = await findClaudeTranscriptFile(paths.projects, desktopSession.cliSessionId, cwd);
    const transcriptMtimeMs = transcriptPath
      ? await stat(transcriptPath).then((metadata) => metadata.mtimeMs, () => 0)
      : 0;
    const activeTask = active?.processAlive
      ? await hasActiveTask(paths.tasks, desktopSession.cliSessionId)
      : false;
    sessions.push({
      sessionId: desktopSession.cliSessionId,
      desktopSessionId: desktopSession.sessionId,
      projectId: projectIdForCwd(cwd),
      projectName,
      cwd,
      title: desktopSession.title || projectName,
      source: "desktop",
      ownership: "DESKTOP_OBSERVED",
      turnState: active?.processAlive ? "running" : "idle",
      lastActivityAt: Math.max(
        desktopSession.lastActivityAt,
        desktopSession.lastFocusedAt,
        desktopSession.createdAt,
        transcriptMtimeMs,
      ),
      pendingCount: 0,
      transcriptMtimeMs,
      processAlive: active?.processAlive ?? false,
      activeTask,
      ...(desktopSession.model ? { hostModel: desktopSession.model } : {}),
      ...(desktopSession.effort ? { hostEffort: desktopSession.effort } : {}),
      ...(transcriptPath ? { transcriptPath } : {}),
    });
  }
  for (const [sessionId, active] of activeSessions) {
    if (seen.has(sessionId)) continue;
    const projectName = basename(active.cwd) || active.cwd;
    const transcriptPath = await findClaudeTranscriptFile(paths.projects, sessionId, active.cwd);
    const transcriptMtimeMs = transcriptPath
      ? await stat(transcriptPath).then((metadata) => metadata.mtimeMs, () => 0)
      : 0;
    const activeTask = await hasActiveTask(paths.tasks, sessionId);
    sessions.push({
      sessionId,
      projectId: projectIdForCwd(active.cwd),
      projectName,
      cwd: active.cwd,
      title: projectName,
      source: "desktop",
      ownership: "DESKTOP_OBSERVED",
      turnState: active.processAlive ? "running" : "idle",
      lastActivityAt: Math.max(active.startedAt, transcriptMtimeMs),
      pendingCount: 0,
      transcriptMtimeMs,
      processAlive: active.processAlive,
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
