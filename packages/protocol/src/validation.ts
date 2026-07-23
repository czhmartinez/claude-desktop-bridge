import {
  PROTOCOL_VERSION,
  type BridgePayload,
  type BridgeRole,
  type ClientFrame,
  type EncryptedEnvelope,
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
    typeof value.ciphertext === "string" && value.ciphertext.length <= 8_000_000
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
    typeof value.expiresAt === "number"
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
  return false;
}
