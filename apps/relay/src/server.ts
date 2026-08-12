import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type Server as HttpServer } from "node:http";
import { isIP, type AddressInfo } from "node:net";
import {
  isEnvelopeFromConnection,
  PROTOCOL_VERSION,
  parseClientFrame,
  type BridgeRole,
  type ClientHello,
  type EnvelopeChunkManifest,
  type RelayEnvelopeItem,
} from "@bridge/protocol";
import { WebSocket, WebSocketServer } from "ws";
import { EnvironmentPushDispatcher, type PushDispatcher } from "./push.js";
import { MemoryRelayStore, relayItemId, type RelayStore } from "./store.js";

const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_PAIRING_WINDOW_MS = 10 * 60 * 1000;
const MAX_MIGRATION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const ROOM_RATE_WINDOW_MS = 60 * 60 * 1000;
/** Per-connection frame budget per minute; the desktop fans out every event to
 *  every paired device, so the historical 600/min cap killed tunnels mid-stream. */
const DEFAULT_MAX_FRAMES_PER_MINUTE = 6000;

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
  remoteAddress: string;
  processing: Promise<void>;
}

export interface RelayMetrics {
  startedAt: number;
  activeConnections: number;
  framesReceived: number;
  envelopesStored: number;
  errors: number;
  pushAttempts: number;
  pushSucceeded: number;
}

export interface RelayServerOptions {
  host?: string;
  port?: number;
  store?: RelayStore;
  allowedOrigins?: string[];
  logger?: Pick<Console, "info" | "warn" | "error">;
  pushDispatcher?: PushDispatcher;
  maxRooms?: number;
  roomCreationsPerIpPerHour?: number;
  maxFramesPerMinute?: number;
  trustProxy?: boolean;
}

export interface RunningRelay {
  httpServer: HttpServer;
  wsServer: WebSocketServer;
  url: string;
  metrics(): RelayMetrics;
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

function isBrowserOrigin(origin: string): boolean {
  return origin.startsWith("http://") || origin.startsWith("https://");
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1" ||
    (isIP(hostname) === 4 && hostname.startsWith("127."))
  );
}

function originAllowed(origin: string, allowedOrigins: Set<string>): boolean {
  if (!origin) return true;
  if (!isBrowserOrigin(origin)) return true;
  const url = new URL(origin);
  // Native WebViews (Capacitor/Electron) commonly report http://localhost or
  // https://localhost as their page origin; loopback origins cannot be forged
  // by a remote attacker, so they are always allowed.
  if (isLoopbackHost(url.hostname)) return true;
  return allowedOrigins.has(origin);
}

function safeSend(ws: WebSocket, frame: unknown): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
}

function sendError(
  ws: WebSocket,
  code: string,
  message: string,
  closeCode?: number,
  envelopeId?: string,
): void {
  safeSend(ws, { type: "error", code, message, ...(envelopeId ? { envelopeId } : {}) });
  if (closeCode) ws.close(closeCode, code);
}

export async function startRelayServer(options: RelayServerOptions = {}): Promise<RunningRelay> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8788;
  const store = options.store ?? new MemoryRelayStore();
  const logger = options.logger ?? console;
  const allowedOrigins = new Set(options.allowedOrigins ?? []);
  const maxFramesPerMinute = options.maxFramesPerMinute ?? DEFAULT_MAX_FRAMES_PER_MINUTE;
  const pushDispatcher = options.pushDispatcher ?? new EnvironmentPushDispatcher();
  const maxRooms = options.maxRooms ?? 100_000;
  const roomCreationsPerIpPerHour = options.roomCreationsPerIpPerHour ?? 20;
  const roomCreationWindows = new Map<string, { startedAt: number; count: number }>();
  const relayMetrics: RelayMetrics = {
    startedAt: Date.now(),
    activeConnections: 0,
    framesReceived: 0,
    envelopesStored: 0,
    errors: 0,
    pushAttempts: 0,
    pushSucceeded: 0,
  };
  await store.load();

  const httpServer = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({
        ok: true,
        service: "claude-bridge-relay",
        version: PROTOCOL_VERSION,
      }));
      return;
    }
    if (request.method === "GET" && request.url === "/ready") {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ ok: true, storage: store.stats() }));
      return;
    }
    if (request.method === "GET" && request.url === "/metrics") {
      const stored = store.stats();
      const values = [
        "# TYPE bridge_relay_connections gauge",
        `bridge_relay_connections ${relayMetrics.activeConnections}`,
        "# TYPE bridge_relay_rooms gauge",
        `bridge_relay_rooms ${stored.rooms}`,
        "# TYPE bridge_relay_devices gauge",
        `bridge_relay_devices ${stored.devices}`,
        "# TYPE bridge_relay_queue_frames gauge",
        `bridge_relay_queue_frames ${stored.queuedFrames}`,
        "# TYPE bridge_relay_queue_bytes gauge",
        `bridge_relay_queue_bytes ${stored.queuedBytes}`,
        "# TYPE bridge_relay_frames_received counter",
        `bridge_relay_frames_received ${relayMetrics.framesReceived}`,
        "# TYPE bridge_relay_envelopes_stored counter",
        `bridge_relay_envelopes_stored ${relayMetrics.envelopesStored}`,
        "# TYPE bridge_relay_errors counter",
        `bridge_relay_errors ${relayMetrics.errors}`,
        "# TYPE bridge_relay_push_attempts counter",
        `bridge_relay_push_attempts ${relayMetrics.pushAttempts}`,
        "# TYPE bridge_relay_push_succeeded counter",
        `bridge_relay_push_succeeded ${relayMetrics.pushSucceeded}`,
        "",
      ];
      response.writeHead(200, { "content-type": "text/plain; version=0.0.4", "cache-control": "no-store" });
      response.end(values.join("\n"));
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
      const previousWindow = roomCreationWindows.get(state.remoteAddress);
      const rateWindow = !previousWindow || now - previousWindow.startedAt >= ROOM_RATE_WINDOW_MS
        ? { startedAt: now, count: 0 }
        : previousWindow;
      if (rateWindow.count >= roomCreationsPerIpPerHour) {
        relayMetrics.errors += 1;
        sendError(ws, "ROOM_RATE_LIMITED", "Too many rooms were created from this address", 1008);
        return;
      }
      if (store.stats().rooms >= maxRooms) {
        relayMetrics.errors += 1;
        sendError(ws, "CAPACITY_REACHED", "The relay is at capacity", 1013);
        return;
      }
      rateWindow.count += 1;
      roomCreationWindows.set(state.remoteAddress, rateWindow);
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
      sendError(ws, "ROLE_UNSUPPORTED", "Agent relay clients are not used by protocol v3", 1008);
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
    for (const item of queued) {
      safeSend(ws, "transferId" in item
        ? { type: "envelope-chunk", chunk: item }
        : { type: "envelope", envelope: item });
    }
    broadcastPresence(room.id, hello.role, hello.deviceId, true);
  }

  function validateEnvelope(
    client: AuthenticatedClient,
    envelope: RelayEnvelopeItem | EnvelopeChunkManifest,
  ): boolean {
    const now = Date.now();
    if (!isEnvelopeFromConnection(envelope, client, now)) return false;
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

  wsServer.on("connection", (ws, request) => {
    const forwarded = options.trustProxy ? request.headers["x-forwarded-for"] : undefined;
    const forwardedAddress = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(",")[0]?.trim();
    const state: ClientState = {
      isAlive: true,
      rateWindowStartedAt: Date.now(),
      rateCount: 0,
      remoteAddress: forwardedAddress || request.socket.remoteAddress || "unknown",
      processing: Promise.resolve(),
    };
    states.set(ws, state);
    relayMetrics.activeConnections += 1;
    const helloTimeout = setTimeout(() => {
      if (!state.authenticated) sendError(ws, "HELLO_TIMEOUT", "Authentication timed out", 1008);
    }, 10_000);

    ws.on("pong", () => { state.isAlive = true; });
    ws.on("message", (data, isBinary) => {
      state.processing = state.processing.then(async () => {
        relayMetrics.framesReceived += 1;
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
        if (state.rateCount > maxFramesPerMinute) {
          sendError(ws, "RATE_LIMITED", "Too many messages", 1008);
          return;
        }
        let frame;
        try {
          frame = parseClientFrame(raw);
        } catch {
          try {
            const candidate = JSON.parse(raw) as { type?: unknown; version?: unknown };
            if (
              candidate.type === "hello" &&
              typeof candidate.version === "number" &&
              candidate.version !== PROTOCOL_VERSION
            ) {
              sendError(
                ws,
                "UPGRADE_REQUIRED",
                `Protocol ${PROTOCOL_VERSION} requires re-pairing`,
                1008,
              );
              return;
            }
          } catch {
            // The generic invalid-frame response below covers malformed JSON.
          }
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
          const registrationWindow = frame.migrate
            ? MAX_MIGRATION_WINDOW_MS
            : MAX_PAIRING_WINDOW_MS + 30_000;
          if (
            frame.expiresAt <= now ||
            frame.expiresAt - now > registrationWindow ||
            frame.authToken.length < 32 ||
            frame.authToken.length > 128 ||
            (frame.migrate && (
              typeof frame.pairedAt !== "number" ||
              frame.pairedAt <= 0 ||
              frame.pairedAt > now
            ))
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
            ...(frame.migrate && frame.pairedAt ? {
              claimedAt: frame.pairedAt,
            } : {}),
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
        if (frame.type === "chunk-query") {
          if (!validateEnvelope(client, frame.manifest)) {
            sendError(
              ws,
              "INVALID_ENVELOPE",
              "Chunk metadata does not match this connection",
              undefined,
              frame.manifest.transferId,
            );
            return;
          }
          const storedIndexes = frame.manifest.temporary
            ? new Set<number>()
            : new Set(store.chunkIndexes(
                client.roomId,
                frame.manifest.transferId,
                client.deviceId,
              ));
          const indexes = Array.from(
            { length: frame.manifest.total },
            (_, index) => index,
          ).filter((index) => !storedIndexes.has(index));
          safeSend(ws, {
            type: "chunk-missing",
            transferId: frame.manifest.transferId,
            indexes,
          });
          if (indexes.length === 0) {
            safeSend(ws, { type: "stored", ids: [frame.manifest.transferId] });
          }
          return;
        }
        if (frame.type === "ack") {
          const acknowledged = await store.ack(client.roomId, client.role, client.deviceId, frame.ids);
          const bySender = new Map<string, Set<string>>();
          for (const item of acknowledged) {
            const ids = bySender.get(item.fromDeviceId) ?? new Set<string>();
            ids.add(relayItemId(item));
            bySender.set(item.fromDeviceId, ids);
          }
          for (const [senderDeviceId, ids] of bySender) {
            for (const [sender] of roomClients(client.roomId, undefined, senderDeviceId)) {
              safeSend(sender, { type: "acknowledged", ids: [...ids], byDeviceId: client.deviceId });
            }
          }
          return;
        }
        const item = frame.type === "envelope-chunk" ? frame.chunk : frame.envelope;
        if (!validateEnvelope(client, item)) {
          sendError(
            ws,
            "INVALID_ENVELOPE",
            "Envelope metadata does not match this connection",
            undefined,
            "transferId" in item ? item.transferId : item.id,
          );
          return;
        }
        if (item.temporary) {
          const recipients = roomClients(
            client.roomId,
            item.to,
            item.toDeviceId,
          );
          for (const [target] of recipients) safeSend(target, "transferId" in item
            ? { type: "envelope-chunk", chunk: item }
            : { type: "envelope", envelope: item });
          safeSend(ws, { type: "stored", ids: [relayItemId(item)] });
          return;
        }
        const completeBefore = "transferId" in item && store.chunkIndexes(
          item.roomId,
          item.transferId,
          item.fromDeviceId,
        ).length === item.total;
        await store.enqueue(item);
        const id = relayItemId(item);
        const complete = !("transferId" in item) || store.chunkIndexes(
          item.roomId,
          item.transferId,
          item.fromDeviceId,
        ).length === item.total;
        if (complete) {
          if (!completeBefore) relayMetrics.envelopesStored += 1;
          safeSend(ws, { type: "stored", ids: [id] });
        }
        const recipients = roomClients(
          client.roomId,
          item.to,
          item.toDeviceId,
        );
        for (const [target] of recipients) safeSend(target, "transferId" in item
          ? { type: "envelope-chunk", chunk: item }
          : { type: "envelope", envelope: item });
        if (
          complete &&
          !completeBefore &&
          recipients.length === 0 &&
          item.to === "mobile" &&
          item.toDeviceId
        ) {
          const device = store.getDevice(client.roomId, item.toDeviceId);
          if (device) {
            relayMetrics.pushAttempts += 1;
            void pushDispatcher.wake(device).then((sent) => {
              if (sent) relayMetrics.pushSucceeded += 1;
            });
          }
        }
      }).catch((error: unknown) => {
        relayMetrics.errors += 1;
        logger.error("relay message handler failed", error);
        sendError(ws, "SERVER_ERROR", "The relay could not process this message");
      });
    });

    ws.on("close", () => {
      clearTimeout(helloTimeout);
      const client = state.authenticated;
      states.delete(ws);
      relayMetrics.activeConnections = Math.max(0, relayMetrics.activeConnections - 1);
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
    if (url.pathname !== "/ws" || (allowedOrigins.size > 0 && origin && !originAllowed(origin, allowedOrigins))) {
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
    metrics: () => ({ ...relayMetrics }),
    async close() {
      clearInterval(heartbeat);
      for (const ws of states.keys()) ws.close(1001, "relay shutting down");
      await new Promise<void>((resolve) => wsServer.close(() => resolve()));
      await new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
      await store.close();
    },
  };
}
