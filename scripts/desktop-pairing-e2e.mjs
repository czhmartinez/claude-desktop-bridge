import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  BridgeCrypto,
  RelayTransport,
  WebRtcTransport,
  bridgeIceServers,
  cryptoWithRelayEndpoint,
  pairingBundleFromUrl,
  randomId,
  relayPathForUrl,
} from "@bridge/protocol";
import { chromium } from "playwright-core";

const endpoint = process.env.BRIDGE_DESKTOP_CDP ?? "http://127.0.0.1:9223";
const forceRelay = process.env.BRIDGE_E2E_FORCE_RELAY === "1";
const paddingBytes = Math.max(
  0,
  Math.min(600_000, Number(process.env.BRIDGE_E2E_PADDING_BYTES ?? (forceRelay ? 0 : 200_000))),
);
const relayOverride = process.env.BRIDGE_E2E_RELAY_URL;
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
  await new Promise((resolve) => setTimeout(resolve, 300));
  const pairedCrypto = await BridgeCrypto.fromPairing(pairing);
  const crypto = relayOverride
    ? cryptoWithRelayEndpoint(pairedCrypto, relayOverride)
    : pairedCrypto;
  const relay = new RelayTransport({
    crypto,
    role: "mobile",
    reconnect: false,
    path: relayPathForUrl(crypto.identity.relayUrl),
  });
  mobile = forceRelay
    ? relay
    : new WebRtcTransport({
        relay,
        crypto,
        role: "mobile",
        RTCPeerConnectionImpl: RTCPeerConnection,
        iceServers: bridgeIceServers(pairing.iceServers),
      });
  const requestId = randomId();

  const result = await new Promise((resolve, reject) => {
    const state = { snapshot: undefined, response: undefined };
    const diagnostics = {
      states: [],
      paths: [],
      errors: [],
      frames: [],
      relayMessages: [],
      messages: [],
    };
    const timeout = setTimeout(() => reject(new Error(
      `Pairing E2E timed out: ${JSON.stringify(diagnostics)}`,
    )), 20_000);
    let fallbackTimer;
    let sent = false;
    const sendRequest = () => {
      if (sent) return;
      sent = true;
      void mobile.send({
        kind: "request",
        requestId,
        idempotencyKey: randomId(),
        method: "project.list",
        params: {
          client: { name: "Pairing E2E", platform: "web" },
          padding: "x".repeat(paddingBytes),
        },
      }, "desktop").catch(reject);
    };
    relay.onMessage((message) => diagnostics.relayMessages.push(message.payload.kind));
    const finish = () => {
      if (!state.snapshot || !state.response) return;
      clearTimeout(timeout);
      clearTimeout(fallbackTimer);
      resolve(state);
    };
    mobile.onState((connection) => {
      diagnostics.states.push(connection);
      if (connection !== "connected") return;
      if (forceRelay) sendRequest();
      else fallbackTimer ??= setTimeout(sendRequest, 5_500);
    });
    const stopMetrics = mobile.onMetrics((metrics) => {
      diagnostics.paths.push(metrics.path);
      if (metrics.path !== "direct") return;
      stopMetrics();
      sendRequest();
    });
    mobile.onMessage((message, encrypted) => {
      diagnostics.messages.push(
        message.payload.kind === "response"
          ? `${message.payload.kind}:${message.payload.requestId}`
          : message.payload.kind,
      );
      mobile.ack([encrypted.id]);
      if (message.payload.kind === "snapshot") state.snapshot = message.payload.snapshot;
      if (message.payload.kind === "response" && message.payload.requestId === requestId) {
        state.response = message.payload;
      }
      finish();
    });
    mobile.onFrame((frame) => {
      diagnostics.frames.push(frame.type);
      if (frame.type === "error") reject(new Error(`${frame.code}: ${frame.message}`));
    });
    mobile.onError((error) => diagnostics.errors.push(error.message));
    mobile.connect();
  });

  assert.equal(result.snapshot.host.hostId, desktopSnapshot.host.hostId);
  assert.equal(result.response.ok, true);
  assert.ok(Array.isArray(result.response.result?.projects));
  const transportPath = mobile.path;
  const acceptedPaths = relayOverride
    ? [relayPathForUrl(relayOverride)]
    : ["direct", "public-relay"];
  assert.ok(
    acceptedPaths.includes(transportPath),
    `Unexpected transport path: ${transportPath}`,
  );
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
