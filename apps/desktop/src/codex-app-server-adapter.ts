import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { access, readFile } from "node:fs/promises";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import type {
  BridgeModelInfo,
  BridgePermissionDecision,
  BridgeRuntimeProviderInfo,
} from "@bridge/protocol";
import {
  DesktopRuntimeAdapter,
  type RuntimeAdapterHistoryItem,
  type RuntimeAdapterConfiguration,
  type RuntimeAdapterConfigurationChange,
  type RuntimeAdapterPermission,
  type RuntimeAdapterSession,
  type RuntimeAdapterTurnInput,
  type RuntimeAdapterTurnResult,
} from "./runtime-adapter.js";

type JsonRpcId = string | number;

interface JsonRpcRequest {
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

interface JsonRpcInbound {
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: unknown };
}

export interface CodexRpcClient {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  respond(id: JsonRpcId, result: unknown): Promise<void>;
  fail(id: JsonRpcId, message: string): Promise<void>;
  on(event: "notification", listener: (notification: JsonRpcNotification) => void): this;
  on(event: "request", listener: (request: JsonRpcRequest) => void): this;
  close(): Promise<void>;
}

class StdioCodexRpcClient extends EventEmitter implements CodexRpcClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private readonly pending = new Map<JsonRpcId, {
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer: NodeJS.Timeout;
  }>();
  private nextId = 0;
  private closed = false;

  constructor(private readonly executablePath: string) {
    super();
  }

  async start(): Promise<void> {
    if (this.child) return;
    const child = spawn(this.executablePath, ["app-server", "--stdio"], {
      stdio: "pipe",
      windowsHide: true,
    });
    this.child = child;
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => this.handleLine(line));
    child.once("error", () => this.rejectAll(new Error("Codex app-server failed to start")));
    child.once("exit", () => {
      this.child = undefined;
      this.rejectAll(new Error("Codex app-server disconnected"));
    });
    try {
      await new Promise<void>((resolveStart, rejectStart) => {
        const timer = setTimeout(() => rejectStart(new Error("Codex app-server startup timed out")), 12_000);
        child.once("spawn", () => {
          clearTimeout(timer);
          resolveStart();
        });
        child.once("error", () => {
          clearTimeout(timer);
          rejectStart(new Error("Codex app-server failed to start"));
        });
      });
    } catch (error) {
      if (this.child === child) this.child = undefined;
      if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
      throw error;
    }
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const child = this.child;
    if (!child || !child.stdin.writable || this.closed) return Promise.reject(new Error("Codex app-server is not connected"));
    const id = ++this.nextId;
    return new Promise<T>((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) rejectRequest(new Error(`Codex request timed out: ${method}`));
      }, 120_000);
      this.pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer });
      try {
        child.stdin.write(`${JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) })}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        rejectRequest(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async respond(id: JsonRpcId, result: unknown): Promise<void> {
    this.write({ id, result });
  }

  async fail(id: JsonRpcId, message: string): Promise<void> {
    this.write({ id, error: { code: -32000, message } });
  }

  async close(): Promise<void> {
    this.closed = true;
    const child = this.child;
    this.child = undefined;
    this.rejectAll(new Error("Codex app-server closed"));
    if (!child || child.exitCode !== null || child.killed) return;
    child.kill("SIGTERM");
  }

  private write(value: unknown): void {
    if (!this.child?.stdin.writable || this.closed) throw new Error("Codex app-server is not connected");
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  private handleLine(line: string): void {
    let message: JsonRpcInbound;
    try {
      message = JSON.parse(line) as JsonRpcInbound;
    } catch {
      return;
    }
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(typeof message.error.message === "string" ? message.error.message : "Codex RPC failed"));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (!message.method) return;
    if (message.id !== undefined) {
      this.emit("request", { id: message.id, method: message.method, ...(message.params === undefined ? {} : { params: message.params }) });
    } else {
      this.emit("notification", { method: message.method, ...(message.params === undefined ? {} : { params: message.params }) });
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

async function executableAt(path: string): Promise<string | undefined> {
  try {
    await access(path);
    return path;
  } catch {
    return undefined;
  }
}

async function findCodexExecutable(): Promise<string | undefined> {
  const configured = process.env.BRIDGE_CODEX_APP_SERVER_PATH;
  if (configured) return executableAt(resolve(configured));
  if (process.platform === "darwin") {
    const bundled = await executableAt("/Applications/ChatGPT.app/Contents/Resources/codex");
    if (bundled) return bundled;
  }
  return undefined;
}

async function configuredCodexProviders(currentProvider?: string): Promise<BridgeRuntimeProviderInfo[]> {
  const codexHome = process.env.CODEX_HOME || (process.env.HOME ? `${process.env.HOME}/.codex` : undefined);
  const providers = new Map<string, BridgeRuntimeProviderInfo>();
  if (codexHome) {
    try {
      const source = await readFile(`${codexHome}/config.toml`, "utf8");
      const pattern = /^\[model_providers\.([^\]\r\n]+)\]\s*$/gmu;
      for (const match of source.matchAll(pattern)) {
        const value = match[1]?.trim();
        if (!value) continue;
        const start = (match.index ?? 0) + match[0].length;
        const nextHeader = source.slice(start).search(/^\[/mu);
        const section = source.slice(start, nextHeader < 0 ? source.length : start + nextHeader);
        const name = /^name\s*=\s*["']([^"']+)["']/mu.exec(section)?.[1]?.trim();
        providers.set(value, { value, displayName: name || value });
      }
    } catch {
      // Provider discovery is advisory; app-server remains the source of truth.
    }
  }
  if (currentProvider && !providers.has(currentProvider)) {
    providers.set(currentProvider, { value: currentProvider, displayName: currentProvider });
  }
  return [...providers.values()];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isUnsupportedCodexMethod(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(method\s+(?:not found|unknown|unsupported)|unknown\s+method|not implemented)/iu.test(message);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function codexModelInfo(value: unknown): BridgeModelInfo | undefined {
  const model = record(value);
  const modelValue = text(model.model) || text(model.id);
  if (!modelValue) return undefined;
  const reasoningLevels = (Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts : []).flatMap((item) => {
    const effort = text(record(item).reasoningEffort) || text(item);
    return effort ? [effort] : [];
  });
  const serviceTiers = Array.isArray(model.serviceTiers) ? model.serviceTiers : [];
  const supportsFast = serviceTiers.some((tier) => text(record(tier).id) === "priority")
    || stringList(model.additionalSpeedTiers).includes("priority");
  return {
    value: modelValue,
    displayName: text(model.displayName) || modelValue,
    ...(text(model.description) ? { description: text(model.description) } : {}),
    supportsEffort: reasoningLevels.length > 0,
    ...(reasoningLevels.length ? { supportedEffortLevels: reasoningLevels } : {}),
    supportsFast,
  };
}

function timestamp(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return Date.now();
  return value < 10_000_000_000 ? value * 1_000 : value;
}

function turnState(status: unknown): RuntimeAdapterSession["turnState"] {
  const type = text(record(status).type);
  if (type === "active") return "running";
  if (type === "systemError") return "failed";
  return "idle";
}

function sessionFromThread(value: unknown): RuntimeAdapterSession | undefined {
  const thread = record(value);
  const nativeSessionId = text(thread.id);
  if (!nativeSessionId) return undefined;
  const preview = text(thread.name) || text(thread.preview) || "未命名任务";
  const cwd = text(thread.cwd) || process.cwd();
  return {
    nativeSessionId,
    cwd,
    title: preview,
    source: text(thread.source) === "app-server" ? "bridge" : "desktop",
    createdAt: timestamp(thread.createdAt),
    lastActivityAt: timestamp(thread.recencyAt ?? thread.updatedAt ?? thread.createdAt),
    turnState: turnState(thread.status),
    transport: "codex-app-server",
    ...(text(thread.modelProvider) ? { provider: text(thread.modelProvider) } : {}),
    ...(text(thread.model) ? { model: text(thread.model) } : {}),
    ...(text(thread.reasoningEffort) ? { reasoningEffort: text(thread.reasoningEffort) } : {}),
    ...(text(thread.serviceTier) ? { fast: text(thread.serviceTier) === "priority" } : {}),
  };
}

function itemText(item: Record<string, unknown>): string {
  if (typeof item.text === "string") return item.text;
  if (typeof item.command === "string") return item.command;
  if (typeof item.aggregatedOutput === "string") return item.aggregatedOutput;
  if (typeof item.tool === "string") return item.tool;
  return "";
}

function historyFromThread(threadValue: unknown): RuntimeAdapterHistoryItem[] {
  const thread = record(threadValue);
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  const items: RuntimeAdapterHistoryItem[] = [];
  for (const turnValue of turns) {
    const turn = record(turnValue);
    const turnId = text(turn.id) || undefined;
    const startedAt = timestamp(turn.startedAt);
    const turnItems = Array.isArray(turn.items) ? turn.items : [];
    for (const itemValue of turnItems) {
      const item = record(itemValue);
      const id = text(item.id) || randomUUID();
      const type = text(item.type);
      if (type === "userMessage") {
        const content = Array.isArray(item.content) ? item.content : [];
        const joined = content.map((part) => text(record(part).text)).filter(Boolean).join("\n");
        if (joined) items.push({ id, ...(turnId ? { turnId } : {}), role: "user", text: joined, createdAt: startedAt });
      } else if (type === "agentMessage" && text(item.text)) {
        items.push({ id, ...(turnId ? { turnId } : {}), role: "assistant", text: text(item.text), createdAt: startedAt });
      } else if (["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall"].includes(type)) {
        const toolName = type === "commandExecution" ? "Command" : type === "fileChange" ? "File change" : text(item.tool) || type;
        items.push({
          id,
          ...(turnId ? { turnId } : {}),
          role: "tool",
          toolName,
          text: itemText(item) || toolName,
          createdAt: startedAt,
          state: text(item.status) === "inProgress" ? "running" : "completed",
        });
      }
    }
  }
  return items.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
}

interface PendingApproval {
  rpcId: JsonRpcId;
  method: string;
  params: Record<string, unknown>;
  permission: RuntimeAdapterPermission;
}

export interface CodexAppServerAdapterOptions {
  clientFactory?: (executablePath: string) => Promise<CodexRpcClient>;
  findExecutable?: () => Promise<string | undefined>;
}

export class CodexAppServerAdapter extends DesktopRuntimeAdapter {
  private readonly sessionMap = new Map<string, RuntimeAdapterSession>();
  private readonly activeTurns = new Map<string, string>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private modelCatalog: BridgeModelInfo[] | undefined;
  private client: CodexRpcClient | undefined;
  private initialized = false;
  private lifecycleId = 0;

  constructor(private readonly options: CodexAppServerAdapterOptions = {}) {
    super("codex-desktop", "Codex Desktop", [
      "session.list",
      "session.create",
      "session.history",
      "session.configure",
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
    this.setStatus("starting", "正在连接 Codex app-server。");
    try {
      const executable = await (this.options.findExecutable ?? findCodexExecutable)();
      if (lifecycleId !== this.lifecycleId) return;
      if (!executable) {
        this.setStatus("unavailable", "未发现 Codex Desktop app-server。请安装 ChatGPT Desktop 或配置 BRIDGE_CODEX_APP_SERVER_PATH。");
        return;
      }
      const client = await (this.options.clientFactory
        ? this.options.clientFactory(executable)
        : this.createClient(executable));
      if (lifecycleId !== this.lifecycleId) {
        await client.close().catch(() => undefined);
        return;
      }
      this.client = client;
      client.on("notification", (notification) => this.handleNotification(notification));
      client.on("request", (request) => void this.handleRequest(request).catch(() => undefined));
      const initialized = await client.request<Record<string, unknown>>("initialize", {
        clientInfo: { name: "bridge", title: "Bridge", version: "0.6.0" },
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
      await this.refresh();
      if (lifecycleId !== this.lifecycleId) return;
      this.setStatus("ready", "Codex app-server 已接入。", {
        ...(text(initialized.userAgent) ? { appVersion: text(initialized.userAgent) } : {}),
        sessionCount: this.sessionMap.size,
      });
    } catch {
      if (lifecycleId !== this.lifecycleId) return;
      await this.client?.close().catch(() => undefined);
      this.client = undefined;
      this.setStatus("error", "无法连接 Codex app-server。请确认 Codex Desktop 已登录并重试。");
    }
  }

  async refresh(): Promise<void> {
    const client = this.requireClient();
    const result = await client.request<Record<string, unknown>>("thread/list", { limit: 100, archived: false });
    const rows = Array.isArray(result.data) ? result.data : [];
    const previous = this.sessionMap;
    const next = new Map<string, RuntimeAdapterSession>();
    for (const value of rows) {
      const session = sessionFromThread(value);
      if (!session) continue;
      const prior = previous.get(session.nativeSessionId);
      if (prior) {
        if (!session.provider && prior.provider) session.provider = prior.provider;
        if (!session.model && prior.model) session.model = prior.model;
        if (!session.reasoningEffort && prior.reasoningEffort) session.reasoningEffort = prior.reasoningEffort;
        if (session.fast === undefined && prior.fast !== undefined) session.fast = prior.fast;
      }
      const activeTurnId = this.activeTurns.get(session.nativeSessionId);
      if (activeTurnId) {
        session.turnState = "running";
        session.activeTurnId = activeTurnId;
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
    const client = this.requireClient();
    const result = await client.request<Record<string, unknown>>("thread/start", {
      cwd: input.cwd,
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
    });
    const session = sessionFromThread(result.thread);
    if (!session) throw new Error("Codex app-server returned an invalid thread");
    if (input.title) session.title = input.title;
    session.source = "bridge";
    this.sessionMap.set(session.nativeSessionId, session);
    this.applyThreadConfiguration(session.nativeSessionId, result);
    this.setSessionCount(this.sessionMap.size);
    const configuredSession = this.sessionMap.get(session.nativeSessionId) ?? session;
    this.emitRuntimeEvent({ type: "session.updated", session: { ...configuredSession } });
    return { ...configuredSession };
  }

  async history(nativeSessionId: string): Promise<RuntimeAdapterHistoryItem[]> {
    const client = this.requireClient();
    const result = await client.request<Record<string, unknown>>("thread/read", {
      threadId: nativeSessionId,
      includeTurns: true,
    });
    return historyFromThread(result.thread);
  }

  async configuration(nativeSessionId: string): Promise<RuntimeAdapterConfiguration> {
    const session = this.sessionMap.get(nativeSessionId);
    if (!session) throw new Error("Codex thread not found");
    const running = this.activeTurns.has(nativeSessionId);
    const resumed = await this.resumeThread(nativeSessionId);
    this.applyThreadConfiguration(nativeSessionId, resumed, running);
    const current = this.sessionMap.get(nativeSessionId) ?? session;
    const catalog = await this.loadModelCatalog();
    const providers = await configuredCodexProviders(current.provider);
    const models = [...catalog.models];
    if (current.model && !models.some((candidate) => candidate.value === current.model)) {
      models.unshift({
        value: current.model,
        displayName: current.model,
        ...(current.provider ? { provider: current.provider } : {}),
        supportsEffort: true,
        supportedEffortLevels: ["none", "low", "medium", "high", "xhigh", "max", "ultra"],
        supportsFast: false,
      });
    }
    const selectedModel = models.find((candidate) => candidate.value === current.model);
    if (selectedModel?.supportsEffort === false) delete current.reasoningEffort;
    const reasoningLevels = selectedModel?.supportedEffortLevels?.length
      ? [...selectedModel.supportedEffortLevels]
      : ["none", "low", "medium", "high", "xhigh", "max", "ultra"];
    this.sessionMap.set(nativeSessionId, { ...current });
    return {
      ...(current.provider ? { provider: current.provider } : {}),
      ...(current.model ? { model: current.model } : {}),
      ...(current.reasoningEffort ? { reasoningEffort: current.reasoningEffort } : {}),
      ...(current.fast !== undefined ? { fast: current.fast } : {}),
      availableModels: models,
      availableProviders: providers,
      availableReasoningEfforts: reasoningLevels,
      modelsComplete: catalog.complete,
      supportsFastMode: models.some((candidate) => candidate.supportsFast === true),
      appliesAfterTurn: running,
    };
  }

  async configureSession(
    nativeSessionId: string,
    change: RuntimeAdapterConfigurationChange,
  ): Promise<RuntimeAdapterConfiguration> {
    const session = this.sessionMap.get(nativeSessionId);
    if (!session) throw new Error("Codex thread not found");
    const client = this.requireClient();
    const nextModel = change.model === null ? undefined : change.model ?? session.model;
    const nextProvider = change.provider === null ? undefined : change.provider ?? session.provider;
    const running = this.activeTurns.has(nativeSessionId);

    if ((change.model !== undefined || change.provider !== undefined) && !nextModel) {
      throw new Error("Codex 需要先选择模型");
    }

    const settings: Record<string, unknown> = { threadId: nativeSessionId };
    if (change.model !== undefined && nextModel) settings.model = nextModel;
    if (change.reasoningEffort !== undefined) settings.effort = change.reasoningEffort;
    if (change.fast !== undefined) {
      settings.serviceTier = change.fast === null ? null : change.fast ? "priority" : "default";
    }

    let settingsUnsupported = false;
    if (change.provider !== undefined) {
      await this.resumeThread(nativeSessionId, {
        ...(nextModel ? { model: nextModel } : {}),
        provider: nextProvider ?? null,
        ...(change.fast !== undefined
          ? { serviceTier: change.fast === null ? null : change.fast ? "priority" : "default" }
          : {}),
      });
    }
    if (Object.keys(settings).length > 1) {
      try {
        await client.request("thread/settings/update", settings);
      } catch (error) {
        if (!isUnsupportedCodexMethod(error)) throw error;
        settingsUnsupported = true;
      }
    }
    if (settingsUnsupported && (change.model !== undefined || change.fast !== undefined) && change.provider === undefined) {
      await this.resumeThread(nativeSessionId, {
        ...(nextModel ? { model: nextModel } : {}),
        ...(change.fast !== undefined
          ? { serviceTier: change.fast === null ? null : change.fast ? "priority" : "default" }
          : {}),
      });
    }

    const updatedSession = this.sessionMap.get(nativeSessionId) ?? session;
    if (change.model !== undefined && nextModel) updatedSession.model = nextModel;
    if (change.provider !== undefined) {
      if (nextProvider) updatedSession.provider = nextProvider;
      else delete updatedSession.provider;
    }
    if (change.reasoningEffort !== undefined) {
      if (change.reasoningEffort) updatedSession.reasoningEffort = change.reasoningEffort;
      else delete updatedSession.reasoningEffort;
    }
    if (change.fast !== undefined) {
      if (change.fast === null) delete updatedSession.fast;
      else updatedSession.fast = change.fast;
    }
    updatedSession.lastActivityAt = Date.now();
    this.sessionMap.set(nativeSessionId, { ...updatedSession });
    this.emitRuntimeEvent({ type: "session.updated", session: { ...updatedSession } });
    return this.configuration(nativeSessionId);
  }

  async startTurn(input: RuntimeAdapterTurnInput): Promise<RuntimeAdapterTurnResult> {
    const client = this.requireClient();
    const configuredSession = this.sessionMap.get(input.nativeSessionId);
    const resumed = await this.resumeThread(input.nativeSessionId, {
      ...(configuredSession?.model ? { model: configuredSession.model } : {}),
      ...(configuredSession?.provider ? { provider: configuredSession.provider } : {}),
      ...(configuredSession?.fast !== undefined
        ? { serviceTier: configuredSession.fast ? "priority" : "default" }
        : {}),
    });
    this.applyThreadConfiguration(input.nativeSessionId, resumed, true);
    const activeSession = this.sessionMap.get(input.nativeSessionId);
    const settings: Record<string, unknown> = {
      threadId: input.nativeSessionId,
      ...(activeSession?.model ? { model: activeSession.model } : {}),
      ...(activeSession?.reasoningEffort ? { effort: activeSession.reasoningEffort } : {}),
      ...(activeSession?.fast !== undefined ? { serviceTier: activeSession.fast ? "priority" : "default" } : {}),
    };
    if (Object.keys(settings).length > 1) {
      await client.request<Record<string, unknown>>("thread/settings/update", settings).catch((error) => {
        if (!isUnsupportedCodexMethod(error)) throw error;
      });
    }
    const result = await client.request<Record<string, unknown>>("turn/start", {
      threadId: input.nativeSessionId,
      clientUserMessageId: input.requestId,
      input: [{ type: "text", text: input.text, text_elements: [] }],
      ...(activeSession?.model ? { model: activeSession.model } : {}),
      ...(activeSession?.reasoningEffort ? { effort: activeSession.reasoningEffort } : {}),
      ...(activeSession?.fast !== undefined ? { serviceTier: activeSession.fast ? "priority" : "default" } : {}),
    });
    const turnId = text(record(result.turn).id) || undefined;
    if (turnId) this.activeTurns.set(input.nativeSessionId, turnId);
    const session = this.sessionMap.get(input.nativeSessionId);
    if (session) {
      session.turnState = "running";
      session.lastActivityAt = Date.now();
      if (turnId) session.activeTurnId = turnId;
      this.emitRuntimeEvent({ type: "session.updated", session: { ...session } });
    }
    return { ...(turnId ? { turnId } : {}), state: "running" };
  }

  async steerTurn(input: RuntimeAdapterTurnInput): Promise<RuntimeAdapterTurnResult> {
    const client = this.requireClient();
    const turnId = this.activeTurns.get(input.nativeSessionId) ?? this.sessionMap.get(input.nativeSessionId)?.activeTurnId;
    if (!turnId) throw new Error("Codex 当前没有可立即调整的任务");
    await client.request("turn/steer", {
      threadId: input.nativeSessionId,
      clientUserMessageId: input.requestId,
      input: [{ type: "text", text: input.text, text_elements: [] }],
      expectedTurnId: turnId,
    });
    return { turnId, state: "running" };
  }

  async interruptTurn(nativeSessionId: string): Promise<boolean> {
    const client = this.requireClient();
    const turnId = this.activeTurns.get(nativeSessionId) ?? this.sessionMap.get(nativeSessionId)?.activeTurnId;
    if (!turnId) return false;
    await client.request("turn/interrupt", { threadId: nativeSessionId, turnId });
    this.activeTurns.delete(nativeSessionId);
    return true;
  }

  async resolvePermission(
    requestId: string,
    decision: BridgePermissionDecision,
    updatedInput?: Record<string, unknown>,
  ): Promise<boolean> {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending) return false;
    this.pendingApprovals.delete(requestId);
    const client = this.requireClient();
    if (pending.method === "item/tool/requestUserInput") {
      const questions = Array.isArray(pending.params.questions) ? pending.params.questions : [];
      const answers = record(updatedInput?.answers);
      const response: Record<string, unknown> = {};
      for (const questionValue of questions) {
        const question = record(questionValue);
        const id = text(question.id);
        const key = text(question.question);
        if (!id) continue;
        const answer = typeof answers[key] === "string" ? answers[key] : "";
        response[id] = { answers: answer ? [answer] : [] };
      }
      await client.respond(pending.rpcId, { answers: response });
    } else if (pending.method === "item/commandExecution/requestApproval" || pending.method === "item/fileChange/requestApproval") {
      const accepted = decision === "allow-always" ? "acceptForSession" : decision === "allow-once" ? "accept" : "decline";
      await client.respond(pending.rpcId, { decision: accepted });
    } else {
      await client.fail(pending.rpcId, "Bridge cannot grant this Codex request remotely");
    }
    this.emitRuntimeEvent({
      type: "permission.resolved",
      nativeSessionId: pending.permission.nativeSessionId,
      requestId,
      decision,
      at: Date.now(),
    });
    return true;
  }

  async close(): Promise<void> {
    this.lifecycleId += 1;
    const client = this.client;
    this.client = undefined;
    this.initialized = false;
    await client?.close();
  }

  private async createClient(executable: string): Promise<CodexRpcClient> {
    const client = new StdioCodexRpcClient(executable);
    await client.start();
    return client;
  }

  private requireClient(): CodexRpcClient {
    if (!this.client) throw new Error("Codex app-server is unavailable");
    return this.client;
  }

  private async loadModelCatalog(): Promise<{ models: BridgeModelInfo[]; complete: boolean }> {
    if (this.modelCatalog) return { models: this.modelCatalog.map((model) => ({ ...model })), complete: true };
    const models: BridgeModelInfo[] = [];
    let cursor: string | undefined;
    try {
      for (let page = 0; page < 20; page += 1) {
        const result = await this.requireClient().request<Record<string, unknown>>("model/list", {
          limit: 100,
          includeHidden: false,
          ...(cursor ? { cursor } : {}),
        });
        const rows = Array.isArray(result.data) ? result.data : [];
        for (const value of rows) {
          const model = codexModelInfo(value);
          if (model && !models.some((candidate) => candidate.value === model.value)) {
            models.push(model);
          }
        }
        const nextCursor = text(result.nextCursor);
        if (!nextCursor || nextCursor === cursor) break;
        cursor = nextCursor;
      }
      this.modelCatalog = models.map((model) => ({ ...model }));
      return { models, complete: true };
    } catch {
      return { models: this.modelCatalog?.map((model) => ({ ...model })) ?? [], complete: false };
    }
  }

  private applyThreadConfiguration(nativeSessionId: string, value: unknown, preserve = true): void {
    const response = record(value);
    const thread = record(response.thread);
    const session = this.sessionMap.get(nativeSessionId);
    if (!session) return;
    const field = (keys: string[]): { present: boolean; value: unknown } => {
      for (const key of keys) {
        if (hasOwn(response, key)) return { present: true, value: response[key] };
      }
      for (const key of keys) {
        if (hasOwn(thread, key)) return { present: true, value: thread[key] };
      }
      return { present: false, value: undefined };
    };
    const model = field(["model"]);
    const provider = field(["modelProvider"]);
    const effort = field(["reasoningEffort", "effort"]);
    const serviceTier = field(["serviceTier"]);

    if (model.present && (!preserve || !session.model)) {
      const value = text(model.value);
      if (value) session.model = value;
      else delete session.model;
    }
    if (provider.present && (!preserve || !session.provider)) {
      const value = text(provider.value);
      if (value) session.provider = value;
      else delete session.provider;
    }
    if (effort.present && (!preserve || !session.reasoningEffort)) {
      const value = text(effort.value);
      if (value) session.reasoningEffort = value;
      else delete session.reasoningEffort;
    }
    if (serviceTier.present && (!preserve || session.fast === undefined)) {
      const value = text(serviceTier.value);
      if (value) session.fast = value === "priority";
      else delete session.fast;
    }
    this.sessionMap.set(nativeSessionId, { ...session });
  }

  private async resumeThread(
    nativeSessionId: string,
    settings: {
      model?: string | null;
      provider?: string | null;
      serviceTier?: string | null;
    } = {},
  ): Promise<Record<string, unknown>> {
    return this.requireClient().request<Record<string, unknown>>("thread/resume", {
      threadId: nativeSessionId,
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      excludeTurns: true,
      ...(settings.model !== undefined ? { model: settings.model } : {}),
      ...(settings.provider !== undefined ? { modelProvider: settings.provider } : {}),
      ...(settings.serviceTier !== undefined ? { serviceTier: settings.serviceTier } : {}),
    });
  }

  private handleNotification(notification: JsonRpcNotification): void {
    const params = record(notification.params);
    const nativeSessionId = text(params.threadId);
    const now = Date.now();
    if (notification.method === "thread/settings/updated" && nativeSessionId) {
      this.applyThreadConfiguration(nativeSessionId, { thread: record(params.threadSettings) }, false);
      const session = this.sessionMap.get(nativeSessionId);
      if (session) this.emitRuntimeEvent({ type: "session.updated", session: { ...session } });
      return;
    }
    if (notification.method === "turn/started" && nativeSessionId) {
      const turnId = text(record(params.turn).id) || undefined;
      if (turnId) this.activeTurns.set(nativeSessionId, turnId);
      this.emitRuntimeEvent({ type: "turn.started", nativeSessionId, ...(turnId ? { turnId } : {}), at: now });
      return;
    }
    if (notification.method === "turn/completed" && nativeSessionId) {
      const turn = record(params.turn);
      const turnId = text(turn.id) || this.activeTurns.get(nativeSessionId);
      const status = text(turn.status);
      this.activeTurns.delete(nativeSessionId);
      if (status === "failed") {
        this.emitRuntimeEvent({ type: "turn.failed", nativeSessionId, ...(turnId ? { turnId } : {}), at: now, error: text(record(turn.error).message) || "Codex 任务失败" });
      } else if (status === "interrupted") {
        this.emitRuntimeEvent({ type: "turn.interrupted", nativeSessionId, ...(turnId ? { turnId } : {}), at: now });
      } else {
        this.emitRuntimeEvent({ type: "turn.completed", nativeSessionId, ...(turnId ? { turnId } : {}), at: now });
      }
      return;
    }
    if (notification.method === "item/agentMessage/delta" && nativeSessionId) {
      const delta = text(params.delta);
      if (delta) this.emitRuntimeEvent({
        type: "assistant.delta",
        nativeSessionId,
        ...(text(params.turnId) ? { turnId: text(params.turnId) } : {}),
        ...(text(params.itemId) ? { itemId: text(params.itemId) } : {}),
        text: delta,
        at: now,
      });
      return;
    }
    if ((notification.method === "item/started" || notification.method === "item/completed") && nativeSessionId) {
      const item = record(params.item);
      const turnId = text(params.turnId) || undefined;
      const itemId = text(item.id) || randomUUID();
      const type = text(item.type);
      if (type === "agentMessage" && notification.method === "item/completed") {
        const value = text(item.text);
        if (value) this.emitRuntimeEvent({ type: "assistant.completed", nativeSessionId, ...(turnId ? { turnId } : {}), itemId, text: value, at: now });
        return;
      }
      if (["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall"].includes(type)) {
        const toolName = type === "commandExecution" ? "Command" : type === "fileChange" ? "File change" : text(item.tool) || type;
        if (notification.method === "item/started") {
          this.emitRuntimeEvent({ type: "tool.started", nativeSessionId, ...(turnId ? { turnId } : {}), itemId, toolName, input: item, at: now });
        } else {
          this.emitRuntimeEvent({ type: "tool.completed", nativeSessionId, ...(turnId ? { turnId } : {}), itemId, toolName, output: item, at: now });
        }
      }
    }
  }

  private async handleRequest(request: JsonRpcRequest): Promise<void> {
    const params = record(request.params);
    const nativeSessionId = text(params.threadId);
    if (!nativeSessionId) {
      await this.client?.fail(request.id, "Bridge requires a thread id for remote approval").catch(() => undefined);
      return;
    }
    let permission: RuntimeAdapterPermission | undefined;
    if (request.method === "item/commandExecution/requestApproval") {
      const itemId = text(params.itemId) || String(request.id);
      permission = {
        requestId: String(request.id),
        nativeSessionId,
        toolUseId: itemId,
        toolName: "Command",
        title: "Codex 请求执行命令",
        description: text(params.reason) || "Codex 需要确认后才能执行命令。",
        input: { command: text(params.command), cwd: text(params.cwd) },
        createdAt: typeof params.startedAtMs === "number" ? params.startedAtMs : Date.now(),
        canAllowAlways: true,
      };
    } else if (request.method === "item/fileChange/requestApproval") {
      const itemId = text(params.itemId) || String(request.id);
      permission = {
        requestId: String(request.id),
        nativeSessionId,
        toolUseId: itemId,
        toolName: "File change",
        title: "Codex 请求修改文件",
        description: text(params.reason) || "Codex 需要确认后才能修改工作区文件。",
        input: { root: text(params.grantRoot) },
        createdAt: typeof params.startedAtMs === "number" ? params.startedAtMs : Date.now(),
        canAllowAlways: true,
      };
    } else if (request.method === "item/tool/requestUserInput") {
      const itemId = text(params.itemId) || String(request.id);
      const questions = Array.isArray(params.questions) ? params.questions.map((value) => {
        const question = record(value);
        return {
          question: text(question.question) || text(question.header),
          options: Array.isArray(question.options) ? question.options.map((option) => {
            const item = record(option);
            return { label: text(item.label), description: text(item.description) };
          }) : [],
        };
      }) : [];
      permission = {
        requestId: String(request.id),
        nativeSessionId,
        toolUseId: itemId,
        toolName: "AskUserQuestion",
        title: "Codex 需要你的选择",
        input: { questions },
        createdAt: Date.now(),
        canAllowAlways: false,
        question: true,
      };
    }
    if (!permission) {
      await this.client?.fail(request.id, "This Codex request is desktop-only").catch(() => undefined);
      return;
    }
    this.pendingApprovals.set(permission.requestId, { rpcId: request.id, method: request.method, params, permission });
    this.emitRuntimeEvent({ type: "permission.requested", permission });
  }
}
