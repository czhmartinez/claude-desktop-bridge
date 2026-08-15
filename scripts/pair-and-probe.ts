import { chromium } from "playwright-core";
import { randomBytes } from "node:crypto";
import {
  BridgeCrypto,
  RelayTransport,
  pairingBundleFromUrl,
} from "../packages/protocol/src/index.js";

// 1) 让真实桌面 app 生成配对链接
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.argv[2] ?? process.env.BRIDGE_CDP_PORT ?? "9333"}`);
const page = browser.contexts().flatMap((context) => context.pages())
  .find((candidate) => candidate.url().includes("app.asar"));
if (!page) throw new Error("Bridge renderer not found over CDP");

const snapshot = await page.evaluate(async () => {
  const api = (window as unknown as { bridgeDesktop: { createPairing(): Promise<Record<string, unknown>> } }).bridgeDesktop;
  return api.createPairing();
});
const pairingUrl = String(snapshot.pairingUrl ?? "");
console.log("[pairing-url]", pairingUrl.slice(0, 90) + "…");
await browser.close();

// 2) 像手机一样兑换配对并连入
const bundle = pairingBundleFromUrl(pairingUrl);
if (!bundle) throw new Error("pairing bundle parse failed");
console.log("[bundle] room", bundle.roomId, "device", bundle.deviceId, "activeEndpoint", bundle.activeEndpoint);
for (const endpoint of bundle.relayEndpoints) {
  console.log("[bundle] endpoint", endpoint.id, endpoint.kind, endpoint.priority, endpoint.url);
}

const instanceId = randomBytes(8).toString("hex");
const crypto = await BridgeCrypto.fromPairing(bundle, { instanceId });
console.log("[probe] crypto relayUrl =", crypto.identity.relayUrl);

const transport = new RelayTransport({ crypto, role: "mobile", reconnect: false });
transport.onState((state) => console.log("[state]", state));
transport.onFrame((frame) => {
  const summary = JSON.stringify(frame);
  console.log("[frame]", summary.length > 240 ? `${summary.slice(0, 240)}…` : summary);
});
transport.onMetrics((metrics) => console.log("[metrics]", JSON.stringify(metrics)));
transport.onError((error) => console.log("[error]", error.name, error.message));
transport.onMessage((message) => {
  const payload = message.payload as { kind?: string; method?: string };
  console.log("[message]", payload.kind ?? payload.method ?? "unknown", "from", message.header.fromDeviceId);
});
transport.connect();

setTimeout(async () => {
  try {
    const envelope = await crypto.encrypt(
      { kind: "request", requestId: "probe-snapshot", idempotencyKey: "probe-snapshot", method: "snapshot.get", params: {} },
      "mobile",
      "desktop",
    );
    console.log("[send] snapshot.get", envelope.id);
    await transport.sendEnvelope(envelope);
  } catch (error) {
    console.log("[send] failed:", error instanceof Error ? error.message : error);
  }
}, 10_000);

setTimeout(async () => {
  try {
    const envelope = await crypto.encrypt(
      { kind: "request", requestId: "probe-sessions", idempotencyKey: "probe-sessions", method: "session.list", params: {} },
      "mobile",
      "desktop",
    );
    console.log("[send] session.list", envelope.id);
    await transport.sendEnvelope(envelope);
  } catch (error) {
    console.log("[send] failed:", error instanceof Error ? error.message : error);
  }
}, 16_000);

setTimeout(() => {
  console.log("[probe] done");
  transport.close();
  process.exit(0);
}, 34_000);
