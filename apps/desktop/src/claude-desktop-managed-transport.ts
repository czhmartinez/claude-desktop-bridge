import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type {
  BridgeAttachment,
  BridgeEffort,
  BridgeSessionContextUsage,
  BridgeSessionInfo,
} from "@bridge/protocol";
import type { SessionHostEvent, SessionHostOrigin } from "./claude-session-host.js";
import type { ClaudeCatalogSnapshot } from "./claude-session-catalog.js";
import type { ClaudeDesktopIntegrationSnapshot } from "./claude-desktop-manager.js";
import type { PermissionBroker, PermissionDecision } from "./permission-broker.js";

interface ManagedDesktopSession {
  sessionId: string;
  cwd: string;
  originCwd?: string;
  isRunning: boolean;
  model?: string;
  effort?: string;
  title?: string;
  lastActivityAt?: number;
}

interface ManagedTurnIntent {
  sessionId: string;
  desktopSessionId: string;
  messageId: string;
  turnId: string;
  text: string;
  attachments: BridgeAttachment[];
  origin: SessionHostOrigin;
  createdAt: number;
  mode: "start" | "steer";
  queuedBehindActive: boolean;
  confirmed: boolean;
  uncertain: boolean;
}

export interface ManagedSendInput {
  session: BridgeSessionInfo;
  text: string;
  attachments: BridgeAttachment[];
  origin: SessionHostOrigin;
  mode: "start" | "steer";
  model?: string;
  effort?: BridgeEffort;
  messageId?: string;
  turnId?: string;
}

export interface ManagedDeliveryUncertain {
  sessionId: string;
  turnId: string;
  messageId: string;
  error: string;
  at: number;
}

export class ManagedDeliveryUncertainError extends Error {
  constructor(
    message: string,
    readonly intent: ManagedDeliveryUncertain,
  ) {
    super(message);
    this.name = "ManagedDeliveryUncertainError";
  }
}

export interface ClaudeDesktopManagedTransportOptions {
  manager: {
    readonly ready: boolean;
    call(method: string, args?: unknown[]): Promise<unknown>;
    status(): ClaudeDesktopIntegrationSnapshot;
    on(event: string, listener: (...args: any[]) => void): unknown;
    off(event: string, listener: (...args: any[]) => void): unknown;
  };
  permissionBroker: PermissionBroker;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function textBlocks(content: unknown): string[] {
  if (typeof content === "string") return content.trim() ? [content] : [];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    const value = record(block);
    return value?.type === "text" && typeof value.text === "string" ? [value.text] : [];
  });
}

function toolBlocks(content: unknown): Array<{ id: string; name: string; input: unknown }> {
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    const value = record(block);
    if (value?.type !== "tool_use" || typeof value.id !== "string" || typeof value.name !== "string") return [];
    return [{ id: value.id, name: value.name, input: value.input }];
  });
}

function imagePayload(attachments: BridgeAttachment[]): Array<{
  base64: string;
  mimeType: string;
  filename: string;
}> | undefined {
  if (!attachments.length) return undefined;
  return attachments.map((attachment) => ({
    base64: attachment.data,
    mimeType: attachment.mimeType,
    filename: attachment.name,
  }));
}

function managedSession(value: unknown): ManagedDesktopSession | undefined {
  const candidate = record(value);
  if (
    !candidate ||
    typeof candidate.sessionId !== "string" ||
    typeof candidate.cwd !== "string" ||
    typeof candidate.isRunning !== "boolean"
  ) return undefined;
  return {
    sessionId: candidate.sessionId,
    cwd: candidate.cwd,
    isRunning: candidate.isRunning,
    ...(typeof candidate.originCwd === "string" ? { originCwd: candidate.originCwd } : {}),
    ...(typeof candidate.model === "string" ? { model: candidate.model } : {}),
    ...(typeof candidate.effort === "string" ? { effort: candidate.effort } : {}),
    ...(typeof candidate.title === "string" ? { title: candidate.title } : {}),
    ...(typeof candidate.lastActivityAt === "number" ? { lastActivityAt: candidate.lastActivityAt } : {}),
  };
}

function contextUsage(value: unknown): BridgeSessionContextUsage | undefined {
  const usage = record(value);
  if (!usage) return undefined;
  const totalTokens = [
    usage.totalTokens,
    usage.total_tokens,
    usage.usedTokens,
    usage.used_tokens,
    usage.contextTokens,
  ].find((candidate): candidate is number => typeof candidate === "number" && Number.isFinite(candidate));
  const maxTokens = [
    usage.maxTokens,
    usage.max_tokens,
    usage.contextWindow,
    usage.context_window,
  ].find((candidate): candidate is number => typeof candidate === "number" && Number.isFinite(candidate));
  if (totalTokens === undefined || maxTokens === undefined || maxTokens <= 0) return undefined;
  return {
    totalTokens,
    maxTokens,
    percentage: Math.min(100, Math.max(0, (totalTokens / maxTokens) * 100)),
    ...(typeof usage.model === "string" ? { model: usage.model } : {}),
    estimated: false,
  };
}

function explicitCallFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(failed to pass validation|unsupported claude desktop method|invalid (request|argument)|unknown session)/iu.test(message);
}

export class ClaudeDesktopManagedTransport extends EventEmitter {
  private readonly bridgeToDesktop = new Map<string, string>();
  private readonly desktopToBridge = new Map<string, string>();
  private readonly active = new Map<string, ManagedTurnIntent[]>();
  private readonly fingerprints = new Set<string>();
  private readonly managerStatusListener = () => this.handleManagerStatus();
  private readonly managerEventListener = (value: unknown) => this.handleRawEvent(value);
  private readonly managerPermissionListener = (value: unknown) => this.handlePermission(value);

  constructor(private readonly options: ClaudeDesktopManagedTransportOptions) {
    super();
    options.manager.on("status", this.managerStatusListener);
    options.manager.on("session-event", this.managerEventListener);
    options.manager.on("permission-request", this.managerPermissionListener);
  }

  get ready(): boolean {
    return this.options.manager.ready;
  }

  updateCatalog(catalog: ClaudeCatalogSnapshot): void {
    for (const session of catalog.sessions) {
      if (!session.desktopSessionId) continue;
      this.rememberMapping(session.sessionId, session.desktopSessionId);
    }
  }

  desktopSessionId(sessionId: string): string | undefined {
    return this.bridgeToDesktop.get(sessionId);
  }

  async sessions(): Promise<ManagedDesktopSession[]> {
    const values = await this.options.manager.call("getAll");
    if (!Array.isArray(values)) throw new Error("Claude Desktop returned an invalid session list");
    return values.map(managedSession).filter((value): value is ManagedDesktopSession => Boolean(value));
  }

  async send(input: ManagedSendInput): Promise<{ messageId: string; turnId: string; desktopSessionId: string }> {
    if (!this.ready) throw new Error("Claude Desktop 同步控制当前不可用");
    const messageId = input.messageId ?? randomUUID();
    const turnId = input.turnId ?? randomUUID();
    const existingDesktopId = input.session.desktopSessionId
      ?? this.bridgeToDesktop.get(input.session.sessionId);
    const desktopSessionId = existingDesktopId ?? input.session.sessionId;
    const desktop = existingDesktopId
      ? await this.options.manager.call("getSession", [existingDesktopId]).then(managedSession, () => undefined)
      : undefined;
    const intent: ManagedTurnIntent = {
      sessionId: input.session.sessionId,
      desktopSessionId,
      messageId,
      turnId,
      text: input.text,
      attachments: input.attachments,
      origin: input.origin,
      createdAt: Date.now(),
      mode: input.mode,
      queuedBehindActive: input.mode === "start" && desktop?.isRunning === true,
      confirmed: false,
      uncertain: false,
    };
    this.intents(input.session.sessionId).push(intent);
    this.rememberMapping(input.session.sessionId, desktopSessionId);

    try {
      if (!existingDesktopId) {
        const result = record(await this.options.manager.call("start", [{
          cwd: input.session.cwd,
          message: input.text,
          sessionId: input.session.sessionId,
          title: input.session.title,
          messageUuid: messageId,
          ...(input.model ? { model: input.model } : {}),
          ...(input.effort ? { effort: input.effort } : {}),
          ...(input.attachments.length ? { images: imagePayload(input.attachments) } : {}),
        }]));
        const returnedDesktopId = stringValue(result?.sessionId) ?? desktopSessionId;
        intent.desktopSessionId = returnedDesktopId;
        this.rememberMapping(input.session.sessionId, returnedDesktopId);
      } else {
        const priority = input.mode === "steer"
          ? "now"
          : desktop?.isRunning
            ? "later"
            : undefined;
        await this.options.manager.call("sendMessage", [
          existingDesktopId,
          input.text,
          imagePayload(input.attachments),
          undefined,
          undefined,
          priority,
          input.mode === "steer" ? { ccdSteering: true, queuedMessageBar: true } : undefined,
        ]);
      }
    } catch (error) {
      if (explicitCallFailure(error)) {
        this.removeIntent(intent);
        throw error;
      }
      const uncertain = this.markUncertain(intent, error instanceof Error ? error.message : String(error));
      throw new ManagedDeliveryUncertainError(uncertain.error, uncertain);
    }
    return {
      messageId,
      turnId,
      desktopSessionId: intent.desktopSessionId,
    };
  }

  async interrupt(sessionId: string): Promise<void> {
    const desktopSessionId = this.bridgeToDesktop.get(sessionId);
    if (!desktopSessionId) throw new Error("Claude Desktop session mapping is unavailable");
    await this.options.manager.call("interrupt", [desktopSessionId]);
  }

  async setModel(sessionId: string, model: string): Promise<void> {
    const desktopSessionId = this.bridgeToDesktop.get(sessionId);
    if (!desktopSessionId) throw new Error("Claude Desktop session mapping is unavailable");
    await this.options.manager.call("setModel", [desktopSessionId, model]);
  }

  async setEffort(sessionId: string, effort?: BridgeEffort): Promise<void> {
    const desktopSessionId = this.bridgeToDesktop.get(sessionId);
    if (!desktopSessionId) throw new Error("Claude Desktop session mapping is unavailable");
    await this.options.manager.call("setEffort", [desktopSessionId, effort ?? null]);
  }

  async getContextUsage(sessionId: string): Promise<BridgeSessionContextUsage | undefined> {
    const desktopSessionId = this.bridgeToDesktop.get(sessionId);
    if (!desktopSessionId) return undefined;
    return contextUsage(await this.options.manager.call("getContextUsage", [desktopSessionId]));
  }

  clearIntent(sessionId: string): void {
    this.active.delete(sessionId);
  }

  onEvent(listener: (event: SessionHostEvent) => void): () => void {
    this.on("event", listener);
    return () => this.off("event", listener);
  }

  onDeliveryUncertain(listener: (event: ManagedDeliveryUncertain) => void): () => void {
    this.on("delivery-uncertain", listener);
    return () => this.off("delivery-uncertain", listener);
  }

  close(): void {
    this.options.manager.off("status", this.managerStatusListener);
    this.options.manager.off("session-event", this.managerEventListener);
    this.options.manager.off("permission-request", this.managerPermissionListener);
    this.removeAllListeners();
  }

  private rememberMapping(sessionId: string, desktopSessionId: string): void {
    const previous = this.bridgeToDesktop.get(sessionId);
    if (previous && previous !== desktopSessionId) this.desktopToBridge.delete(previous);
    this.bridgeToDesktop.set(sessionId, desktopSessionId);
    this.desktopToBridge.set(desktopSessionId, sessionId);
  }

  private bridgeSessionId(localSessionId: string, message?: Record<string, unknown>): string {
    const cliSessionId = stringValue(message?.session_id);
    if (cliSessionId) {
      this.rememberMapping(cliSessionId, localSessionId);
      return cliSessionId;
    }
    return this.desktopToBridge.get(localSessionId) ?? localSessionId;
  }

  private handleManagerStatus(): void {
    const status = this.options.manager.status();
    if (status.state === "ready" || status.state === "starting") return;
    for (const intents of this.active.values()) {
      for (const intent of intents) {
        if (!intent.confirmed && !intent.uncertain) {
          this.markUncertain(intent, status.lastError ?? status.detail);
        }
      }
    }
  }

  private handleRawEvent(raw: unknown): void {
    const value = record(raw);
    if (!value) return;
    const session = managedSession(value.session);
    const localSessionId = stringValue(value.sessionId)
      ?? session?.sessionId
      ?? stringValue(record(value.request)?.sessionId);
    if (!localSessionId) return;
    const messages = [
      ...(value.message !== undefined ? [value.message] : []),
      ...(Array.isArray(value.messages) ? value.messages : []),
    ];
    const firstMessage = messages.map(record).find(Boolean);
    const sessionId = this.bridgeSessionId(localSessionId, firstMessage);
    if (session) this.rememberMapping(sessionId, session.sessionId);

    const eventType = stringValue(value.type)?.toLocaleLowerCase() ?? "";
    if (stringValue(value.userMessageUuid)) {
      this.confirmIntent(sessionId, stringValue(value.userMessageUuid));
    }
    if (session?.isRunning || /(started|running|query_start)/u.test(eventType)) {
      this.emitTurnStarted(sessionId);
    }
    for (const message of messages) this.handleSdkMessage(localSessionId, message);
    if (typeof value.error === "string" && value.error) {
      const intent = this.active.get(sessionId);
      const primary = intent?.find((candidate) => candidate.mode === "start")
        ?? intent?.[0];
      this.emitUnique({
        type: "turn.failed",
        sessionId,
        ...(primary ? { turnId: primary.turnId } : {}),
        error: value.error,
        at: Date.now(),
      }, `error:${value.error}`);
      this.active.delete(sessionId);
    }
    if (
      session?.isRunning === false &&
      this.primaryIntent(sessionId)?.confirmed &&
      !/(started|running|query_start)/u.test(eventType)
    ) {
      const intent = this.primaryIntent(sessionId);
      if (intent) {
        this.emitUnique({
          type: "turn.completed",
          sessionId,
          turnId: intent.turnId,
          result: "",
          at: Date.now(),
        }, `idle:${session.lastActivityAt ?? Date.now()}`);
        this.active.delete(sessionId);
      }
    }
  }

  private handleSdkMessage(localSessionId: string, raw: unknown): void {
    const message = record(raw);
    if (!message || typeof message.type !== "string") return;
    const sessionId = this.bridgeSessionId(localSessionId, message);
    const intent = this.primaryIntent(sessionId);
    const turnId = intent?.turnId;
    const at = typeof message.timestamp === "number" ? message.timestamp : Date.now();
    if (message.type === "stream_event") {
      const stream = record(message.event);
      const delta = record(stream?.delta);
      if (stream?.type === "content_block_delta" && delta?.type === "text_delta" && typeof delta.text === "string") {
        const index = typeof stream.index === "number" ? stream.index : 0;
        this.emitUnique({
          type: "assistant.delta",
          sessionId,
          ...(turnId ? { turnId } : {}),
          itemId: `${stringValue(message.uuid) ?? "stream"}:${index}`,
          text: delta.text,
          at,
        }, `delta:${stringValue(message.uuid) ?? ""}:${index}:${delta.text}`);
      }
      return;
    }
    if (message.type === "assistant") {
      const body = record(message.message);
      const text = textBlocks(body?.content).join("\n\n").trim();
      const itemId = stringValue(message.uuid) ?? randomUUID();
      if (text) {
        this.emitUnique({
          type: "assistant.completed",
          sessionId,
          ...(turnId ? { turnId } : {}),
          itemId,
          text,
          at,
        }, `assistant:${itemId}:${text}`);
      }
      for (const tool of toolBlocks(body?.content)) {
        this.emitUnique({
          type: "tool.started",
          sessionId,
          ...(turnId ? { turnId } : {}),
          itemId: tool.id,
          toolName: tool.name,
          input: tool.input,
          at,
        }, `tool-start:${tool.id}`);
      }
      return;
    }
    if (message.type === "user") {
      const body = record(message.message);
      const text = textBlocks(body?.content).join("\n\n").trim();
      if (message.tool_use_result !== undefined || message.parent_tool_use_id) {
        const itemId = stringValue(message.parent_tool_use_id)
          ?? stringValue(message.uuid)
          ?? randomUUID();
        this.emitUnique({
          type: "tool.completed",
          sessionId,
          ...(turnId ? { turnId } : {}),
          itemId,
          output: message.tool_use_result,
          at,
        }, `tool-complete:${itemId}`);
      } else if (text || intent?.attachments.length) {
        this.confirmIntent(sessionId, stringValue(message.uuid), text);
      }
      return;
    }
    if (message.type === "tool_progress") {
      const itemId = stringValue(message.tool_use_id) ?? randomUUID();
      const toolName = stringValue(message.tool_name) ?? "Tool";
      const seconds = typeof message.elapsed_time_seconds === "number"
        ? Math.round(message.elapsed_time_seconds)
        : 0;
      this.emitUnique({
        type: "tool.progress",
        sessionId,
        ...(turnId ? { turnId } : {}),
        itemId,
        text: `${toolName} ${seconds}s`,
        at,
      }, `tool-progress:${itemId}:${seconds}`);
      return;
    }
    if (message.type !== "result") return;
    const result = typeof message.result === "string" ? message.result : "";
    const subtype = stringValue(message.subtype) ?? "unknown";
    const failed = message.is_error === true || subtype !== "success" || /^API Error:/iu.test(result.trim());
    if (failed) {
      const errors = Array.isArray(message.errors)
        ? message.errors.filter((entry): entry is string => typeof entry === "string").join("\n")
        : "";
      this.emitUnique({
        type: "turn.failed",
        sessionId,
        ...(turnId ? { turnId } : {}),
        error: result || errors || subtype,
        at,
      }, `result-failed:${stringValue(message.uuid) ?? result}`);
    } else {
      this.emitUnique({
        type: "turn.completed",
        sessionId,
        ...(turnId ? { turnId } : {}),
        result,
        at,
      }, `result:${stringValue(message.uuid) ?? result}`);
    }
    this.active.delete(sessionId);
  }

  private confirmIntent(sessionId: string, messageId?: string, observedText?: string): void {
    const intents = this.active.get(sessionId) ?? [];
    const intent = intents.find((candidate) => (
      !candidate.confirmed &&
      (
        Boolean(messageId && candidate.messageId === messageId) ||
        Boolean(observedText && candidate.text === observedText)
      )
    )) ?? intents.find((candidate) => !candidate.confirmed);
    if (!intent || intent.confirmed) return;
    intent.confirmed = true;
    intent.uncertain = false;
    this.emitTurnStarted(sessionId);
    this.emitUnique({
      type: "user.accepted",
      sessionId,
      turnId: intent.turnId,
      messageId: messageId ?? intent.messageId,
      text: observedText ?? intent.text,
      attachments: intent.attachments.map(({ data: _data, ...attachment }) => attachment),
      origin: intent.origin,
      at: Date.now(),
    }, `user:${messageId ?? intent.messageId}`);
    if (intent.mode === "steer") this.removeIntent(intent);
  }

  private emitTurnStarted(sessionId: string): void {
    for (const intent of this.active.get(sessionId) ?? []) {
      if (intent.queuedBehindActive && !intent.confirmed) continue;
      this.emitUnique({
        type: "turn.started",
        sessionId,
        turnId: intent.turnId,
        at: Date.now(),
      }, `turn-start:${intent.turnId}`);
    }
  }

  private handlePermission(raw: unknown): void {
    const value = record(raw);
    const request = record(value?.request) ?? value;
    if (
      !request ||
      typeof request.requestId !== "string" ||
      typeof request.sessionId !== "string" ||
      typeof request.toolName !== "string"
    ) return;
    const sessionId = this.desktopToBridge.get(request.sessionId) ?? request.sessionId;
    const input = record(request.input) ?? {};
    this.options.permissionBroker.registerExternal({
      requestId: request.requestId,
      sessionId,
      toolName: request.toolName,
      input,
      ...(stringValue(request.toolUseId) ?? stringValue(request.toolUseID)
        ? { toolUseId: stringValue(request.toolUseId) ?? stringValue(request.toolUseID)! }
        : {}),
      ...(stringValue(request.title) ? { title: stringValue(request.title)! } : {}),
      ...(stringValue(request.displayName) ? { displayName: stringValue(request.displayName)! } : {}),
      ...(stringValue(request.description) ?? stringValue(request.decisionReason)
        ? { description: (stringValue(request.description) ?? stringValue(request.decisionReason))! }
        : {}),
    }, async (decision, updatedInput) => {
      const desktopDecision = this.desktopPermissionDecision(decision);
      await this.options.manager.call("respondToToolPermission", [
        request.requestId,
        desktopDecision,
        updatedInput,
      ]);
    });
  }

  private desktopPermissionDecision(decision: PermissionDecision): "once" | "always" | "deny" {
    if (decision === "allow-always") return "always";
    if (decision === "allow-once") return "once";
    return "deny";
  }

  private markUncertain(intent: ManagedTurnIntent, error: string): ManagedDeliveryUncertain {
    intent.uncertain = true;
    const value: ManagedDeliveryUncertain = {
      sessionId: intent.sessionId,
      turnId: intent.turnId,
      messageId: intent.messageId,
      error: error || "Claude Desktop 在确认消息前断开，发送结果需要人工确认。",
      at: Date.now(),
    };
    this.emit("delivery-uncertain", value);
    return value;
  }

  private intents(sessionId: string): ManagedTurnIntent[] {
    const existing = this.active.get(sessionId);
    if (existing) return existing;
    const created: ManagedTurnIntent[] = [];
    this.active.set(sessionId, created);
    return created;
  }

  private primaryIntent(sessionId: string): ManagedTurnIntent | undefined {
    const intents = this.active.get(sessionId) ?? [];
    return intents.find((candidate) => candidate.mode === "start" && candidate.confirmed)
      ?? intents.find((candidate) => candidate.mode === "start" && !candidate.queuedBehindActive)
      ?? intents.find((candidate) => candidate.mode === "start")
      ?? intents[0];
  }

  private removeIntent(intent: ManagedTurnIntent): void {
    const intents = this.active.get(intent.sessionId);
    if (!intents) return;
    const next = intents.filter((candidate) => candidate !== intent);
    if (next.length) this.active.set(intent.sessionId, next);
    else this.active.delete(intent.sessionId);
  }

  private emitUnique(event: SessionHostEvent, discriminator: string): void {
    const key = createHash("sha256")
      .update(`${event.sessionId}\0${event.type}\0${discriminator}`)
      .digest("base64url")
      .slice(0, 24);
    if (this.fingerprints.has(key)) return;
    this.fingerprints.add(key);
    while (this.fingerprints.size > 5_000) {
      const oldest = this.fingerprints.values().next().value as string | undefined;
      if (!oldest) break;
      this.fingerprints.delete(oldest);
    }
    this.emit("event", event);
  }
}
