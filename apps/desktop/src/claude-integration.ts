import { createHash, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { basename, dirname, join } from "node:path";
import type { ClaudeSessionInfo, HistoryRequestPayload, StatusPayload } from "@bridge/protocol";
import {
  type ClaudeBridgeActivity,
  type ClaudeSessionSnapshot,
  type DesktopController,
} from "./controller.js";
import { listClaudeDesktopSessions, type ClaudeDesktopSession } from "./claude-desktop-sessions.js";
import type { ClaudeWorkerErrorKind, ClaudeWorkerLease } from "./claude-background-worker.js";
import type { ClaudeRuntimePaths } from "./platform.js";
import { readClaudeSessionHistory, type ClaudeHistoryReadResult } from "./claude-history.js";

const MAX_BODY_BYTES = 256 * 1024;
const DEFAULT_POLL_INTERVAL_MS = 2_500;
const WORKER_TTL_MS = 35_000;
const LEASE_TTL_MS = 90_000;
const COMMAND_RETRY_DELAY_MS = 30_000;

interface ClaudeSessionFile {
  pid?: unknown;
  sessionId?: unknown;
  cwd?: unknown;
  startedAt?: unknown;
  name?: unknown;
}

interface ClaudeTaskFile {
  id?: unknown;
  subject?: unknown;
  activeForm?: unknown;
  status?: unknown;
}

interface ClaudeTask {
  id: string;
  subject: string;
  activeForm: string;
  status: string;
}

export interface ClaudeHookInput {
  session_id?: unknown;
  cwd?: unknown;
  hook_event_name?: unknown;
  notification_type?: unknown;
  tool_name?: unknown;
  tool_use_id?: unknown;
  prompt_id?: unknown;
  prompt?: unknown;
  last_assistant_message?: unknown;
  [key: string]: unknown;
}

export interface ClaudeIntegrationOptions {
  controller: DesktopController;
  paths: ClaudeRuntimePaths;
  authorization: string;
  host?: string;
  port?: number;
  pollIntervalMs?: number;
  processAlive?: (pid: number) => boolean;
  bridgeSessionsPath?: string;
}

interface BackgroundWorkerState {
  workerId: string;
  available: boolean;
  authenticated: boolean;
  lastSeenAt: number;
  version?: string;
}

interface CommandLease {
  workerId: string;
  sourceSessionId: string;
  expiresAt: number;
}

interface BridgeSessionRoute {
  sourceSessionId: string;
  bridgeSessionId: string;
  cwd: string;
  updatedAt: number;
  resumedFromSource: boolean;
}

interface BridgeSessionRouteFile {
  version: 1;
  sessions: BridgeSessionRoute[];
}

interface ClaudeSessionCatalogEntry extends ClaudeSessionInfo {
  cwd: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return undefined;
  }
}

async function listJsonFiles(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => join(path, entry.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function taskOrder(left: ClaudeTask, right: ClaudeTask): number {
  const leftNumber = Number(left.id);
  const rightNumber = Number(right.id);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return leftNumber - rightNumber;
  return left.id.localeCompare(right.id);
}

function compactText(value: string, limit = 180): string {
  const compact = value.replace(/\s+/gu, " ").trim();
  return compact.length <= limit ? compact : `${compact.slice(0, limit - 1)}…`;
}

async function readTasks(path: string): Promise<ClaudeTask[]> {
  const files = await listJsonFiles(path);
  const tasks = await Promise.all(files.map(async (file) => {
    const value = await readJson(file) as ClaudeTaskFile | undefined;
    if (!value || typeof value.id !== "string" || typeof value.status !== "string") return undefined;
    const subject = typeof value.subject === "string" ? value.subject : "";
    const activeForm = typeof value.activeForm === "string" ? value.activeForm : subject;
    if (!subject && !activeForm) return undefined;
    return { id: value.id, subject: subject || activeForm, activeForm: activeForm || subject, status: value.status };
  }));
  return tasks.filter((task): task is ClaudeTask => task !== undefined).sort(taskOrder);
}

export async function scanClaudeSessions(
  paths: ClaudeRuntimePaths,
  processAlive: (pid: number) => boolean = defaultProcessAlive,
  desktopSessionSource?: ClaudeDesktopSession[],
): Promise<ClaudeSessionSnapshot[]> {
  const desktopSessions = desktopSessionSource ?? await listClaudeDesktopSessions(paths.desktopSessions);
  const desktopByCliSession = new Map<string, (typeof desktopSessions)[number]>();
  for (const desktopSession of desktopSessions) {
    if (!desktopByCliSession.has(desktopSession.cliSessionId)) {
      desktopByCliSession.set(desktopSession.cliSessionId, desktopSession);
    }
  }
  const files = await listJsonFiles(paths.sessions);
  const sessions = await Promise.all(files.map(async (file): Promise<ClaudeSessionSnapshot | undefined> => {
    const value = await readJson(file) as ClaudeSessionFile | undefined;
    if (
      !value ||
      typeof value.pid !== "number" ||
      !Number.isInteger(value.pid) ||
      typeof value.sessionId !== "string" ||
      typeof value.cwd !== "string" ||
      typeof value.startedAt !== "number" ||
      !processAlive(value.pid)
    ) return undefined;

    const tasks = await readTasks(join(paths.tasks, value.sessionId));
    const completedTasks = tasks.filter((task) => task.status === "completed").length;
    const pendingTasks = tasks.filter((task) => task.status === "pending").length;
    const current = tasks.find((task) => task.status === "in_progress")
      ?? tasks.find((task) => task.status === "pending");
    const projectName = compactText(basename(value.cwd) || value.cwd, 100);
    const name = typeof value.name === "string" && value.name.trim() ? compactText(value.name, 100) : projectName;
    const desktopSession = desktopByCliSession.get(value.sessionId);
    const desktopActivityAt = desktopSession
      ? Math.max(desktopSession.lastActivityAt, desktopSession.lastFocusedAt, desktopSession.createdAt)
      : 0;
    return {
      sessionId: value.sessionId,
      ...(desktopSession ? { desktopSessionId: desktopSession.sessionId } : {}),
      pid: value.pid,
      cwd: value.cwd,
      projectName,
      name,
      startedAt: value.startedAt,
      lastActivityAt: desktopActivityAt || value.startedAt,
      state: "running",
      completedTasks,
      totalTasks: tasks.length,
      pendingTasks,
      ...(current ? { currentTask: compactText(current.subject || current.activeForm) } : {}),
    } satisfies ClaudeSessionSnapshot;
  }));
  const liveSessions = sessions
    .filter((session): session is ClaudeSessionSnapshot => session !== undefined)
    .sort((left, right) => right.lastActivityAt - left.lastActivityAt || right.startedAt - left.startedAt);
  if (liveSessions.length > 0) return liveSessions;

  const recent = desktopSessions[0];
  if (!recent) return [];
  const tasks = await readTasks(join(paths.tasks, recent.cliSessionId));
  const completedTasks = tasks.filter((task) => task.status === "completed").length;
  const pendingTasks = tasks.filter((task) => task.status === "pending").length;
  const current = tasks.find((task) => task.status === "in_progress")
    ?? tasks.find((task) => task.status === "pending");
  const projectName = compactText(basename(recent.cwd) || recent.cwd, 100);
  return [{
    sessionId: recent.cliSessionId,
    desktopSessionId: recent.sessionId,
    cwd: recent.cwd,
    projectName,
    name: recent.title ? compactText(recent.title, 100) : projectName,
    startedAt: recent.createdAt,
    lastActivityAt: recent.lastActivityAt,
    state: "idle",
    completedTasks,
    totalTasks: tasks.length,
    pendingTasks,
    ...(current ? { currentTask: compactText(current.subject || current.activeForm) } : {}),
  }];
}

export function buildClaudeSessionCatalog(
  desktopSessions: ClaudeDesktopSession[],
  observedSessions: ClaudeSessionSnapshot[],
  limit = 60,
): ClaudeSessionCatalogEntry[] {
  const observedById = new Map(observedSessions.map((session) => [session.sessionId, session]));
  const seen = new Set<string>();
  const catalog: ClaudeSessionCatalogEntry[] = [];
  for (const desktopSession of desktopSessions) {
    if (seen.has(desktopSession.cliSessionId)) continue;
    seen.add(desktopSession.cliSessionId);
    const observed = observedById.get(desktopSession.cliSessionId);
    const projectName = observed?.projectName
      ?? compactText(basename(desktopSession.cwd) || desktopSession.cwd, 100);
    catalog.push({
      sessionId: desktopSession.cliSessionId,
      desktopSessionId: desktopSession.sessionId,
      title: observed?.name ?? compactText(desktopSession.title || projectName, 140),
      projectName,
      cwd: desktopSession.cwd,
      state: observed?.state ?? "idle",
      lastActivityAt: Math.max(
        observed?.lastActivityAt ?? 0,
        desktopSession.lastActivityAt,
        desktopSession.lastFocusedAt,
        desktopSession.createdAt,
      ),
      ...(observed && observed.totalTasks > 0 ? {
        completedTasks: observed.completedTasks,
        totalTasks: observed.totalTasks,
      } : {}),
      ...(observed?.currentTask ? { currentTask: observed.currentTask } : {}),
    });
  }
  for (const observed of observedSessions) {
    if (seen.has(observed.sessionId)) continue;
    catalog.push({
      sessionId: observed.sessionId,
      ...(observed.desktopSessionId ? { desktopSessionId: observed.desktopSessionId } : {}),
      title: observed.name,
      projectName: observed.projectName,
      cwd: observed.cwd,
      state: observed.state,
      lastActivityAt: observed.lastActivityAt,
      ...(observed.totalTasks > 0 ? {
        completedTasks: observed.completedTasks,
        totalTasks: observed.totalTasks,
      } : {}),
      ...(observed.currentTask ? { currentTask: observed.currentTask } : {}),
    });
  }
  return catalog
    .sort((left, right) => (
      Number(right.state === "running") - Number(left.state === "running")
      || right.lastActivityAt - left.lastActivityAt
    ))
    .slice(0, limit);
}

export function primaryProjectSessions(sessions: ClaudeSessionSnapshot[]): ClaudeSessionSnapshot[] {
  const seen = new Set<string>();
  return sessions.filter((session) => {
    if (seen.has(session.cwd)) return false;
    seen.add(session.cwd);
    return true;
  });
}

function sessionPublishFingerprint(session: ClaudeSessionSnapshot): string {
  return JSON.stringify({
    projectName: session.projectName,
    state: session.state,
    completedTasks: session.completedTasks,
    totalTasks: session.totalTasks,
    pendingTasks: session.pendingTasks,
    currentTask: session.currentTask,
  });
}

export function sessionStatusPayload(session: ClaudeSessionSnapshot): StatusPayload {
  if (session.totalTasks === 0) {
    return {
      kind: "status",
      step: session.projectName,
      message: session.state === "idle"
        ? "已读取 Claude Desktop 历史，可从手机在 Bridge 后台继续。"
        : "Claude Desktop 会话已打开，可从手机创建 Bridge 后台续写。",
      level: "info",
      sessionId: session.sessionId,
    };
  }
  const complete = session.completedTasks === session.totalTasks;
  const progressText = session.currentTask
    ? `当前：${session.currentTask}；已完成 ${session.completedTasks}/${session.totalTasks} 项`
    : `任务清单已完成 ${session.completedTasks}/${session.totalTasks} 项`;
  const message = session.state === "idle"
    ? `${progressText}；可从手机在 Bridge 后台继续。`
    : progressText;
  return {
    kind: "status",
    step: session.projectName,
    message,
    progress: Math.round((session.completedTasks / session.totalTasks) * 100),
    level: complete ? "success" : "info",
    sessionId: session.sessionId,
  };
}

export function hookStatusPayload(input: ClaudeHookInput, projectName: string): StatusPayload | undefined {
  const eventName = typeof input.hook_event_name === "string" ? input.hook_event_name : "";
  if (eventName === "Notification" && input.notification_type === "permission_prompt") {
    return { kind: "status", step: projectName, message: "Claude 正在等待电脑端确认操作。", level: "warning" };
  }
  if (eventName === "Notification" && input.notification_type === "idle_prompt") {
    return { kind: "status", step: projectName, message: "Claude 已暂停，正在等待下一条指令。", level: "info" };
  }
  if (eventName === "PostToolUseFailure") {
    const toolName = typeof input.tool_name === "string" ? compactText(input.tool_name, 80) : "工具";
    return { kind: "status", step: projectName, message: `${toolName} 执行失败，Claude 正在处理。`, level: "warning" };
  }
  if (eventName === "SessionStart") {
    return { kind: "status", step: projectName, message: "Claude 会话已启动。", level: "info" };
  }
  return undefined;
}

async function readRequestJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const contentType = request.headers["content-type"] ?? "";
  if (!contentType.toLowerCase().includes("application/json")) throw new Error("content_type");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) throw new Error("body_too_large");
    chunks.push(buffer);
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  if (!isRecord(parsed)) throw new Error("invalid_json");
  return parsed;
}

function authorized(request: IncomingMessage, expected: string): boolean {
  const actual = request.headers.authorization;
  if (typeof actual !== "string") return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function sendJson(response: ServerResponse, status: number, value: unknown, onSent?: () => void): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(value), onSent);
}

function mergeHistories(
  source: ClaudeHistoryReadResult,
  bridge: ClaudeHistoryReadResult,
): ClaudeHistoryReadResult {
  const messages = new Map(source.messages.map((message) => [message.id, message]));
  for (const message of bridge.messages) messages.set(message.id, message);
  const sorted = [...messages.values()].sort((left, right) => (
    left.createdAt - right.createdAt || left.id.localeCompare(right.id)
  ));
  const trimmed = sorted.slice(-40);
  return {
    available: source.available || bridge.available,
    messages: trimmed,
    truncated: source.truncated || bridge.truncated || trimmed.length < sorted.length,
  };
}

function workerIdFrom(body: Record<string, unknown>): string | undefined {
  const value = body.workerId;
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/u.test(value) ? value : undefined;
}

function safeWorkerText(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, limit) : undefined;
}

export class ClaudeIntegration {
  private readonly controller: DesktopController;
  private readonly paths: ClaudeRuntimePaths;
  private readonly authorization: string;
  private readonly host: string;
  private readonly port: number;
  private readonly pollIntervalMs: number;
  private readonly processAlive: (pid: number) => boolean;
  private readonly bridgeSessionsPath: string | undefined;
  private server: HttpServer | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private sessions: ClaudeSessionSnapshot[] = [];
  private sessionCatalog: ClaudeSessionCatalogEntry[] = [];
  private readonly published = new Map<string, string>();
  private publishedCatalog = "";
  private readonly announcedCommands = new Set<string>();
  private readonly hookAnnouncements = new Set<string>();
  private readonly backgroundWorkers = new Map<string, BackgroundWorkerState>();
  private readonly commandLeases = new Map<string, CommandLease>();
  private readonly commandRetryAt = new Map<string, number>();
  private readonly commandFailures = new Map<string, ClaudeWorkerErrorKind>();
  private readonly bridgeSessionRoutes = new Map<string, BridgeSessionRoute>();
  private readonly sessionsUpdatedViaBridge = new Set<string>();
  private activitiesHydrated = false;
  private refreshing: Promise<void> | undefined;
  private savingRoutes: Promise<void> = Promise.resolve();

  constructor(options: ClaudeIntegrationOptions) {
    this.controller = options.controller;
    this.paths = options.paths;
    this.authorization = options.authorization;
    this.host = options.host ?? "127.0.0.1";
    this.port = options.port ?? 8790;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.processAlive = options.processAlive ?? defaultProcessAlive;
    this.bridgeSessionsPath = options.bridgeSessionsPath;
  }

  localPort(): number | undefined {
    const address = this.server?.address();
    return address && typeof address === "object" ? address.port : undefined;
  }

  async start(): Promise<void> {
    if (this.server) return;
    const server = createServer((request, response) => {
      void this.handleRequest(request, response).catch(() => {
        if (!response.headersSent) sendJson(response, 500, { error: "internal_error" });
        else response.end();
      });
    });
    server.on("clientError", (_error, socket) => socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.port, this.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.server = server;
    await this.loadBridgeSessionRoutes();
    this.controller.on("command", this.onCommand);
    this.controller.on("mobile-online", this.onMobileOnline);
    this.controller.on("history-request", this.onHistoryRequest);
    await this.refreshSessions();
    await this.hydrateBridgeActivities();
    await this.announcePendingCommands();
    this.publishTransportState();
    this.timer = setInterval(() => {
      this.expireWorkersAndLeases();
      void this.refreshSessions();
    }, this.pollIntervalMs);
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.controller.off("command", this.onCommand);
    this.controller.off("mobile-online", this.onMobileOnline);
    this.controller.off("history-request", this.onHistoryRequest);
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private readonly onCommand = (): void => {
    void this.refreshSessions().then(async () => {
      await this.announcePendingCommands();
    });
  };

  private readonly onMobileOnline = (): void => {
    this.published.clear();
    this.publishedCatalog = "";
    void this.refreshSessions().then(() => this.announcePendingCommands());
  };

  private readonly onHistoryRequest = (request: HistoryRequestPayload): void => {
    void this.publishHistory(request.sessionId);
  };

  private async loadBridgeSessionRoutes(): Promise<void> {
    if (!this.bridgeSessionsPath) return;
    try {
      const value = JSON.parse(await readFile(this.bridgeSessionsPath, "utf8")) as Partial<BridgeSessionRouteFile>;
      if (value.version !== 1 || !Array.isArray(value.sessions)) return;
      for (const route of value.sessions) {
        if (
          !route ||
          typeof route.sourceSessionId !== "string" ||
          typeof route.bridgeSessionId !== "string" ||
          typeof route.cwd !== "string" ||
          typeof route.updatedAt !== "number" ||
          typeof route.resumedFromSource !== "boolean"
        ) continue;
        this.bridgeSessionRoutes.set(route.sourceSessionId, route);
      }
    } catch {
      // A missing or damaged route cache only starts a fresh background continuation.
    }
  }

  private saveBridgeSessionRoutes(): Promise<void> {
    if (!this.bridgeSessionsPath) return Promise.resolve();
    const path = this.bridgeSessionsPath;
    const contents = `${JSON.stringify({
      version: 1,
      sessions: [...this.bridgeSessionRoutes.values()],
    } satisfies BridgeSessionRouteFile, null, 2)}\n`;
    this.savingRoutes = this.savingRoutes.catch(() => undefined).then(async () => {
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${process.pid}.tmp`;
      await writeFile(temporary, contents, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, path);
      await chmod(path, 0o600).catch(() => undefined);
    });
    return this.savingRoutes;
  }

  private expireWorkersAndLeases(): void {
    const now = Date.now();
    let changed = false;
    for (const [workerId, worker] of this.backgroundWorkers) {
      if (now - worker.lastSeenAt <= WORKER_TTL_MS) continue;
      this.backgroundWorkers.delete(workerId);
      changed = true;
    }
    for (const [commandId, lease] of this.commandLeases) {
      if (lease.expiresAt > now && this.backgroundWorkers.has(lease.workerId)) continue;
      this.commandLeases.delete(commandId);
      changed = true;
    }
    if (changed) this.publishTransportState();
  }

  private publishTransportState(): void {
    const workers = [...this.backgroundWorkers.values()];
    const working = this.commandLeases.size > 0;
    const ready = workers.find((worker) => worker.available && worker.authenticated);
    const installed = workers.find((worker) => worker.available);
    if (working && ready) {
      this.controller.setClaudeTransport({
        state: "working",
        detail: "Bridge 后台续写正在处理手机指令；结果会同步到手机和本应用，不会出现在当前 Claude Desktop 窗口。",
        lastSeenAt: ready.lastSeenAt,
        ...(ready.version ? { version: ready.version } : {}),
      });
      return;
    }
    if (ready) {
      this.controller.setClaudeTransport({
        state: "ready",
        detail: "Bridge 后台续写已就绪，不使用鼠标、键盘或剪贴板，也不会抢占 Claude Desktop。",
        lastSeenAt: ready.lastSeenAt,
        ...(ready.version ? { version: ready.version } : {}),
      });
      return;
    }
    if (installed) {
      this.controller.setClaudeTransport({
        state: "auth-required",
        detail: "未检测到 Claude Desktop 的第三方登录凭据。保持已登录的 Claude Desktop 运行，Bridge 会自动重连后台续写通道。",
        lastSeenAt: installed.lastSeenAt,
        ...(installed.version ? { version: installed.version } : {}),
      });
      return;
    }
    this.controller.setClaudeTransport({
      state: workers.length > 0 ? "unavailable" : "waiting",
      detail: workers.length > 0
        ? "未检测到可用的 Claude Code 运行时。"
        : "正在启动 Bridge 常驻后台续写通道。",
    });
  }

  private setActivity(activity: ClaudeBridgeActivity): void {
    this.controller.setClaudeActivity(activity);
  }

  private async hydrateBridgeActivities(): Promise<void> {
    if (this.activitiesHydrated) return;
    this.activitiesHydrated = true;
    for (const route of this.bridgeSessionRoutes.values()) {
      const history = await readClaudeSessionHistory(this.paths.projects, route.bridgeSessionId, route.cwd);
      let assistantIndex = -1;
      for (let index = history.messages.length - 1; index >= 0; index -= 1) {
        if (history.messages[index]?.role === "assistant") {
          assistantIndex = index;
          break;
        }
      }
      if (assistantIndex < 0) continue;
      let userIndex = -1;
      for (let index = assistantIndex - 1; index >= 0; index -= 1) {
        if (history.messages[index]?.role === "user") {
          userIndex = index;
          break;
        }
      }
      if (userIndex < 0) continue;
      const userMessage = history.messages[userIndex];
      const assistantMessage = history.messages[assistantIndex];
      if (!userMessage || !assistantMessage) continue;
      const session = this.deliverySession(route.sourceSessionId);
      const projectName = session?.projectName ?? compactText(basename(route.cwd) || route.cwd, 100);
      this.setActivity({
        id: `history:${route.sourceSessionId}`,
        sessionId: route.sourceSessionId,
        projectName,
        sessionTitle: session?.name ?? projectName,
        state: "completed",
        command: userMessage.text,
        summary: assistantMessage.text,
        updatedAt: Math.max(route.updatedAt, assistantMessage.createdAt),
      });
    }
  }

  private async refreshSessions(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.doRefreshSessions().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  private async doRefreshSessions(): Promise<void> {
    const desktopSessions = await listClaudeDesktopSessions(this.paths.desktopSessions);
    const sessions = await scanClaudeSessions(this.paths, this.processAlive, desktopSessions);
    this.sessions = sessions;
    this.sessionCatalog = buildClaudeSessionCatalog(desktopSessions, sessions);
    this.controller.setClaudeSessions(sessions);
    const knownIds = new Set(this.sessionCatalog.map((session) => session.sessionId));
    const defaultSessionId = sessions.find((session) => session.state === "running")?.sessionId
      ?? this.sessionCatalog[0]?.sessionId;
    this.controller.assignPendingCommands(defaultSessionId, knownIds);
    await this.publishSessionCatalog();

    const primarySessions = primaryProjectSessions(sessions);
    const primaryIds = new Set(primarySessions.map((session) => session.sessionId));
    for (const sessionId of this.published.keys()) {
      if (!primaryIds.has(sessionId)) this.published.delete(sessionId);
    }
    for (const session of primarySessions) {
      const fingerprint = sessionPublishFingerprint(session);
      if (this.published.get(session.sessionId) === fingerprint) continue;
      try {
        await this.controller.sendMobile(sessionStatusPayload(session));
        this.published.set(session.sessionId, fingerprint);
      } catch {
        // The relay reconnect loop will make the next poll retry this snapshot.
      }
    }
  }

  private async publishSessionCatalog(): Promise<void> {
    const sessions = this.sessionCatalog.map(({ cwd: _cwd, ...session }) => session);
    const fingerprint = JSON.stringify(sessions);
    if (fingerprint === this.publishedCatalog) return;
    try {
      await this.controller.sendMobile({ kind: "sessions", sessions });
      this.publishedCatalog = fingerprint;
    } catch {
      // Retry on the next observer poll after relay reconnection.
    }
  }

  private async publishHistory(sessionId: string): Promise<void> {
    await this.refreshSessions();
    const session = this.deliverySession(sessionId);
    const sourceHistory = session
      ? await readClaudeSessionHistory(this.paths.projects, session.sessionId, session.cwd)
      : { available: false, messages: [], truncated: false };
    const route = this.bridgeSessionRoutes.get(sessionId);
    const history = route && route.bridgeSessionId !== sessionId
      ? mergeHistories(
          sourceHistory,
          await readClaudeSessionHistory(this.paths.projects, route.bridgeSessionId, route.cwd),
        )
      : sourceHistory;
    try {
      await this.controller.sendMobile({
        kind: "history",
        sessionId,
        messages: history.messages,
        syncedAt: Date.now(),
        available: history.available,
        truncated: history.truncated,
      });
    } catch {
      // A fresh request after relay reconnection will retry this on-demand payload.
    }
  }

  private deliverySession(sessionId: string | undefined): ClaudeSessionSnapshot | undefined {
    const observed = this.sessions.find((session) => session.sessionId === sessionId);
    if (observed) return observed;
    const catalog = this.sessionCatalog.find((session) => session.sessionId === sessionId)
      ?? (!sessionId ? this.sessionCatalog[0] : undefined);
    if (!catalog) return undefined;
    return {
      sessionId: catalog.sessionId,
      ...(catalog.desktopSessionId ? { desktopSessionId: catalog.desktopSessionId } : {}),
      cwd: catalog.cwd,
      projectName: catalog.projectName,
      name: catalog.title,
      startedAt: catalog.lastActivityAt,
      lastActivityAt: catalog.lastActivityAt,
      state: catalog.state,
      completedTasks: catalog.completedTasks ?? 0,
      totalTasks: catalog.totalTasks ?? 0,
      pendingTasks: 0,
      ...(catalog.currentTask ? { currentTask: catalog.currentTask } : {}),
    };
  }

  private async announcePendingCommands(): Promise<void> {
    const commands = this.controller.peekPendingCommands(20);
    for (const command of commands) {
      if (this.announcedCommands.has(command.id)) continue;
      const session = this.deliverySession(command.targetSessionId);
      if (session) {
        this.setActivity({
          id: command.id,
          sessionId: session.sessionId,
          projectName: session.projectName,
          sessionTitle: session.name,
          state: "queued",
          command: command.text,
          updatedAt: Date.now(),
        });
      }
      try {
        await this.controller.sendMobile({
          kind: "status",
          step: session?.projectName ?? "Claude",
          message: session
            ? `指令已收到，已进入「${session.name}」的 Bridge 后台续写队列。`
            : "指令已收到，正在匹配可在 Bridge 后台续写的 Claude 历史。",
          level: "info",
          ...(session ? { sessionId: session.sessionId } : {}),
        });
        this.announcedCommands.add(command.id);
      } catch {
        return;
      }
    }
  }

  private registerWorker(body: Record<string, unknown>): BackgroundWorkerState | undefined {
    const workerId = workerIdFrom(body);
    if (!workerId) return undefined;
    const version = safeWorkerText(body.version, 100);
    const worker: BackgroundWorkerState = {
      workerId,
      available: body.available === true,
      authenticated: body.authenticated === true,
      lastSeenAt: Date.now(),
      ...(version ? { version } : {}),
    };
    this.backgroundWorkers.set(workerId, worker);
    if (worker.authenticated) {
      for (const [commandId, errorKind] of this.commandFailures) {
        if (errorKind === "auth-required") this.commandRetryAt.delete(commandId);
      }
    }
    this.publishTransportState();
    return worker;
  }

  private async handleWorkerLease(body: Record<string, unknown>, response: ServerResponse): Promise<void> {
    const worker = this.registerWorker(body);
    if (!worker) {
      sendJson(response, 400, { error: "invalid_worker" });
      return;
    }
    this.expireWorkersAndLeases();
    if (!worker.available || !worker.authenticated) {
      sendJson(response, 200, { lease: null });
      return;
    }
    await this.refreshSessions();
    const now = Date.now();
    const leasedSessions = new Set([...this.commandLeases.values()].map((lease) => lease.sourceSessionId));
    const command = this.controller.peekPendingCommands(100).find((candidate) => {
      if (this.commandLeases.has(candidate.id) || (this.commandRetryAt.get(candidate.id) ?? 0) > now) return false;
      const candidateSession = this.deliverySession(candidate.targetSessionId);
      return Boolean(candidateSession && !leasedSessions.has(candidateSession.sessionId));
    });
    const session = this.deliverySession(command?.targetSessionId);
    if (!command || !session) {
      sendJson(response, 200, { lease: null });
      return;
    }
    this.commandLeases.set(command.id, {
      workerId: worker.workerId,
      sourceSessionId: session.sessionId,
      expiresAt: now + LEASE_TTL_MS,
    });
    const route = this.bridgeSessionRoutes.get(session.sessionId);
    const lease: ClaudeWorkerLease = {
      commandId: command.id,
      text: command.text,
      sourceSessionId: session.sessionId,
      resumeSessionId: route?.bridgeSessionId ?? session.sessionId,
      cwd: route?.cwd ?? session.cwd,
      projectName: session.projectName,
      forkSession: session.state === "running" && (route?.bridgeSessionId ?? session.sessionId) === session.sessionId,
    };
    this.setActivity({
      id: command.id,
      sessionId: session.sessionId,
      projectName: session.projectName,
      sessionTitle: session.name,
      state: "working",
      command: command.text,
      updatedAt: Date.now(),
    });
    this.publishTransportState();
    void this.controller.sendMobile({
      kind: "status",
      step: session.projectName,
      message: "Bridge 已创建独立后台续写并开始处理；结果会回到这里，当前 Claude Desktop 窗口不会自动变化。",
      level: "info",
      sessionId: session.sessionId,
    }).catch(() => undefined);
    sendJson(response, 200, { lease });
  }

  private handleWorkerHeartbeat(body: Record<string, unknown>, response: ServerResponse): void {
    const workerId = workerIdFrom(body);
    const commandId = safeWorkerText(body.commandId, 100);
    const lease = commandId ? this.commandLeases.get(commandId) : undefined;
    const worker = workerId ? this.backgroundWorkers.get(workerId) : undefined;
    if (!workerId || !commandId || !lease || lease.workerId !== workerId || !worker) {
      sendJson(response, 409, { error: "lease_not_found" });
      return;
    }
    worker.lastSeenAt = Date.now();
    lease.expiresAt = Date.now() + LEASE_TTL_MS;
    sendJson(response, 200, { ok: true });
  }

  private async handleWorkerResult(body: Record<string, unknown>, response: ServerResponse): Promise<void> {
    const workerId = workerIdFrom(body);
    const commandId = safeWorkerText(body.commandId, 100);
    const lease = commandId ? this.commandLeases.get(commandId) : undefined;
    if (!workerId || !commandId || !lease || lease.workerId !== workerId) {
      sendJson(response, 409, { error: "lease_not_found" });
      return;
    }
    const command = this.controller.peekPendingCommands(100).find((candidate) => candidate.id === commandId);
    this.commandLeases.delete(commandId);
    if (!command) {
      this.publishTransportState();
      sendJson(response, 200, { ok: true, alreadyCompleted: true });
      return;
    }
    const session = this.deliverySession(command.targetSessionId);
    if (body.ok === true && session) {
      const resultSessionId = safeWorkerText(body.sessionId, 128) ?? session.sessionId;
      this.bridgeSessionRoutes.set(session.sessionId, {
        sourceSessionId: session.sessionId,
        bridgeSessionId: resultSessionId,
        cwd: session.cwd,
        updatedAt: Date.now(),
        resumedFromSource: body.resumedFromSource !== false,
      });
      await this.saveBridgeSessionRoutes().catch(() => undefined);
      const acknowledged = this.controller.ackPendingCommands([command.id]);
      this.announcedCommands.delete(command.id);
      this.commandRetryAt.delete(command.id);
      this.commandFailures.delete(command.id);
      if (acknowledged.length > 0) {
        const summary = safeWorkerText(body.summary, 8_000) ?? "Claude 已完成这条指令。";
        this.setActivity({
          id: command.id,
          sessionId: session.sessionId,
          projectName: session.projectName,
          sessionTitle: session.name,
          state: "completed",
          command: command.text,
          summary,
          updatedAt: Date.now(),
        });
        await this.controller.sendMobile({
          kind: "completion",
          summary,
          sessionId: session.sessionId,
        }).catch(() => undefined);
        setTimeout(() => { void this.publishHistory(session.sessionId); }, 500);
      }
      this.publishTransportState();
      sendJson(response, 200, { ok: true });
      return;
    }

    const allowedErrors = new Set<ClaudeWorkerErrorKind>([
      "auth-required",
      "session-not-found",
      "permission-denied",
      "timeout",
      "unavailable",
      "failed",
    ]);
    const errorKind = allowedErrors.has(body.errorKind as ClaudeWorkerErrorKind)
      ? body.errorKind as ClaudeWorkerErrorKind
      : "failed";
    this.commandRetryAt.set(command.id, Date.now() + (
      errorKind === "auth-required" ? 5 * 60_000 : COMMAND_RETRY_DELAY_MS
    ));
    if (errorKind === "auth-required") {
      const worker = this.backgroundWorkers.get(workerId);
      if (worker) worker.authenticated = false;
    }
    if (this.commandFailures.get(command.id) !== errorKind) {
      this.commandFailures.set(command.id, errorKind);
      const message = errorKind === "auth-required"
        ? "Claude Desktop 第三方通道暂不可用，指令已安全保留；通道恢复后会自动继续。"
        : errorKind === "permission-denied"
          ? "Claude 后台执行受到权限限制，指令已保留，未触碰电脑前台。"
          : errorKind === "timeout"
            ? "Claude 后台处理超时，指令仍在队列中，稍后会重试。"
            : "Claude 后台执行暂时失败，指令已保留且不会转发到其他窗口。";
      if (session) {
        this.setActivity({
          id: command.id,
          sessionId: session.sessionId,
          projectName: session.projectName,
          sessionTitle: session.name,
          state: "retrying",
          command: command.text,
          summary: message,
          updatedAt: Date.now(),
        });
      }
      await this.controller.sendMobile({
        kind: "status",
        step: session?.projectName ?? "Claude",
        message,
        level: "warning",
        ...(session ? { sessionId: session.sessionId } : {}),
      }).catch(() => undefined);
    }
    this.publishTransportState();
    sendJson(response, 200, { ok: false, retained: true });
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", `http://${this.host}:${this.port}`);
    if (request.method === "GET" && url.pathname === "/health") {
      const now = Date.now();
      const backgroundWorkers = [...this.backgroundWorkers.values()]
        .filter((worker) => now - worker.lastSeenAt <= WORKER_TTL_MS);
      sendJson(response, 200, {
        ok: true,
        service: "claude-bridge-local",
        activeSessions: this.sessions.length,
        backgroundWorkers: backgroundWorkers.length,
        availableWorkers: backgroundWorkers.filter((worker) => worker.available).length,
        authenticatedWorkers: backgroundWorkers.filter((worker) => worker.available && worker.authenticated).length,
        inFlightCommands: this.commandLeases.size,
      });
      return;
    }
    if (!authorized(request, this.authorization)) {
      sendJson(response, 401, { error: "unauthorized" });
      return;
    }
    if (request.method === "GET" && url.pathname === "/state") {
      sendJson(response, 200, {
        sessions: this.sessions,
        pendingCommands: this.controller.peekPendingCommands(100).length,
      });
      return;
    }
    if (request.method !== "POST") {
      sendJson(response, 404, { error: "not_found" });
      return;
    }
    if (url.pathname === "/hooks/claude") {
      await this.handleClaudeHook(request, response);
      return;
    }
    if (url.pathname === "/workers/lease") {
      await this.handleWorkerLease(await readRequestJson(request), response);
      return;
    }
    if (url.pathname === "/workers/heartbeat") {
      this.handleWorkerHeartbeat(await readRequestJson(request), response);
      return;
    }
    if (url.pathname === "/workers/result") {
      await this.handleWorkerResult(await readRequestJson(request), response);
      return;
    }
    sendJson(response, 404, { error: "not_found" });
  }

  private async handleClaudeHook(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const input = await readRequestJson(request) as ClaudeHookInput;
    const sessionId = typeof input.session_id === "string" ? input.session_id : undefined;
    await this.refreshSessions();
    const session = this.sessions.find((candidate) => candidate.sessionId === sessionId);
    const projectName = session?.projectName
      ?? (typeof input.cwd === "string" ? compactText(basename(input.cwd) || input.cwd, 100) : "当前项目");
    await this.publishHookNotice(input, projectName, sessionId);
    // Hooks are observation-only. Phone commands are executed by the background worker,
    // never injected into the foreground Claude process or its current prompt.
    sendJson(response, 200, {});
  }

  private async publishHookNotice(
    input: ClaudeHookInput,
    projectName: string,
    sessionId: string | undefined,
  ): Promise<void> {
    const eventName = typeof input.hook_event_name === "string" ? input.hook_event_name : "";
    if (
      eventName === "PostToolUse" &&
      input.tool_name === "mcp__claude-bridge__bridge_send_update" &&
      sessionId
    ) {
      this.sessionsUpdatedViaBridge.add(sessionId);
    }
    if (eventName === "Stop" && sessionId && this.sessionsUpdatedViaBridge.delete(sessionId)) return;
    const identity = String(
      input.tool_use_id
      ?? input.notification_type
      ?? input.prompt_id
      ?? input.last_assistant_message
      ?? "",
    );
    const digest = createHash("sha256").update(identity).digest("hex").slice(0, 16);
    const eventKey = `${sessionId}:${eventName}:${digest}`;
    if (this.hookAnnouncements.has(eventKey)) return;
    const payload = hookStatusPayload(input, projectName);
    if (!payload) return;
    try {
      await this.controller.sendMobile({ ...payload, ...(sessionId ? { sessionId } : {}) });
      this.hookAnnouncements.add(eventKey);
    } catch {
      // Session snapshots will retry independently after relay reconnection.
    }
  }

}
