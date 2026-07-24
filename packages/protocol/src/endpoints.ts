import type { BridgeEndpoint, BridgeEndpointKind } from "./types.js";

function isPrivateIpv4(hostname: string): boolean {
  const octets = hostname.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) return false;
  const [first, second] = octets;
  return (
    first === 10 ||
    (first === 172 && second! >= 16 && second! <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254) ||
    (first === 100 && second! >= 64 && second! <= 127)
  );
}

export function relayPathForUrl(value: string): Extract<BridgeEndpointKind, "public-relay" | "lan-relay"> {
  try {
    const url = new URL(value);
    const local = (
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]" ||
      isPrivateIpv4(url.hostname)
    );
    return local ? "lan-relay" : "public-relay";
  } catch {
    return "lan-relay";
  }
}

export function bridgeEndpoint(
  url: string,
  priority: number,
  id = relayPathForUrl(url) === "public-relay" ? "public" : "lan",
): BridgeEndpoint {
  return {
    id,
    kind: relayPathForUrl(url),
    url,
    priority,
  };
}

export function isBridgeEndpoint(value: unknown): value is BridgeEndpoint {
  if (!value || typeof value !== "object") return false;
  const endpoint = value as Partial<BridgeEndpoint>;
  if (
    typeof endpoint.id !== "string" ||
    !["public-relay", "lan-relay", "direct"].includes(String(endpoint.kind)) ||
    typeof endpoint.url !== "string" ||
    typeof endpoint.priority !== "number" ||
    !Number.isFinite(endpoint.priority)
  ) return false;
  if (endpoint.kind === "direct") return true;
  try {
    const protocol = new URL(endpoint.url).protocol;
    return protocol === "ws:" || protocol === "wss:";
  } catch {
    return false;
  }
}

export function normalizeBridgeEndpoints(endpoints: BridgeEndpoint[]): BridgeEndpoint[] {
  const byUrl = new Map<string, BridgeEndpoint>();
  for (const endpoint of endpoints.filter(isBridgeEndpoint)) {
    const previous = byUrl.get(endpoint.url);
    if (!previous || endpoint.priority < previous.priority) byUrl.set(endpoint.url, endpoint);
  }
  return [...byUrl.values()].sort((left, right) => (
    left.priority - right.priority || left.id.localeCompare(right.id)
  ));
}

export function selectBridgeEndpoint(
  endpoints: BridgeEndpoint[],
  activeEndpoint?: string,
): BridgeEndpoint | undefined {
  const normalized = normalizeBridgeEndpoints(endpoints);
  return normalized.find((endpoint) => endpoint.id === activeEndpoint) ?? normalized[0];
}
