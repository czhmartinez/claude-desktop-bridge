import { EventEmitter } from "node:events";
import { stat } from "node:fs/promises";
import type { ClaudeHistoryMessage } from "@bridge/protocol";
import {
  isClaudeTranscriptAtTurnBoundary,
  parseClaudeTranscriptSnapshot,
} from "./claude-history.js";
import {
  scanClaudeCatalog,
  type ClaudeCatalogSnapshot,
  type ObservedClaudeSession,
} from "./claude-session-catalog.js";
import type { ClaudeRuntimePaths } from "./platform.js";
import type { SessionEventLog } from "./session-event-log.js";

export interface TranscriptObserverOptions {
  paths: ClaudeRuntimePaths;
  eventLog: SessionEventLog;
  pollIntervalMs?: number;
  catalogIntervalMs?: number;
  idleGraceMs?: number;
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
  private readonly knownUserMessages = new Map<string, Map<string, string>>();
  private readonly lastChangedAt = new Map<string, number>();
  private readonly lastMtime = new Map<string, number>();
  private readonly externalWriteVersions = new Map<string, number>();
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

  externalWriteVersion(sessionId: string): number {
    return this.externalWriteVersions.get(sessionId) ?? 0;
  }

  async canStartBridgeHost(sessionId: string): Promise<boolean> {
    const session = this.catalogValue.sessions.find((candidate) => candidate.sessionId === sessionId);
    if (session?.transcriptPath && !this.knownUserMessages.has(sessionId)) {
      await this.primeTranscript(session);
    }
    if (!session?.desktopProcessAlive) return true;
    if (this.isDesktopBusy(sessionId) || !session.transcriptPath) return false;
    return isClaudeTranscriptAtTurnBoundary(session.transcriptPath);
  }

  session(sessionId: string): ObservedClaudeSession | undefined {
    return this.catalogValue.sessions.find((candidate) => candidate.sessionId === sessionId);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 10));
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
          if (
            initialCandidates.has(session.sessionId) &&
            !this.knownUserMessages.has(session.sessionId)
          ) {
            await this.primeTranscript(session);
          } else if (previousMtime !== undefined && previousMtime !== session.transcriptMtimeMs) {
            this.lastChangedAt.set(session.sessionId, now);
            await this.observeTranscript(session);
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
    const result = await parseClaudeTranscriptSnapshot(session.transcriptPath, { limit: 50 });
    const known = this.knownMessages.get(session.sessionId) ?? new Map<string, string>();
    const knownUsers = this.knownUserMessages.get(session.sessionId) ?? new Map<string, string>();
    // A competing Desktop input can land on a non-terminal branch while Bridge keeps writing.
    for (const message of result.userMessages) {
      const persisted = this.options.eventLog.latestItem(session.sessionId, "session.observed", message.id);
      const previousText = knownUsers.get(message.id)
        ?? (typeof persisted?.data.text === "string" ? persisted.data.text : undefined);
      if (previousText === message.text) continue;
      const bridgeOwned = this.options.eventLog.hasItem(
        session.sessionId,
        "user.message.accepted",
        message.id,
      );
      if (previousText === undefined && !bridgeOwned) {
        this.externalWriteVersions.set(
          session.sessionId,
          this.externalWriteVersion(session.sessionId) + 1,
        );
      }
      knownUsers.set(message.id, message.text);
      await this.appendObserved(session, message);
    }
    this.knownUserMessages.set(session.sessionId, knownUsers);
    for (const message of result.messages) {
      if (message.role === "user") continue;
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
    const result = await parseClaudeTranscriptSnapshot(session.transcriptPath, { limit: 50 });
    this.knownMessages.set(
      session.sessionId,
      new Map(result.messages.map((message) => [message.id, message.text])),
    );
    this.knownUserMessages.set(
      session.sessionId,
      new Map(result.userMessages.map((message) => [message.id, message.text])),
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
