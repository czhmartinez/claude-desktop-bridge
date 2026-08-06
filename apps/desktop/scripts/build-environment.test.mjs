import { describe, expect, it } from "vitest";
import { buildEnvironmentValue } from "./build-environment.mjs";

describe("desktop build environment", () => {
  it.each([undefined, "", "   "])("uses the release default for %j", (configured) => {
    expect(buildEnvironmentValue(
      { BRIDGE_RELAY_URL: configured },
      "BRIDGE_RELAY_URL",
      "ws://127.0.0.1:8788/ws",
    )).toBe("ws://127.0.0.1:8788/ws");
  });

  it("trims an explicitly configured release value", () => {
    expect(buildEnvironmentValue(
      { BRIDGE_RELAY_URL: "  wss://relay.example/ws  " },
      "BRIDGE_RELAY_URL",
      "ws://127.0.0.1:8788/ws",
    )).toBe("wss://relay.example/ws");
  });
});
