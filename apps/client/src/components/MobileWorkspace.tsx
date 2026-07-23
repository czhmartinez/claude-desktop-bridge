import type { BridgePayload, ClaudeHistoryMessage, ClaudeSessionInfo, SocketState, StatusPayload } from "@bridge/protocol";
import {
  ArrowLeft,
  Bell,
  BellOff,
  Check,
  ChevronRight,
  Folder,
  FolderTree,
  GitBranch,
  Moon,
  RefreshCw,
  Send,
  Sun,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { MobileConnectionIssue, SessionHistoryState, TimelineEntry } from "../hooks/useMobileBridge.js";
import type { Theme } from "../hooks/useTheme.js";
import { IconButton } from "./IconButton.js";
import { ConfirmationDialog } from "./ConfirmationDialog.js";

function connectionLabel(state: SocketState, desktopOnline: boolean, issue?: MobileConnectionIssue): string {
  if (issue) return "连接未成功";
  if (state === "connected" && desktopOnline) return "电脑在线";
  if (state === "connected") return "等待电脑上线";
  if (state === "connecting" || state === "reconnecting") return "正在连接";
  return "离线，消息会稍后发送";
}

function payloadText(payload: BridgePayload): string {
  if (payload.kind === "command") return payload.text;
  if (payload.kind === "completion") return payload.summary;
  if (payload.kind === "status" || payload.kind === "system") return payload.message;
  return "";
}

function sessionProgress(session: ClaudeSessionInfo): number | undefined {
  if (!session.totalTasks) return undefined;
  return Math.round(((session.completedTasks ?? 0) / session.totalTasks) * 100);
}

function formatSessionTime(value: number): string {
  const date = new Date(value);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(date);
  }
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(date);
}

function TimelineItem({ entry }: { entry: TimelineEntry }) {
  const payload = entry.payload;
  const time = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(entry.header.sentAt);
  const className = payload.kind === "command" ? "timeline-item command" : `timeline-item ${payload.kind}`;
  const sender = payload.kind === "command"
    ? "你"
    : payload.kind === "completion"
      ? "已完成"
      : payload.kind === "status"
        ? payload.step ?? "Claude"
        : "Bridge";
  return (
    <article className={className}>
      <div className="timeline-meta">
        <span>{sender}</span>
        <time>{time}</time>
      </div>
      <div className="timeline-message">{payloadText(payload)}</div>
      {payload.kind === "status" && typeof payload.progress === "number" && (
        <div
          className="progress-track"
          role="progressbar"
          aria-label="当前进度"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.max(0, Math.min(100, payload.progress))}
        >
          <span style={{ width: `${Math.max(0, Math.min(100, payload.progress))}%` }} />
        </div>
      )}
      {payload.kind === "completion" && <Check className="completion-check" size={16} aria-hidden="true" />}
    </article>
  );
}

function HistoryItem({ message }: { message: ClaudeHistoryMessage }) {
  const time = message.createdAt > 0
    ? new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(message.createdAt)
    : "";
  return (
    <article className={`timeline-item history-item ${message.role === "user" ? "command" : "assistant"}`}>
      <div className="timeline-meta">
        <span>{message.role === "user" ? "你" : "Claude"}</span>
        {time && <time>{time}</time>}
      </div>
      <div className="timeline-message">{message.text}</div>
    </article>
  );
}

function normalizedMessage(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function timelineWithoutHistoryDuplicates(
  timeline: TimelineEntry[],
  history: SessionHistoryState | undefined,
): TimelineEntry[] {
  if (!history?.messages.length) return timeline;
  const historyText = new Set(history.messages.map((message) => normalizedMessage(message.text)));
  return timeline.filter((entry) => {
    const payload = entry.payload;
    if (
      payload.kind === "status" &&
      typeof payload.progress !== "number" &&
      /^(已读取 Claude Desktop 历史|Claude Desktop 会话已打开)/u.test(payload.message)
    ) return false;
    if (payload.kind === "command") return !historyText.has(normalizedMessage(payload.text));
    if (payload.kind === "status") return !historyText.has(normalizedMessage(payload.message));
    if (payload.kind === "completion") return !historyText.has(normalizedMessage(payload.summary));
    return true;
  });
}

function timelineForSession(
  timeline: TimelineEntry[],
  session: ClaudeSessionInfo,
  sessions: ClaudeSessionInfo[],
): TimelineEntry[] {
  return timeline.filter((entry) => {
    const payload = entry.payload;
    if (payload.kind === "sessions" || payload.kind === "history" || payload.kind === "history-request") return false;
    if (payload.kind === "command" || payload.kind === "status" || payload.kind === "completion") {
      if (payload.sessionId) return payload.sessionId === session.sessionId;
      if (payload.kind === "status" && payload.step) {
        return sessions.find((candidate) => candidate.projectName === payload.step)?.sessionId === session.sessionId;
      }
    }
    return sessions[0]?.sessionId === session.sessionId;
  });
}

export function MobileWorkspace({
  desktopName,
  connection,
  desktopOnline,
  sessions,
  sessionCatalogReceived,
  histories,
  timeline,
  connectionIssue,
  theme,
  onToggleTheme,
  onSend,
  onRequestHistory,
  onBackToHosts,
  onUnpair,
  onRetry,
}: {
  desktopName: string;
  connection: SocketState;
  desktopOnline: boolean;
  sessions: ClaudeSessionInfo[];
  sessionCatalogReceived: boolean;
  histories: Record<string, SessionHistoryState>;
  timeline: TimelineEntry[];
  connectionIssue?: MobileConnectionIssue | undefined;
  theme: Theme;
  onToggleTheme(): void;
  onSend(text: string, sessionId: string): Promise<void>;
  onRequestHistory(sessionId: string): Promise<void>;
  onBackToHosts(): void;
  onUnpair(): Promise<void>;
  onRetry(): Promise<void>;
}) {
  const [selectedSessionId, setSelectedSessionId] = useState<string>();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [removeConfirmOpen, setRemoveConfirmOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [notifications, setNotifications] = useState(() => typeof Notification !== "undefined" && Notification.permission === "granted");
  const endRef = useRef<HTMLDivElement>(null);
  const sendingRef = useRef(false);
  const projectGroups = useMemo(() => {
    const groups = new Map<string, ClaudeSessionInfo[]>();
    for (const session of sessions) {
      const projectSessions = groups.get(session.projectName) ?? [];
      projectSessions.push(session);
      groups.set(session.projectName, projectSessions);
    }
    return [...groups.entries()].map(([projectName, projectSessions]) => ({ projectName, sessions: projectSessions }));
  }, [sessions]);
  const selectedSession = sessions.find((session) => session.sessionId === selectedSessionId);
  const selectedHistory = selectedSessionId ? histories[selectedSessionId] : undefined;
  const selectedTimeline = useMemo(
    () => selectedSession
      ? timelineWithoutHistoryDuplicates(timelineForSession(timeline, selectedSession, sessions), selectedHistory)
      : [],
    [selectedHistory, selectedSession, sessions, timeline],
  );
  const activeProgress = [...selectedTimeline]
    .reverse()
    .map((entry) => entry.payload)
    .find((payload): payload is StatusPayload & { progress: number } => (
      payload.kind === "status" && typeof payload.progress === "number"
    ));
  const latestClaudeReply = [...selectedTimeline].reverse().find((entry) => (
    entry.direction === "incoming" && (
      entry.payload.kind === "completion" ||
      (entry.payload.kind === "status" && entry.payload.level === "success")
    )
  ));

  useEffect(() => {
    if (selectedSessionId && !selectedSession) setSelectedSessionId(undefined);
  }, [selectedSession, selectedSessionId]);

  useEffect(() => {
    if (selectedSessionId && connection === "connected" && desktopOnline) {
      void onRequestHistory(selectedSessionId);
    }
  }, [connection, desktopOnline, onRequestHistory, selectedSessionId]);

  useEffect(() => {
    if (
      !selectedSessionId ||
      !latestClaudeReply ||
      !selectedHistory?.syncedAt ||
      latestClaudeReply.header.sentAt <= selectedHistory.syncedAt ||
      connection !== "connected" ||
      !desktopOnline
    ) return;
    const timer = setTimeout(() => void onRequestHistory(selectedSessionId), 400);
    return () => clearTimeout(timer);
  }, [
    connection,
    desktopOnline,
    latestClaudeReply?.header.id,
    onRequestHistory,
    selectedHistory?.syncedAt,
    selectedSessionId,
  ]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [selectedHistory?.messages.length, selectedTimeline.length]);

  async function send(): Promise<void> {
    const command = text.trim();
    if (!command || sendingRef.current || !selectedSession) return;
    sendingRef.current = true;
    setSending(true);
    setText("");
    try { await onSend(command, selectedSession.sessionId); }
    catch { setText(command); }
    finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  async function toggleNotifications(): Promise<void> {
    if (typeof Notification === "undefined") return;
    if (Notification.permission === "granted") {
      setNotifications(false);
      return;
    }
    const permission = await Notification.requestPermission();
    setNotifications(permission === "granted");
  }

  async function removeHost(): Promise<void> {
    if (removing) return;
    setRemoving(true);
    try {
      await onUnpair();
      setRemoveConfirmOpen(false);
    } finally {
      setRemoving(false);
    }
  }

  const themeButton = (
    <IconButton label={theme === "dark" ? "切换浅色" : "切换深色"} onClick={onToggleTheme}>
      {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
    </IconButton>
  );

  if (!selectedSession) {
    return (
      <main className="mobile-workspace session-list-workspace">
        <header className="mobile-topbar">
          <IconButton label="返回主机列表" onClick={onBackToHosts}><ArrowLeft size={19} /></IconButton>
          <div className="mobile-device">
            <strong>{desktopName}</strong>
            <span><i className={connection === "connected" && desktopOnline ? "online" : ""} />{connectionLabel(connection, desktopOnline, connectionIssue)}</span>
          </div>
          <div className="topbar-actions">
            {themeButton}
            <IconButton label="删除这台电脑" onClick={() => setRemoveConfirmOpen(true)}><Trash2 size={18} /></IconButton>
          </div>
        </header>

        <section className="session-browser" aria-label="Claude 会话列表">
          <div className="session-browser-heading">
            <div><span>Claude</span><h1>会话</h1></div>
            <b>{sessions.length}</b>
          </div>
          {sessions.length === 0 ? (
            <div className="empty-sessions">
              <h2>{connectionIssue
                ? "无法同步会话"
                : connection !== "connected"
                  ? "正在连接电脑"
                  : !desktopOnline
                    ? "电脑暂时离线"
                    : sessionCatalogReceived ? "暂无 Claude 会话" : "正在同步会话"}</h2>
              <p>{connectionIssue?.message
                ?? (connection !== "connected"
                  ? "连接成功后会自动加载项目和会话。"
                  : !desktopOnline
                    ? "请确认电脑端 Bridge 正在运行。"
                    : sessionCatalogReceived
                      ? "打开电脑端 Claude 后，会话会自动出现在这里。"
                      : "正在从电脑读取 Claude 的项目和会话。")}</p>
              {connectionIssue && (
                <div className="empty-session-actions">
                  {connectionIssue.code !== "pairing-invalid" && (
                    <button type="button" className="secondary-button" onClick={() => void onRetry()}>
                      <RefreshCw size={16} /><span>重试连接</span>
                    </button>
                  )}
                  <button type="button" className="danger-button" onClick={() => setRemoveConfirmOpen(true)}>
                    <Trash2 size={16} /><span>删除这条配对</span>
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="project-groups">
              {projectGroups.map((project) => (
                <section className="project-group" key={project.projectName}>
                  <header className="project-group-heading">
                    <FolderTree size={17} aria-hidden="true" />
                    <strong>{project.projectName}</strong>
                    <span>{project.sessions.length} 个会话</span>
                  </header>
                  <div className="session-rows">
                    {project.sessions.map((session) => {
                      const progress = sessionProgress(session);
                      return (
                        <button
                          type="button"
                          className="session-row"
                          key={session.sessionId}
                          onClick={() => setSelectedSessionId(session.sessionId)}
                        >
                          <span className="session-row-icon"><Folder size={18} /></span>
                          <span className="session-row-copy">
                            <strong>{session.title}</strong>
                            <small>{session.currentTask ?? "可在 Bridge 后台续写"}</small>
                          </span>
                          <span className="session-row-meta">
                            <time>{formatSessionTime(session.lastActivityAt)}</time>
                            <em className={session.state === "running" ? "running" : ""}>{session.state === "running" ? "桌面已打开" : "历史可续写"}</em>
                          </span>
                          {progress !== undefined && <span className="session-row-progress">{progress}%</span>}
                          <ChevronRight size={18} aria-hidden="true" />
                        </button>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          )}
        </section>
        <ConfirmationDialog
          open={removeConfirmOpen}
          title="删除这台电脑？"
          description={`将从手机移除“${desktopName}”的配对和本地消息记录，之后可重新扫码添加。`}
          confirmLabel="删除主机"
          danger
          busy={removing}
          onCancel={() => setRemoveConfirmOpen(false)}
          onConfirm={() => void removeHost()}
        />
      </main>
    );
  }

  return (
    <main className="mobile-workspace">
      <header className="mobile-topbar conversation-topbar">
        <IconButton label="返回会话列表" onClick={() => setSelectedSessionId(undefined)}><ArrowLeft size={19} /></IconButton>
        <div className="mobile-device">
          <strong>{selectedSession.title}</strong>
          <span><i className={connection === "connected" && desktopOnline ? "online" : ""} />Bridge 后台续写</span>
        </div>
        <div className="topbar-actions">
          <IconButton
            label="同步历史消息"
            onClick={() => void onRequestHistory(selectedSession.sessionId)}
            disabled={connection !== "connected" || !desktopOnline || selectedHistory?.status === "loading"}
          >
            <RefreshCw className={selectedHistory?.status === "loading" ? "is-spinning" : ""} size={18} />
          </IconButton>
          {typeof Notification !== "undefined" && (
            <IconButton label={notifications ? "关闭提醒" : "开启提醒"} onClick={() => void toggleNotifications()}>
              {notifications ? <Bell size={18} /> : <BellOff size={18} />}
            </IconButton>
          )}
          {themeButton}
        </div>
      </header>

      <section className="timeline" aria-live="polite">
        <section className="continuation-note" aria-label="续写方式">
          <GitBranch size={17} aria-hidden="true" />
          <div>
            <strong>独立后台续写</strong>
            <span>保留这段历史并同步回复，不抢占电脑；当前 Claude Desktop 窗口不会自动变化。</span>
          </div>
        </section>
        {activeProgress && (
          <section className="active-progress" aria-label="Claude 当前进度">
            <div className="active-progress-heading">
              <span>{activeProgress.progress >= 100 ? "当前状态" : "正在处理"}</span>
              <strong>{activeProgress.step ?? selectedSession.projectName}</strong>
              <b>{Math.round(activeProgress.progress)}%</b>
            </div>
            <p>{activeProgress.message}</p>
            <div className="progress-track" role="progressbar" aria-label="当前进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={activeProgress.progress}>
              <span style={{ width: `${Math.max(0, Math.min(100, activeProgress.progress))}%` }} />
            </div>
          </section>
        )}
        {selectedHistory?.truncated && selectedHistory.messages.length > 0 && (
          <div className="history-sync-note">已同步最近 {selectedHistory.messages.length} 条消息，较早内容未载入</div>
        )}
        {selectedHistory?.status === "loading" && selectedHistory.messages.length === 0 && (
          <div className="history-loading"><span className="spinner" /><span>正在同步历史消息</span></div>
        )}
        {selectedHistory?.status === "error" && selectedHistory.messages.length === 0 && (
          <div className="empty-timeline">
            <h1>历史消息同步失败</h1>
            <p>连接恢复后可重新读取，不影响继续发送指令。</p>
            <button type="button" className="secondary-button" onClick={() => void onRequestHistory(selectedSession.sessionId)}>
              <RefreshCw size={16} /><span>重新同步</span>
            </button>
          </div>
        )}
        {selectedHistory?.status === "ready" && !selectedHistory.available && selectedHistory.messages.length === 0 && (
          <div className="empty-timeline">
            <h1>未找到本地历史记录</h1>
            <p>这段会话仍可从下方继续，后续消息会正常同步。</p>
          </div>
        )}
        {selectedHistory?.status === "ready" && selectedHistory.available && selectedHistory.messages.length === 0 && selectedTimeline.length === 0 && (
          <div className="empty-timeline">
            <h1>暂无可显示的历史消息</h1>
            <p>工具调用和内部过程不会显示；可以从下方继续对话。</p>
          </div>
        )}
        {!selectedHistory && selectedTimeline.length === 0 && (
          <div className="empty-timeline">
            <h1>{connection === "connected" && desktopOnline ? "正在读取历史消息" : "电脑离线"}</h1>
            <p>{connection === "connected" && desktopOnline ? "正在从电脑端 Claude 同步这段会话。" : "电脑重新在线后会自动同步。"}</p>
          </div>
        )}
        {selectedHistory?.messages.map((message) => <HistoryItem key={message.id} message={message} />)}
        {selectedTimeline.map((entry) => <TimelineItem key={entry.header.id} entry={entry} />)}
        <div ref={endRef} />
      </section>

      <form className="command-composer" onSubmit={(event) => { event.preventDefault(); void send(); }}>
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
          placeholder="在 Bridge 后台续写这段会话"
          rows={1}
          aria-label="给 Claude 发指令"
        />
        <button type="submit" className="send-button" aria-label="发送" title="发送" disabled={!text.trim() || sending}>
          <Send size={19} />
        </button>
      </form>
    </main>
  );
}
