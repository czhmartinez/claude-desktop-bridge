import { open, readdir, stat, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const ROLLOUT_FILE_NAME = /^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/iu;
const MAX_TAIL_BYTES = 256 * 1024;
const DEFAULT_INDEX_INTERVAL_MS = 5_000;
const DEFAULT_INFERRED_ACTIVE_GRACE_MS = 30 * 60_000;

type RolloutLifecycle = "started" | "terminal";

interface RolloutLifecycleEvent {
  lifecycle: RolloutLifecycle;
  turnId?: string;
}

interface RolloutMetadata {
  size: number;
  mtimeMs: number;
}

interface CachedRollout {
  path: string;
  size: number;
  mtimeMs: number;
  activity: CodexRolloutActivity;
}

export interface CodexRolloutActivity {
  state: "running" | "idle";
  lastActivityAt: number;
  /** A lifecycle event was found instead of inferring state from a recent write. */
  definitive: boolean;
  activeTurnId?: string;
}

export interface CodexRolloutActivityObserverOptions {
  rolloutDirectory: string;
  indexIntervalMs?: number;
  inferredActiveGraceMs?: number;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function lifecycleEvent(line: string): RolloutLifecycleEvent | undefined {
  if (!line.includes("task_") && !line.includes("turn_")) return undefined;
  let row: Record<string, unknown>;
  try {
    row = record(JSON.parse(line) as unknown);
  } catch {
    return undefined;
  }
  const payload = record(row.payload);
  const type = text(payload.type) || text(row.type);
  const turnId = text(payload.turn_id) || text(payload.turnId) || undefined;
  if (type === "task_started") return { lifecycle: "started", ...(turnId ? { turnId } : {}) };
  if (["task_complete", "task_failed", "task_cancelled", "turn_completed", "turn_failed", "turn_aborted"].includes(type)) {
    return { lifecycle: "terminal", ...(turnId ? { turnId } : {}) };
  }
  return undefined;
}

async function collectRolloutPaths(directory: string, depth: number, paths: Map<string, string>): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isFile()) {
      const match = ROLLOUT_FILE_NAME.exec(entry.name);
      const sessionId = match?.[1];
      if (sessionId) paths.set(sessionId, path);
    } else if (entry.isDirectory() && depth > 0) {
      await collectRolloutPaths(path, depth - 1, paths);
    }
  }
}

async function readLifecycle(path: string, size: number): Promise<RolloutLifecycleEvent | undefined> {
  const length = Math.min(size, MAX_TAIL_BYTES);
  if (length <= 0) return undefined;
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, "r");
    const bytes = Buffer.alloc(length);
    const offset = Math.max(0, size - length);
    const { bytesRead } = await handle.read(bytes, 0, length, offset);
    const lines = bytes.subarray(0, bytesRead).toString("utf8").split(/\r?\n/u);
    if (offset > 0) lines.shift();
    let latest: RolloutLifecycleEvent | undefined;
    for (const line of lines) {
      const event = lifecycleEvent(line);
      if (event) latest = event;
    }
    return latest;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Recovers turn state for work started by the native Codex Desktop process.
 * app-server notifications only cover the Bridge-owned child process, while
 * each native turn records a durable lifecycle boundary in its rollout file.
 */
export class CodexRolloutActivityObserver {
  private readonly indexIntervalMs: number;
  private readonly inferredActiveGraceMs: number;
  private readonly paths = new Map<string, string>();
  private readonly cache = new Map<string, CachedRollout>();
  private indexed = false;
  private nextIndexAt = 0;

  constructor(private readonly options: CodexRolloutActivityObserverOptions) {
    this.indexIntervalMs = options.indexIntervalMs ?? DEFAULT_INDEX_INTERVAL_MS;
    this.inferredActiveGraceMs = options.inferredActiveGraceMs ?? DEFAULT_INFERRED_ACTIVE_GRACE_MS;
  }

  async observe(nativeSessionIds: readonly string[], now = Date.now()): Promise<Map<string, CodexRolloutActivity>> {
    const uniqueSessionIds = [...new Set(nativeSessionIds)].filter((nativeSessionId) => SESSION_ID.test(nativeSessionId));
    if (uniqueSessionIds.length === 0) return new Map();
    await this.refreshIndex(now, uniqueSessionIds.some((nativeSessionId) => !this.paths.has(nativeSessionId)));
    const observations = await Promise.all(uniqueSessionIds.map(async (nativeSessionId) => {
      const activity = await this.observeOne(nativeSessionId, now);
      return activity ? [nativeSessionId, activity] as const : undefined;
    }));
    return new Map(observations.flatMap((entry) => entry ? [entry] : []));
  }

  private async refreshIndex(now: number, resolveMissingPaths: boolean): Promise<void> {
    if (this.indexed && (!resolveMissingPaths || now < this.nextIndexAt)) return;
    const paths = new Map<string, string>();
    await collectRolloutPaths(this.options.rolloutDirectory, 3, paths);
    this.paths.clear();
    for (const [sessionId, path] of paths) this.paths.set(sessionId, path);
    for (const sessionId of this.cache.keys()) {
      if (!this.paths.has(sessionId)) this.cache.delete(sessionId);
    }
    this.indexed = true;
    this.nextIndexAt = now + this.indexIntervalMs;
  }

  private async observeOne(nativeSessionId: string, now: number): Promise<CodexRolloutActivity | undefined> {
    const path = this.paths.get(nativeSessionId);
    if (!path) return undefined;
    let metadata: RolloutMetadata;
    try {
      const value = await stat(path);
      if (!value.isFile()) return undefined;
      metadata = { size: value.size, mtimeMs: value.mtimeMs };
    } catch {
      this.paths.delete(nativeSessionId);
      this.cache.delete(nativeSessionId);
      return undefined;
    }
    const cached = this.cache.get(nativeSessionId);
    if (cached && cached.path === path && cached.size === metadata.size && cached.mtimeMs === metadata.mtimeMs) {
      if (
        cached.activity.state === "running" &&
        !cached.activity.definitive &&
        now - cached.mtimeMs > this.inferredActiveGraceMs
      ) {
        cached.activity = { state: "idle", lastActivityAt: cached.activity.lastActivityAt, definitive: false };
      }
      return { ...cached.activity };
    }

    const priorIsRecent = now - metadata.mtimeMs <= this.inferredActiveGraceMs;
    // A terminal boundary is appended after all turn output, so a bounded
    // tail is sufficient even when the historical rollout itself is large.
    const lifecycle = await readLifecycle(path, metadata.size);
    const activity: CodexRolloutActivity = lifecycle?.lifecycle === "started"
      ? {
        state: "running",
        lastActivityAt: metadata.mtimeMs,
        definitive: true,
        ...(lifecycle.turnId ? { activeTurnId: lifecycle.turnId } : {}),
      }
      : lifecycle?.lifecycle === "terminal"
        ? { state: "idle", lastActivityAt: metadata.mtimeMs, definitive: true }
        : priorIsRecent
          ? { state: "running", lastActivityAt: metadata.mtimeMs, definitive: false }
          : { state: "idle", lastActivityAt: metadata.mtimeMs, definitive: false };
    this.cache.set(nativeSessionId, { path, ...metadata, activity });
    return { ...activity };
  }
}
