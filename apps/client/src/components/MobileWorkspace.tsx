import type {
  BridgeAttachment,
  BridgeArtifactManifest,
  BridgeArtifactPreview,
  BridgeDeliveryState,
  BridgeDesktopRuntimeId,
  BridgeEvidenceBundle,
  BridgeEvent,
  BridgeFileChangeSummary,
  BridgeHistoryItem,
  BridgeHostSnapshot,
  BridgePermissionInfo,
  BridgePermissionMode,
  BridgeRuntimeGoalStatus,
  BridgeRuntimeHandoff,
  BridgeRuntimeHandoffPreview,
  BridgeSessionConfiguration,
  BridgeSessionInfo,
  BridgeTransportMetrics,
  BridgeDesktopAppStatus,
  SocketState,
} from "@bridge/protocol";
import { isClaudeTranscriptControlMessage } from "@bridge/protocol";
import {
  AlertTriangle,
  Archive,
  ArchiveRestore,
  ArrowLeft,
  ArrowRightLeft,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsDown,
  ChevronsUp,
  CircleStop,
  FilePenLine,
  Forward,
  Goal,
  ImagePlus,
  LoaderCircle,
  Moon,
  MoreHorizontal,
  Play,
  Plus,
  Power,
  RefreshCw,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  Sun,
  Terminal,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  LocalTurn,
  MobileConnectionIssue,
  SessionEvidenceState,
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
import { useStreamEntrance } from "../lib/stream-entrance.js";
import { sessionActivity } from "../lib/session-activity.js";
import { ConfirmationDialog } from "./ConfirmationDialog.js";
import { EvidenceInlineSummary, EvidencePanel } from "./EvidencePanel.js";
import { FileChangesCard } from "./FileChangesCard.js";
import { IconButton } from "./IconButton.js";
import {
  SessionConfigurationDialog,
  type SessionConfigurationChange,
} from "./SessionConfigurationDialog.js";
import {
  ProviderSwitchDialog,
  providerName,
  type ProviderSwitchPreview,
  type ProviderSwitchResult,
} from "./ProviderSwitchDialog.js";
import { RuntimeHandoffDialog } from "./RuntimeHandoffDialog.js";
import { SessionActivityIndicator } from "./SessionActivityIndicator.js";

interface ConversationItem extends BridgeHistoryItem {
  delivery?: BridgeDeliveryState;
  requestId?: string;
  commandId?: string;
  live?: boolean;
}

function lastSessionKey(hostId: string): string {
  return `bridge.mobile.last-session.v1:${hostId}`;
}

function readLastSession(hostId: string): string | undefined {
  try {
    return localStorage.getItem(lastSessionKey(hostId)) ?? undefined;
  } catch {
    return undefined;
  }
}

function writeLastSession(hostId: string, sessionId?: string): void {
  try {
    if (sessionId) localStorage.setItem(lastSessionKey(hostId), sessionId);
    else localStorage.removeItem(lastSessionKey(hostId));
  } catch {
    // Session restoration is optional when browser storage is unavailable.
  }
}

export function restorableSessionId(
  candidate: string | undefined,
  sessions: BridgeSessionInfo[],
): string | undefined {
  return candidate && sessions.some((session) => session.sessionId === candidate)
    ? candidate
    : undefined;
}

export type ConversationTimelineEntry =
  | { kind: "message"; item: ConversationItem }
  | { kind: "evidence"; evidence: BridgeEvidenceBundle };

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

export function sessionProfile(session: BridgeSessionInfo): string {
  const model = session.model
    ?.replace(/^claude-/iu, "")
    .replace(/\[1m\]/giu, " 1M")
    .replaceAll("-", " ");
  const native = session.runtimeId === "codex-desktop" || session.runtimeId === "hermes-desktop";
  return [
    native && session.provider ? session.provider : undefined,
    model || "默认模型",
    (native ? session.reasoningEffort : session.effort)?.toLocaleUpperCase(),
    native && session.fast !== undefined ? (session.fast ? "快速" : "标准") : undefined,
  ].filter(Boolean).join(" · ");
}

export function ownershipLabel(session: BridgeSessionInfo): string {
  const bridgeCreated = session.source === "bridge";
  if (session.ownership === "OWNERSHIP_CONFLICT") return "写入冲突";
  if (session.ownership === "FALLBACK_CONFIRMATION_REQUIRED") return "等待接管";
  if (session.ownership === "DESKTOP_OBSERVED" && session.turnState === "running") {
    return "桌面运行中";
  }
  if (session.turnState === "running") return bridgeCreated ? "Bridge 运行中" : "运行中";
  if (session.turnState === "queued") {
    return bridgeCreated
      ? `Bridge · ${session.pendingCount} 条排队`
      : `${session.pendingCount} 条排队`;
  }
  if (session.turnState === "waiting") return "需处理";
  if (bridgeCreated) return "Bridge 待机";
  if (session.transport === "claude-desktop-managed") return "Claude Desktop 同步";
  if (session.runtimeId && session.runtimeId !== "claude-desktop") return `${desktopRuntimeName(session.runtimeId)} 待机`;
  if (session.ownership === "DESKTOP_OBSERVED") return "桌面待机";
  return "待机";
}

export function desktopRuntimeId(session: BridgeSessionInfo): BridgeDesktopRuntimeId {
  return session.runtimeId ?? "claude-desktop";
}

export function desktopRuntimeName(runtimeId: BridgeDesktopRuntimeId | undefined): string {
  if (runtimeId === "codex-desktop") return "Codex Desktop";
  if (runtimeId === "hermes-desktop") return "Hermes Desktop";
  return "Claude Desktop";
}

export function runtimeProviderLabel(runtimeId: BridgeDesktopRuntimeId | undefined): string {
  if (runtimeId === "codex-desktop") return "Codex（ChatGPT）";
  if (runtimeId === "hermes-desktop") return "Hermes";
  return "Claude";
}

function runtimeSupports(
  snapshot: BridgeHostSnapshot | undefined,
  session: BridgeSessionInfo,
  capability: "attachment.image",
): boolean {
  const runtime = snapshot?.runtimes?.find((candidate) => candidate.id === desktopRuntimeId(session));
  return runtime?.capabilities.includes(capability) ?? desktopRuntimeId(session) === "claude-desktop";
}

export function canStopBridgeTask(session: BridgeSessionInfo): boolean {
  if (session.pendingCount > 0 || session.turnState === "queued") return true;
  if (session.turnState !== "running" && session.turnState !== "waiting") return false;
  return session.ownership === "BRIDGE_RUNNING"
    || session.ownership === "DESKTOP_MANAGED_RUNNING";
}

export function supportsProviderSwitching(
  snapshot: BridgeHostSnapshot | undefined,
): boolean {
  return Boolean(
    snapshot?.host.capabilities.includes("provider.profile.v1") &&
    snapshot.host.capabilities.includes("conversation.handoff.v1"),
  );
}

export function supportsRuntimeHandoff(
  snapshot: BridgeHostSnapshot | undefined,
): boolean {
  return Boolean(snapshot?.host.capabilities.includes("runtime.handoff.v1"));
}

export function goalStatusLabel(status: BridgeRuntimeGoalStatus): string {
  if (status === "active") return "goal 执行中";
  if (status === "paused") return "goal 已暂停";
  if (status === "blocked") return "goal 受阻";
  return "goal 已完成";
}

export function usesOfficialComposer(
  session: BridgeSessionInfo,
  providers: NonNullable<BridgeHostSnapshot["providers"]>,
): boolean {
  return providers.find((profile) => profile.id === session.activeProviderProfileId)?.kind
    === "claude-official";
}

export function stoppableBridgeTask(
  sessions: BridgeSessionInfo[],
  selectedSessionId?: string,
): BridgeSessionInfo | undefined {
  const selected = sessions.find((session) => session.sessionId === selectedSessionId);
  if (selected && canStopBridgeTask(selected)) return selected;
  return sessions.find(canStopBridgeTask);
}

function deliveryLabel(state: BridgeDeliveryState): string {
  if (state === "local-saved") return "已保存到手机";
  if (state === "relay-received") return "Relay 已接收";
  if (state === "host-received") return "主机已接收";
  if (state === "session-received") return "会话已接收";
  if (state === "running") return "正在处理中";
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
  const deltaByStream = new Map<string, ConversationItem>();
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
      // Provider stream events can use a new item id for every chunk. The turn is the stable stream identity.
      const id = event.turnId ? `assistant:${event.turnId}` : event.itemId ?? event.eventId;
      const existing = deltaByStream.get(id);
      const text = `${existing?.text ?? ""}${eventText(event)}`;
      deltaByStream.set(id, {
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
      const fileChanges = Array.isArray(event.data.fileChanges)
        ? event.data.fileChanges as BridgeFileChangeSummary[]
        : existing?.fileChanges;
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
        ...(fileChanges?.length ? { fileChanges } : {}),
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
      if (event.data.automatic === true) continue;
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
  for (const item of deltaByStream.values()) items.set(item.id, item);
  for (const item of toolByItem.values()) items.set(item.id, item);
  return [...items.values()].sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
}

export function conversationTimeline(
  items: ConversationItem[],
  evidenceItems: BridgeEvidenceBundle[],
): ConversationTimelineEntry[] {
  const latestByTurn = new Map<string, BridgeEvidenceBundle>();
  for (const evidence of evidenceItems) {
    if (!evidence.turnId || evidence.state === "collecting") continue;
    const previous = latestByTurn.get(evidence.turnId);
    const completedAt = evidence.completedAt ?? evidence.startedAt;
    const previousCompletedAt = previous?.completedAt ?? previous?.startedAt ?? 0;
    if (!previous || completedAt > previousCompletedAt) latestByTurn.set(evidence.turnId, evidence);
  }

  const evidenceAfter = new Map<number, BridgeEvidenceBundle[]>();
  for (const evidence of latestByTurn.values()) {
    const matchingTurnIndexes = items.flatMap((item, index) => (
      item.turnId === evidence.turnId ? [index] : []
    ));
    let anchorIndex = matchingTurnIndexes.at(-1);
    if (anchorIndex === undefined) {
      const userIndex = items.findIndex((item) => (
        item.role === "user" && item.id === evidence.turnId
      ));
      if (userIndex < 0) continue;
      const nextUserOffset = items
        .slice(userIndex + 1)
        .findIndex((item) => item.role === "user");
      anchorIndex = nextUserOffset < 0
        ? items.length - 1
        : userIndex + nextUserOffset;
    }
    const anchored = evidenceAfter.get(anchorIndex) ?? [];
    anchored.push(evidence);
    evidenceAfter.set(anchorIndex, anchored);
  }

  const timeline: ConversationTimelineEntry[] = [];
  items.forEach((item, index) => {
    // File-change tool cards are aggregated Codex-style into the 成果 tab;
    // one card per edit would flood the conversation.
    if (!(item.role === "tool" && item.toolName === "File change")) {
      timeline.push({ kind: "message", item });
    }
    for (const evidence of (evidenceAfter.get(index) ?? [])
      .sort((left, right) => left.startedAt - right.startedAt)) {
      timeline.push({ kind: "evidence", evidence });
    }
  });
  return timeline;
}

export interface FileChangeAggregate {
  path: string;
  kind: BridgeFileChangeSummary["kind"];
  additions: number;
  deletions: number;
}

export interface FileChangesSummary {
  files: FileChangeAggregate[];
  totalAdditions: number;
  totalDeletions: number;
}

export function aggregateFileChanges(items: ConversationItem[]): FileChangesSummary | undefined {
  const byPath = new Map<string, FileChangeAggregate>();
  for (const item of items) {
    if (item.role !== "tool" || !item.fileChanges?.length) continue;
    for (const change of item.fileChanges) {
      const existing = byPath.get(change.path);
      if (existing) {
        existing.kind = change.kind;
        existing.additions += change.additions;
        existing.deletions += change.deletions;
      } else {
        byPath.set(change.path, {
          path: change.path,
          kind: change.kind,
          additions: change.additions,
          deletions: change.deletions,
        });
      }
    }
  }
  if (!byPath.size) return undefined;
  const files = [...byPath.values()].sort(
    (left, right) => (right.additions + right.deletions) - (left.additions + left.deletions),
  );
  return {
    files,
    totalAdditions: files.reduce((sum, file) => sum + file.additions, 0),
    totalDeletions: files.reduce((sum, file) => sum + file.deletions, 0),
  };
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
      || (mutating ? "这项操作会修改电脑上的项目内容" : "当前任务需要确认后才能继续"),
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
        <strong>{permission.title || "当前任务需要你的选择"}</strong>
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
  onEnableFullAccess,
}: {
  permission: BridgePermissionInfo;
  onResolve(
    requestId: string,
    decision: "allow-once" | "allow-always" | "deny",
    message?: string,
    updatedInput?: Record<string, unknown>,
  ): Promise<void>;
  onEnableFullAccess?(sessionId: string): Promise<void>;
}) {
  const presentation = permissionPresentation(permission);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [confirmFullAccess, setConfirmFullAccess] = useState(false);

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

  async function enableFullAccess(): Promise<void> {
    if (!onEnableFullAccess || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await onEnableFullAccess(permission.sessionId);
    } catch (resolveError) {
      setError(resolveError instanceof Error ? resolveError.message : "完全授权设置失败");
    } finally {
      setBusy(false);
      setConfirmFullAccess(false);
    }
  }

  return (
    <>
    <section className="permission-prompt">
      <div className="permission-title">
        <strong>{permission.title || `${permission.toolName} 请求权限`}</strong>
        <span>{presentation.summary}</span>
      </div>
      <div className={`permission-risk ${presentation.mutating ? "mutating" : ""}`}>
        {presentation.mutating ? <AlertTriangle size={16} /> : <Wrench size={16} />}
        <span>{presentation.mutating ? "操作前请核对目标与内容" : "当前任务正在等待你的确认"}</span>
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
        {onEnableFullAccess && (
          <button type="button" className="secondary-button" disabled={busy} onClick={() => setConfirmFullAccess(true)}>
            <ShieldCheck size={15} />完全授权
          </button>
        )}
      </div>
    </section>
    <ConfirmationDialog
      open={confirmFullAccess}
      title="整台电脑启用完全授权"
      description="Bridge 将自动批准命令和文件修改，并立即处理当前积压；模型提出的提问仍需你回答。"
      confirmLabel="启用完全授权"
      busy={busy}
      onCancel={() => setConfirmFullAccess(false)}
      onConfirm={() => void enableFullAccess()}
    />
    </>
  );
}

export function PermissionPrompt({
  permission,
  onResolve,
  onEnableFullAccess,
}: {
  permission: BridgePermissionInfo;
  onResolve(
    requestId: string,
    decision: "allow-once" | "allow-always" | "deny",
    message?: string,
    updatedInput?: Record<string, unknown>,
  ): Promise<void>;
  onEnableFullAccess?(sessionId: string): Promise<void>;
}) {
  return permission.toolName === "AskUserQuestion"
    ? <QuestionPrompt permission={permission} onResolve={onResolve} />
    : (
      <ToolPermissionPrompt
        permission={permission}
        onResolve={onResolve}
        {...(onEnableFullAccess ? { onEnableFullAccess } : {})}
      />
    );
}

export function MobileWorkspace({
  activeHostId,
  desktopName,
  connection,
  desktopOnline,
  snapshot,
  permissions,
  focusSessionId,
  histories,
  evidence,
  artifactPreviews,
  artifactTransfers,
  events,
  localTurns,
  connectionIssue,
  transportMetrics,
  pendingOutbound,
  theme,
  onToggleTheme,
  onOpenSession,
  onLoadOlderHistory,
  onLoadOlderEvidence,
  onPreviewArtifact,
  onDownloadArtifact,
  onSendTurn,
  onInterruptTurn,
  onResolveUncertain,
  onResolvePermission,
  onCreateSession,
  onLoadSessionConfiguration,
  onConfigureSession,
  onConfigurePermissionPolicy,
  onPreviewProviderSwitch,
  onCommitProviderSwitch,
  onCancelProviderSwitch,
  onPreviewRuntimeHandoff,
  onCommitRuntimeHandoff,
  onConfirmRuntimeHandoff,
  onCancelRuntimeHandoff,
  onGetRuntimeHandoff,
  onPauseRuntimeGoal,
  onResumeRuntimeGoal,
  onArchiveSession,
  onDeleteSession,
  onOpenRuntimeFile,
  onRefreshProviders,
  onDesktopAppAction,
  onRefresh,
  onBackToHosts,
  onRetry,
}: {
  activeHostId: string;
  desktopName: string;
  connection: SocketState;
  desktopOnline: boolean;
  snapshot: BridgeHostSnapshot | undefined;
  permissions: BridgePermissionInfo[];
  focusSessionId?: string | undefined;
  histories: Record<string, SessionHistoryState>;
  evidence: Record<string, SessionEvidenceState>;
  artifactPreviews: Record<string, BridgeArtifactPreview>;
  artifactTransfers: Record<string, number>;
  events: BridgeEvent[];
  localTurns: LocalTurn[];
  connectionIssue?: MobileConnectionIssue | undefined;
  transportMetrics?: BridgeTransportMetrics | undefined;
  pendingOutbound: number;
  theme: Theme;
  onToggleTheme(): void;
  onOpenSession(sessionId: string): Promise<void>;
  onLoadOlderHistory(sessionId: string): Promise<void>;
  onLoadOlderEvidence(sessionId: string): Promise<void>;
  onPreviewArtifact(artifactId: string): Promise<BridgeArtifactPreview>;
  onDownloadArtifact(artifact: BridgeArtifactManifest): Promise<void>;
  onSendTurn(sessionId: string, text: string, attachments: BridgeAttachment[], steer: boolean): Promise<void>;
  onInterruptTurn(sessionId: string, commandId?: string): Promise<void>;
  onResolveUncertain(commandId: string, action: "confirm" | "retry"): Promise<void>;
  onResolvePermission(
    requestId: string,
    decision: "allow-once" | "allow-always" | "deny",
    message?: string,
    updatedInput?: Record<string, unknown>,
  ): Promise<void>;
  onCreateSession(
    cwd: string,
    title?: string,
    runtimeId?: BridgeDesktopRuntimeId,
  ): Promise<BridgeSessionInfo | undefined>;
  onLoadSessionConfiguration(sessionId: string): Promise<BridgeSessionConfiguration>;
  onConfigureSession(
    sessionId: string,
    change: SessionConfigurationChange,
  ): Promise<BridgeSessionConfiguration>;
  onConfigurePermissionPolicy?(
    sessionId: string,
    scope: "host" | "session",
    mode: BridgePermissionMode | null,
  ): Promise<BridgeSessionConfiguration>;
  onPreviewProviderSwitch(
    sessionId: string,
    targetProviderProfileId: string,
    model?: string,
  ): Promise<ProviderSwitchPreview>;
  onCommitProviderSwitch(
    handoffId: string,
    targetNativeSessionId?: string,
    model?: string,
  ): Promise<ProviderSwitchResult>;
  onCancelProviderSwitch(handoffId: string): Promise<void>;
  onRefreshProviders(): Promise<void>;
  onPreviewRuntimeHandoff(
    sessionId: string,
    targetRuntimeId: BridgeDesktopRuntimeId,
  ): Promise<BridgeRuntimeHandoffPreview>;
  onCommitRuntimeHandoff(handoffId: string): Promise<BridgeRuntimeHandoff>;
  onConfirmRuntimeHandoff(
    handoffId: string,
    objective?: string,
  ): Promise<{ handoff: BridgeRuntimeHandoff }>;
  onCancelRuntimeHandoff(handoffId: string): Promise<BridgeRuntimeHandoff | undefined>;
  onGetRuntimeHandoff(handoffId: string): Promise<BridgeRuntimeHandoff>;
  onPauseRuntimeGoal(sessionId: string): Promise<void>;
  onResumeRuntimeGoal(sessionId: string): Promise<void>;
  onArchiveSession?(sessionId: string, archived: boolean): Promise<void>;
  onOpenRuntimeFile?(sessionId: string, filePath: string): Promise<void>;
  onDeleteSession?(sessionId: string): Promise<void>;
  onDesktopAppAction(
    runtimeId: BridgeDesktopRuntimeId,
    action: "launch" | "quit",
  ): Promise<BridgeDesktopAppStatus[]>;
  onRefresh(sessionId?: string): Promise<boolean>;
  onBackToHosts(): void;
  onRetry(): Promise<void>;
}) {
  const [selectedSessionId, setSelectedSessionId] = useState<string>();
  const [sessionView, setSessionView] = useState<"conversation" | "evidence">("conversation");
  const [search, setSearch] = useState("");
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<BridgeAttachment[]>([]);
  const [sending, setSending] = useState(false);
  const [steer, setSteer] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createProjectId, setCreateProjectId] = useState("");
  const [createRuntimeId, setCreateRuntimeId] = useState<BridgeDesktopRuntimeId>("claude-desktop");
  const [createTitle, setCreateTitle] = useState("");
  const [createBusy, setCreateBusy] = useState(false);
  const [configurationOpen, setConfigurationOpen] = useState(false);
  const [providerOpen, setProviderOpen] = useState(false);
  const [relayOpen, setRelayOpen] = useState(false);
  const [imageError, setImageError] = useState<string>();
  const [stoppingSessionId, setStoppingSessionId] = useState<string>();
  const [stopError, setStopError] = useState<string>();
  const [permissionOpen, setPermissionOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [syncFlash, setSyncFlash] = useState(false);
  const [menuSessionId, setMenuSessionId] = useState<string>();
  const [deleteSessionConfirmOpen, setDeleteSessionConfirmOpen] = useState(false);
  const [sessionActionBusy, setSessionActionBusy] = useState(false);
  const [sessionActionError, setSessionActionError] = useState<string>();
  const [archivedExpanded, setArchivedExpanded] = useState(false);
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<Set<string>>(() => new Set());
  const [desktopAction, setDesktopAction] = useState<{ runtimeId: BridgeDesktopRuntimeId; action: "launch" | "quit" }>();
  const [desktopActionError, setDesktopActionError] = useState<{ runtimeId: BridgeDesktopRuntimeId; message: string }>();
  const [quitDesktopTarget, setQuitDesktopTarget] = useState<BridgeDesktopRuntimeId>();
  const [runtimeFilter, setRuntimeFilter] = useState<BridgeDesktopRuntimeId | "all">("all");
  const endRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef<HTMLElement>(null);
  const streamScrollState = useRef<{
    sessionId: string | undefined;
    count: number;
    firstKey: string | undefined;
    lastKey: string | undefined;
    height: number;
  }>({ sessionId: undefined, count: 0, firstKey: undefined, lastKey: undefined, height: 0 });
  const fileRef = useRef<HTMLInputElement>(null);
  const handledFocusRef = useRef<string | undefined>(undefined);
  const restoredSessionRef = useRef(false);
  const announcedPermissionsRef = useRef(new Set<string>());

  const sessions = snapshot?.sessions ?? [];
  const selectedSession = sessions.find((session) => session.sessionId === selectedSessionId);
  const providers = snapshot?.providers ?? [];
  const providerSwitchingAvailable = Boolean(
    selectedSession && desktopRuntimeId(selectedSession) === "claude-desktop" && supportsProviderSwitching(snapshot),
  );
  const runtimeHandoffAvailable = supportsRuntimeHandoff(snapshot);
  const selectedHistory = selectedSessionId ? histories[selectedSessionId] : undefined;
  const selectedEvidence = selectedSessionId ? evidence[selectedSessionId] : undefined;
  const items = useMemo(
    () => selectedSessionId
      ? conversationItems(selectedSessionId, selectedHistory, events, localTurns)
      : [],
    [events, localTurns, selectedHistory, selectedSessionId],
  );
  const fileChangesSummary = useMemo(() => aggregateFileChanges(items), [items]);
  const timeline = useMemo(
    () => conversationTimeline(items, selectedEvidence?.items ?? []),
    [items, selectedEvidence?.items],
  );
  const streamKeys = useMemo(() => timeline.map((entry) => (
    entry.kind === "evidence" ? `evidence:${entry.evidence.id}` : entry.item.id
  )), [timeline]);
  const streamEntering = useStreamEntrance(selectedSessionId, streamKeys);
  const activity = useMemo(() => sessionActivity(selectedSession, items), [selectedSession, items]);
  const grouped = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    const filtered = sessions.filter((session) => (
      !session.archivedAt
      && (runtimeFilter === "all" || desktopRuntimeId(session) === runtimeFilter)
      && (!query || `${session.title}\n${session.projectName}\n${session.cwd}`.toLocaleLowerCase().includes(query))
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
  }, [runtimeFilter, search, sessions, snapshot?.projects]);
  const archivedSessions = useMemo(() => sessions.filter((session) => (
    Boolean(session.archivedAt) && (runtimeFilter === "all" || desktopRuntimeId(session) === runtimeFilter)
  )), [runtimeFilter, sessions]);
  const menuSession = menuSessionId ? sessions.find((session) => session.sessionId === menuSessionId) : undefined;
  const canManageSessions = Boolean(onArchiveSession || onDeleteSession);
  const menuSessionBusy = Boolean(menuSession && (
    menuSession.turnState === "running"
    || menuSession.turnState === "queued"
    || menuSession.turnState === "waiting"
  ));
  const groupedProjectIds = useMemo(
    () => grouped.map((group) => group.project?.projectId ?? group.sessions[0]!.projectId),
    [grouped],
  );
  const allProjectsCollapsed = groupedProjectIds.length > 0
    && groupedProjectIds.every((projectId) => collapsedProjectIds.has(projectId));
  const allProjectsExpanded = groupedProjectIds.length > 0
    && groupedProjectIds.every((projectId) => !collapsedProjectIds.has(projectId));

  async function runRefresh(sessionId?: string): Promise<void> {
    if (refreshing) return;
    setRefreshing(true);
    try {
      if (await onRefresh(sessionId)) setSyncFlash(true);
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    if (!syncFlash) return;
    const timer = setTimeout(() => setSyncFlash(false), 2_400);
    return () => clearTimeout(timer);
  }, [syncFlash]);

  useEffect(() => {
    if (!snapshot || restoredSessionRef.current) return;
    restoredSessionRef.current = true;
    const storedSessionId = readLastSession(activeHostId);
    if (!storedSessionId) return;
    const sessionId = restorableSessionId(storedSessionId, sessions);
    if (!sessionId) {
      writeLastSession(activeHostId);
      return;
    }
    void selectSession(sessionId);
  }, [activeHostId, snapshot]);

  useEffect(() => {
    if (!snapshot || !selectedSessionId) return;
    if (restorableSessionId(selectedSessionId, sessions)) return;
    setSelectedSessionId(undefined);
    writeLastSession(activeHostId);
  }, [activeHostId, selectedSessionId, sessions, snapshot]);

  useEffect(() => registerMobileBackHandler(() => {
    if (providerOpen) {
      setProviderOpen(false);
      return true;
    }
    if (relayOpen) {
      setRelayOpen(false);
      return true;
    }
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
    if (deleteSessionConfirmOpen) {
      setDeleteSessionConfirmOpen(false);
      return true;
    }
    if (menuSessionId) {
      setMenuSessionId(undefined);
      return true;
    }
    if (quitDesktopTarget) {
      setQuitDesktopTarget(undefined);
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
    deleteSessionConfirmOpen,
    menuSessionId,
    permissionOpen,
    providerOpen,
    quitDesktopTarget,
    selectedSessionId,
  ]);

  useLayoutEffect(() => {
    const stream = streamRef.current;
    if (!stream || !selectedSessionId) return;
    const firstKey = streamKeys[0];
    const lastKey = streamKeys[streamKeys.length - 1];
    const previous = streamScrollState.current;
    streamScrollState.current = {
      sessionId: selectedSessionId,
      count: streamKeys.length,
      firstKey,
      lastKey,
      height: stream.scrollHeight,
    };
    const jump = () => endRef.current?.scrollIntoView({ block: "end" });
    if (previous.sessionId !== selectedSessionId) {
      jump();
      return;
    }
    const added = streamKeys.length - previous.count;
    // Older history prepended above: keep the reading position anchored.
    if (added > 0 && firstKey !== previous.firstKey && lastKey === previous.lastKey) {
      stream.scrollTop += stream.scrollHeight - previous.height;
      return;
    }
    // A bulk (re)load lands at the bottom instantly.
    if (added > 6) {
      jump();
      return;
    }
    // Live appends and streaming text growth follow smoothly only while
    // pinned to the bottom; reading higher up is never interrupted.
    const pinnedToBottom = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 120;
    if (!pinnedToBottom) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    endRef.current?.scrollIntoView({ block: "end", behavior: reduced ? "auto" : "smooth" });
  }, [streamKeys, selectedSessionId]);

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
    setSessionView("conversation");
    setStopError(undefined);
    setSelectedSessionId(sessionId);
    writeLastSession(activeHostId, sessionId);
    await onOpenSession(sessionId);
  }

  function toggleProject(projectId: string): void {
    setCollapsedProjectIds((current) => toggleCollapsedProject(current, projectId));
  }

  async function runDesktopAppAction(runtimeId: BridgeDesktopRuntimeId, action: "launch" | "quit"): Promise<void> {
    if (desktopAction) return;
    if (action === "quit") setQuitDesktopTarget(undefined);
    setDesktopAction({ runtimeId, action });
    setDesktopActionError(undefined);
    try {
      await onDesktopAppAction(runtimeId, action);
    } catch (error) {
      setDesktopActionError({
        runtimeId,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setDesktopAction(undefined);
    }
  }

  async function sendMessage(): Promise<void> {
    if (
      !selectedSession ||
      selectedSession.allowedActions?.canSend === false ||
      sending ||
      (!text.trim() && (!runtimeSupports(snapshot, selectedSession, "attachment.image") || attachments.length === 0))
    ) return;
    const nextText = text.trim();
    const nextAttachments = runtimeSupports(snapshot, selectedSession, "attachment.image") ? attachments : [];
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

  async function stopTask(sessionId: string): Promise<void> {
    if (stoppingSessionId) return;
    setStoppingSessionId(sessionId);
    setStopError(undefined);
    try {
      await onInterruptTurn(sessionId);
    } catch (error) {
      setStopError(error instanceof Error ? error.message : "任务停止失败");
    } finally {
      setStoppingSessionId(undefined);
    }
  }

  async function archiveSessionById(sessionId: string, archived: boolean): Promise<void> {
    if (!onArchiveSession || sessionActionBusy) return;
    setSessionActionBusy(true);
    setSessionActionError(undefined);
    try {
      await onArchiveSession(sessionId, archived);
      setMenuSessionId(undefined);
    } catch (error) {
      setSessionActionError(error instanceof Error ? error.message : "归档设置失败");
    } finally {
      setSessionActionBusy(false);
    }
  }

  async function deleteSessionById(sessionId: string): Promise<void> {
    if (!onDeleteSession || sessionActionBusy) return;
    setSessionActionBusy(true);
    setSessionActionError(undefined);
    try {
      await onDeleteSession(sessionId);
      setDeleteSessionConfirmOpen(false);
      setMenuSessionId(undefined);
    } catch (error) {
      setSessionActionError(error instanceof Error ? error.message : "删除会话失败");
    } finally {
      setSessionActionBusy(false);
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
      const created = await onCreateSession(
        project.cwd,
        createTitle.trim() || undefined,
        createRuntimeId,
      );
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
    const runtimeName = desktopRuntimeName(desktopRuntimeId(selectedSession));
    const canAttachImages = runtimeSupports(snapshot, selectedSession, "attachment.image");
    const canConfigure = selectedSession.allowedActions?.canConfigure === true
      || (desktopRuntimeId(selectedSession) === "claude-desktop"
        && selectedSession.allowedActions?.canConfigure !== false);
    const officialActive = usesOfficialComposer(selectedSession, providers);
    const bridgeRunning = selectedSession.turnState === "running"
      && (
        selectedSession.ownership === "BRIDGE_RUNNING" ||
        selectedSession.ownership === "DESKTOP_MANAGED_RUNNING"
      );
    const stopTarget = stoppableBridgeTask(sessions, selectedSession.sessionId);
    const canStop = Boolean(stopTarget);
    const stopping = stoppingSessionId === stopTarget?.sessionId;
    const stoppingBlocker = Boolean(stopTarget && stopTarget.sessionId !== selectedSession.sessionId);
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
              <i />{runtimeName} · {ownershipLabel(selectedSession)}
            </span>
          </div>
        </header>
        <div className="session-action-strip" role="toolbar" aria-label="会话操作">
          {providerSwitchingAvailable && (
            <button
              type="button"
              className="session-provider-trigger"
              onClick={() => setProviderOpen(true)}
            >
              <ArrowRightLeft size={14} />
              <span>{providerName(selectedSession.activeProviderProfileId, providers)}</span>
            </button>
          )}
          {runtimeHandoffAvailable && selectedSession.allowedActions?.canRelay !== false && (
            <button
              type="button"
              className="session-provider-trigger"
              onClick={() => setRelayOpen(true)}
            >
              <Forward size={14} />
              <span>接力</span>
            </button>
          )}
          {!providerSwitchingAvailable && !runtimeHandoffAvailable && desktopRuntimeId(selectedSession) !== "claude-desktop" && (
            <span
              className="session-provider-trigger is-static"
              title={`${runtimeName} 是独立的会话域，不提供跨 Desktop 接力`}
            >
              <ArrowRightLeft size={14} />
              <span>{runtimeProviderLabel(desktopRuntimeId(selectedSession))}</span>
            </span>
          )}
          {canConfigure && (
            <button
              type="button"
              className="session-provider-trigger"
              onClick={() => setConfigurationOpen(true)}
            >
              <Settings2 size={14} />
              <span>{sessionProfile(selectedSession)}</span>
            </button>
          )}
          {canStop && (
            <button
              type="button"
              className="session-provider-trigger is-stop"
              disabled={stopping}
              onClick={() => stopTarget && void stopTask(stopTarget.sessionId)}
            >
              {stopping ? <LoaderCircle className="is-spinning" size={14} /> : <CircleStop size={14} />}
              <span>{stopping ? "停止中" : stoppingBlocker ? "停止阻塞任务" : "停止"}</span>
            </button>
          )}
          <button
            type="button"
            className="session-provider-trigger"
            disabled={refreshing}
            onClick={() => void runRefresh(selectedSession.sessionId)}
          >
            {refreshing ? <LoaderCircle className="is-spinning" size={14} /> : syncFlash ? <Check size={14} /> : <RefreshCw size={14} />}
            <span>{syncFlash ? "已同步" : "同步"}</span>
          </button>
        </div>

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
        {selectedSession.goal && (
          <div className={`session-channel-warning goal-status ${selectedSession.goal.status}`}>
            <Goal size={17} />
            <span>
              <strong>{goalStatusLabel(selectedSession.goal.status)}</strong>
              {selectedSession.goal.objective}
              {selectedSession.goal.detail ? ` · ${selectedSession.goal.detail}` : ""}
              {selectedSession.goal.continuations > 0 ? ` · 已续跑 ${selectedSession.goal.continuations} 轮` : ""}
            </span>
            {selectedSession.goal.status === "active" ? (
              <button
                type="button"
                className="secondary-button goal-action"
                onClick={() => void onPauseRuntimeGoal(selectedSession.sessionId).catch(() => undefined)}
              >
                暂停目标
              </button>
            ) : selectedSession.goal.status !== "complete" ? (
              <button
                type="button"
                className="secondary-button goal-action"
                onClick={() => void onResumeRuntimeGoal(selectedSession.sessionId).catch(() => undefined)}
              >
                继续目标
              </button>
            ) : null}
          </div>
        )}
        {(selectedSession.relay?.inbound || selectedSession.relay?.outbound?.length) && (
          <div className="relay-chain-bar">
            {selectedSession.relay.inbound && (
              <button
                type="button"
                className="relay-chain-link"
                onClick={() => void selectSession(selectedSession.relay!.inbound!.sessionId)}
              >
                <Forward size={14} />
                {`接力自 ${selectedSession.relay.inbound.title}`}
              </button>
            )}
            {selectedSession.relay.outbound?.map((link) => (
              <button
                type="button"
                className="relay-chain-link outbound"
                key={link.handoffId}
                onClick={() => void selectSession(link.sessionId)}
              >
                <Forward size={14} />
                {`接力至 ${link.title}`}
              </button>
            ))}
          </div>
        )}
        {stopError && (
          <div className="session-channel-warning danger">
            <AlertTriangle size={17} />
            <span><strong>任务停止失败</strong>{stopError}</span>
          </div>
        )}
        {providerSwitchingAvailable && selectedSession.routeState && selectedSession.routeState !== "ready" && (
          <button
            type="button"
            className="session-channel-warning provider-route-banner"
            onClick={() => setProviderOpen(true)}
          >
            <ArrowRightLeft size={17} />
            <span>
              <strong>{selectedSession.routeState === "awaiting-user-confirmation"
                ? "等待本机确认"
                : selectedSession.routeState === "awaiting-target-selection"
                  ? "选择 Claude 官方会话"
                  : selectedSession.routeState === "failed"
                    ? "提供方切换未完成"
                    : "正在切换执行通道"}</strong>
              {selectedSession.pendingHandoff?.summary ?? "原执行通道保持活动。"}
            </span>
          </button>
        )}

        <nav className="session-view-switch" aria-label="会话视图">
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

        <div className={`permission-dock-slot ${activePermission || otherPermission ? "has-attention" : ""}`}>
          {activePermission ? (
            <button type="button" className="permission-dock" onClick={() => setPermissionOpen(true)}>
              <span className="permission-dock-icon"><AlertTriangle size={18} /></span>
              <span><strong>{runtimeName} 正在等待授权</strong><small>{activePermission.title || activePermission.displayName || activePermission.toolName}</small></span>
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

        {sessionView === "conversation" ? (
        <section className="conversation-stream" aria-live="polite" ref={streamRef}>
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
          {timeline.map((entry) => entry.kind === "evidence" ? (
            <EvidenceInlineSummary
              evidence={entry.evidence}
              key={`evidence:${entry.evidence.id}`}
              entering={streamEntering(`evidence:${entry.evidence.id}`)}
              onOpen={() => setSessionView("evidence")}
            />
          ) : (
            <article
              className={`conversation-item ${entry.item.role} ${entry.item.live ? "live" : ""}${streamEntering(entry.item.id) ? " is-entering" : ""}`}
              key={entry.item.id}
            >
              <div className="conversation-item-meta">
                <strong>{entry.item.role === "user" ? "你" : entry.item.role === "assistant" ? runtimeName : entry.item.role === "tool" ? entry.item.toolName : "Bridge"}</strong>
                <time>{formatTime(entry.item.createdAt)}</time>
              </div>
              {entry.item.role === "tool" && <Wrench size={16} aria-hidden="true" />}
              {entry.item.text && <div className="conversation-text">{entry.item.text}</div>}
              {entry.item.attachments?.length ? (
                <div className="conversation-attachments">
                  {entry.item.attachments.map((attachment) => attachment.data ? (
                    <img key={attachment.id} src={`data:${attachment.mimeType};base64,${attachment.data}`} alt={attachment.name} loading="lazy" />
                  ) : (
                    <span className="attachment-chip" key={attachment.id}>{attachment.name}</span>
                  ))}
                </div>
              ) : null}
              {entry.item.delivery && <div className={`delivery-state ${entry.item.delivery}`}>{deliveryLabel(entry.item.delivery)}</div>}
              {entry.item.delivery === "uncertain" && entry.item.commandId && (
                <div className="uncertain-delivery-actions">
                  <button type="button" className="secondary-button" onClick={() => void onResolveUncertain(entry.item.commandId!, "confirm")}>确认已发送</button>
                  <button type="button" className="secondary-button" onClick={() => void onResolveUncertain(entry.item.commandId!, "retry")}>检查后重发</button>
                </div>
              )}
              {entry.item.live && <span className="stream-caret" aria-label="正在生成" />}
            </article>
          ))}
          <div ref={endRef} />
        </section>
        ) : (
          <section className="mobile-evidence-view">
            {fileChangesSummary && (
              <FileChangesCard
                summary={fileChangesSummary}
                {...(onOpenRuntimeFile ? {
                  onOpenFile: (filePath) => void onOpenRuntimeFile(selectedSession.sessionId, filePath),
                } : {})}
              />
            )}
            <EvidencePanel
              state={selectedEvidence}
              previews={artifactPreviews}
              transfers={artifactTransfers}
              online={connection === "connected" && desktopOnline}
              suppressEmpty={Boolean(fileChangesSummary)}
              onLoadMore={() => onLoadOlderEvidence(selectedSession.sessionId)}
              onPreview={onPreviewArtifact}
              onDownload={onDownloadArtifact}
            />
          </section>
        )}

        {sessionView === "conversation" && (
        <>
        <SessionActivityIndicator activity={activity} />
        <section className="mobile-composer">
          {officialActive ? (
            <button
              type="button"
              className="official-continue-button"
              onClick={() => void onDesktopAppAction("claude-desktop", "launch")}
            >
              <ArrowRightLeft size={18} />
              在 Claude 官方继续
            </button>
          ) : (
          <>
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
          {bridgeRunning && selectedSession.allowedActions?.canSteer !== false && (
            <div className="composer-mode" role="group" aria-label="发送方式">
              <button type="button" className={!steer ? "active" : ""} onClick={() => setSteer(false)}>排到下一轮</button>
              <button type="button" className={steer ? "active" : ""} onClick={() => setSteer(true)}>立即调整</button>
            </div>
          )}
          <form
            className={canAttachImages ? "composer-form composer-form--with-attachment" : "composer-form"}
            onSubmit={(event) => { event.preventDefault(); void sendMessage(); }}
          >
            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/gif,image/webp"
              multiple
              hidden
              onChange={(event) => void addImages(event.target.files)}
            />
            {canAttachImages && (
              <IconButton
                label="添加图片"
                disabled={selectedSession.allowedActions?.canSend === false}
                onClick={() => fileRef.current?.click()}
              >
                <ImagePlus size={20} />
              </IconButton>
            )}
            <textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              disabled={selectedSession.allowedActions?.canSend === false}
              placeholder={desktopOnline
                ? selectedSession.allowedActions?.reason ?? (
                    selectedSession.source === "bridge"
                      ? "给这个 Bridge 会话发指令"
                      : `给这个 ${runtimeName} 会话发指令`
                  )
                : "电脑离线，消息会保存在手机并自动送达"}
              rows={1}
              aria-label={`给 ${runtimeName} 发指令`}
            />
            <button
              type="submit"
              className="send-button"
              aria-label="发送"
              disabled={selectedSession.allowedActions?.canSend === false || sending || (!text.trim() && (!canAttachImages || attachments.length === 0))}
            >
              {sending ? <LoaderCircle className="is-spinning" size={19} /> : <Send size={19} />}
            </button>
          </form>
          </>
          )}
        </section>
        </>
        )}
        {providerOpen && providerSwitchingAvailable && (
          <ProviderSwitchDialog
            session={selectedSession}
            profiles={providers}
            onPreview={(targetProviderProfileId, model) => (
              onPreviewProviderSwitch(selectedSession.sessionId, targetProviderProfileId, model)
            )}
            onCommit={onCommitProviderSwitch}
            onCancel={onCancelProviderSwitch}
            onRefresh={async () => {
              await onRefreshProviders();
              await onRefresh();
            }}
            onChanged={() => void onRefresh()}
            onClose={() => setProviderOpen(false)}
          />
        )}
        {relayOpen && runtimeHandoffAvailable && (
          <RuntimeHandoffDialog
            session={selectedSession}
            runtimes={snapshot?.runtimes ?? []}
            onPreview={(targetRuntimeId) => onPreviewRuntimeHandoff(selectedSession.sessionId, targetRuntimeId)}
            onCommit={onCommitRuntimeHandoff}
            onConfirm={onConfirmRuntimeHandoff}
            onCancel={onCancelRuntimeHandoff}
            onGet={onGetRuntimeHandoff}
            onOpenSession={(sessionId) => void selectSession(sessionId)}
            onClose={() => setRelayOpen(false)}
          />
        )}
        {configurationOpen && canConfigure && (
          <SessionConfigurationDialog
            session={selectedSession}
            onLoad={() => onLoadSessionConfiguration(selectedSession.sessionId)}
            onSave={(change) => onConfigureSession(selectedSession.sessionId, change)}
            {...(onConfigurePermissionPolicy ? {
              onConfigurePermission: (scope: "host" | "session", mode: BridgePermissionMode | null) => (
                onConfigurePermissionPolicy(selectedSession.sessionId, scope, mode)
              ),
            } : {})}
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
                  <h2 id="permission-sheet-title">{runtimeName} 等待授权</h2>
                </div>
                <IconButton label="暂时关闭" onClick={() => setPermissionOpen(false)}><X size={19} /></IconButton>
              </header>
              {sessionPermissions.length > 1 && <div className="permission-queue-count">还有 {sessionPermissions.length} 项待处理，提交后自动显示下一项。</div>}
              <PermissionPrompt
                permission={activePermission}
                onResolve={onResolvePermission}
                {...(onConfigurePermissionPolicy ? {
                  onEnableFullAccess: (sessionId: string) => (
                    onConfigurePermissionPolicy(sessionId, "host", "full-access").then(() => undefined)
                  ),
                } : {})}
              />
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
        <IconButton
          label="强制同步"
          disabled={refreshing}
          onClick={() => void runRefresh(selectedSessionId)}
        >
          {refreshing ? <LoaderCircle className="is-spinning" size={19} /> : syncFlash ? <Check size={19} /> : <RefreshCw size={19} />}
        </IconButton>
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
            <span>Bridge 0.7</span>
            <h1>项目与会话</h1>
          </div>
          <button
            type="button"
            className="primary-button"
            disabled={!snapshot?.projects.length}
            onClick={() => {
              const runtimeId = runtimeFilter === "all"
                ? snapshot?.runtimes?.find((runtime) => (
                    runtime.state === "ready" && runtime.capabilities.includes("session.create")
                  ))?.id ?? "claude-desktop"
                : runtimeFilter;
              setCreateRuntimeId(runtimeId);
              setCreateProjectId(
                snapshot?.projects.find((project) => project.runtimeId === runtimeId)?.projectId
                ?? snapshot?.projects[0]?.projectId
                ?? "",
              );
              setCreateOpen(true);
            }}
          >
            <Plus size={17} />新建
          </button>
        </div>
        {(snapshot?.runtimes?.length ?? 0) > 0 && (
          <nav className="runtime-filter" aria-label="Desktop 运行时筛选">
            <button type="button" className={runtimeFilter === "all" ? "active" : ""} onClick={() => setRuntimeFilter("all")}>全部</button>
            {snapshot!.runtimes!.map((runtime) => (
              <button
                type="button"
                key={runtime.id}
                className={runtimeFilter === runtime.id ? "active" : ""}
                disabled={runtime.state !== "ready" && runtime.sessionCount === 0}
                onClick={() => setRuntimeFilter(runtime.id)}
              >
                {desktopRuntimeName(runtime.id)}
              </button>
            ))}
          </nav>
        )}
        {(snapshot?.desktopApps ?? [{
          id: "claude-desktop" as const,
          name: "Claude Desktop",
          state: snapshot?.claudeDesktop?.state ?? "unavailable",
          detail: snapshot?.claudeDesktop?.detail ?? "正在读取电脑端运行状态。",
          canLaunch: snapshot?.claudeDesktop?.canLaunch ?? false,
          canQuit: snapshot?.claudeDesktop?.canQuit ?? false,
        }]).map((desktopApp) => (
          <section className={`mobile-desktop-control ${desktopApp.state}`} key={desktopApp.id}>
            <div className="mobile-desktop-control-copy">
              <i aria-hidden="true" />
              <span>
                <strong>{desktopApp.name}</strong>
                <small className={desktopActionError?.runtimeId === desktopApp.id ? "desktop-app-error" : undefined}>
                  {desktopActionError?.runtimeId === desktopApp.id ? desktopActionError.message : desktopApp.detail}
                </small>
              </span>
            </div>
            <div className="mobile-desktop-control-actions">
              <button
                type="button"
                className="secondary-button"
                disabled={Boolean(desktopAction) || !desktopOnline || !desktopApp.canLaunch}
                onClick={() => void runDesktopAppAction(desktopApp.id, "launch")}
              >
                <Play size={15} />
                {desktopAction?.runtimeId === desktopApp.id && desktopAction.action === "launch" ? "启动中" : "启动"}
              </button>
              <button
                type="button"
                className="danger-button"
                disabled={Boolean(desktopAction) || !desktopOnline || !desktopApp.canQuit}
                onClick={() => setQuitDesktopTarget(desktopApp.id)}
              >
                <Power size={15} />
                {desktopAction?.runtimeId === desktopApp.id && desktopAction.action === "quit" ? "退出中" : "退出"}
              </button>
            </div>
          </section>
        ))}
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
              <strong>Desktop 任务正在等待处理</strong>
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
            <strong>{search ? "没有匹配的会话" : "暂未发现 Desktop 会话"}</strong>
            <span>{search ? "换一个关键词试试。" : "启动目标 Desktop 后，Bridge 会自动读取其独立会话。"}</span>
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
                      <div className="session-row-v2" data-session-id={session.sessionId} key={session.sessionId}>
                        <button
                          type="button"
                          className="session-row-hit"
                          onClick={() => void selectSession(session.sessionId)}
                        >
                          <span className={`session-state-dot ${session.turnState}`} />
                          <span className="session-row-copy">
                            <strong>{session.title}</strong>
                            <small>{desktopRuntimeName(desktopRuntimeId(session))} · {relativeTime(session.lastActivityAt)}{session.currentSummary ? ` · ${session.currentSummary}` : ""}</small>
                          </span>
                          <span className="session-row-status">{ownershipLabel(session)}</span>
                          <ChevronRight size={18} />
                        </button>
                        {canManageSessions && (
                          <IconButton
                            label="会话操作"
                            className="session-row-action"
                            onClick={() => {
                              setSessionActionError(undefined);
                              setMenuSessionId(session.sessionId);
                            }}
                          >
                            <MoreHorizontal size={18} />
                          </IconButton>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </section>
            );
          })}
          {canManageSessions && archivedSessions.length > 0 && (
            <section className={`project-group archived-group ${archivedExpanded ? "expanded" : "collapsed"}`}>
              <button
                type="button"
                className="project-group-toggle"
                aria-expanded={archivedExpanded}
                aria-controls="mobile-archived-sessions"
                onClick={() => setArchivedExpanded((current) => !current)}
              >
                <span className="project-group-toggle-copy">
                  <span>
                    <strong>已归档</strong>
                    <b>{archivedSessions.length} 个会话</b>
                  </span>
                  <small>归档会话保留历史，可随时恢复</small>
                </span>
                {archivedExpanded ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
              </button>
              {archivedExpanded && (
                <div className="session-rows" id="mobile-archived-sessions">
                  {archivedSessions.map((session) => (
                    <div className="session-row-v2" data-session-id={session.sessionId} key={session.sessionId}>
                      <button
                        type="button"
                        className="session-row-hit"
                        onClick={() => void selectSession(session.sessionId)}
                      >
                        <span className={`session-state-dot ${session.turnState}`} />
                        <span className="session-row-copy">
                          <strong>{session.title}</strong>
                          <small>{desktopRuntimeName(desktopRuntimeId(session))} · {relativeTime(session.lastActivityAt)}</small>
                        </span>
                        <span className="session-row-status">已归档</span>
                        <ChevronRight size={18} />
                      </button>
                      {canManageSessions && (
                        <IconButton
                          label="会话操作"
                          className="session-row-action"
                          onClick={() => {
                            setSessionActionError(undefined);
                            setMenuSessionId(session.sessionId);
                          }}
                        >
                          <MoreHorizontal size={18} />
                        </IconButton>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}
        </div>
      </section>

      {menuSession && canManageSessions && (
        <div className="permission-sheet-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !sessionActionBusy) setMenuSessionId(undefined);
        }}>
          <section className="permission-sheet session-menu-sheet" role="dialog" aria-modal="true" aria-labelledby="session-menu-title">
            <header>
              <div>
                <span>会话操作</span>
                <h2 id="session-menu-title">{menuSession.title}</h2>
              </div>
              <IconButton label="关闭" disabled={sessionActionBusy} onClick={() => setMenuSessionId(undefined)}><X size={19} /></IconButton>
            </header>
            <div className="session-menu-actions">
              {onArchiveSession && (
                menuSession.archivedAt ? (
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={sessionActionBusy}
                    onClick={() => void archiveSessionById(menuSession.sessionId, false)}
                  >
                    <ArchiveRestore size={17} />取消归档
                  </button>
                ) : (
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={sessionActionBusy}
                    onClick={() => void archiveSessionById(menuSession.sessionId, true)}
                  >
                    <Archive size={17} />归档会话
                  </button>
                )
              )}
              {onDeleteSession && (
                <button
                  type="button"
                  className="secondary-button danger-text"
                  disabled={sessionActionBusy || menuSessionBusy || Boolean(menuSession.pendingRuntimeHandoff)}
                  onClick={() => setDeleteSessionConfirmOpen(true)}
                >
                  <Trash2 size={17} />删除会话
                </button>
              )}
            </div>
            {(menuSessionBusy || menuSession.pendingRuntimeHandoff) && onDeleteSession && (
              <p className="session-menu-hint">任务或接力进行中，先停止再删除。</p>
            )}
            {sessionActionError && <p className="session-menu-hint danger-text">{sessionActionError}</p>}
          </section>
        </div>
      )}
      <ConfirmationDialog
        open={deleteSessionConfirmOpen && Boolean(menuSession)}
        title="删除会话"
        description={`从 Bridge 列表中删除「${menuSession?.title ?? ""}」？对应 Desktop 应用中的原生会话与文件不受影响；Bridge 中的会话配置、排队与授权记录会被清除，此操作不可恢复。`}
        confirmLabel="删除会话"
        danger
        busy={sessionActionBusy}
        onCancel={() => setDeleteSessionConfirmOpen(false)}
        onConfirm={() => menuSession && void deleteSessionById(menuSession.sessionId)}
      />

      {createOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setCreateOpen(false);
        }}>
          <section className="create-session-dialog" role="dialog" aria-modal="true" aria-labelledby="create-session-title">
            <header>
              <h2 id="create-session-title">新建会话</h2>
              <IconButton label="关闭" onClick={() => setCreateOpen(false)}><X size={19} /></IconButton>
            </header>
            <label>
              <span>Desktop 运行时</span>
              <select
                value={createRuntimeId}
                onChange={(event) => {
                  const runtimeId = event.target.value as BridgeDesktopRuntimeId;
                  setCreateRuntimeId(runtimeId);
                  setCreateProjectId(
                    snapshot?.projects.find((project) => project.runtimeId === runtimeId)?.projectId
                    ?? snapshot?.projects[0]?.projectId
                    ?? "",
                  );
                }}
              >
                {snapshot?.runtimes?.map((runtime) => (
                  <option
                    value={runtime.id}
                    key={runtime.id}
                    disabled={runtime.state !== "ready" || !runtime.capabilities.includes("session.create")}
                  >
                    {desktopRuntimeName(runtime.id)}{runtime.state === "ready" ? "" : "（不可用）"}
                  </option>
                ))}
              </select>
            </label>
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
        open={Boolean(quitDesktopTarget)}
        title={`退出电脑上的 ${quitDesktopTarget ? desktopRuntimeName(quitDesktopTarget) : ""}？`}
        description={`${quitDesktopTarget ? desktopRuntimeName(quitDesktopTarget) : ""} 窗口会关闭，Bridge 主机仍保持在线，可继续管理已接管的远程会话。`}
        confirmLabel={`退出 ${quitDesktopTarget ? desktopRuntimeName(quitDesktopTarget) : ""}`}
        busy={desktopAction?.action === "quit"}
        danger
        onCancel={() => setQuitDesktopTarget(undefined)}
        onConfirm={() => {
          if (quitDesktopTarget) void runDesktopAppAction(quitDesktopTarget, "quit");
        }}
      />
    </main>
  );
}
