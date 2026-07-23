import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  query as createQuery,
  type CanUseTool,
  type ModelInfo,
  type Query,
  type SDKControlGetContextUsageResponse,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { BridgeAttachment } from "@bridge/protocol";
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
  cwd: string;
  executablePath: string;
  environment: NodeJS.ProcessEnv;
  permissionBroker: PermissionBroker;
  resume: boolean;
  model?: string;
  effort?: ClaudeSessionEffort;
  settingSources?: Array<"user" | "project" | "local">;
  queryFactory?: typeof createQuery;
}

export interface SessionHostInput {
  text: string;
  attachments?: BridgeAttachment[];
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

function partialText(message: SDKMessage): { itemId: string; text: string } | undefined {
  if (message.type !== "stream_event") return undefined;
  const event = message.event as unknown;
  if (!isRecord(event) || event.type !== "content_block_delta" || !isRecord(event.delta)) return undefined;
  if (event.delta.type !== "text_delta" || typeof event.delta.text !== "string") return undefined;
  const index = typeof event.index === "number" ? event.index : 0;
  return { itemId: `${message.uuid}:${index}`, text: event.delta.text };
}

export class ClaudeSessionHost extends EventEmitter {
  private readonly input = new AsyncInputQueue<SDKUserMessage>();
  private readonly queryFactory: typeof createQuery;
  private queryProcess: Query | undefined;
  private streamTask: Promise<void> | undefined;
  private sessionIdValue: string;
  private currentTurnId: string | undefined;
  private modelValue: string | undefined;
  private effortValue: ClaudeSessionEffort | undefined;
  private closed = false;

  constructor(private readonly options: ClaudeSessionHostOptions) {
    super();
    this.queryFactory = options.queryFactory ?? createQuery;
    this.sessionIdValue = options.sessionId;
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
    if (this.streamTask) return;
    const canUseTool: CanUseTool = async (toolName, input, context) => (
      this.options.permissionBroker.request(this.sessionIdValue, toolName, input, {
        signal: context.signal,
        toolUseId: context.toolUseID,
        ...(context.suggestions ? { suggestions: context.suggestions } : {}),
        ...(context.title ? { title: context.title } : {}),
        ...(context.displayName ? { displayName: context.displayName } : {}),
        ...(context.description ? { description: context.description } : {}),
      })
    );
    this.queryProcess = this.queryFactory({
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
        persistSession: true,
        ...(this.modelValue ? { model: this.modelValue } : {}),
        ...(this.effortValue ? { effort: this.effortValue } : {}),
        ...(this.options.resume
          ? { resume: this.options.sessionId, forkSession: false }
          : { sessionId: this.options.sessionId }),
      },
    });
    this.emitEvent({
      type: "runtime.started",
      sessionId: this.sessionIdValue,
      cwd: this.options.cwd,
      at: Date.now(),
    });
    this.streamTask = this.consume();
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
    this.start();
    const messageId = randomUUID();
    const turnId = randomUUID();
    this.currentTurnId = turnId;
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
    this.input.push({
      type: "user",
      message: { role: "user", content } as unknown as SDKUserMessage["message"],
      parent_tool_use_id: null,
      origin: { kind: "human" },
      uuid: messageId,
      session_id: this.sessionIdValue,
    });
    return { messageId, turnId };
  }

  async interrupt(): Promise<void> {
    if (!this.queryProcess) return;
    await this.queryProcess.interrupt();
    this.emitEvent({
      type: "turn.interrupted",
      sessionId: this.sessionIdValue,
      ...(this.currentTurnId ? { turnId: this.currentTurnId } : {}),
      at: Date.now(),
    });
    this.currentTurnId = undefined;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.input.close();
    this.options.permissionBroker.cancelSession(this.sessionIdValue);
    this.queryProcess?.close();
    await this.streamTask?.catch(() => undefined);
    this.emitEvent({ type: "runtime.stopped", sessionId: this.sessionIdValue, at: Date.now() });
  }

  private async consume(): Promise<void> {
    try {
      for await (const message of this.queryProcess!) this.handleMessage(message);
    } catch (error) {
      if (!this.closed) {
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
    this.start();
    if (!this.queryProcess) throw new Error("Session host failed to start");
    return this.queryProcess;
  }

  private handleMessage(message: SDKMessage): void {
    if ("session_id" in message && typeof message.session_id === "string") {
      this.sessionIdValue = message.session_id;
    }
    const turnId = this.currentTurnId;
    const partial = partialText(message);
    if (partial) {
      this.emitEvent({
        type: "assistant.delta",
        sessionId: this.sessionIdValue,
        ...(turnId ? { turnId } : {}),
        itemId: partial.itemId,
        text: partial.text,
        at: Date.now(),
      });
      return;
    }
    if (message.type === "assistant") {
      const text = textBlocks(message.message.content).join("\n\n").trim();
      if (text) {
        this.emitEvent({
          type: "assistant.completed",
          sessionId: this.sessionIdValue,
          ...(turnId ? { turnId } : {}),
          itemId: message.uuid,
          text,
          at: Date.now(),
        });
      }
      for (const tool of toolBlocks(message.message.content)) {
        this.emitEvent({
          type: "tool.started",
          sessionId: this.sessionIdValue,
          ...(turnId ? { turnId } : {}),
          itemId: tool.id,
          toolName: tool.name,
          input: tool.input,
          at: Date.now(),
        });
      }
      return;
    }
    if (message.type === "user" && message.tool_use_result !== undefined) {
      this.emitEvent({
        type: "tool.completed",
        sessionId: this.sessionIdValue,
        ...(turnId ? { turnId } : {}),
        itemId: message.parent_tool_use_id ?? message.uuid ?? randomUUID(),
        output: message.tool_use_result,
        at: Date.now(),
      });
      return;
    }
    if (message.type === "tool_progress") {
      this.emitEvent({
        type: "tool.progress",
        sessionId: this.sessionIdValue,
        ...(turnId ? { turnId } : {}),
        itemId: message.tool_use_id,
        text: `${message.tool_name} ${Math.round(message.elapsed_time_seconds)}s`,
        at: Date.now(),
      });
      return;
    }
    if (message.type === "result") {
      if (
        message.subtype === "success" &&
        !message.is_error &&
        !/^API Error:/iu.test(message.result.trim())
      ) {
        this.emitEvent({
          type: "turn.completed",
          sessionId: this.sessionIdValue,
          ...(turnId ? { turnId } : {}),
          result: message.result,
          at: Date.now(),
        });
      } else {
        this.emitEvent({
          type: "turn.failed",
          sessionId: this.sessionIdValue,
          ...(turnId ? { turnId } : {}),
          error: message.subtype === "success"
            ? message.result
            : message.errors.join("\n") || message.subtype,
          at: Date.now(),
        });
      }
      this.currentTurnId = undefined;
    }
  }

  private emitEvent(event: SessionHostEvent): void {
    this.emit("event", event);
  }
}
