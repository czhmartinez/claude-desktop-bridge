export const PROTOCOL_VERSION = 1 as const;

export type BridgeRole = "desktop" | "mobile" | "agent";
export type MessageTarget = Exclude<BridgeRole, "desktop"> | "desktop";

export interface PairingBundle {
  version: typeof PROTOCOL_VERSION;
  roomId: string;
  secret: string;
  relayUrl: string;
  desktopName: string;
  createdAt: number;
}

export interface StoredIdentity {
  version: typeof PROTOCOL_VERSION;
  roomId: string;
  relayUrl: string;
  desktopName: string;
  deviceId: string;
  authToken: string;
}

export type StatusLevel = "info" | "success" | "warning" | "error";

export interface StatusPayload {
  kind: "status";
  message: string;
  progress?: number;
  step?: string;
  level?: StatusLevel;
  sessionId?: string;
}

export interface CommandPayload {
  kind: "command";
  text: string;
  sessionId?: string;
}

export interface CompletionPayload {
  kind: "completion";
  summary: string;
  sessionId?: string;
}

export interface ClaudeSessionInfo {
  sessionId: string;
  desktopSessionId?: string;
  title: string;
  projectName: string;
  state: "running" | "idle";
  lastActivityAt: number;
  completedTasks?: number;
  totalTasks?: number;
  currentTask?: string;
}

export interface SessionsPayload {
  kind: "sessions";
  sessions: ClaudeSessionInfo[];
}

export type ClaudeHistoryRole = "user" | "assistant";

export interface ClaudeHistoryMessage {
  id: string;
  role: ClaudeHistoryRole;
  text: string;
  createdAt: number;
}

export interface HistoryRequestPayload {
  kind: "history-request";
  sessionId: string;
}

export interface HistoryPayload {
  kind: "history";
  sessionId: string;
  messages: ClaudeHistoryMessage[];
  syncedAt: number;
  available: boolean;
  truncated: boolean;
}

export interface SystemPayload {
  kind: "system";
  event: "paired" | "connector-ready";
  message: string;
}

export type BridgePayload =
  | StatusPayload
  | CommandPayload
  | CompletionPayload
  | SessionsPayload
  | HistoryRequestPayload
  | HistoryPayload
  | SystemPayload;

export interface EnvelopeHeader {
  version: typeof PROTOCOL_VERSION;
  id: string;
  roomId: string;
  from: BridgeRole;
  fromDeviceId: string;
  to: MessageTarget;
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

export type ClientFrame = ClientHello | ClientEnvelopeMessage | ClientAck | ClientPing;

export interface ServerReady {
  type: "ready";
  connectionId: string;
  queued: number;
  online: BridgeRole[];
}

export interface ServerEnvelopeMessage {
  type: "envelope";
  envelope: EncryptedEnvelope;
}

export interface ServerPresence {
  type: "presence";
  role: BridgeRole;
  online: boolean;
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
  | ServerError
  | ServerPong;

export interface DecryptedEnvelope {
  header: EnvelopeHeader;
  payload: BridgePayload;
}
