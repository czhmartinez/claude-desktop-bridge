import { randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { access } from "node:fs/promises";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import type { BridgePermissionDecision } from "@bridge/protocol";
import {
  DesktopRuntimeAdapter,
  type RuntimeAdapterHistoryItem,
  type RuntimeAdapterPermission,
  type RuntimeAdapterSession,
  type RuntimeAdapterTurnInput,
  type RuntimeAdapterTurnResult,
} from "./runtime-adapter.js";

type JsonRpcId = string | number;

interface WebSocketEvent {
  data?: unknown;
}

interface WebSocketLike {
  readonly readyState: number;
  addEventListener(type: string, listener: (event: WebSocketEvent) => void, options?: { once?: boolean }): void;
  close(): void;
  send(data: string): void;
}

interface WebSocketConstructor {
  new(url: string): WebSocketLike;
  OPEN: number;
}

interface HermesRpcFrame {
  id?: JsonRpcId | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: unknown };
}

interface HermesGatewayEvent {
  type?: string;
  session_id?: string;
  payload?: unknown;
}

interface HermesRpcClient {
  request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  on(event: "event", listener: (event: HermesGatewayEvent) => void): this;
  close(): void;
}

class WebSocketHermesRpcClient extends EventEmitter implements HermesRpcClient {
  private socket: WebSocketLike | undefined;
  private readonly pending = new Map<JsonRpcId, {
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer: NodeJS.Timeout;
  }>();
  private nextId = 0;

  constructor(private readonly WebSocketImpl: WebSocketConstructor) {
    super();
  }

  async connect(url: string): Promise<void> {
    if (this.socket?.readyState === this.WebSocketImpl.OPEN) return;
    const socket = new this.WebSocketImpl(url);
    this.socket = socket;
    socket.addEventListener("message", (event) => this.handleMessage(event.data));
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.rejectAll(new Error("Hermes gateway disconnected"));
    });
    await new Promise<void>((resolveConnect, rejectConnect) => {
      const timer = setTimeout(() => {
        socket.close();
        rejectConnect(new Error("Hermes gateway startup timed out"));
      }, 20_000);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolveConnect();
      }, { once: true });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        rejectConnect(new Error("Hermes gateway connection failed"));
      }, { once: true });
    });
  }

  request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const socket = this.socket;
    if (!socket || socket.readyState !== this.WebSocketImpl.OPEN) {
      return Promise.reject(new Error("Hermes gateway is not connected"));
    }
    const id = `bridge-${++this.nextId}`;
    return new Promise<T>((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) rejectRequest(new Error(`Hermes request timed out: ${method}`));
      }, 120_000);
      this.pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer });
      try {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        rejectRequest(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  close(): void {
    this.socket?.close();
    this.socket = undefined;
    this.rejectAll(new Error("Hermes gateway closed"));
  }

  private handleMessage(raw: unknown): void {
    let message: HermesRpcFrame;
    try {
      message = JSON.parse(typeof raw === "string" ? raw : String(raw)) as HermesRpcFrame;
    } catch {
      return;
    }
    if (message.id !== undefined && message.id !== null) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(typeof message.error.message === "string" ? message.error.message : "Hermes RPC failed"));
      else pending.resolve(message.result);
      return;
    }
    if (message.method === "event" && message.params && typeof message.params === "object") {
      this.emit("event", message.params as HermesGatewayEvent);
    }
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

interface HermesSidecar {
  client: HermesRpcClient;
  close(): Promise<void>;
}

interface PendingHermesPermission {
  nativeSessionId: string;
  kind: "approval" | "clarify";
  nativeRequestId: string;
}

async function executableAt(path: string): Promise<string | undefined> {
  try {
    await access(path);
    return path;
  } catch {
    return undefined;
  }
}

async function findHermesExecutable(): Promise<string | undefined> {
  const configured = process.env.BRIDGE_HERMES_EXECUTABLE;
  if (configured) return executableAt(resolve(configured));
  const home = process.env.HOME;
  if (home) {
    const local = await executableAt(`${home}/.local/bin/hermes`);
    if (local) return local;
  }
  return undefined;
}

function webSocketConstructor(): WebSocketConstructor | undefined {
  return (globalThis as unknown as { WebSocket?: WebSocketConstructor }).WebSocket;
}

function loopbackGatewayUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Configured Hermes Gateway URL is invalid");
  }
  const loopback = url.hostname === "127.0.0.1"
    || url.hostname === "localhost"
    || url.hostname === "[::1]"
    || url.hostname === "::1";
  if (!loopback || (url.protocol !== "ws:" && url.protocol !== "wss:")) {
    throw new Error("Configured Hermes Gateway must use a loopback WebSocket URL");
  }
  return url.toString();
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function timestamp(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return Date.now();
  return value < 10_000_000_000 ? value * 1_000 : value;
}

function sessionFromGateway(value: unknown): RuntimeAdapterSession | undefined {
  const item = record(value);
  const nativeSessionId = text(item.id);
  if (!nativeSessionId) return undefined;
  const title = text(item.title) || text(item.preview) || "未命名任务";
  const lastActivityAt = timestamp(item.updated_at ?? item.started_at);
  return {
    nativeSessionId,
    cwd: text(item.cwd) || process.cwd(),
    title,
    source: text(item.source) === "bridge" ? "bridge" : "desktop",
    createdAt: timestamp(item.started_at),
    lastActivityAt,
    turnState: "idle",
    transport: "hermes-gateway",
  };
}

function historyItem(value: unknown, index: number): RuntimeAdapterHistoryItem | undefined {
  const item = record(value);
  const role = text(item.role);
  const content = text(item.content) || text(item.text) || text(item.message);
  if (role !== "user" && role !== "assistant" && role !== "tool" && role !== "system") return undefined;
  return {
    id: text(item.id) || `hermes-history-${index}`,
    role,
    text: content,
    createdAt: timestamp(item.created_at ?? item.timestamp),
    ...(text(item.tool_name) ? { toolName: text(item.tool_name) } : {}),
  };
}

export interface HermesGatewayAdapterOptions {
  clientFactory?: (url: string) => Promise<HermesRpcClient>;
  findExecutable?: () => Promise<string | undefined>;
}

export class HermesGatewayAdapter extends DesktopRuntimeAdapter {
  private readonly sessionMap = new Map<string, RuntimeAdapterSession>();
  private readonly activeTurns = new Map<string, string>();
  private readonly pendingPermissions = new Map<string, PendingHermesPermission>();
  private client: HermesRpcClient | undefined;
  private sidecar: HermesSidecar | undefined;
  private startingChild: ChildProcessWithoutNullStreams | undefined;
  private initialized = false;
  private lifecycleId = 0;

  constructor(private readonly options: HermesGatewayAdapterOptions = {}) {
    super("hermes-desktop", "Hermes Desktop", [
      "session.list",
      "session.create",
      "session.history",
      "turn.start",
      "turn.steer",
      "turn.interrupt",
      "permission.resolve",
      "tool.events",
    ]);
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    const lifecycleId = ++this.lifecycleId;
    this.initialized = true;
    this.setStatus("starting", "正在连接 Hermes Gateway。");
    try {
      const endpoint = await this.connectClient();
      if (lifecycleId !== this.lifecycleId) {
        if (endpoint.sidecar) await endpoint.sidecar.close().catch(() => undefined);
        else endpoint.client.close();
        return;
      }
      this.client = endpoint.client;
      this.sidecar = endpoint.sidecar;
      this.client.on("event", (event) => this.handleGatewayEvent(event));
      await this.refresh();
      if (lifecycleId !== this.lifecycleId) return;
      this.setStatus("ready", "Hermes Gateway 已接入。", { sessionCount: this.sessionMap.size });
    } catch {
      if (lifecycleId !== this.lifecycleId) return;
      await this.sidecar?.close().catch(() => undefined);
      this.sidecar = undefined;
      this.client = undefined;
      this.setStatus("error", "无法连接 Hermes Gateway。请确认 Hermes Desktop 已安装并完成模型配置。");
    }
  }

  async refresh(): Promise<void> {
    const result = await this.requireClient().request<Record<string, unknown>>("session.list", { limit: 100 });
    const rows = Array.isArray(result.sessions) ? result.sessions : [];
    const next = new Map<string, RuntimeAdapterSession>();
    for (const value of rows) {
      const session = sessionFromGateway(value);
      if (!session) continue;
      const turnId = this.activeTurns.get(session.nativeSessionId);
      if (turnId) {
        session.turnState = "running";
        session.activeTurnId = turnId;
      }
      next.set(session.nativeSessionId, session);
    }
    this.sessionMap.clear();
    for (const [id, session] of next) this.sessionMap.set(id, session);
    this.setSessionCount(this.sessionMap.size);
  }

  sessions(): RuntimeAdapterSession[] {
    return [...this.sessionMap.values()].map((session) => ({ ...session }));
  }

  async createSession(input: { cwd: string; title?: string }): Promise<RuntimeAdapterSession> {
    const result = await this.requireClient().request<Record<string, unknown>>("session.create", {
      cwd: input.cwd,
      ...(input.title ? { title: input.title } : {}),
      source: "bridge",
    });
    const nativeSessionId = text(result.session_id);
    if (!nativeSessionId) throw new Error("Hermes Gateway returned an invalid session");
    const info = record(result.info);
    const session: RuntimeAdapterSession = {
      nativeSessionId,
      cwd: text(info.cwd) || input.cwd,
      title: input.title || "未命名任务",
      source: "bridge",
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      turnState: "idle",
      transport: "hermes-gateway",
      ...(text(info.model) ? { model: text(info.model) } : {}),
    };
    this.sessionMap.set(nativeSessionId, session);
    this.setSessionCount(this.sessionMap.size);
    this.emitRuntimeEvent({ type: "session.updated", session: { ...session } });
    return session;
  }

  async history(nativeSessionId: string): Promise<RuntimeAdapterHistoryItem[]> {
    await this.resume(nativeSessionId);
    const result = await this.requireClient().request<Record<string, unknown>>("session.history", { session_id: nativeSessionId });
    const rows = Array.isArray(result.messages) ? result.messages : [];
    return rows.flatMap((item, index) => {
      const parsed = historyItem(item, index);
      return parsed ? [parsed] : [];
    });
  }

  async startTurn(input: RuntimeAdapterTurnInput): Promise<RuntimeAdapterTurnResult> {
    await this.resume(input.nativeSessionId);
    const turnId = `hermes:${input.commandId}`;
    const result = await this.requireClient().request<Record<string, unknown>>("prompt.submit", {
      session_id: input.nativeSessionId,
      text: input.text,
    });
    if (text(result.status) && text(result.status) !== "streaming") throw new Error(text(result.status));
    this.activeTurns.set(input.nativeSessionId, turnId);
    const session = this.sessionMap.get(input.nativeSessionId);
    if (session) {
      session.turnState = "running";
      session.activeTurnId = turnId;
      session.lastActivityAt = Date.now();
      this.emitRuntimeEvent({ type: "session.updated", session: { ...session } });
    }
    return { turnId, state: "running" };
  }

  async steerTurn(input: RuntimeAdapterTurnInput): Promise<RuntimeAdapterTurnResult> {
    const turnId = this.activeTurns.get(input.nativeSessionId);
    if (!turnId) throw new Error("Hermes 当前没有可立即调整的任务");
    const result = await this.requireClient().request<Record<string, unknown>>("session.steer", {
      session_id: input.nativeSessionId,
      text: input.text,
    });
    if (text(result.status) === "rejected") throw new Error("Hermes 未接受当前调整");
    return { turnId, state: "running" };
  }

  async interruptTurn(nativeSessionId: string): Promise<boolean> {
    const active = this.activeTurns.has(nativeSessionId);
    if (!active) return false;
    await this.requireClient().request("session.interrupt", { session_id: nativeSessionId });
    this.activeTurns.delete(nativeSessionId);
    return true;
  }

  async resolvePermission(
    requestId: string,
    decision: BridgePermissionDecision,
    updatedInput?: Record<string, unknown>,
  ): Promise<boolean> {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return false;
    this.pendingPermissions.delete(requestId);
    if (pending.kind === "clarify") {
      const answers = record(updatedInput?.answers);
      const answer = Object.values(answers).find((value): value is string => typeof value === "string") ?? "";
      await this.requireClient().request("clarify.respond", {
        session_id: pending.nativeSessionId,
        request_id: pending.nativeRequestId,
        answer: decision === "deny" ? "" : answer,
      });
    } else {
      const choice = decision === "allow-always" ? "always" : decision === "allow-once" ? "once" : "deny";
      await this.requireClient().request("approval.respond", {
        session_id: pending.nativeSessionId,
        choice,
      });
    }
    this.emitRuntimeEvent({ type: "permission.resolved", nativeSessionId: pending.nativeSessionId, requestId, decision, at: Date.now() });
    return true;
  }

  async close(): Promise<void> {
    this.lifecycleId += 1;
    const startingChild = this.startingChild;
    this.startingChild = undefined;
    if (startingChild && startingChild.exitCode === null && !startingChild.killed) startingChild.kill("SIGTERM");
    const client = this.client;
    this.client = undefined;
    const sidecar = this.sidecar;
    this.sidecar = undefined;
    this.initialized = false;
    client?.close();
    await sidecar?.close();
  }

  private async connectClient(): Promise<{ client: HermesRpcClient; sidecar?: HermesSidecar }> {
    const configured = process.env.BRIDGE_HERMES_GATEWAY_URL;
    if (configured) {
      const client = await this.createClient(loopbackGatewayUrl(configured));
      return { client };
    }
    const executable = await (this.options.findExecutable ?? findHermesExecutable)();
    if (!executable) throw new Error("Hermes executable not found");
    const sidecar = await this.startSidecar(executable);
    return { client: sidecar.client, sidecar };
  }

  private async createClient(url: string): Promise<HermesRpcClient> {
    if (this.options.clientFactory) return this.options.clientFactory(url);
    const WebSocketImpl = webSocketConstructor();
    if (!WebSocketImpl) throw new Error("WebSocket is unavailable in this Bridge runtime");
    const client = new WebSocketHermesRpcClient(WebSocketImpl);
    await client.connect(url);
    return client;
  }

  private async startSidecar(executable: string): Promise<HermesSidecar> {
    const token = randomBytes(32).toString("base64url");
    const child = spawn(executable, ["serve", "--port", "0", "--host", "127.0.0.1", "--skip-build"], {
      env: { ...process.env, HERMES_DASHBOARD_SESSION_TOKEN: token },
      stdio: "pipe",
      windowsHide: true,
    });
    this.startingChild = child;
    const clearStartingChild = () => {
      if (this.startingChild === child) this.startingChild = undefined;
    };
    try {
      const port = await new Promise<number>((resolvePort, rejectPort) => {
        let settled = false;
        const finish = (action: () => void) => {
          if (settled) return;
          settled = true;
          action();
        };
        const timeout = setTimeout(() => finish(() => rejectPort(new Error("Hermes Gateway startup timed out"))), 60_000);
        const read = (line: string) => {
          const match = /HERMES_BACKEND_READY\s+port=(\d+)/u.exec(line);
          if (!match) return;
          clearTimeout(timeout);
          finish(() => resolvePort(Number(match[1])));
        };
        createInterface({ input: child.stdout }).on("line", read);
        createInterface({ input: child.stderr }).on("line", read);
        child.once("error", () => {
          clearTimeout(timeout);
          finish(() => rejectPort(new Error("Hermes Gateway failed to start")));
        });
        child.once("exit", () => {
          clearTimeout(timeout);
          finish(() => rejectPort(new Error("Hermes Gateway exited during startup")));
        });
      });
      const client = await this.createClient(`ws://127.0.0.1:${port}/api/ws?token=${encodeURIComponent(token)}`);
      clearStartingChild();
      return {
        client,
        async close(): Promise<void> {
          client.close();
          if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
        },
      };
    } catch (error) {
      clearStartingChild();
      if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
      throw error;
    }
  }

  private requireClient(): HermesRpcClient {
    if (!this.client) throw new Error("Hermes Gateway is unavailable");
    return this.client;
  }

  private async resume(nativeSessionId: string): Promise<void> {
    await this.requireClient().request("session.resume", { session_id: nativeSessionId });
  }

  private handleGatewayEvent(event: HermesGatewayEvent): void {
    const nativeSessionId = text(event.session_id);
    if (!nativeSessionId) return;
    const payload = record(event.payload);
    const turnId = this.activeTurns.get(nativeSessionId);
    const now = Date.now();
    if (event.type === "message.start") {
      this.emitRuntimeEvent({ type: "turn.started", nativeSessionId, ...(turnId ? { turnId } : {}), at: now });
    } else if (event.type === "message.delta") {
      const value = text(payload.text);
      if (value) this.emitRuntimeEvent({ type: "assistant.delta", nativeSessionId, ...(turnId ? { turnId } : {}), text: value, at: now });
    } else if (event.type === "message.complete") {
      const value = text(payload.text);
      if (value) this.emitRuntimeEvent({ type: "assistant.completed", nativeSessionId, ...(turnId ? { turnId } : {}), itemId: `assistant:${turnId ?? randomUUID()}`, text: value, at: now });
      const status = text(payload.status);
      this.activeTurns.delete(nativeSessionId);
      if (status === "error") this.emitRuntimeEvent({ type: "turn.failed", nativeSessionId, ...(turnId ? { turnId } : {}), at: now, error: text(payload.error) || "Hermes 任务失败" });
      else this.emitRuntimeEvent({ type: "turn.completed", nativeSessionId, ...(turnId ? { turnId } : {}), at: now, ...(value ? { result: value } : {}) });
    } else if (event.type === "tool.start") {
      const itemId = text(payload.tool_id) || randomUUID();
      this.emitRuntimeEvent({ type: "tool.started", nativeSessionId, ...(turnId ? { turnId } : {}), itemId, toolName: text(payload.name) || "Tool", input: payload.context ?? payload.args, at: now });
    } else if (event.type === "tool.progress") {
      const itemId = text(payload.tool_id) || randomUUID();
      this.emitRuntimeEvent({ type: "tool.progress", nativeSessionId, ...(turnId ? { turnId } : {}), itemId, toolName: text(payload.name) || "Tool", ...(text(payload.text) ? { text: text(payload.text) } : {}), at: now });
    } else if (event.type === "tool.complete") {
      const itemId = text(payload.tool_id) || randomUUID();
      this.emitRuntimeEvent({ type: "tool.completed", nativeSessionId, ...(turnId ? { turnId } : {}), itemId, toolName: text(payload.name) || "Tool", output: payload.result ?? payload.summary, at: now });
    } else if (event.type === "approval.request") {
      const requestId = text(payload.request_id) || `hermes-approval:${randomUUID()}`;
      const permission: RuntimeAdapterPermission = {
        requestId,
        nativeSessionId,
        toolUseId: text(payload.tool_id) || requestId,
        toolName: text(payload.tool_name) || "Hermes tool",
        title: "Hermes 请求授权",
        description: text(payload.description) || "Hermes 需要确认后才能继续。",
        input: payload,
        createdAt: now,
        canAllowAlways: Array.isArray(payload.choices) && payload.choices.includes("always"),
      };
      this.pendingPermissions.set(requestId, { nativeSessionId, kind: "approval", nativeRequestId: requestId });
      this.emitRuntimeEvent({ type: "permission.requested", permission });
    } else if (event.type === "clarify.request") {
      const requestId = text(payload.request_id) || `hermes-clarify:${randomUUID()}`;
      const choices = Array.isArray(payload.choices) ? payload.choices : [];
      const permission: RuntimeAdapterPermission = {
        requestId,
        nativeSessionId,
        toolUseId: requestId,
        toolName: "AskUserQuestion",
        title: "Hermes 需要你的选择",
        input: {
          questions: [{
            question: text(payload.question) || "请选择",
            options: choices.map((choice) => ({ label: text(choice), description: "" })),
          }],
        },
        createdAt: now,
        canAllowAlways: false,
        question: true,
      };
      this.pendingPermissions.set(requestId, { nativeSessionId, kind: "clarify", nativeRequestId: requestId });
      this.emitRuntimeEvent({ type: "permission.requested", permission });
    }
  }
}
