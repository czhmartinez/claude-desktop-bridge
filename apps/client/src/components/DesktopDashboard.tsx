import type {
  BridgeAttachment,
  BridgeEvent,
  BridgeHistoryPage,
  BridgeResponse,
  BridgeSessionConfiguration,
  BridgeSessionInfo,
  DesktopControlSnapshot,
} from "@bridge/protocol";
import {
  CircleStop,
  Download,
  ImagePlus,
  Laptop,
  MessageSquare,
  Moon,
  Plus,
  QrCode,
  RefreshCw,
  Send,
  Settings2,
  ShieldCheck,
  Smartphone,
  Sun,
  Trash2,
  X,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Theme } from "../hooks/useTheme.js";
import type { SessionHistoryState } from "../hooks/useMobileBridge.js";
import type { LocalBridgeRequest } from "../runtime/desktop.js";
import { BrandMark } from "./BrandMark.js";
import { ConfirmationDialog } from "./ConfirmationDialog.js";
import { IconButton } from "./IconButton.js";
import { conversationItems, fileToAttachment, PermissionPrompt } from "./MobileWorkspace.js";
import {
  SessionConfigurationDialog,
  type SessionConfigurationChange,
} from "./SessionConfigurationDialog.js";

type DesktopTab = "sessions" | "devices" | "status";

function unwrap<T>(response: BridgeResponse): T {
  if (!response.ok) throw new Error(response.error?.message ?? "Bridge 请求失败");
  return response.result as T;
}

function formatLastSeen(value: number | undefined, online: boolean): string {
  if (online) return "当前在线";
  if (!value) return "尚未上线";
  const elapsed = Math.max(0, Date.now() - value);
  if (elapsed < 60_000) return "刚刚在线";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前在线`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前在线`;
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(value);
}

function sessionState(session: BridgeSessionInfo): string {
  if (session.turnState === "running") return "运行中";
  if (session.turnState === "queued") return "排队中";
  if (session.ownership === "DESKTOP_OBSERVED") return "桌面会话";
  return "待机";
}

function sessionProfile(session: BridgeSessionInfo): string {
  const model = session.model
    ?.replace(/^claude-/iu, "")
    .replace(/\[1m\]/giu, " 1M")
    .replaceAll("-", " ");
  return [model || "默认模型", session.effort?.toLocaleUpperCase()].filter(Boolean).join(" · ");
}

function DesktopSessions({
  snapshot,
  events,
  apiRequest,
}: {
  snapshot: DesktopControlSnapshot;
  events: BridgeEvent[];
  apiRequest(request: LocalBridgeRequest): Promise<BridgeResponse>;
}) {
  const [selectedId, setSelectedId] = useState(snapshot.sessions[0]?.sessionId);
  const [history, setHistory] = useState<Record<string, SessionHistoryState>>({});
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<BridgeAttachment[]>([]);
  const [steer, setSteer] = useState(false);
  const [sending, setSending] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [configurationOpen, setConfigurationOpen] = useState(false);
  const [projectId, setProjectId] = useState(snapshot.projects[0]?.projectId ?? "");
  const [title, setTitle] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const streamRef = useRef<HTMLDivElement>(null);
  const selected = snapshot.sessions.find((session) => session.sessionId === selectedId);
  const bridgeRunning = selected?.turnState === "running" && selected.ownership === "BRIDGE_RUNNING";
  const items = useMemo(() => (
    selectedId ? conversationItems(selectedId, history[selectedId], events, []) : []
  ), [events, history, selectedId]);
  const grouped = useMemo(() => {
    const map = new Map<string, BridgeSessionInfo[]>();
    for (const session of snapshot.sessions) {
      const list = map.get(session.projectId) ?? [];
      list.push(session);
      map.set(session.projectId, list);
    }
    return [...map.entries()];
  }, [snapshot.sessions]);

  useEffect(() => {
    if (!selectedId) return;
    setSteer(false);
    setConfigurationOpen(false);
    void openSession(selectedId);
  }, [selectedId]);

  useEffect(() => {
    streamRef.current?.scrollTo({ top: streamRef.current.scrollHeight });
  }, [items.length]);

  async function openSession(sessionId: string): Promise<void> {
    setHistory((current) => ({
      ...current,
      [sessionId]: {
        status: "loading",
        items: current[sessionId]?.items ?? [],
        hasMore: current[sessionId]?.hasMore ?? false,
      },
    }));
    try {
      const result = unwrap<{ history: BridgeHistoryPage }>(await apiRequest({
        method: "session.open",
        params: { sessionId },
      }));
      setHistory((current) => ({
        ...current,
        [sessionId]: {
          status: "ready",
          items: result.history.items,
          hasMore: result.history.hasMore,
          ...(result.history.nextCursor ? { nextCursor: result.history.nextCursor } : {}),
        },
      }));
    } catch {
      setHistory((current) => ({
        ...current,
        [sessionId]: { status: "error", items: current[sessionId]?.items ?? [], hasMore: false },
      }));
    }
  }

  async function send(): Promise<void> {
    if (!selected || sending || (!text.trim() && attachments.length === 0)) return;
    const nextText = text.trim();
    const nextAttachments = attachments;
    setText("");
    setAttachments([]);
    setSending(true);
    try {
      unwrap(await apiRequest({
        method: steer ? "turn.steer" : "turn.start",
        params: {
          sessionId: selected.sessionId,
          text: nextText,
          attachments: nextAttachments,
        },
        idempotencyKey: crypto.randomUUID(),
      }));
      setSteer(false);
    } catch {
      setText(nextText);
      setAttachments(nextAttachments);
    } finally {
      setSending(false);
    }
  }

  async function createSession(): Promise<void> {
    const project = snapshot.projects.find((candidate) => candidate.projectId === projectId);
    if (!project) return;
    const result = unwrap<{ session: BridgeSessionInfo }>(await apiRequest({
      method: "session.create",
      params: { cwd: project.cwd, ...(title.trim() ? { title: title.trim() } : {}) },
    }));
    setCreateOpen(false);
    setTitle("");
    setSelectedId(result.session.sessionId);
  }

  async function addImages(files: FileList | null): Promise<void> {
    if (!files?.length) return;
    const candidates = [...files].filter((file) => file.size <= 4 * 1024 * 1024);
    const next = await Promise.all(candidates.map(fileToAttachment));
    setAttachments((current) => [...current, ...next].slice(0, 4));
    if (fileRef.current) fileRef.current.value = "";
  }

  async function resolvePermission(
    requestId: string,
    decision: "allow-once" | "allow-always" | "deny",
    message?: string,
    updatedInput?: Record<string, unknown>,
  ): Promise<void> {
    unwrap(await apiRequest({
      method: "permission.resolve",
      params: { requestId, decision, ...(message ? { message } : {}), ...(updatedInput ? { updatedInput } : {}) },
    }));
  }

  async function loadConfiguration(): Promise<BridgeSessionConfiguration> {
    if (!selected) throw new Error("Session not found");
    return unwrap<{ configuration: BridgeSessionConfiguration }>(await apiRequest({
      method: "session.configuration",
      params: { sessionId: selected.sessionId },
    })).configuration;
  }

  async function saveConfiguration(change: SessionConfigurationChange): Promise<BridgeSessionConfiguration> {
    if (!selected) throw new Error("Session not found");
    return unwrap<{ configuration: BridgeSessionConfiguration }>(await apiRequest({
      method: "session.configure",
      params: { sessionId: selected.sessionId, ...change },
    })).configuration;
  }

  return (
    <section className="desktop-session-layout">
      <aside className="desktop-session-sidebar">
        <div className="desktop-sidebar-heading">
          <div><span>Claude</span><h1>会话</h1></div>
          <IconButton label="新建会话" onClick={() => setCreateOpen(true)} disabled={!snapshot.projects.length}><Plus size={18} /></IconButton>
        </div>
        <div className="desktop-project-list">
          {grouped.map(([groupProjectId, sessions]) => (
            <section key={groupProjectId}>
              <header>
                <strong>{snapshot.projects.find((project) => project.projectId === groupProjectId)?.name ?? sessions[0]!.projectName}</strong>
                <span>{sessions.length}</span>
              </header>
              {sessions.map((session) => (
                <button
                  type="button"
                  className={`desktop-session-row ${session.sessionId === selectedId ? "active" : ""}`}
                  onClick={() => setSelectedId(session.sessionId)}
                  key={session.sessionId}
                >
                  <span className={`session-state-dot ${session.turnState}`} />
                  <span><strong>{session.title}</strong><small>{sessionState(session)}</small></span>
                  {session.pendingCount > 0 && <b>{session.pendingCount}</b>}
                </button>
              ))}
            </section>
          ))}
          {snapshot.sessions.length === 0 && (
            <div className="desktop-sidebar-empty">等待发现 Claude Desktop 会话</div>
          )}
        </div>
      </aside>

      <section className="desktop-conversation">
        {selected ? (
          <>
            <header className="desktop-conversation-heading">
              <div><h2>{selected.title}</h2><span>{selected.projectName} · {sessionState(selected)}</span></div>
              <div className="desktop-conversation-heading-actions">
                <button type="button" className="session-profile-trigger" aria-label="模型与 Effort" onClick={() => setConfigurationOpen(true)}>
                  <Settings2 size={15} />
                  <span>{sessionProfile(selected)}</span>
                </button>
                {bridgeRunning && (
                  <button type="button" className="secondary-button" onClick={() => void apiRequest({ method: "turn.interrupt", params: { sessionId: selected.sessionId } })}>
                    <CircleStop size={16} />停止
                  </button>
                )}
              </div>
            </header>
            <div className="desktop-conversation-stream" ref={streamRef}>
              {history[selected.sessionId]?.status === "loading" && items.length === 0 && <div className="desktop-conversation-empty">正在读取会话</div>}
              {items.map((item) => (
                <article className={`conversation-item ${item.role}`} key={item.id}>
                  <div className="conversation-item-meta"><strong>{item.role === "user" ? "你" : item.role === "assistant" ? "Claude" : item.toolName ?? "Bridge"}</strong></div>
                  <div className="conversation-text">{item.text}</div>
                </article>
              ))}
              {snapshot.permissions
                .filter((permission) => permission.sessionId === selected.sessionId)
                .map((permission) => (
                  <PermissionPrompt key={permission.requestId} permission={permission} onResolve={resolvePermission} />
                ))}
            </div>
            <div className="desktop-composer">
              {attachments.length > 0 && (
                <div className="composer-attachments">
                  {attachments.map((attachment) => <span key={attachment.id}>{attachment.name}<button type="button" onClick={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))}><X size={12} /></button></span>)}
                </div>
              )}
              {bridgeRunning && (
                <div className="composer-mode">
                  <button type="button" className={!steer ? "active" : ""} onClick={() => setSteer(false)}>排到下一轮</button>
                  <button type="button" className={steer ? "active" : ""} onClick={() => setSteer(true)}>停止并调整</button>
                </div>
              )}
              <form onSubmit={(event) => { event.preventDefault(); void send(); }}>
                <input ref={fileRef} type="file" hidden multiple accept="image/jpeg,image/png,image/gif,image/webp" onChange={(event) => void addImages(event.target.files)} />
                <IconButton label="添加图片" onClick={() => fileRef.current?.click()}><ImagePlus size={19} /></IconButton>
                <textarea value={text} onChange={(event) => setText(event.target.value)} placeholder="在这个 Claude 会话中继续" rows={1} />
                <button type="submit" className="send-button" aria-label="发送" disabled={sending || (!text.trim() && attachments.length === 0)}><Send size={18} /></button>
              </form>
            </div>
          </>
        ) : (
          <div className="desktop-conversation-empty"><MessageSquare size={24} /><span>从左侧选择会话</span></div>
        )}
      </section>

      {createOpen && (
        <div className="modal-backdrop">
          <section className="create-session-dialog" role="dialog" aria-modal="true">
            <header><h2>新建 Claude 会话</h2><IconButton label="关闭" onClick={() => setCreateOpen(false)}><X size={18} /></IconButton></header>
            <label><span>项目</span><select value={projectId} onChange={(event) => setProjectId(event.target.value)}>{snapshot.projects.map((project) => <option key={project.projectId} value={project.projectId}>{project.name}</option>)}</select></label>
            <label><span>会话名称</span><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="可留空" /></label>
            <div className="dialog-actions"><button type="button" className="secondary-button" onClick={() => setCreateOpen(false)}>取消</button><button type="button" className="primary-button" onClick={() => void createSession()}>创建</button></div>
          </section>
        </div>
      )}
      {configurationOpen && selected && (
        <SessionConfigurationDialog
          session={selected}
          onLoad={loadConfiguration}
          onSave={saveConfiguration}
          onClose={() => setConfigurationOpen(false)}
        />
      )}
    </section>
  );
}

function DesktopDevices({
  snapshot,
  onCreatePairing,
  onRevoke,
}: {
  snapshot: DesktopControlSnapshot;
  onCreatePairing(): Promise<void>;
  onRevoke(deviceId: string): Promise<void>;
}) {
  const [revokeCandidate, setRevokeCandidate] = useState<string>();
  return (
    <section className="desktop-page">
      <header className="desktop-page-heading">
        <div><span>访问控制</span><h1>设备</h1></div>
        <button type="button" className="primary-button" onClick={() => void onCreatePairing()}><QrCode size={17} />添加手机</button>
      </header>
      {snapshot.pairingUrl && snapshot.pairingExpiresAt && (
        <section className="device-pairing-band">
          <div className="qr-wrap"><QRCodeSVG value={snapshot.pairingUrl} size={176} level="M" marginSize={2} title="手机配对二维码" /></div>
          <div>
            <span>一次性配对</span>
            <h2>使用手机 Bridge 扫描</h2>
            <p>二维码十分钟内有效，首次扫描后绑定到该手机安装。每台设备使用独立密钥。</p>
            <small>{Math.max(0, Math.ceil((snapshot.pairingExpiresAt - Date.now()) / 60_000))} 分钟后过期</small>
          </div>
        </section>
      )}
      <div className="desktop-device-list">
        {snapshot.devices.filter((device) => !device.revokedAt).map((device) => (
          <article className="desktop-device-row" key={device.deviceId}>
            <span className="device-icon"><Smartphone size={20} /></span>
            <div><strong>{device.name}</strong><span>{device.platform.toUpperCase()} · {formatLastSeen(device.lastSeenAt, device.online)}</span></div>
            <span className={`device-online-state ${device.online ? "online" : ""}`}><i />{device.online ? "在线" : "已授权"}</span>
            <IconButton label={`撤销 ${device.name}`} onClick={() => setRevokeCandidate(device.deviceId)}><Trash2 size={17} /></IconButton>
          </article>
        ))}
        {snapshot.devices.filter((device) => !device.revokedAt).length === 0 && (
          <div className="desktop-page-empty"><Smartphone size={24} /><strong>还没有配对手机</strong><span>点击右上角生成十分钟有效的二维码。</span></div>
        )}
      </div>
      <ConfirmationDialog
        open={Boolean(revokeCandidate)}
        title="撤销这台手机？"
        description="撤销后旧密钥会立即失效，手机需要重新扫码才能连接。"
        confirmLabel="撤销权限"
        danger
        onCancel={() => setRevokeCandidate(undefined)}
        onConfirm={() => {
          if (!revokeCandidate) return;
          void onRevoke(revokeCandidate).finally(() => setRevokeCandidate(undefined));
        }}
      />
    </section>
  );
}

function DesktopStatus({
  snapshot,
  onLaunchChange,
  onExport,
}: {
  snapshot: DesktopControlSnapshot;
  onLaunchChange(enabled: boolean): Promise<void>;
  onExport(): Promise<void>;
}) {
  return (
    <section className="desktop-page">
      <header className="desktop-page-heading">
        <div><span>运行诊断</span><h1>状态</h1></div>
        <button type="button" className="secondary-button" onClick={() => void onExport()}><Download size={17} />导出诊断</button>
      </header>
      <div className="status-grid-v2">
        <section>
          <span>Claude 通道</span>
          <strong>{snapshot.runtime.state === "ready" ? "已就绪" : snapshot.runtime.state === "working" ? "运行中" : "需要处理"}</strong>
          <p>{snapshot.runtime.detail}</p>
          {snapshot.runtime.version && <small>Claude {snapshot.runtime.version}</small>}
        </section>
        <section>
          <span>Relay</span>
          <strong>{snapshot.connection === "connected" ? "已连接" : "正在重连"}</strong>
          <p>{new URL(snapshot.host.relayUrl).host}</p>
          <small>{new URL(snapshot.host.relayUrl).protocol === "wss:" ? "出站 WSS" : "局域网 WS"} · 端到端加密</small>
        </section>
        <section>
          <span>活动会话</span>
          <strong>{snapshot.runtime.activeTurns} / {snapshot.runtime.maxParallelTurns}</strong>
          <p>{snapshot.sessions.filter((session) => session.pendingCount > 0).reduce((sum, session) => sum + session.pendingCount, 0)} 条指令排队</p>
          <small>每台主机最多并行两个 turn</small>
        </section>
        <section>
          <span>待处理</span>
          <strong>{snapshot.permissions.length}</strong>
          <p>{snapshot.permissions.length ? "Claude 正在等待审批或回答" : "没有待处理事项"}</p>
          <small>首次有效答复生效</small>
        </section>
      </div>
      <section className="status-settings">
        <label className="toggle-row">
          <span><strong>开机自动运行</strong><small>登录系统后 Bridge 自动待机</small></span>
          <input type="checkbox" checked={snapshot.launchAtLogin} onChange={(event) => void onLaunchChange(event.target.checked)} />
          <i aria-hidden="true" />
        </label>
        <div><span>Bridge 版本</span><strong>{snapshot.host.version}</strong></div>
        <div><span>事件游标</span><strong>{snapshot.latestSeq}</strong></div>
      </section>
    </section>
  );
}

export function DesktopDashboard({ theme, onToggleTheme }: { theme: Theme; onToggleTheme(): void }) {
  const api = window.bridgeDesktop;
  const [snapshot, setSnapshot] = useState<DesktopControlSnapshot>();
  const [events, setEvents] = useState<BridgeEvent[]>([]);
  const [tab, setTab] = useState<DesktopTab>("sessions");

  useEffect(() => {
    if (!api) return;
    void api.getSnapshot().then(setSnapshot);
    const stopSnapshots = api.onSnapshot(setSnapshot);
    const stopEvents = api.onEvent((event) => {
      setEvents((current) => [...current.filter((candidate) => candidate.eventId !== event.eventId), event]
        .sort((left, right) => left.seq - right.seq)
        .slice(-2_000));
    });
    return () => {
      stopSnapshots();
      stopEvents();
    };
  }, [api]);

  if (!api || !snapshot) return <div className="desktop-loading"><BrandMark /><span>正在准备会话主机</span></div>;

  async function request(input: LocalBridgeRequest): Promise<BridgeResponse> {
    return api!.request(input);
  }

  return (
    <main className="desktop-shell-v2">
      <aside className="desktop-nav-v2">
        <BrandMark compact />
        <nav aria-label="Bridge 主导航">
          <button className={tab === "sessions" ? "active" : ""} type="button" onClick={() => setTab("sessions")}><MessageSquare size={19} /><span>会话</span></button>
          <button className={tab === "devices" ? "active" : ""} type="button" onClick={() => setTab("devices")}><Smartphone size={19} /><span>设备</span></button>
          <button className={tab === "status" ? "active" : ""} type="button" onClick={() => setTab("status")}><Settings2 size={19} /><span>状态</span></button>
        </nav>
        <div className="desktop-host-chip">
          <Laptop size={17} />
          <span><strong>{snapshot.host.name}</strong><small>{snapshot.connection === "connected" ? "Bridge 在线" : "正在重连"}</small></span>
        </div>
        <IconButton label={theme === "dark" ? "切换浅色" : "切换深色"} onClick={onToggleTheme}>
          {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
        </IconButton>
      </aside>
      <section className="desktop-content-v2">
        {tab === "sessions" && <DesktopSessions snapshot={snapshot} events={events} apiRequest={request} />}
        {tab === "devices" && (
          <DesktopDevices
            snapshot={snapshot}
            onCreatePairing={async () => setSnapshot(await api.createPairing())}
            onRevoke={async (deviceId) => setSnapshot(await api.revokeDevice(deviceId))}
          />
        )}
        {tab === "status" && (
          <DesktopStatus
            snapshot={snapshot}
            onLaunchChange={async (enabled) => setSnapshot(await api.setLaunchAtLogin(enabled))}
            onExport={async () => { await api.exportDiagnostics(); }}
          />
        )}
      </section>
    </main>
  );
}
