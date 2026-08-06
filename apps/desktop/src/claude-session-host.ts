import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  query as createQuery,
  type CanUseTool,
  type ModelInfo,
  type Query,
  type SDKControlGetContextUsageResponse,
  type SDKMessage,
  type SDKUserMessage,
  type SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import {
  isClaudeTranscriptControlMessage,
  type BridgeAttachment,
} from "@bridge/protocol";
import { AsyncInputQueue } from "./async-input-queue.js";
import type { ClaudeSessionEffort } from "./claude-desktop-sessions.js";
import type { PermissionBroker } from "./permission-broker.js";

export type SessionHostOrigin = "desktop" | "mobile" | "system";

export type SessionHostEvent =
  | { type: "runtime.started"; sessionId: string; cwd: string; at: number }
  | { type: "runtime.stopped"; sessionId: string; at: number }
  | { type: "turn.started"; sessionId: string; turnId: string; at: number }
  | {
      type: "user.accepted";
      sessionId: string;
      turnId: string;
      messageId: string;
      text: string;
      attachments: Array<Omit<BridgeAttachment, "data">>;
      origin: SessionHostOrigin;
      at: number;
    }
  | { type: "assistant.delta"; sessionId: string; turnId?: string; itemId: string; text: string; at: number }
  | { type: "assistant.completed"; sessionId: string; turnId?: string; itemId: string; text: string; at: number }
  | { type: "tool.started"; sessionId: string; turnId?: string; itemId: string; toolName: string; input: unknown; at: number }
  | { type: "tool.progress"; sessionId: string; turnId?: string; itemId: string; text: string; at: number }
  | { type: "tool.completed"; sessionId: string; turnId?: string; itemId: string; output: unknown; at: number }
  | { type: "turn.completed"; sessionId: string; turnId?: string; result: string; at: number }
  | { type: "turn.failed"; sessionId: string; turnId?: string; error: string; at: number }
  | { type: "turn.interrupted"; sessionId: string; turnId?: string; at: number }
  | { type: "runtime.error"; sessionId: string; error: string; at: number };

export interface ClaudeSessionHostOptions {
  sessionId: string;
  eventSessionId?: string;
  cwd: string;
  executablePath: string;
  environment: NodeJS.ProcessEnv;
  permissionBroker: PermissionBroker;
  resume: boolean;
  model?: string;
  effort?: ClaudeSessionEffort;
  settingSources?: Array<"user" | "project" | "local">;
  persistSession?: boolean;
  queryFactory?: typeof createQuery;
}

export interface SessionHostInput {
  text: string;
  attachments?: BridgeAttachment[];
}

function needsWindowsShell(executablePath: string): boolean {
  return process.platform === "win32" && /\.(?:cmd|bat)$/iu.test(executablePath);
}

function spawnWindowsShim(options: SpawnOptions) {
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    shell: true,
  });
  options.signal.addEventListener("abort", () => {
    if (!child.killed) child.kill();
  }, { once: true });
  return child;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textBlocks(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => (
    isRecord(block) && block.type === "text" && typeof block.text === "string"
      ? [block.text]
      : []
  ));
}

function toolBlocks(content: unknown): Array<{ id: string; name: string; input: unknown }> {
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    if (!isRecord(block) || block.type !== "tool_use") return [];
    if (typeof block.id !== "string" || typeof block.name !== "string") return [];
    return [{ id: block.id, name: block.name, input: block.input }];
  });
}

function isSyntheticAssistantFailure(message: SDKMessage & { type: "assistant" }, text: string): boolean {
  const payload = message.message as unknown;
  if (!isRecord(payload) || payload.model !== "<synthetic>") return false;
  return payload.stop_reason === "model_context_window_exceeded" ||
    /^(?:Prompt is too long|API Error:|Error:)/iu.test(text);
}

function partialText(message: SDKMessage): { itemId: string; text: string } | undefined {
  if (message.type !== "stream_event") return undefined;
  const event = message.event as unknown;
  if (!isRecord(event) || event.type !== "content_block_delta" || !isRecord(event.delta)) return undefined;
  if (event.delta.type !== "text_delta" || typeof event.delta.text !== "string") return undefined;
  const index = typeof event.index === "number" ? event.index : 0;
  return { itemId: `${message.uuid}:${index}`, text: event.delta.text };
}

interface PendingTurn {
  turnId: string;
  messageId: string;
  userMessage: SDKUserMessage;
  interrupted: boolean;
  submitted: boolean;
}

export class ClaudeSessionHost extends EventEmitter {
  private input = new AsyncInputQueue<SDKUserMessage>();
  private readonly pendingTurns: PendingTurn[] = [];
  private readonly queryFactory: typeof createQuery;
  private queryProcess: Query | undefined;
  private streamTask: Promise<void> | undefined;
  private retiring = false;
  private hasStartedQuery = false;
  private sessionIdValue: string;
  private readonly eventSessionId: string;
  private currentTurnId: string | undefined;
  private modelValue: string | undefined;
  private effortValue: ClaudeSessionEffort | undefined;
  private closed = false;

  constructor(private readonly options: ClaudeSessionHostOptions) {
    super();
    this.queryFactory = options.queryFactory ?? createQuery;
    this.sessionIdValue = options.sessionId;
    this.eventSessionId = options.eventSessionId ?? options.sessionId;
    this.modelValue = options.model;
    this.effortValue = options.effort;
  }

  get sessionId(): string {
    return this.sessionIdValue;
  }

  get running(): boolean {
    return Boolean(this.streamTask) && !this.closed;
  }

  get busy(): boolean {
    return this.currentTurnId !== undefined;
  }

  onEvent(listener: (event: SessionHostEvent) => void): () => void {
    this.on("event", listener);
    return () => this.off("event", listener);
  }

  start(): void {
    if (this.retiring) throw new Error("Session host is retiring its previous writer");
    if (this.streamTask) return;
    const canUseTool: CanUseTool = async (toolName, input, context) => (
      this.options.permissionBroker.request(this.eventSessionId, toolName, input, {
        signal: context.signal,
        toolUseId: context.toolUseID,
        ...(context.suggestions ? { suggestions: context.suggestions } : {}),
        ...(context.title ? { title: context.title } : {}),
        ...(context.displayName ? { displayName: context.displayName } : {}),
        ...(context.description ? { description: context.description } : {}),
      })
    );
    const resumeExistingSession = this.options.resume || this.hasStartedQuery;
    const queryProcess = this.queryFactory({
      prompt: this.input,
      options: {
        cwd: this.options.cwd,
        env: this.options.environment,
        pathToClaudeCodeExecutable: this.options.executablePath,
        includePartialMessages: true,
        includeHookEvents: true,
        settingSources: this.options.settingSources ?? ["user", "project", "local"],
        permissionMode: "default",
        canUseTool,
        persistSession: this.options.persistSession ?? true,
        ...(this.modelValue ? { model: this.modelValue } : {}),
        ...(this.effortValue ? { effort: this.effortValue } : {}),
        ...(needsWindowsShell(this.options.executablePath)
          ? { spawnClaudeCodeProcess: spawnWindowsShim }
          : {}),
        ...(resumeExistingSession
          ? { resume: this.sessionIdValue, forkSession: false }
          : { sessionId: this.sessionIdValue }),
      },
    });
    this.hasStartedQuery = true;
    this.queryProcess = queryProcess;
    this.emitEvent({
      type: "runtime.started",
      sessionId: this.sessionIdValue,
      cwd: this.options.cwd,
      at: Date.now(),
    });
    this.streamTask = this.consume(queryProcess);
  }

  async setModel(model?: string): Promise<void> {
    if (this.modelValue === model) return;
    const query = this.activeQuery();
    await query.setModel(model);
    this.modelValue = model;
  }

  async setEffort(effort?: ClaudeSessionEffort): Promise<void> {
    if (this.effortValue === effort) return;
    const query = this.activeQuery();
    await query.applyFlagSettings({ effortLevel: effort ?? null });
    this.effortValue = effort;
  }

  async supportedModels(): Promise<ModelInfo[]> {
    return this.activeQuery().supportedModels();
  }

  async contextUsage(): Promise<SDKControlGetContextUsageResponse> {
    return this.activeQuery().getContextUsage();
  }

  send(input: string | SessionHostInput, origin: SessionHostOrigin): { messageId: string; turnId: string } {
    const normalizedInput = typeof input === "string" ? { text: input } : input;
    const normalized = normalizedInput.text.trim();
    const attachments = normalizedInput.attachments ?? [];
    if (!normalized && attachments.length === 0) throw new Error("Message cannot be empty");
    if (this.closed) throw new Error("Session host is closed");
    if (this.currentTurnId) throw new Error("Session already has a running turn");
    const messageId = randomUUID();
    const turnId = randomUUID();
    this.currentTurnId = turnId;
    const content: Array<Record<string, unknown>> = [];
    if (normalized) content.push({ type: "text", text: normalized });
    for (const attachment of attachments) {
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: attachment.mimeType,
          data: attachment.data,
        },
      });
    }
    const userMessage: SDKUserMessage = {
      type: "user",
      message: { role: "user", content } as unknown as SDKUserMessage["message"],
      parent_tool_use_id: null,
      origin: { kind: "human" },
      uuid: messageId,
      session_id: this.sessionIdValue,
    };
    const pendingTurn: PendingTurn = {
      turnId,
      messageId,
      userMessage,
      interrupted: false,
      submitted: false,
    };
    this.pendingTurns.push(pendingTurn);
    try {
      if (this.pendingTurns[0] === pendingTurn) this.submitTurn(pendingTurn);
    } catch (error) {
      this.input.removePending(userMessage);
      this.currentTurnId = undefined;
      const pendingIndex = this.pendingTurns.indexOf(pendingTurn);
      if (pendingIndex >= 0) this.pendingTurns.splice(pendingIndex, 1);
      throw error;
    }
    this.emitEvent({ type: "turn.started", sessionId: this.sessionIdValue, turnId, at: Date.now() });
    this.emitEvent({
      type: "user.accepted",
      sessionId: this.sessionIdValue,
      turnId,
      messageId,
      text: normalized,
      attachments: attachments.map(({ data: _data, ...attachment }) => attachment),
      origin,
      at: Date.now(),
    });
    return { messageId, turnId };
  }

  async interrupt(): Promise<void> {
    if (!this.queryProcess || !this.currentTurnId) return;
    const turnId = this.currentTurnId;
    const pendingTurn = this.pendingTurns.find((candidate) => candidate.turnId === turnId);
    if (!pendingTurn) return;
    pendingTurn.interrupted = true;
    if (!pendingTurn.submitted) {
      this.removePendingTurn(pendingTurn);
      this.currentTurnId = undefined;
      this.emitInterrupted(turnId);
      return;
    }
    const queryProcess = this.queryProcess;
    try {
      const receipt = await queryProcess.interrupt();
      if (receipt?.still_queued.includes(pendingTurn.messageId)) {
        const cancellable = queryProcess as Query & {
          cancelAsyncMessage?(messageId: string): Promise<boolean>;
        };
        await cancellable.cancelAsyncMessage?.(pendingTurn.messageId).catch(() => false);
        await this.retireQuery(pendingTurn, queryProcess);
      }
    } catch (error) {
      if (this.pendingTurns.includes(pendingTurn)) {
        pendingTurn.interrupted = false;
        throw error;
      }
    }
    if (this.currentTurnId === turnId) this.currentTurnId = undefined;
    this.emitInterrupted(turnId);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.input.close();
    this.pendingTurns.length = 0;
    this.options.permissionBroker.cancelSession(this.eventSessionId);
    this.queryProcess?.close();
    await this.streamTask?.catch(() => undefined);
    this.emitEvent({ type: "runtime.stopped", sessionId: this.sessionIdValue, at: Date.now() });
  }

  private async consume(queryProcess: Query): Promise<void> {
    try {
      for await (const message of queryProcess) this.handleMessage(message);
    } catch (error) {
      if (!this.closed && this.queryProcess === queryProcess) {
        this.emitEvent({
          type: "runtime.error",
          sessionId: this.sessionIdValue,
          error: error instanceof Error ? error.message : String(error),
          at: Date.now(),
        });
      }
    }
  }

  private activeQuery(): Query {
    if (this.closed) throw new Error("Session host is closed");
    if (this.retiring) throw new Error("Session host is retiring its previous writer");
    this.start();
    if (!this.queryProcess) throw new Error("Session host failed to start");
    return this.queryProcess;
  }

  private handleMessage(message: SDKMessage): void {
    if ("session_id" in message && typeof message.session_id === "string") {
      this.sessionIdValue = message.session_id;
    }
    const streamTurn = this.pendingTurns[0];
    const turnId = streamTurn?.turnId;
    const drainingInterruptedTurn = streamTurn?.interrupted === true;
    const partial = partialText(message);
    if (partial) {
      if (!turnId || drainingInterruptedTurn) return;
      this.emitEvent({
        type: "assistant.delta",
        sessionId: this.sessionIdValue,
        turnId,
        itemId: partial.itemId,
        text: partial.text,
        at: Date.now(),
      });
      return;
    }
    if (message.type === "assistant") {
      if (!turnId || drainingInterruptedTurn) return;
      const text = textBlocks(message.message.content).join("\n\n").trim();
      if (
        text &&
        !isClaudeTranscriptControlMessage("assistant", text) &&
        !isSyntheticAssistantFailure(message, text)
      ) {
        this.emitEvent({
          type: "assistant.completed",
          sessionId: this.sessionIdValue,
          turnId,
          itemId: message.uuid,
          text,
          at: Date.now(),
        });
      }
      for (const tool of toolBlocks(message.message.content)) {
        this.emitEvent({
          type: "tool.started",
          sessionId: this.sessionIdValue,
          turnId,
          itemId: tool.id,
          toolName: tool.name,
          input: tool.input,
          at: Date.now(),
        });
      }
      return;
    }
    if (message.type === "user" && message.tool_use_result !== undefined) {
      if (!turnId || drainingInterruptedTurn) return;
      this.emitEvent({
        type: "tool.completed",
        sessionId: this.sessionIdValue,
        turnId,
        itemId: message.parent_tool_use_id ?? message.uuid ?? randomUUID(),
        output: message.tool_use_result,
        at: Date.now(),
      });
      return;
    }
    if (message.type === "tool_progress") {
      if (!turnId || drainingInterruptedTurn) return;
      this.emitEvent({
        type: "tool.progress",
        sessionId: this.sessionIdValue,
        turnId,
        itemId: message.tool_use_id,
        text: `${message.tool_name} ${Math.round(message.elapsed_time_seconds)}s`,
        at: Date.now(),
      });
      return;
    }
    if (message.type === "result") {
      const settledTurn = this.pendingTurns.shift();
      if (!settledTurn) return;
      if (settledTurn.interrupted) {
        this.submitDeferredTurn();
        return;
      }
      const settledTurnId = settledTurn.turnId;
      if (
        message.subtype === "success" &&
        !message.is_error &&
        !/^API Error:/iu.test(message.result.trim())
      ) {
        this.emitEvent({
          type: "turn.completed",
          sessionId: this.sessionIdValue,
          turnId: settledTurnId,
          result: message.result,
          at: Date.now(),
        });
      } else {
        this.emitEvent({
          type: "turn.failed",
          sessionId: this.sessionIdValue,
          turnId: settledTurnId,
          error: message.subtype === "success"
            ? message.result
            : message.errors.join("\n") || message.subtype,
          at: Date.now(),
        });
      }
      if (this.currentTurnId === settledTurnId) this.currentTurnId = undefined;
      this.submitDeferredTurn();
    }
  }

  private submitTurn(turn: PendingTurn): void {
    if (turn.submitted) return;
    this.input.push(turn.userMessage);
    try {
      this.start();
      turn.submitted = true;
    } catch (error) {
      this.input.removePending(turn.userMessage);
      throw error;
    }
  }

  private submitDeferredTurn(): void {
    const nextTurn = this.pendingTurns[0];
    if (!nextTurn || nextTurn.submitted) return;
    try {
      this.submitTurn(nextTurn);
    } catch (error) {
      this.removePendingTurn(nextTurn);
      if (this.currentTurnId === nextTurn.turnId) this.currentTurnId = undefined;
      this.emitEvent({
        type: "turn.failed",
        sessionId: this.sessionIdValue,
        turnId: nextTurn.turnId,
        error: error instanceof Error ? error.message : String(error),
        at: Date.now(),
      });
    }
  }

  private removePendingTurn(turn: PendingTurn): void {
    const index = this.pendingTurns.indexOf(turn);
    if (index >= 0) this.pendingTurns.splice(index, 1);
  }

  private async retireQuery(turn: PendingTurn, queryProcess: Query): Promise<void> {
    if (this.queryProcess !== queryProcess) return;
    const streamTask = this.streamTask;
    const input = this.input;
    this.retiring = true;
    try {
      input.close();
      queryProcess.close();
      await streamTask?.catch(() => undefined);
    } finally {
      if (this.queryProcess === queryProcess) {
        this.queryProcess = undefined;
        this.streamTask = undefined;
        this.input = new AsyncInputQueue<SDKUserMessage>();
      }
      this.removePendingTurn(turn);
      this.retiring = false;
    }
  }

  private emitInterrupted(turnId: string): void {
    this.emitEvent({
      type: "turn.interrupted",
      sessionId: this.sessionIdValue,
      turnId,
      at: Date.now(),
    });
  }

  private emitEvent(event: SessionHostEvent): void {
    this.emit("event", event.sessionId === this.eventSessionId
      ? event
      : { ...event, sessionId: this.eventSessionId });
  }
}
