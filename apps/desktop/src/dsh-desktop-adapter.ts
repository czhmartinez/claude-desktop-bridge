import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { promisify } from "node:util";
import type {
  BridgeFileChangeSummary,
  BridgeModelInfo,
  BridgePermissionDecision,
  BridgeRuntimeProviderInfo,
  BridgeTokenUsage,
} from "@bridge/protocol";
import {
  DesktopRuntimeAdapter,
  type RuntimeAdapterConfiguration,
  type RuntimeAdapterConfigurationChange,
  type RuntimeAdapterHistoryItem,
  type RuntimeAdapterPermission,
  type RuntimeAdapterSession,
  type RuntimeAdapterTurnInput,
  type RuntimeAdapterTurnResult,
} from "./runtime-adapter.js";

const execFileAsync = promisify(execFile);

/** Upper bound for a single inlined image, mirroring DSH's imageLimits projection. */
const DSH_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const DSH_IMAGE_TOTAL_BYTES = 100 * 1024 * 1024;
const DSH_IMAGE_MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};
/** Text deltas stream per token; coalesce before they hit the relay. */
const DELTA_FLUSH_MS = 80;
const REDISCOVERY_INTERVAL_MS = 15_000;

export interface DshServerFrame {
  rpcId: string;
  method: string;
  payload: Record<string, unknown>;
}

export interface DshClientResponse {
  type: "client-response";
  rpcId: string;
  result: { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } };
}

export interface DshApiClient {
  request<T = unknown>(method: string, payload?: Record<string, unknown>): Promise<T>;
  respond(message: DshClientResponse): Promise<{ accepted: boolean; reason?: string }>;
  on(event: "frame", listener: (frame: DshServerFrame) => void): this;
  on(event: "dropped", listener: () => void): this;
  close(): void;
}

interface WebSocketEvent {
  data?: unknown;
}

interface WebSocketLike {
  readonly readyState: number;
  addEventListener(type: string, listener: (event: WebSocketEvent) => void, options?: { once?: boolean }): void;
  close(): void;
}

interface WebSocketConstructor {
  new(url: string): WebSocketLike;
  OPEN: number;
}

interface DshPendingPermission {
  kind: "approval" | "question";
  nativeSessionId: string;
  /** The rpcId of the host-minted server-request frame; /api/respond routes on it. */
  frameRpcId: string;
  approvalId?: string;
  toolName?: string;
  questions?: unknown[];
}

interface DshTurnStream {
  turn: number;
  turnId: string;
  textBuffer: string;
  textItemId: string;
  lastAssistantText: string;
  usage: Required<BridgeTokenUsage>;
  usageSeen: boolean;
}

interface DshSessionState {
  session: RuntimeAdapterSession;
  /** Highest turn number observed in the event log. */
  lastTurn: number;
  /** Bridge commandIds awaiting their turn/start, in submission order. */
  pendingCommandIds: string[];
  turnIds: Map<number, string>;
  stream?: DshTurnStream;
  flushTimer?: NodeJS.Timeout;
  pendingPermissions: Map<string, DshPendingPermission>;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** DSH content blocks mix text, reasoning and tool calls; only text is shown. */
function textFromContent(content: unknown): string {
  return list(content)
    .map((part) => record(part))
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("");
}

function toolResultText(message: unknown): { text: string; isError: boolean } {
  const data = record(message);
  const parts = list(data.content)
    .map((part) => record(part))
    .filter((part) => part.type === "tool-result");
  const texts: string[] = [];
  let isError = false;
  for (const part of parts) {
    if (part.isError === true) isError = true;
    for (const inner of list(part.content)) {
      const block = record(inner);
      if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
    }
  }
  return { text: texts.join("\n"), isError };
}

/** File-mutating DSH tools surface their target path in the arguments. */
function fileChangesFromToolCall(name: string, args: Record<string, unknown>): BridgeFileChangeSummary[] | undefined {
  const path = text(args.path ?? args.file_path ?? args.target_file);
  if (!path) return undefined;
  if (name === "str_replace_editor") {
    const command = text(args.command);
    if (command === "create") return [{ path, kind: "add", additions: 0, deletions: 0 }];
    if (command === "str_replace" || command === "insert") return [{ path, kind: "update", additions: 0, deletions: 0 }];
    return undefined;
  }
  if (name === "write" || name === "write_file" || name === "create_file") {
    return [{ path, kind: "add", additions: 0, deletions: 0 }];
  }
  if (name === "edit" || name === "edit_file" || name === "apply_patch") {
    return [{ path, kind: "update", additions: 0, deletions: 0 }];
  }
  return undefined;
}

function loopbackBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("BRIDGE_DSH_GATEWAY_URL 不是合法 URL");
  }
  const loopback = url.hostname === "127.0.0.1"
    || url.hostname === "localhost"
    || url.hostname === "[::1]"
    || url.hostname === "::1";
  if (!loopback || (url.protocol !== "http:" && url.protocol !== "https:")) {
    throw new Error("BRIDGE_DSH_GATEWAY_URL 必须指向回环地址（DSH 的信任栅栏只认回环权威）");
  }
  return url.toString().replace(/\/+$/u, "");
}

/** Parse `TCP 127.0.0.1:60768 (LISTEN)` rows out of lsof output. Exported for tests. */
export function listeningLoopbackPorts(lsofOutput: string): number[] {
  const ports = new Set<number>();
  for (const line of lsofOutput.split("\n")) {
    const match = /TCP (?:127\.0\.0\.1|localhost|\[::1\]|\*):(\d+) \(LISTEN\)/u.exec(line);
    if (!match) continue;
    const port = Number.parseInt(match[1] ?? "", 10);
    if (Number.isFinite(port) && port > 0) ports.add(port);
  }
  return [...ports];
}

class HttpDshApiClient extends EventEmitter implements DshApiClient {
  private sockets: WebSocketLike[] = [];
  private closed = false;

  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch,
    private readonly WebSocketImpl: WebSocketConstructor | undefined,
  ) {
    super();
  }

  async request<T = unknown>(method: string, payload: Record<string, unknown> = {}): Promise<T> {
    const rpcId = randomUUID();
    const response = await this.fetchImpl(`${this.baseUrl}/api/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "client-request", rpcId, method, payload }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`DSH ${method} 传输失败：HTTP ${response.status}`);
    const body = record(await response.json());
    const result = record(body.result);
    if (result.ok !== true) {
      const error = record(result.error);
      throw new Error(text(error.message) || `DSH ${method} 被拒绝（${text(error.code) || "unknown"}）`);
    }
    return result.value as T;
  }

  async respond(message: DshClientResponse): Promise<{ accepted: boolean; reason?: string }> {
    const response = await this.fetchImpl(`${this.baseUrl}/api/respond`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`DSH 回应传输失败：HTTP ${response.status}`);
    const body = record(await response.json());
    return { accepted: body.accepted === true, ...(typeof body.reason === "string" ? { reason: body.reason } : {}) };
  }

  /** The readiness contract: host.describe plus both downlink streams open. */
  async connect(): Promise<void> {
    await this.request("host.describe");
    if (!this.WebSocketImpl) throw new Error("当前 Node 运行时不支持 WebSocket");
    await Promise.all([
      this.openStream("/api/events.mux"),
      this.openStream("/api/events.host"),
    ]);
  }

  close(): void {
    this.closed = true;
    for (const socket of this.sockets) socket.close();
    this.sockets = [];
  }

  private openStream(path: string): Promise<void> {
    const wsScheme = this.baseUrl.startsWith("https:") ? "wss" : "ws";
    const url = `${wsScheme}://${new URL(this.baseUrl).host}${path}`;
    const socket = new this.WebSocketImpl!(url);
    this.sockets.push(socket);
    socket.addEventListener("message", (event) => this.handleMessage(event.data));
    socket.addEventListener("close", () => {
      if (this.closed) return;
      this.closed = true;
      for (const other of this.sockets) other.close();
      this.emit("dropped");
    });
    return new Promise<void>((resolveOpen, rejectOpen) => {
      const timer = setTimeout(() => rejectOpen(new Error(`DSH 事件流 ${path} 连接超时`)), 15_000);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolveOpen();
      }, { once: true });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        rejectOpen(new Error(`DSH 事件流 ${path} 连接失败`));
      }, { once: true });
    });
  }

  private handleMessage(raw: unknown): void {
    let message: Record<string, unknown>;
    try {
      message = record(JSON.parse(typeof raw === "string" ? raw : String(raw)));
    } catch {
      return;
    }
    if (message.type !== "server-request") return;
    const payload = record(message.payload);
    this.emit("frame", {
      rpcId: text(message.rpcId),
      method: text(message.method) || text(payload.type),
      payload,
    } satisfies DshServerFrame);
  }
}

export interface DshDesktopAdapterOptions {
  clientFactory?: (baseUrl: string) => Promise<DshApiClient>;
  discoverGatewayUrl?: () => Promise<string | undefined>;
  fetchImpl?: typeof fetch;
  rediscoveryIntervalMs?: number;
}

export class DshDesktopAdapter extends DesktopRuntimeAdapter {
  private readonly states = new Map<string, DshSessionState>();
  private client: DshApiClient | undefined;
  private initialized = false;
  private lifecycleId = 0;
  private rediscoveryTimer: NodeJS.Timeout | undefined;

  constructor(private readonly options: DshDesktopAdapterOptions = {}) {
    super("dsh-desktop", "DSH Desktop", [
      "session.list",
      "session.create",
      "session.history",
      "session.configure",
      "turn.start",
      "turn.steer",
      "turn.interrupt",
      "permission.resolve",
      "tool.events",
      "attachment.image",
    ]);
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    const lifecycleId = ++this.lifecycleId;
    this.initialized = true;
    this.clearRediscovery();
    this.setStatus("starting", "正在发现 DSH Desktop 宿主。");
    try {
      const baseUrl = await this.discover();
      if (lifecycleId !== this.lifecycleId) return;
      if (!baseUrl) {
        this.setStatus(
          "unavailable",
          "未发现运行中的 DSH Desktop。请安装并启动 DSH Desktop，或配置 BRIDGE_DSH_GATEWAY_URL。",
        );
        this.scheduleRediscovery();
        return;
      }
      const client = await (this.options.clientFactory
        ? this.options.clientFactory(baseUrl)
        : this.createClient(baseUrl));
      if (lifecycleId !== this.lifecycleId) {
        client.close();
        return;
      }
      this.client = client;
      client.on("frame", (frame) => this.handleFrame(frame));
      client.on("dropped", () => void this.handleDropped());
      const description = record(await client.request("host.describe"));
      await this.refresh();
      if (lifecycleId !== this.lifecycleId) return;
      this.setStatus("ready", "DSH Desktop 已接入。", {
        ...(text(description.version) ? { appVersion: text(description.version) } : {}),
        sessionCount: this.states.size,
      });
    } catch {
      if (lifecycleId !== this.lifecycleId) return;
      this.client?.close();
      this.client = undefined;
      this.setStatus("error", "无法连接 DSH Desktop。请确认 DSH Desktop 已启动并完成模型配置。");
      this.scheduleRediscovery();
    }
  }

  async refresh(): Promise<void> {
    const result = record(await this.requireClient().request("session.list"));
    const rows = list(result.items);
    const next = new Set<string>();
    for (const value of rows) {
      const row = record(value);
      const nativeSessionId = text(row.sessionId);
      if (!nativeSessionId) continue;
      next.add(nativeSessionId);
      const projections = record(record(row.projections).values);
      const prior = this.states.get(nativeSessionId);
      const running = row.running === true || Boolean(prior?.stream);
      const priorTurnState = prior?.session.turnState;
      const session: RuntimeAdapterSession = {
        nativeSessionId,
        cwd: text(row.cwd) || prior?.session.cwd || process.cwd(),
        title: text(projections.title) || prior?.session.title || "未命名任务",
        source: prior?.session.source ?? "desktop",
        createdAt: prior?.session.createdAt ?? num(row.updatedAt) ?? Date.now(),
        lastActivityAt: num(row.updatedAt) ?? Date.now(),
        turnState: running ? "running" : priorTurnState === "running" ? "idle" : priorTurnState ?? "idle",
        transport: "dsh-gateway",
        ...(prior?.session.activeTurnId && running ? { activeTurnId: prior.session.activeTurnId } : {}),
        ...(prior?.session.provider ? { provider: prior.session.provider } : {}),
        ...(prior?.session.model ? { model: prior.session.model } : {}),
        ...(prior?.session.reasoningEffort ? { reasoningEffort: prior.session.reasoningEffort } : {}),
      };
      this.states.set(nativeSessionId, {
        lastTurn: prior?.lastTurn ?? 0,
        pendingCommandIds: prior?.pendingCommandIds ?? [],
        turnIds: prior?.turnIds ?? new Map(),
        ...(prior?.stream ? { stream: prior.stream } : {}),
        pendingPermissions: prior?.pendingPermissions ?? new Map(),
        session,
      });
    }
    for (const [id, state] of this.states) {
      if (!next.has(id) && state.session.source !== "bridge") this.states.delete(id);
    }
    this.setSessionCount(this.states.size);
  }

  sessions(): RuntimeAdapterSession[] {
    return [...this.states.values()].map((state) => ({ ...state.session }));
  }

  async createSession(input: { cwd: string; title?: string }): Promise<RuntimeAdapterSession> {
    const result = record(await this.requireClient().request("session.create", { cwd: input.cwd }));
    const nativeSessionId = text(result.sessionId);
    if (!nativeSessionId) throw new Error("DSH 返回了无效的会话");
    const session: RuntimeAdapterSession = {
      nativeSessionId,
      cwd: input.cwd,
      title: input.title || "未命名任务",
      source: "bridge",
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      turnState: "idle",
      transport: "dsh-gateway",
    };
    this.states.set(nativeSessionId, {
      lastTurn: 0,
      pendingCommandIds: [],
      turnIds: new Map(),
      pendingPermissions: new Map(),
      session,
    });
    this.setSessionCount(this.states.size);
    this.emitRuntimeEvent({ type: "session.updated", session: { ...session } });
    return session;
  }

  async history(nativeSessionId: string): Promise<RuntimeAdapterHistoryItem[]> {
    const result = record(await this.requireClient().request("session.history", {
      sessionId: nativeSessionId,
      maxMessages: 50,
    }));
    const rows = list(result.events);
    const items: RuntimeAdapterHistoryItem[] = [];
    const toolCalls = new Map<string, { name: string; arguments: string; at: number; seq: number }>();
    for (const value of rows) {
      const entry = record(value);
      const event = record(entry.event);
      const type = text(event.type);
      const data = record(event.data);
      const at = num(event.time) ?? Date.now();
      const seq = num(event.seq) ?? items.length;
      if (type === "user/message") {
        if (text(record(data.source).kind) !== "user") continue;
        const content = textFromContent(data.content);
        if (!content.trim()) continue;
        items.push({
          id: text(data.id) || `dsh-history-${seq}`,
          role: "user",
          text: content,
          createdAt: at,
        });
      } else if (type === "assistant/message") {
        const message = record(data.message);
        const content = textFromContent(message.content);
        if (!content.trim()) continue;
        items.push({
          id: text(message.id) || `dsh-history-${seq}`,
          role: "assistant",
          text: content,
          createdAt: at,
        });
      } else if (type === "tool/call") {
        const callId = text(data.callId);
        if (callId) {
          toolCalls.set(callId, {
            name: text(data.name),
            arguments: text(data.arguments),
            at,
            seq,
          });
        }
      } else if (type === "tool/result") {
        const message = record(data.message);
        const callId = text(record(message.source).callId);
        const call = callId ? toolCalls.get(callId) : undefined;
        if (!callId || !call) continue;
        toolCalls.delete(callId);
        const outcome = toolResultText(message);
        let args: Record<string, unknown> = {};
        try {
          args = record(JSON.parse(call.arguments));
        } catch {
          args = {};
        }
        const fileChanges = fileChangesFromToolCall(call.name, args);
        items.push({
          id: `dsh-history-${call.seq}`,
          role: "tool",
          toolName: call.name,
          text: outcome.text.slice(0, 400) || call.name,
          createdAt: call.at,
          state: outcome.isError ? "failed" : "completed",
          ...(fileChanges ? { fileChanges } : {}),
        });
      }
    }
    return items;
  }

  async configuration(nativeSessionId: string): Promise<RuntimeAdapterConfiguration> {
    const state = this.states.get(nativeSessionId);
    if (!state) throw new Error("DSH 会话不存在");
    const catalog = record(await this.requireClient().request("session.models", { sessionId: nativeSessionId }));
    const current = record(catalog.current);
    const availableProviders: BridgeRuntimeProviderInfo[] = [];
    const availableModels: BridgeModelInfo[] = [];
    const effortNames = new Set<string>();
    for (const value of list(catalog.groups)) {
      const group = record(value);
      const provider = text(group.id);
      if (!provider) continue;
      availableProviders.push({ value: provider, displayName: text(group.name) || provider });
      for (const modelValue of list(group.models)) {
        const model = record(modelValue);
        const id = text(model.id);
        if (!id) continue;
        const efforts = list(record(model.reasoning).efforts)
          .map((effort) => text(record(effort).id))
          .filter(Boolean);
        for (const effort of efforts) effortNames.add(effort);
        availableModels.push({
          value: id,
          displayName: text(model.name) || id,
          provider,
          supportsEffort: efforts.length > 0,
          ...(efforts.length ? { supportedEffortLevels: efforts } : {}),
        });
      }
    }
    const model = text(current.model) || state.session.model;
    const provider = text(current.provider) || state.session.provider;
    const reasoningEffort = text(current.reasoningEffort) || state.session.reasoningEffort;
    if (model) state.session.model = model;
    if (provider) state.session.provider = provider;
    if (reasoningEffort) state.session.reasoningEffort = reasoningEffort;
    this.states.set(nativeSessionId, state);
    return {
      ...(model ? { model } : {}),
      ...(provider ? { provider } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      availableModels,
      availableProviders,
      availableReasoningEfforts: [...effortNames],
      modelsComplete: availableModels.length > 0,
      supportsFastMode: false,
      appliesAfterTurn: false,
    };
  }

  async configureSession(
    nativeSessionId: string,
    change: RuntimeAdapterConfigurationChange,
  ): Promise<RuntimeAdapterConfiguration> {
    const state = this.states.get(nativeSessionId);
    if (!state) throw new Error("DSH 会话不存在");
    const model = change.model === null || change.model === undefined ? state.session.model : change.model;
    const provider = change.provider === null || change.provider === undefined ? state.session.provider : change.provider;
    const reasoningEffort = change.reasoningEffort === null || change.reasoningEffort === undefined
      ? state.session.reasoningEffort
      : change.reasoningEffort;
    if (!model || !provider) throw new Error("DSH 需要先同时选择 Provider 与模型");
    await this.requireClient().request("session.selectModel", {
      sessionId: nativeSessionId,
      provider,
      model,
      ...(reasoningEffort ? { reasoningEffort } : {}),
    });
    state.session.model = model;
    state.session.provider = provider;
    if (reasoningEffort) state.session.reasoningEffort = reasoningEffort;
    else delete state.session.reasoningEffort;
    state.session.lastActivityAt = Date.now();
    this.states.set(nativeSessionId, state);
    this.emitRuntimeEvent({ type: "session.updated", session: { ...state.session } });
    return this.configuration(nativeSessionId);
  }

  async startTurn(input: RuntimeAdapterTurnInput): Promise<RuntimeAdapterTurnResult> {
    const state = this.states.get(input.nativeSessionId);
    if (!state) throw new Error("DSH 会话不存在");
    // Snapshot before submitting: the resulting turn/start can race the RPC
    // response and would otherwise make a fresh prompt look "queued".
    const queued = Boolean(state.stream);
    const content = await this.promptContent(input);
    state.pendingCommandIds.push(input.commandId);
    try {
      await this.requireClient().request("session.prompt", {
        sessionId: input.nativeSessionId,
        mode: "queue",
        content,
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
    } catch (error) {
      state.pendingCommandIds = state.pendingCommandIds.filter((id) => id !== input.commandId);
      throw error;
    }
    const turnId = `dsh:${input.commandId}`;
    if (!queued) {
      state.session.turnState = "running";
      state.session.activeTurnId = turnId;
    } else {
      state.session.turnState = "queued";
    }
    state.session.lastActivityAt = Date.now();
    this.states.set(input.nativeSessionId, state);
    this.emitRuntimeEvent({ type: "session.updated", session: { ...state.session } });
    return { turnId, state: queued ? "queued" : "running" };
  }

  async steerTurn(input: RuntimeAdapterTurnInput): Promise<RuntimeAdapterTurnResult> {
    const state = this.states.get(input.nativeSessionId);
    if (!state?.stream) throw new Error("DSH 当前没有可立即调整的任务");
    const content = await this.promptContent(input);
    await this.requireClient().request("session.prompt", {
      sessionId: input.nativeSessionId,
      mode: "steer",
      content,
      clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    return { turnId: state.stream.turnId, state: "running" };
  }

  async interruptTurn(nativeSessionId: string): Promise<boolean> {
    const state = this.states.get(nativeSessionId);
    if (!state?.stream) return false;
    await this.requireClient().request("session.cancel", { sessionId: nativeSessionId });
    return true;
  }

  async resolvePermission(
    requestId: string,
    decision: BridgePermissionDecision,
    updatedInput?: Record<string, unknown>,
  ): Promise<boolean> {
    for (const state of this.states.values()) {
      const pending = state.pendingPermissions.get(requestId);
      if (!pending) continue;
      state.pendingPermissions.delete(requestId);
      if (pending.kind === "approval") {
        await this.requireClient().respond({
          type: "client-response",
          rpcId: pending.frameRpcId,
          result: {
            ok: true,
            value: {
              sessionId: pending.nativeSessionId,
              approvalId: pending.approvalId,
              outcome: decision === "deny" ? "rejected" : "allowed-once",
            },
          },
        });
      } else if (decision === "deny") {
        await this.requireClient().respond({
          type: "client-response",
          rpcId: pending.frameRpcId,
          result: { ok: false, error: { code: "cancelled", message: "用户在 Bridge 中取消了提问" } },
        });
      } else {
        const answers = record(updatedInput?.answers);
        await this.requireClient().respond({
          type: "client-response",
          rpcId: pending.frameRpcId,
          result: {
            ok: true,
            value: {
              sessionId: pending.nativeSessionId,
              answer: {
                answers: (pending.questions ?? []).map((question) => {
                  const id = text(record(question).id);
                  const answer = typeof answers[id] === "string" ? answers[id] : "";
                  return { id, selected: [], ...(answer ? { custom: answer } : {}) };
                }),
              },
            },
          },
        });
      }
      this.emitRuntimeEvent({
        type: "permission.resolved",
        nativeSessionId: pending.nativeSessionId,
        requestId,
        decision,
        at: Date.now(),
      });
      return true;
    }
    return false;
  }

  async close(): Promise<void> {
    this.lifecycleId += 1;
    this.clearRediscovery();
    for (const state of this.states.values()) {
      if (state.flushTimer) clearTimeout(state.flushTimer);
    }
    const client = this.client;
    this.client = undefined;
    this.initialized = false;
    client?.close();
  }

  // ---- event pump ----

  private handleFrame(frame: DshServerFrame): void {
    const payload = frame.payload;
    const type = text(payload.type);
    if (type === "session/event") {
      this.handleSessionEvent(text(payload.sessionId), record(payload.event));
      return;
    }
    if (type === "session/projection") {
      this.handleProjection(text(payload.sessionId), text(payload.key), payload.value);
      return;
    }
    if (type === "approval/requested") {
      this.handleApprovalRequested(frame);
      return;
    }
    if (type === "approval/resolved") {
      const approvalId = text(payload.approvalId);
      const state = this.states.get(text(payload.sessionId));
      if (state && approvalId && state.pendingPermissions.delete(approvalId)) {
        this.emitRuntimeEvent({
          type: "permission.resolved",
          nativeSessionId: state.session.nativeSessionId,
          requestId: approvalId,
          decision: text(payload.outcome) === "rejected" ? "deny" : "allow-once",
          at: Date.now(),
        });
      }
      return;
    }
    if (type === "question/requested") {
      this.handleQuestionRequested(frame);
      return;
    }
    if (type === "question/resolved") {
      const state = this.states.get(text(payload.sessionId));
      if (state?.pendingPermissions.delete(frame.rpcId)) {
        this.emitRuntimeEvent({
          type: "permission.resolved",
          nativeSessionId: state.session.nativeSessionId,
          requestId: frame.rpcId,
          decision: "allow-once",
          at: Date.now(),
        });
      }
      return;
    }
    if (type === "host/session-added" || type === "host/session-removed" || type === "host/workspace-changed") {
      void this.refresh().catch(() => undefined);
      return;
    }
    if (type === "host/session-status") {
      const state = this.states.get(text(payload.sessionId));
      if (state && payload.running === false && !state.stream && state.session.turnState === "running") {
        state.session.turnState = "idle";
        delete state.session.activeTurnId;
        this.emitRuntimeEvent({ type: "session.updated", session: { ...state.session } });
      }
      return;
    }
    if (type === "host/agent-error") {
      const state = this.states.get(text(payload.sessionId));
      if (state?.stream) {
        this.finishTurn(state, "failed", text(payload.message) || "DSH Agent 运行失败");
      }
    }
  }

  private handleSessionEvent(nativeSessionId: string, event: Record<string, unknown>): void {
    const type = text(event.type);
    const data = record(event.data);
    const at = num(event.time) ?? Date.now();
    let state = this.states.get(nativeSessionId);
    if (!state) {
      // Events can arrive before the next session.list refresh (e.g. sessions
      // created in the DSH UI while Bridge is connected). Materialize a row.
      state = {
        lastTurn: 0,
        pendingCommandIds: [],
        turnIds: new Map(),
        pendingPermissions: new Map(),
        session: {
          nativeSessionId,
          cwd: process.cwd(),
          title: "未命名任务",
          source: "desktop",
          createdAt: at,
          lastActivityAt: at,
          turnState: "idle",
          transport: "dsh-gateway",
        },
      };
      this.states.set(nativeSessionId, state);
      void this.refresh().catch(() => undefined);
    }
    state.session.lastActivityAt = at;

    if (type === "turn/start") {
      const turn = num(data.turn) ?? state.lastTurn + 1;
      state.lastTurn = Math.max(state.lastTurn, turn);
      const commandId = state.pendingCommandIds.shift();
      const turnId = commandId ? `dsh:${commandId}` : `dsh-turn-${turn}`;
      state.turnIds.set(turn, turnId);
      state.stream = {
        turn,
        turnId,
        textBuffer: "",
        textItemId: "",
        lastAssistantText: "",
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
        usageSeen: false,
      };
      state.session.turnState = "running";
      state.session.activeTurnId = turnId;
      this.emitRuntimeEvent({ type: "turn.started", nativeSessionId, turnId, at });
      this.emitRuntimeEvent({ type: "session.updated", session: { ...state.session } });
      return;
    }
    if (type === "assistant/chunk") {
      this.handleChunk(state, data);
      return;
    }
    if (type === "assistant/message") {
      this.flushDelta(state, at);
      const message = record(data.message);
      const content = textFromContent(message.content);
      const stream = state.stream;
      if (stream && content.trim()) {
        stream.lastAssistantText = content;
        const messageId = text(message.id) || stream.textItemId;
        this.emitRuntimeEvent({
          type: "assistant.completed",
          nativeSessionId,
          turnId: stream.turnId,
          ...(messageId ? { itemId: messageId } : {}),
          text: content,
          at,
        });
      }
      return;
    }
    if (type === "tool/call") {
      this.flushDelta(state, at);
      const stream = state.stream;
      const callId = text(data.callId);
      if (!stream || !callId) return;
      const name = text(data.name);
      let input: unknown = text(data.arguments);
      try {
        input = JSON.parse(text(data.arguments));
      } catch {
        // keep the raw string when arguments are not JSON
      }
      const fileChanges = input && typeof input === "object" && !Array.isArray(input)
        ? fileChangesFromToolCall(name, input as Record<string, unknown>)
        : undefined;
      this.emitRuntimeEvent({
        type: "tool.started",
        nativeSessionId,
        turnId: stream.turnId,
        itemId: callId,
        toolName: name,
        input,
        ...(fileChanges ? { fileChanges } : {}),
        at,
      });
      return;
    }
    if (type === "tool/result") {
      const stream = state.stream;
      const message = record(data.message);
      const callId = text(record(message.source).callId);
      if (!stream || !callId) return;
      const outcome = toolResultText(message);
      this.emitRuntimeEvent({
        type: "tool.completed",
        nativeSessionId,
        turnId: stream.turnId,
        itemId: callId,
        toolName: "",
        output: outcome.text.slice(0, 64 * 1024),
        at,
      });
      return;
    }
    if (type === "turn/end") {
      const reason = text(record(data.reason).kind);
      if (reason === "completed") this.finishTurn(state, "completed");
      else if (reason === "aborted") this.finishTurn(state, "interrupted");
      else this.finishTurn(state, "failed", `DSH 轮次结束：${reason || "unknown"}`);
      return;
    }
    if (type === "user/message" && text(record(data.source).kind) === "user") {
      const content = textFromContent(data.content);
      if (!content.trim()) return;
      this.emitRuntimeEvent({
        type: "user.accepted",
        nativeSessionId,
        ...(state.stream ? { turnId: state.stream.turnId } : {}),
        ...(text(data.id) ? { itemId: text(data.id) } : {}),
        text: content,
        at,
      });
      return;
    }
    if (type === "request/header") {
      const header = record(data.header);
      const config = record(header.config);
      const provider = text(config.provider);
      const model = text(config.model);
      const reasoningEffort = text(config.reasoningEffort);
      if (provider) state.session.provider = provider;
      if (model) state.session.model = model;
      if (reasoningEffort) state.session.reasoningEffort = reasoningEffort;
    }
  }

  private handleChunk(state: DshSessionState, data: Record<string, unknown>): void {
    const stream = state.stream;
    if (!stream) return;
    const chunk = record(data.chunk);
    if (chunk.type === "block-start") {
      stream.textItemId = `dsh-text-${stream.turn}-${num(data.step) ?? 0}-${num(chunk.index) ?? 0}`;
      stream.textBuffer = "";
      return;
    }
    if (chunk.type === "usage") {
      const usage = record(chunk.usage);
      stream.usage.inputTokens += num(usage.inputTokens) ?? 0;
      stream.usage.outputTokens += num(usage.outputTokens) ?? 0;
      stream.usage.cacheReadTokens += num(usage.cacheReadTokens) ?? 0;
      stream.usage.cacheWriteTokens += num(usage.cacheWriteTokens) ?? 0;
      stream.usage.reasoningTokens += num(usage.reasoningTokens) ?? 0;
      stream.usageSeen = true;
      return;
    }
    if (chunk.type !== "text-delta" || typeof chunk.text !== "string") return;
    if (!stream.textItemId) {
      stream.textItemId = `dsh-text-${stream.turn}-${num(data.step) ?? 0}-0`;
    }
    stream.textBuffer += chunk.text;
    if (!state.flushTimer) {
      state.flushTimer = setTimeout(() => {
        delete state.flushTimer;
        this.flushDelta(state, Date.now());
      }, DELTA_FLUSH_MS);
      state.flushTimer.unref?.();
    }
  }

  private flushDelta(state: DshSessionState, at: number): void {
    const stream = state.stream;
    if (state.flushTimer) {
      clearTimeout(state.flushTimer);
      delete state.flushTimer;
    }
    if (!stream || !stream.textBuffer) return;
    const textDelta = stream.textBuffer;
    stream.textBuffer = "";
    const itemId = stream.textItemId;
    this.emitRuntimeEvent({
      type: "assistant.delta",
      nativeSessionId: state.session.nativeSessionId,
      turnId: stream.turnId,
      ...(itemId ? { itemId } : {}),
      text: textDelta,
      at,
    });
  }

  private finishTurn(state: DshSessionState, outcome: "completed" | "failed" | "interrupted", error?: string): void {
    const stream = state.stream;
    if (!stream) return;
    this.flushDelta(state, Date.now());
    delete state.stream;
    const nativeSessionId = state.session.nativeSessionId;
    const at = Date.now();
    if (outcome === "completed") {
      this.emitRuntimeEvent({
        type: "turn.completed",
        nativeSessionId,
        turnId: stream.turnId,
        at,
        ...(stream.lastAssistantText ? { result: stream.lastAssistantText } : {}),
        ...(stream.usageSeen ? { usage: { ...stream.usage } } : {}),
      });
      state.session.turnState = "completed";
    } else if (outcome === "interrupted") {
      this.emitRuntimeEvent({ type: "turn.interrupted", nativeSessionId, turnId: stream.turnId, at });
      state.session.turnState = "interrupted";
    } else {
      this.emitRuntimeEvent({
        type: "turn.failed",
        nativeSessionId,
        turnId: stream.turnId,
        at,
        error: error || "DSH 轮次失败",
      });
      state.session.turnState = "failed";
    }
    delete state.session.activeTurnId;
    this.emitRuntimeEvent({ type: "session.updated", session: { ...state.session } });
  }

  private handleProjection(nativeSessionId: string, key: string, value: unknown): void {
    const state = this.states.get(nativeSessionId);
    if (!state || key !== "title") return;
    const title = text(value);
    if (!title || state.session.title === title) return;
    state.session.title = title;
    this.emitRuntimeEvent({ type: "session.updated", session: { ...state.session } });
  }

  private handleApprovalRequested(frame: DshServerFrame): void {
    const payload = frame.payload;
    const nativeSessionId = text(payload.sessionId);
    const state = this.states.get(nativeSessionId);
    const approvalId = text(payload.approvalId);
    if (!state || !approvalId) return;
    const toolName = text(payload.toolName) || "工具调用";
    state.pendingPermissions.set(approvalId, {
      kind: "approval",
      nativeSessionId,
      frameRpcId: frame.rpcId,
      approvalId,
      toolName,
    });
    const permission: RuntimeAdapterPermission = {
      requestId: approvalId,
      nativeSessionId,
      toolUseId: text(payload.callId) || approvalId,
      toolName,
      ...(text(payload.reason) ? { description: text(payload.reason) } : {}),
      input: text(payload.reason) ? { reason: text(payload.reason) } : {},
      createdAt: Date.now(),
      canAllowAlways: false,
    };
    this.emitRuntimeEvent({ type: "permission.requested", permission });
  }

  private handleQuestionRequested(frame: DshServerFrame): void {
    const payload = frame.payload;
    const nativeSessionId = text(payload.sessionId);
    const state = this.states.get(nativeSessionId);
    if (!state) return;
    const questions = list(payload.questions);
    const first = record(questions[0]);
    state.pendingPermissions.set(frame.rpcId, {
      kind: "question",
      nativeSessionId,
      frameRpcId: frame.rpcId,
      questions,
    });
    const permission: RuntimeAdapterPermission = {
      requestId: frame.rpcId,
      nativeSessionId,
      toolUseId: frame.rpcId,
      toolName: "AskUserQuestion",
      ...(text(first.question) ? { title: text(first.question) } : {}),
      input: { questions },
      createdAt: Date.now(),
      canAllowAlways: false,
      question: true,
    };
    this.emitRuntimeEvent({ type: "permission.requested", permission });
  }

  // ---- discovery ----

  private async discover(): Promise<string | undefined> {
    if (this.options.discoverGatewayUrl) return this.options.discoverGatewayUrl();
    const override = process.env.BRIDGE_DSH_GATEWAY_URL;
    if (override) return loopbackBaseUrl(override);
    return discoverRunningDshGateway(this.options.fetchImpl ?? fetch);
  }

  private scheduleRediscovery(): void {
    this.clearRediscovery();
    const interval = this.options.rediscoveryIntervalMs ?? REDISCOVERY_INTERVAL_MS;
    this.rediscoveryTimer = setTimeout(() => {
      this.rediscoveryTimer = undefined;
      this.initialized = false;
      void this.initialize();
    }, interval);
    this.rediscoveryTimer.unref?.();
  }

  private clearRediscovery(): void {
    if (this.rediscoveryTimer) clearTimeout(this.rediscoveryTimer);
    this.rediscoveryTimer = undefined;
  }

  private async handleDropped(): Promise<void> {
    const lifecycleId = this.lifecycleId;
    this.client?.close();
    this.client = undefined;
    for (const state of this.states.values()) {
      if (state.stream) {
        this.finishTurn(state, "interrupted");
      }
      if (state.session.turnState === "running" || state.session.turnState === "queued") {
        state.session.turnState = "idle";
        delete state.session.activeTurnId;
        this.emitRuntimeEvent({ type: "session.updated", session: { ...state.session } });
      }
    }
    if (lifecycleId !== this.lifecycleId) return;
    this.setStatus("starting", "DSH Desktop 连接中断，正在重连…");
    this.initialized = false;
    this.scheduleRediscovery();
  }

  private async createClient(baseUrl: string): Promise<DshApiClient> {
    const client = new HttpDshApiClient(
      baseUrl,
      this.options.fetchImpl ?? fetch,
      (globalThis as unknown as { WebSocket?: WebSocketConstructor }).WebSocket,
    );
    await client.connect();
    return client;
  }

  private requireClient(): DshApiClient {
    if (!this.client) throw new Error("DSH Desktop 尚未连接");
    return this.client;
  }

  private async promptContent(input: RuntimeAdapterTurnInput): Promise<Array<Record<string, unknown>>> {
    const content: Array<Record<string, unknown>> = [];
    let total = 0;
    for (const path of input.images ?? []) {
      const mediaType = DSH_IMAGE_MEDIA_TYPES[extname(path).toLowerCase()];
      if (!mediaType) continue;
      const bytes = await readFile(path);
      if (bytes.byteLength > DSH_IMAGE_MAX_BYTES) {
        throw new Error(`图片 ${basename(path)} 超过 DSH 单张 ${Math.round(DSH_IMAGE_MAX_BYTES / 1024 / 1024)}MB 上限`);
      }
      total += bytes.byteLength;
      if (total > DSH_IMAGE_TOTAL_BYTES) throw new Error("图片总量超过 DSH 单条消息上限");
      content.push({ type: "image", mediaType, data: bytes.toString("base64"), name: basename(path) });
    }
    content.unshift({ type: "text", text: input.text });
    return content;
  }
}

// ---- host discovery ----

async function run(command: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(command, args, { timeout: 5_000 });
    return stdout;
  } catch {
    return "";
  }
}

/** DSH 的 web server 监听回环随机端口：按进程名找 PID，枚举监听端口后逐一探测 host.describe。 */
export async function discoverRunningDshGateway(fetchImpl: typeof fetch = fetch): Promise<string | undefined> {
  if (process.platform === "win32") return undefined;
  const pidsOut = await run("pgrep", ["-f", "DSH Desktop.app/Contents/MacOS/DSH Desktop|dsh-desktop|dsh web"]);
  const pids = pidsOut.split("\n").map((line) => line.trim()).filter(Boolean);
  if (!pids.length) return undefined;
  const lsofOut = await run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", pids.join(",")]);
  for (const port of listeningLoopbackPorts(lsofOut)) {
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      const response = await fetchImpl(`${baseUrl}/api/host.describe`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "client-request", rpcId: randomUUID(), method: "host.describe", payload: {} }),
        signal: AbortSignal.timeout(1_500),
      });
      if (!response.ok) continue;
      const body = record(await response.json());
      const value = record(record(body.result).value);
      if (typeof value.attachedSessions === "number" && typeof value.cwd === "string") return baseUrl;
    } catch {
      continue;
    }
  }
  return undefined;
}
