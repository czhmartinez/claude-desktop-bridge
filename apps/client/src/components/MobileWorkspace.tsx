import type {
  BridgeAttachment,
  BridgeDeliveryState,
  BridgeEvent,
  BridgeHistoryItem,
  BridgeHostSnapshot,
  BridgePermissionInfo,
  BridgeSessionConfiguration,
  BridgeSessionInfo,
  BridgeTransportMetrics,
  ClaudeDesktopAppStatus,
  SocketState,
} from "@bridge/protocol";
import { isClaudeTranscriptControlMessage } from "@bridge/protocol";
import {
  AlertTriangle,
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  ChevronsDown,
  ChevronsUp,
  CircleStop,
  FilePenLine,
  ImagePlus,
  LoaderCircle,
  Moon,
  Play,
  Plus,
  Power,
  RefreshCw,
  Search,
  Send,
  Settings2,
  Sun,
  Terminal,
  Wrench,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  LocalTurn,
  MobileConnectionIssue,
  SessionHistoryState,
} from "../hooks/useMobileBridge.js";
import type { Theme } from "../hooks/useTheme.js";
import {
  collapseProjects,
  expandAllProjects,
  expandProject,
  toggleCollapsedProject,
} from "../lib/project-groups.js";
import { registerMobileBackHandler } from "../lib/mobile-back-navigation.js";
import { ConfirmationDialog } from "./ConfirmationDialog.js";
import { IconButton } from "./IconButton.js";
import {
  SessionConfigurationDialog,
  type SessionConfigurationChange,
} from "./SessionConfigurationDialog.js";

interface ConversationItem extends BridgeHistoryItem {
  delivery?: BridgeDeliveryState;
  requestId?: string;
  commandId?: string;
  live?: boolean;
}

function formatTime(value: number): string {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(value);
}

function relativeTime(value: number): string {
  const elapsed = Math.max(0, Date.now() - value);
  if (elapsed < 60_000) return "刚刚";
  if (elapsed < 60 * 60_000) return `${Math.floor(elapsed / 60_000)} 分钟前`;
  if (elapsed < 24 * 60 * 60_000) return `${Math.floor(elapsed / 3_600_000)} 小时前`;
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(value);
}

function mobileConnectionLabel(
  connection: SocketState,
  desktopOnline: boolean,
  metrics: BridgeTransportMetrics | undefined,
  version: string | undefined,
): string {
  if (version?.startsWith("0.2.")) return "需要升级";
  if (connection === "connecting" || connection === "reconnecting") return "正在重连";
  if (connection !== "connected" || !desktopOnline) return "主机离线";
  if (metrics?.path === "direct") return "直连";
  if (metrics?.path === "public-relay") return "安全中继";
  return "局域网连接";
}

function ownershipLabel(session: BridgeSessionInfo): string {
  if (session.ownership === "OWNERSHIP_CONFLICT") return "写入冲突";
  if (session.ownership === "FALLBACK_CONFIRMATION_REQUIRED") return "等待接管";
  if (session.turnState === "running") return "运行中";
  if (session.turnState === "queued") return `${session.pendingCount} 条排队`;
  if (session.turnState === "waiting") return "需处理";
  if (session.transport === "claude-desktop-managed") return "Claude Desktop 同步";
  if (session.ownership === "DESKTOP_OBSERVED") return "桌面待机";
  return "待机";
}

function deliveryLabel(state: BridgeDeliveryState): string {
  if (state === "local-saved") return "已保存到手机";
  if (state === "relay-received") return "Relay 已接收";
  if (state === "host-received") return "主机已接收";
  if (state === "session-received") return "会话已接收";
  if (state === "running") return "Claude 处理中";
  if (state === "completed") return "已完成";
  if (state === "failed") return "发送失败";
  if (state === "uncertain") return "发送结果待确认";
  return "已取消";
}

function eventText(event: BridgeEvent): string {
  if (typeof event.data.text === "string") return event.data.text;
  if (typeof event.data.summary === "string") return event.data.summary;
  if (typeof event.data.error === "string") return event.data.error;
  return "";
}

export function conversationItems(
  sessionId: string,
  history: SessionHistoryState | undefined,
  events: BridgeEvent[],
  localTurns: LocalTurn[],
): ConversationItem[] {
  const items = new Map<string, ConversationItem>();
  for (const item of history?.items ?? []) {
    if (
      (item.role === "user" || item.role === "assistant") &&
      isClaudeTranscriptControlMessage(item.role, item.text)
    ) continue;
    items.set(item.id, item);
  }
  const sessionEvents = events.filter((event) => event.sessionId === sessionId);
  const acceptedRequests = new Set(
    sessionEvents
      .filter((event) => event.type === "user.message.accepted" && typeof event.data.requestId === "string")
      .map((event) => event.data.requestId as string),
  );
  for (const turn of localTurns.filter((candidate) => candidate.sessionId === sessionId)) {
    if (acceptedRequests.has(turn.requestId)) continue;
    items.set(`local:${turn.requestId}`, {
      id: `local:${turn.requestId}`,
      sessionId,
      role: "user",
      text: turn.text,
      createdAt: turn.createdAt,
      origin: "mobile",
      attachments: turn.attachments,
      delivery: turn.delivery,
      requestId: turn.requestId,
      ...(turn.commandId ? { commandId: turn.commandId } : {}),
    });
  }
  const completedTurns = new Set(
    sessionEvents
      .filter((event) => event.type === "assistant.completed" && event.turnId)
      .map((event) => event.turnId!),
  );
  const deltaByItem = new Map<string, ConversationItem>();
  const toolByItem = new Map<string, ConversationItem>();
  for (const event of sessionEvents) {
    if (event.type === "session.observed") {
      const role = event.data.role;
      const text = eventText(event);
      if (
        (role === "user" || role === "assistant") &&
        text &&
        !isClaudeTranscriptControlMessage(role, text)
      ) {
        items.set(event.itemId ?? event.eventId, {
          id: event.itemId ?? event.eventId,
          sessionId,
          ...(event.turnId ? { turnId: event.turnId } : {}),
          role,
          text,
          createdAt: event.timestamp,
          origin: event.origin,
        });
      }
    }
    if (event.type === "user.message.accepted") {
      const text = eventText(event);
      const attachments = Array.isArray(event.data.attachments)
        ? event.data.attachments as ConversationItem["attachments"]
        : undefined;
      items.set(event.itemId ?? event.eventId, {
        id: event.itemId ?? event.eventId,
        sessionId,
        ...(event.turnId ? { turnId: event.turnId } : {}),
        role: "user",
        text,
        createdAt: event.timestamp,
        origin: event.origin,
        delivery: "session-received",
        ...(attachments?.length ? { attachments } : {}),
        ...(typeof event.data.requestId === "string" ? { requestId: event.data.requestId } : {}),
      });
    }
    if (event.type === "assistant.delta" && !(event.turnId && completedTurns.has(event.turnId))) {
      const id = event.itemId ?? event.eventId;
      const existing = deltaByItem.get(id);
      const text = `${existing?.text ?? ""}${eventText(event)}`;
      deltaByItem.set(id, {
        id,
        sessionId,
        ...(event.turnId ? { turnId: event.turnId } : {}),
        role: "assistant",
        text,
        createdAt: existing?.createdAt ?? event.timestamp,
        origin: "claude-host",
        live: true,
      });
    }
    if (event.type === "assistant.completed") {
      const text = eventText(event);
      if (!text) continue;
      items.set(event.itemId ?? event.eventId, {
        id: event.itemId ?? event.eventId,
        sessionId,
        ...(event.turnId ? { turnId: event.turnId } : {}),
        role: "assistant",
        text,
        createdAt: event.timestamp,
        origin: "claude-host",
      });
    }
    if (event.type === "tool.started" || event.type === "tool.progress" || event.type === "tool.completed") {
      const id = event.itemId ?? event.eventId;
      const existing = toolByItem.get(id);
      const toolName = typeof event.data.toolName === "string"
        ? event.data.toolName
        : existing?.toolName ?? "工具";
      const text = eventText(event) || existing?.text || toolName;
      toolByItem.set(id, {
        id: `tool:${id}`,
        sessionId,
        ...(event.turnId ? { turnId: event.turnId } : {}),
        role: "tool",
        toolName,
        text,
        createdAt: existing?.createdAt ?? event.timestamp,
        origin: "claude-host",
        state: event.type === "tool.completed" ? "completed" : "running",
      });
    }
    if (event.type === "turn.failed" || event.type === "turn.interrupted") {
      items.set(event.eventId, {
        id: event.eventId,
        sessionId,
        ...(event.turnId ? { turnId: event.turnId } : {}),
        role: "system",
        text: event.type === "turn.failed" ? eventText(event) || "Claude 处理失败" : "任务已停止",
        createdAt: event.timestamp,
        origin: "system",
        state: event.type === "turn.failed" ? "failed" : "interrupted",
      });
    }
    if (event.type === "permission.resolved" || event.type === "question.resolved") {
      const resolver = typeof event.data.resolvedByName === "string"
        ? event.data.resolvedByName
        : "另一台设备";
      const decision = event.data.decision;
      const outcome = event.type === "question.resolved"
        ? decision === "deny" ? "取消了回答" : "提交了回答"
        : decision === "deny"
          ? "拒绝了授权"
          : decision === "allow-always"
            ? "设为始终允许"
            : "允许了这一次操作";
      items.set(event.eventId, {
        id: event.eventId,
        sessionId,
        role: "system",
        text: `${resolver}${outcome}`,
        createdAt: event.timestamp,
        origin: "system",
      });
    }
  }
  for (const item of deltaByItem.values()) items.set(item.id, item);
  for (const item of toolByItem.values()) items.set(item.id, item);
  return [...items.values()].sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
}

export async function fileToAttachment(file: File): Promise<BridgeAttachment> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result)));
    reader.addEventListener("error", () => reject(reader.error ?? new Error("图片读取失败")));
    reader.readAsDataURL(file);
  });
  const data = dataUrl.slice(dataUrl.indexOf(",") + 1);
  return {
    id: crypto.randomUUID(),
    name: file.name,
    mimeType: file.type as BridgeAttachment["mimeType"],
    size: file.size,
    data,
  };
}

interface PermissionFact {
  label: string;
  value: string;
  code?: boolean;
}

export interface PermissionPresentation {
  summary: string;
  facts: PermissionFact[];
  preview?: {
    label: string;
    value: string;
  };
  raw: string;
  mutating: boolean;
}

function inputText(input: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n… 已省略 ${value.length - max} 个字符`;
}

export function permissionPresentation(permission: BridgePermissionInfo): PermissionPresentation {
  const tool = permission.toolName.toLocaleLowerCase();
  const mutating = /(write|edit|bash|delete|remove|move|notebook)/u.test(tool);
  const facts: PermissionFact[] = [];
  const path = inputText(permission.input, "file_path", "path", "notebook_path");
  const command = inputText(permission.input, "command");
  const cwd = inputText(permission.input, "cwd", "working_directory");
  const url = inputText(permission.input, "url");
  const query = inputText(permission.input, "query", "pattern");
  if (path) facts.push({ label: "目标", value: path, code: true });
  if (command) facts.push({ label: "命令", value: truncate(command, 600), code: true });
  if (cwd) facts.push({ label: "目录", value: cwd, code: true });
  if (url) facts.push({ label: "地址", value: url, code: true });
  if (query) facts.push({ label: "查询", value: truncate(query, 300) });

  const ignored = new Set([
    "file_path",
    "path",
    "notebook_path",
    "command",
    "cwd",
    "working_directory",
    "url",
    "query",
    "pattern",
    "content",
    "old_string",
    "new_string",
  ]);
  for (const [key, value] of Object.entries(permission.input)) {
    if (facts.length >= 5 || ignored.has(key)) continue;
    if (typeof value === "string" && value.trim()) {
      facts.push({ label: key, value: truncate(value.trim(), 240) });
    } else if (typeof value === "number" || typeof value === "boolean") {
      facts.push({ label: key, value: String(value) });
    }
  }

  const content = inputText(permission.input, "content", "new_string");
  const oldContent = inputText(permission.input, "old_string");
  const preview = content
    ? { label: oldContent ? "变更后预览" : "内容预览", value: truncate(content, 1_200) }
    : oldContent
      ? { label: "待替换内容", value: truncate(oldContent, 1_200) }
      : undefined;
  const serialized = JSON.stringify(permission.input, null, 2);
  return {
    summary: permission.description
      || permission.displayName
      || (mutating ? "这项操作会修改电脑上的项目内容" : "Claude 需要确认后才能继续"),
    facts,
    ...(preview ? { preview } : {}),
    raw: truncate(serialized, 4_000),
    mutating,
  };
}

function QuestionPrompt({
  permission,
  onResolve,
}: {
  permission: BridgePermissionInfo;
  onResolve(
    requestId: string,
    decision: "allow-once" | "allow-always" | "deny",
    message?: string,
    updatedInput?: Record<string, unknown>,
  ): Promise<void>;
}) {
  const questions = Array.isArray(permission.input.questions)
    ? permission.input.questions.filter((question): question is Record<string, unknown> => (
        Boolean(question) && typeof question === "object"
      ))
    : [];
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const complete = questions.every((question) => (
    typeof question.question === "string" && Boolean(answers[question.question])
  ));
  async function resolveQuestion(
    decision: "allow-once" | "deny",
    updatedInput?: Record<string, unknown>,
  ): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await onResolve(permission.requestId, decision, undefined, updatedInput);
    } catch (resolveError) {
      setError(resolveError instanceof Error ? resolveError.message : "回答提交失败");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="permission-prompt question-prompt">
      <div className="permission-title">
        <strong>{permission.title || "Claude 需要你的选择"}</strong>
        <span>任一已授权设备的首次回答生效</span>
      </div>
      {error && <div className="permission-error" role="alert">{error}</div>}
      {questions.map((question, index) => {
        const prompt = typeof question.question === "string" ? question.question : `问题 ${index + 1}`;
        const options = Array.isArray(question.options)
          ? question.options.filter((option): option is Record<string, unknown> => Boolean(option) && typeof option === "object")
          : [];
        return (
          <fieldset key={prompt}>
            <legend>{prompt}</legend>
            {options.map((option) => {
              const label = typeof option.label === "string" ? option.label : "";
              return (
                <label key={label} className="question-option">
                  <input
                    type="radio"
                    name={`${permission.requestId}:${index}`}
                    checked={answers[prompt] === label}
                    onChange={() => setAnswers((current) => ({ ...current, [prompt]: label }))}
                  />
                  <span><strong>{label}</strong>{typeof option.description === "string" && <small>{option.description}</small>}</span>
                </label>
              );
            })}
          </fieldset>
        );
      })}
      <div className="permission-actions">
        <button type="button" className="secondary-button" disabled={busy} onClick={() => void resolveQuestion("deny")}>取消</button>
        <button
          type="button"
          className="primary-button"
          disabled={!complete || busy}
          onClick={() => void resolveQuestion(
            "allow-once",
            { ...permission.input, answers },
          )}
        >
          {busy && <LoaderCircle className="is-spinning" size={15} />}提交回答
        </button>
      </div>
    </section>
  );
}

function ToolPermissionPrompt({
  permission,
  onResolve,
}: {
  permission: BridgePermissionInfo;
  onResolve(
    requestId: string,
    decision: "allow-once" | "allow-always" | "deny",
    message?: string,
    updatedInput?: Record<string, unknown>,
  ): Promise<void>;
}) {
  const presentation = permissionPresentation(permission);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function decide(decision: "allow-once" | "allow-always" | "deny"): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await onResolve(permission.requestId, decision);
    } catch (resolveError) {
      setError(resolveError instanceof Error ? resolveError.message : "授权处理失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="permission-prompt">
      <div className="permission-title">
        <strong>{permission.title || `${permission.toolName} 请求权限`}</strong>
        <span>{presentation.summary}</span>
      </div>
      <div className={`permission-risk ${presentation.mutating ? "mutating" : ""}`}>
        {presentation.mutating ? <AlertTriangle size={16} /> : <Wrench size={16} />}
        <span>{presentation.mutating ? "操作前请核对目标与内容" : "Claude 正在等待你的确认"}</span>
      </div>
      {presentation.facts.length > 0 && (
        <dl className="permission-facts">
          {presentation.facts.map((fact) => (
            <div key={`${fact.label}:${fact.value}`}>
              <dt>{fact.label}</dt>
              <dd className={fact.code ? "is-code" : ""}>{fact.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {presentation.preview && (
        <details className="permission-details">
          <summary><FilePenLine size={15} />{presentation.preview.label}</summary>
          <pre>{presentation.preview.value}</pre>
        </details>
      )}
      <details className="permission-details raw-details">
        <summary><Terminal size={15} />查看完整参数</summary>
        <pre>{presentation.raw}</pre>
      </details>
      {error && <div className="permission-error" role="alert">{error}</div>}
      <div className="permission-actions">
        <button type="button" className="secondary-button danger-text" disabled={busy} onClick={() => void decide("deny")}>拒绝</button>
        <button type="button" className="primary-button" disabled={busy} onClick={() => void decide("allow-once")}>
          {busy && <LoaderCircle className="is-spinning" size={15} />}允许一次
        </button>
        {permission.canAllowAlways && (
          <button type="button" className="secondary-button" disabled={busy} onClick={() => void decide("allow-always")}>始终允许</button>
        )}
      </div>
    </section>
  );
}

export function PermissionPrompt({
  permission,
  onResolve,
}: {
  permission: BridgePermissionInfo;
  onResolve(
    requestId: string,
    decision: "allow-once" | "allow-always" | "deny",
    message?: string,
    updatedInput?: Record<string, unknown>,
  ): Promise<void>;
}) {
  return permission.toolName === "AskUserQuestion"
    ? <QuestionPrompt permission={permission} onResolve={onResolve} />
    : <ToolPermissionPrompt permission={permission} onResolve={onResolve} />;
}

export function MobileWorkspace({
  desktopName,
  connection,
  desktopOnline,
  snapshot,
  permissions,
  focusSessionId,
  histories,
  events,
  localTurns,
  connectionIssue,
  transportMetrics,
  pendingOutbound,
  theme,
  onToggleTheme,
  onOpenSession,
  onLoadOlderHistory,
  onSendTurn,
  onInterruptTurn,
  onResolveUncertain,
  onResolvePermission,
  onCreateSession,
  onLoadSessionConfiguration,
  onConfigureSession,
  onClaudeDesktopLaunch,
  onClaudeDesktopQuit,
  onRefresh,
  onBackToHosts,
  onRetry,
}: {
  desktopName: string;
  connection: SocketState;
  desktopOnline: boolean;
  snapshot: BridgeHostSnapshot | undefined;
  permissions: BridgePermissionInfo[];
  focusSessionId?: string | undefined;
  histories: Record<string, SessionHistoryState>;
  events: BridgeEvent[];
  localTurns: LocalTurn[];
  connectionIssue?: MobileConnectionIssue | undefined;
  transportMetrics?: BridgeTransportMetrics | undefined;
  pendingOutbound: number;
  theme: Theme;
  onToggleTheme(): void;
  onOpenSession(sessionId: string): Promise<void>;
  onLoadOlderHistory(sessionId: string): Promise<void>;
  onSendTurn(sessionId: string, text: string, attachments: BridgeAttachment[], steer: boolean): Promise<void>;
  onInterruptTurn(sessionId: string, commandId?: string): Promise<void>;
  onResolveUncertain(commandId: string, action: "confirm" | "retry"): Promise<void>;
  onResolvePermission(
    requestId: string,
    decision: "allow-once" | "allow-always" | "deny",
    message?: string,
    updatedInput?: Record<string, unknown>,
  ): Promise<void>;
  onCreateSession(cwd: string, title?: string): Promise<BridgeSessionInfo | undefined>;
  onLoadSessionConfiguration(sessionId: string): Promise<BridgeSessionConfiguration>;
  onConfigureSession(
    sessionId: string,
    change: SessionConfigurationChange,
  ): Promise<BridgeSessionConfiguration>;
  onClaudeDesktopLaunch(): Promise<ClaudeDesktopAppStatus>;
  onClaudeDesktopQuit(): Promise<ClaudeDesktopAppStatus>;
  onRefresh(): Promise<void>;
  onBackToHosts(): void;
  onRetry(): Promise<void>;
}) {
  const [selectedSessionId, setSelectedSessionId] = useState<string>();
  const [search, setSearch] = useState("");
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<BridgeAttachment[]>([]);
  const [sending, setSending] = useState(false);
  const [steer, setSteer] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createProjectId, setCreateProjectId] = useState("");
  const [createTitle, setCreateTitle] = useState("");
  const [createBusy, setCreateBusy] = useState(false);
  const [configurationOpen, setConfigurationOpen] = useState(false);
  const [imageError, setImageError] = useState<string>();
  const [permissionOpen, setPermissionOpen] = useState(false);
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<Set<string>>(() => new Set());
  const [desktopAction, setDesktopAction] = useState<"launch" | "quit">();
  const [desktopActionError, setDesktopActionError] = useState("");
  const [quitDesktopOpen, setQuitDesktopOpen] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const handledFocusRef = useRef<string | undefined>(undefined);
  const announcedPermissionsRef = useRef(new Set<string>());

  const sessions = snapshot?.sessions ?? [];
  const selectedSession = sessions.find((session) => session.sessionId === selectedSessionId);
  const selectedHistory = selectedSessionId ? histories[selectedSessionId] : undefined;
  const items = useMemo(
    () => selectedSessionId
      ? conversationItems(selectedSessionId, selectedHistory, events, localTurns)
      : [],
    [events, localTurns, selectedHistory, selectedSessionId],
  );
  const grouped = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    const filtered = sessions.filter((session) => !query || (
      `${session.title}\n${session.projectName}\n${session.cwd}`.toLocaleLowerCase().includes(query)
    ));
    const groups = new Map<string, BridgeSessionInfo[]>();
    for (const session of filtered) {
      const list = groups.get(session.projectId) ?? [];
      list.push(session);
      groups.set(session.projectId, list);
    }
    return [...groups.entries()].map(([projectId, projectSessions]) => ({
      project: snapshot?.projects.find((project) => project.projectId === projectId),
      sessions: projectSessions,
    }));
  }, [search, sessions, snapshot?.projects]);
  const groupedProjectIds = useMemo(
    () => grouped.map((group) => group.project?.projectId ?? group.sessions[0]!.projectId),
    [grouped],
  );
  const allProjectsCollapsed = groupedProjectIds.length > 0
    && groupedProjectIds.every((projectId) => collapsedProjectIds.has(projectId));
  const allProjectsExpanded = groupedProjectIds.length > 0
    && groupedProjectIds.every((projectId) => !collapsedProjectIds.has(projectId));

  useEffect(() => registerMobileBackHandler(() => {
    if (permissionOpen) {
      setPermissionOpen(false);
      return true;
    }
    if (configurationOpen) {
      setConfigurationOpen(false);
      return true;
    }
    if (createOpen) {
      setCreateOpen(false);
      return true;
    }
    if (quitDesktopOpen) {
      setQuitDesktopOpen(false);
      return true;
    }
    if (selectedSessionId) {
      setSelectedSessionId(undefined);
      return true;
    }
    return false;
  }, 100), [
    configurationOpen,
    createOpen,
    permissionOpen,
    quitDesktopOpen,
    selectedSessionId,
  ]);

  useEffect(() => {
    if (!selectedSessionId) return;
    endRef.current?.scrollIntoView({ block: "end" });
  }, [items.length, selectedSessionId]);

  useEffect(() => {
    if (search.trim()) setCollapsedProjectIds(new Set());
  }, [search]);

  useEffect(() => {
    if (
      !focusSessionId ||
      handledFocusRef.current === focusSessionId ||
      !sessions.some((session) => session.sessionId === focusSessionId)
    ) return;
    handledFocusRef.current = focusSessionId;
    void selectSession(focusSessionId).then(() => setPermissionOpen(true));
  }, [focusSessionId, sessions]);

  useEffect(() => {
    if (!selectedSessionId) return;
    const next = permissions.find((permission) => (
      permission.sessionId === selectedSessionId &&
      !announcedPermissionsRef.current.has(permission.requestId)
    ));
    if (!next) return;
    announcedPermissionsRef.current.add(next.requestId);
    setPermissionOpen(true);
  }, [permissions, selectedSessionId]);

  useEffect(() => {
    if (
      permissionOpen &&
      selectedSessionId &&
      !permissions.some((permission) => permission.sessionId === selectedSessionId)
    ) {
      setPermissionOpen(false);
    }
  }, [permissionOpen, permissions, selectedSessionId]);

  async function selectSession(sessionId: string): Promise<void> {
    setConfigurationOpen(false);
    setSelectedSessionId(sessionId);
    await onOpenSession(sessionId);
  }

  function toggleProject(projectId: string): void {
    setCollapsedProjectIds((current) => toggleCollapsedProject(current, projectId));
  }

  async function runClaudeDesktopAction(action: "launch" | "quit"): Promise<void> {
    if (desktopAction) return;
    if (action === "quit") setQuitDesktopOpen(false);
    setDesktopAction(action);
    setDesktopActionError("");
    try {
      if (action === "launch") await onClaudeDesktopLaunch();
      else await onClaudeDesktopQuit();
    } catch (error) {
      setDesktopActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setDesktopAction(undefined);
    }
  }

  async function sendMessage(): Promise<void> {
    if (!selectedSession || sending || (!text.trim() && attachments.length === 0)) return;
    const nextText = text.trim();
    const nextAttachments = attachments;
    setText("");
    setAttachments([]);
    setSending(true);
    try {
      await onSendTurn(selectedSession.sessionId, nextText, nextAttachments, steer);
      setSteer(false);
    } catch {
      setText(nextText);
      setAttachments(nextAttachments);
    } finally {
      setSending(false);
    }
  }

  async function addImages(files: FileList | null): Promise<void> {
    if (!files?.length) return;
    setImageError(undefined);
    try {
      const candidates = [...files];
      if (candidates.some((file) => file.size > 4 * 1024 * 1024)) throw new Error("单张图片不能超过 4 MB");
      const total = candidates.reduce((sum, file) => sum + file.size, attachments.reduce((sum, item) => sum + item.size, 0));
      if (total > 6 * 1024 * 1024) throw new Error("图片总大小不能超过 6 MB");
      const next = await Promise.all(candidates.map(fileToAttachment));
      setAttachments((current) => [...current, ...next].slice(0, 4));
    } catch (error) {
      setImageError(error instanceof Error ? error.message : "图片读取失败");
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function createSession(): Promise<void> {
    const project = snapshot?.projects.find((candidate) => candidate.projectId === createProjectId);
    if (!project || createBusy) return;
    setCreateBusy(true);
    try {
      const created = await onCreateSession(project.cwd, createTitle.trim() || undefined);
      if (created) {
        setCreateOpen(false);
        setCreateTitle("");
        setCollapsedProjectIds((current) => expandProject(current, created.projectId));
        await onRefresh();
        await selectSession(created.sessionId);
      }
    } finally {
      setCreateBusy(false);
    }
  }

  if (selectedSession) {
    const bridgeRunning = selectedSession.turnState === "running"
      && (
        selectedSession.ownership === "BRIDGE_RUNNING" ||
        selectedSession.ownership === "DESKTOP_MANAGED_RUNNING"
      );
    const activeTurn = localTurns
      .filter((turn) => turn.sessionId === selectedSession.sessionId && turn.delivery === "running")
      .at(-1);
    const sessionPermissions = permissions.filter((permission) => permission.sessionId === selectedSession.sessionId);
    const activePermission = sessionPermissions[0];
    const otherPermission = permissions.find((permission) => permission.sessionId !== selectedSession.sessionId);
    const otherPermissionSession = otherPermission
      ? sessions.find((session) => session.sessionId === otherPermission.sessionId)
      : undefined;
    return (
      <main className="mobile-workspace conversation-workspace">
        <header className="mobile-topbar conversation-topbar">
          <IconButton label="返回会话列表" onClick={() => setSelectedSessionId(undefined)}><ArrowLeft size={21} /></IconButton>
          <div className="mobile-device">
            <strong>{selectedSession.title}</strong>
            <span className={`session-presence ${selectedSession.turnState}`}>
              <i />{ownershipLabel(selectedSession)}
            </span>
          </div>
          <div className="topbar-actions">
            <IconButton label="模型与 Effort" onClick={() => setConfigurationOpen(true)}>
              <Settings2 size={19} />
            </IconButton>
            {bridgeRunning ? (
              <IconButton label="停止任务" onClick={() => void onInterruptTurn(selectedSession.sessionId, activeTurn?.commandId)}>
                <CircleStop size={20} />
              </IconButton>
            ) : (
              <IconButton label={theme === "dark" ? "切换浅色" : "切换深色"} onClick={onToggleTheme}>
                {theme === "dark" ? <Sun size={19} /> : <Moon size={19} />}
              </IconButton>
            )}
          </div>
        </header>

        {selectedSession.ownership === "FALLBACK_CONFIRMATION_REQUIRED" && (
          <div className="session-channel-warning">
            <AlertTriangle size={17} />
            <span><strong>正在等待同会话接管</strong>电脑端当前任务结束后会自动发送，无需额外操作。</span>
          </div>
        )}
        {selectedSession.ownership === "OWNERSHIP_CONFLICT" && (
          <div className="session-channel-warning danger">
            <AlertTriangle size={17} />
            <span><strong>检测到重复写入</strong>Bridge 已停止重叠写入并会自动复查；当前指令保留排队，无需重复发送。</span>
          </div>
        )}

        <div className={`permission-dock-slot ${activePermission || otherPermission ? "has-attention" : ""}`}>
          {activePermission ? (
            <button type="button" className="permission-dock" onClick={() => setPermissionOpen(true)}>
              <span className="permission-dock-icon"><AlertTriangle size={18} /></span>
              <span><strong>Claude 正在等待授权</strong><small>{activePermission.title || activePermission.displayName || activePermission.toolName}</small></span>
              <b>{sessionPermissions.length > 1 ? `${sessionPermissions.length} 项` : "处理"}</b>
            </button>
          ) : otherPermission && otherPermissionSession ? (
            <button type="button" className="permission-dock" onClick={() => void selectSession(otherPermission.sessionId)}>
              <span className="permission-dock-icon"><AlertTriangle size={18} /></span>
              <span><strong>另一会话需要处理</strong><small>{otherPermissionSession.title}</small></span>
              <b>前往</b>
            </button>
          ) : null}
        </div>

        <section className="conversation-stream" aria-live="polite">
          {selectedHistory?.hasMore && (
            <button
              type="button"
              className="load-older-button"
              disabled={selectedHistory.status === "loading"}
              onClick={() => void onLoadOlderHistory(selectedSession.sessionId)}
            >
              {selectedHistory.status === "loading" && <LoaderCircle className="is-spinning" size={15} />}
              加载更早消息
            </button>
          )}
          {selectedHistory?.status === "loading" && selectedHistory.items.length === 0 && (
            <div className="conversation-loading"><LoaderCircle className="is-spinning" size={20} />正在读取完整会话</div>
          )}
          {selectedHistory?.status === "error" && selectedHistory.items.length === 0 && (
            <div className="conversation-empty">
              <strong>会话暂时无法读取</strong>
              <button type="button" className="secondary-button" onClick={() => void onOpenSession(selectedSession.sessionId)}>重试</button>
            </div>
          )}
          {items.length === 0 && selectedHistory?.status === "ready" && (
            <div className="conversation-empty">
              <strong>这是一个空会话</strong>
              <span>从下方发出第一条指令。</span>
            </div>
          )}
          {items.map((item) => (
            <article className={`conversation-item ${item.role} ${item.live ? "live" : ""}`} key={item.id}>
              <div className="conversation-item-meta">
                <strong>{item.role === "user" ? "你" : item.role === "assistant" ? "Claude" : item.role === "tool" ? item.toolName : "Bridge"}</strong>
                <time>{formatTime(item.createdAt)}</time>
              </div>
              {item.role === "tool" && <Wrench size={16} aria-hidden="true" />}
              {item.text && <div className="conversation-text">{item.text}</div>}
              {item.attachments?.length ? (
                <div className="attachment-summary">{item.attachments.map((attachment) => <span key={attachment.id}>{attachment.name}</span>)}</div>
              ) : null}
              {item.delivery && <div className={`delivery-state ${item.delivery}`}>{deliveryLabel(item.delivery)}</div>}
              {item.delivery === "uncertain" && item.commandId && (
                <div className="uncertain-delivery-actions">
                  <button type="button" className="secondary-button" onClick={() => void onResolveUncertain(item.commandId!, "confirm")}>确认已发送</button>
                  <button type="button" className="secondary-button" onClick={() => void onResolveUncertain(item.commandId!, "retry")}>检查后重发</button>
                </div>
              )}
              {item.live && <span className="stream-caret" aria-label="正在生成" />}
            </article>
          ))}
          <div ref={endRef} />
        </section>

        <section className="mobile-composer">
          {connectionIssue && (
            <button type="button" className="composer-connection" onClick={() => void onRetry()}>
              {connectionIssue.message} 点击重试
            </button>
          )}
          {attachments.length > 0 && (
            <div className="composer-attachments">
              {attachments.map((attachment) => (
                <span key={attachment.id}>
                  {attachment.name}
                  <button type="button" aria-label={`移除 ${attachment.name}`} onClick={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))}>
                    <X size={13} />
                  </button>
                </span>
              ))}
            </div>
          )}
          {imageError && <div className="composer-error">{imageError}</div>}
          {bridgeRunning && (
            <div className="composer-mode" role="group" aria-label="发送方式">
              <button type="button" className={!steer ? "active" : ""} onClick={() => setSteer(false)}>排到下一轮</button>
                  <button type="button" className={steer ? "active" : ""} onClick={() => setSteer(true)}>立即调整</button>
            </div>
          )}
          <form onSubmit={(event) => { event.preventDefault(); void sendMessage(); }}>
            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/gif,image/webp"
              multiple
              hidden
              onChange={(event) => void addImages(event.target.files)}
            />
            <IconButton label="添加图片" onClick={() => fileRef.current?.click()}><ImagePlus size={20} /></IconButton>
            <textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder={desktopOnline ? "给这个 Claude 会话发指令" : "电脑离线，消息会保存在手机并自动送达"}
              rows={1}
              aria-label="给 Claude 发指令"
            />
            <button type="submit" className="send-button" aria-label="发送" disabled={sending || (!text.trim() && attachments.length === 0)}>
              {sending ? <LoaderCircle className="is-spinning" size={19} /> : <Send size={19} />}
            </button>
          </form>
        </section>
        {configurationOpen && (
          <SessionConfigurationDialog
            session={selectedSession}
            onLoad={() => onLoadSessionConfiguration(selectedSession.sessionId)}
            onSave={(change) => onConfigureSession(selectedSession.sessionId, change)}
            onClose={() => setConfigurationOpen(false)}
          />
        )}
        {permissionOpen && activePermission && (
          <div className="permission-sheet-backdrop" role="presentation" onMouseDown={(event) => {
            if (event.target === event.currentTarget) setPermissionOpen(false);
          }}>
            <section className="permission-sheet" role="dialog" aria-modal="true" aria-labelledby="permission-sheet-title">
              <header>
                <div>
                  <span>需要处理</span>
                  <h2 id="permission-sheet-title">Claude 等待授权</h2>
                </div>
                <IconButton label="暂时关闭" onClick={() => setPermissionOpen(false)}><X size={19} /></IconButton>
              </header>
              {sessionPermissions.length > 1 && <div className="permission-queue-count">还有 {sessionPermissions.length} 项待处理，提交后自动显示下一项。</div>}
              <PermissionPrompt permission={activePermission} onResolve={onResolvePermission} />
            </section>
          </div>
        )}
      </main>
    );
  }

  return (
    <main className="mobile-workspace host-detail-workspace">
      <header className="mobile-topbar">
        <IconButton label="返回主机列表" onClick={onBackToHosts}><ArrowLeft size={21} /></IconButton>
        <div className="mobile-device">
          <strong>{desktopName}</strong>
          <span className={desktopOnline ? "online" : ""}><i />{desktopOnline ? "在线" : connection === "connecting" ? "正在连接" : "离线"}</span>
        </div>
        <IconButton label="刷新" onClick={() => void onRefresh()}><RefreshCw size={19} /></IconButton>
        <IconButton label={theme === "dark" ? "切换浅色" : "切换深色"} onClick={onToggleTheme}>
          {theme === "dark" ? <Sun size={19} /> : <Moon size={19} />}
        </IconButton>
      </header>

      <section className={`mobile-transport-band ${connection === "connected" && desktopOnline ? "online" : ""}`}>
        <span>
          <i aria-hidden="true" />
          <strong>{mobileConnectionLabel(connection, desktopOnline, transportMetrics, snapshot?.host.version)}</strong>
        </span>
        <small>
          {transportMetrics?.rttMs !== undefined ? `${Math.round(transportMetrics.rttMs)} ms` : "等待链路"}
          {" · "}{pendingOutbound} 条待发送
        </small>
      </section>

      <section className="host-detail">
        <div className="host-detail-heading">
          <div>
            <span>Claude</span>
            <h1>项目与会话</h1>
          </div>
          <button
            type="button"
            className="primary-button"
            disabled={!snapshot?.projects.length}
            onClick={() => {
              setCreateProjectId(snapshot?.projects[0]?.projectId ?? "");
              setCreateOpen(true);
            }}
          >
            <Plus size={17} />新建
          </button>
        </div>
        <section className={`mobile-desktop-control ${snapshot?.claudeDesktop?.state ?? "unknown"}`}>
          <div className="mobile-desktop-control-copy">
            <i aria-hidden="true" />
            <span>
              <strong>Claude Desktop</strong>
              <small className={desktopActionError ? "desktop-app-error" : undefined}>
                {desktopActionError || snapshot?.claudeDesktop?.detail || "正在读取电脑端运行状态。"}
              </small>
            </span>
          </div>
          <div className="mobile-desktop-control-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={Boolean(desktopAction) || !desktopOnline || !snapshot?.claudeDesktop?.canLaunch}
              onClick={() => void runClaudeDesktopAction("launch")}
            >
              <Play size={15} />
              {desktopAction === "launch" ? "启动中" : "启动"}
            </button>
            <button
              type="button"
              className="danger-button"
              disabled={Boolean(desktopAction) || !desktopOnline || !snapshot?.claudeDesktop?.canQuit}
              onClick={() => setQuitDesktopOpen(true)}
            >
              <Power size={15} />
              {desktopAction === "quit" ? "退出中" : "退出"}
            </button>
          </div>
        </section>
        <label className="session-search">
          <Search size={17} />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索项目或会话" />
        </label>
        <div className="project-list-toolbar">
          <span>{groupedProjectIds.length} 个项目</span>
          <div>
            <button
              type="button"
              disabled={groupedProjectIds.length === 0 || allProjectsCollapsed}
              onClick={() => setCollapsedProjectIds(collapseProjects(groupedProjectIds))}
            >
              <ChevronsUp size={15} />全部折叠
            </button>
            <button
              type="button"
              disabled={groupedProjectIds.length === 0 || allProjectsExpanded}
              onClick={() => setCollapsedProjectIds(expandAllProjects())}
            >
              <ChevronsDown size={15} />全部展开
            </button>
          </div>
        </div>
        {permissions[0] && (
          <button type="button" className="host-permission-alert" onClick={() => void selectSession(permissions[0]!.sessionId)}>
            <span className="permission-dock-icon"><AlertTriangle size={18} /></span>
            <span>
              <strong>Claude 正在等待处理</strong>
              <small>{sessions.find((session) => session.sessionId === permissions[0]!.sessionId)?.title ?? permissions[0]!.toolName}</small>
            </span>
            <b>{permissions.length > 1 ? `${permissions.length} 项` : "查看"}</b>
          </button>
        )}
        {connectionIssue && (
          <button type="button" className="host-connection-issue" onClick={() => void onRetry()}>
            {connectionIssue.message}
          </button>
        )}
        {!snapshot && (
          <div className="session-catalog-loading">
            <LoaderCircle className="is-spinning" size={20} />
            <strong>正在同步主机状态</strong>
            <span>已保存的会话会在连接恢复后自动出现。</span>
          </div>
        )}
        {snapshot && grouped.length === 0 && (
          <div className="session-catalog-loading">
            <strong>{search ? "没有匹配的会话" : "暂未发现 Claude 会话"}</strong>
            <span>{search ? "换一个关键词试试。" : "先在电脑端 Claude 打开一个项目，Bridge 会自动读取。"}</span>
          </div>
        )}
        <div className="project-groups">
          {grouped.map((group) => {
            const projectId = group.project?.projectId ?? group.sessions[0]!.projectId;
            const expanded = !collapsedProjectIds.has(projectId);
            const sessionsId = `mobile-project-${encodeURIComponent(projectId)}`;
            return (
              <section className={`project-group ${expanded ? "expanded" : "collapsed"}`} key={projectId}>
                <button
                  type="button"
                  className="project-group-toggle"
                  aria-expanded={expanded}
                  aria-controls={sessionsId}
                  onClick={() => toggleProject(projectId)}
                >
                  <span className="project-group-toggle-copy">
                    <span>
                      <strong>{group.project?.name ?? group.sessions[0]!.projectName}</strong>
                      <b>{group.sessions.length} 个会话</b>
                    </span>
                    <small>{group.project?.cwd ?? group.sessions[0]!.cwd}</small>
                  </span>
                  {expanded ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
                </button>
                {expanded && (
                  <div className="session-rows" id={sessionsId}>
                    {group.sessions.map((session) => (
                      <button
                        type="button"
                        className="session-row-v2"
                        data-session-id={session.sessionId}
                        key={session.sessionId}
                        onClick={() => void selectSession(session.sessionId)}
                      >
                        <span className={`session-state-dot ${session.turnState}`} />
                        <span className="session-row-copy">
                          <strong>{session.title}</strong>
                          <small>{relativeTime(session.lastActivityAt)}{session.currentSummary ? ` · ${session.currentSummary}` : ""}</small>
                        </span>
                        <span className="session-row-status">{ownershipLabel(session)}</span>
                        <ChevronRight size={18} />
                      </button>
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      </section>

      {createOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setCreateOpen(false);
        }}>
          <section className="create-session-dialog" role="dialog" aria-modal="true" aria-labelledby="create-session-title">
            <header>
              <h2 id="create-session-title">新建 Claude 会话</h2>
              <IconButton label="关闭" onClick={() => setCreateOpen(false)}><X size={19} /></IconButton>
            </header>
            <label>
              <span>项目</span>
              <select value={createProjectId} onChange={(event) => setCreateProjectId(event.target.value)}>
                {snapshot?.projects.map((project) => <option value={project.projectId} key={project.projectId}>{project.name}</option>)}
              </select>
            </label>
            <label>
              <span>会话名称</span>
              <input value={createTitle} onChange={(event) => setCreateTitle(event.target.value)} placeholder="可留空" />
            </label>
            <div className="dialog-actions">
              <button type="button" className="secondary-button" onClick={() => setCreateOpen(false)}>取消</button>
              <button type="button" className="primary-button" disabled={!createProjectId || createBusy} onClick={() => void createSession()}>
                {createBusy && <LoaderCircle className="is-spinning" size={16} />}创建会话
              </button>
            </div>
          </section>
        </div>
      )}
      <ConfirmationDialog
        open={quitDesktopOpen}
        title="退出电脑上的 Claude Desktop？"
        description="Claude Desktop 窗口会关闭，Bridge 主机仍保持在线，可继续管理已接管的远程会话。"
        confirmLabel="退出 Claude Desktop"
        busy={desktopAction === "quit"}
        danger
        onCancel={() => setQuitDesktopOpen(false)}
        onConfirm={() => void runClaudeDesktopAction("quit")}
      />
    </main>
  );
}
