const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function utf8(value: string): Uint8Array<ArrayBuffer> {
  return textEncoder.encode(value);
}

export function decodeUtf8(value: ArrayBuffer | Uint8Array): string {
  return textDecoder.decode(value);
}

export function toBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(length));
}

export function randomId(byteLength = 16): string {
  return toBase64Url(randomBytes(byteLength));
}

export function serializeHeader(header: {
  version: number;
  id: string;
  roomId: string;
  from: string;
  fromDeviceId: string;
  to: string;
  sentAt: number;
  expiresAt: number;
}): Uint8Array<ArrayBuffer> {
  return utf8([
    header.version,
    header.id,
    header.roomId,
    header.from,
    header.fromDeviceId,
    header.to,
    header.sentAt,
    header.expiresAt,
  ].join("\u001f"));
}
