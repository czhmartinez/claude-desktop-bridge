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
    typeof value.sentAt === "number" && Number.isFinite(value.sentAt) &&
    typeof value.expiresAt === "number" && Number.isFinite(value.expiresAt) &&
    typeof value.nonce === "string" && value.nonce.length <= 32 &&
    typeof value.ciphertext === "string" && value.ciphertext.length <= 100_000
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
      typeof value.authToken !== "string"
    ) throw new Error("Invalid hello frame");
    return value as unknown as ClientFrame;
  }
  if (value.type === "envelope" && isEncryptedEnvelope(value.envelope)) {
    return value as unknown as ClientFrame;
  }
  if (value.type === "ack" && Array.isArray(value.ids) && value.ids.every((id) => typeof id === "string")) {
    return value as unknown as ClientFrame;
  }
  if (value.type === "ping" && typeof value.at === "number") return value as unknown as ClientFrame;
  throw new Error("Unsupported frame");
}

export function parseServerFrame(input: string): ServerFrame {
  const value: unknown = JSON.parse(input);
  if (!isRecord(value) || typeof value.type !== "string") throw new Error("Invalid server frame");
  if (value.type === "envelope" && isEncryptedEnvelope(value.envelope)) return value as unknown as ServerFrame;
  if (value.type === "ready" || value.type === "presence" || value.type === "error" || value.type === "pong") {
    return value as unknown as ServerFrame;
  }
  throw new Error("Unsupported server frame");
}

export function isBridgePayload(value: unknown): value is BridgePayload {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  if (value.kind === "command") return typeof value.text === "string";
  if (value.kind === "completion") return typeof value.summary === "string";
  if (value.kind === "sessions") {
    return Array.isArray(value.sessions) && value.sessions.every((session) => (
      isRecord(session) &&
      typeof session.sessionId === "string" &&
      typeof session.title === "string" &&
      typeof session.projectName === "string" &&
      (session.state === "running" || session.state === "idle") &&
      typeof session.lastActivityAt === "number"
    ));
  }
  if (value.kind === "history-request") return typeof value.sessionId === "string";
  if (value.kind === "history") {
    return (
      typeof value.sessionId === "string" &&
      typeof value.syncedAt === "number" &&
      typeof value.available === "boolean" &&
      typeof value.truncated === "boolean" &&
      Array.isArray(value.messages) &&
      value.messages.every((message) => (
        isRecord(message) &&
        typeof message.id === "string" &&
        (message.role === "user" || message.role === "assistant") &&
        typeof message.text === "string" &&
        typeof message.createdAt === "number"
      ))
    );
  }
  if (value.kind === "system") return typeof value.event === "string" && typeof value.message === "string";
  if (value.kind === "status") return typeof value.message === "string";
  return false;
}
