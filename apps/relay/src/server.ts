import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { parseClientFrame, type BridgeRole, type ClientHello, type EncryptedEnvelope } from "@bridge/protocol";
import { WebSocket, WebSocketServer } from "ws";
import { MemoryRelayStore, type RelayStore } from "./store.js";

const MAX_FRAME_BYTES = 128 * 1024;
const MAX_ENVELOPE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CLOCK_TOLERANCE_MS = 24 * 60 * 60 * 1000;

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
  await store.load();

  const httpServer = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ ok: true, service: "claude-bridge-relay", version: 1 }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not_found" }));
  });

  const wsServer = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  const states = new Map<WebSocket, ClientState>();

  function roomClients(roomId: string, role?: BridgeRole): Array<[WebSocket, AuthenticatedClient]> {
    const result: Array<[WebSocket, AuthenticatedClient]> = [];
    for (const [socket, state] of states) {
      const client = state.authenticated;
      if (client?.roomId === roomId && (!role || client.role === role) && socket.readyState === WebSocket.OPEN) {
        result.push([socket, client]);
      }
    }
    return result;
  }

  function broadcastPresence(roomId: string, role: BridgeRole, online: boolean): void {
    for (const [socket] of roomClients(roomId)) safeSend(socket, { type: "presence", role, online });
  }

  function listQueuedForRole(roomId: string, role: BridgeRole, now: number): EncryptedEnvelope[] {
    const direct = store.listQueued(roomId, role, now).filter((envelope) => (
      role !== "agent" || envelope.from !== "mobile"
    ));
    const legacyMobileCommands = role === "desktop"
      ? store.listQueued(roomId, "agent", now).filter((envelope) => envelope.from === "mobile")
      : [];
    return [...new Map([...direct, ...legacyMobileCommands].map((envelope) => [envelope.id, envelope])).values()]
      .sort((left, right) => left.sentAt - right.sentAt);
  }

  function deliveryRole(envelope: EncryptedEnvelope): BridgeRole {
    if (envelope.from === "mobile" && envelope.to === "agent") return "desktop";
    return envelope.to;
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
      await store.createRoom({ id: hello.roomId, authHash: suppliedHash, createdAt: now, lastSeenAt: now });
      room = store.getRoom(hello.roomId);
    }
    if (!room || !hashesMatch(room.authHash, suppliedHash)) {
      sendError(ws, "AUTH_FAILED", "Pairing credentials were rejected", 1008);
      return;
    }
    const client: AuthenticatedClient = {
      connectionId: crypto.randomUUID(),
      roomId: hello.roomId,
      role: hello.role,
      deviceId: hello.deviceId,
    };
    state.authenticated = client;
    await store.touchRoom(room.id, Date.now());
    await store.prune(Date.now());
    const queued = listQueuedForRole(room.id, hello.role, Date.now());
    const online = [...new Set(roomClients(room.id).map(([, connected]) => connected.role))];
    safeSend(ws, { type: "ready", connectionId: client.connectionId, queued: queued.length, online });
    for (const envelope of queued) safeSend(ws, { type: "envelope", envelope });
    broadcastPresence(room.id, hello.role, true);
  }

  function validateEnvelope(client: AuthenticatedClient, envelope: EncryptedEnvelope): boolean {
    const now = Date.now();
    return (
      envelope.roomId === client.roomId &&
      envelope.from === client.role &&
      envelope.fromDeviceId === client.deviceId &&
      envelope.expiresAt > envelope.sentAt &&
      envelope.expiresAt - envelope.sentAt <= MAX_ENVELOPE_TTL_MS &&
      Math.abs(envelope.sentAt - now) <= CLOCK_TOLERANCE_MS
    );
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
        if (state.rateCount > 120) {
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
        if (frame.type === "ack") {
          await store.ack(client.roomId, client.role, frame.ids.slice(0, 100));
          if (client.role === "desktop") {
            await store.ack(client.roomId, "agent", frame.ids.slice(0, 100));
          }
          return;
        }
        if (!validateEnvelope(client, frame.envelope)) {
          sendError(ws, "INVALID_ENVELOPE", "Envelope metadata does not match this connection");
          return;
        }
        await store.enqueue(frame.envelope);
        for (const [target] of roomClients(client.roomId, deliveryRole(frame.envelope))) {
          safeSend(target, { type: "envelope", envelope: frame.envelope });
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
      if (client && roomClients(client.roomId, client.role).length === 0) {
        broadcastPresence(client.roomId, client.role, false);
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
