import {
  BridgeCrypto,
  BridgeSocket,
  PROTOCOL_VERSION,
  type BridgePayload,
  type DecryptedEnvelope,
  type RelayEnvelopeItem,
  type ServerFrame,
} from "@bridge/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { startRelayServer, type RunningRelay } from "./server.js";
import { MemoryRelayStore } from "./store.js";
import type { DeviceRecord } from "./store.js";

const relays: RunningRelay[] = [];
const sockets: BridgeSocket[] = [];

class CountingRelayStore extends MemoryRelayStore {
  enqueuedFrames = 0;

  override async enqueue(item: RelayEnvelopeItem): Promise<void> {
    this.enqueuedFrames += 1;
    await super.enqueue(item);
  }
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  for (const relay of relays.splice(0)) await relay.close();
});

function waitForState(socket: BridgeSocket, expected = "connected", timeoutMs = 3_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for ${expected}; current state is ${socket.state}`));
    }, timeoutMs);
    const unsubscribe = socket.onState((state) => {
      if (state === expected) {
        clearTimeout(timeout);
        unsubscribe();
        resolve();
      }
    });
  });
}

function waitForFrame(
  socket: BridgeSocket,
  predicate: (frame: ServerFrame) => boolean,
  timeoutMs = 3_000,
): Promise<ServerFrame> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error("Timed out waiting for relay frame"));
    }, timeoutMs);
    const unsubscribe = socket.onFrame((frame) => {
      if (!predicate(frame)) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve(frame);
    });
  });
}

function nextMessage(socket: BridgeSocket, timeoutMs = 3_000): Promise<DecryptedEnvelope> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error("Timed out waiting for a bridge message"));
    }, timeoutMs);
    const unsubscribe = socket.onMessage((message) => {
      clearTimeout(timeout);
      unsubscribe();
      resolve(message);
    });
  });
}

function turnRequest(text: string): BridgePayload {
  return {
    kind: "request",
    requestId: crypto.randomUUID(),
    idempotencyKey: crypto.randomUUID(),
    method: "turn.start",
    params: { sessionId: "session-1", text },
  };
}

async function connectedPair(relayUrl: string) {
  const host = await BridgeCrypto.createHost(relayUrl, "Test Mac");
  const device = await BridgeCrypto.createDevicePairing({
    roomId: host.crypto.identity.roomId,
    relayUrl,
    desktopName: "Test Mac",
  });
  const desktopDeviceCrypto = device.desktopCrypto.withSenderDevice(host.crypto.identity.deviceId);
  const mobileCrypto = await BridgeCrypto.fromPairing(device.pairing);
  const desktopSocket = new BridgeSocket({
    crypto: host.crypto,
    role: "desktop",
    createRoom: true,
    reconnect: false,
    resolveCrypto: () => desktopDeviceCrypto,
  });
  const mobileSocket = new BridgeSocket({ crypto: mobileCrypto, role: "mobile", reconnect: false });
  sockets.push(desktopSocket, mobileSocket);
  desktopSocket.connect();
  await waitForState(desktopSocket);
  const registered = waitForFrame(desktopSocket, (frame) => frame.type === "device-registered");
  desktopSocket.registerDevice(device.pairing.deviceId, device.desktopCrypto.identity.authToken, device.pairing.expiresAt);
  await registered;
  mobileSocket.connect();
  await waitForState(mobileSocket);
  return { host, device, desktopDeviceCrypto, mobileCrypto, desktopSocket, mobileSocket };
}

describe("relay v3", () => {
  it("publishes liveness, readiness and content-free operational metrics", async () => {
    const relay = await startRelayServer({
      port: 0,
      store: new MemoryRelayStore(),
      logger: { info() {}, warn() {}, error() {} },
    });
    relays.push(relay);
    const origin = relay.url.replace(/^ws:/u, "http:").replace(/\/ws$/u, "");
    const health = await fetch(`${origin}/health`);
    const ready = await fetch(`${origin}/ready`);
    const metrics = await fetch(`${origin}/metrics`);

    expect(await health.json()).toMatchObject({ ok: true, version: PROTOCOL_VERSION });
    expect(await ready.json()).toMatchObject({
      ok: true,
      storage: { rooms: 0, devices: 0, queuedFrames: 0 },
    });
    expect(await metrics.text()).toContain("bridge_relay_queue_bytes 0");
  });

  it("routes an encrypted phone request to its host and reports transport storage", async () => {
    const relay = await startRelayServer({
      port: 0,
      store: new MemoryRelayStore(),
      logger: { info() {}, warn() {}, error() {} },
    });
    relays.push(relay);
    const pair = await connectedPair(relay.url);
    const stored = waitForFrame(pair.mobileSocket, (frame) => frame.type === "stored");
    const message = nextMessage(pair.desktopSocket);
    await pair.mobileSocket.send(turnRequest("Run focused tests"), "desktop");

    expect((await message).payload).toMatchObject({ kind: "request", method: "turn.start" });
    expect((await stored).type).toBe("stored");
  });

  it("identifies a rejected envelope without dropping the authenticated connection", async () => {
    const relay = await startRelayServer({
      port: 0,
      store: new MemoryRelayStore(),
      logger: { info() {}, warn() {}, error() {} },
    });
    relays.push(relay);
    const pair = await connectedPair(relay.url);
    const envelope = await pair.mobileCrypto.encrypt(turnRequest("Stale metadata"), "mobile", "desktop");
    const rejected = waitForFrame(pair.mobileSocket, (frame) => frame.type === "error");

    await pair.mobileSocket.sendEnvelope({ ...envelope, fromDeviceId: "old-phone" });

    expect(await rejected).toMatchObject({
      type: "error",
      code: "INVALID_ENVELOPE",
      envelopeId: envelope.id,
    });
    expect(pair.mobileSocket.state).toBe("connected");
  });

  it("rejects protocol v2 clients with an explicit re-pairing error", async () => {
    const relay = await startRelayServer({
      port: 0,
      store: new MemoryRelayStore(),
      logger: { info() {}, warn() {}, error() {} },
    });
    relays.push(relay);
    const socket = new WebSocket(relay.url);
    const error = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for upgrade error")), 3_000);
      socket.on("open", () => {
        socket.send(JSON.stringify({
          type: "hello",
          version: 2,
          roomId: "legacy-room-12345678",
          role: "mobile",
          deviceId: "legacy-phone",
          authToken: "x".repeat(43),
        }));
      });
      socket.on("message", (data) => {
        clearTimeout(timeout);
        resolve(JSON.parse(data.toString()) as Record<string, unknown>);
      });
    });

    await expect(error).resolves.toMatchObject({
      type: "error",
      code: "UPGRADE_REQUIRED",
    });
    socket.close();
  });

  it("chunks, hashes and reassembles an encrypted payload larger than a websocket frame", async () => {
    const store = new CountingRelayStore();
    const relay = await startRelayServer({
      port: 0,
      store,
      logger: { info() {}, warn() {}, error() {} },
    });
    relays.push(relay);
    const pair = await connectedPair(relay.url);
    const text = "x".repeat(900_000);
    const received = nextMessage(pair.desktopSocket, 5_000);
    const stored = waitForFrame(pair.mobileSocket, (frame) => frame.type === "stored", 5_000);
    const envelope = await pair.mobileCrypto.encrypt(turnRequest(text), "mobile", "desktop");
    await pair.mobileSocket.sendEnvelope(envelope);

    const payload = (await received).payload;
    expect(payload.kind).toBe("request");
    if (payload.kind !== "request") throw new Error("Expected a request payload");
    expect(payload.params.text).toBe(text);
    expect(await stored).toMatchObject({ type: "stored" });
    const initiallyStoredFrames = store.enqueuedFrames;
    expect(initiallyStoredFrames).toBeGreaterThan(1);
    const retried = waitForFrame(pair.mobileSocket, (frame) => frame.type === "stored", 5_000);
    await pair.mobileSocket.sendEnvelope(envelope);
    await retried;
    expect(store.enqueuedFrames).toBe(initiallyStoredFrames);
    expect(relay.metrics().envelopesStored).toBeGreaterThanOrEqual(1);
  });

  it("forwards temporary artifact bodies without entering the persistent queue", async () => {
    const store = new CountingRelayStore();
    const relay = await startRelayServer({
      port: 0,
      store,
      logger: { info() {}, warn() {}, error() {} },
    });
    relays.push(relay);
    const pair = await connectedPair(relay.url);
    const text = "preview".repeat(140_000);
    const received = nextMessage(pair.desktopSocket, 5_000);
    const envelope = await pair.mobileCrypto.encrypt(
      turnRequest(text),
      "mobile",
      "desktop",
      Date.now(),
      10 * 60 * 1_000,
      undefined,
      true,
    );
    await pair.mobileSocket.sendEnvelope(envelope);

    const payload = (await received).payload;
    expect(payload.kind).toBe("request");
    if (payload.kind !== "request") throw new Error("Expected a request payload");
    expect(payload.params.text).toBe(text);
    expect(store.enqueuedFrames).toBe(0);
    expect(relay.metrics().envelopesStored).toBe(0);
  });

  it("replays an offline request until the exact host device acknowledges it", async () => {
    const relay = await startRelayServer({
      port: 0,
      store: new MemoryRelayStore(),
      logger: { info() {}, warn() {}, error() {} },
    });
    relays.push(relay);
    const pair = await connectedPair(relay.url);
    pair.desktopSocket.close();
    await pair.mobileSocket.send(turnRequest("Remember this"), "desktop");

    const reconnect = new BridgeSocket({
      crypto: pair.host.crypto,
      role: "desktop",
      createRoom: true,
      reconnect: false,
      resolveCrypto: () => pair.desktopDeviceCrypto,
    });
    sockets.push(reconnect);
    const first = nextMessage(reconnect);
    reconnect.connect();
    await waitForState(reconnect);
    const delivered = await first;
    reconnect.close();

    const replaySocket = new BridgeSocket({
      crypto: pair.host.crypto,
      role: "desktop",
      createRoom: true,
      reconnect: false,
      resolveCrypto: () => pair.desktopDeviceCrypto,
    });
    sockets.push(replaySocket);
    const replayed = nextMessage(replaySocket);
    replaySocket.connect();
    await waitForState(replaySocket);
    expect((await replayed).header.id).toBe(delivered.header.id);
    replaySocket.ack([delivered.header.id]);
  });

  it("delivers host events only to the addressed phone", async () => {
    const relay = await startRelayServer({
      port: 0,
      store: new MemoryRelayStore(),
      logger: { info() {}, warn() {}, error() {} },
    });
    relays.push(relay);
    const pair = await connectedPair(relay.url);
    const event: BridgePayload = {
      kind: "event",
      event: {
        eventId: "event-1",
        sessionId: "session-1",
        seq: 1,
        timestamp: Date.now(),
        origin: "claude-host",
        type: "assistant.completed",
        data: { text: "Done" },
      },
    };
    const received = nextMessage(pair.mobileSocket);
    await pair.desktopSocket.send(event, "mobile", {
      toDeviceId: pair.device.pairing.deviceId,
      crypto: pair.desktopDeviceCrypto,
    });

    expect((await received).payload).toEqual(event);
  });

  it("binds a pairing code to the first mobile installation", async () => {
    const relay = await startRelayServer({
      port: 0,
      store: new MemoryRelayStore(),
      logger: { info() {}, warn() {}, error() {} },
    });
    relays.push(relay);
    const pair = await connectedPair(relay.url);
    const copiedCrypto = await BridgeCrypto.fromPairing(pair.device.pairing);
    const copied = new BridgeSocket({ crypto: copiedCrypto, role: "mobile", reconnect: false });
    sockets.push(copied);
    const error = waitForFrame(copied, (frame) => frame.type === "error");
    copied.connect();

    expect(await error).toMatchObject({ type: "error", code: "PAIRING_ALREADY_USED" });
  });

  it("rejects a revoked device on its next reconnect", async () => {
    const relay = await startRelayServer({
      port: 0,
      store: new MemoryRelayStore(),
      logger: { info() {}, warn() {}, error() {} },
    });
    relays.push(relay);
    const pair = await connectedPair(relay.url);
    const revoked = waitForFrame(pair.desktopSocket, (frame) => frame.type === "device-revoked");
    pair.desktopSocket.revokeDevice(pair.device.pairing.deviceId);
    await revoked;
    pair.mobileSocket.close();
    const rejected = new BridgeSocket({ crypto: pair.mobileCrypto, role: "mobile", reconnect: false });
    sockets.push(rejected);
    const error = waitForFrame(rejected, (frame) => frame.type === "error");
    rejected.connect();

    expect(await error).toMatchObject({ type: "error", code: "DEVICE_REVOKED" });
  });

  it("requests a content-free wake when a targeted phone is offline", async () => {
    const wakes: string[] = [];
    const relay = await startRelayServer({
      port: 0,
      store: new MemoryRelayStore(),
      pushDispatcher: {
        async wake(device: DeviceRecord) {
          wakes.push(device.deviceId);
          return true;
        },
      },
      logger: { info() {}, warn() {}, error() {} },
    });
    relays.push(relay);
    const pair = await connectedPair(relay.url);
    pair.mobileSocket.registerPushToken("android", "test-push-token-1234567890");
    await new Promise((resolve) => setTimeout(resolve, 10));
    pair.mobileSocket.close();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await pair.desktopSocket.send({
      kind: "event",
      event: {
        eventId: "wake-event",
        seq: 2,
        timestamp: Date.now(),
        origin: "system",
        type: "host.presence",
        data: {},
      },
    }, "mobile", {
      toDeviceId: pair.device.pairing.deviceId,
      crypto: pair.desktopDeviceCrypto,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(wakes).toEqual([pair.device.pairing.deviceId]);
  });

  it("moves an already paired device to a new public relay without a new secret", async () => {
    const firstRelay = await startRelayServer({
      port: 0,
      store: new MemoryRelayStore(),
      logger: { info() {}, warn() {}, error() {} },
    });
    relays.push(firstRelay);
    const pair = await connectedPair(firstRelay.url);
    pair.desktopSocket.close();
    pair.mobileSocket.close();

    const publicRelay = await startRelayServer({
      port: 0,
      store: new MemoryRelayStore(),
      logger: { info() {}, warn() {}, error() {} },
    });
    relays.push(publicRelay);
    const movedHostCrypto = new BridgeCrypto({
      encryptionKey: pair.host.crypto.encryptionKey,
      identity: { ...pair.host.crypto.identity, relayUrl: publicRelay.url },
    });
    const movedMobileCrypto = new BridgeCrypto({
      encryptionKey: pair.mobileCrypto.encryptionKey,
      identity: { ...pair.mobileCrypto.identity, relayUrl: publicRelay.url },
    });
    const desktop = new BridgeSocket({
      crypto: movedHostCrypto,
      role: "desktop",
      createRoom: true,
      reconnect: false,
      resolveCrypto: () => pair.desktopDeviceCrypto,
    });
    const mobile = new BridgeSocket({ crypto: movedMobileCrypto, role: "mobile", reconnect: false });
    sockets.push(desktop, mobile);
    desktop.connect();
    await waitForState(desktop);
    desktop.registerDevice(
      pair.device.pairing.deviceId,
      pair.device.desktopCrypto.identity.authToken,
      Date.now() + 7 * 24 * 60 * 60 * 1_000,
      { migrate: true, pairedAt: Date.now() - 1_000 },
    );
    await waitForFrame(desktop, (frame) => frame.type === "device-registered");

    mobile.connect();
    await waitForState(mobile);
    const received = nextMessage(desktop);
    await mobile.send(turnRequest("Continue after migration"), "desktop");
    expect((await received).payload).toMatchObject({
      kind: "request",
      method: "turn.start",
    });
  });

  it("allows native WebView origins and loopback browsers while blocking remote http origins", async () => {
    const relay = await startRelayServer({
      port: 0,
      store: new MemoryRelayStore(),
      logger: { info() {}, warn() {}, error() {} },
      allowedOrigins: ["https://relay.alioxis.com"],
    });
    relays.push(relay);

    async function upgradeResult(origin?: string): Promise<number> {
      return new Promise((resolve, reject) => {
        const socket = new WebSocket(relay.url, {
          headers: origin ? { origin } : undefined,
        });
        const timeout = setTimeout(() => {
          socket.terminate();
          reject(new Error("Timed out waiting for the relay upgrade"));
        }, 3_000);
        socket.on("open", () => {
          clearTimeout(timeout);
          socket.close(1000);
          resolve(200);
        });
        socket.on("unexpected-response", (_request, response) => {
          clearTimeout(timeout);
          resolve(response.statusCode ?? 0);
        });
        socket.on("error", () => {
          clearTimeout(timeout);
          resolve(0);
        });
      });
    }

    // Native mobile WebViews and Electron file contexts must never be blocked.
    for (const origin of [
      "capacitor://localhost",
      "bridge://localhost",
      "http://localhost",
      "https://localhost",
      "ionic://localhost",
      "file://",
      "null",
      undefined,
    ]) {
      await expect(upgradeResult(origin)).resolves.toBe(200);
    }

    // A remote attacker page is still rejected unless explicitly allowed.
    await expect(upgradeResult("https://evil.example")).resolves.toBe(403);
    await expect(upgradeResult("https://relay.alioxis.com")).resolves.toBe(200);
  });

  it("applies the per-connection frame budget without killing normal relay traffic", async () => {
    const relay = await startRelayServer({
      port: 0,
      store: new MemoryRelayStore(),
      logger: { info() {}, warn() {}, error() {} },
      maxFramesPerMinute: 5,
    });
    relays.push(relay);
    const socket = new WebSocket(relay.url);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for the relay upgrade")), 3_000);
      socket.on("open", () => {
        clearTimeout(timeout);
        resolve();
      });
      socket.on("error", reject);
    });
    socket.send(JSON.stringify({
      type: "hello",
      version: PROTOCOL_VERSION,
      roomId: "frame-budget-room-12345678",
      role: "desktop",
      deviceId: "frame-budget-host",
      authToken: "x".repeat(43),
      create: true,
    }));
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for relay ready")), 3_000);
      socket.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as { type?: string };
        if (frame.type === "ready") {
          clearTimeout(timeout);
          resolve();
        }
      });
    });
    const errors: string[] = [];
    socket.on("message", (data) => {
      const frame = JSON.parse(data.toString()) as { type?: string; code?: string };
      if (frame.type === "error" && frame.code) errors.push(frame.code);
    });
    for (let index = 0; index < 10; index += 1) {
      socket.send(JSON.stringify({ type: "ping", at: Date.now() }));
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(errors).toContain("RATE_LIMITED");
    socket.close();
  });
});
