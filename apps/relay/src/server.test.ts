import { BridgeCrypto, BridgeSocket, type DecryptedEnvelope } from "@bridge/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { startRelayServer, type RunningRelay } from "./server.js";
import { MemoryRelayStore } from "./store.js";

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

describe("relay", () => {
  it("routes legacy mobile-to-agent commands to the desktop coordinator", async () => {
    const relay = await startRelayServer({ port: 0, store: new MemoryRelayStore(), logger: { info() {}, warn() {}, error() {} } });
    relays.push(relay);
    const { crypto: desktop, pairing } = await BridgeCrypto.createDesktop(relay.url, "Test Mac");
    const mobile = await BridgeCrypto.fromPairing(pairing, "phone");
    const desktopSocket = new BridgeSocket({ crypto: desktop, role: "desktop", createRoom: true, reconnect: false });
    const mobileSocket = new BridgeSocket({ crypto: mobile, role: "mobile", reconnect: false });
    sockets.push(desktopSocket, mobileSocket);
    desktopSocket.connect();
    await waitForState(desktopSocket);
    mobileSocket.connect();
    await waitForState(mobileSocket);

    const messagePromise = nextMessage(desktopSocket);
    await mobileSocket.send({ kind: "command", text: "Run the focused tests" }, "agent");
    const message = await messagePromise;
    expect(message.payload).toEqual({ kind: "command", text: "Run the focused tests" });
  });

  it("replays an offline message until its target acknowledges it", async () => {
    const relay = await startRelayServer({ port: 0, store: new MemoryRelayStore(), logger: { info() {}, warn() {}, error() {} } });
    relays.push(relay);
    const { crypto: desktop, pairing } = await BridgeCrypto.createDesktop(relay.url, "Test Mac");
    const mobile = await BridgeCrypto.fromPairing(pairing, "phone");
    const desktopSocket = new BridgeSocket({ crypto: desktop, role: "desktop", createRoom: true, reconnect: false });
    const mobileSocket = new BridgeSocket({ crypto: mobile, role: "mobile", reconnect: false });
    sockets.push(desktopSocket, mobileSocket);
    desktopSocket.connect();
    await waitForState(desktopSocket);
    mobileSocket.connect();
    await waitForState(mobileSocket);
    desktopSocket.close();
    await mobileSocket.send({ kind: "command", text: "Remember this" }, "agent");

    const firstDesktop = new BridgeSocket({ crypto: desktop, role: "desktop", createRoom: true, reconnect: false });
    sockets.push(firstDesktop);
    const firstMessage = nextMessage(firstDesktop);
    firstDesktop.connect();
    await waitForState(firstDesktop);
    const delivered = await firstMessage;
    firstDesktop.close();

    const secondDesktop = new BridgeSocket({ crypto: desktop, role: "desktop", createRoom: true, reconnect: false });
    sockets.push(secondDesktop);
    const replay = nextMessage(secondDesktop);
    secondDesktop.connect();
    await waitForState(secondDesktop);
    expect((await replay).header.id).toBe(delivered.header.id);
    secondDesktop.ack([delivered.header.id]);
  });

  it("delivers new mobile commands addressed directly to desktop", async () => {
    const relay = await startRelayServer({ port: 0, store: new MemoryRelayStore(), logger: { info() {}, warn() {}, error() {} } });
    relays.push(relay);
    const { crypto: desktop, pairing } = await BridgeCrypto.createDesktop(relay.url, "Test Mac");
    const mobile = await BridgeCrypto.fromPairing(pairing, "phone");
    const desktopSocket = new BridgeSocket({ crypto: desktop, role: "desktop", createRoom: true, reconnect: false });
    const mobileSocket = new BridgeSocket({ crypto: mobile, role: "mobile", reconnect: false });
    sockets.push(desktopSocket, mobileSocket);
    desktopSocket.connect();
    await waitForState(desktopSocket);
    mobileSocket.connect();
    await waitForState(mobileSocket);

    const messagePromise = nextMessage(desktopSocket);
    await mobileSocket.send({ kind: "command", text: "Continue the current task" }, "desktop");
    expect((await messagePromise).payload).toEqual({ kind: "command", text: "Continue the current task" });
  });
});
