export const PROTOCOL_VERSION = 2 as const;

export type BridgeRole = "desktop" | "mobile" | "agent";
export type MessageTarget = BridgeRole;

export interface PairingBundle {
  version: typeof PROTOCOL_VERSION;
  roomId: string;
  deviceId: string;
  secret: string;
  relayUrl: string;
  desktopName: string;
  createdAt: number;
  expiresAt: number;
  singleUse: true;
}

export interface StoredIdentity {
  version: typeof PROTOCOL_VERSION;
  roomId: string;
  relayUrl: string;
  desktopName: string;
  deviceId: string;
  authToken: string;
  instanceId?: string;
}

export type BridgeOrigin = "desktop" | "mobile" | "claude-desktop" | "claude-host" | "system";
export type BridgeOwnershipState =
  | "DESKTOP_OBSERVED"
  | "ACQUIRING"
  | "BRIDGE_IDLE"
  | "BRIDGE_RUNNING"
  | "RELEASING";
export type BridgeTurnState = "idle" | "queued" | "running" | "waiting" | "completed" | "failed" | "interrupted";
export type BridgeDeliveryState =
  | "local-saved"
  | "relay-received"
  | "host-received"
  | "session-received"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface BridgeAttachment {
  id: string;
  name: string;
  mimeType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  size: number;
  data: string;
}

export interface BridgeProjectInfo {
  projectId: string;
  name: string;
  cwd: string;
  sessionCount: number;
  runningCount: number;
  pendingCount: number;
  lastActivityAt: number;
}

export interface BridgeSessionInfo {
  sessionId: string;
  desktopSessionId?: string;
  projectId: string;
  projectName: string;
  cwd: string;
  title: string;
  source: "desktop" | "bridge";
  ownership: BridgeOwnershipState;
  turnState: BridgeTurnState;
  lastActivityAt: number;
  pendingCount: number;
  activeTurnId?: string;
  currentSummary?: string;
}

export interface BridgeHistoryItem {
  id: string;
  sessionId: string;
  turnId?: string;
  role: "user" | "assistant" | "tool" | "system";
  text: string;
  createdAt: number;
  origin: BridgeOrigin;
  toolName?: string;
  state?: BridgeTurnState;
  attachments?: Array<Omit<BridgeAttachment, "data">>;
}

export interface BridgeHistoryPage {
  sessionId: string;
  items: BridgeHistoryItem[];
  nextCursor?: string;
  hasMore: boolean;
}

// Transcript parsing stays intentionally transport-agnostic.
export interface ClaudeHistoryMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: number;
}

export interface BridgeDeviceInfo {
  deviceId: string;
  name: string;
  platform: "android" | "ios" | "web" | "unknown";
  online: boolean;
  createdAt: number;
  lastSeenAt?: number;
  revokedAt?: number;
}

export interface BridgePermissionInfo {
  requestId: string;
  sessionId: string;
  toolUseId: string;
  toolName: string;
  title?: string;
  displayName?: string;
  description?: string;
  input: Record<string, unknown>;
  createdAt: number;
}

export interface BridgeRuntimeStatus {
  state: "ready" | "working" | "auth-required" | "unavailable";
  detail: string;
  version?: string;
  credentialSource?: "third-party-host";
  activeTurns: number;
  maxParallelTurns: number;
}

export interface BridgeHostSnapshot {
  host: {
    hostId: string;
    name: string;
    relayUrl: string;
    online: boolean;
    lastSeenAt: number;
    version: string;
  };
  projects: BridgeProjectInfo[];
  sessions: BridgeSessionInfo[];
  devices: BridgeDeviceInfo[];
  runtime: BridgeRuntimeStatus;
  permissions: BridgePermissionInfo[];
  latestSeq: number;
}

export interface DesktopControlSnapshot extends BridgeHostSnapshot {
  connection: "idle" | "connecting" | "connected" | "reconnecting" | "closed";
  launchAtLogin: boolean;
  pairingUrl?: string;
  pairingExpiresAt?: number;
}

export type BridgeMethod =
  | "project.list"
  | "session.list"
  | "session.open"
  | "session.create"
  | "session.history"
  | "turn.start"
  | "turn.steer"
  | "turn.interrupt"
  | "permission.resolve"
  | "events.resume"
  | "device.revoke";

export interface BridgeRequest {
  kind: "request";
  requestId: string;
  idempotencyKey: string;
  method: BridgeMethod;
  params: Record<string, unknown>;
}

export interface BridgeResponse {
  kind: "response";
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
}

export type BridgeEventType =
  | "host.presence"
  | "snapshot.updated"
  | "session.created"
  | "session.observed"
  | "session.ownership"
  | "user.message.accepted"
  | "message.delivery"
  | "assistant.delta"
  | "assistant.completed"
  | "tool.started"
  | "tool.progress"
  | "tool.completed"
  | "permission.requested"
  | "permission.resolved"
  | "question.requested"
  | "question.resolved"
  | "turn.queued"
  | "turn.started"
  | "turn.completed"
  | "turn.failed"
  | "turn.interrupted"
  | "device.paired"
  | "device.revoked"
  | "runtime.error";

export interface BridgeEvent {
  eventId: string;
  sessionId?: string;
  turnId?: string;
  itemId?: string;
  seq: number;
  timestamp: number;
  origin: BridgeOrigin;
  type: BridgeEventType;
  data: Record<string, unknown>;
}

export interface BridgeEventPayload {
  kind: "event";
  event: BridgeEvent;
}

export interface BridgeSnapshotPayload {
  kind: "snapshot";
  snapshot: BridgeHostSnapshot;
}

export type BridgePayload =
  | BridgeRequest
  | BridgeResponse
  | BridgeEventPayload
  | BridgeSnapshotPayload;

export interface EnvelopeHeader {
  version: typeof PROTOCOL_VERSION;
  id: string;
  roomId: string;
  from: BridgeRole;
  fromDeviceId: string;
  to: MessageTarget;
  toDeviceId?: string;
  sentAt: number;
  expiresAt: number;
}

export interface EncryptedEnvelope extends EnvelopeHeader {
  nonce: string;
  ciphertext: string;
}

export interface ClientHello {
  type: "hello";
  version: typeof PROTOCOL_VERSION;
  roomId: string;
  role: BridgeRole;
  deviceId: string;
  instanceId?: string;
  authToken: string;
  create?: boolean;
}

export interface ClientEnvelopeMessage {
  type: "envelope";
  envelope: EncryptedEnvelope;
}

export interface ClientAck {
  type: "ack";
  ids: string[];
}

export interface ClientPing {
  type: "ping";
  at: number;
}

export interface ClientDeviceRegister {
  type: "device-register";
  deviceId: string;
  authToken: string;
  expiresAt: number;
}

export interface ClientDeviceRevoke {
  type: "device-revoke";
  deviceId: string;
}

export interface ClientPushRegister {
  type: "push-register";
  platform: "android" | "ios";
  pushToken: string;
}

export type ClientFrame =
  | ClientHello
  | ClientEnvelopeMessage
  | ClientAck
  | ClientPing
  | ClientDeviceRegister
  | ClientDeviceRevoke
  | ClientPushRegister;

export interface OnlineDevice {
  role: BridgeRole;
  deviceId: string;
}

export interface ServerReady {
  type: "ready";
  connectionId: string;
  queued: number;
  online: BridgeRole[];
  onlineDevices: OnlineDevice[];
}

export interface ServerEnvelopeMessage {
  type: "envelope";
  envelope: EncryptedEnvelope;
}

export interface ServerPresence {
  type: "presence";
  role: BridgeRole;
  deviceId: string;
  online: boolean;
}

export interface ServerDeviceRegistered {
  type: "device-registered";
  deviceId: string;
  expiresAt: number;
}

export interface ServerDeviceRevoked {
  type: "device-revoked";
  deviceId: string;
}

export interface ServerAcknowledged {
  type: "acknowledged";
  ids: string[];
  byDeviceId: string;
}

export interface ServerStored {
  type: "stored";
  ids: string[];
}

export interface ServerError {
  type: "error";
  code: string;
  message: string;
}

export interface ServerPong {
  type: "pong";
  at: number;
}

export type ServerFrame =
  | ServerReady
  | ServerEnvelopeMessage
  | ServerPresence
  | ServerDeviceRegistered
  | ServerDeviceRevoked
  | ServerAcknowledged
  | ServerStored
  | ServerError
  | ServerPong;

export interface DecryptedEnvelope {
  header: EnvelopeHeader;
  payload: BridgePayload;
}
