import { EventEmitter } from "node:events";
import { execFile as execFileCallback } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ClaudeHistoryMessage } from "@bridge/protocol";
import { isClaudeTranscriptAtTurnBoundary, parseClaudeTranscript } from "./claude-history.js";
import {
  scanClaudeCatalog,
  type ClaudeCatalogSnapshot,
  type ObservedClaudeSession,
} from "./claude-session-catalog.js";
import type { ClaudeRuntimePaths } from "./platform.js";
import type { SessionEventLog } from "./session-event-log.js";

const execFile = promisify(execFileCallback);

export interface TranscriptObserverOptions {
  paths: ClaudeRuntimePaths;
  eventLog: SessionEventLog;
  pollIntervalMs?: number;
  catalogIntervalMs?: number;
  idleGraceMs?: number;
  resolveDesktopMainProcessId?(pid: number): Promise<number | undefined>;
  signalProcess?(pid: number): void;
  processExists?(pid: number): boolean;
  sleep?(durationMs: number): Promise<void>;
}

export class TranscriptObserver extends EventEmitter {
  private readonly pollIntervalMs: number;
  private readonly catalogIntervalMs: number;
  private readonly idleGraceMs: number;
  private catalogValue: ClaudeCatalogSnapshot = { projects: [], sessions: [], observedAt: 0 };
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private closed = false;
  private readonly knownMessages = new Map<string, Map<string, string>>();
  private readonly lastChangedAt = new Map<string, number>();
  private readonly lastMtime = new Map<string, number>();
  private readonly lastActivity = new Map<string, number>();
  private nextCatalogAt = 0;

  constructor(private readonly options: TranscriptObserverOptions) {
    super();
    this.pollIntervalMs = options.pollIntervalMs ?? 1_500;
    this.catalogIntervalMs = options.catalogIntervalMs ?? 10_000;
    this.idleGraceMs = options.idleGraceMs ?? 2_500;
  }

  get catalog(): ClaudeCatalogSnapshot {
    return this.catalogValue;
  }

  onCatalog(listener: (catalog: ClaudeCatalogSnapshot) => void): () => void {
    this.on("catalog", listener);
    return () => this.off("catalog", listener);
  }

  async start(): Promise<void> {
    await this.options.eventLog.initialize();
    await this.poll();
  }

  isDesktopBusy(sessionId: string, now = Date.now()): boolean {
    const session = this.catalogValue.sessions.find((candidate) => candidate.sessionId === sessionId);
    if (!session) return false;
    const changedAt = this.lastChangedAt.get(sessionId) ?? session.transcriptMtimeMs;
    return session.activeTask || (session.processAlive && now - changedAt < this.idleGraceMs);
  }

  hasDesktopWriter(sessionId: string): boolean {
    return this.catalogValue.sessions.some((candidate) => (
      candidate.sessionId === sessionId && candidate.desktopProcessAlive
    ));
  }

  async releaseDesktopWriter(sessionId: string): Promise<boolean> {
    const session = this.catalogValue.sessions.find((candidate) => candidate.sessionId === sessionId);
    if (!session?.desktopProcessAlive) return true;
    if (this.isDesktopBusy(sessionId) || session.activeTask || !session.transcriptPath) return false;
    if (!await isClaudeTranscriptAtTurnBoundary(session.transcriptPath)) return false;

    const candidates = session.activeProcesses.filter((candidate) => (
      candidate.processAlive &&
      candidate.entrypoint.startsWith("claude-desktop") &&
      candidate.pid !== undefined
    ));
    const verifiedChildren: number[] = [];
    const desktopMainPids = new Set<number>();
    for (const candidate of candidates) {
      if (!await this.isRegisteredDesktopWriter(candidate.pid!, sessionId)) continue;
      const mainPid = await (
        this.options.resolveDesktopMainProcessId
          ? this.options.resolveDesktopMainProcessId(candidate.pid!)
          : this.claudeDesktopMainProcessId(candidate.pid!)
      );
      if (mainPid === undefined) continue;
      verifiedChildren.push(candidate.pid!);
      desktopMainPids.add(mainPid);
    }
    if (desktopMainPids.size === 0) return false;

    for (const pid of desktopMainPids) {
      try {
        (this.options.signalProcess ?? ((target) => process.kill(target, "SIGTERM")))(pid);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false;
      }
    }
    const processIds = [...desktopMainPids, ...verifiedChildren];
    const deadline = Date.now() + 5_000;
    while (processIds.some((pid) => this.processExists(pid)) && Date.now() < deadline) {
      await (this.options.sleep ?? ((durationMs) => (
        new Promise((resolve) => setTimeout(resolve, durationMs))
      )))(100);
    }
    if (processIds.some((pid) => this.processExists(pid))) return false;

    for (const active of session.activeProcesses) {
      if (
        active.entrypoint.startsWith("claude-desktop") &&
        active.pid !== undefined &&
        verifiedChildren.includes(active.pid)
      ) active.processAlive = false;
    }
    const live = session.activeProcesses.filter((candidate) => candidate.processAlive);
    session.desktopProcessAlive = live.some((candidate) => candidate.entrypoint.startsWith("claude-desktop"));
    session.bridgeProcessAlive = live.some((candidate) => candidate.entrypoint === "claude-bridge");
    session.processAlive = live.length > 0;
    session.processConflict = session.desktopProcessAlive && session.bridgeProcessAlive;
    session.activeTask = false;
    this.catalogValue.observedAt = Date.now();
    this.emit("catalog", this.catalogValue);
    return !session.desktopProcessAlive;
  }

  session(sessionId: string): ObservedClaudeSession | undefined {
    return this.catalogValue.sessions.find((candidate) => candidate.sessionId === sessionId);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 10));
  }

  private processExists(pid: number): boolean {
    if (this.options.processExists) return this.options.processExists(pid);
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  }

  private async isRegisteredDesktopWriter(pid: number, sessionId: string): Promise<boolean> {
    try {
      const value = JSON.parse(
        await readFile(join(this.options.paths.sessions, `${pid}.json`), "utf8"),
      ) as Record<string, unknown>;
      return (
        value.pid === pid &&
        value.sessionId === sessionId &&
        typeof value.entrypoint === "string" &&
        value.entrypoint.startsWith("claude-desktop")
      );
    } catch {
      return false;
    }
  }

  private async claudeDesktopMainProcessId(pid: number): Promise<number | undefined> {
    if (process.platform !== "darwin") return undefined;
    let currentPid = pid;
    for (let depth = 0; depth < 10 && currentPid > 1; depth += 1) {
      let stdout: string;
      try {
        ({ stdout } = await execFile("/bin/ps", [
          "-p",
          String(currentPid),
          "-o",
          "ppid=,command=",
        ], {
          encoding: "utf8",
          maxBuffer: 1024 * 1024,
        }));
      } catch {
        return undefined;
      }
      const match = /^\s*(\d+)\s+(.+)$/su.exec(stdout.trim());
      if (!match) return undefined;
      const command = match[2]!;
      if (depth === 0 && (
        !command.includes("--output-format stream-json") ||
        !command.includes("--input-format stream-json") ||
        !/\/claude(?:\s|$)/u.test(command)
      )) return undefined;
      if (/\/Applications\/Claude\.app\/Contents\/MacOS\/Claude(?:\s|$)/u.test(command)) return currentPid;
      currentPid = Number(match[1]);
    }
    return undefined;
  }

  private async poll(): Promise<void> {
    if (this.closed || this.running) return;
    this.running = true;
    try {
      const now = Date.now();
      let changed = false;
      if (!this.catalogValue.observedAt || now >= this.nextCatalogAt) {
        const catalog = await scanClaudeCatalog(this.options.paths);
        const initialCandidates = new Set(
          catalog.sessions
            .filter((session, index) => index < 24 || session.processAlive || session.activeTask)
            .map((session) => session.sessionId),
        );
        for (const session of catalog.sessions) {
          const previousMtime = this.lastMtime.get(session.sessionId);
          this.lastMtime.set(session.sessionId, session.transcriptMtimeMs);
          if (previousMtime === undefined && initialCandidates.has(session.sessionId)) {
            await this.primeTranscript(session);
          } else if (previousMtime !== undefined && previousMtime !== session.transcriptMtimeMs) {
            this.lastChangedAt.set(session.sessionId, now);
            await this.observeTranscript(session);
          }
          const previousActivity = this.lastActivity.get(session.sessionId);
          if (previousActivity !== session.lastActivityAt) {
            this.lastActivity.set(session.sessionId, session.lastActivityAt);
            this.lastChangedAt.set(
              session.sessionId,
              previousActivity === undefined ? session.lastActivityAt : now,
            );
          }
        }
        this.catalogValue = catalog;
        this.nextCatalogAt = now + this.catalogIntervalMs;
        changed = true;
      } else {
        changed = await this.pollRecentTranscripts(now);
      }
      if (changed) this.emit("catalog", this.catalogValue);
    } finally {
      this.running = false;
      if (!this.closed) this.timer = setTimeout(() => void this.poll(), this.pollIntervalMs);
    }
  }

  private async pollRecentTranscripts(now: number): Promise<boolean> {
    const candidates = this.catalogValue.sessions.filter((session, index) => (
      Boolean(session.transcriptPath) &&
      (index < 24 || session.processAlive || session.activeTask)
    ));
    const mtimes = await Promise.all(candidates.map(async (session) => ({
      session,
      mtimeMs: await stat(session.transcriptPath!).then((metadata) => metadata.mtimeMs, () => 0),
    })));
    let changed = false;
    for (const { session, mtimeMs } of mtimes) {
      const previousMtime = this.lastMtime.get(session.sessionId);
      if (previousMtime === mtimeMs) continue;
      this.lastMtime.set(session.sessionId, mtimeMs);
      this.lastChangedAt.set(session.sessionId, now);
      session.transcriptMtimeMs = mtimeMs;
      session.lastActivityAt = Math.max(session.lastActivityAt, mtimeMs);
      await this.observeTranscript(session);
      changed = true;
    }
    if (changed) this.catalogValue.observedAt = now;
    return changed;
  }

  private async observeTranscript(session: ObservedClaudeSession): Promise<void> {
    if (!session.transcriptPath) return;
    const result = await parseClaudeTranscript(session.transcriptPath, { limit: 50 });
    const known = this.knownMessages.get(session.sessionId) ?? new Map<string, string>();
    for (const message of result.messages) {
      const persisted = this.options.eventLog.latestItem(session.sessionId, "session.observed", message.id);
      const previousText = known.get(message.id)
        ?? (typeof persisted?.data.text === "string" ? persisted.data.text : undefined);
      if (previousText === message.text) continue;
      known.set(message.id, message.text);
      await this.appendObserved(session, message);
    }
    this.knownMessages.set(session.sessionId, known);
  }

  private async primeTranscript(session: ObservedClaudeSession): Promise<void> {
    if (!session.transcriptPath) return;
    const result = await parseClaudeTranscript(session.transcriptPath, { limit: 50 });
    this.knownMessages.set(
      session.sessionId,
      new Map(result.messages.map((message) => [message.id, message.text])),
    );
  }

  private async appendObserved(session: ObservedClaudeSession, message: ClaudeHistoryMessage): Promise<void> {
    const type = "session.observed" as const;
    if (
      this.options.eventLog.hasItem(session.sessionId, "user.message.accepted", message.id) ||
      this.options.eventLog.hasItem(session.sessionId, "assistant.completed", message.id)
    ) return;
    await this.options.eventLog.append({
      sessionId: session.sessionId,
      itemId: message.id,
      timestamp: message.createdAt || Date.now(),
      origin: "claude-desktop",
      type,
      data: { role: message.role, text: message.text },
    });
  }
}
