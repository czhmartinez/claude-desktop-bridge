import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { BridgeEffort } from "@bridge/protocol";

interface DesktopSessionFile {
  sessionId?: unknown;
  cliSessionId?: unknown;
  cwd?: unknown;
  lastFocusedAt?: unknown;
  createdAt?: unknown;
  lastActivityAt?: unknown;
  isArchived?: unknown;
  title?: unknown;
  model?: unknown;
  effort?: unknown;
  sessionSettings?: unknown;
}

export type ClaudeSessionEffort = BridgeEffort;
export type ClaudeDesktopProfile = "claude" | "claude-3p" | "unknown";

export interface ClaudeDesktopSession {
  sessionId: string;
  cliSessionId: string;
  cwd: string;
  lastFocusedAt: number;
  createdAt: number;
  lastActivityAt: number;
  title?: string;
  model?: string;
  effort?: ClaudeSessionEffort;
  profile: ClaudeDesktopProfile;
  ultracode?: boolean;
}

function parseEffort(value: unknown): ClaudeSessionEffort | undefined {
  return value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max"
    ? value
    : undefined;
}

export function claudeDesktopProfileForPath(path: string): ClaudeDesktopProfile {
  const normalized = path.replaceAll("\\", "/");
  if (/(?:^|\/)Claude-3p(?:\/|$)/iu.test(normalized)) return "claude-3p";
  if (/(?:^|\/)Claude(?:\/|$)/iu.test(normalized)) return "claude";
  return "unknown";
}

function parseUltracode(value: unknown): boolean | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const ultracode = (value as Record<string, unknown>).ultracode;
  return typeof ultracode === "boolean" ? ultracode : undefined;
}

async function collectJsonFiles(root: string, depth = 3): Promise<string[]> {
  if (depth < 0) return [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isFile() && entry.name.startsWith("local_") && entry.name.endsWith(".json")) {
      files.push(path);
    } else if (entry.isDirectory() && depth > 0) {
      files.push(...await collectJsonFiles(path, depth - 1));
    }
  }
  return files;
}

export async function listClaudeDesktopSessions(roots: string[]): Promise<ClaudeDesktopSession[]> {
  const files = (await Promise.all(roots.map(async (root) => (
    (await collectJsonFiles(root)).map((file) => ({ file, root }))
  )))).flat();
  const sessions: ClaudeDesktopSession[] = [];
  for (const { file, root } of files) {
    let value: DesktopSessionFile;
    try {
      value = JSON.parse(await readFile(file, "utf8")) as DesktopSessionFile;
    } catch {
      continue;
    }
    if (
      value.isArchived === true ||
      typeof value.sessionId !== "string" ||
      typeof value.cliSessionId !== "string" ||
      typeof value.cwd !== "string"
    ) continue;
    const lastFocusedAt = typeof value.lastFocusedAt === "number" ? value.lastFocusedAt : 0;
    const createdAt = typeof value.createdAt === "number" ? value.createdAt : lastFocusedAt;
    const lastActivityAt = typeof value.lastActivityAt === "number" ? value.lastActivityAt : lastFocusedAt;
    const effort = parseEffort(value.effort);
    const ultracode = parseUltracode(value.sessionSettings);
    sessions.push({
      sessionId: value.sessionId,
      cliSessionId: value.cliSessionId,
      cwd: value.cwd,
      lastFocusedAt,
      createdAt,
      lastActivityAt,
      profile: claudeDesktopProfileForPath(root),
      ...(typeof value.title === "string" && value.title.trim() ? { title: value.title.trim() } : {}),
      ...(typeof value.model === "string" && value.model.trim() ? { model: value.model.trim() } : {}),
      ...(effort ? { effort } : {}),
      ...(ultracode !== undefined ? { ultracode } : {}),
    });
  }
  return sessions.sort((left, right) => (
    Math.max(right.lastFocusedAt, right.lastActivityAt)
    - Math.max(left.lastFocusedAt, left.lastActivityAt)
  ));
}

export async function findClaudeDesktopSessionId(
  roots: string[],
  cliSessionId: string,
): Promise<string | undefined> {
  const sessions = await listClaudeDesktopSessions(roots);
  return sessions.find((session) => session.cliSessionId === cliSessionId)?.sessionId;
}
