import type {
  BridgeAttachment,
  BridgeDeliveryState,
  BridgeEvent,
  BridgeHistoryItem,
  BridgePermissionInfo,
  BridgeSessionConfiguration,
  BridgeSessionInfo,
  SocketState,
} from "@bridge/protocol";
import {
  ArrowLeft,
  ChevronRight,
  CircleStop,
  ImagePlus,
  LoaderCircle,
  Moon,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings2,
  Sun,
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
import { IconButton } from "./IconButton.js";
import {
  SessionConfigurationDialog,
  type SessionConfigurationChange,
} from "./SessionConfigurationDialog.js";

interface ConversationItem extends BridgeHistoryItem {
  delivery?: BridgeDeliveryState;
  requestId?: string;
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

function ownershipLabel(session: BridgeSessionInfo): string {
  if (session.turnState === "running") return "运行中";
  if (session.turnState === "queued") return `${session.pendingCount} 条排队`;
  if (session.turnState === "waiting") return "需处理";
  if (session.ownership === "DESKTOP_OBSERVED") return "桌面会话";
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
  for (const item of history?.items ?? []) items.set(item.id, item);
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
      if ((role === "user" || role === "assistant") && text) {
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
  const complete = questions.every((question) => (
    typeof question.question === "string" && Boolean(answers[question.question])
  ));
  return (
    <section className="permission-prompt question-prompt">
      <div className="permission-title">
        <strong>{permission.title || "Claude 需要你的选择"}</strong>
        <span>任一已授权设备的首次回答生效</span>
      </div>
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
        <button type="button" className="secondary-button" onClick={() => void onResolve(permission.requestId, "deny")}>取消</button>
        <button
          type="button"
          className="primary-button"
          disabled={!complete}
          onClick={() => void onResolve(
            permission.requestId,
            "allow-once",
            undefined,
            { ...permission.input, answers },
          )}
        >
          提交回答
        </button>
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
  if (permission.toolName === "AskUserQuestion") {
    return <QuestionPrompt permission={permission} onResolve={onResolve} />;
  }
  return (
    <section className="permission-prompt">
      <div className="permission-title">
        <strong>{permission.title || `${permission.toolName} 请求权限`}</strong>
        <span>{permission.description || permission.displayName || "Claude 等待确认后继续"}</span>
      </div>
      <pre>{JSON.stringify(permission.input, null, 2)}</pre>
      <div className="permission-actions">
        <button type="button" className="secondary-button danger-text" onClick={() => void onResolve(permission.requestId, "deny")}>拒绝</button>
        <button type="button" className="secondary-button" onClick={() => void onResolve(permission.requestId, "allow-once")}>允许一次</button>
        <button type="button" className="primary-button" onClick={() => void onResolve(permission.requestId, "allow-always")}>始终允许</button>
      </div>
    </section>
  );
}

export function MobileWorkspace({
  desktopName,
  connection,
  desktopOnline,
  snapshot,
  histories,
  events,
  localTurns,
  connectionIssue,
  theme,
  onToggleTheme,
  onOpenSession,
  onLoadOlderHistory,
  onSendTurn,
  onInterruptTurn,
  onResolvePermission,
  onCreateSession,
  onLoadSessionConfiguration,
  onConfigureSession,
  onRefresh,
  onBackToHosts,
  onRetry,
}: {
  desktopName: string;
  connection: SocketState;
  desktopOnline: boolean;
  snapshot: {
    projects: Array<{ projectId: string; name: string; cwd: string }>;
    sessions: BridgeSessionInfo[];
    permissions: BridgePermissionInfo[];
    runtime: { state: string; activeTurns: number };
  } | undefined;
  histories: Record<string, SessionHistoryState>;
  events: BridgeEvent[];
  localTurns: LocalTurn[];
  connectionIssue?: MobileConnectionIssue | undefined;
  theme: Theme;
  onToggleTheme(): void;
  onOpenSession(sessionId: string): Promise<void>;
  onLoadOlderHistory(sessionId: string): Promise<void>;
  onSendTurn(sessionId: string, text: string, attachments: BridgeAttachment[], steer: boolean): Promise<void>;
  onInterruptTurn(sessionId: string, commandId?: string): Promise<void>;
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
  const endRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

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

  useEffect(() => {
    if (!selectedSessionId) return;
    endRef.current?.scrollIntoView({ block: "end" });
  }, [items.length, selectedSessionId]);

  async function selectSession(sessionId: string): Promise<void> {
    setConfigurationOpen(false);
    setSelectedSessionId(sessionId);
    await onOpenSession(sessionId);
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
        await onRefresh();
        await selectSession(created.sessionId);
      }
    } finally {
      setCreateBusy(false);
    }
  }

  if (selectedSession) {
    const bridgeRunning = selectedSession.turnState === "running"
      && selectedSession.ownership === "BRIDGE_RUNNING";
    const activeTurn = localTurns
      .filter((turn) => turn.sessionId === selectedSession.sessionId && turn.delivery === "running")
      .at(-1);
    const permissions = snapshot?.permissions.filter((permission) => permission.sessionId === selectedSession.sessionId) ?? [];
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
              {item.live && <span className="stream-caret" aria-label="正在生成" />}
            </article>
          ))}
          {permissions.map((permission) => (
            <PermissionPrompt key={permission.requestId} permission={permission} onResolve={onResolvePermission} />
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
              <button type="button" className={steer ? "active" : ""} onClick={() => setSteer(true)}>停止并调整</button>
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
        <label className="session-search">
          <Search size={17} />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索项目或会话" />
        </label>
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
          {grouped.map((group) => (
            <section className="project-group" key={group.project?.projectId ?? group.sessions[0]!.projectId}>
              <header>
                <div><strong>{group.project?.name ?? group.sessions[0]!.projectName}</strong><span>{group.sessions.length} 个会话</span></div>
                <small>{group.project?.cwd ?? group.sessions[0]!.cwd}</small>
              </header>
              <div className="session-rows">
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
            </section>
          ))}
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
    </main>
  );
}
