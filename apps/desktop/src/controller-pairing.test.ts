import { describe, expect, it } from "vitest";
import type { LoadedDeviceConfig } from "./config.js";
import { acceptsRelayDevice } from "./controller.js";

function device(overrides: Partial<LoadedDeviceConfig> = {}): LoadedDeviceConfig {
  return {
    deviceId: "phone-1",
    name: "Android 手机",
    platform: "android",
    secret: "secret",
    createdAt: 1,
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

describe("Relay pairing admission", () => {
  it("accepts pending and paired devices only while their local key exists", () => {
    expect(acceptsRelayDevice([device()], "phone-1", true)).toBe(true);
    expect(acceptsRelayDevice([device({ pairedAt: 2 })], "phone-1", true)).toBe(true);
    expect(acceptsRelayDevice([device()], "phone-1", false)).toBe(false);
  });

  it("rejects stale Relay claims and locally revoked devices", () => {
    expect(acceptsRelayDevice([device()], "stale-phone", true)).toBe(false);
    expect(acceptsRelayDevice([device({ revokedAt: 3 })], "phone-1", true)).toBe(false);
  });
});
