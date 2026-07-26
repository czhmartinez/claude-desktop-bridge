import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { PROTOCOL_VERSION } from "@bridge/protocol";
import { WebSocket } from "ws";

const relayUrl = process.env.BRIDGE_RELAY_URL ?? "wss://relay.alioxis.uk/ws";
const timeoutMs = Number(process.env.BRIDGE_RELAY_PROBE_TIMEOUT_MS ?? 8_000);

function randomId(bytes) {
  return randomBytes(bytes).toString("base64url");
}

function healthUrlForRelay(endpoint) {
  const url = new URL(endpoint);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "/health";
  url.search = "";
  url.hash = "";
  return url;
}

async function probeHello(version) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(relayUrl);
    const timeout = setTimeout(() => {
      socket.terminate();
      reject(new Error(`Relay V${version} handshake timed out`));
    }, timeoutMs);

    const finish = (error, frame) => {
      clearTimeout(timeout);
      if (socket.readyState === WebSocket.OPEN) socket.close(1000, "contract probe complete");
      if (error) reject(error);
      else resolve(frame);
    };

    socket.once("open", () => {
      socket.send(JSON.stringify({
        type: "hello",
        version,
        roomId: randomId(18),
        role: "mobile",
        deviceId: randomId(12),
        instanceId: randomId(12),
        authToken: randomId(32),
      }));
    });
    socket.once("message", (data) => {
      try {
        finish(undefined, JSON.parse(data.toString()));
      } catch (error) {
        finish(error);
      }
    });
    socket.once("error", (error) => finish(error));
  });
}

const healthResponse = await fetch(healthUrlForRelay(relayUrl), {
  headers: { accept: "application/json" },
  signal: AbortSignal.timeout(timeoutMs),
});
assert.equal(healthResponse.ok, true, `Relay health returned HTTP ${healthResponse.status}`);
const health = await healthResponse.json();
assert.equal(
  health.version,
  PROTOCOL_VERSION,
  `Relay health advertises V${String(health.version)}, expected V${PROTOCOL_VERSION}`,
);

const current = await probeHello(PROTOCOL_VERSION);
assert.deepEqual(
  { type: current.type, code: current.code },
  { type: "error", code: "ROOM_NOT_FOUND" },
  `Relay parser rejected the current V${PROTOCOL_VERSION} hello: ${JSON.stringify(current)}`,
);

const legacy = await probeHello(PROTOCOL_VERSION - 1);
assert.deepEqual(
  { type: legacy.type, code: legacy.code },
  { type: "error", code: "UPGRADE_REQUIRED" },
  `Relay did not explicitly reject V${PROTOCOL_VERSION - 1}: ${JSON.stringify(legacy)}`,
);

process.stdout.write(`${JSON.stringify({
  ok: true,
  relayUrl,
  protocolVersion: PROTOCOL_VERSION,
  currentHello: current.code,
  legacyHello: legacy.code,
}, null, 2)}\n`);
