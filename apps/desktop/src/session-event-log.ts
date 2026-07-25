import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  BridgeEvent,
  BridgeEventType,
  BridgeHistoryItem,
  BridgeHistoryPage,
  BridgeOrigin,
} from "@bridge/protocol";
import { isClaudeTranscriptControlMessage } from "@bridge/protocol";

export interface BridgeEventDraft {
  sessionId?: string;
  turnId?: string;
  itemId?: string;
  timestamp?: number;
  origin: BridgeOrigin;
  type: BridgeEventType;
  data?: Record<string, unknown>;
}

interface PendingDelta {
  draft: BridgeEventDraft;
  text: string;
  timer: ReturnType<typeof setTimeout>;
}

function isEvent(value: unknown): value is BridgeEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<BridgeEvent>;
  return (
    typeof event.eventId === "string" &&
    typeof event.seq === "number" &&
    typeof event.timestamp === "number" &&
    typeof event.origin === "string" &&
    typeof event.type === "string" &&
    Boolean(event.data) &&
    typeof event.data === "object"
  );
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function historyItem(event: BridgeEvent): BridgeHistoryItem | undefined {
  if (!event.sessionId) return undefined;
  const base = {
    sessionId: event.sessionId,
    ...(event.turnId ? { turnId: event.turnId } : {}),
    createdAt: event.timestamp,
    origin: event.origin,
  };
  if (event.type === "user.message.accepted") {
    const text = textValue(event.data.text);
    const attachments = Array.isArray(event.data.attachments)
      ? event.data.attachments as BridgeHistoryItem["attachments"]
      : undefined;
    if (!text && !attachments?.length) return undefined;
    return {
      ...base,
      id: event.itemId ?? event.eventId,
      role: "user",
      text,
      ...(attachments?.length ? { attachments } : {}),
    };
  }
  if (event.type === "assistant.completed") {
    const text = textValue(event.data.text);
    if (!text) return undefined;
    return { ...base, id: event.itemId ?? event.eventId, role: "assistant", text };
  }
  if (event.type === "session.observed") {
    const role = event.data.role;
    const text = textValue(event.data.text);
    if ((role !== "user" && role !== "assistant") || !text) return undefined;
    if (isClaudeTranscriptControlMessage(role, text)) return undefined;
    return { ...base, id: event.itemId ?? event.eventId, role, text };
  }
  if (event.type === "tool.started") {
    const toolName = textValue(event.data.toolName) || "Tool";
    return {
      ...base,
      id: event.itemId ?? event.eventId,
      role: "tool",
      toolName,
      text: textValue(event.data.summary) || `${toolName} started`,
      state: "running",
    };
  }
  if (event.type === "tool.completed") {
    const toolName = textValue(event.data.toolName) || "Tool";
    return {
      ...base,
      id: `${event.itemId ?? event.eventId}:completed`,
      role: "tool",
      toolName,
      text: textValue(event.data.summary) || `${toolName} completed`,
      state: "completed",
    };
  }
  if (event.type === "turn.failed") {
    return {
      ...base,
      id: event.eventId,
      role: "system",
      text: textValue(event.data.error) || "Turn failed",
      state: "failed",
    };
  }
  if (event.type === "turn.interrupted") {
    return {
      ...base,
      id: event.eventId,
      role: "system",
      text: "Turn stopped",
      state: "interrupted",
    };
  }
  return undefined;
}

export class SessionEventLog extends EventEmitter {
  private readonly events: BridgeEvent[] = [];
  private readonly itemKeys = new Set<string>();
  private readonly latestItems = new Map<string, BridgeEvent>();
  private readonly pendingDeltas = new Map<string, PendingDelta>();
  private writeQueue: Promise<void> = Promise.resolve();
  private nextSeq = 1;
  private initialized = false;

  constructor(
    readonly path: string,
    private readonly deltaWindowMs = 80,
  ) {
    super();
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    let raw = "";
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (!isEvent(parsed)) continue;
        this.events.push(parsed);
        this.nextSeq = Math.max(this.nextSeq, parsed.seq + 1);
        if (parsed.itemId) {
          const key = `${parsed.sessionId ?? ""}\u001f${parsed.type}\u001f${parsed.itemId}`;
          this.itemKeys.add(key);
          this.latestItems.set(key, parsed);
        }
      } catch {
        // A partial trailing line can be left by a hard power loss and is ignored.
      }
    }
    this.events.sort((left, right) => left.seq - right.seq);
  }

  latestSeq(): number {
    return this.nextSeq - 1;
  }

  hasItem(sessionId: string, type: BridgeEventType, itemId: string): boolean {
    return this.itemKeys.has(`${sessionId}\u001f${type}\u001f${itemId}`);
  }

  latestItem(sessionId: string, type: BridgeEventType, itemId: string): BridgeEvent | undefined {
    return this.latestItems.get(`${sessionId}\u001f${type}\u001f${itemId}`);
  }

  async append(draft: BridgeEventDraft): Promise<BridgeEvent> {
    await this.initialize();
    const event: BridgeEvent = {
      eventId: randomUUID(),
      seq: this.nextSeq++,
      timestamp: draft.timestamp ?? Date.now(),
      origin: draft.origin,
      type: draft.type,
      data: draft.data ?? {},
      ...(draft.sessionId ? { sessionId: draft.sessionId } : {}),
      ...(draft.turnId ? { turnId: draft.turnId } : {}),
      ...(draft.itemId ? { itemId: draft.itemId } : {}),
    };
    this.events.push(event);
    if (event.itemId) {
      const key = `${event.sessionId ?? ""}\u001f${event.type}\u001f${event.itemId}`;
      this.itemKeys.add(key);
      this.latestItems.set(key, event);
    }
    const line = `${JSON.stringify(event)}\n`;
    this.writeQueue = this.writeQueue.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(this.path, line, { flag: "a", encoding: "utf8", mode: 0o600 });
    });
    await this.writeQueue;
    this.emit("event", event);
    return event;
  }

  appendCoalescedDelta(draft: BridgeEventDraft, text: string): void {
    if (!draft.sessionId || !draft.itemId || !text) return;
    const key = `${draft.sessionId}\u001f${draft.turnId ?? ""}\u001f${draft.itemId}`;
    const existing = this.pendingDeltas.get(key);
    if (existing) {
      existing.text += text;
      return;
    }
    const pending: PendingDelta = {
      draft,
      text,
      timer: setTimeout(() => {
        void this.flushDelta(key);
      }, this.deltaWindowMs),
    };
    this.pendingDeltas.set(key, pending);
  }

  async flushDeltas(sessionId?: string): Promise<void> {
    const keys = [...this.pendingDeltas.entries()]
      .filter(([, delta]) => !sessionId || delta.draft.sessionId === sessionId)
      .map(([key]) => key);
    await Promise.all(keys.map((key) => this.flushDelta(key)));
  }

  replay(afterSeq = 0, limit = 500, sessionId?: string): BridgeEvent[] {
    return this.events
      .filter((event) => event.seq > afterSeq && (!sessionId || event.sessionId === sessionId))
      .slice(0, Math.max(1, Math.min(limit, 1_000)));
  }

  history(sessionId: string, cursor?: string, limit = 50): BridgeHistoryPage {
    const beforeSeq = cursor ? Number.parseInt(cursor, 10) : Number.POSITIVE_INFINITY;
    const all = this.events
      .filter((event) => event.sessionId === sessionId && event.seq < beforeSeq)
      .map(historyItem)
      .filter((item): item is BridgeHistoryItem => item !== undefined);
    const pageSize = Math.max(1, Math.min(limit, 10_000));
    const items = all.slice(-pageSize);
    const first = items[0];
    const firstEvent = first
      ? this.events.find((event) => (event.itemId ?? event.eventId) === first.id.replace(/:completed$/u, ""))
      : undefined;
    const hasMore = all.length > items.length;
    return {
      sessionId,
      items,
      hasMore,
      ...(hasMore && firstEvent ? { nextCursor: String(firstEvent.seq) } : {}),
    };
  }

  async close(): Promise<void> {
    for (const delta of this.pendingDeltas.values()) clearTimeout(delta.timer);
    await this.flushDeltas();
    await this.writeQueue.catch(() => undefined);
  }

  private async flushDelta(key: string): Promise<void> {
    const pending = this.pendingDeltas.get(key);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingDeltas.delete(key);
    await this.append({
      ...pending.draft,
      type: "assistant.delta",
      data: { ...pending.draft.data, text: pending.text },
    });
  }
}
