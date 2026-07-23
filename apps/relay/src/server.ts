import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { parseClientFrame, type BridgeRole, type ClientHello, type EncryptedEnvelope } from "@bridge/protocol";
import { WebSocket, WebSocketServer } from "ws";
import { EnvironmentPushDispatcher, type PushDispatcher } from "./push.js";
import { MemoryRelayStore, type RelayStore } from "./store.js";

const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_ENVELOPE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CLOCK_TOLERANCE_MS = 24 * 60 * 60 * 1000;
const MAX_PAIRING_WINDOW_MS = 10 * 60 * 1000;

interface AuthenticatedClient {
  connectionId: string;
  roomId: string;
  role: BridgeRole;
  deviceId: string;
}

interface ClientState {
  authenticated?: AuthenticatedClient;
  isAlive: boolean;
  rateWindowStartedAt: number;
  rateCount: number;
}

export interface RelayServerOptions {
  host?: string;
  port?: number;
  store?: RelayStore;
  allowedOrigins?: string[];
  logger?: Pick<Console, "info" | "warn" | "error">;
  pushDispatcher?: PushDispatcher;
}

export interface RunningRelay {
  httpServer: HttpServer;
  wsServer: WebSocketServer;
  url: string;
  close(): Promise<void>;
}

function authHash(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

function hashesMatch(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function safeSend(ws: WebSocket, frame: unknown): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
}

function sendError(ws: WebSocket, code: string, message: string, closeCode?: number): void {
  safeSend(ws, { type: "error", code, message });
  if (closeCode) ws.close(closeCode, code);
}

export async function startRelayServer(options: RelayServerOptions = {}): Promise<RunningRelay> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8788;
  const store = options.store ?? new MemoryRelayStore();
  const logger = options.logger ?? console;
  const allowedOrigins = new Set(options.allowedOrigins ?? []);
  const pushDispatcher = options.pushDispatcher ?? new EnvironmentPushDispatcher();
  await store.load();

  const httpServer = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ ok: true, service: "claude-bridge-relay", version: 2 }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not_found" }));
  });

  const wsServer = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  const states = new Map<WebSocket, ClientState>();

  function roomClients(
    roomId: string,
    role?: BridgeRole,
    deviceId?: string,
  ): Array<[WebSocket, AuthenticatedClient]> {
    const result: Array<[WebSocket, AuthenticatedClient]> = [];
    for (const [socket, state] of states) {
      const client = state.authenticated;
      if (
        client?.roomId === roomId &&
        (!role || client.role === role) &&
        (!deviceId || client.deviceId === deviceId) &&
        socket.readyState === WebSocket.OPEN
      ) {
        result.push([socket, client]);
      }
    }
    return result;
  }

  function broadcastPresence(roomId: string, role: BridgeRole, deviceId: string, online: boolean): void {
    for (const [socket] of roomClients(roomId)) {
      safeSend(socket, { type: "presence", role, deviceId, online });
    }
  }

  async function authenticate(ws: WebSocket, state: ClientState, hello: ClientHello): Promise<void> {
    if (state.authenticated) {
      sendError(ws, "ALREADY_AUTHENTICATED", "This connection is already authenticated", 1008);
      return;
    }
    if (
      hello.roomId.length < 16 || hello.roomId.length > 64 ||
      hello.deviceId.length < 1 || hello.deviceId.length > 64 ||
      hello.authToken.length < 32 || hello.authToken.length > 128
    ) {
      sendError(ws, "INVALID_HELLO", "The pairing credentials are invalid", 1008);
      return;
    }
    const suppliedHash = authHash(hello.authToken);
    let room = store.getRoom(hello.roomId);
    if (!room) {
      if (!hello.create || hello.role !== "desktop") {
        sendError(ws, "ROOM_NOT_FOUND", "Open Bridge on the paired computer first", 1008);
        return;
      }
      const now = Date.now();
      await store.createRoom({
        id: hello.roomId,
        hostDeviceId: hello.deviceId,
        authHash: suppliedHash,
        createdAt: now,
        lastSeenAt: now,
      });
      room = store.getRoom(hello.roomId);
    }
    if (!room) {
      sendError(ws, "ROOM_NOT_FOUND", "The host is unavailable", 1008);
      return;
    }

    const now = Date.now();
    if (hello.role === "desktop") {
      if (room.hostDeviceId !== hello.deviceId || !hashesMatch(room.authHash, suppliedHash)) {
        sendError(ws, "AUTH_FAILED", "Host credentials were rejected", 1008);
        return;
      }
    } else if (hello.role === "mobile") {
      const device = store.getDevice(room.id, hello.deviceId);
      if (!device || !hashesMatch(device.authHash, suppliedHash)) {
        sendError(ws, "AUTH_FAILED", "Pairing credentials were rejected", 1008);
        return;
      }
      if (device.revokedAt) {
        sendError(ws, "DEVICE_REVOKED", "This device was removed by the host", 1008);
        return;
      }
      if (!device.claimedAt && device.expiresAt <= now) {
        sendError(ws, "PAIRING_EXPIRED", "This pairing code has expired", 1008);
        return;
      }
      if (!hello.instanceId || !(await store.claimDevice(room.id, device.deviceId, hello.instanceId, now))) {
        sendError(ws, "PAIRING_ALREADY_USED", "This pairing code is already bound to another installation", 1008);
        return;
      }
    } else {
      sendError(ws, "ROLE_UNSUPPORTED", "Agent relay clients are not used by protocol v2", 1008);
      return;
    }

    const client: AuthenticatedClient = {
      connectionId: crypto.randomUUID(),
      roomId: hello.roomId,
      role: hello.role,
      deviceId: hello.deviceId,
    };
    state.authenticated = client;
    await store.touchRoom(room.id, now);
    if (hello.role === "mobile") await store.touchDevice(room.id, hello.deviceId, now);
    await store.prune(now);
    const queued = store.listQueued(room.id, hello.role, hello.deviceId, now);
    const onlineDevices = roomClients(room.id).map(([, connected]) => ({
      role: connected.role,
      deviceId: connected.deviceId,
    }));
    const online = [...new Set(onlineDevices.map((connected) => connected.role))];
    safeSend(ws, {
      type: "ready",
      connectionId: client.connectionId,
      queued: queued.length,
      online,
      onlineDevices,
    });
    for (const envelope of queued) safeSend(ws, { type: "envelope", envelope });
    broadcastPresence(room.id, hello.role, hello.deviceId, true);
  }

  function validateEnvelope(client: AuthenticatedClient, envelope: EncryptedEnvelope): boolean {
    const now = Date.now();
    if (
      envelope.roomId !== client.roomId ||
      envelope.from !== client.role ||
      envelope.fromDeviceId !== client.deviceId ||
      envelope.expiresAt <= envelope.sentAt ||
      envelope.expiresAt - envelope.sentAt > MAX_ENVELOPE_TTL_MS ||
      Math.abs(envelope.sentAt - now) > CLOCK_TOLERANCE_MS
    ) return false;
    if (envelope.to === "mobile") {
      if (!envelope.toDeviceId) return false;
      const device = store.getDevice(client.roomId, envelope.toDeviceId);
      return Boolean(device && !device.revokedAt);
    }
    if (envelope.to === "desktop" && envelope.toDeviceId) {
      return store.getRoom(client.roomId)?.hostDeviceId === envelope.toDeviceId;
    }
    return envelope.to === "desktop";
  }

  wsServer.on("connection", (ws) => {
    const state: ClientState = {
      isAlive: true,
      rateWindowStartedAt: Date.now(),
      rateCount: 0,
    };
    states.set(ws, state);
    const helloTimeout = setTimeout(() => {
      if (!state.authenticated) sendError(ws, "HELLO_TIMEOUT", "Authentication timed out", 1008);
    }, 10_000);

    ws.on("pong", () => { state.isAlive = true; });
    ws.on("message", (data, isBinary) => {
      void (async () => {
        const raw = data.toString();
        if (isBinary || Buffer.byteLength(raw) > MAX_FRAME_BYTES) {
          sendError(ws, "FRAME_TOO_LARGE", "The frame is too large", 1009);
          return;
        }
        const now = Date.now();
        if (now - state.rateWindowStartedAt >= 60_000) {
          state.rateWindowStartedAt = now;
          state.rateCount = 0;
        }
        state.rateCount += 1;
        if (state.rateCount > 600) {
          sendError(ws, "RATE_LIMITED", "Too many messages", 1008);
          return;
        }
        let frame;
        try {
          frame = parseClientFrame(raw);
        } catch {
          sendError(ws, "INVALID_FRAME", "The frame could not be read");
          return;
        }
        if (frame.type === "hello") {
          await authenticate(ws, state, frame);
          return;
        }
        const client = state.authenticated;
        if (!client) {
          sendError(ws, "AUTH_REQUIRED", "Authenticate before sending messages", 1008);
          return;
        }
        if (frame.type === "ping") {
          safeSend(ws, { type: "pong", at: frame.at });
          return;
        }
        if (frame.type === "device-register") {
          if (client.role !== "desktop") {
            sendError(ws, "FORBIDDEN", "Only the host can register a device");
            return;
          }
          if (
            frame.expiresAt <= now ||
            frame.expiresAt - now > MAX_PAIRING_WINDOW_MS + 30_000 ||
            frame.authToken.length < 32 ||
            frame.authToken.length > 128
          ) {
            sendError(ws, "INVALID_PAIRING", "Pairing registration is invalid");
            return;
          }
          await store.registerDevice({
            roomId: client.roomId,
            deviceId: frame.deviceId,
            role: "mobile",
            authHash: authHash(frame.authToken),
            createdAt: now,
            expiresAt: frame.expiresAt,
          });
          safeSend(ws, { type: "device-registered", deviceId: frame.deviceId, expiresAt: frame.expiresAt });
          return;
        }
        if (frame.type === "device-revoke") {
          if (client.role !== "desktop") {
            sendError(ws, "FORBIDDEN", "Only the host can revoke a device");
            return;
          }
          await store.revokeDevice(client.roomId, frame.deviceId, now);
          for (const [target] of roomClients(client.roomId, "mobile", frame.deviceId)) {
            sendError(target, "DEVICE_REVOKED", "This device was removed by the host", 1008);
          }
          safeSend(ws, { type: "device-revoked", deviceId: frame.deviceId });
          return;
        }
        if (frame.type === "push-register") {
          if (client.role !== "mobile") {
            sendError(ws, "FORBIDDEN", "Only mobile devices can register a push token");
            return;
          }
          const registered = await store.registerPush(
            client.roomId,
            client.deviceId,
            frame.platform,
            frame.pushToken,
            now,
          );
          if (!registered) sendError(ws, "PUSH_REGISTRATION_FAILED", "Push token registration was rejected");
          return;
        }
        if (frame.type === "ack") {
          const acknowledged = await store.ack(client.roomId, client.role, client.deviceId, frame.ids);
          const bySender = new Map<string, string[]>();
          for (const envelope of acknowledged) {
            const ids = bySender.get(envelope.fromDeviceId) ?? [];
            ids.push(envelope.id);
            bySender.set(envelope.fromDeviceId, ids);
          }
          for (const [senderDeviceId, ids] of bySender) {
            for (const [sender] of roomClients(client.roomId, undefined, senderDeviceId)) {
              safeSend(sender, { type: "acknowledged", ids, byDeviceId: client.deviceId });
            }
          }
          return;
        }
        if (!validateEnvelope(client, frame.envelope)) {
          sendError(ws, "INVALID_ENVELOPE", "Envelope metadata does not match this connection");
          return;
        }
        await store.enqueue(frame.envelope);
        safeSend(ws, { type: "stored", ids: [frame.envelope.id] });
        const recipients = roomClients(
          client.roomId,
          frame.envelope.to,
          frame.envelope.toDeviceId,
        );
        for (const [target] of recipients) safeSend(target, { type: "envelope", envelope: frame.envelope });
        if (
          recipients.length === 0 &&
          frame.envelope.to === "mobile" &&
          frame.envelope.toDeviceId
        ) {
          const device = store.getDevice(client.roomId, frame.envelope.toDeviceId);
          if (device) void pushDispatcher.wake(device);
        }
      })().catch((error: unknown) => {
        logger.error("relay message handler failed", error);
        sendError(ws, "SERVER_ERROR", "The relay could not process this message");
      });
    });

    ws.on("close", () => {
      clearTimeout(helloTimeout);
      const client = state.authenticated;
      states.delete(ws);
      if (client && roomClients(client.roomId, client.role, client.deviceId).length === 0) {
        broadcastPresence(client.roomId, client.role, client.deviceId, false);
      }
    });
    ws.on("error", (error) => logger.warn("relay websocket error", error));
  });

  httpServer.on("upgrade", (request, socket, head) => {
    const hostHeader = request.headers.host ?? "localhost";
    const url = new URL(request.url ?? "/", `http://${hostHeader}`);
    const origin = request.headers.origin;
    if (url.pathname !== "/ws" || (allowedOrigins.size > 0 && origin && !allowedOrigins.has(origin))) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wsServer.handleUpgrade(request, socket, head, (ws) => wsServer.emit("connection", ws, request));
  });

  const heartbeat = setInterval(() => {
    for (const [ws, state] of states) {
      if (!state.isAlive) {
        ws.terminate();
        continue;
      }
      state.isAlive = false;
      ws.ping();
    }
  }, 30_000);

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });
  const address = httpServer.address() as AddressInfo;
  const displayHost = address.address === "::" ? "127.0.0.1" : address.address;
  const url = `ws://${displayHost}:${address.port}/ws`;

  return {
    httpServer,
    wsServer,
    url,
    async close() {
      clearInterval(heartbeat);
      for (const ws of states.keys()) ws.close(1001, "relay shutting down");
      await new Promise<void>((resolve) => wsServer.close(() => resolve()));
      await new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
      await store.close();
    },
  };
}
