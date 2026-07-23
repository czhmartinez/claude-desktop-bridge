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
  PROTOCOL_VERSION,
  type BridgePayload,
  type BridgeRole,
  type DecryptedEnvelope,
  type EncryptedEnvelope,
  type EnvelopeHeader,
  type MessageTarget,
  type PairingBundle,
  type StoredIdentity,
} from "./types.js";

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

async function deriveKeyMaterial(secret: Uint8Array<ArrayBuffer>, roomId: string): Promise<{
  encryptionKey: CryptoKey;
  authToken: string;
}> {
  const baseKey = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey", "deriveBits"]);
  const salt = utf8(`claude-bridge/v1/${roomId}`);
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

  static async createDesktop(
    relayUrl: string,
    desktopName: string,
  ): Promise<{ crypto: BridgeCrypto; pairing: PairingBundle }> {
    const secret = randomBytes(32);
    const roomId = randomId(18);
    const deviceId = randomId(12);
    const { encryptionKey, authToken } = await deriveKeyMaterial(secret, roomId);
    const pairing: PairingBundle = {
      version: PROTOCOL_VERSION,
      roomId,
      secret: toBase64Url(secret),
      relayUrl,
      desktopName,
      createdAt: Date.now(),
    };
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
      pairing,
    };
  }

  static async fromPairing(pairing: PairingBundle, deviceId = randomId(12)): Promise<BridgeCrypto> {
    if (pairing.version !== PROTOCOL_VERSION) throw new Error("Unsupported pairing version");
    const secret = fromBase64Url(pairing.secret);
    if (secret.byteLength !== 32) throw new Error("Invalid pairing secret");
    const { encryptionKey, authToken } = await deriveKeyMaterial(secret, pairing.roomId);
    return new BridgeCrypto({
      encryptionKey,
      identity: {
        version: PROTOCOL_VERSION,
        roomId: pairing.roomId,
        relayUrl: pairing.relayUrl,
        desktopName: pairing.desktopName,
        deviceId,
        authToken,
      },
    });
  }

  async encrypt(
    payload: BridgePayload,
    from: BridgeRole,
    to: MessageTarget,
    now = Date.now(),
    ttlMs = DEFAULT_TTL_MS,
  ): Promise<EncryptedEnvelope> {
    const header: EnvelopeHeader = {
      version: PROTOCOL_VERSION,
      id: randomId(),
      roomId: this.identity.roomId,
      from,
      fromDeviceId: this.identity.deviceId,
      to,
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
  return toBase64Url(utf8(JSON.stringify(pairing)));
}

export function decodePairingBundle(value: string): PairingBundle {
  const parsed = JSON.parse(decodeUtf8(fromBase64Url(value))) as Partial<PairingBundle>;
  if (
    parsed.version !== PROTOCOL_VERSION ||
    typeof parsed.roomId !== "string" ||
    typeof parsed.secret !== "string" ||
    typeof parsed.relayUrl !== "string" ||
    typeof parsed.desktopName !== "string" ||
    typeof parsed.createdAt !== "number"
  ) {
    throw new Error("Invalid pairing bundle");
  }
  return parsed as PairingBundle;
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
