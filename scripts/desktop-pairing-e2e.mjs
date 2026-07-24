import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  BridgeCrypto,
  RelayTransport,
  WebRtcTransport,
  bridgeIceServers,
  pairingBundleFromUrl,
  randomId,
  relayPathForUrl,
} from "@bridge/protocol";
import { chromium } from "playwright-core";

const endpoint = process.env.BRIDGE_DESKTOP_CDP ?? "http://127.0.0.1:9223";
const nativeRequire = createRequire(import.meta.url);
const { RTCPeerConnection } = nativeRequire("node-datachannel/polyfill");
const nodeDataChannel = nativeRequire("node-datachannel");
nodeDataChannel.preload?.();
const browser = await chromium.connectOverCDP(endpoint);
let mobile;
try {
  const page = browser.contexts()
    .flatMap((context) => context.pages())
    .find((candidate) => candidate.url().startsWith("file:"));
  assert.ok(page, "Packaged Bridge renderer was not found");
  const desktopSnapshot = await page.evaluate(() => window.bridgeDesktop.createPairing());
  assert.ok(desktopSnapshot.pairingUrl, "Desktop did not create a pairing URL");
  const pairing = pairingBundleFromUrl(desktopSnapshot.pairingUrl);
  assert.ok(pairing, "Desktop pairing URL was invalid");
  const crypto = await BridgeCrypto.fromPairing(pairing);
  const relay = new RelayTransport({
    crypto,
    role: "mobile",
    reconnect: false,
    path: relayPathForUrl(crypto.identity.relayUrl),
  });
  mobile = new WebRtcTransport({
    relay,
    crypto,
    role: "mobile",
    RTCPeerConnectionImpl: RTCPeerConnection,
    iceServers: bridgeIceServers(pairing.serviceOrigin ?? ""),
  });
  const requestId = randomId();

  const result = await new Promise((resolve, reject) => {
    const state = { snapshot: undefined, response: undefined };
    const timeout = setTimeout(() => reject(new Error("Pairing E2E timed out")), 10_000);
    const finish = () => {
      if (!state.snapshot || !state.response) return;
      clearTimeout(timeout);
      resolve(state);
    };
    mobile.onState((connection) => {
      if (connection !== "connected") return;
    });
    const stopMetrics = mobile.onMetrics((metrics) => {
      if (metrics.path !== "direct") return;
      stopMetrics();
      void mobile.send({
        kind: "request",
        requestId,
        idempotencyKey: randomId(),
        method: "project.list",
        params: {
          client: { name: "Pairing E2E", platform: "web" },
          padding: "x".repeat(200_000),
        },
      }, "desktop").catch(reject);
    });
    mobile.onMessage((message, encrypted) => {
      mobile.ack([encrypted.id]);
      if (message.payload.kind === "snapshot") state.snapshot = message.payload.snapshot;
      if (message.payload.kind === "response" && message.payload.requestId === requestId) {
        state.response = message.payload;
      }
      finish();
    });
    mobile.onFrame((frame) => {
      if (frame.type === "error") reject(new Error(`${frame.code}: ${frame.message}`));
    });
    mobile.connect();
  });

  assert.equal(result.snapshot.host.hostId, desktopSnapshot.host.hostId);
  assert.equal(result.response.ok, true);
  assert.ok(Array.isArray(result.response.result?.projects));
  const transportPath = mobile.path;
  assert.equal(transportPath, "direct");
  const revokedNotice = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Revoked device remained connected")), 5_000);
    const stop = mobile.onFrame((frame) => {
      if (frame.type !== "error" || frame.code !== "DEVICE_REVOKED") return;
      clearTimeout(timeout);
      stop();
      resolve(true);
    });
  });
  await page.evaluate((deviceId) => window.bridgeDesktop.revokeDevice(deviceId), pairing.deviceId);
  await revokedNotice;
  process.stdout.write(`${JSON.stringify({
    ok: true,
    host: result.snapshot.host.name,
    projects: result.response.result.projects.length,
    transport: transportPath,
    deviceRevoked: true,
  }, null, 2)}\n`);
} finally {
  mobile?.close();
  await browser.close();
  nodeDataChannel.cleanup?.();
}
