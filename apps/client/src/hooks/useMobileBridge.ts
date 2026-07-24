import {
  BridgeCrypto,
  BridgeSocket,
  randomId,
  type BridgeAttachment,
  type BridgeDeliveryState,
  type BridgeEffort,
  type BridgeEvent,
  type BridgeHistoryPage,
  type BridgeHostSnapshot,
  type BridgePayload,
  type BridgePermissionInfo,
  type BridgeRequest,
  type BridgeResponse,
  type BridgeSessionConfiguration,
  type BridgeSessionInfo,
  type ClaudeDesktopAppStatus,
  type DecryptedEnvelope,
  type EncryptedEnvelope,
  type PairingBundle,
  type SocketState,
} from "@bridge/protocol";
import { Capacitor } from "@capacitor/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { bridgeVault, type StoredBridgeHost } from "../lib/vault.js";
import { nativePushRegistration, onNativePushWake } from "../lib/push-wake.js";

export interface PairedHost {
  roomId: string;
  desktopName: string;
  relayUrl: string;
  needsRepair: boolean;
  status: "standby" | "running" | "attention" | "offline";
  lastSeenAt?: number;
  activeTurns: number;
  attentionSessionId?: string;
}

export interface MobileConnectionIssue {
  code: "unreachable" | "pairing-invalid" | "revoked";
  message: string;
}

export interface SessionHistoryState {
  status: "idle" | "loading" | "ready" | "error";
  items: BridgeHistoryPage["items"];
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

interface PendingResponse {
  resolve(response: BridgeResponse): void;
  timer: ReturnType<typeof setTimeout>;
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
  events: BridgeEvent[];
  localTurns: LocalTurn[];
  latestSeq: number;
  connectionIssue: MobileConnectionIssue | undefined;
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
  events: [],
  localTurns: [],
  latestSeq: 0,
  connectionIssue: undefined,
  error: undefined,
};

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
    code === "PAIRING_ALREADY_USED"
  ) {
    return {
      code: "pairing-invalid",
      message: "配对已过期或已绑定其他设备，请删除后在电脑端生成新二维码。",
    };
  }
  return { code: "unreachable", message: fallback };
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
  return {
    roomId: host.roomId,
    desktopName: host.desktopName,
    relayUrl: host.relayUrl,
    needsRepair: Capacitor.isNativePlatform() && isLoopbackRelay(host.relayUrl),
    status: hostStatus(snapshot, permissions),
    activeTurns: snapshot?.runtime.activeTurns ?? 0,
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

export function snapshotWithClaudeDesktop(
  snapshot: BridgeHostSnapshot | undefined,
  claudeDesktop: ClaudeDesktopAppStatus,
): BridgeHostSnapshot | undefined {
  return snapshot ? { ...snapshot, claudeDesktop } : undefined;
}

export function applyEventToSnapshot(
  snapshot: BridgeHostSnapshot | undefined,
  event: BridgeEvent,
  permissions: BridgePermissionInfo[],
): BridgeHostSnapshot | undefined {
  const current = snapshotWithPermissions(snapshot, permissions);
  if (!current || !event.sessionId) return current;
  const hasPendingPermission = permissions.some((permission) => permission.sessionId === event.sessionId);
  return {
    ...current,
    sessions: current.sessions.map((session) => {
      if (session.sessionId !== event.sessionId) return session;
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
          turnState: session.pendingCount > 0 ? "queued" : "idle",
        };
      }
      return session;
    }),
  };
}

async function readStoredHostState(crypto: BridgeCrypto): Promise<{
  snapshot?: BridgeHostSnapshot;
  permissions: BridgePermissionInfo[];
  events: BridgeEvent[];
  localTurns: LocalTurn[];
  latestSeq: number;
}> {
  const results = await Promise.allSettled(
    (await bridgeVault.listMessages(crypto.identity.roomId)).map((envelope) => crypto.decrypt(envelope)),
  );
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
  return {
    ...(storedSnapshot ? { snapshot: storedSnapshot } : {}),
    permissions,
    events,
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
  const socket = new BridgeSocket({ crypto, role: "mobile", reconnect: false });
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
  const socketRef = useRef<BridgeSocket | undefined>(undefined);
  const connectionTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingResponsesRef = useRef(new Map<string, PendingResponse>());
  const envelopeRequestsRef = useRef(new Map<string, string>());

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

  const handlePayload = useCallback((
    payload: BridgePayload,
    encrypted: EncryptedEnvelope,
    crypto: BridgeCrypto,
  ) => {
    if (payload.kind === "snapshot") {
      let permissions = payload.snapshot.permissions;
      let snapshot: BridgeHostSnapshot | undefined = payload.snapshot;
      for (const event of stateRef.current.events.filter((candidate) => candidate.seq > payload.snapshot.latestSeq)) {
        permissions = applyPermissionEvent(permissions, event);
        snapshot = applyEventToSnapshot(snapshot, event, permissions);
      }
      snapshot = snapshotWithPermissions(snapshot, permissions) ?? payload.snapshot;
      setState((current) => ({
        ...current,
        snapshot,
        permissions,
        desktopName: snapshot.host.name,
      }));
      updateHostCache(crypto.identity.roomId, snapshot, permissions);
      return;
    }
    if (payload.kind === "event") {
      setState((current) => {
        const permissions = applyPermissionEvent(current.permissions, payload.event);
        const snapshot = applyEventToSnapshot(current.snapshot, payload.event, permissions);
        return {
          ...current,
          snapshot,
          permissions,
          events: mergeBridgeEvents(current.events, [payload.event]),
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
    const responsePromise = options.wait ? new Promise<BridgeResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingResponsesRef.current.delete(request.requestId);
        reject(new Error("电脑响应超时"));
      }, options.timeoutMs ?? 20_000);
      pendingResponsesRef.current.set(request.requestId, { resolve, timer });
    }) : undefined;
    try {
      socket.sendEnvelope(envelope);
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
        let permissions = current.permissions;
        let snapshot = current.snapshot;
        for (const event of events) {
          turns = applyEventToTurns(turns, event);
          permissions = applyPermissionEvent(permissions, event);
          snapshot = applyEventToSnapshot(snapshot, event, permissions);
        }
        return {
          ...current,
          snapshot,
          permissions,
          events: mergeBridgeEvents(current.events, events),
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

  const start = useCallback(async (
    crypto: BridgeCrypto,
    bootstrap = false,
    focusSessionId?: string,
  ) => {
    if (connectionTimerRef.current) clearTimeout(connectionTimerRef.current);
    socketRef.current?.close();
    socketRef.current = undefined;
    cryptoRef.current = crypto;
    const roomId = crypto.identity.roomId;
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
      events: [],
      localTurns: [],
      latestSeq: 0,
      connectionIssue: undefined,
      error: undefined,
    }));

    const stored = await readStoredHostState(crypto);
    if (cryptoRef.current !== crypto) return;
    setState((current) => ({
      ...current,
      snapshot: stored.snapshot,
      permissions: stored.permissions,
      events: stored.events,
      localTurns: stored.localTurns,
      latestSeq: stored.latestSeq,
    }));
    if (stored.snapshot) updateHostCache(roomId, stored.snapshot, stored.permissions);

    if (Capacitor.isNativePlatform() && isLoopbackRelay(crypto.identity.relayUrl)) {
      setState((current) => ({
        ...current,
        connection: "closed",
        connectionIssue: {
          code: "pairing-invalid",
          message: "这条配对来自旧版电脑端，请删除后用 Bridge 0.2 二维码重新配对。",
        },
      }));
      return;
    }

    const socket = new BridgeSocket({ crypto, role: "mobile" });
    socketRef.current = socket;
    let bootstrapPending = bootstrap;
    const isCurrent = () => socketRef.current === socket;
    socket.onState((connection) => {
      if (!isCurrent()) return;
      setState((current) => ({ ...current, connection }));
      if (connection === "connected") {
        if (connectionTimerRef.current) clearTimeout(connectionTimerRef.current);
        setState((current) => ({ ...current, connectionIssue: undefined }));
        void (async () => {
          for (const envelope of await bridgeVault.listOutbox(roomId)) {
            try {
              const decrypted = await crypto.decrypt(envelope);
              if (decrypted.payload.kind === "request") {
                envelopeRequestsRef.current.set(envelope.id, decrypted.payload.requestId);
              }
              socket.sendEnvelope(envelope);
            } catch {
              break;
            }
          }
          const push = await nativePushRegistration();
          if (push && isCurrent() && socket.state === "connected") {
            socket.registerPushToken(push.platform, push.token);
          }
          const bootstrapResume = bootstrapPending;
          bootstrapPending = false;
          await resumeEvents(bootstrapResume);
        })();
      }
    });
    socket.onFrame((frame) => {
      if (!isCurrent()) return;
      if (frame.type === "ready") {
        setState((current) => ({
          ...current,
          desktopOnline: frame.onlineDevices.some((device) => device.role === "desktop"),
        }));
      }
      if (frame.type === "presence" && frame.role === "desktop") {
        setState((current) => ({ ...current, desktopOnline: frame.online }));
      }
      if (frame.type === "stored" || frame.type === "acknowledged") {
        const delivery: BridgeDeliveryState = frame.type === "stored" ? "relay-received" : "host-received";
        void Promise.all(frame.ids.map((id) => bridgeVault.removeOutbox(id)));
        const requestIds = frame.ids
          .map((id) => envelopeRequestsRef.current.get(id))
          .filter((value): value is string => Boolean(value));
        setState((current) => ({
          ...current,
          localTurns: current.localTurns.map((turn) => (
            requestIds.includes(turn.requestId) &&
            (turn.delivery === "local-saved" || turn.delivery === "relay-received")
              ? { ...turn, delivery }
              : turn
          )),
        }));
      }
      if (frame.type === "error") {
        setState((current) => ({
          ...current,
          connectionIssue: relayIssue(frame.code, frame.message),
        }));
      }
    });
    socket.onMessage((message, encrypted) => {
      if (!isCurrent()) return;
      void (async () => {
        await bridgeVault.saveMessage(encrypted);
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
    }, 10_000);
  }, [handlePayload, resumeEvents, updateHostCache]);

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
    })().catch(() => setState((current) => ({
      ...current,
      loading: false,
      error: "无法读取本机配对信息",
    })));
    return () => {
      active = false;
      if (connectionTimerRef.current) clearTimeout(connectionTimerRef.current);
      socketRef.current?.close();
      for (const pending of pendingResponsesRef.current.values()) clearTimeout(pending.timer);
      pendingResponsesRef.current.clear();
    };
  }, []);

  useEffect(() => onNativePushWake(() => {
    socketRef.current?.connect();
    void resumeEvents();
  }), [resumeEvents]);

  const pair = useCallback(async (pairing: PairingBundle): Promise<boolean> => {
    setState((current) => ({ ...current, loading: true, error: undefined }));
    if (Capacitor.isNativePlatform() && isLoopbackRelay(pairing.relayUrl)) {
      setState((current) => ({
        ...current,
        loading: false,
        error: "电脑端二维码来自旧版本，请先更新电脑端 Bridge。",
      }));
      return false;
    }
    try {
      const crypto = await bridgeVault.importPairing(pairing);
      cryptoByRoomRef.current.set(crypto.identity.roomId, crypto);
      const nextHost = hostSummary({
        roomId: crypto.identity.roomId,
        desktopName: crypto.identity.desktopName,
        relayUrl: crypto.identity.relayUrl,
        updatedAt: Date.now(),
        crypto,
      });
      setState((current) => ({
        ...current,
        loading: false,
        hosts: [nextHost, ...current.hosts.filter((host) => host.roomId !== nextHost.roomId)],
      }));
      await start(crypto, true);
      return true;
    } catch (error) {
      setState((current) => ({
        ...current,
        loading: false,
        error: error instanceof Error && /expired/iu.test(error.message)
          ? "二维码已超过十分钟，请在电脑端重新生成"
          : "配对链接无效，请在电脑端重新生成",
      }));
      return false;
    }
  }, [start]);

  const selectHost = useCallback(async (roomId: string, focusSessionId?: string) => {
    let crypto = cryptoByRoomRef.current.get(roomId);
    if (!crypto) {
      const hosts = await bridgeVault.listHosts();
      cryptoByRoomRef.current = new Map(hosts.map((host) => [host.roomId, host.crypto]));
      crypto = cryptoByRoomRef.current.get(roomId);
    }
    if (!crypto) throw new Error("Paired host not found");
    await bridgeVault.touchHost(crypto).catch(() => undefined);
    await start(crypto, false, focusSessionId);
  }, [start]);

  const backToHosts = useCallback(() => {
    if (connectionTimerRef.current) clearTimeout(connectionTimerRef.current);
    socketRef.current?.close();
    socketRef.current = undefined;
    cryptoRef.current = undefined;
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
      events: [],
      localTurns: [],
      latestSeq: 0,
      connectionIssue: undefined,
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
    }));
    try {
      const response = await sendRequest("session.open", { sessionId }, { wait: true });
      if (!response?.ok) throw new Error(response?.error?.message ?? "会话打开失败");
      const result = response.result as { history?: BridgeHistoryPage; session?: BridgeSessionInfo };
      if (!result.history) throw new Error("电脑未返回会话历史");
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
          },
        },
        error: error instanceof Error ? error.message : "会话打开失败",
      }));
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
    await sendRequest("turn.interrupt", {
      sessionId,
      ...(commandId ? { commandId } : {}),
    }, { allowOffline: false });
  }, [sendRequest]);

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

  const createSession = useCallback(async (cwd: string, title?: string): Promise<BridgeSessionInfo | undefined> => {
    const response = await sendRequest("session.create", {
      cwd,
      ...(title ? { title } : {}),
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
    change: { model?: string | null; effort?: BridgeEffort | null },
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

  const refresh = useCallback(async () => {
    await resumeEvents();
    await controlClaudeDesktop("status").catch(() => undefined);
    const response = await sendRequest("session.list", {}, { wait: true }).catch(() => undefined);
    if (!response?.ok) return;
    const result = response.result as { sessions?: BridgeSessionInfo[] };
    if (!result.sessions) return;
    setState((current) => current.snapshot ? {
      ...current,
      snapshot: { ...current.snapshot, sessions: result.sessions! },
    } : current);
  }, [controlClaudeDesktop, resumeEvents, sendRequest]);

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
        events: [],
        localTurns: [],
        latestSeq: 0,
        connectionIssue: undefined,
      } : {}),
    }));
  }, [sendRequest]);

  const retryConnection = useCallback(async () => {
    const crypto = cryptoRef.current;
    if (crypto) await start(crypto);
  }, [start]);

  return {
    state,
    pair,
    selectHost,
    backToHosts,
    openSession,
    loadOlderHistory,
    sendTurn,
    interruptTurn,
    resolveUncertainDelivery,
    resolvePermission,
    createSession,
    loadSessionConfiguration,
    configureSession,
    launchClaudeDesktop,
    quitClaudeDesktop,
    refresh,
    forgetHost,
    retryConnection,
  };
}
