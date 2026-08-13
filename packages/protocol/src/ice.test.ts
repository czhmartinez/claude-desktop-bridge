import { describe, expect, it } from "vitest";
import {
  DEFAULT_BRIDGE_ICE_SERVERS,
  DEFAULT_BRIDGE_ICE_SERVERS_JSON,
  isLegacyCloudflareIceServers,
  preferredBridgeIceServers,
} from "./index.js";

describe("Bridge ICE defaults", () => {
  it("prefers the self-hosted STUN server and retains Cloudflare as a fallback", () => {
    expect(DEFAULT_BRIDGE_ICE_SERVERS).toEqual([
      { urls: "stun:stun.alioxis.com:3478" },
      { urls: "stun:stun.cloudflare.com:3478" },
    ]);
    expect(JSON.parse(DEFAULT_BRIDGE_ICE_SERVERS_JSON)).toEqual(DEFAULT_BRIDGE_ICE_SERVERS);
  });

  it("does not add TURN credentials or TURN URLs to the packaged default", () => {
    expect(DEFAULT_BRIDGE_ICE_SERVERS.every((server) => {
      const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
      return (
        !("username" in server) &&
        !("credential" in server) &&
        urls.every((url) => !/^turns?:/iu.test(url))
      );
    })).toBe(true);
  });

  it("smoothly upgrades only the historical Cloudflare-only default", () => {
    const legacy = [{ urls: "stun:stun.cloudflare.com:3478" }];
    const custom = [{ urls: "stun:stun.example.net:3478" }];

    expect(isLegacyCloudflareIceServers(legacy)).toBe(true);
    expect(preferredBridgeIceServers(legacy)).toEqual(DEFAULT_BRIDGE_ICE_SERVERS);
    expect(preferredBridgeIceServers(custom)).toEqual(custom);
  });
});
