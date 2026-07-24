import type { BridgeIceServer } from "./types.js";

function isIceUrl(value: unknown): value is string {
  return typeof value === "string" && /^(?:stun|stuns|turn|turns):\S+$/iu.test(value);
}

export function isBridgeIceServer(value: unknown): value is BridgeIceServer {
  if (!value || typeof value !== "object") return false;
  const server = value as Partial<BridgeIceServer>;
  const urls = typeof server.urls === "string"
    ? [server.urls]
    : Array.isArray(server.urls)
      ? server.urls
      : [];
  return (
    urls.length > 0 &&
    urls.length <= 16 &&
    urls.every(isIceUrl) &&
    (server.username === undefined || (
      typeof server.username === "string" && server.username.length <= 512
    )) &&
    (server.credential === undefined || (
      typeof server.credential === "string" && server.credential.length <= 2_048
    ))
  );
}

export function normalizeBridgeIceServers(value: unknown): BridgeIceServer[] {
  if (!Array.isArray(value)) return [];
  const servers = new Map<string, BridgeIceServer>();
  for (const candidate of value) {
    const normalized = typeof candidate === "string" ? { urls: candidate } : candidate;
    if (!isBridgeIceServer(normalized)) continue;
    const server: BridgeIceServer = {
      urls: Array.isArray(normalized.urls) ? [...normalized.urls] : normalized.urls,
      ...(normalized.username !== undefined ? { username: normalized.username } : {}),
      ...(normalized.credential !== undefined ? { credential: normalized.credential } : {}),
    };
    servers.set(JSON.stringify(server), server);
  }
  return [...servers.values()];
}

export function parseBridgeIceServers(value: string | undefined): BridgeIceServer[] {
  const raw = value?.trim();
  if (!raw) return [];
  try {
    return normalizeBridgeIceServers(JSON.parse(raw));
  } catch {
    return normalizeBridgeIceServers(raw.split(",").map((url) => url.trim()).filter(Boolean));
  }
}

export function bridgeIceServers(value: readonly BridgeIceServer[] | undefined): RTCIceServer[] {
  return normalizeBridgeIceServers(value);
}
