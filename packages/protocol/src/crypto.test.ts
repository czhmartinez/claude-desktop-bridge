import { describe, expect, it } from "vitest";
import {
  BridgeCrypto,
  buildPairingUrl,
  decodeUtf8,
  decodePairingBundle,
  encodePairingBundle,
  fromBase64Url,
  isBridgePayload,
  pairingBundleFromUrl,
  toBase64Url,
  utf8,
  type BridgeRequest,
} from "./index.js";

function request(text: string): BridgeRequest {
  return {
    kind: "request",
    requestId: crypto.randomUUID(),
    idempotencyKey: crypto.randomUUID(),
    method: "turn.start",
    params: { sessionId: "session-1", text },
  };
}

describe("BridgeCrypto v2", () => {
  it("encrypts device-targeted requests with authenticated metadata", async () => {
    const { crypto: desktop, pairing } = await BridgeCrypto.createDesktop("ws://localhost:8788/ws", "Studio Mac");
    const mobile = await BridgeCrypto.fromPairing(pairing);
    const envelope = await mobile.encrypt(request("Continue"), "mobile", "desktop");

    expect(envelope.ciphertext).not.toContain("Continue");
    expect((await desktop.decrypt(envelope)).payload).toMatchObject({
      kind: "request",
      method: "turn.start",
    });
  });

  it("uses independent encryption and relay credentials for each device", async () => {
    const host = await BridgeCrypto.createHost("wss://relay.example/ws", "Studio Mac");
    const phoneA = await BridgeCrypto.createDevicePairing({
      roomId: host.crypto.identity.roomId,
      relayUrl: host.crypto.identity.relayUrl,
      desktopName: host.crypto.identity.desktopName,
    });
    const phoneB = await BridgeCrypto.createDevicePairing({
      roomId: host.crypto.identity.roomId,
      relayUrl: host.crypto.identity.relayUrl,
      desktopName: host.crypto.identity.desktopName,
    });
    const mobileA = await BridgeCrypto.fromPairing(phoneA.pairing);
    const mobileB = await BridgeCrypto.fromPairing(phoneB.pairing);
    const outbound = phoneA.desktopCrypto
      .withSenderDevice(host.crypto.identity.deviceId);
    const envelope = await outbound.encrypt({
      kind: "response",
      requestId: "request-1",
      ok: true,
    }, "desktop", "mobile", Date.now(), undefined, phoneA.pairing.deviceId);

    expect(phoneA.desktopCrypto.identity.authToken).not.toBe(phoneB.desktopCrypto.identity.authToken);
    await expect(mobileB.decrypt(envelope)).rejects.toThrow();
    expect((await mobileA.decrypt(envelope)).payload).toMatchObject({ kind: "response", ok: true });
  });

  it("rejects tampered target metadata", async () => {
    const { crypto: desktop, pairing } = await BridgeCrypto.createDesktop("ws://localhost:8788/ws", "Studio Mac");
    const mobile = await BridgeCrypto.fromPairing(pairing);
    const envelope = await desktop.encrypt({
      kind: "event",
      event: {
        eventId: "event-1",
        seq: 1,
        timestamp: Date.now(),
        origin: "system",
        type: "host.presence",
        data: {},
      },
    }, "desktop", "mobile");

    await expect(mobile.decrypt({ ...envelope, toDeviceId: "another-phone" })).rejects.toThrow();
  });

  it("round-trips a ten-minute single-use pairing URL", async () => {
    const host = await BridgeCrypto.createHost("wss://relay.example/ws", "Workstation");
    const { pairing } = await BridgeCrypto.createDevicePairing({
      roomId: host.crypto.identity.roomId,
      relayUrl: host.crypto.identity.relayUrl,
      desktopName: host.crypto.identity.desktopName,
      iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
      now: 1_000,
    });
    const encoded = encodePairingBundle(pairing);
    expect(encoded).not.toMatch(/[+/=]/u);
    expect(decodePairingBundle(encoded)).toEqual(pairing);
    const url = buildPairingUrl("https://bridge.example/app?source=desktop", pairing);
    expect(new URL(url).searchParams.get("source")).toBe("desktop");
    expect(pairingBundleFromUrl(url)).toEqual(pairing);
    expect(pairing.expiresAt - pairing.createdAt).toBe(10 * 60 * 1_000);
    expect(pairing).toMatchObject({
      version: 3,
      protocolVersion: 2,
      activeEndpoint: "public",
      iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
    });
    expect(pairing.relayEndpoints).toHaveLength(1);
  });

  it("uses a compact QR wire format while preserving all pairing routes", async () => {
    const host = await BridgeCrypto.createHost("wss://relay.example/ws", "工作室 Mac");
    const { pairing } = await BridgeCrypto.createDevicePairing({
      roomId: host.crypto.identity.roomId,
      relayUrl: "wss://relay.example/ws",
      desktopName: host.crypto.identity.desktopName,
      serviceOrigin: "https://relay.example",
      relayEndpoints: [
        { id: "public", kind: "public-relay", url: "wss://relay.example/ws", priority: 10 },
        { id: "lan", kind: "lan-relay", url: "ws://192.168.1.32:8788/ws", priority: 20 },
      ],
      activeEndpoint: "public",
      iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
      now: 1_000,
    });
    const legacyEncoded = toBase64Url(utf8(JSON.stringify(pairing)));
    const encoded = encodePairingBundle(pairing);
    const wireValue = JSON.parse(decodeUtf8(fromBase64Url(encoded))) as unknown[];

    expect(wireValue[0]).toBe("b3");
    expect(encoded.length).toBeLessThan(500);
    expect(encoded.length).toBeLessThan(legacyEncoded.length * 0.65);
    expect(decodePairingBundle(encoded)).toEqual(pairing);
  });

  it("rejects malformed compact pairing payloads", () => {
    const malformed = toBase64Url(utf8(JSON.stringify(["b3", "room"])));
    expect(() => decodePairingBundle(malformed)).toThrow("Invalid pairing bundle");
  });

  it("normalizes a 0.2 pairing bundle without rotating its device secret", () => {
    const legacy = {
      version: 2,
      roomId: "legacy-room-12345678",
      deviceId: "legacy-phone",
      secret: "legacy-secret",
      relayUrl: "ws://192.168.1.32:8788/ws",
      desktopName: "Legacy Mac",
      createdAt: 1_000,
      expiresAt: 601_000,
      singleUse: true,
    };
    const normalized = decodePairingBundle(toBase64Url(utf8(JSON.stringify(legacy))));

    expect(normalized).toMatchObject({
      version: 3,
      protocolVersion: 2,
      roomId: legacy.roomId,
      deviceId: legacy.deviceId,
      secret: legacy.secret,
      activeEndpoint: "legacy",
      relayUrl: legacy.relayUrl,
      iceServers: [],
    });
    expect(normalized.relayEndpoints).toEqual([
      expect.objectContaining({ kind: "lan-relay", url: legacy.relayUrl }),
    ]);
  });

  it("accepts authenticated Claude Desktop lifecycle requests", () => {
    for (const method of [
      "claude.desktop.status",
      "claude.desktop.launch",
      "claude.desktop.quit",
    ] as const) {
      expect(isBridgePayload({
        kind: "request",
        requestId: `request:${method}`,
        idempotencyKey: `idempotency:${method}`,
        method,
        params: {},
      })).toBe(true);
    }
  });

  it("validates encrypted WebRTC signaling payloads", () => {
    expect(isBridgePayload({
      kind: "peer-signal",
      connectionId: "peer-1",
      action: "offer",
      description: { type: "offer", sdp: "v=0" },
    })).toBe(true);
    expect(isBridgePayload({
      kind: "peer-signal",
      connectionId: "peer-1",
      action: "candidate",
      candidate: { candidate: "candidate:1", sdpMLineIndex: 0 },
    })).toBe(true);
    expect(isBridgePayload({
      kind: "peer-signal",
      connectionId: "peer-1",
      action: "offer",
      description: { type: "answer", sdp: "v=0" },
    })).toBe(false);
  });
});
