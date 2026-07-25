import {
  decodeUtf8,
  fromBase64Url,
  randomBytes,
  randomId,
  serializeHeader,
  toBase64Url,
  utf8,
} from "./encoding.js";
import {
  bridgeEndpoint,
  isBridgeEndpoint,
  normalizeBridgeEndpoints,
  selectBridgeEndpoint,
} from "./endpoints.js";
import {
  PAIRING_SCHEMA_VERSION,
  PROTOCOL_VERSION,
  type BridgeEndpoint,
  type BridgeIceServer,
  type BridgePayload,
  type BridgeRole,
  type DecryptedEnvelope,
  type EncryptedEnvelope,
  type EnvelopeHeader,
  type MessageTarget,
  type PairingBundle,
  type StoredIdentity,
} from "./types.js";
import { normalizeBridgeIceServers } from "./ice.js";

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PAIRING_TTL_MS = 10 * 60 * 1000;
// Pairing QR codes use this compact tuple; decoding still accepts legacy JSON objects.
const COMPACT_PAIRING_MARKER = "b3";

type CompactEndpointKind = 0 | 1 | 2;
type CompactPairingEndpoint = [
  id: string,
  kind: CompactEndpointKind,
  url: string,
  priority: number,
];
type CompactPairingIceServer = [
  urls: string | string[],
  username?: string | null,
  credential?: string,
];
type CompactPairingBundle = [
  marker: typeof COMPACT_PAIRING_MARKER,
  roomId: string,
  deviceId: string,
  secret: string,
  desktopName: string,
  createdAt: number,
  expiresAt: number,
  serviceOriginOverride: string,
  relayEndpoints: CompactPairingEndpoint[],
  iceServers: CompactPairingIceServer[],
];

function serviceOriginForRelay(relayUrl: string): string {
  try {
    const value = new URL(relayUrl);
    value.protocol = value.protocol === "wss:" ? "https:" : "http:";
    value.pathname = "/";
    value.search = "";
    value.hash = "";
    return value.toString().replace(/\/$/u, "");
  } catch {
    return "";
  }
}

function compactEndpointKind(kind: BridgeEndpoint["kind"]): CompactEndpointKind {
  if (kind === "public-relay") return 0;
  if (kind === "lan-relay") return 1;
  return 2;
}

function expandedEndpointKind(kind: unknown): BridgeEndpoint["kind"] | undefined {
  if (kind === 0) return "public-relay";
  if (kind === 1) return "lan-relay";
  if (kind === 2) return "direct";
  return undefined;
}

function compactPairingBundle(pairing: PairingBundle): CompactPairingBundle {
  const active = selectBridgeEndpoint(pairing.relayEndpoints, pairing.activeEndpoint);
  if (!active) throw new Error("Pairing requires a relay endpoint");
  const endpoints = [
    active,
    ...pairing.relayEndpoints.filter((endpoint) => endpoint.id !== active.id),
  ];
  const derivedServiceOrigin = serviceOriginForRelay(active.url);
  return [
    COMPACT_PAIRING_MARKER,
    pairing.roomId,
    pairing.deviceId,
    pairing.secret,
    pairing.desktopName,
    pairing.createdAt,
    pairing.expiresAt,
    pairing.serviceOrigin === derivedServiceOrigin ? "" : pairing.serviceOrigin,
    endpoints.map((endpoint) => [
      endpoint.id,
      compactEndpointKind(endpoint.kind),
      endpoint.url,
      endpoint.priority,
    ]),
    pairing.iceServers.map((server) => {
      if (server.credential !== undefined) {
        return [server.urls, server.username ?? null, server.credential];
      }
      if (server.username !== undefined) return [server.urls, server.username];
      return [server.urls];
    }),
  ];
}

function expandCompactPairingBundle(value: unknown): unknown {
  if (!Array.isArray(value) || value[0] !== COMPACT_PAIRING_MARKER || value.length !== 10) {
    return value;
  }
  const [
    ,
    roomId,
    deviceId,
    secret,
    desktopName,
    createdAt,
    expiresAt,
    serviceOriginOverride,
    compactEndpoints,
    compactIceServers,
  ] = value;
  if (
    typeof roomId !== "string" ||
    typeof deviceId !== "string" ||
    typeof secret !== "string" ||
    typeof desktopName !== "string" ||
    typeof createdAt !== "number" ||
    typeof expiresAt !== "number" ||
    typeof serviceOriginOverride !== "string" ||
    !Array.isArray(compactEndpoints) ||
    compactEndpoints.length === 0 ||
    !Array.isArray(compactIceServers)
  ) {
    throw new Error("Invalid pairing bundle");
  }
  const relayEndpoints = compactEndpoints.map((candidate): BridgeEndpoint => {
    if (!Array.isArray(candidate) || candidate.length !== 4) {
      throw new Error("Invalid pairing bundle");
    }
    const [id, compactKind, url, priority] = candidate;
    const kind = expandedEndpointKind(compactKind);
    if (
      typeof id !== "string" ||
      !kind ||
      typeof url !== "string" ||
      typeof priority !== "number"
    ) {
      throw new Error("Invalid pairing bundle");
    }
    return { id, kind, url, priority };
  });
  const iceServers = compactIceServers.map((candidate): BridgeIceServer => {
    if (!Array.isArray(candidate) || candidate.length < 1 || candidate.length > 3) {
      throw new Error("Invalid pairing bundle");
    }
    const [urls, username, credential] = candidate;
    if (
      (typeof urls !== "string" && !Array.isArray(urls)) ||
      (username !== undefined && username !== null && typeof username !== "string") ||
      (credential !== undefined && typeof credential !== "string")
    ) {
      throw new Error("Invalid pairing bundle");
    }
    return {
      urls: urls as string | string[],
      ...(typeof username === "string" ? { username } : {}),
      ...(typeof credential === "string" ? { credential } : {}),
    };
  });
  const active = relayEndpoints[0]!;
  return {
    version: PAIRING_SCHEMA_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    roomId,
    deviceId,
    secret,
    relayUrl: active.url,
    serviceOrigin: serviceOriginOverride || serviceOriginForRelay(active.url),
    relayEndpoints,
    activeEndpoint: active.id,
    iceServers,
    desktopName,
    createdAt,
    expiresAt,
    singleUse: true,
  };
}

function pairingEndpoint(
  relayEndpoints: BridgeEndpoint[] | undefined,
  relayUrl: string,
  activeEndpoint: string | undefined,
): { endpoints: BridgeEndpoint[]; active: BridgeEndpoint } {
  const fallback = bridgeEndpoint(
    relayUrl,
    relayEndpoints?.length ? 100 : 10,
    relayEndpoints?.length ? "legacy" : undefined,
  );
  const endpoints = normalizeBridgeEndpoints([
    ...(relayEndpoints ?? []),
    fallback,
  ]);
  const active = selectBridgeEndpoint(endpoints, activeEndpoint);
  if (!active) throw new Error("Pairing requires a relay endpoint");
  return { endpoints, active };
}

async function deriveKeyMaterial(secret: Uint8Array<ArrayBuffer>, roomId: string): Promise<{
  encryptionKey: CryptoKey;
  authToken: string;
}> {
  const baseKey = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey", "deriveBits"]);
  const salt = utf8(`claude-bridge/v2/${roomId}`);
  const encryptionKey = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: utf8("payload-encryption") },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  const authBits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info: utf8("relay-authentication") },
    baseKey,
    256,
  );
  return { encryptionKey, authToken: toBase64Url(new Uint8Array(authBits)) };
}

export interface BridgeCryptoOptions {
  identity: StoredIdentity;
  encryptionKey: CryptoKey;
}

export class BridgeCrypto {
  readonly identity: StoredIdentity;
  readonly encryptionKey: CryptoKey;

  constructor(options: BridgeCryptoOptions) {
    this.identity = options.identity;
    this.encryptionKey = options.encryptionKey;
  }

  // Kept for protocol tests and simple embedded deployments. Production desktop code
  // uses createHost plus createDevicePairing so every phone receives a distinct key.
  static async createDesktop(
    relayUrl: string,
    desktopName: string,
  ): Promise<{ crypto: BridgeCrypto; pairing: PairingBundle }> {
    const host = await BridgeCrypto.createHost(relayUrl, desktopName);
    const device = await BridgeCrypto.createDevicePairing({
      roomId: host.crypto.identity.roomId,
      relayUrl,
      desktopName,
    });
    return {
      crypto: new BridgeCrypto({
        encryptionKey: device.desktopCrypto.encryptionKey,
        identity: {
          ...host.crypto.identity,
          authToken: device.desktopCrypto.identity.authToken,
        },
      }),
      pairing: device.pairing,
    };
  }

  static async createHost(
    relayUrl: string,
    desktopName: string,
  ): Promise<{ crypto: BridgeCrypto; secret: string }> {
    const secret = randomBytes(32);
    const roomId = randomId(18);
    const deviceId = randomId(12);
    const { encryptionKey, authToken } = await deriveKeyMaterial(secret, roomId);
    return {
      crypto: new BridgeCrypto({
        encryptionKey,
        identity: {
          version: PROTOCOL_VERSION,
          roomId,
          relayUrl,
          desktopName,
          deviceId,
          authToken,
        },
      }),
      secret: toBase64Url(secret),
    };
  }

  static async fromHostSecret(options: {
    roomId: string;
    relayUrl: string;
    desktopName: string;
    deviceId: string;
    secret: string;
  }): Promise<BridgeCrypto> {
    const secret = fromBase64Url(options.secret);
    if (secret.byteLength !== 32) throw new Error("Invalid host secret");
    const { encryptionKey, authToken } = await deriveKeyMaterial(secret, options.roomId);
    return new BridgeCrypto({
      encryptionKey,
      identity: {
        version: PROTOCOL_VERSION,
        roomId: options.roomId,
        relayUrl: options.relayUrl,
        desktopName: options.desktopName,
        deviceId: options.deviceId,
        authToken,
      },
    });
  }

  static async createDevicePairing(options: {
    roomId: string;
    relayUrl: string;
    desktopName: string;
    serviceOrigin?: string;
    relayEndpoints?: BridgeEndpoint[];
    activeEndpoint?: string;
    iceServers?: BridgeIceServer[];
    deviceId?: string;
    now?: number;
  }): Promise<{ pairing: PairingBundle; desktopCrypto: BridgeCrypto }> {
    const secret = randomBytes(32);
    const deviceId = options.deviceId ?? randomId(12);
    const createdAt = options.now ?? Date.now();
    const { encryptionKey, authToken } = await deriveKeyMaterial(secret, options.roomId);
    const { endpoints, active } = pairingEndpoint(
      options.relayEndpoints,
      options.relayUrl,
      options.activeEndpoint,
    );
    const pairing: PairingBundle = {
      version: PAIRING_SCHEMA_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      roomId: options.roomId,
      deviceId,
      secret: toBase64Url(secret),
      relayUrl: active.url,
      serviceOrigin: options.serviceOrigin ?? serviceOriginForRelay(active.url),
      relayEndpoints: endpoints,
      activeEndpoint: active.id,
      iceServers: normalizeBridgeIceServers(options.iceServers),
      desktopName: options.desktopName,
      createdAt,
      expiresAt: createdAt + PAIRING_TTL_MS,
      singleUse: true,
    };
    return {
      pairing,
      desktopCrypto: new BridgeCrypto({
        encryptionKey,
        identity: {
          version: PROTOCOL_VERSION,
          roomId: options.roomId,
          relayUrl: options.relayUrl,
          desktopName: options.desktopName,
          deviceId,
          authToken,
        },
      }),
    };
  }

  static async fromPairing(
    pairing: PairingBundle,
    options: string | { deviceId?: string; ignoreExpiry?: boolean; instanceId?: string } = {},
  ): Promise<BridgeCrypto> {
    if (
      pairing.version !== PAIRING_SCHEMA_VERSION ||
      pairing.protocolVersion !== PROTOCOL_VERSION
    ) throw new Error("Unsupported pairing version");
    const normalized = typeof options === "string" ? { deviceId: options, ignoreExpiry: true } : options;
    if (!normalized.ignoreExpiry && pairing.expiresAt <= Date.now()) throw new Error("Pairing code has expired");
    const secret = fromBase64Url(pairing.secret);
    if (secret.byteLength !== 32) throw new Error("Invalid pairing secret");
    const { encryptionKey, authToken } = await deriveKeyMaterial(secret, pairing.roomId);
    const relayUrl = selectBridgeEndpoint(pairing.relayEndpoints, pairing.activeEndpoint)?.url
      ?? pairing.relayUrl;
    return new BridgeCrypto({
      encryptionKey,
      identity: {
        version: PROTOCOL_VERSION,
        roomId: pairing.roomId,
        relayUrl,
        desktopName: pairing.desktopName,
        deviceId: normalized.deviceId ?? pairing.deviceId,
        authToken,
        instanceId: normalized.instanceId ?? randomId(12),
      },
    });
  }

  withSenderDevice(deviceId: string): BridgeCrypto {
    return new BridgeCrypto({
      encryptionKey: this.encryptionKey,
      identity: { ...this.identity, deviceId },
    });
  }

  async encrypt(
    payload: BridgePayload,
    from: BridgeRole,
    to: MessageTarget,
    now = Date.now(),
    ttlMs = DEFAULT_TTL_MS,
    toDeviceId?: string,
  ): Promise<EncryptedEnvelope> {
    const header: EnvelopeHeader = {
      version: PROTOCOL_VERSION,
      id: randomId(),
      roomId: this.identity.roomId,
      from,
      fromDeviceId: this.identity.deviceId,
      to,
      ...(toDeviceId ? { toDeviceId } : {}),
      sentAt: now,
      expiresAt: now + ttlMs,
    };
    const nonce = randomBytes(12);
    const plaintext = utf8(JSON.stringify(payload));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, additionalData: serializeHeader(header), tagLength: 128 },
      this.encryptionKey,
      plaintext,
    );
    return {
      ...header,
      nonce: toBase64Url(nonce),
      ciphertext: toBase64Url(new Uint8Array(ciphertext)),
    };
  }

  async decrypt(envelope: EncryptedEnvelope, now = Date.now()): Promise<DecryptedEnvelope> {
    if (envelope.version !== PROTOCOL_VERSION) throw new Error("Unsupported envelope version");
    if (envelope.roomId !== this.identity.roomId) throw new Error("Envelope belongs to another room");
    if (envelope.toDeviceId && envelope.toDeviceId !== this.identity.deviceId) {
      throw new Error("Envelope belongs to another device");
    }
    if (envelope.expiresAt <= now) throw new Error("Envelope has expired");
    const { nonce, ciphertext, ...header } = envelope;
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: fromBase64Url(nonce),
        additionalData: serializeHeader(header),
        tagLength: 128,
      },
      this.encryptionKey,
      fromBase64Url(ciphertext),
    );
    return { header, payload: JSON.parse(decodeUtf8(plaintext)) as BridgePayload };
  }
}

export function encodePairingBundle(pairing: PairingBundle): string {
  return toBase64Url(utf8(JSON.stringify(compactPairingBundle(pairing))));
}

export function normalizePairingBundle(value: unknown): PairingBundle {
  if (!value || typeof value !== "object") throw new Error("Invalid pairing bundle");
  const parsed = value as {
    version?: unknown;
    protocolVersion?: unknown;
    roomId?: unknown;
    deviceId?: unknown;
    secret?: unknown;
    relayUrl?: unknown;
    serviceOrigin?: unknown;
    relayEndpoints?: unknown;
    activeEndpoint?: unknown;
    iceServers?: unknown;
    desktopName?: unknown;
    createdAt?: unknown;
    expiresAt?: unknown;
    singleUse?: unknown;
  };
  if (
    typeof parsed.roomId !== "string" ||
    typeof parsed.deviceId !== "string" ||
    typeof parsed.secret !== "string" ||
    typeof parsed.relayUrl !== "string" ||
    typeof parsed.desktopName !== "string" ||
    typeof parsed.createdAt !== "number" ||
    typeof parsed.expiresAt !== "number" ||
    parsed.singleUse !== true
  ) {
    throw new Error("Invalid pairing bundle");
  }
  if (parsed.version === PROTOCOL_VERSION) {
    const endpoint = bridgeEndpoint(parsed.relayUrl, 100, "legacy");
    return {
      version: PAIRING_SCHEMA_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      roomId: parsed.roomId,
      deviceId: parsed.deviceId,
      secret: parsed.secret,
      relayUrl: parsed.relayUrl,
      serviceOrigin: serviceOriginForRelay(parsed.relayUrl),
      relayEndpoints: [endpoint],
      activeEndpoint: endpoint.id,
      iceServers: [],
      desktopName: parsed.desktopName,
      createdAt: parsed.createdAt,
      expiresAt: parsed.expiresAt,
      singleUse: true,
    };
  }
  if (
    parsed.version !== PAIRING_SCHEMA_VERSION ||
    parsed.protocolVersion !== PROTOCOL_VERSION ||
    typeof parsed.serviceOrigin !== "string" ||
    !Array.isArray(parsed.relayEndpoints) ||
    !parsed.relayEndpoints.every(isBridgeEndpoint) ||
    typeof parsed.activeEndpoint !== "string"
  ) {
    throw new Error("Invalid pairing bundle");
  }
  const endpoints = normalizeBridgeEndpoints(parsed.relayEndpoints);
  const active = selectBridgeEndpoint(endpoints, parsed.activeEndpoint);
  if (!active) throw new Error("Invalid pairing endpoints");
  return {
    version: PAIRING_SCHEMA_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    roomId: parsed.roomId,
    deviceId: parsed.deviceId,
    secret: parsed.secret,
    relayUrl: active.url,
    serviceOrigin: parsed.serviceOrigin,
    relayEndpoints: endpoints,
    activeEndpoint: active.id,
    iceServers: normalizeBridgeIceServers(parsed.iceServers),
    desktopName: parsed.desktopName,
    createdAt: parsed.createdAt,
    expiresAt: parsed.expiresAt,
    singleUse: true,
  };
}

export function decodePairingBundle(value: string): PairingBundle {
  const decoded = JSON.parse(decodeUtf8(fromBase64Url(value))) as unknown;
  return normalizePairingBundle(expandCompactPairingBundle(decoded));
}

export function buildPairingUrl(baseUrl: string, pairing: PairingBundle): string {
  const base = new URL(baseUrl);
  base.hash = `/pair/${encodePairingBundle(pairing)}`;
  return base.toString();
}

export function pairingBundleFromUrl(value: string): PairingBundle | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  const match = url.hash.match(/^#\/?pair\/([A-Za-z0-9_-]+)$/u);
  if (!match?.[1]) return undefined;
  return decodePairingBundle(match[1]);
}
