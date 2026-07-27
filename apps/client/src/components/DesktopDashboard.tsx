import type {
  BridgeAttachment,
  BridgeArtifactManifest,
  BridgeArtifactPreview,
  BridgeEvidenceBundle,
  BridgeEvidencePage,
  BridgeEvent,
  BridgeHistoryPage,
  BridgeProviderProfile,
  BridgeResponse,
  BridgeSessionConfiguration,
  BridgeSessionInfo,
  DesktopControlSnapshot,
} from "@bridge/protocol";
import {
  AlertTriangle,
  ArrowRightLeft,
  ChevronDown,
  ChevronRight,
  ChevronsDown,
  ChevronsUp,
  CircleStop,
  Download,
  ImagePlus,
  Laptop,
  LoaderCircle,
  MessageSquare,
  Moon,
  Play,
  Plus,
  Power,
  QrCode,
  RefreshCw,
  Send,
  Settings2,
  Smartphone,
  Sun,
  Trash2,
  X,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Theme } from "../hooks/useTheme.js";
import type { SessionEvidenceState, SessionHistoryState } from "../hooks/useMobileBridge.js";
import { downloadBridgeArtifact } from "../lib/artifact-download.js";
import {
  collapseProjects,
  expandAllProjects,
  expandProject,
  toggleCollapsedProject,
} from "../lib/project-groups.js";
import type { LocalBridgeRequest } from "../runtime/desktop.js";
import { BrandMark } from "./BrandMark.js";
import { ConfirmationDialog } from "./ConfirmationDialog.js";
import { EvidenceInlineSummary, EvidencePanel } from "./EvidencePanel.js";
import { IconButton } from "./IconButton.js";
import {
  conversationItems,
  conversationTimeline,
  fileToAttachment,
  PermissionPrompt,
  stoppableBridgeTask,
} from "./MobileWorkspace.js";
import {
  ProviderSwitchDialog,
  providerName,
  type ProviderSwitchPreview,
  type ProviderSwitchResult,
} from "./ProviderSwitchDialog.js";
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

function connectionLabel(snapshot: DesktopControlSnapshot): string {
  if (snapshot.host.version.startsWith("0.2.")) return "需要升级";
  if (snapshot.connection === "connecting" || snapshot.connection === "reconnecting") return "正在重连";
  if (snapshot.connection !== "connected") return "主机离线";
  if (snapshot.transport?.path === "direct") return "直连";
  if (snapshot.transport?.path === "public-relay") return "安全中继";
  return "局域网连接";
}

function sessionState(session: BridgeSessionInfo): string {
  const bridgeCreated = session.source === "bridge";
  if (session.ownership === "OWNERSHIP_CONFLICT") return "写入冲突";
  if (session.ownership === "FALLBACK_CONFIRMATION_REQUIRED") return "等待接管";
  if (session.ownership === "DESKTOP_OBSERVED" && session.turnState === "running") {
    return "桌面运行中";
  }
  if (session.turnState === "running") return bridgeCreated ? "Bridge 运行中" : "运行中";
  if (session.turnState === "queued") return bridgeCreated ? "Bridge 排队中" : "排队中";
  if (bridgeCreated) return "Bridge 待机";
  if (session.transport === "claude-desktop-managed") return "Claude Desktop 同步";
  if (session.ownership === "DESKTOP_OBSERVED") return "桌面待机";
  return "待机";
}

function transportLabel(session: BridgeSessionInfo): string {
  if (session.transport === "claude-desktop-managed") return "Claude Desktop 同步";
  if (session.source === "bridge") {
    if (session.desktopRegistration?.state === "registered") return "Claude Desktop 已登记";
    if (session.desktopRegistration?.state === "restart-required") return "等待 Desktop 重启";
    return "仅在 Bridge";
  }
  return "桌面会话接管";
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
  onClaudeDesktopLaunch,
  onClaudeDesktopQuit,
  onSetAnthropicApiKey,
  onRemoveAnthropicApiKey,
  onRefreshSnapshot,
}: {
  snapshot: DesktopControlSnapshot;
  events: BridgeEvent[];
  apiRequest(request: LocalBridgeRequest): Promise<BridgeResponse>;
  onClaudeDesktopLaunch(): Promise<DesktopControlSnapshot>;
  onClaudeDesktopQuit(): Promise<DesktopControlSnapshot>;
  onSetAnthropicApiKey(value: string): Promise<void>;
  onRemoveAnthropicApiKey(): Promise<void>;
  onRefreshSnapshot(): Promise<void>;
}) {
  const [selectedId, setSelectedId] = useState(snapshot.sessions[0]?.sessionId);
  const [history, setHistory] = useState<Record<string, SessionHistoryState>>({});
  const [evidence, setEvidence] = useState<Record<string, SessionEvidenceState>>({});
  const [artifactPreviews, setArtifactPreviews] = useState<Record<string, BridgeArtifactPreview>>({});
  const [artifactTransfers, setArtifactTransfers] = useState<Record<string, number>>({});
  const [sessionView, setSessionView] = useState<"conversation" | "evidence">("conversation");
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<BridgeAttachment[]>([]);
  const [steer, setSteer] = useState(false);
  const [sending, setSending] = useState(false);
  const [stoppingSessionId, setStoppingSessionId] = useState<string>();
  const [stopError, setStopError] = useState<string>();
  const [registrationBusy, setRegistrationBusy] = useState(false);
  const [registrationError, setRegistrationError] = useState<string>();
  const [createOpen, setCreateOpen] = useState(false);
  const [configurationOpen, setConfigurationOpen] = useState(false);
  const [providerOpen, setProviderOpen] = useState(false);
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<Set<string>>(() => new Set());
  const [projectId, setProjectId] = useState(snapshot.projects[0]?.projectId ?? "");
  const [title, setTitle] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const streamRef = useRef<HTMLDivElement>(null);
  const selected = snapshot.sessions.find((session) => session.sessionId === selectedId);
  const providers = snapshot.providers ?? [];
  const providerSwitchingAvailable = snapshot.host.capabilities.includes("provider.profile.v1")
    && snapshot.host.capabilities.includes("conversation.handoff.v1");
  const activeProvider = providers.find((profile) => profile.id === selected?.activeProviderProfileId);
  const officialActive = activeProvider?.kind === "claude-official";
  const selectedEvidence = selectedId ? evidence[selectedId] : undefined;
  const bridgeRunning = selected?.turnState === "running" && (
    selected.ownership === "BRIDGE_RUNNING" ||
    selected.ownership === "DESKTOP_MANAGED_RUNNING"
  );
  const stopTarget = stoppableBridgeTask(snapshot.sessions, selected?.sessionId);
  const canStop = Boolean(stopTarget);
  const stopping = stopTarget?.sessionId === stoppingSessionId;
  const stoppingBlocker = Boolean(stopTarget && stopTarget.sessionId !== selected?.sessionId);
  const items = useMemo(() => (
    selectedId ? conversationItems(selectedId, history[selectedId], events, []) : []
  ), [events, history, selectedId]);
  const timeline = useMemo(
    () => conversationTimeline(items, selectedEvidence?.items ?? []),
    [items, selectedEvidence?.items],
  );
  const grouped = useMemo(() => {
    const map = new Map<string, BridgeSessionInfo[]>();
    for (const session of snapshot.sessions) {
      const list = map.get(session.projectId) ?? [];
      list.push(session);
      map.set(session.projectId, list);
    }
    return [...map.entries()];
  }, [snapshot.sessions]);
  const groupedProjectIds = useMemo(
    () => grouped.map(([groupProjectId]) => groupProjectId),
    [grouped],
  );
  const allProjectsCollapsed = groupedProjectIds.length > 0
    && groupedProjectIds.every((groupProjectId) => collapsedProjectIds.has(groupProjectId));
  const allProjectsExpanded = groupedProjectIds.length > 0
    && groupedProjectIds.every((groupProjectId) => !collapsedProjectIds.has(groupProjectId));
  const uncertainDeliveries = useMemo(() => {
    if (!selectedId) return [];
    const latest = new Map<string, BridgeEvent>();
    for (const event of events) {
      if (
        event.sessionId !== selectedId ||
        event.type !== "message.delivery" ||
        typeof event.data.commandId !== "string"
      ) continue;
      const previous = latest.get(event.data.commandId);
      if (!previous || event.seq > previous.seq) latest.set(event.data.commandId, event);
    }
    return [...latest.values()].filter((event) => event.data.delivery === "uncertain");
  }, [events, selectedId]);

  useEffect(() => {
    if (!selectedId) return;
    setSteer(false);
    setSessionView("conversation");
    setConfigurationOpen(false);
    setStopError(undefined);
    setRegistrationError(undefined);
    void openSession(selectedId);
  }, [selectedId]);

  useEffect(() => {
    const incoming = events.flatMap((event): BridgeEvidenceBundle[] => {
      if (!event.type.startsWith("evidence.")) return [];
      const item = event.data.evidence as Partial<BridgeEvidenceBundle> | undefined;
      if (
        !item ||
        typeof item.id !== "string" ||
        typeof item.sessionId !== "string" ||
        !Array.isArray(item.tools) ||
        !Array.isArray(item.artifacts)
      ) return [];
      return [item as BridgeEvidenceBundle];
    });
    if (incoming.length === 0) return;
    setEvidence((current) => {
      const next = { ...current };
      for (const item of incoming) {
        const previous = next[item.sessionId] ?? { status: "ready", items: [], hasMore: false };
        const merged = new Map(previous.items.map((candidate) => [candidate.id, candidate]));
        merged.set(item.id, item);
        next[item.sessionId] = {
          ...previous,
          status: "ready",
          items: [...merged.values()].sort((left, right) => right.startedAt - left.startedAt),
        };
      }
      return next;
    });
  }, [events]);

  useEffect(() => {
    if (selectedId && snapshot.sessions.some((session) => session.sessionId === selectedId)) return;
    setSelectedId(snapshot.sessions[0]?.sessionId);
  }, [selectedId, snapshot.sessions]);

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
    setEvidence((current) => ({
      ...current,
      [sessionId]: {
        status: "loading",
        items: current[sessionId]?.items ?? [],
        hasMore: current[sessionId]?.hasMore ?? false,
      },
    }));
    try {
      const [result, evidenceResult] = await Promise.all([
        apiRequest({
          method: "session.open",
          params: { sessionId },
        }).then((response) => unwrap<{ history: BridgeHistoryPage }>(response)),
        apiRequest({
          method: "evidence.list",
          params: { sessionId, limit: 30 },
        }).then((response) => response.ok
          ? response.result as { evidence: BridgeEvidencePage }
          : undefined)
          .catch(() => undefined),
      ]);
      setHistory((current) => ({
        ...current,
        [sessionId]: {
          status: "ready",
          items: result.history.items,
          hasMore: result.history.hasMore,
          ...(result.history.nextCursor ? { nextCursor: result.history.nextCursor } : {}),
        },
      }));
      setEvidence((current) => {
        const merged = new Map(
          (current[sessionId]?.items ?? []).map((item) => [item.id, item]),
        );
        for (const item of evidenceResult?.evidence.items ?? []) merged.set(item.id, item);
        return {
          ...current,
          [sessionId]: {
            status: evidenceResult ? "ready" : merged.size > 0 ? "ready" : "error",
            items: [...merged.values()].sort((left, right) => right.startedAt - left.startedAt),
            hasMore: evidenceResult?.evidence.hasMore ?? false,
            ...(evidenceResult?.evidence.nextCursor
              ? { nextCursor: evidenceResult.evidence.nextCursor }
              : {}),
          },
        };
      });
    } catch {
      setHistory((current) => ({
        ...current,
        [sessionId]: { status: "error", items: current[sessionId]?.items ?? [], hasMore: false },
      }));
      setEvidence((current) => ({
        ...current,
        [sessionId]: {
          status: current[sessionId]?.items.length ? "ready" : "error",
          items: current[sessionId]?.items ?? [],
          hasMore: current[sessionId]?.hasMore ?? false,
        },
      }));
    }
  }

  async function loadOlderEvidence(): Promise<void> {
    if (!selectedId) return;
    const current = evidence[selectedId];
    if (!current?.nextCursor || current.status === "loading") return;
    setEvidence((value) => ({
      ...value,
      [selectedId]: { ...current, status: "loading" },
    }));
    try {
      const result = unwrap<{ evidence: BridgeEvidencePage }>(await apiRequest({
        method: "evidence.list",
        params: { sessionId: selectedId, cursor: current.nextCursor, limit: 30 },
      }));
      const merged = new Map(current.items.map((item) => [item.id, item]));
      for (const item of result.evidence.items) merged.set(item.id, item);
      setEvidence((value) => ({
        ...value,
        [selectedId]: {
          status: "ready",
          items: [...merged.values()].sort((left, right) => right.startedAt - left.startedAt),
          hasMore: result.evidence.hasMore,
          ...(result.evidence.nextCursor ? { nextCursor: result.evidence.nextCursor } : {}),
        },
      }));
    } catch {
      setEvidence((value) => ({
        ...value,
        [selectedId]: { ...current, status: "error" },
      }));
    }
  }

  async function previewArtifact(artifactId: string): Promise<BridgeArtifactPreview> {
    const cached = artifactPreviews[artifactId];
    if (cached) return cached;
    const preview = unwrap<{ preview: BridgeArtifactPreview }>(await apiRequest({
      method: "artifact.preview",
      params: { artifactId },
    })).preview;
    setArtifactPreviews((current) => ({ ...current, [artifactId]: preview }));
    return preview;
  }

  async function downloadArtifact(artifact: BridgeArtifactManifest): Promise<void> {
    setArtifactTransfers((current) => ({ ...current, [artifact.id]: 0 }));
    try {
      await downloadBridgeArtifact(
        artifact,
        async (method, params) => apiRequest({ method, params }),
        (progress) => setArtifactTransfers((current) => ({
          ...current,
          [artifact.id]: progress,
        })),
      );
    } finally {
      setArtifactTransfers((current) => {
        const next = { ...current };
        delete next[artifact.id];
        return next;
      });
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

  async function previewProviderSwitch(
    targetProviderProfileId: string,
    model?: string,
  ): Promise<ProviderSwitchPreview> {
    if (!selected) throw new Error("Session not found");
    return unwrap<ProviderSwitchPreview>(await apiRequest({
      method: "conversation.switch.preview",
      params: {
        sessionId: selected.sessionId,
        targetProviderProfileId,
        ...(model ? { model } : {}),
      },
    }));
  }

  async function commitProviderSwitch(
    handoffId: string,
    targetNativeSessionId?: string,
    model?: string,
  ): Promise<ProviderSwitchResult> {
    return unwrap<ProviderSwitchResult>(await apiRequest({
      method: "conversation.switch.commit",
      params: {
        handoffId,
        ...(targetNativeSessionId ? { targetNativeSessionId } : {}),
        ...(model ? { model } : {}),
      },
    }));
  }

  async function cancelProviderSwitch(handoffId: string): Promise<void> {
    unwrap(await apiRequest({
      method: "conversation.switch.cancel",
      params: { handoffId },
    }));
  }

  async function refreshProviders(): Promise<void> {
    unwrap<{ providers: BridgeProviderProfile[] }>(await apiRequest({
      method: "provider.refresh",
      params: {},
    }));
    await onRefreshSnapshot();
  }

  async function stopCurrentTask(): Promise<void> {
    if (!stopTarget || stoppingSessionId) return;
    setStoppingSessionId(stopTarget.sessionId);
    setStopError(undefined);
    try {
      const result = unwrap<{ interrupted: boolean }>(await apiRequest({
        method: "turn.interrupt",
        params: { sessionId: stopTarget.sessionId, force: true },
      }));
      if (!result.interrupted) throw new Error("当前没有可停止的 Bridge 任务");
    } catch (error) {
      setStopError(error instanceof Error ? error.message : "任务停止失败");
    } finally {
      setStoppingSessionId(undefined);
    }
  }

  async function refreshDesktopRegistration(): Promise<void> {
    if (!selected || registrationBusy) return;
    setRegistrationBusy(true);
    setRegistrationError(undefined);
    try {
      unwrap(await apiRequest({
        method: "session.desktop.register",
        params: { sessionId: selected.sessionId },
      }));
    } catch (error) {
      setRegistrationError(error instanceof Error ? error.message : "Claude Desktop 会话登记失败");
    } finally {
      setRegistrationBusy(false);
    }
  }

  async function restartClaudeForRegistration(): Promise<void> {
    if (!selected || registrationBusy) return;
    setRegistrationBusy(true);
    setRegistrationError(undefined);
    try {
      const stopped = await onClaudeDesktopQuit();
      if (stopped.claudeDesktop.state !== "stopped") {
        throw new Error("已取消重启，登记文件仍会保留。");
      }
      await onClaudeDesktopLaunch();
      unwrap(await apiRequest({
        method: "session.desktop.register",
        params: { sessionId: selected.sessionId },
      }));
    } catch (error) {
      setRegistrationError(error instanceof Error ? error.message : "Claude Desktop 重启失败");
    } finally {
      setRegistrationBusy(false);
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
    setCollapsedProjectIds((current) => expandProject(current, result.session.projectId));
    setSelectedId(result.session.sessionId);
  }

  function toggleProject(projectId: string): void {
    setCollapsedProjectIds((current) => toggleCollapsedProject(current, projectId));
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
          <div className="desktop-sidebar-actions">
            <IconButton
              label="全部折叠"
              disabled={groupedProjectIds.length === 0 || allProjectsCollapsed}
              onClick={() => setCollapsedProjectIds(collapseProjects(groupedProjectIds))}
            >
              <ChevronsUp size={17} />
            </IconButton>
            <IconButton
              label="全部展开"
              disabled={groupedProjectIds.length === 0 || allProjectsExpanded}
              onClick={() => setCollapsedProjectIds(expandAllProjects())}
            >
              <ChevronsDown size={17} />
            </IconButton>
            <IconButton label="新建 Bridge 会话" onClick={() => setCreateOpen(true)} disabled={!snapshot.projects.length}><Plus size={18} /></IconButton>
          </div>
        </div>
        <div className="desktop-project-list">
          {grouped.map(([groupProjectId, sessions]) => {
            const expanded = !collapsedProjectIds.has(groupProjectId);
            const sessionsId = `desktop-project-${encodeURIComponent(groupProjectId)}`;
            return (
              <section className={expanded ? "expanded" : "collapsed"} key={groupProjectId}>
                <button
                  type="button"
                  className="desktop-project-toggle"
                  aria-expanded={expanded}
                  aria-controls={sessionsId}
                  onClick={() => toggleProject(groupProjectId)}
                >
                  {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  <strong>{snapshot.projects.find((project) => project.projectId === groupProjectId)?.name ?? sessions[0]!.projectName}</strong>
                  <span>{sessions.length}</span>
                </button>
                {expanded && (
                  <div className="desktop-project-sessions" id={sessionsId}>
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
                  </div>
                )}
              </section>
            );
          })}
          {snapshot.sessions.length === 0 && (
            <div className="desktop-sidebar-empty">等待发现 Claude Desktop 会话</div>
          )}
        </div>
      </aside>

      <section className="desktop-conversation">
        {selected ? (
          <>
            <header className="desktop-conversation-heading">
              <div>
                <h2>{selected.title}</h2>
                <span>{selected.projectName} · {sessionState(selected)} · {transportLabel(selected)}</span>
              </div>
              <div className="desktop-conversation-heading-actions">
                {providerSwitchingAvailable && (
                  <button
                    type="button"
                    className="session-provider-trigger"
                    aria-label="切换执行提供方"
                    onClick={() => setProviderOpen(true)}
                  >
                    <ArrowRightLeft size={15} />
                    <span>{providerName(selected.activeProviderProfileId, providers)}</span>
                  </button>
                )}
                <button
                  type="button"
                  className="session-profile-trigger"
                  aria-label="模型与 Effort"
                  disabled={selected.allowedActions?.canConfigure === false}
                  onClick={() => setConfigurationOpen(true)}
                >
                  <Settings2 size={15} />
                  <span>{sessionProfile(selected)}</span>
                </button>
                {canStop && (
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={stopping}
                    aria-label={stoppingBlocker ? "停止阻塞的 Bridge 任务" : "停止当前 Bridge 任务"}
                    onClick={() => void stopCurrentTask()}
                  >
                    {stopping ? <LoaderCircle className="is-spinning" size={16} /> : <CircleStop size={16} />}
                    {stopping ? "停止中" : stoppingBlocker ? "停止阻塞任务" : "停止"}
                  </button>
                )}
              </div>
            </header>
            {selected.ownership === "FALLBACK_CONFIRMATION_REQUIRED" && (
              <div className="desktop-channel-banner">
                <AlertTriangle size={18} />
                <span><strong>正在等待同会话接管</strong>Claude Desktop 当前任务结束后，Bridge 会自动恢复这条会话。</span>
              </div>
            )}
            {selected.ownership === "OWNERSHIP_CONFLICT" && (
              <div className="desktop-channel-banner danger">
                <AlertTriangle size={18} />
                <span><strong>检测到重复写入</strong>Bridge 已停止重叠写入并会自动复查；持续冲突时再结束重复进程。</span>
              </div>
            )}
            {stopError && (
              <div className="desktop-channel-banner danger">
                <AlertTriangle size={18} />
                <span><strong>任务停止失败</strong>{stopError}</span>
              </div>
            )}
            {providerSwitchingAvailable && selected.routeState && selected.routeState !== "ready" && (
              <button
                type="button"
                className="desktop-channel-banner provider-route-banner"
                onClick={() => setProviderOpen(true)}
              >
                <ArrowRightLeft size={18} />
                <span>
                  <strong>{selected.routeState === "awaiting-user-confirmation"
                    ? "等待 Mac 确认"
                    : selected.routeState === "awaiting-target-selection"
                      ? "选择 Claude 官方会话"
                      : selected.routeState === "failed"
                        ? "提供方切换未完成"
                        : "正在切换执行通道"}</strong>
                  {selected.pendingHandoff?.summary ?? "原执行通道保持活动。"}
                </span>
              </button>
            )}
            {selected.source === "bridge" &&
              !officialActive &&
              selected.desktopRegistration &&
              selected.desktopRegistration.state !== "registered" && (
                <div className={`desktop-channel-banner ${
                  selected.desktopRegistration.state === "failed" ? "danger" : ""
                }`}>
                  {registrationBusy
                    ? <LoaderCircle className="is-spinning" size={18} />
                    : <AlertTriangle size={18} />}
                  <span>
                    <strong>
                      {selected.desktopRegistration.state === "restart-required"
                        ? "等待 Claude Desktop 重启"
                        : selected.desktopRegistration.state === "waiting-transcript"
                          ? "等待首轮会话记录"
                          : "尚未登记到 Claude Desktop"}
                    </strong>
                    {registrationError ?? selected.desktopRegistration.detail}
                  </span>
                  {selected.desktopRegistration.state === "restart-required" ? (
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={registrationBusy}
                      onClick={() => void restartClaudeForRegistration()}
                    >
                      <RefreshCw size={15} />
                      {registrationBusy ? "重启中" : "重启并登记"}
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={registrationBusy}
                      onClick={() => void refreshDesktopRegistration()}
                    >
                      <RefreshCw size={15} />
                      {registrationBusy ? "检查中" : "重新检查"}
                    </button>
                  )}
                </div>
              )}
            <nav className="session-view-switch desktop-session-view-switch" aria-label="会话视图">
              <button
                type="button"
                className={sessionView === "conversation" ? "active" : ""}
                onClick={() => setSessionView("conversation")}
              >
                对话
              </button>
              <button
                type="button"
                className={sessionView === "evidence" ? "active" : ""}
                onClick={() => setSessionView("evidence")}
              >
                成果
                {(selectedEvidence?.items.length ?? 0) > 0 && <b>{selectedEvidence!.items.length}</b>}
              </button>
            </nav>
            {sessionView === "conversation" ? (
            <div className="desktop-conversation-stream" ref={streamRef}>
              {history[selected.sessionId]?.status === "loading" && items.length === 0 && <div className="desktop-conversation-empty">正在读取会话</div>}
              {timeline.map((entry) => entry.kind === "evidence" ? (
                <EvidenceInlineSummary
                  evidence={entry.evidence}
                  key={`evidence:${entry.evidence.id}`}
                  onOpen={() => setSessionView("evidence")}
                />
              ) : (
                <article className={`conversation-item ${entry.item.role}`} key={entry.item.id}>
                  <div className="conversation-item-meta"><strong>{entry.item.role === "user" ? "你" : entry.item.role === "assistant" ? "Claude" : entry.item.toolName ?? "Bridge"}</strong></div>
                  <div className="conversation-text">{entry.item.text}</div>
                </article>
              ))}
              {snapshot.permissions
                .filter((permission) => permission.sessionId === selected.sessionId)
                .map((permission) => (
                  <PermissionPrompt key={permission.requestId} permission={permission} onResolve={resolvePermission} />
                ))}
              {uncertainDeliveries.map((event) => (
                <article className="conversation-item system uncertain-delivery" key={event.eventId}>
                  <div className="conversation-item-meta"><strong>发送结果待确认</strong></div>
                  <div className="conversation-text">{typeof event.data.error === "string" ? event.data.error : "Claude Desktop 在确认消息前断开。"}</div>
                  <div className="uncertain-delivery-actions">
                    <button type="button" className="secondary-button" onClick={() => void apiRequest({
                      method: "message.delivery.resolve",
                      params: { commandId: event.data.commandId, action: "confirm" },
                    })}>确认已发送</button>
                    <button type="button" className="secondary-button" onClick={() => void apiRequest({
                      method: "message.delivery.resolve",
                      params: { commandId: event.data.commandId, action: "retry" },
                    })}>检查后重发</button>
                  </div>
                </article>
              ))}
            </div>
            ) : (
              <div className="desktop-evidence-view">
                <EvidencePanel
                  state={selectedEvidence}
                  previews={artifactPreviews}
                  transfers={artifactTransfers}
                  online
                  onLoadMore={loadOlderEvidence}
                  onPreview={previewArtifact}
                  onDownload={downloadArtifact}
                />
              </div>
            )}
            {sessionView === "conversation" && (
            <div className="desktop-composer">
              {officialActive ? (
                <button
                  type="button"
                  className="official-continue-button"
                  onClick={() => void onClaudeDesktopLaunch()}
                >
                  <ArrowRightLeft size={18} />
                  在 Claude 官方继续
                </button>
              ) : (
              <>
              {attachments.length > 0 && (
                <div className="composer-attachments">
                  {attachments.map((attachment) => <span key={attachment.id}>{attachment.name}<button type="button" onClick={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))}><X size={12} /></button></span>)}
                </div>
              )}
              {bridgeRunning && (
                <div className="composer-mode">
                  <button type="button" className={!steer ? "active" : ""} onClick={() => setSteer(false)}>排到下一轮</button>
                  <button type="button" className={steer ? "active" : ""} onClick={() => setSteer(true)}>立即调整</button>
                </div>
              )}
              <form onSubmit={(event) => { event.preventDefault(); void send(); }}>
                <input ref={fileRef} type="file" hidden multiple accept="image/jpeg,image/png,image/gif,image/webp" onChange={(event) => void addImages(event.target.files)} />
                <IconButton label="添加图片" disabled={selected.allowedActions?.canSend === false} onClick={() => fileRef.current?.click()}><ImagePlus size={19} /></IconButton>
                <textarea
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  disabled={selected.allowedActions?.canSend === false}
                  placeholder={selected.allowedActions?.reason ?? (
                    selected.source === "bridge"
                      ? "在这个 Bridge 会话中继续"
                      : "在这个 Claude Desktop 会话中继续"
                  )}
                  rows={1}
                />
                <button type="submit" className="send-button" aria-label="发送" disabled={selected.allowedActions?.canSend === false || sending || (!text.trim() && attachments.length === 0)}><Send size={18} /></button>
              </form>
              </>
              )}
            </div>
            )}
          </>
        ) : (
          <div className="desktop-conversation-empty"><MessageSquare size={24} /><span>从左侧选择会话</span></div>
        )}
      </section>

      {createOpen && (
        <div className="modal-backdrop">
          <section className="create-session-dialog" role="dialog" aria-modal="true">
            <header><h2>新建 Bridge 会话</h2><IconButton label="关闭" onClick={() => setCreateOpen(false)}><X size={18} /></IconButton></header>
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
      {providerOpen && selected && providerSwitchingAvailable && (
        <ProviderSwitchDialog
          session={selected}
          profiles={providers}
          desktopLocal
          onPreview={previewProviderSwitch}
          onCommit={commitProviderSwitch}
          onCancel={cancelProviderSwitch}
          onRefresh={refreshProviders}
          onSetApiKey={onSetAnthropicApiKey}
          onRemoveApiKey={onRemoveAnthropicApiKey}
          onChanged={onRefreshSnapshot}
          onClose={() => setProviderOpen(false)}
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
          <div className="qr-wrap"><QRCodeSVG value={snapshot.pairingUrl} size={320} level="M" marginSize={4} title="手机配对二维码" /></div>
          <div>
            <span>一次性配对</span>
            <h2>使用手机 Bridge 扫描</h2>
            <p>二维码十分钟内有效，首次扫描后绑定到该手机安装。V0.4.0 使用新配对密钥，旧设备需要重新扫码。</p>
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
  onClaudeDesktopLaunch,
  onClaudeDesktopQuit,
  onExport,
}: {
  snapshot: DesktopControlSnapshot;
  onLaunchChange(enabled: boolean): Promise<void>;
  onClaudeDesktopLaunch(): Promise<void>;
  onClaudeDesktopQuit(): Promise<void>;
  onExport(): Promise<void>;
}) {
  const [desktopAction, setDesktopAction] = useState<"launch" | "quit">();
  const [desktopActionError, setDesktopActionError] = useState("");
  const takeoverReady = snapshot.runtime.state === "ready" || snapshot.runtime.state === "working";
  const takeoverTitle = takeoverReady
    ? snapshot.runtime.state === "working" ? "正在接管" : "自动接管已就绪"
    : snapshot.runtime.state === "auth-required" ? "等待第三方凭据" : "运行时不可用";
  async function runDesktopAction(action: "launch" | "quit"): Promise<void> {
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
  return (
    <section className="desktop-page">
      <header className="desktop-page-heading">
        <div><span>运行诊断</span><h1>状态</h1></div>
        <button type="button" className="secondary-button" onClick={() => void onExport()}><Download size={17} />导出诊断</button>
      </header>
      <div className="status-grid-v2">
        <section className={`managed-status-card ${takeoverReady ? "ready" : "disconnected"}`}>
          <span>会话所有权</span>
          <strong>{takeoverTitle}</strong>
          <p>{takeoverReady
            ? "Claude Desktop 执行时排队，空闲后恢复相同 sessionId 与 transcript。"
            : snapshot.runtime.detail}</p>
          <small>第三方 Host · 无 CDP · 无焦点或剪贴板控制</small>
        </section>
        <section>
          <span>Claude 通道</span>
          <strong>{snapshot.runtime.state === "ready" ? "已就绪" : snapshot.runtime.state === "working" ? "运行中" : "需要处理"}</strong>
          <p>{snapshot.runtime.detail}</p>
          {snapshot.runtime.version && <small>Claude {snapshot.runtime.version}</small>}
        </section>
        <section>
          <span>连接路径</span>
          <strong>{connectionLabel(snapshot)}</strong>
          <p>
            {snapshot.transport?.rttMs !== undefined
              ? `${Math.round(snapshot.transport.rttMs)} ms 延迟`
              : "正在测量延迟"}
            {" · "}{snapshot.transport?.pendingCount ?? 0} 条待发送
          </p>
          <small>
            {snapshot.transport?.relayHealthy ? "Relay 状态正常" : "Relay 健康检查未响应"}
            {" · "}端到端加密
          </small>
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
        <div className="desktop-app-control">
          <span>
            <strong>Claude Desktop</strong>
            <small className={desktopActionError ? "desktop-app-error" : undefined}>
              {desktopActionError || snapshot.claudeDesktop.detail}
            </small>
          </span>
          <div className="desktop-app-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={Boolean(desktopAction) || !snapshot.claudeDesktop.canLaunch}
              onClick={() => void runDesktopAction("launch")}
            >
              <Play size={15} />
              {desktopAction === "launch" ? "启动中" : "启动"}
            </button>
            <button
              type="button"
              className="danger-button"
              disabled={Boolean(desktopAction) || !snapshot.claudeDesktop.canQuit}
              onClick={() => void runDesktopAction("quit")}
            >
              <Power size={15} />
              {desktopAction === "quit" ? "退出中" : "退出"}
            </button>
          </div>
        </div>
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

  useEffect(() => {
    if (!api || tab !== "status") return;
    const timer = window.setInterval(() => {
      void api.getSnapshot().then(setSnapshot).catch(() => undefined);
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [api, tab]);

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
          <span><strong>{snapshot.host.name}</strong><small>{connectionLabel(snapshot)}</small></span>
        </div>
        <IconButton label={theme === "dark" ? "切换浅色" : "切换深色"} onClick={onToggleTheme}>
          {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
        </IconButton>
      </aside>
      <section className="desktop-content-v2">
        {tab === "sessions" && (
          <DesktopSessions
            snapshot={snapshot}
            events={events}
            apiRequest={request}
            onClaudeDesktopLaunch={async () => {
              const next = await api.launchClaudeDesktop();
              setSnapshot(next);
              return next;
            }}
            onClaudeDesktopQuit={async () => {
              const next = await api.quitClaudeDesktop();
              setSnapshot(next);
              return next;
            }}
            onSetAnthropicApiKey={async (value) => {
              setSnapshot(await api.setAnthropicApiKey(value));
            }}
            onRemoveAnthropicApiKey={async () => {
              setSnapshot(await api.removeAnthropicApiKey());
            }}
            onRefreshSnapshot={async () => {
              setSnapshot(await api.getSnapshot());
            }}
          />
        )}
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
            onClaudeDesktopLaunch={async () => setSnapshot(await api.launchClaudeDesktop())}
            onClaudeDesktopQuit={async () => setSnapshot(await api.quitClaudeDesktop())}
            onExport={async () => { await api.exportDiagnostics(); }}
          />
        )}
      </section>
    </main>
  );
}
