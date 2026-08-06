import type { EncryptedEnvelope } from "@bridge/protocol";
import { describe, expect, it } from "vitest";
import { isReplayableMobileEnvelope } from "./outbox.js";

const now = 1_750_000_000_000;
const identity = { roomId: "room-1", deviceId: "phone-1" };

function envelope(overrides: Partial<EncryptedEnvelope> = {}): EncryptedEnvelope {
  return {
    version: 3,
    id: "envelope-1",
    roomId: identity.roomId,
    from: "mobile",
    fromDeviceId: identity.deviceId,
    to: "desktop",
    sentAt: now,
    expiresAt: now + 60_000,
    nonce: "nonce",
    ciphertext: "ciphertext",
    ...overrides,
  };
}

describe("isReplayableMobileEnvelope", () => {
  it("accepts a current envelope addressed to the desktop", () => {
    expect(isReplayableMobileEnvelope(envelope(), identity, now)).toBe(true);
  });

  it("rejects envelopes from another device or an expired queue entry", () => {
    expect(isReplayableMobileEnvelope(envelope({ fromDeviceId: "old-phone" }), identity, now)).toBe(false);
    expect(isReplayableMobileEnvelope(envelope({ expiresAt: now }), identity, now)).toBe(false);
  });
});
