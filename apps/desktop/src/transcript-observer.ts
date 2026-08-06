import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import type { ClaudeHistoryMessage } from "@bridge/protocol";
import {
  ClaudeTranscriptEvidenceCursor,
  isClaudeTranscriptAtTurnBoundary,
  parseClaudeTranscriptSnapshot,
} from "./claude-history.js";
import type { ObservedDesktopEvidence } from "./evidence-manager.js";
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
  platform?: NodeJS.Platform;
  pollIntervalMs?: number;
  catalogIntervalMs?: number;
  idleGraceMs?: number;
  evidence?: {
    upsertDesktopEvidence(input: ObservedDesktopEvidence): Promise<unknown>;
  };
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
  private readonly transcriptTurnBoundaries = new Map<string, boolean>();
  private readonly externalWriteVersions = new Map<string, number>();
  private readonly knownEvidence = new Map<string, string>();
  private readonly sessionAliases = new Map<string, string>();
  private evidenceFailureReported = false;
  private readonly evidenceCursors = new Map<string, {
    path: string;
    cursor: ClaudeTranscriptEvidenceCursor;
  }>();
  private readonly evidenceBackfill = new Set<string>();
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
    if (session.activeTask) return true;
    if (!session.processAlive) return false;
    const atTurnBoundary = this.transcriptTurnBoundaries.get(sessionId);
    if (atTurnBoundary !== undefined) return !atTurnBoundary;
    const changedAt = this.lastChangedAt.get(sessionId) ?? session.transcriptMtimeMs;
    return now - changedAt < this.idleGraceMs;
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

  setSessionAlias(nativeSessionId: string, logicalSessionId: string): void {
    this.sessionAliases.set(nativeSessionId, logicalSessionId);
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
        const catalog = await scanClaudeCatalog(this.options.paths, this.options.platform);
        const initialCandidates = new Set(
          catalog.sessions
            .filter((session, index) => index < 24 || session.processAlive || session.activeTask)
            .map((session) => session.sessionId),
        );
        for (const session of catalog.sessions) {
          if (session.transcriptPath && !this.evidenceCursors.has(session.sessionId)) {
            this.evidenceBackfill.add(session.sessionId);
          }
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
        await this.backfillEvidence(8);
        changed = true;
      } else {
        changed = await this.pollRecentTranscripts(now);
        await this.backfillEvidence(8);
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
    this.updateTurnBoundary(session.sessionId, result.atTurnBoundary);
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
    await this.observeEvidence(session);
  }

  private async primeTranscript(session: ObservedClaudeSession): Promise<void> {
    if (!session.transcriptPath) return;
    const result = await parseClaudeTranscriptSnapshot(session.transcriptPath, { limit: 50 });
    this.updateTurnBoundary(session.sessionId, result.atTurnBoundary);
    this.knownMessages.set(
      session.sessionId,
      new Map(result.messages.map((message) => [message.id, message.text])),
    );
    this.knownUserMessages.set(
      session.sessionId,
      new Map(result.userMessages.map((message) => [message.id, message.text])),
    );
    await this.observeEvidence(session);
  }

  private updateTurnBoundary(sessionId: string, atTurnBoundary: boolean | undefined): void {
    if (atTurnBoundary === undefined) {
      this.transcriptTurnBoundaries.delete(sessionId);
      return;
    }
    this.transcriptTurnBoundaries.set(sessionId, atTurnBoundary);
  }

  private async observeEvidence(session: ObservedClaudeSession): Promise<void> {
    if (!this.options.evidence || !session.transcriptPath) return;
    const existingCursor = this.evidenceCursors.get(session.sessionId);
    const cursor = existingCursor?.path === session.transcriptPath
      ? existingCursor.cursor
      : new ClaudeTranscriptEvidenceCursor();
    this.evidenceCursors.set(session.sessionId, {
      path: session.transcriptPath,
      cursor,
    });
    this.evidenceBackfill.delete(session.sessionId);
    const turns = await cursor.read(session.transcriptPath);
    for (const turn of turns) {
      const tools = turn.tools.filter((tool) => !this.options.eventLog.hasItem(
        session.sessionId,
        "tool.started",
        tool.id,
      ));
      if (tools.length === 0) continue;
      const evidenceId = `desktop-${createHash("sha256")
        .update(`${session.sessionId}\0${turn.id}`)
        .digest("base64url")
        .slice(0, 32)}`;
      const input: ObservedDesktopEvidence = {
        id: evidenceId,
        sessionId: this.sessionAliases.get(session.sessionId) ?? session.sessionId,
        cwd: session.cwd,
        turnId: turn.id,
        startedAt: turn.startedAt,
        completedAt: turn.completedAt,
        tools,
        paths: turn.paths,
      };
      const signature = createHash("sha256").update(JSON.stringify(input)).digest("base64url");
      if (this.knownEvidence.get(evidenceId) === signature) continue;
      try {
        await this.options.evidence.upsertDesktopEvidence(input);
        this.knownEvidence.set(evidenceId, signature);
      } catch {
        if (!this.evidenceFailureReported) {
          this.evidenceFailureReported = true;
          process.stderr.write("Claude Desktop evidence recovery failed; transcript observation will continue.\n");
        }
      }
    }
  }

  private async backfillEvidence(limit: number): Promise<void> {
    if (!this.options.evidence || this.evidenceBackfill.size === 0) return;
    const sessionIds = [...this.evidenceBackfill].slice(0, limit);
    for (const sessionId of sessionIds) {
      const session = this.catalogValue.sessions.find((candidate) => candidate.sessionId === sessionId);
      if (!session?.transcriptPath) {
        this.evidenceBackfill.delete(sessionId);
        continue;
      }
      await this.observeEvidence(session);
    }
  }

  private async appendObserved(session: ObservedClaudeSession, message: ClaudeHistoryMessage): Promise<void> {
    const type = "session.observed" as const;
    const sessionId = this.sessionAliases.get(session.sessionId) ?? session.sessionId;
    if (
      this.options.eventLog.hasItem(sessionId, "user.message.accepted", message.id) ||
      this.options.eventLog.hasItem(sessionId, "assistant.completed", message.id)
    ) return;
    await this.options.eventLog.append({
      sessionId,
      itemId: message.id,
      timestamp: message.createdAt || Date.now(),
      origin: "claude-desktop",
      type,
      data: { role: message.role, text: message.text },
    });
  }
}
