import {
  BridgeCrypto,
  RelayTransport,
  TransportRouter,
  WebRtcTransport,
  bridgeEndpoint,
  bridgeIceServers,
  cryptoWithRelayEndpoint,
  normalizeBridgeEndpoints,
  preferredBridgeIceServers,
  randomId,
  type BridgeAttachment,
  type BridgeDeliveryState,
  type BridgeDesktopAppStatus,
  type BridgeDesktopRuntimeId,
  type BridgeEndpoint,
  type BridgeEvidenceBundle,
  type BridgeEvidencePage,
  type BridgeEvent,
  type BridgeHistoryPage,
  type BridgeHostSnapshot,
  type BridgePayload,
  type BridgeArtifactManifest,
  type BridgeArtifactPreview,
  type BridgeConversationRoute,
  type BridgeHandoff,
  type BridgePermissionInfo,
  type BridgePermissionMode,
  type BridgeProviderProfile,
  type BridgeRequest,
  type BridgeResponse,
  type BridgeRuntimeGoalInfo,
  type BridgeRuntimeHandoff,
  type BridgeRuntimeHandoffPreview,
  type BridgeSessionConfiguration,
  type BridgeSessionInfo,
  type BridgeTransport,
  type BridgeTransportCandidate,
  type BridgeTransportMetrics,
  type BridgeTransportPath,
  type ClaudeDesktopAppStatus,
  type DecryptedEnvelope,
  type EncryptedEnvelope,
  type PairingBundle,
  type SocketState,
} from "@bridge/protocol";
import { App as CapacitorApp } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { bridgeVault, type StoredBridgeHost } from "../lib/vault.js";
import { downloadBridgeArtifact } from "../lib/artifact-download.js";
import { isReplayableMobileEnvelope } from "../lib/outbox.js";
import { nativePushRegistration, onNativePushWake } from "../lib/push-wake.js";

export interface PairedHost {
  hostId: string;
  roomId: string;
  desktopName: string;
  relayUrl: string;
  needsRepair: boolean;
  status: "standby" | "running" | "attention" | "offline";
  lastSeenAt?: number;
  activeTurns: number;
  attentionSessionId?: string;
  path: BridgeTransportPath;
}

export interface MobileConnectionIssue {
  code: "unreachable" | "pairing-invalid" | "revoked" | "waiting-link";
  message: string;
}

/**
 * Send gate for the dual-relay topology. Public relays keep independent room
 * queues, so an envelope is only safe to hand to the current connection when:
 * - a direct WebRTC peer to the desktop is open (the desktop is right there);
 * - the desktop was observed on THIS connection (presence or fresh traffic);
 * - no desktop home relay is known yet (first contact, legacy behavior); or
 * - the current connection IS the desktop's home relay — storing there is
 *   safe even with the desktop offline, because it drains that queue on
 *   return.
 * Anything else would store the envelope on a relay the desktop may never
 * visit again: the old behavior showed "Relay 已接收" while the message
 * silently rotted (proxy apps pull the phone onto the overseas relay).
 */
export function relayLinkAllowsSend(link: {
  homeRelayUrl?: string | undefined;
  currentRelayUrl: string;
  desktopHere: boolean;
  directPeer: boolean;
}): boolean {
  if (link.directPeer) return true;
  if (link.desktopHere) return true;
  if (!link.homeRelayUrl) return true;
  return link.currentRelayUrl === link.homeRelayUrl;
}

/** A queued envelope this fresh can still prove where the desktop lives;
 *  older ones may come from a relay the desktop has long since left. */
const HOME_LEARN_FRESHNESS_MS = 3 * 60_000;

export interface SessionHistoryState {
  status: "idle" | "loading" | "ready" | "error";
  items: BridgeHistoryPage["items"];
  nextCursor?: string;
  hasMore: boolean;
  error?: string;
}

export interface SessionEvidenceState {
  status: "idle" | "loading" | "ready" | "error";
  items: BridgeEvidenceBundle[];
  nextCursor?: string;
  hasMore: boolean;
}

export interface LocalTurn {
  requestId: string;
  idempotencyKey: string;
  sessionId: string;
  text: string;
  attachments: Array<Omit<BridgeAttachment, "data">>;
  createdAt: number;
  delivery: BridgeDeliveryState;
  commandId?: string;
  error?: string;
}

export type PairingSyncStage = "connecting" | "verifying" | "syncing" | "ready";

export interface PairingSyncState {
  roomId: string;
  desktopName: string;
  stage: PairingSyncStage;
  progress: number;
}

interface PendingResponse {
  resolve(response: BridgeResponse): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface PairingConnectionPhase {
  provisional: boolean;
}

interface MobileBridgeState {
  loading: boolean;
  hosts: PairedHost[];
  activeHostId: string | undefined;
  desktopName: string | undefined;
  connection: SocketState;
  desktopOnline: boolean;
  snapshot: BridgeHostSnapshot | undefined;
  permissions: BridgePermissionInfo[];
  focusSessionId: string | undefined;
  histories: Record<string, SessionHistoryState>;
  evidence: Record<string, SessionEvidenceState>;
  artifactPreviews: Record<string, BridgeArtifactPreview>;
  artifactTransfers: Record<string, number>;
  events: BridgeEvent[];
  localTurns: LocalTurn[];
  latestSeq: number;
  connectionIssue: MobileConnectionIssue | undefined;
  transportMetrics: BridgeTransportMetrics | undefined;
  pendingOutbound: number;
  pairingSync: PairingSyncState | undefined;
  error: string | undefined;
}

const INITIAL_STATE: MobileBridgeState = {
  loading: true,
  hosts: [],
  activeHostId: undefined,
  desktopName: undefined,
  connection: "idle",
  desktopOnline: false,
  snapshot: undefined,
  permissions: [],
  focusSessionId: undefined,
  histories: {},
  evidence: {},
  artifactPreviews: {},
  artifactTransfers: {},
  events: [],
  localTurns: [],
  latestSeq: 0,
  connectionIssue: undefined,
  transportMetrics: undefined,
  pendingOutbound: 0,
  pairingSync: undefined,
  error: undefined,
};

const LOCAL_EVIDENCE_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const LAST_ACTIVE_HOST_KEY = "bridge.mobile.last-active-host.v1";
const PENDING_PAIRING_INSTANCE_PREFIX = "bridge.mobile.pending-pairing-instance.v1.";

function readLastActiveHost(): string | undefined {
  try {
    return localStorage.getItem(LAST_ACTIVE_HOST_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function writeLastActiveHost(roomId?: string): void {
  try {
    if (roomId) localStorage.setItem(LAST_ACTIVE_HOST_KEY, roomId);
    else localStorage.removeItem(LAST_ACTIVE_HOST_KEY);
  } catch {
    // The vault still retains pairing state when browser storage is unavailable.
  }
}

/**
 * Pairing claims are single-use on the relay: the first hello binds the
 * device to an installation instanceId, and every later hello must present
 * the same value. A transient handshake failure (e.g. the desktop is
 * momentarily offline and `snapshot.get` times out) used to burn the QR
 * because `fromPairing` minted a fresh random instanceId on each retry.
 * Persist the provisional instanceId per room/device so re-scanning the same
 * QR reclaims the same slot instead of failing with PAIRING_ALREADY_USED.
 */
function pendingPairingInstanceId(roomId: string, deviceId: string): string {
  const key = `${PENDING_PAIRING_INSTANCE_PREFIX}${roomId}:${deviceId}`;
  try {
    const existing = localStorage.getItem(key);
    if (existing) return existing;
    const value = randomId(12);
    localStorage.setItem(key, value);
    return value;
  } catch {
    return randomId(12);
  }
}

function clearPendingPairingInstanceId(roomId: string, deviceId: string): void {
  try {
    localStorage.removeItem(`${PENDING_PAIRING_INSTANCE_PREFIX}${roomId}:${deviceId}`);
  } catch {
    // Non-fatal; a stale key is harmless because the installed identity
    // carries the same instanceId after importPairing.
  }
}

function isLoopbackRelay(value: string): boolean {
  try {
    const hostname = new URL(value).hostname;
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
  } catch {
    return false;
  }
}

function relayIssue(code: string, fallback: string): MobileConnectionIssue {
  if (code === "DEVICE_REVOKED") {
    return { code: "revoked", message: "这台电脑已撤销当前手机的访问权限，请删除主机后重新扫码。" };
  }
  if (
    code === "AUTH_FAILED" ||
    code === "ROOM_NOT_FOUND" ||
    code === "PAIRING_EXPIRED" ||
    code === "PAIRING_ALREADY_USED" ||
    code === "UPGRADE_REQUIRED"
  ) {
    return {
      code: "pairing-invalid",
      message: "配对已过期或已绑定其他设备，请删除后在电脑端生成新二维码。",
    };
  }
  if (code === "INVALID_ENVELOPE") {
    return {
      code: "unreachable",
      message: "有一条待发送消息已过期或不属于当前配对，已跳过；连接仍可用，正在同步最新会话。",
    };
  }
  return { code: "unreachable", message: fallback };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function advancePairingSync(
  current: MobileBridgeState,
  roomId: string,
  stage: PairingSyncStage,
  progress: number,
): MobileBridgeState {
  if (!current.pairingSync || current.pairingSync.roomId !== roomId) return current;
  return {
    ...current,
    pairingSync: {
      ...current.pairingSync,
      stage,
      progress,
    },
  };
}

export function confirmedPairingSnapshot(
  pairing: PairingBundle,
  response: BridgeResponse | undefined,
): BridgeHostSnapshot {
  if (!response?.ok) throw new Error(response?.error?.message ?? "电脑端拒绝了加密配对握手");
  const result = response.result as { snapshot?: BridgeHostSnapshot } | undefined;
  const snapshot = result?.snapshot;
  if (
    !snapshot ||
    snapshot.host.hostId !== pairing.hostId ||
    snapshot.host.pairingEpoch !== pairing.pairingEpoch
  ) {
    throw new Error("电脑端返回的身份与二维码不一致");
  }
  return snapshot;
}

function hostStatus(
  snapshot: BridgeHostSnapshot | undefined,
  permissions: BridgePermissionInfo[] = snapshot?.permissions ?? [],
): PairedHost["status"] {
  if (permissions.length > 0) return "attention";
  if (!snapshot) return "offline";
  if (
    snapshot.runtime.activeTurns > 0 ||
    snapshot.sessions.some((session) => session.turnState === "running")
  ) return "running";
  return "standby";
}

function hostSummary(
  host: StoredBridgeHost,
  snapshot?: BridgeHostSnapshot,
  permissions: BridgePermissionInfo[] = snapshot?.permissions ?? [],
): PairedHost {
  const activeEndpoint = host.relayEndpoints.find((endpoint) => endpoint.id === host.activeEndpoint)
    ?? host.relayEndpoints[0];
  return {
    hostId: host.hostId,
    roomId: host.roomId,
    desktopName: host.desktopName,
    relayUrl: host.relayUrl,
    needsRepair: host.needsRepair || (
      Capacitor.isNativePlatform() &&
      host.relayEndpoints.every((endpoint) => isLoopbackRelay(endpoint.url))
    ),
    status: hostStatus(snapshot, permissions),
    activeTurns: snapshot?.runtime.activeTurns ?? 0,
    path: activeEndpoint?.kind ?? "lan-relay",
    ...(snapshot ? { lastSeenAt: snapshot.host.lastSeenAt } : {}),
    ...(permissions[0] ? { attentionSessionId: permissions[0].sessionId } : {}),
  };
}

function hostWithRuntimeState(
  host: PairedHost,
  snapshot: BridgeHostSnapshot | undefined,
  permissions: BridgePermissionInfo[],
): PairedHost {
  const { attentionSessionId: _attentionSessionId, ...base } = host;
  const visibleActiveTurns = snapshot
    ? Math.max(
        snapshot.runtime.activeTurns,
        snapshot.sessions.filter((session) => session.turnState === "running" || session.turnState === "waiting").length,
      )
    : host.activeTurns;
  return {
    ...base,
    status: hostStatus(snapshot, permissions),
    activeTurns: visibleActiveTurns,
    ...(snapshot ? { lastSeenAt: snapshot.host.lastSeenAt } : {}),
    ...(permissions[0] ? { attentionSessionId: permissions[0].sessionId } : {}),
  };
}

function isBridgeResponse(value: BridgePayload): value is BridgeResponse {
  return value.kind === "response";
}

export function applyEventToTurns(turns: LocalTurn[], event: BridgeEvent): LocalTurn[] {
  const requestId = typeof event.data.requestId === "string" ? event.data.requestId : undefined;
  const commandId = typeof event.data.commandId === "string" ? event.data.commandId : undefined;
  return turns.map((turn) => {
    if (
      (requestId && turn.requestId !== requestId) ||
      (!requestId && commandId && turn.commandId !== commandId) ||
      (!requestId && !commandId && turn.sessionId !== event.sessionId)
    ) return turn;
    if (event.type === "turn.queued") {
      return { ...turn, delivery: "host-received", ...(commandId ? { commandId } : {}) };
    }
    if (event.type === "user.message.accepted") return { ...turn, delivery: "session-received" };
    if (event.type === "message.delivery" && typeof event.data.delivery === "string") {
      const delivery = event.data.delivery as BridgeDeliveryState;
      if (
        [
          "local-saved",
          "relay-received",
          "host-received",
          "session-received",
          "running",
          "completed",
          "failed",
          "cancelled",
          "uncertain",
        ].includes(delivery)
      ) {
        return {
          ...turn,
          delivery,
          ...(typeof event.data.error === "string" ? { error: event.data.error } : {}),
          ...(commandId ? { commandId } : {}),
        };
      }
    }
    if (event.type === "turn.started") return { ...turn, delivery: "running" };
    if (event.type === "turn.completed") return { ...turn, delivery: "completed" };
    if (event.type === "turn.failed") {
      return {
        ...turn,
        delivery: "failed",
        error: typeof event.data.error === "string" ? event.data.error : "Claude 处理失败",
      };
    }
    if (event.type === "turn.interrupted") return { ...turn, delivery: "cancelled" };
    return turn;
  });
}

export function mergeBridgeEvents(current: BridgeEvent[], incoming: BridgeEvent[]): BridgeEvent[] {
  const merged = new Map(current.map((event) => [event.eventId, event]));
  for (const event of incoming) merged.set(event.eventId, event);
  return [...merged.values()]
    .sort((left, right) => left.seq - right.seq)
    .slice(-2_000);
}

function evidenceFromEvent(event: BridgeEvent): BridgeEvidenceBundle | undefined {
  if (!event.type.startsWith("evidence.")) return undefined;
  const value = event.data.evidence;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const evidence = value as Partial<BridgeEvidenceBundle>;
  if (
    typeof evidence.id !== "string" ||
    typeof evidence.sessionId !== "string" ||
    !Array.isArray(evidence.tools) ||
    !Array.isArray(evidence.artifacts)
  ) return undefined;
  return evidence as BridgeEvidenceBundle;
}

function previewFromResponse(response: BridgeResponse): BridgeArtifactPreview | undefined {
  if (!response.ok || !response.result || typeof response.result !== "object") return undefined;
  const preview = (response.result as { preview?: unknown }).preview;
  if (!preview || typeof preview !== "object" || Array.isArray(preview)) return undefined;
  const value = preview as Partial<BridgeArtifactPreview>;
  if (
    typeof value.artifactId !== "string" ||
    typeof value.mimeType !== "string" ||
    typeof value.data !== "string" ||
    (value.encoding !== "utf8" && value.encoding !== "base64")
  ) return undefined;
  return value as BridgeArtifactPreview;
}

function evidencePageFromResponse(response: BridgeResponse): BridgeEvidencePage | undefined {
  if (!response.ok || !response.result || typeof response.result !== "object") return undefined;
  const evidence = (response.result as { evidence?: unknown }).evidence;
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return undefined;
  const value = evidence as Partial<BridgeEvidencePage>;
  if (typeof value.sessionId !== "string" || !Array.isArray(value.items)) return undefined;
  return value as BridgeEvidencePage;
}

function shouldExtendLocalEvidenceCache(payload: BridgePayload): boolean {
  if (payload.kind === "event") return payload.event.type.startsWith("evidence.");
  return payload.kind === "response" && Boolean(
    previewFromResponse(payload) || evidencePageFromResponse(payload),
  );
}

function mergeEvidence(
  current: BridgeEvidenceBundle[],
  incoming: BridgeEvidenceBundle[],
): BridgeEvidenceBundle[] {
  const merged = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) merged.set(item.id, item);
  return [...merged.values()].sort((left, right) => (
    right.startedAt - left.startedAt || right.id.localeCompare(left.id)
  ));
}

function permissionFromEvent(event: BridgeEvent): BridgePermissionInfo | undefined {
  if (event.type !== "permission.requested" && event.type !== "question.requested") return undefined;
  if (
    !event.sessionId ||
    typeof event.data.requestId !== "string" ||
    typeof event.data.toolUseId !== "string" ||
    typeof event.data.toolName !== "string" ||
    !event.data.input ||
    typeof event.data.input !== "object" ||
    Array.isArray(event.data.input)
  ) return undefined;
  return {
    requestId: event.data.requestId,
    sessionId: event.sessionId,
    toolUseId: event.data.toolUseId,
    toolName: event.data.toolName,
    input: event.data.input as Record<string, unknown>,
    createdAt: typeof event.data.createdAt === "number" ? event.data.createdAt : event.timestamp,
    canAllowAlways: event.data.canAllowAlways === true,
    ...(typeof event.data.title === "string" && event.data.title ? { title: event.data.title } : {}),
    ...(typeof event.data.displayName === "string" && event.data.displayName
      ? { displayName: event.data.displayName }
      : {}),
    ...(typeof event.data.description === "string" && event.data.description
      ? { description: event.data.description }
      : {}),
  };
}

export function applyPermissionEvent(
  current: BridgePermissionInfo[],
  event: BridgeEvent,
): BridgePermissionInfo[] {
  const requested = permissionFromEvent(event);
  if (requested) {
    return [
      ...current.filter((permission) => permission.requestId !== requested.requestId),
      requested,
    ].sort((left, right) => left.createdAt - right.createdAt);
  }
  if (
    (event.type === "permission.resolved" || event.type === "question.resolved") &&
    typeof event.data.requestId === "string"
  ) {
    return current.filter((permission) => permission.requestId !== event.data.requestId);
  }
  return current;
}

function snapshotWithPermissions(
  snapshot: BridgeHostSnapshot | undefined,
  permissions: BridgePermissionInfo[],
): BridgeHostSnapshot | undefined {
  if (!snapshot) return undefined;
  const waitingSessions = new Set(permissions.map((permission) => permission.sessionId));
  return {
    ...snapshot,
    permissions,
    sessions: snapshot.sessions.map((session) => {
      if (waitingSessions.has(session.sessionId)) return { ...session, turnState: "waiting" };
      if (session.turnState !== "waiting") return session;
      return {
        ...session,
        turnState: session.ownership === "BRIDGE_RUNNING"
          ? "running"
          : session.pendingCount > 0
            ? "queued"
            : "idle",
      };
    }),
  };
}

export function rebaseSnapshot(
  snapshot: BridgeHostSnapshot,
  events: BridgeEvent[],
): {
  snapshot: BridgeHostSnapshot;
  permissions: BridgePermissionInfo[];
  latestSeq: number;
} {
  const replay = events
    .filter((event) => event.seq > snapshot.latestSeq)
    .sort((left, right) => left.seq - right.seq);
  const applied = applyEventsToSnapshot(snapshot, replay, snapshot.permissions);
  const rebased = applied.snapshot ?? snapshot;
  return {
    snapshot: rebased,
    permissions: applied.permissions,
    latestSeq: Math.max(snapshot.latestSeq, ...events.map((event) => event.seq), 0),
  };
}

export function snapshotWithClaudeDesktop(
  snapshot: BridgeHostSnapshot | undefined,
  claudeDesktop: ClaudeDesktopAppStatus,
): BridgeHostSnapshot | undefined {
  return snapshot ? { ...snapshot, claudeDesktop } : undefined;
}

function sessionWithRoute(
  session: BridgeSessionInfo,
  route: BridgeConversationRoute,
): BridgeSessionInfo {
  const {
    pendingHandoff: _pendingHandoff,
    ...withoutPending
  } = session;
  return {
    ...withoutPending,
    activeLaneId: route.activeLaneId,
    activeProviderProfileId: route.activeProviderProfileId,
    routeState: route.state,
    allowedActions: route.allowedActions,
    ...(route.pendingHandoff ? { pendingHandoff: route.pendingHandoff } : {}),
  };
}

export function applyEventToSnapshot(
  snapshot: BridgeHostSnapshot | undefined,
  event: BridgeEvent,
  permissions: BridgePermissionInfo[],
): BridgeHostSnapshot | undefined {
  const current = snapshotWithPermissions(snapshot, permissions);
  if (!current) return current;
  if (event.type === "provider.updated") {
    const profile = event.data.profile as BridgeProviderProfile | undefined;
    if (!profile || typeof profile.id !== "string") return current;
    const providers = new Map((current.providers ?? []).map((candidate) => [candidate.id, candidate]));
    providers.set(profile.id, profile);
    return { ...current, providers: [...providers.values()] };
  }
  if (!event.sessionId) return current;
  const hasPendingPermission = permissions.some((permission) => permission.sessionId === event.sessionId);
  if (event.type === "session.deleted") {
    return {
      ...current,
      sessions: current.sessions.filter((session) => session.sessionId !== event.sessionId),
    };
  }
  const index = current.sessions.findIndex((session) => session.sessionId === event.sessionId);
  if (index < 0) return current;
  const target = current.sessions[index]!;
  const updated = applyEventToSession(target, event, hasPendingPermission);
  if (updated === target) return current;
  const sessions = current.sessions.slice();
  sessions[index] = updated;
  return { ...current, sessions };
}

function applyEventToSession(
  session: BridgeSessionInfo,
  event: BridgeEvent,
  hasPendingPermission: boolean,
): BridgeSessionInfo {
  if (event.type === "runtime.updated") {
    const updated = event.data.session as Partial<BridgeSessionInfo> | undefined;
    if (updated?.sessionId === session.sessionId) {
      const { allowedActions, ...fields } = updated;
      return {
        ...session,
        ...fields,
        ...(allowedActions ? { allowedActions } : {}),
      };
    }
  }
  if (event.type === "session.archived") {
    if (event.data.archived === true && typeof event.data.archivedAt === "number") {
      return { ...session, archivedAt: event.data.archivedAt };
    }
    if (event.data.archived === false) {
      const { archivedAt: _dropped, ...rest } = session;
      return rest;
    }
    return session;
  }
  if (event.type === "conversation.route.changed") {
    const route = event.data.route as BridgeConversationRoute | undefined;
    if (route?.conversationId === session.sessionId) return sessionWithRoute(session, route);
  }
  if (hasPendingPermission) return { ...session, turnState: "waiting" };
  if (event.type === "session.ownership" && typeof event.data.ownership === "string") {
    return {
      ...session,
      ownership: event.data.ownership as BridgeSessionInfo["ownership"],
    };
  }
  if (event.type === "session.transport" && typeof event.data.transport === "string") {
    return {
      ...session,
      transport: event.data.transport as BridgeSessionInfo["transport"],
    };
  }
  if (event.type === "session.ownership-conflict") {
    return {
      ...session,
      ownership: "OWNERSHIP_CONFLICT",
      turnState: "waiting",
    };
  }
  if (event.type === "runtime.goal.updated") {
    const goal = event.data.goal as BridgeRuntimeGoalInfo | undefined;
    if (goal && typeof goal.objective === "string") return { ...session, goal };
    return session;
  }
  if (
    event.type === "runtime.handoff.started" ||
    event.type === "runtime.handoff.plan-ready" ||
    event.type === "runtime.handoff.failed" ||
    event.type === "runtime.handoff.cancelled"
  ) {
    // The plan gate lives on the source session; follow it live on
    // mobile so confirmation never requires the desktop.
    const handoff = event.data.handoff as BridgeRuntimeHandoff | undefined;
    if (!handoff || handoff.sourceSessionId !== session.sessionId) return session;
    return { ...session, pendingRuntimeHandoff: handoff };
  }
  if (event.type === "runtime.handoff.applied") {
    const handoff = event.data.handoff as BridgeRuntimeHandoff | undefined;
    if (!handoff || handoff.sourceSessionId !== session.sessionId) return session;
    const { pendingRuntimeHandoff: _pending, ...rest } = session;
    return rest;
  }
  if (event.type === "turn.queued") {
    return {
      ...session,
      turnState: "queued",
      pendingCount: Math.max(1, session.pendingCount),
    };
  }
  if (event.type === "turn.started") {
    return {
      ...session,
      ownership: session.transport === "claude-desktop-managed"
        ? "DESKTOP_MANAGED_RUNNING"
        : "BRIDGE_RUNNING",
      turnState: "running",
      pendingCount: Math.max(0, session.pendingCount - 1),
      ...(event.turnId ? { activeTurnId: event.turnId } : {}),
    };
  }
  if (
    event.type === "turn.completed" ||
    event.type === "turn.failed" ||
    event.type === "turn.interrupted"
  ) {
    const pendingCount = event.type === "turn.interrupted" && event.data.wasQueued === true
      ? Math.max(0, session.pendingCount - 1)
      : session.pendingCount;
    const {
      activeTurnId: _activeTurnId,
      currentSummary: _currentSummary,
      ...rest
    } = session;
    return {
      ...rest,
      ownership: session.transport === "claude-desktop-managed"
        ? "DESKTOP_MANAGED_IDLE"
        : "BRIDGE_IDLE",
      turnState: pendingCount > 0 ? "queued" : "idle",
      pendingCount,
    };
  }
  return session;
}

/**
 * Batch variant for catch-up replay: one session-index build and one final
 * wrap for the whole event run instead of a full sessions map per event.
 * A busy away window can queue thousands of events; per-event mapping made
 * every reconnect O(events x sessions) and froze the phone for seconds.
 */
export function applyEventsToSnapshot(
  snapshot: BridgeHostSnapshot | undefined,
  events: BridgeEvent[],
  permissions: BridgePermissionInfo[],
): { snapshot: BridgeHostSnapshot | undefined; permissions: BridgePermissionInfo[] } {
  let current = snapshotWithPermissions(snapshot, permissions);
  let currentPermissions = permissions;
  if (!current || events.length === 0) return { snapshot: current, permissions: currentPermissions };
  const byId = new Map(current.sessions.map((session) => [session.sessionId, session]));
  let providers = current.providers ?? [];
  let providersDirty = false;
  let sessionsDirty = false;
  for (const event of events) {
    currentPermissions = applyPermissionEvent(currentPermissions, event);
    if (event.type === "provider.updated") {
      const profile = event.data.profile as BridgeProviderProfile | undefined;
      if (profile && typeof profile.id === "string") {
        const index = providers.findIndex((candidate) => candidate.id === profile.id);
        if (index < 0) providers = [...providers, profile];
        else {
          if (!providersDirty) providers = providers.slice();
          providers[index] = profile;
        }
        providersDirty = true;
      }
      continue;
    }
    if (!event.sessionId) continue;
    if (event.type === "session.deleted") {
      if (byId.delete(event.sessionId)) sessionsDirty = true;
      continue;
    }
    const existing = byId.get(event.sessionId);
    if (!existing) continue;
    const hasPendingPermission = currentPermissions.some(
      (permission) => permission.sessionId === event.sessionId,
    );
    const updated = applyEventToSession(existing, event, hasPendingPermission);
    if (updated !== existing) {
      byId.set(event.sessionId, updated);
      sessionsDirty = true;
    }
  }
  current = {
    ...current,
    ...(sessionsDirty ? { sessions: [...byId.values()] } : {}),
    ...(providersDirty ? { providers } : {}),
  };
  return {
    snapshot: snapshotWithPermissions(current, currentPermissions),
    permissions: currentPermissions,
  };
}

async function readStoredHostState(
  crypto: BridgeCrypto,
  storedEnvelopes?: EncryptedEnvelope[],
): Promise<{
  snapshot?: BridgeHostSnapshot;
  permissions: BridgePermissionInfo[];
  events: BridgeEvent[];
  evidence: Record<string, SessionEvidenceState>;
  artifactPreviews: Record<string, BridgeArtifactPreview>;
  localTurns: LocalTurn[];
  latestSeq: number;
}> {
  const envelopes = storedEnvelopes ?? await bridgeVault.listMessages(crypto.identity.roomId);
  const results = await Promise.allSettled(envelopes.map((envelope) => crypto.decrypt(envelope)));
  const messages = results
    .filter((result): result is PromiseFulfilledResult<DecryptedEnvelope> => result.status === "fulfilled")
    .map((result) => result.value);
  const snapshot = [...messages].reverse().find((message) => message.payload.kind === "snapshot")?.payload;
  const events = mergeBridgeEvents(
    [],
    messages.flatMap((message) => message.payload.kind === "event" ? [message.payload.event] : []),
  );
  let permissions = snapshot?.kind === "snapshot" ? snapshot.snapshot.permissions : [];
  const snapshotSeq = snapshot?.kind === "snapshot" ? snapshot.snapshot.latestSeq : 0;
  let replayedSnapshot = snapshot?.kind === "snapshot" ? snapshot.snapshot : undefined;
  for (const event of events.filter((candidate) => candidate.seq > snapshotSeq)) {
    permissions = applyPermissionEvent(permissions, event);
    replayedSnapshot = applyEventToSnapshot(replayedSnapshot, event, permissions);
  }
  const localTurns: LocalTurn[] = messages.flatMap((message) => {
    if (
      message.header.from !== "mobile" ||
      message.payload.kind !== "request" ||
      (message.payload.method !== "turn.start" && message.payload.method !== "turn.steer")
    ) return [];
    const params = message.payload.params;
    if (typeof params.sessionId !== "string") return [];
    return [{
      requestId: message.payload.requestId,
      idempotencyKey: message.payload.idempotencyKey,
      sessionId: params.sessionId,
      text: typeof params.text === "string" ? params.text : "",
      attachments: Array.isArray(params.attachments)
        ? params.attachments.flatMap((attachment) => {
            if (!attachment || typeof attachment !== "object") return [];
            const { data: _data, ...metadata } = attachment as BridgeAttachment;
            return [metadata];
          })
        : [],
      createdAt: message.header.sentAt,
      delivery: "local-saved" as const,
    }];
  });
  let appliedTurns = localTurns;
  for (const event of events) appliedTurns = applyEventToTurns(appliedTurns, event);
  for (const message of messages) {
    if (!isBridgeResponse(message.payload)) continue;
    const response = message.payload;
    const turnIndex = appliedTurns.findIndex((turn) => turn.requestId === response.requestId);
    if (turnIndex < 0) continue;
    const turn = appliedTurns[turnIndex]!;
    if (response.ok) {
      const result = response.result as { commandId?: unknown; state?: unknown } | undefined;
      const terminalDelivery: BridgeDeliveryState | undefined = result?.state === "completed"
        ? "completed"
        : result?.state === "failed"
          ? "failed"
          : result?.state === "cancelled"
            ? "cancelled"
            : undefined;
      appliedTurns[turnIndex] = {
        ...turn,
        delivery: terminalDelivery ?? (turn.delivery === "local-saved" ? "host-received" : turn.delivery),
        ...(typeof result?.commandId === "string" ? { commandId: result.commandId } : {}),
      };
    } else {
      appliedTurns[turnIndex] = {
        ...turn,
        delivery: "failed",
        error: response.error?.message ?? "请求失败",
      };
    }
  }
  const storedSnapshot = snapshotWithPermissions(replayedSnapshot, permissions);
  const evidence = events.reduce<Record<string, SessionEvidenceState>>((result, event) => {
    const item = evidenceFromEvent(event);
    if (!item) return result;
    const current = result[item.sessionId] ?? {
      status: "ready" as const,
      items: [],
      hasMore: false,
    };
    result[item.sessionId] = {
      ...current,
      items: mergeEvidence(current.items, [item]),
    };
    return result;
  }, {});
  const artifactPreviews: Record<string, BridgeArtifactPreview> = {};
  for (const message of messages) {
    if (!isBridgeResponse(message.payload)) continue;
    const preview = previewFromResponse(message.payload);
    if (preview) artifactPreviews[preview.artifactId] = preview;
    const page = evidencePageFromResponse(message.payload);
    if (!page) continue;
    const current = evidence[page.sessionId] ?? {
      status: "ready" as const,
      items: [],
      hasMore: page.hasMore,
    };
    evidence[page.sessionId] = {
      status: "ready",
      items: mergeEvidence(current.items, page.items),
      hasMore: current.hasMore || page.hasMore,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  }
  return {
    ...(storedSnapshot ? { snapshot: storedSnapshot } : {}),
    permissions,
    events,
    evidence,
    artifactPreviews,
    localTurns: appliedTurns,
    latestSeq: Math.max(snapshotSeq, ...events.map((event) => event.seq), 0),
  };
}

function clientMetadata(): Record<string, string> {
  const platform = Capacitor.getPlatform();
  return {
    platform: platform === "android" || platform === "ios" ? platform : "web",
    name: platform === "android" ? "Android 手机" : platform === "ios" ? "iPhone" : "Web 客户端",
  };
}

async function revokeRemoteDevice(crypto: BridgeCrypto): Promise<void> {
  const socket = new RelayTransport({ crypto, role: "mobile", reconnect: false });
  await new Promise<void>((resolve) => {
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      socket.close();
      resolve();
    };
    const timeout = setTimeout(done, 4_000);
    socket.onState((connection) => {
      if (connection !== "connected") return;
      const request: BridgeRequest = {
        kind: "request",
        requestId: randomId(),
        idempotencyKey: randomId(),
        method: "device.revoke",
        params: { deviceId: crypto.identity.deviceId, client: clientMetadata() },
      };
      void socket.send(request, "desktop").catch(done);
    });
    socket.onMessage((message, encrypted) => {
      socket.ack([encrypted.id]);
      if (message.payload.kind !== "response") return;
      clearTimeout(timeout);
      done();
    });
    socket.onFrame((frame) => {
      if (frame.type === "error") {
        clearTimeout(timeout);
        done();
      }
    });
    socket.connect();
  });
}

export function useMobileBridge() {
  const [state, setState] = useState<MobileBridgeState>(INITIAL_STATE);
  const stateRef = useRef(state);
  stateRef.current = state;
  const cryptoRef = useRef<BridgeCrypto | undefined>(undefined);
  const cryptoByRoomRef = useRef(new Map<string, BridgeCrypto>());
  const socketRef = useRef<BridgeTransport | undefined>(undefined);
  const connectionTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pairingSyncTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingResponsesRef = useRef(new Map<string, PendingResponse>());
  const envelopeRequestsRef = useRef(new Map<string, string>());
  const desktopHomeRef = useRef<string | undefined>(undefined);
  const linkGateRef = useRef<() => boolean>(() => true);
  const sendAttemptedAtRef = useRef<number | undefined>(undefined);

  const updateHostCache = useCallback((
    roomId: string,
    snapshot: BridgeHostSnapshot,
    permissions: BridgePermissionInfo[] = snapshot.permissions,
  ) => {
    setState((current) => ({
      ...current,
      hosts: current.hosts.map((host) => host.roomId === roomId
        ? hostWithRuntimeState(host, snapshot, permissions)
        : host),
    }));
  }, []);

  // 0.9.5: the desktop advertises its current LAN relay in every snapshot;
  // heal the stored (possibly stale) LAN endpoint in place, no re-pairing.
  const applyLanRelayAdvertisement = useCallback((roomId: string, snapshot: BridgeHostSnapshot) => {
    const url = snapshot.host.lanRelayUrl;
    if (!url) return;
    // The healed endpoint is read from the vault on the next (re)connect.
    void bridgeVault.updateLanRelay(roomId, url).catch(() => undefined);
  }, []);

  const handlePayload = useCallback((
    payload: BridgePayload,
    encrypted: EncryptedEnvelope,
    crypto: BridgeCrypto,
  ) => {
    if (payload.kind === "snapshot") {
      const rebased = rebaseSnapshot(payload.snapshot, stateRef.current.events);
      const { snapshot, permissions } = rebased;
      setState((current) => ({
        ...current,
        snapshot,
        permissions,
        desktopName: snapshot.host.name,
        desktopOnline: snapshot.host.online,
        latestSeq: rebased.latestSeq,
      }));
      updateHostCache(crypto.identity.roomId, snapshot, permissions);
      applyLanRelayAdvertisement(crypto.identity.roomId, snapshot);
      return;
    }
    if (payload.kind === "event") {
      setState((current) => {
        const permissions = applyPermissionEvent(current.permissions, payload.event);
        const snapshot = applyEventToSnapshot(current.snapshot, payload.event, permissions);
        const evidenceItem = evidenceFromEvent(payload.event);
        const evidence = evidenceItem ? {
          ...current.evidence,
          [evidenceItem.sessionId]: {
            status: "ready" as const,
            items: mergeEvidence(
              current.evidence[evidenceItem.sessionId]?.items ?? [],
              [evidenceItem],
            ),
            hasMore: current.evidence[evidenceItem.sessionId]?.hasMore ?? false,
            ...(current.evidence[evidenceItem.sessionId]?.nextCursor
              ? { nextCursor: current.evidence[evidenceItem.sessionId]!.nextCursor }
              : {}),
          },
        } : current.evidence;
        return {
          ...current,
          snapshot,
          permissions,
          events: mergeBridgeEvents(current.events, [payload.event]),
          evidence,
          localTurns: applyEventToTurns(current.localTurns, payload.event),
          latestSeq: Math.max(current.latestSeq, payload.event.seq),
          hosts: current.hosts.map((host) => host.roomId === crypto.identity.roomId
            ? hostWithRuntimeState(host, snapshot, permissions)
            : host),
        };
      });
      return;
    }
    if (payload.kind !== "response") return;
    setState((current) => {
      const index = current.localTurns.findIndex((turn) => turn.requestId === payload.requestId);
      if (index < 0) return current;
      const localTurns = [...current.localTurns];
      const turn = localTurns[index]!;
      if (payload.ok) {
        const result = payload.result as { commandId?: unknown; state?: unknown } | undefined;
        const terminalDelivery: BridgeDeliveryState | undefined = result?.state === "completed"
          ? "completed"
          : result?.state === "failed"
            ? "failed"
            : result?.state === "cancelled"
              ? "cancelled"
              : undefined;
        localTurns[index] = {
          ...turn,
          delivery: terminalDelivery ?? (
            turn.delivery === "local-saved" || turn.delivery === "relay-received"
              ? "host-received"
              : turn.delivery
          ),
          ...(typeof result?.commandId === "string" ? { commandId: result.commandId } : {}),
        };
      } else {
        localTurns[index] = {
          ...turn,
          delivery: "failed",
          error: payload.error?.message ?? "请求失败",
        };
      }
      return { ...current, localTurns };
    });
    const pending = pendingResponsesRef.current.get(payload.requestId);
    if (pending) {
      clearTimeout(pending.timer);
      pendingResponsesRef.current.delete(payload.requestId);
      pending.resolve(payload);
    }
    void encrypted;
  }, [updateHostCache]);

  const sendRequest = useCallback(async (
    method: BridgeRequest["method"],
    params: Record<string, unknown>,
    options: { wait?: boolean; allowOffline?: boolean; idempotencyKey?: string; timeoutMs?: number } = {},
  ): Promise<BridgeResponse | undefined> => {
    const crypto = cryptoRef.current;
    if (!crypto) throw new Error("No host selected");
    const socket = socketRef.current;
    if ((!socket || socket.state !== "connected") && !options.allowOffline) {
      throw new Error("电脑当前离线");
    }
    const request: BridgeRequest = {
      kind: "request",
      requestId: randomId(),
      idempotencyKey: options.idempotencyKey ?? randomId(),
      method,
      params: { ...params, client: clientMetadata() },
    };
    const envelope = await crypto.encrypt(request, "mobile", "desktop");
    envelopeRequestsRef.current.set(envelope.id, request.requestId);
    await Promise.all([bridgeVault.saveMessage(envelope), bridgeVault.addOutbox(envelope)]);
    setState((current) => ({ ...current, pendingOutbound: current.pendingOutbound + 1 }));
    if (method === "turn.start" || method === "turn.steer") {
      const attachments = Array.isArray(params.attachments)
        ? params.attachments.flatMap((attachment) => {
            if (!attachment || typeof attachment !== "object") return [];
            const { data: _data, ...metadata } = attachment as BridgeAttachment;
            return [metadata];
          })
        : [];
      setState((current) => ({
        ...current,
        localTurns: [
          ...current.localTurns.filter((turn) => turn.requestId !== request.requestId),
          {
            requestId: request.requestId,
            idempotencyKey: request.idempotencyKey,
            sessionId: String(params.sessionId ?? ""),
            text: typeof params.text === "string" ? params.text : "",
            attachments,
            createdAt: envelope.sentAt,
            delivery: "local-saved",
          },
        ],
      }));
    }
    if (!socket || socket.state !== "connected") {
      return undefined;
    }
    if (!linkGateRef.current()) {
      // The current connection landed on a relay the desktop isn't using
      // (e.g. a proxy app pulled the phone onto the overseas relay). Keep the
      // envelope in the outbox instead of letting it rot in the wrong
      // namespace, and say so instead of faking progress.
      setState((current) => ({
        ...current,
        connectionIssue: {
          code: "waiting-link",
          message: "当前网络未连到电脑所在的中继（可能被代理带偏），消息已保存在手机，链路恢复后自动重发。",
        },
      }));
      if (options.wait) {
        throw new Error("当前网络未连到电脑所在的中继（可能被代理带偏），请检查代理或 VPN 设置后重试。");
      }
      return undefined;
    }
    const responsePromise = options.wait ? new Promise<BridgeResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingResponsesRef.current.delete(request.requestId);
        reject(new Error("电脑响应超时"));
      }, options.timeoutMs ?? 20_000);
      pendingResponsesRef.current.set(request.requestId, { resolve, reject, timer });
    }) : undefined;
    try {
      sendAttemptedAtRef.current = Date.now();
      await socket.sendEnvelope(envelope);
    } catch (error) {
      const pending = pendingResponsesRef.current.get(request.requestId);
      if (pending) clearTimeout(pending.timer);
      pendingResponsesRef.current.delete(request.requestId);
      throw error;
    }
    return responsePromise;
  }, []);

  const resumeEvents = useCallback(async (bootstrap = false) => {
    try {
      const events: BridgeEvent[] = [];
      let cursor = stateRef.current.latestSeq;
      for (let page = 0; page < 100; page += 1) {
        const response = await sendRequest("events.resume", {
          afterSeq: cursor,
          limit: 1_000,
          ...(bootstrap && cursor === 0 ? { bootstrap: true } : {}),
        }, { wait: true });
        if (!response?.ok) break;
        const result = response.result as {
          events?: unknown;
          latestSeq?: unknown;
          nextSeq?: unknown;
          hasMore?: unknown;
        } | undefined;
        if (!Array.isArray(result?.events)) break;
        const pageEvents = result.events as BridgeEvent[];
        events.push(...pageEvents);
        const nextSeq = typeof result.nextSeq === "number"
          ? result.nextSeq
          : Math.max(cursor, ...pageEvents.map((event) => event.seq));
        if (nextSeq <= cursor) break;
        cursor = nextSeq;
        const latestSeq = typeof result.latestSeq === "number" ? result.latestSeq : cursor;
        if (result.hasMore !== true || cursor >= latestSeq) break;
      }
      setState((current) => {
        let turns = current.localTurns;
        let evidence = current.evidence;
        for (const event of events) {
          turns = applyEventToTurns(turns, event);
          const item = evidenceFromEvent(event);
          if (item) {
            evidence = {
              ...evidence,
              [item.sessionId]: {
                status: "ready",
                items: mergeEvidence(evidence[item.sessionId]?.items ?? [], [item]),
                hasMore: evidence[item.sessionId]?.hasMore ?? false,
                ...(evidence[item.sessionId]?.nextCursor
                  ? { nextCursor: evidence[item.sessionId]!.nextCursor }
                  : {}),
              },
            };
          }
        }
        const applied = applyEventsToSnapshot(current.snapshot, events, current.permissions);
        const snapshot = applied.snapshot;
        const permissions = applied.permissions;
        return {
          ...current,
          snapshot,
          permissions,
          events: mergeBridgeEvents(current.events, events),
          evidence,
          localTurns: turns,
          latestSeq: Math.max(current.latestSeq, cursor),
          hosts: current.hosts.map((host) => host.roomId === current.activeHostId
            ? hostWithRuntimeState(host, snapshot, permissions)
            : host),
        };
      });
    } catch {
      // The next reconnect retries from the same cursor.
    }
  }, [sendRequest]);

  const refreshSessionList = useCallback(async (): Promise<boolean> => {
    const response = await sendRequest("session.list", {}, {
      wait: true,
      timeoutMs: 20_000,
    });
    if (!response?.ok) return false;
    const result = response.result as { sessions?: BridgeSessionInfo[] };
    if (!result.sessions) return false;
    setState((current) => current.snapshot ? {
      ...current,
      snapshot: { ...current.snapshot, sessions: result.sessions! },
    } : current);
    return true;
  }, [sendRequest]);

  const refreshSnapshot = useCallback(async (): Promise<boolean> => {
    const response = await sendRequest("snapshot.get", {}, {
      wait: true,
      timeoutMs: 20_000,
    });
    if (!response?.ok) throw new Error(response?.error?.message ?? "电脑端快照刷新失败");
    const result = response.result as { snapshot?: BridgeHostSnapshot } | undefined;
    if (!result?.snapshot) throw new Error("电脑端未返回最新会话快照");
    const crypto = cryptoRef.current;
    if (!crypto) throw new Error("电脑当前离线");
    const roomId = crypto.identity.roomId;
    const initial = rebaseSnapshot(result.snapshot, stateRef.current.events);
    const cacheCrypto = crypto.withSenderDevice(crypto.identity.hostId ?? crypto.identity.deviceId);
    const cachedEnvelope = await cacheCrypto.encrypt(
      { kind: "snapshot", snapshot: initial.snapshot },
      "desktop",
      "mobile",
      Date.now(),
      LOCAL_EVIDENCE_CACHE_TTL_MS,
      crypto.identity.deviceId,
    );
    await bridgeVault.saveMessage(cachedEnvelope);
    applyLanRelayAdvertisement(roomId, result.snapshot);
    setState((current) => {
      const rebased = rebaseSnapshot(result.snapshot!, current.events);
      return {
        ...current,
        snapshot: rebased.snapshot,
        permissions: rebased.permissions,
        desktopName: rebased.snapshot.host.name,
        desktopOnline: rebased.snapshot.host.online,
        latestSeq: rebased.latestSeq,
        error: undefined,
        hosts: current.hosts.map((host) => host.roomId === roomId
          ? hostWithRuntimeState(host, rebased.snapshot, rebased.permissions)
          : host),
      };
    });
    return true;
  }, [sendRequest]);

  const start = useCallback(async (
    crypto: BridgeCrypto,
    bootstrap = false,
    focusSessionId?: string,
    provisionalPairing?: PairingBundle,
    pairingPhase?: PairingConnectionPhase,
  ) => {
    if (connectionTimerRef.current) clearTimeout(connectionTimerRef.current);
    socketRef.current?.close();
    socketRef.current = undefined;
    cryptoRef.current = crypto;
    linkGateRef.current = () => true;
    desktopHomeRef.current = undefined;
    sendAttemptedAtRef.current = undefined;
    const roomId = crypto.identity.roomId;
    if (!provisionalPairing) writeLastActiveHost(roomId);
    const storedHost = await bridgeVault.getHost(roomId);
    const relayEndpoints = normalizeBridgeEndpoints(
      provisionalPairing?.relayEndpoints ??
        storedHost?.relayEndpoints ??
        [bridgeEndpoint(crypto.identity.relayUrl, 100, "legacy")],
    ).filter((endpoint): endpoint is BridgeEndpoint & {
      kind: "public-relay" | "lan-relay";
    } => endpoint.kind !== "direct");
    setState((current) => ({
      ...current,
      loading: false,
      activeHostId: roomId,
      desktopName: crypto.identity.desktopName,
      connection: "connecting",
      desktopOnline: false,
      snapshot: undefined,
      permissions: [],
      focusSessionId,
      histories: {},
      evidence: {},
      artifactPreviews: {},
      artifactTransfers: {},
      events: [],
      localTurns: [],
      latestSeq: 0,
      connectionIssue: undefined,
      transportMetrics: undefined,
      pendingOutbound: 0,
      error: undefined,
    }));

    const stored = provisionalPairing
      ? await readStoredHostState(crypto, [])
      : await readStoredHostState(crypto);
    const queuedOutbox = provisionalPairing ? [] : await bridgeVault.listOutbox(roomId);
    const replayableOutbox = queuedOutbox.filter((envelope) => isReplayableMobileEnvelope(
      envelope,
      { roomId, deviceId: crypto.identity.deviceId },
    ));
    const replayableIds = new Set(replayableOutbox.map((envelope) => envelope.id));
    const rejectedOutbox = queuedOutbox.filter((envelope) => !replayableIds.has(envelope.id));
    const rejectedRequestIds = new Set<string>();
    await Promise.all(rejectedOutbox.map(async (envelope) => {
      try {
        const decrypted = await crypto.decrypt(envelope);
        if (decrypted.payload.kind === "request") rejectedRequestIds.add(decrypted.payload.requestId);
      } catch {
        // Expired or foreign ciphertext has no safe request identity to restore.
      }
    }));
    if (rejectedOutbox.length > 0) await bridgeVault.removeOutbox(rejectedOutbox.map((envelope) => envelope.id));
    const pendingOutbound = replayableOutbox.length;
    if (cryptoRef.current !== crypto) return;
    setState((current) => ({
      ...current,
      snapshot: stored.snapshot,
      permissions: stored.permissions,
      events: stored.events,
      evidence: stored.evidence,
      artifactPreviews: stored.artifactPreviews,
      localTurns: stored.localTurns.map((turn) => (
        rejectedRequestIds.has(turn.requestId) &&
        (turn.delivery === "local-saved" || turn.delivery === "relay-received")
          ? {
              ...turn,
              delivery: "uncertain",
              error: "这条消息未能送达当前连接，请确认后重试。",
            }
          : turn
      )),
      latestSeq: stored.latestSeq,
      pendingOutbound,
    }));
    if (stored.snapshot) updateHostCache(roomId, stored.snapshot, stored.permissions);

    if (
      Capacitor.isNativePlatform() &&
      relayEndpoints.every((endpoint) => isLoopbackRelay(endpoint.url))
    ) {
      setState((current) => ({
        ...current,
        connection: "closed",
        connectionIssue: {
          code: "pairing-invalid",
          message: "这条配对没有手机可访问的网络地址，请更新电脑端 Bridge 后重试。",
        },
      }));
      return;
    }

    const candidates: BridgeTransportCandidate[] = relayEndpoints.map((endpoint) => ({
      id: endpoint.id,
      path: endpoint.kind,
      endpoint: endpoint.url,
      priority: endpoint.priority,
      create: () => new RelayTransport({
        crypto: cryptoWithRelayEndpoint(crypto, endpoint.url),
        role: "mobile",
        reconnect: false,
        path: endpoint.kind,
      }),
    }));
    const relay = new TransportRouter(candidates);
    const socket: BridgeTransport = typeof globalThis.RTCPeerConnection === "function"
      ? new WebRtcTransport({
          relay,
          crypto,
          role: "mobile",
          RTCPeerConnectionImpl: globalThis.RTCPeerConnection,
          iceServers: bridgeIceServers(preferredBridgeIceServers(
            provisionalPairing?.iceServers ?? storedHost?.iceServers,
          )),
        })
      : relay;
    socketRef.current = socket;
    let bootstrapPending = bootstrap;
    let authenticatedDesktop = false;
    let authenticationTimer: ReturnType<typeof setTimeout> | undefined;
    const isCurrent = () => socketRef.current === socket;
    const isProvisionalPairing = () => pairingPhase?.provisional ?? Boolean(provisionalPairing);
    // Desktop home relay for this room: the relay where the desktop was last
    // seen. Learned from presence frames and fresh authentic traffic, restored
    // from the vault across restarts. See relayLinkAllowsSend for why sends
    // are pinned to it.
    desktopHomeRef.current = provisionalPairing ? undefined : storedHost?.desktopRelayUrl;
    sendAttemptedAtRef.current = undefined;
    let linkHasDesktop = false;
    const learnHome = (url: string) => {
      if (!url.startsWith("ws://") && !url.startsWith("wss://")) return;
      if (desktopHomeRef.current === url) return;
      desktopHomeRef.current = url;
      if (!isProvisionalPairing()) {
        void bridgeVault.setDesktopRelay(roomId, url).catch(() => undefined);
      }
    };
    const linkAllowsSend = () => relayLinkAllowsSend({
      homeRelayUrl: desktopHomeRef.current,
      currentRelayUrl: relay.endpoint,
      desktopHere: linkHasDesktop,
      directPeer: socket.path === "direct",
    });
    linkGateRef.current = linkAllowsSend;
    let outboxFlush: Promise<void> | undefined;
    const flushOutbox = (): Promise<void> => {
      if (outboxFlush) return outboxFlush;
      outboxFlush = (async () => {
        const queued = await bridgeVault.listOutbox(roomId).catch(() => []);
        for (const envelope of queued) {
          if (!isCurrent() || socket.state !== "connected" || !linkAllowsSend()) break;
          if (!isReplayableMobileEnvelope(envelope, { roomId, deviceId: crypto.identity.deviceId })) {
            continue;
          }
          try {
            const decrypted = await crypto.decrypt(envelope);
            if (decrypted.payload.kind === "request") {
              envelopeRequestsRef.current.set(envelope.id, decrypted.payload.requestId);
            }
            sendAttemptedAtRef.current = Date.now();
            await socket.sendEnvelope(envelope);
          } catch {
            break;
          }
        }
      })().finally(() => {
        outboxFlush = undefined;
      });
      return outboxFlush;
    };
    // 0.9.5 uplink watchdog: a socket can be half-dead — presence and snapshots
    // flow in, but pings/envelopes never get out (broken middlebox, dead proxy).
    // Heartbeat only sees pong loss after 45s and retries the same path; here we
    // watch the app-level delivery confirmations ("stored"/"acknowledged") and
    // force the router onto the next endpoint when the uplink is provably dead.
    let lastDeliveryConfirmAt = Date.now();
    let lastHuntAt = 0;
    const uplinkWatchdog = setInterval(() => {
      if (!isCurrent()) {
        clearInterval(uplinkWatchdog);
        return;
      }
      void bridgeVault.listOutbox(roomId).then((outbox) => {
        if (!isCurrent() || outbox.length === 0) return;
        const now = Date.now();
        const attemptedAt = sendAttemptedAtRef.current;
        // Half-dead uplink: envelopes were actually written to this link and
        // nothing was confirmed for 25s. Gated sends never attempt, so they
        // cannot trip this.
        if (
          attemptedAt !== undefined &&
          now - lastDeliveryConfirmAt > 25_000 &&
          now - attemptedAt > 25_000
        ) {
          relay.cycle();
          return;
        }
        // Home hunting: the outbox has mail but this connection is camping on
        // a relay the desktop isn't using. Cycle the router so it re-probes
        // the desktop's home relay instead of waiting for a lifecycle event.
        const home = desktopHomeRef.current;
        if (
          home &&
          relay.endpoint !== home &&
          !linkHasDesktop &&
          now - lastHuntAt > 45_000
        ) {
          lastHuntAt = now;
          relay.cycle();
        }
      }).catch(() => undefined);
    }, 10_000);
    socket.onState((connection) => {
      if (!isCurrent()) return;
      if (connection !== "connected") linkHasDesktop = false;
      setState((current) => ({
        ...current,
        connection,
        ...(connection === "connected" ? {} : { desktopOnline: false }),
      }));
      if (connection === "connected") {
        if (connectionTimerRef.current) clearTimeout(connectionTimerRef.current);
        if (authenticationTimer) clearTimeout(authenticationTimer);
        if (isProvisionalPairing()) {
          setState((current) => advancePairingSync(current, roomId, "verifying", 38));
        }
        authenticationTimer = setTimeout(() => {
          if (!isCurrent() || authenticatedDesktop) return;
          const home = desktopHomeRef.current;
          if (!isProvisionalPairing() && home && relay.endpoint !== home) {
            // Known desktop, wrong relay namespace: say we're hunting instead
            // of claiming the pairing broke.
            setState((current) => ({
              ...current,
              desktopOnline: false,
              connectionIssue: {
                code: "waiting-link",
                message: "当前网络未连到电脑所在的中继（可能被代理带偏），正在自动重连；消息会保存在手机。",
              },
            }));
            return;
          }
          setState((current) => ({
            ...current,
            desktopOnline: false,
            connectionIssue: {
              code: "pairing-invalid",
              message: "Relay 已连接，但电脑未通过加密握手，请在电脑端重新生成二维码。",
            },
          }));
        }, 25_000);
        setState((current) => ({
          ...current,
          connectionIssue: rejectedOutbox.length > 0
            ? relayIssue("INVALID_ENVELOPE", "")
            : undefined,
        }));
        const active = relayEndpoints.find((endpoint) => endpoint.url === socket.endpoint);
        if (active && !isProvisionalPairing()) {
          void bridgeVault.setActiveEndpoint(roomId, active.id).then((host) => {
            if (!host) return;
            cryptoByRoomRef.current.set(roomId, host.crypto);
            setState((current) => ({
              ...current,
              hosts: current.hosts.map((candidate) => candidate.roomId === roomId
                ? { ...candidate, relayUrl: host.relayUrl, needsRepair: false }
                : candidate),
            }));
          }).catch(() => undefined);
        }
        if (!isProvisionalPairing()) void (async () => {
          const bootstrapResume = bootstrapPending;
          bootstrapPending = false;
          await resumeEvents(bootstrapResume);
          if (!isCurrent() || socket.state !== "connected") return;
          const snapshotSynced = await refreshSnapshot().catch(() => false);
          const sessionListSynced = snapshotSynced || await refreshSessionList().catch(() => false);
          if (sessionListSynced && rejectedOutbox.length > 0 && isCurrent()) {
            setState((current) => ({ ...current, connectionIssue: undefined }));
          }
          void flushOutbox();
          const push = await nativePushRegistration();
          if (push && isCurrent() && socket.state === "connected") {
            socket.registerPushToken(push.platform, push.token);
          }
        })();
      } else if (authenticationTimer) {
        clearTimeout(authenticationTimer);
        authenticationTimer = undefined;
      }
    });
    socket.onMetrics((metrics) => {
      if (!isCurrent()) return;
      setState((current) => ({
        ...current,
        transportMetrics: metrics,
        hosts: current.hosts.map((host) => host.roomId === roomId
          ? { ...host, path: metrics.path }
          : host),
      }));
    });
    socket.onFrame((frame) => {
      if (!isCurrent()) return;
      if (frame.type === "ready") {
        const desktopHere = frame.onlineDevices.some((device) => device.role === "desktop");
        linkHasDesktop = desktopHere;
        if (desktopHere) {
          learnHome(relay.endpoint);
          void flushOutbox();
        }
        if (!desktopHere) {
          setState((current) => ({ ...current, desktopOnline: false }));
        }
      }
      if (frame.type === "presence" && frame.role === "desktop") {
        linkHasDesktop = frame.online;
        if (frame.online) {
          learnHome(relay.endpoint);
          void flushOutbox();
        }
        if (!frame.online) setState((current) => ({ ...current, desktopOnline: false }));
      }
      if (frame.type === "stored" || frame.type === "acknowledged") {
        const delivery: BridgeDeliveryState = frame.type === "stored" ? "relay-received" : "host-received";
        lastDeliveryConfirmAt = Date.now();
        void bridgeVault.removeOutbox(frame.ids)
          .then(() => bridgeVault.listOutbox(roomId))
          .then((outbox) => {
            if (!isCurrent()) return;
            setState((current) => ({ ...current, pendingOutbound: outbox.length }));
          })
          .catch(() => undefined);
        const requestIds = frame.ids
          .map((id) => envelopeRequestsRef.current.get(id))
          .filter((value): value is string => Boolean(value));
        for (const id of frame.ids) envelopeRequestsRef.current.delete(id);
        setState((current) => ({
          ...current,
          connectionIssue: current.connectionIssue?.code === "waiting-link"
            ? undefined
            : current.connectionIssue,
          localTurns: current.localTurns.map((turn) => (
            requestIds.includes(turn.requestId) &&
            (turn.delivery === "local-saved" || turn.delivery === "relay-received")
              ? { ...turn, delivery }
              : turn
          )),
        }));
      }
      if (frame.type === "error") {
        const issue = relayIssue(frame.code, frame.message);
        if (frame.code === "INVALID_ENVELOPE") {
          const envelopeId = frame.envelopeId;
          const requestId = envelopeId ? envelopeRequestsRef.current.get(envelopeId) : undefined;
          if (envelopeId) {
            envelopeRequestsRef.current.delete(envelopeId);
            void bridgeVault.removeOutbox(envelopeId)
              .then(() => bridgeVault.listOutbox(roomId))
              .then((outbox) => {
                if (!isCurrent()) return;
                setState((current) => ({ ...current, pendingOutbound: outbox.length }));
              })
              .catch(() => undefined);
          }
          if (requestId) {
            const pending = pendingResponsesRef.current.get(requestId);
            if (pending) {
              clearTimeout(pending.timer);
              pendingResponsesRef.current.delete(requestId);
              pending.reject(new Error(issue.message));
            }
          }
          setState((current) => ({
            ...current,
            connectionIssue: issue,
            localTurns: current.localTurns.map((turn) => (
              requestId && turn.requestId === requestId
                ? { ...turn, delivery: "uncertain", error: issue.message }
                : turn
            )),
          }));
          return;
        }
        if (issue.code === "pairing-invalid" && relayEndpoints.length > 1) {
          // A migrated pairing may fail on the new public relay while its
          // legacy endpoint is still serving the same room. Let the transport
          // router try every candidate before marking the host for repair.
          setState((current) => ({ ...current, connectionIssue: issue }));
          return;
        }
        if (issue.code === "pairing-invalid" || issue.code === "revoked") {
          for (const pending of pendingResponsesRef.current.values()) {
            clearTimeout(pending.timer);
            pending.reject(new Error(issue.message));
          }
          pendingResponsesRef.current.clear();
          if (socketRef.current === socket) {
            socketRef.current = undefined;
            cryptoRef.current = undefined;
          }
          if (!isProvisionalPairing()) writeLastActiveHost();
          socket.close();
          setState((current) => ({
            ...current,
            activeHostId: undefined,
            desktopName: undefined,
            connection: "closed",
            desktopOnline: false,
            snapshot: undefined,
            permissions: [],
            focusSessionId: undefined,
            histories: {},
            evidence: {},
            artifactPreviews: {},
            artifactTransfers: {},
            events: [],
            localTurns: [],
            latestSeq: 0,
            connectionIssue: undefined,
            transportMetrics: undefined,
            pendingOutbound: 0,
            pairingSync: undefined,
            error: issue.message,
            hosts: isProvisionalPairing()
              ? current.hosts
              : current.hosts.map((host) => host.roomId === roomId
                  ? { ...host, needsRepair: true, status: "offline" }
                  : host),
          }));
          return;
        }
        setState((current) => ({
          ...current,
          connectionIssue: issue,
        }));
      }
    });
    socket.onMessage((message, encrypted) => {
      if (!isCurrent()) return;
      authenticatedDesktop = true;
      if (authenticationTimer) {
        clearTimeout(authenticationTimer);
        authenticationTimer = undefined;
      }
      // Authentic desktop traffic on this link proves where the desktop lives
      // right now. Queued replays can be old, so only fresh envelopes teach
      // the home relay; presence frames handle the silent-but-online case.
      linkHasDesktop = true;
      if (Date.now() - message.header.sentAt < HOME_LEARN_FRESHNESS_MS) {
        learnHome(relay.endpoint);
      }
      setState((current) => ({ ...current, desktopOnline: true, connectionIssue: undefined }));
      void (async () => {
        const cachedEnvelope = shouldExtendLocalEvidenceCache(message.payload)
          ? await crypto.encrypt(
              message.payload,
              message.header.from,
              message.header.to,
              Date.now(),
              LOCAL_EVIDENCE_CACHE_TTL_MS,
              message.header.to === "mobile" ? crypto.identity.deviceId : undefined,
            )
          : encrypted;
        await bridgeVault.saveMessage(cachedEnvelope);
        socket.ack([encrypted.id]);
        const event = message.payload.kind === "event" ? message.payload.event : undefined;
        const isNewPermission = Boolean(
          event &&
          (event.type === "permission.requested" || event.type === "question.requested") &&
          !stateRef.current.events.some((candidate) => candidate.eventId === event.eventId),
        );
        handlePayload(message.payload, encrypted, crypto);
        if (isNewPermission && document.visibilityState === "visible") {
          navigator.vibrate?.([120, 60, 120]);
        }
        if (
          document.visibilityState !== "visible" &&
          typeof Notification !== "undefined" &&
          Notification.permission === "granted" &&
          event && (
            event.type === "assistant.completed" ||
            event.type === "permission.requested" ||
            event.type === "question.requested" ||
            event.type === "turn.failed"
          )
        ) {
            new Notification(crypto.identity.desktopName, {
              body: event.type === "permission.requested" || event.type === "question.requested"
                ? "Claude 正在等待你处理"
                : "Bridge 有新的会话动态",
              icon: "/icon-192.png",
              tag: encrypted.id,
            });
        }
      })().catch(() => setState((current) => ({ ...current, error: "新消息暂时无法保存" })));
    });
    socket.connect();
    connectionTimerRef.current = setTimeout(() => {
      if (!isCurrent() || socket.state === "connected") return;
      setState((current) => ({
        ...current,
        connectionIssue: {
          code: "unreachable",
          message: "无法连接这台电脑，请确认电脑 Bridge 在线并检查网络。",
        },
      }));
    }, Math.max(12_000, relayEndpoints.length * 8_000 + 2_000));
  }, [handlePayload, refreshSessionList, refreshSnapshot, resumeEvents, updateHostCache]);

  useEffect(() => {
    let active = true;
    void (async () => {
      const hosts = await bridgeVault.listHosts();
      if (!active) return;
      cryptoByRoomRef.current = new Map(hosts.map((host) => [host.roomId, host.crypto]));
      const summaries = await Promise.all(hosts.map(async (host) => {
        const stored = await readStoredHostState(host.crypto);
        return hostSummary(host, stored.snapshot, stored.permissions);
      }));
      if (!active) return;
      setState((current) => ({ ...current, loading: false, hosts: summaries }));
      const lastRoomId = readLastActiveHost();
      const lastHost = lastRoomId ? hosts.find((host) => host.roomId === lastRoomId) : undefined;
      if (lastRoomId && (!lastHost || lastHost.needsRepair)) writeLastActiveHost();
      if (lastHost && !lastHost.needsRepair) await start(lastHost.crypto, false);
    })().catch(() => setState((current) => ({
      ...current,
      loading: false,
      error: "无法读取本机配对信息",
    })));
    return () => {
      active = false;
      if (connectionTimerRef.current) clearTimeout(connectionTimerRef.current);
      if (pairingSyncTimerRef.current) clearTimeout(pairingSyncTimerRef.current);
      socketRef.current?.close();
      for (const pending of pendingResponsesRef.current.values()) clearTimeout(pending.timer);
      pendingResponsesRef.current.clear();
    };
  }, [start]);

  const reconnectAndResume = useCallback(() => {
    const socket = socketRef.current;
    if (!socket) return;
    socket.connect();
    if (socket.state === "connected") void resumeEvents();
  }, [resumeEvents]);

  useEffect(() => onNativePushWake(reconnectAndResume), [reconnectAndResume]);

  useEffect(() => {
    const reconnect = () => {
      if (document.visibilityState === "hidden") return;
      reconnectAndResume();
    };
    const visibilityChanged = () => {
      if (document.visibilityState === "visible") reconnect();
    };
    window.addEventListener("online", reconnect);
    document.addEventListener("visibilitychange", visibilityChanged);
    return () => {
      window.removeEventListener("online", reconnect);
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, [reconnectAndResume]);

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return undefined;
    let active = true;
    let remove: (() => Promise<void>) | undefined;
    void CapacitorApp.addListener("appStateChange", ({ isActive }) => {
      if (isActive) reconnectAndResume();
    }).then((handle) => {
      if (!active) void handle.remove();
      else remove = () => handle.remove();
    }).catch(() => undefined);
    return () => {
      active = false;
      void remove?.();
    };
  }, [reconnectAndResume]);

  const pair = useCallback(async (pairing: PairingBundle): Promise<boolean> => {
    if (pairingSyncTimerRef.current) clearTimeout(pairingSyncTimerRef.current);
    setState((current) => ({
      ...current,
      loading: true,
      error: undefined,
      pairingSync: {
        roomId: pairing.roomId,
        desktopName: pairing.desktopName,
        stage: "connecting",
        progress: 14,
      },
    }));
    if (
      Capacitor.isNativePlatform() &&
      pairing.relayEndpoints.every((endpoint) => isLoopbackRelay(endpoint.url))
    ) {
      setState((current) => ({
        ...current,
        loading: false,
        pairingSync: undefined,
        error: "电脑端二维码来自旧版本，请先更新电脑端 Bridge。",
      }));
      return false;
    }
    const previousLastActiveHost = readLastActiveHost();
    let preparedCrypto: BridgeCrypto | undefined;
    const pairingPhase: PairingConnectionPhase = { provisional: true };
    try {
      const crypto = await BridgeCrypto.fromPairing(pairing, {
        instanceId: pendingPairingInstanceId(pairing.roomId, pairing.deviceId),
      });
      preparedCrypto = crypto;
      await start(crypto, true, undefined, pairing, pairingPhase);
      const connectDeadline = Date.now() + 20_000;
      while (socketRef.current?.state !== "connected") {
        if (cryptoRef.current !== crypto) {
          throw new Error(stateRef.current.error ?? "电脑端已拒绝这次配对");
        }
        if (Date.now() >= connectDeadline) throw new Error("连接电脑超时");
        await delay(100);
      }
      const response = await sendRequest("snapshot.get", {}, {
        wait: true,
        timeoutMs: 20_000,
      });
      const verifiedSnapshot = confirmedPairingSnapshot(pairing, response);
      setState((current) => advancePairingSync(current, crypto.identity.roomId, "syncing", 56));
      await bridgeVault.importPairing(pairing, crypto);
      clearPendingPairingInstanceId(pairing.roomId, pairing.deviceId);
      cryptoByRoomRef.current.set(crypto.identity.roomId, crypto);
      pairingPhase.provisional = false;
      const verifiedState = rebaseSnapshot(verifiedSnapshot, stateRef.current.events);
      const nextHost = hostSummary({
        hostId: pairing.hostId,
        pairingEpoch: pairing.pairingEpoch,
        roomId: crypto.identity.roomId,
        desktopName: crypto.identity.desktopName,
        relayUrl: crypto.identity.relayUrl,
        serviceOrigin: pairing.serviceOrigin,
        relayEndpoints: pairing.relayEndpoints,
        activeEndpoint: pairing.activeEndpoint,
        iceServers: preferredBridgeIceServers(pairing.iceServers),
        updatedAt: Date.now(),
        needsRepair: false,
        crypto,
      }, verifiedState.snapshot, verifiedState.permissions);
      setState((current) => ({
        ...current,
        loading: false,
        hosts: [
          hostWithRuntimeState(nextHost, verifiedState.snapshot, verifiedState.permissions),
          ...current.hosts.filter((host) => host.hostId !== nextHost.hostId),
        ],
        snapshot: verifiedState.snapshot,
        permissions: verifiedState.permissions,
        desktopName: verifiedState.snapshot.host.name,
        desktopOnline: true,
        latestSeq: verifiedState.latestSeq,
        pairingSync: current.pairingSync?.roomId === crypto.identity.roomId
          ? { ...current.pairingSync, stage: "syncing", progress: 66 }
          : current.pairingSync,
      }));
      writeLastActiveHost(crypto.identity.roomId);
      setState((current) => advancePairingSync(current, crypto.identity.roomId, "syncing", 72));
      await resumeEvents(true);
      setState((current) => advancePairingSync(current, crypto.identity.roomId, "syncing", 80));
      const snapshotSynced = await refreshSnapshot().catch(() => false);
      if (!snapshotSynced) await refreshSessionList().catch(() => false);
      setState((current) => advancePairingSync(current, crypto.identity.roomId, "ready", 100));
      void nativePushRegistration().then((push) => {
        if (push && cryptoRef.current === crypto && socketRef.current?.state === "connected") {
          socketRef.current.registerPushToken(push.platform, push.token);
        }
      }).catch(() => undefined);
      pairingSyncTimerRef.current = setTimeout(() => {
        setState((current) => (
          current.pairingSync?.roomId === crypto.identity.roomId && current.pairingSync.stage === "ready"
            ? { ...current, pairingSync: undefined }
            : current
        ));
      }, 650);
      return true;
    } catch (error) {
      if (preparedCrypto && cryptoRef.current === preparedCrypto) {
        socketRef.current?.close();
        socketRef.current = undefined;
        cryptoRef.current = undefined;
      }
      if (preparedCrypto) {
        await bridgeVault.removeDeviceArtifacts(
          preparedCrypto.identity.roomId,
          preparedCrypto.identity.deviceId,
        ).catch(() => undefined);
      }
      writeLastActiveHost(previousLastActiveHost);
      const message = error instanceof Error ? error.message : "";
      setState((current) => ({
        ...current,
        loading: false,
        pairingSync: undefined,
        activeHostId: undefined,
        desktopName: undefined,
        connection: "closed",
        desktopOnline: false,
        snapshot: undefined,
        permissions: [],
        connectionIssue: undefined,
        transportMetrics: undefined,
        error: /expired/iu.test(message)
          ? "二维码已超过十分钟，请在电脑端重新生成"
          : /prepared pairing|identity|身份/iu.test(message)
            ? "二维码身份校验失败，请在电脑端重新生成"
            : "未能与电脑完成加密配对，请在电脑端重新生成二维码后重试。",
      }));
      return false;
    }
  }, [refreshSessionList, refreshSnapshot, resumeEvents, sendRequest, start]);

  const selectHost = useCallback(async (roomId: string, focusSessionId?: string) => {
    let crypto = cryptoByRoomRef.current.get(roomId);
    if (!crypto) {
      const hosts = await bridgeVault.listHosts();
      cryptoByRoomRef.current = new Map(hosts.map((host) => [host.roomId, host.crypto]));
      crypto = cryptoByRoomRef.current.get(roomId);
    }
    if (!crypto) throw new Error("Paired host not found");
    const storedHost = await bridgeVault.getHost(roomId);
    if (storedHost?.needsRepair) {
      setState((current) => ({
        ...current,
        error: "V0.4.0 已轮换安全密钥，请在电脑端重新生成二维码。",
      }));
      return;
    }
    await bridgeVault.touchHost(crypto).catch(() => undefined);
    await start(crypto, false, focusSessionId);
  }, [start]);

  const backToHosts = useCallback(() => {
    if (connectionTimerRef.current) clearTimeout(connectionTimerRef.current);
    socketRef.current?.close();
    socketRef.current = undefined;
    cryptoRef.current = undefined;
    writeLastActiveHost();
    setState((current) => ({
      ...current,
      activeHostId: undefined,
      desktopName: undefined,
      connection: "idle",
      desktopOnline: false,
      snapshot: undefined,
      permissions: [],
      focusSessionId: undefined,
      histories: {},
      evidence: {},
      artifactPreviews: {},
      artifactTransfers: {},
      events: [],
      localTurns: [],
      latestSeq: 0,
      connectionIssue: undefined,
      pairingSync: undefined,
      error: undefined,
    }));
  }, []);

  const openSession = useCallback(async (sessionId: string) => {
    setState((current) => ({
      ...current,
      histories: {
        ...current.histories,
        [sessionId]: {
          status: "loading",
          items: current.histories[sessionId]?.items ?? [],
          hasMore: current.histories[sessionId]?.hasMore ?? false,
          ...(current.histories[sessionId]?.nextCursor
            ? { nextCursor: current.histories[sessionId].nextCursor }
            : {}),
          },
        },
      evidence: {
        ...current.evidence,
        [sessionId]: {
          status: "loading",
          items: current.evidence[sessionId]?.items ?? [],
          hasMore: current.evidence[sessionId]?.hasMore ?? false,
          ...(current.evidence[sessionId]?.nextCursor
            ? { nextCursor: current.evidence[sessionId]!.nextCursor }
            : {}),
        },
      },
    }));
    try {
      const [response, evidenceResponse] = await Promise.all([
        sendRequest("session.open", { sessionId }, { wait: true }),
        sendRequest("evidence.list", { sessionId, limit: 30 }, {
          wait: true,
          timeoutMs: 45_000,
        }).catch(() => undefined),
      ]);
      if (!response?.ok) throw new Error(response?.error?.message ?? "会话打开失败");
      const result = response.result as { history?: BridgeHistoryPage; session?: BridgeSessionInfo };
      if (!result.history) throw new Error("电脑未返回会话历史");
      const evidenceResult = evidenceResponse?.ok
        ? evidenceResponse.result as { evidence?: BridgeEvidencePage }
        : undefined;
      setState((current) => ({
        ...current,
        histories: {
          ...current.histories,
          [sessionId]: {
            status: "ready",
            items: result.history!.items,
            hasMore: result.history!.hasMore,
            ...(result.history!.nextCursor ? { nextCursor: result.history!.nextCursor } : {}),
          },
        },
        evidence: {
          ...current.evidence,
          [sessionId]: evidenceResult?.evidence ? {
            status: "ready",
            items: mergeEvidence(
              current.evidence[sessionId]?.items ?? [],
              evidenceResult.evidence.items,
            ),
            hasMore: evidenceResult.evidence.hasMore,
            ...(evidenceResult.evidence.nextCursor
              ? { nextCursor: evidenceResult.evidence.nextCursor }
              : {}),
          } : {
            status: "error",
            items: current.evidence[sessionId]?.items ?? [],
            hasMore: false,
          },
        },
      }));
    } catch (error) {
      setState((current) => ({
        ...current,
        histories: {
          ...current.histories,
          [sessionId]: {
            status: "error",
            items: current.histories[sessionId]?.items ?? [],
            hasMore: current.histories[sessionId]?.hasMore ?? false,
            error: error instanceof Error ? error.message : "会话打开失败",
          },
        },
        evidence: {
          ...current.evidence,
          [sessionId]: {
            status: current.evidence[sessionId]?.items.length ? "ready" : "error",
            items: current.evidence[sessionId]?.items ?? [],
            hasMore: current.evidence[sessionId]?.hasMore ?? false,
          },
        },
        error: error instanceof Error ? error.message : "会话打开失败",
      }));
    }
  }, [sendRequest]);

  const loadOlderEvidence = useCallback(async (sessionId: string) => {
    const current = stateRef.current.evidence[sessionId];
    if (!current?.nextCursor || current.status === "loading") return;
    setState((stateValue) => ({
      ...stateValue,
      evidence: {
        ...stateValue.evidence,
        [sessionId]: { ...current, status: "loading" },
      },
    }));
    try {
      const response = await sendRequest("evidence.list", {
        sessionId,
        cursor: current.nextCursor,
        limit: 30,
      }, { wait: true, timeoutMs: 45_000 });
      if (!response?.ok) throw new Error(response?.error?.message ?? "成果加载失败");
      const result = response.result as { evidence?: BridgeEvidencePage };
      if (!result.evidence) throw new Error("电脑未返回成果证据");
      const page = result.evidence;
      setState((stateValue) => ({
        ...stateValue,
        evidence: {
          ...stateValue.evidence,
          [sessionId]: {
            status: "ready",
            items: mergeEvidence(current.items, page.items),
            hasMore: page.hasMore,
            ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
          },
        },
      }));
    } catch (error) {
      setState((stateValue) => ({
        ...stateValue,
        evidence: {
          ...stateValue.evidence,
          [sessionId]: { ...current, status: "error" },
        },
        error: error instanceof Error ? error.message : "成果加载失败",
      }));
    }
  }, [sendRequest]);

  const previewArtifact = useCallback(async (
    artifactId: string,
  ): Promise<BridgeArtifactPreview> => {
    const cached = stateRef.current.artifactPreviews[artifactId];
    if (cached) return cached;
    const response = await sendRequest("artifact.preview", { artifactId }, {
      wait: true,
      timeoutMs: 60_000,
    });
    if (!response?.ok) throw new Error(response?.error?.message ?? "成果预览失败");
    const result = response.result as { preview?: BridgeArtifactPreview };
    if (!result.preview) throw new Error("电脑未返回成果预览");
    setState((current) => ({
      ...current,
      artifactPreviews: {
        ...current.artifactPreviews,
        [artifactId]: result.preview!,
      },
    }));
    return result.preview;
  }, [sendRequest]);

  const downloadArtifact = useCallback(async (artifact: BridgeArtifactManifest) => {
    setState((current) => ({
      ...current,
      artifactTransfers: { ...current.artifactTransfers, [artifact.id]: 0 },
    }));
    try {
      await downloadBridgeArtifact(
        artifact,
        (method, params, options) => sendRequest(method, params, options),
        (progress) => setState((current) => ({
          ...current,
          artifactTransfers: {
            ...current.artifactTransfers,
            [artifact.id]: progress,
          },
        })),
      );
    } finally {
      setState((current) => {
        const artifactTransfers = { ...current.artifactTransfers };
        delete artifactTransfers[artifact.id];
        return { ...current, artifactTransfers };
      });
    }
  }, [sendRequest]);

  const loadOlderHistory = useCallback(async (sessionId: string) => {
    const current = stateRef.current.histories[sessionId];
    if (!current?.nextCursor || current.status === "loading") return;
    setState((stateValue) => ({
      ...stateValue,
      histories: {
        ...stateValue.histories,
        [sessionId]: { ...current, status: "loading" },
      },
    }));
    try {
      const response = await sendRequest("session.history", {
        sessionId,
        cursor: current.nextCursor,
        limit: 50,
      }, { wait: true });
      if (!response?.ok) throw new Error(response?.error?.message ?? "历史加载失败");
      const result = response.result as { history?: BridgeHistoryPage };
      if (!result.history) throw new Error("电脑未返回历史");
      const page = result.history;
      setState((stateValue) => ({
        ...stateValue,
        histories: {
          ...stateValue.histories,
          [sessionId]: {
            status: "ready",
            items: [...page.items, ...current.items],
            hasMore: page.hasMore,
            ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
          },
        },
      }));
    } catch {
      setState((stateValue) => ({
        ...stateValue,
        histories: {
          ...stateValue.histories,
          [sessionId]: { ...current, status: "error" },
        },
      }));
    }
  }, [sendRequest]);

  const sendTurn = useCallback(async (
    sessionId: string,
    text: string,
    attachments: BridgeAttachment[] = [],
    steer = false,
  ) => {
    await sendRequest(steer ? "turn.steer" : "turn.start", {
      sessionId,
      text,
      attachments,
    }, { allowOffline: true, idempotencyKey: randomId() });
  }, [sendRequest]);

  const interruptTurn = useCallback(async (sessionId: string, commandId?: string) => {
    const response = await sendRequest("turn.interrupt", {
      sessionId,
      ...(commandId ? { commandId } : {}),
      force: true,
    }, { allowOffline: false, wait: true });
    if (!response?.ok) throw new Error(response?.error?.message ?? "任务停止失败");
    const result = response.result as { interrupted?: boolean } | undefined;
    if (result?.interrupted !== true) throw new Error("当前没有可停止的 Bridge 任务");
    await resumeEvents();
  }, [resumeEvents, sendRequest]);

  const resolveUncertainDelivery = useCallback(async (
    commandId: string,
    action: "confirm" | "retry",
  ) => {
    const response = await sendRequest("message.delivery.resolve", {
      commandId,
      action,
    }, { allowOffline: false, wait: true });
    if (!response?.ok) throw new Error(response?.error?.message ?? "投递状态处理失败");
    await resumeEvents();
  }, [resumeEvents, sendRequest]);

  const resolvePermission = useCallback(async (
    requestId: string,
    decision: "allow-once" | "allow-always" | "deny",
    message?: string,
    updatedInput?: Record<string, unknown>,
  ) => {
    const response = await sendRequest("permission.resolve", {
      requestId,
      decision,
      ...(message ? { message } : {}),
      ...(updatedInput ? { updatedInput } : {}),
    }, { allowOffline: false, wait: true });
    if (!response?.ok) {
      if (response?.error?.code === "ALREADY_RESOLVED") {
        setState((current) => {
          const permissions = current.permissions.filter((permission) => permission.requestId !== requestId);
          const snapshot = snapshotWithPermissions(current.snapshot, permissions);
          return {
            ...current,
            snapshot,
            permissions,
            hosts: current.hosts.map((host) => host.roomId === current.activeHostId
              ? hostWithRuntimeState(host, snapshot, permissions)
              : host),
          };
        });
        await resumeEvents();
      }
      throw new Error(response?.error?.message ?? "授权处理失败");
    }
    setState((current) => {
      const permissions = current.permissions.filter((permission) => permission.requestId !== requestId);
      const snapshot = snapshotWithPermissions(current.snapshot, permissions);
      return {
        ...current,
        snapshot,
        permissions,
        hosts: current.hosts.map((host) => host.roomId === current.activeHostId
          ? hostWithRuntimeState(host, snapshot, permissions)
          : host),
      };
    });
  }, [resumeEvents, sendRequest]);

  const createSession = useCallback(async (
    cwd: string,
    title?: string,
    runtimeId?: BridgeDesktopRuntimeId,
  ): Promise<BridgeSessionInfo | undefined> => {
    const response = await sendRequest("session.create", {
      cwd,
      ...(title ? { title } : {}),
      ...(runtimeId ? { runtimeId } : {}),
    }, { wait: true });
    if (!response?.ok) throw new Error(response?.error?.message ?? "新建会话失败");
    const result = response.result as { session?: BridgeSessionInfo };
    return result.session;
  }, [sendRequest]);

  const loadSessionConfiguration = useCallback(async (sessionId: string): Promise<BridgeSessionConfiguration> => {
    const response = await sendRequest("session.configuration", { sessionId }, {
      wait: true,
      timeoutMs: 45_000,
    });
    if (!response?.ok) throw new Error(response?.error?.message ?? "会话配置读取失败");
    const result = response.result as { configuration?: BridgeSessionConfiguration };
    if (!result.configuration) throw new Error("电脑未返回会话配置");
    return result.configuration;
  }, [sendRequest]);

  const configureSession = useCallback(async (
    sessionId: string,
    change: {
      model?: string | null;
      provider?: string | null;
      effort?: string | null;
      reasoningEffort?: string | null;
      fast?: boolean | null;
    },
  ): Promise<BridgeSessionConfiguration> => {
    const response = await sendRequest("session.configure", { sessionId, ...change }, {
      wait: true,
      timeoutMs: 45_000,
    });
    if (!response?.ok) throw new Error(response?.error?.message ?? "会话配置保存失败");
    const result = response.result as {
      configuration?: BridgeSessionConfiguration;
      session?: BridgeSessionInfo;
    };
    if (!result.configuration) throw new Error("电脑未返回会话配置");
    if (result.session) {
      setState((current) => current.snapshot ? {
        ...current,
        snapshot: {
          ...current.snapshot,
          sessions: current.snapshot.sessions.map((session) => (
            session.sessionId === result.session!.sessionId ? result.session! : session
          )),
        },
      } : current);
    }
    return result.configuration;
  }, [sendRequest]);

  const configurePermissionPolicy = useCallback(async (
    sessionId: string,
    scope: "host" | "session",
    mode: BridgePermissionMode | null,
  ): Promise<BridgeSessionConfiguration> => {
    const response = await sendRequest("permission.policy.configure", {
      sessionId,
      scope,
      mode,
    }, { wait: true, timeoutMs: 45_000 });
    if (!response?.ok) throw new Error(response?.error?.message ?? "授权模式保存失败");
    const result = response.result as {
      configuration?: BridgeSessionConfiguration;
      defaultPermissionMode?: BridgePermissionMode;
    };
    if (!result.configuration) throw new Error("电脑未返回授权配置");
    setState((current) => current.snapshot ? {
      ...current,
      snapshot: {
        ...current.snapshot,
        host: {
          ...current.snapshot.host,
          ...(result.defaultPermissionMode
            ? { defaultPermissionMode: result.defaultPermissionMode }
            : {}),
        },
      },
    } : current);
    await resumeEvents();
    return result.configuration;
  }, [resumeEvents, sendRequest]);

  const previewProviderSwitch = useCallback(async (
    sessionId: string,
    targetProviderProfileId: string,
    model?: string,
  ) => {
    const response = await sendRequest("conversation.switch.preview", {
      sessionId,
      targetProviderProfileId,
      ...(model ? { model } : {}),
    }, { wait: true, timeoutMs: 45_000 });
    if (!response?.ok) throw new Error(response?.error?.message ?? "提供方接力预览失败");
    const result = response.result as {
      handoff?: BridgeHandoff;
      route?: BridgeConversationRoute;
      target?: BridgeProviderProfile;
      summary?: string;
    };
    if (!result.handoff || !result.route || !result.target || typeof result.summary !== "string") {
      throw new Error("电脑未返回完整接力预览");
    }
    setState((current) => current.snapshot ? {
      ...current,
      snapshot: {
        ...current.snapshot,
        sessions: current.snapshot.sessions.map((session) => (
          session.sessionId === result.route!.conversationId
            ? sessionWithRoute(session, result.route!)
            : session
        )),
      },
    } : current);
    return {
      handoff: result.handoff,
      route: result.route,
      target: result.target,
      summary: result.summary,
    };
  }, [sendRequest]);

  const commitProviderSwitch = useCallback(async (
    handoffId: string,
    targetNativeSessionId?: string,
    model?: string,
  ) => {
    const response = await sendRequest("conversation.switch.commit", {
      handoffId,
      ...(targetNativeSessionId ? { targetNativeSessionId } : {}),
      ...(model ? { model } : {}),
    }, { wait: true, timeoutMs: 45_000 });
    if (!response?.ok) throw new Error(response?.error?.message ?? "提供方切换失败");
    const result = response.result as {
      handoff?: BridgeHandoff;
      route?: BridgeConversationRoute;
      deepLink?: string;
    };
    if (!result.handoff || !result.route) throw new Error("电脑未返回完整接力状态");
    setState((current) => current.snapshot ? {
      ...current,
      snapshot: {
        ...current.snapshot,
        sessions: current.snapshot.sessions.map((session) => (
          session.sessionId === result.route!.conversationId
            ? sessionWithRoute(session, result.route!)
            : session
        )),
      },
    } : current);
    return {
      handoff: result.handoff,
      route: result.route,
      ...(result.deepLink ? { deepLink: result.deepLink } : {}),
    };
  }, [sendRequest]);

  const cancelProviderSwitch = useCallback(async (handoffId: string): Promise<void> => {
    const response = await sendRequest("conversation.switch.cancel", {
      handoffId,
    }, { wait: true, timeoutMs: 45_000 });
    if (!response?.ok) throw new Error(response?.error?.message ?? "取消接力失败");
    const result = response.result as { route?: BridgeConversationRoute };
    if (!result.route) return;
    setState((current) => current.snapshot ? {
      ...current,
      snapshot: {
        ...current.snapshot,
        sessions: current.snapshot.sessions.map((session) => (
          session.sessionId === result.route!.conversationId
            ? sessionWithRoute(session, result.route!)
            : session
        )),
      },
    } : current);
  }, [sendRequest]);

  const refreshProviders = useCallback(async (): Promise<void> => {
    const response = await sendRequest("provider.refresh", {}, {
      wait: true,
      timeoutMs: 45_000,
    });
    if (!response?.ok) throw new Error(response?.error?.message ?? "提供方状态刷新失败");
    const result = response.result as { providers?: BridgeProviderProfile[] };
    const providers = result.providers;
    if (!providers) throw new Error("电脑未返回提供方状态");
    setState((current) => current.snapshot ? {
      ...current,
      snapshot: { ...current.snapshot, providers },
    } : current);
  }, [sendRequest]);

  const controlClaudeDesktop = useCallback(async (
    action: "status" | "launch" | "quit",
  ): Promise<ClaudeDesktopAppStatus> => {
    const method: BridgeRequest["method"] = `claude.desktop.${action}`;
    const response = await sendRequest(method, {}, {
      wait: true,
      timeoutMs: action === "status" ? 20_000 : 45_000,
    });
    if (!response?.ok) {
      throw new Error(response?.error?.message ?? (
        action === "launch" ? "Claude Desktop 启动失败" : action === "quit" ? "Claude Desktop 退出失败" : "无法读取 Claude Desktop 状态"
      ));
    }
    const result = response.result as { claudeDesktop?: ClaudeDesktopAppStatus } | undefined;
    if (!result?.claudeDesktop) throw new Error("电脑未返回 Claude Desktop 状态");
    const claudeDesktop = result.claudeDesktop;
    setState((current) => ({
      ...current,
      snapshot: snapshotWithClaudeDesktop(current.snapshot, claudeDesktop),
    }));
    return claudeDesktop;
  }, [sendRequest]);

  const launchClaudeDesktop = useCallback(
    () => controlClaudeDesktop("launch"),
    [controlClaudeDesktop],
  );

  const quitClaudeDesktop = useCallback(
    () => controlClaudeDesktop("quit"),
    [controlClaudeDesktop],
  );

  const controlDesktopApp = useCallback(async (
    runtimeId: BridgeDesktopRuntimeId,
    action: "status" | "launch" | "quit",
  ): Promise<BridgeDesktopAppStatus[]> => {
    const method: BridgeRequest["method"] = `desktop.app.${action}`;
    const response = await sendRequest(method, { runtimeId }, {
      wait: true,
      timeoutMs: action === "status" ? 20_000 : 45_000,
    });
    if (!response?.ok) {
      throw new Error(response?.error?.message ?? (
        action === "launch" ? "Desktop 应用启动失败" : action === "quit" ? "Desktop 应用退出失败" : "无法读取 Desktop 应用状态"
      ));
    }
    const result = response.result as { desktopApps?: BridgeDesktopAppStatus[] } | undefined;
    if (!result?.desktopApps) throw new Error("电脑未返回 Desktop 应用状态");
    const desktopApps = result.desktopApps;
    setState((current) => {
      if (!current.snapshot) return current;
      const claudeDesktop = desktopApps.find((app) => app.id === "claude-desktop");
      return {
        ...current,
        snapshot: {
          ...current.snapshot,
          desktopApps,
          ...(claudeDesktop ? { claudeDesktop } : {}),
        },
      };
    });
    return desktopApps;
  }, [sendRequest]);

  const refresh = useCallback(async (sessionId?: string): Promise<boolean> => {
    try {
      // Ask the desktop to re-discover native sessions first; otherwise a
      // manual sync can only echo the desktop's cached snapshot and sessions
      // created on the computer never reach the phone. Tolerate failure so
      // older desktops still serve their cached state below.
      await sendRequest("runtime.refresh", {}, { wait: true, timeoutMs: 45_000 }).catch(() => undefined);
      await resumeEvents();
      let snapshotSynced = false;
      let snapshotError: unknown;
      try {
        snapshotSynced = await refreshSnapshot();
      } catch (error) {
        snapshotError = error;
      }
      if (!snapshotSynced) {
        const sessionListSynced = await refreshSessionList().catch(() => false);
        await controlClaudeDesktop("status").catch(() => undefined);
        if (!sessionListSynced) {
          throw snapshotError instanceof Error ? snapshotError : new Error("电脑端同步失败");
        }
      }
      if (sessionId) await openSession(sessionId);
      return true;
    } catch (error) {
      setState((current) => ({
        ...current,
        error: error instanceof Error ? error.message : "电脑端同步失败",
      }));
      return false;
    }
  }, [controlClaudeDesktop, openSession, refreshSessionList, refreshSnapshot, resumeEvents, sendRequest]);

  const forgetHost = useCallback(async (roomId: string) => {
    const crypto = cryptoByRoomRef.current.get(roomId);
    const active = cryptoRef.current?.identity.roomId === roomId;
    if (active && crypto && socketRef.current?.state === "connected") {
      await sendRequest("device.revoke", { deviceId: crypto.identity.deviceId }, { wait: true }).catch(() => undefined);
    } else if (!active && crypto) {
      await revokeRemoteDevice(crypto).catch(() => undefined);
    }
    if (active) {
      socketRef.current?.close();
      socketRef.current = undefined;
      cryptoRef.current = undefined;
    }
    if (readLastActiveHost() === roomId) writeLastActiveHost();
    await bridgeVault.removeHost(roomId);
    cryptoByRoomRef.current.delete(roomId);
    setState((current) => ({
      ...current,
      hosts: current.hosts.filter((host) => host.roomId !== roomId),
      ...(active ? {
        activeHostId: undefined,
        desktopName: undefined,
        connection: "idle" as const,
        desktopOnline: false,
        snapshot: undefined,
        permissions: [],
        focusSessionId: undefined,
        histories: {},
        evidence: {},
        artifactPreviews: {},
        artifactTransfers: {},
        events: [],
        localTurns: [],
        latestSeq: 0,
        connectionIssue: undefined,
        transportMetrics: undefined,
        pendingOutbound: 0,
        pairingSync: undefined,
      } : {}),
    }));
  }, [sendRequest]);

  const retryConnection = useCallback(async () => {
    const crypto = cryptoRef.current;
    if (crypto) await start(crypto);
  }, [start]);

  const previewRuntimeHandoff = useCallback(async (
    sessionId: string,
    targetRuntimeId: BridgeDesktopRuntimeId,
  ): Promise<BridgeRuntimeHandoffPreview> => {
    const response = await sendRequest("runtime.handoff.preview", {
      sessionId,
      targetRuntimeId,
    }, { wait: true, timeoutMs: 60_000 });
    if (!response?.ok) throw new Error(response?.error?.message ?? "跨 Desktop 接力预览失败");
    const result = response.result as { preview?: BridgeRuntimeHandoffPreview };
    if (!result.preview?.handoff) throw new Error("电脑未返回完整接力预览");
    return result.preview;
  }, [sendRequest]);

  const commitRuntimeHandoff = useCallback(async (handoffId: string) => {
    const response = await sendRequest("runtime.handoff.commit", {
      handoffId,
    }, { wait: true, timeoutMs: 60_000 });
    if (!response?.ok) throw new Error(response?.error?.message ?? "跨 Desktop 接力失败");
    const result = response.result as { handoff?: BridgeRuntimeHandoff };
    if (!result.handoff) throw new Error("电脑未返回接力状态");
    return result.handoff;
  }, [sendRequest]);

  const confirmRuntimeHandoff = useCallback(async (handoffId: string, objective?: string) => {
    const response = await sendRequest("runtime.handoff.confirm", {
      handoffId,
      ...(objective?.trim() ? { objective: objective.trim() } : {}),
    }, { wait: true, timeoutMs: 60_000 });
    if (!response?.ok) throw new Error(response?.error?.message ?? "确认执行失败");
    const result = response.result as { handoff?: BridgeRuntimeHandoff; goal?: BridgeRuntimeGoalInfo };
    if (!result.handoff) throw new Error("电脑未返回接力状态");
    return { handoff: result.handoff, ...(result.goal ? { goal: result.goal } : {}) };
  }, [sendRequest]);

  const cancelRuntimeHandoff = useCallback(async (handoffId: string) => {
    const response = await sendRequest("runtime.handoff.cancel", {
      handoffId,
    }, { wait: true, timeoutMs: 45_000 });
    if (!response?.ok) throw new Error(response?.error?.message ?? "取消接力失败");
    const result = response.result as { handoff?: BridgeRuntimeHandoff };
    return result.handoff;
  }, [sendRequest]);

  const getRuntimeHandoff = useCallback(async (handoffId: string) => {
    const response = await sendRequest("runtime.handoff.get", {
      handoffId,
    }, { wait: true, timeoutMs: 30_000 });
    if (!response?.ok) throw new Error(response?.error?.message ?? "读取接力状态失败");
    const result = response.result as { handoff?: BridgeRuntimeHandoff };
    if (!result.handoff) throw new Error("电脑未返回接力状态");
    return result.handoff;
  }, [sendRequest]);

  const pauseRuntimeGoal = useCallback(async (sessionId: string) => {
    const response = await sendRequest("runtime.goal.pause", {
      sessionId,
    }, { wait: true, timeoutMs: 30_000 });
    if (!response?.ok) throw new Error(response?.error?.message ?? "暂停目标失败");
  }, [sendRequest]);

  const resumeRuntimeGoal = useCallback(async (sessionId: string) => {
    const response = await sendRequest("runtime.goal.resume", {
      sessionId,
    }, { wait: true, timeoutMs: 30_000 });
    if (!response?.ok) throw new Error(response?.error?.message ?? "恢复目标失败");
  }, [sendRequest]);

  const openRuntimeFile = useCallback(async (sessionId: string, filePath: string) => {
    const response = await sendRequest("runtime.file.open", {
      sessionId,
      path: filePath,
    }, { wait: true, timeoutMs: 30_000 });
    if (!response?.ok) throw new Error(response?.error?.message ?? "打开文件失败");
  }, [sendRequest]);

  const archiveSession = useCallback(async (sessionId: string, archived: boolean) => {
    const response = await sendRequest("session.archive", {
      sessionId,
      archived,
    }, { wait: true, timeoutMs: 30_000 });
    if (!response?.ok) throw new Error(response?.error?.message ?? "归档设置失败");
  }, [sendRequest]);

  const deleteSession = useCallback(async (sessionId: string) => {
    const response = await sendRequest("session.delete", {
      sessionId,
    }, { wait: true, timeoutMs: 30_000 });
    if (!response?.ok) throw new Error(response?.error?.message ?? "删除会话失败");
  }, [sendRequest]);

  return {
    state,
    pair,
    selectHost,
    backToHosts,
    openSession,
    loadOlderHistory,
    loadOlderEvidence,
    previewArtifact,
    downloadArtifact,
    sendTurn,
    interruptTurn,
    resolveUncertainDelivery,
    resolvePermission,
    createSession,
    loadSessionConfiguration,
    configureSession,
    configurePermissionPolicy,
    previewProviderSwitch,
    commitProviderSwitch,
    cancelProviderSwitch,
    previewRuntimeHandoff,
    commitRuntimeHandoff,
    confirmRuntimeHandoff,
    cancelRuntimeHandoff,
    getRuntimeHandoff,
    pauseRuntimeGoal,
    resumeRuntimeGoal,
    archiveSession,
    deleteSession,
    openRuntimeFile,
    refreshProviders,
    launchClaudeDesktop,
    controlDesktopApp,
    quitClaudeDesktop,
    refresh,
    forgetHost,
    retryConnection,
  };
}
