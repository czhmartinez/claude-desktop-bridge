import { describe, expect, it } from "vitest";
import {
  BridgeCrypto,
  buildPairingUrl,
  decodePairingBundle,
  encodePairingBundle,
  pairingBundleFromUrl,
} from "./crypto.js";

describe("BridgeCrypto", () => {
  it("pairs two devices and exchanges authenticated ciphertext", async () => {
    const { crypto: desktop, pairing } = await BridgeCrypto.createDesktop("ws://localhost:8788/ws", "Studio Mac");
    const mobile = await BridgeCrypto.fromPairing(pairing, "phone-1");
    const envelope = await desktop.encrypt(
      { kind: "status", message: "Tests are green", progress: 100, level: "success" },
      "agent",
      "mobile",
    );

    expect(envelope.ciphertext).not.toContain("Tests are green");
    const result = await mobile.decrypt(envelope);
    expect(result.payload).toEqual({ kind: "status", message: "Tests are green", progress: 100, level: "success" });
    expect(mobile.identity.authToken).toBe(desktop.identity.authToken);
  });

  it("rejects tampered metadata", async () => {
    const { crypto: desktop, pairing } = await BridgeCrypto.createDesktop("ws://localhost:8788/ws", "Studio Mac");
    const mobile = await BridgeCrypto.fromPairing(pairing);
    const envelope = await desktop.encrypt({ kind: "command", text: "continue" }, "mobile", "agent");

    await expect(mobile.decrypt({ ...envelope, to: "desktop" })).rejects.toThrow();
  });

  it("round-trips the URL-safe pairing bundle", async () => {
    const { pairing } = await BridgeCrypto.createDesktop("wss://relay.example/ws", "Workstation");
    const encoded = encodePairingBundle(pairing);
    expect(encoded).not.toMatch(/[+/=]/u);
    expect(decodePairingBundle(encoded)).toEqual(pairing);
    const url = buildPairingUrl("https://bridge.example/app?source=desktop", pairing);
    expect(new URL(url).searchParams.get("source")).toBe("desktop");
    expect(pairingBundleFromUrl(url)).toEqual(pairing);
  });

  it("round-trips selectable sessions and a session-targeted command", async () => {
    const { crypto: desktop, pairing } = await BridgeCrypto.createDesktop("ws://localhost:8788/ws", "Studio Mac");
    const mobile = await BridgeCrypto.fromPairing(pairing, "phone-1");
    const sessions = await desktop.encrypt({
      kind: "sessions",
      sessions: [{
        sessionId: "session-history",
        desktopSessionId: "local_history",
        title: "历史经营分析",
        projectName: "analysis",
        state: "idle",
        lastActivityAt: 1_784_710_000_000,
      }],
    }, "desktop", "mobile");
    const command = await mobile.encrypt({
      kind: "command",
      text: "继续这个会话",
      sessionId: "session-history",
    }, "mobile", "desktop");

    expect((await mobile.decrypt(sessions)).payload).toEqual(expect.objectContaining({ kind: "sessions" }));
    expect((await desktop.decrypt(command)).payload).toEqual({
      kind: "command",
      text: "继续这个会话",
      sessionId: "session-history",
    });
  });

  it("round-trips an on-demand encrypted Claude transcript", async () => {
    const { crypto: desktop, pairing } = await BridgeCrypto.createDesktop("ws://localhost:8788/ws", "Studio Mac");
    const mobile = await BridgeCrypto.fromPairing(pairing, "phone-1");
    const request = await mobile.encrypt({
      kind: "history-request",
      sessionId: "session-history",
    }, "mobile", "desktop");
    const history = await desktop.encrypt({
      kind: "history",
      sessionId: "session-history",
      messages: [
        { id: "user-1", role: "user", text: "继续实现", createdAt: 1_784_710_000_000 },
        { id: "assistant-1", role: "assistant", text: "已经完成。", createdAt: 1_784_710_010_000 },
      ],
      syncedAt: 1_784_710_020_000,
      available: true,
      truncated: false,
    }, "desktop", "mobile");

    expect((await desktop.decrypt(request)).payload).toEqual({ kind: "history-request", sessionId: "session-history" });
    expect((await mobile.decrypt(history)).payload).toEqual(expect.objectContaining({
      kind: "history",
      sessionId: "session-history",
      messages: expect.arrayContaining([expect.objectContaining({ role: "assistant", text: "已经完成。" })]),
    }));
  });
});
