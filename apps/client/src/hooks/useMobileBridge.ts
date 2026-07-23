import {
  BridgeCrypto,
  BridgeSocket,
  type BridgePayload,
  type ClaudeHistoryMessage,
  type ClaudeSessionInfo,
  type DecryptedEnvelope,
  type EncryptedEnvelope,
  type PairingBundle,
  type SocketState,
  type StatusPayload,
} from "@bridge/protocol";
import { Capacitor } from "@capacitor/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { bridgeVault, type StoredBridgeHost } from "../lib/vault.js";

export interface TimelineEntry extends DecryptedEnvelope {
  direction: "incoming" | "outgoing";
}

export interface PairedHost {
  roomId: string;
  desktopName: string;
  relayUrl: string;
  needsRepair: boolean;
}

export interface MobileConnectionIssue {
  code: "unreachable" | "pairing-invalid";
  message: string;
}

export interface SessionHistoryState {
  status: "loading" | "ready" | "error";
  messages: ClaudeHistoryMessage[];
  available: boolean;
  truncated: boolean;
  syncedAt?: number;
}

interface MobileBridgeState {
  loading: boolean;
  hosts: PairedHost[];
  activeHostId: string | undefined;
  desktopName: string | undefined;
  connection: SocketState;
  desktopOnline: boolean;
  agentOnline: boolean;
  sessions: ClaudeSessionInfo[];
  sessionCatalogReceived: boolean;
  histories: Record<string, SessionHistoryState>;
  timeline: TimelineEntry[];
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
  agentOnline: false,
  sessions: [],
  sessionCatalogReceived: false,
  histories: {},
  timeline: [],
  connectionIssue: undefined,
  error: undefined,
};

function hostSummary(host: StoredBridgeHost): PairedHost {
  return {
    roomId: host.roomId,
    desktopName: host.desktopName,
    relayUrl: host.relayUrl,
    needsRepair: Capacitor.isNativePlatform() && isLoopbackRelay(host.relayUrl),
  };
}

function directionFor(envelope: DecryptedEnvelope): TimelineEntry["direction"] {
  return envelope.header.from === "mobile" ? "outgoing" : "incoming";
}

function isSessionSnapshot(payload: StatusPayload): boolean {
  return /^(已读取 Claude Desktop 历史|Claude Desktop 会话已打开|任务清单已完成|当前：)/u.test(payload.message);
}

function statusSessionKey(payload: StatusPayload): string {
  return payload.sessionId ?? payload.step ?? "Claude";
}

function isCommandDeliveryStatus(payload: StatusPayload): boolean {
  return /^(?:指令已收到，正在打开|指令已收到，正在查找|已打开「.+」，指令正在发送|正在重新打开「.+」|暂时无法操作「.+」的输入框|指令已收到，已进入|指令已收到，正在匹配|Claude 已在后台开始处理|Bridge 已创建独立后台续写|Claude 后台凭据暂不可用|Claude 后台执行受到权限限制|Claude 后台处理超时|Claude 后台执行暂时失败)/u
    .test(payload.message.trim());
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
  if (code === "AUTH_FAILED" || code === "ROOM_NOT_FOUND") {
    return {
      code: "pairing-invalid",
      message: "这条配对已失效，请删除后在电脑端重新扫码。",
    };
  }
  return { code: "unreachable", message: fallback };
}

export function compactTimeline(entries: TimelineEntry[]): TimelineEntry[] {
  return [...entries]
    .sort((a, b) => a.header.sentAt - b.header.sentAt)
    .reduce<TimelineEntry[]>((timeline, entry) => {
      if (
        entry.payload.kind === "sessions" ||
        entry.payload.kind === "history" ||
        entry.payload.kind === "history-request"
      ) return timeline;
      if (
        entry.payload.kind === "status" &&
        /^Claude 会话已结束[。.!！]?$/u.test(entry.payload.message.trim())
      ) return timeline;
      const withoutDuplicate = timeline.filter((item) => item.header.id !== entry.header.id);
      if (entry.payload.kind === "status" && isCommandDeliveryStatus(entry.payload)) {
        const entrySessionKey = statusSessionKey(entry.payload);
        const entryMessage = entry.payload.message;
        return [
          ...withoutDuplicate.filter((item) => !(
            item.payload.kind === "status" &&
            isCommandDeliveryStatus(item.payload) &&
            item.payload.message === entryMessage &&
            statusSessionKey(item.payload) === entrySessionKey
          )),
          entry,
        ];
      }
      if (entry.payload.kind !== "status" || !isSessionSnapshot(entry.payload)) {
        return [...withoutDuplicate, entry];
      }
      const entrySessionKey = statusSessionKey(entry.payload);
      return [
        ...withoutDuplicate.filter((item) => !(
          item.payload.kind === "status" &&
          isSessionSnapshot(item.payload) &&
          statusSessionKey(item.payload) === entrySessionKey
        )),
        entry,
      ];
    }, [])
    .slice(-250);
}

async function decryptStoredMessages(crypto: BridgeCrypto, envelopes: EncryptedEnvelope[]): Promise<{
  timeline: TimelineEntry[];
  sessions: ClaudeSessionInfo[];
  sessionCatalogReceived: boolean;
  histories: Record<string, SessionHistoryState>;
}> {
  const results = await Promise.allSettled(envelopes.map((envelope) => crypto.decrypt(envelope)));
  const messages = results
    .filter((result): result is PromiseFulfilledResult<DecryptedEnvelope> => result.status === "fulfilled")
    .map((result) => result.value);
  const sessions = [...messages]
    .reverse()
    .find((message) => message.payload.kind === "sessions")?.payload;
  const histories: Record<string, SessionHistoryState> = {};
  for (const message of messages) {
    if (message.payload.kind !== "history") continue;
    histories[message.payload.sessionId] = {
      status: "ready",
      messages: message.payload.messages,
      available: message.payload.available,
      truncated: message.payload.truncated,
      syncedAt: message.payload.syncedAt,
    };
  }
  return {
    timeline: compactTimeline(messages.map((message) => ({ ...message, direction: directionFor(message) }))),
    sessions: sessions?.kind === "sessions" ? sessions.sessions : [],
    sessionCatalogReceived: messages.some((message) => message.payload.kind === "sessions"),
    histories,
  };
}

export function useMobileBridge() {
  const [state, setState] = useState<MobileBridgeState>(INITIAL_STATE);
  const cryptoRef = useRef<BridgeCrypto | undefined>(undefined);
  const cryptoByRoomRef = useRef(new Map<string, BridgeCrypto>());
  const socketRef = useRef<BridgeSocket | undefined>(undefined);
  const connectionTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const addTimeline = useCallback((entry: TimelineEntry) => {
    setState((current) => ({
      ...current,
      timeline: compactTimeline([...current.timeline, entry]),
    }));
  }, []);

  const start = useCallback(async (crypto: BridgeCrypto) => {
    if (connectionTimerRef.current) clearTimeout(connectionTimerRef.current);
    const previousSocket = socketRef.current;
    socketRef.current = undefined;
    previousSocket?.close();
    cryptoRef.current = crypto;
    const roomId = crypto.identity.roomId;
    setState((current) => ({
      ...current,
      loading: false,
      activeHostId: roomId,
      desktopName: crypto.identity.desktopName,
      connection: "connecting",
      desktopOnline: false,
      agentOnline: false,
      sessions: [],
      sessionCatalogReceived: false,
      histories: {},
      timeline: [],
      connectionIssue: undefined,
      error: undefined,
    }));

    const history = await decryptStoredMessages(crypto, await bridgeVault.listMessages(roomId));
    if (cryptoRef.current !== crypto) return;
    setState((current) => ({
      ...current,
      sessions: history.sessions,
      sessionCatalogReceived: history.sessionCatalogReceived,
      histories: history.histories,
      timeline: history.timeline,
    }));

    if (Capacitor.isNativePlatform() && isLoopbackRelay(crypto.identity.relayUrl)) {
      setState((current) => ({
        ...current,
        connection: "closed",
        connectionIssue: {
          code: "pairing-invalid",
          message: "这条配对来自旧版电脑端，请删除后用新版 Bridge 二维码重新配对。",
        },
      }));
      return;
    }

    const socket = new BridgeSocket({ crypto, role: "mobile" });
    socketRef.current = socket;
    const isCurrentSocket = () => socketRef.current === socket;
    socket.onState((connection) => {
      if (!isCurrentSocket()) return;
      setState((current) => ({ ...current, connection }));
      if (connection === "connected") {
        if (connectionTimerRef.current) clearTimeout(connectionTimerRef.current);
        setState((current) => ({ ...current, connectionIssue: undefined }));
        void (async () => {
          for (const envelope of await bridgeVault.listOutbox(roomId)) {
            try {
              socket.sendEnvelope(envelope);
              await bridgeVault.removeOutbox(envelope.id);
            } catch {
              break;
            }
          }
        })();
      }
    });
    socket.onFrame((frame) => {
      if (!isCurrentSocket()) return;
      if (frame.type === "ready") {
        setState((current) => ({
          ...current,
          desktopOnline: frame.online.includes("desktop"),
          agentOnline: frame.online.includes("agent"),
        }));
      }
      if (frame.type === "presence") {
        setState((current) => ({
          ...current,
          ...(frame.role === "desktop" ? { desktopOnline: frame.online } : {}),
          ...(frame.role === "agent" ? { agentOnline: frame.online } : {}),
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
      if (!isCurrentSocket()) return;
      void (async () => {
        await bridgeVault.saveMessage(encrypted);
        socket.ack([encrypted.id]);
        if (message.payload.kind === "sessions") {
          const sessions = message.payload.sessions;
          setState((current) => ({ ...current, sessions, sessionCatalogReceived: true }));
        } else if (message.payload.kind === "history") {
          const history = message.payload;
          setState((current) => ({
            ...current,
            histories: {
              ...current.histories,
              [history.sessionId]: {
                status: "ready",
                messages: history.messages,
                available: history.available,
                truncated: history.truncated,
                syncedAt: history.syncedAt,
              },
            },
          }));
        } else {
          addTimeline({ ...message, direction: directionFor(message) });
        }
        if (document.visibilityState !== "visible" && Notification.permission === "granted") {
          const payload = message.payload;
          if (payload.kind !== "sessions" && payload.kind !== "history" && payload.kind !== "history-request") {
            const body = payload.kind === "status"
              ? payload.message
              : payload.kind === "completion"
                ? payload.summary
                : "电脑有新动态";
            new Notification(crypto.identity.desktopName, { body, icon: "/icon-192.png", tag: encrypted.id });
          }
        }
      })().catch(() => setState((current) => ({ ...current, error: "新消息暂时无法保存" })));
    });
    socket.connect();
    connectionTimerRef.current = setTimeout(() => {
      if (!isCurrentSocket() || socket.state === "connected") return;
      setState((current) => ({
        ...current,
        connectionIssue: {
          code: "unreachable",
          message: "无法连接这台电脑，请确认手机与电脑在同一网络，然后重试。",
        },
      }));
    }, 8_000);
  }, [addTimeline]);

  useEffect(() => {
    let active = true;
    void bridgeVault.listHosts().then((hosts) => {
      if (!active) return;
      cryptoByRoomRef.current = new Map(hosts.map((host) => [host.roomId, host.crypto]));
      setState((current) => ({
        ...current,
        loading: false,
        hosts: hosts.map(hostSummary),
      }));
    }).catch(() => setState((current) => ({
      ...current,
      loading: false,
      error: "无法读取本机配对信息",
    })));
    return () => {
      active = false;
      if (connectionTimerRef.current) clearTimeout(connectionTimerRef.current);
      socketRef.current?.close();
    };
  }, []);

  const pair = useCallback(async (pairing: PairingBundle): Promise<boolean> => {
    setState((current) => ({ ...current, loading: true, error: undefined }));
    if (Capacitor.isNativePlatform() && isLoopbackRelay(pairing.relayUrl)) {
      setState((current) => ({
        ...current,
        loading: false,
        error: "电脑端二维码来自旧版本，请先更新电脑端 Bridge 再重新扫码。",
      }));
      return false;
    }
    try {
      const crypto = await bridgeVault.importPairing(pairing);
      cryptoByRoomRef.current.set(crypto.identity.roomId, crypto);
      const nextHost: PairedHost = {
        roomId: crypto.identity.roomId,
        desktopName: crypto.identity.desktopName,
        relayUrl: crypto.identity.relayUrl,
        needsRepair: Capacitor.isNativePlatform() && isLoopbackRelay(crypto.identity.relayUrl),
      };
      setState((current) => ({
        ...current,
        loading: false,
        hosts: [nextHost, ...current.hosts.filter((host) => host.roomId !== nextHost.roomId)],
      }));
      await start(crypto);
      return true;
    } catch {
      setState((current) => ({
        ...current,
        loading: false,
        error: "配对链接无效，请在电脑上重新生成",
      }));
      return false;
    }
  }, [start]);

  const selectHost = useCallback(async (roomId: string) => {
    let crypto = cryptoByRoomRef.current.get(roomId);
    if (!crypto) {
      const hosts = await bridgeVault.listHosts();
      cryptoByRoomRef.current = new Map(hosts.map((host) => [host.roomId, host.crypto]));
      crypto = cryptoByRoomRef.current.get(roomId);
    }
    if (!crypto) throw new Error("Paired host not found");
    await bridgeVault.touchHost(crypto).catch(() => undefined);
    setState((current) => ({
      ...current,
      hosts: [
        ...current.hosts.filter((host) => host.roomId === roomId),
        ...current.hosts.filter((host) => host.roomId !== roomId),
      ],
    }));
    await start(crypto);
  }, [start]);

  const backToHosts = useCallback(() => {
    if (connectionTimerRef.current) clearTimeout(connectionTimerRef.current);
    const socket = socketRef.current;
    socketRef.current = undefined;
    socket?.close();
    cryptoRef.current = undefined;
    setState((current) => ({
      ...current,
      activeHostId: undefined,
      desktopName: undefined,
      connection: "idle",
      desktopOnline: false,
      agentOnline: false,
      sessions: [],
      sessionCatalogReceived: false,
      histories: {},
      timeline: [],
      connectionIssue: undefined,
      error: undefined,
    }));
  }, []);

  const sendCommand = useCallback(async (text: string, sessionId: string) => {
    const crypto = cryptoRef.current;
    if (!crypto) throw new Error("No host selected");
    const payload: BridgePayload = { kind: "command", text, sessionId };
    const envelope = await crypto.encrypt(payload, "mobile", "desktop");
    await Promise.all([bridgeVault.saveMessage(envelope), bridgeVault.addOutbox(envelope)]);
    const decrypted = await crypto.decrypt(envelope);
    addTimeline({ ...decrypted, direction: "outgoing" });
    if (socketRef.current?.state === "connected") {
      socketRef.current.sendEnvelope(envelope);
      await bridgeVault.removeOutbox(envelope.id);
    }
  }, [addTimeline]);

  const requestHistory = useCallback(async (sessionId: string) => {
    setState((current) => ({
      ...current,
      histories: {
        ...current.histories,
        [sessionId]: {
          status: "loading",
          messages: current.histories[sessionId]?.messages ?? [],
          available: current.histories[sessionId]?.available ?? true,
          truncated: current.histories[sessionId]?.truncated ?? false,
          ...(current.histories[sessionId]?.syncedAt !== undefined
            ? { syncedAt: current.histories[sessionId].syncedAt }
            : {}),
        },
      },
    }));
    const socket = socketRef.current;
    if (!socket || socket.state !== "connected") {
      setState((current) => ({
        ...current,
        histories: {
          ...current.histories,
          [sessionId]: {
            ...(current.histories[sessionId] ?? { messages: [], available: true, truncated: false }),
            status: "error",
          },
        },
      }));
      return;
    }
    try {
      await socket.send({ kind: "history-request", sessionId }, "desktop");
    } catch {
      setState((current) => ({
        ...current,
        histories: {
          ...current.histories,
          [sessionId]: {
            ...(current.histories[sessionId] ?? { messages: [], available: true, truncated: false }),
            status: "error",
          },
        },
      }));
    }
  }, []);

  const forgetHost = useCallback(async (roomId: string) => {
    const active = cryptoRef.current?.identity.roomId === roomId;
    if (active) {
      if (connectionTimerRef.current) clearTimeout(connectionTimerRef.current);
      const socket = socketRef.current;
      socketRef.current = undefined;
      socket?.close();
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
        agentOnline: false,
        sessions: [],
        sessionCatalogReceived: false,
        histories: {},
        timeline: [],
        connectionIssue: undefined,
        error: undefined,
      } : {}),
    }));
  }, []);

  const unpair = useCallback(async () => {
    const roomId = cryptoRef.current?.identity.roomId;
    if (roomId) await forgetHost(roomId);
  }, [forgetHost]);

  const retryConnection = useCallback(async () => {
    const crypto = cryptoRef.current;
    if (crypto) await start(crypto);
  }, [start]);

  return { state, pair, selectHost, backToHosts, sendCommand, requestHistory, forgetHost, unpair, retryConnection };
}
