import {
  BridgeCrypto,
  BridgeSocket,
  type BridgePayload,
  type DecryptedEnvelope,
  type ServerFrame,
} from "@bridge/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { startRelayServer, type RunningRelay } from "./server.js";
import { MemoryRelayStore } from "./store.js";
import type { DeviceRecord } from "./store.js";

const relays: RunningRelay[] = [];
const sockets: BridgeSocket[] = [];

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

describe("relay v2", () => {
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
});
