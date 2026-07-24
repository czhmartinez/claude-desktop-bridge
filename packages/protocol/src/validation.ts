import {
  PROTOCOL_VERSION,
  MAX_ENVELOPE_CHUNKS,
  type BridgePayload,
  type BridgeRole,
  type ClientFrame,
  type EncryptedEnvelopeChunk,
  type EncryptedEnvelope,
  type EnvelopeChunkManifest,
  type MessageTarget,
  type ServerFrame,
} from "./types.js";

const ROLES = new Set<BridgeRole>(["desktop", "mobile", "agent"]);
const TARGETS = new Set<MessageTarget>(["desktop", "mobile", "agent"]);
const METHODS = new Set([
  "project.list",
  "session.list",
  "session.open",
  "session.create",
  "session.history",
  "session.configuration",
  "session.configure",
  "session.fallback.confirm",
  "message.delivery.resolve",
  "claude.desktop.status",
  "claude.desktop.launch",
  "claude.desktop.quit",
  "turn.start",
  "turn.steer",
  "turn.interrupt",
  "permission.resolve",
  "events.resume",
  "device.revoke",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isBridgeRole(value: unknown): value is BridgeRole {
  return typeof value === "string" && ROLES.has(value as BridgeRole);
}

export function isEncryptedEnvelope(value: unknown): value is EncryptedEnvelope {
  if (!isRecord(value)) return false;
  return (
    value.version === PROTOCOL_VERSION &&
    typeof value.id === "string" && value.id.length <= 64 &&
    typeof value.roomId === "string" && value.roomId.length <= 64 &&
    isBridgeRole(value.from) &&
    typeof value.fromDeviceId === "string" && value.fromDeviceId.length <= 64 &&
    typeof value.to === "string" && TARGETS.has(value.to as MessageTarget) &&
    (value.toDeviceId === undefined || (typeof value.toDeviceId === "string" && value.toDeviceId.length <= 64)) &&
    typeof value.sentAt === "number" && Number.isFinite(value.sentAt) &&
    typeof value.expiresAt === "number" && Number.isFinite(value.expiresAt) &&
    typeof value.nonce === "string" && value.nonce.length <= 32 &&
    typeof value.ciphertext === "string" && value.ciphertext.length <= 16_000_000
  );
}

export function isEncryptedEnvelopeChunk(value: unknown): value is EncryptedEnvelopeChunk {
  if (!isRecord(value)) return false;
  return (
    value.version === PROTOCOL_VERSION &&
    typeof value.transferId === "string" && value.transferId.length > 0 && value.transferId.length <= 64 &&
    typeof value.roomId === "string" && value.roomId.length <= 64 &&
    isBridgeRole(value.from) &&
    typeof value.fromDeviceId === "string" && value.fromDeviceId.length <= 64 &&
    typeof value.to === "string" && TARGETS.has(value.to as MessageTarget) &&
    (value.toDeviceId === undefined || (typeof value.toDeviceId === "string" && value.toDeviceId.length <= 64)) &&
    typeof value.sentAt === "number" && Number.isFinite(value.sentAt) &&
    typeof value.expiresAt === "number" && Number.isFinite(value.expiresAt) &&
    typeof value.index === "number" && Number.isInteger(value.index) && value.index >= 0 &&
    typeof value.total === "number" &&
    Number.isInteger(value.total) &&
    value.total > 1 &&
    value.total <= MAX_ENVELOPE_CHUNKS &&
    value.index < value.total &&
    typeof value.sha256 === "string" && /^[A-Za-z0-9_-]{43}$/u.test(value.sha256) &&
    typeof value.data === "string" && value.data.length > 0 && value.data.length <= 524_288
  );
}

export function isEnvelopeChunkManifest(value: unknown): value is EnvelopeChunkManifest {
  if (!isRecord(value)) return false;
  return (
    value.version === PROTOCOL_VERSION &&
    typeof value.transferId === "string" && value.transferId.length > 0 && value.transferId.length <= 64 &&
    typeof value.roomId === "string" && value.roomId.length <= 64 &&
    isBridgeRole(value.from) &&
    typeof value.fromDeviceId === "string" && value.fromDeviceId.length <= 64 &&
    typeof value.to === "string" && TARGETS.has(value.to as MessageTarget) &&
    (value.toDeviceId === undefined || (typeof value.toDeviceId === "string" && value.toDeviceId.length <= 64)) &&
    typeof value.sentAt === "number" && Number.isFinite(value.sentAt) &&
    typeof value.expiresAt === "number" && Number.isFinite(value.expiresAt) &&
    typeof value.total === "number" &&
    Number.isInteger(value.total) &&
    value.total > 1 &&
    value.total <= MAX_ENVELOPE_CHUNKS &&
    typeof value.sha256 === "string" && /^[A-Za-z0-9_-]{43}$/u.test(value.sha256)
  );
}

export function parseClientFrame(input: string): ClientFrame {
  const value: unknown = JSON.parse(input);
  if (!isRecord(value) || typeof value.type !== "string") throw new Error("Invalid frame");
  if (value.type === "hello") {
    if (
      value.version !== PROTOCOL_VERSION ||
      typeof value.roomId !== "string" ||
      !isBridgeRole(value.role) ||
      typeof value.deviceId !== "string" ||
      (value.instanceId !== undefined && typeof value.instanceId !== "string") ||
      typeof value.authToken !== "string"
    ) throw new Error("Invalid hello frame");
    return value as unknown as ClientFrame;
  }
  if (value.type === "envelope" && isEncryptedEnvelope(value.envelope)) {
    return value as unknown as ClientFrame;
  }
  if (value.type === "envelope-chunk" && isEncryptedEnvelopeChunk(value.chunk)) {
    return value as unknown as ClientFrame;
  }
  if (value.type === "chunk-query" && isEnvelopeChunkManifest(value.manifest)) {
    return value as unknown as ClientFrame;
  }
  if (
    value.type === "ack" &&
    Array.isArray(value.ids) &&
    value.ids.length <= 100 &&
    value.ids.every((id) => typeof id === "string" && id.length <= 64)
  ) {
    return value as unknown as ClientFrame;
  }
  if (value.type === "ping" && typeof value.at === "number") return value as unknown as ClientFrame;
  if (
    value.type === "device-register" &&
    typeof value.deviceId === "string" &&
    typeof value.authToken === "string" &&
    typeof value.expiresAt === "number" &&
    (value.migrate === undefined || typeof value.migrate === "boolean") &&
    (value.pairedAt === undefined || typeof value.pairedAt === "number")
  ) return value as unknown as ClientFrame;
  if (value.type === "device-revoke" && typeof value.deviceId === "string") {
    return value as unknown as ClientFrame;
  }
  if (
    value.type === "push-register" &&
    (value.platform === "android" || value.platform === "ios") &&
    typeof value.pushToken === "string" &&
    value.pushToken.length >= 16 &&
    value.pushToken.length <= 4_096
  ) return value as unknown as ClientFrame;
  throw new Error("Unsupported frame");
}

export function parseServerFrame(input: string): ServerFrame {
  const value: unknown = JSON.parse(input);
  if (!isRecord(value) || typeof value.type !== "string") throw new Error("Invalid server frame");
  if (value.type === "envelope" && isEncryptedEnvelope(value.envelope)) return value as unknown as ServerFrame;
  if (value.type === "envelope-chunk" && isEncryptedEnvelopeChunk(value.chunk)) {
    return value as unknown as ServerFrame;
  }
  if (
    value.type === "chunk-missing" &&
    typeof value.transferId === "string" &&
    value.transferId.length <= 64 &&
    Array.isArray(value.indexes) &&
    value.indexes.length <= MAX_ENVELOPE_CHUNKS &&
    value.indexes.every((index) => (
      typeof index === "number" &&
      Number.isInteger(index) &&
      index >= 0 &&
      index < MAX_ENVELOPE_CHUNKS
    ))
  ) return value as unknown as ServerFrame;
  if (
    value.type === "ready" ||
    value.type === "presence" ||
    value.type === "device-registered" ||
    value.type === "device-revoked" ||
    value.type === "acknowledged" ||
    value.type === "stored" ||
    value.type === "error" ||
    value.type === "pong"
  ) return value as unknown as ServerFrame;
  throw new Error("Unsupported server frame");
}

export function isBridgePayload(value: unknown): value is BridgePayload {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "request") {
    return (
      typeof value.requestId === "string" &&
      typeof value.idempotencyKey === "string" &&
      typeof value.method === "string" &&
      METHODS.has(value.method) &&
      isRecord(value.params)
    );
  }
  if (value.kind === "response") {
    return typeof value.requestId === "string" && typeof value.ok === "boolean";
  }
  if (value.kind === "event") {
    return isRecord(value.event) && typeof value.event.eventId === "string" && typeof value.event.seq === "number";
  }
  if (value.kind === "snapshot") {
    return isRecord(value.snapshot) && isRecord(value.snapshot.host) && Array.isArray(value.snapshot.sessions);
  }
  if (value.kind === "peer-signal") {
    if (
      typeof value.connectionId !== "string" ||
      value.connectionId.length === 0 ||
      value.connectionId.length > 64 ||
      !["offer", "answer", "candidate", "end-of-candidates", "ack", "bye"].includes(
        String(value.action),
      )
    ) return false;
    if (value.action === "offer" || value.action === "answer") {
      return (
        isRecord(value.description) &&
        value.description.type === value.action &&
        typeof value.description.sdp === "string" &&
        value.description.sdp.length <= 1_000_000
      );
    }
    if (value.action === "candidate") {
      return (
        isRecord(value.candidate) &&
        typeof value.candidate.candidate === "string" &&
        value.candidate.candidate.length <= 8_192 &&
        (
          value.candidate.sdpMid === undefined ||
          value.candidate.sdpMid === null ||
          typeof value.candidate.sdpMid === "string"
        ) &&
        (
          value.candidate.sdpMLineIndex === undefined ||
          value.candidate.sdpMLineIndex === null ||
          (
            typeof value.candidate.sdpMLineIndex === "number" &&
            Number.isInteger(value.candidate.sdpMLineIndex)
          )
        )
      );
    }
    if (value.action === "ack") {
      return (
        Array.isArray(value.ids) &&
        value.ids.length <= 100 &&
        value.ids.every((id) => typeof id === "string" && id.length <= 64)
      );
    }
    return true;
  }
  return false;
}
