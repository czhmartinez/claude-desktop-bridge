export const PROTOCOL_VERSION = 3 as const;
export const PAIRING_SCHEMA_VERSION = 4 as const;
export const ENVELOPE_CHUNK_BYTES = 64 * 1024;
export const MAX_ENVELOPE_CHUNKS = 384;
export const ARTIFACT_MAX_BYTES = 20 * 1024 * 1024;
export const ARTIFACT_TRANSFER_CHUNK_BYTES = 256 * 1024;
export const ARTIFACT_TRANSFER_TTL_MS = 10 * 60 * 1000;

export type BridgeRole = "desktop" | "mobile" | "agent";
export type MessageTarget = BridgeRole;

export type BridgeEndpointKind = "public-relay" | "lan-relay" | "direct";

export interface BridgeEndpoint {
  id: string;
  kind: BridgeEndpointKind;
  url: string;
  priority: number;
}

export interface BridgeIceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface PairingBundle {
  version: typeof PAIRING_SCHEMA_VERSION;
  protocolVersion: typeof PROTOCOL_VERSION;
  hostId: string;
  pairingEpoch: number;
  roomId: string;
  deviceId: string;
  secret: string;
  // Kept as a compatibility alias for 0.2 clients and exported diagnostics.
  relayUrl: string;
  serviceOrigin: string;
  relayEndpoints: BridgeEndpoint[];
  activeEndpoint: string;
  iceServers: BridgeIceServer[];
  desktopName: string;
  createdAt: number;
  expiresAt: number;
  singleUse: true;
}

export interface LegacyPairingBundle {
  version: number;
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
  version: number;
  hostId?: string;
  pairingEpoch?: number;
  roomId: string;
  relayUrl: string;
  desktopName: string;
  deviceId: string;
  authToken: string;
  instanceId?: string;
}

export type BridgeOrigin =
  | "desktop"
  | "mobile"
  | "claude-desktop"
  | "claude-host"
  | "codex-desktop"
  | "codex-host"
  | "hermes-desktop"
  | "hermes-host"
  | "system";

/**
 * A Desktop runtime owns its own account, native session IDs and transcript.
 * Bridge normalizes the controls around it; it never turns these into one
 * shared conversation domain.
 */
export type BridgeDesktopRuntimeId = "claude-desktop" | "codex-desktop" | "hermes-desktop";
export type BridgeDesktopRuntimeState = "ready" | "starting" | "unavailable" | "error";
export type BridgeRuntimeCapability =
  | "session.list"
  | "session.create"
  | "session.history"
  | "turn.start"
  | "turn.steer"
  | "turn.interrupt"
  | "permission.resolve"
  | "tool.events"
  | "attachment.image";

export interface BridgeDesktopRuntime {
  id: BridgeDesktopRuntimeId;
  name: string;
  state: BridgeDesktopRuntimeState;
  detail: string;
  capabilities: BridgeRuntimeCapability[];
  /** Every runtime remains an isolated native session domain. */
  sessionIsolation: "independent";
  sessionCount: number;
  updatedAt: number;
  appVersion?: string;
}

export type BridgeSessionTransport =
  | "claude-desktop-managed"
  | "bridge-host"
  | "codex-app-server"
  | "hermes-gateway";
export type ClaudeDesktopIntegrationState =
  | "not-managed"
  | "starting"
  | "ready"
  | "incompatible"
  | "disconnected";
export type BridgeOwnershipState =
  | "DESKTOP_OBSERVED"
  | "DESKTOP_MANAGED_IDLE"
  | "DESKTOP_MANAGED_RUNNING"
  | "FALLBACK_CONFIRMATION_REQUIRED"
  | "OWNERSHIP_CONFLICT"
  | "ACQUIRING"
  | "BRIDGE_IDLE"
  | "BRIDGE_RUNNING"
  | "RELEASING";
export type BridgeTurnState = "idle" | "queued" | "running" | "waiting" | "completed" | "failed" | "interrupted";
export type BridgeEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type BridgeDesktopRegistrationState =
  | "waiting-transcript"
  | "unavailable"
  | "restart-required"
  | "registered"
  | "failed";
export type BridgePermissionDecision = "allow-once" | "allow-always" | "deny";
export type BridgePermissionMode = "standard" | "full-access";
export type BridgePermissionPolicySource = "host" | "session";
export type BridgePermissionResolutionReason =
  | "policy-full-access"
  | "turn-finished"
  | "turn-interrupted"
  | "session-ended";
export type BridgeConfigurationSource = "bridge" | "claude-desktop" | "project" | "default";
export type BridgeDeliveryState =
  | "local-saved"
  | "relay-received"
  | "host-received"
  | "session-received"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "uncertain";

export type BridgeCapability =
  | "evidence.v1"
  | "artifact.preview.v1"
  | "artifact.transfer.v1"
  | "provider.profile.v1"
  | "conversation.lanes.v1"
  | "conversation.handoff.v1"
  | "permission.policy.v1"
  | "runtime.adapter.v1";

export type BridgeProviderKind =
  | "claude-3p"
  | "anthropic-api"
  | "claude-official";
export type BridgeProviderProfileStatus =
  | "ready"
  | "needs-configuration"
  | "unavailable"
  | "error";
export type BridgeExecutionLaneStatus =
  | "active"
  | "inactive"
  | "preparing"
  | "failed";
export type BridgeRouteState =
  | "ready"
  | "switching"
  | "awaiting-user-confirmation"
  | "awaiting-target-selection"
  | "failed";
export type BridgeHandoffState =
  | "previewed"
  | "preparing"
  | "awaiting_target"
  | "awaiting_user_confirmation"
  | "activating"
  | "applied"
  | "failed"
  | "cancelled"
  | "expired";

export interface BridgeProviderModelCapability {
  supported: boolean;
}

export interface BridgeProviderModel {
  id: string;
  displayName: string;
  createdAt?: string;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  capabilities: Record<string, BridgeProviderModelCapability | Record<string, unknown>>;
}

export interface BridgeProviderProfile {
  id: string;
  kind: BridgeProviderKind;
  name: string;
  status: BridgeProviderProfileStatus;
  detail: string;
  configured: boolean;
  localOnlyConfiguration: boolean;
  readOnly: boolean;
  models: BridgeProviderModel[];
  defaultModel?: string;
  refreshedAt?: number;
}

export interface BridgeExecutionLane {
  laneId: string;
  conversationId: string;
  providerProfileId: string;
  providerKind: BridgeProviderKind;
  status: BridgeExecutionLaneStatus;
  access: "read-write" | "read-only";
  nativeSessionId?: string;
  model?: string;
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
}

export interface BridgeSessionAllowedActions {
  canSend: boolean;
  canSteer: boolean;
  canInterrupt: boolean;
  canSwitchProvider: boolean;
  canContinueOfficial: boolean;
  canConfigure: boolean;
  reason?: string;
}

export interface BridgeHandoff {
  handoffId: string;
  conversationId: string;
  sourceLaneId: string;
  targetProviderProfileId: string;
  targetLaneId?: string;
  state: BridgeHandoffState;
  summary: string;
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
  requiresUserConfirmation: boolean;
  candidateNativeSessionIds?: string[];
  error?: string;
}

export interface BridgeConversationRoute {
  conversationId: string;
  activeLaneId: string;
  activeProviderProfileId: string;
  state: BridgeRouteState;
  lanes: BridgeExecutionLane[];
  allowedActions: BridgeSessionAllowedActions;
  pendingHandoff?: BridgeHandoff;
}

export type BridgeEvidenceSource = "bridge-host" | "claude-desktop";
export type BridgeEvidenceConfidence = "exact" | "inferred" | "partial";
export type BridgeEvidenceState = "collecting" | "ready" | "failed";
export type BridgeArtifactKind =
  | "text"
  | "code"
  | "diff"
  | "image"
  | "html"
  | "pdf"
  | "binary"
  | "log";
export type BridgeArtifactChangeKind =
  | "created"
  | "modified"
  | "deleted"
  | "renamed"
  | "observed";
export type BridgeArtifactAvailability =
  | "snapshot"
  | "current-file"
  | "expired"
  | "blocked";
export type BridgeArtifactPreviewMode =
  | "text"
  | "diff"
  | "image"
  | "html-screenshot"
  | "none";

export interface BridgeToolEvidence {
  id: string;
  toolName: string;
  status: "running" | "completed" | "failed";
  summary: string;
  startedAt: number;
  completedAt?: number;
  exitCode?: number;
  outputSummary?: string;
  truncated: boolean;
}

export interface BridgeArtifactManifest {
  id: string;
  evidenceId: string;
  relativePath: string;
  previousPath?: string;
  name: string;
  kind: BridgeArtifactKind;
  changeKind: BridgeArtifactChangeKind;
  mimeType: string;
  size: number;
  sha256?: string;
  availability: BridgeArtifactAvailability;
  previewMode: BridgeArtifactPreviewMode;
  downloadAllowed: boolean;
  blockedReason?: string;
  capturedAt?: number;
}

export interface BridgeEvidenceBundle {
  id: string;
  sessionId: string;
  turnId?: string;
  laneId?: string;
  providerProfileId?: string;
  source: BridgeEvidenceSource;
  confidence: BridgeEvidenceConfidence;
  state: BridgeEvidenceState;
  startedAt: number;
  completedAt?: number;
  toolCount: number;
  changeCount: number;
  artifactCount: number;
  tools: BridgeToolEvidence[];
  artifacts: BridgeArtifactManifest[];
  warnings: string[];
}

export interface BridgeEvidencePage {
  sessionId: string;
  items: BridgeEvidenceBundle[];
  nextCursor?: string;
  hasMore: boolean;
}

export interface BridgeArtifactPreview {
  artifactId: string;
  mode: Exclude<BridgeArtifactPreviewMode, "none">;
  mimeType: string;
  encoding: "utf8" | "base64";
  data: string;
  truncated: boolean;
  generatedAt: number;
}

export interface BridgeArtifactTransferInfo {
  transferId: string;
  artifactId: string;
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
  chunkBytes: number;
  totalChunks: number;
  expiresAt: number;
}

export interface BridgeArtifactTransferChunk {
  transferId: string;
  index: number;
  data: string;
}

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
  /** Omitted only for snapshots produced by pre-0.6 hosts. */
  runtimeId?: BridgeDesktopRuntimeId;
}

export interface BridgeDesktopRegistrationInfo {
  state: BridgeDesktopRegistrationState;
  detail: string;
  updatedAt: number;
  desktopSessionId?: string;
  registeredAt?: number;
}

export interface BridgeSessionInfo {
  sessionId: string;
  /** The native Desktop that owns this session. Defaults to Claude for old hosts. */
  runtimeId?: BridgeDesktopRuntimeId;
  /** Never portable across Desktop runtimes; exposed only as an opaque reference. */
  nativeSessionId?: string;
  desktopSessionId?: string;
  projectId: string;
  projectName: string;
  cwd: string;
  title: string;
  source: "desktop" | "bridge";
  transport: BridgeSessionTransport;
  ownership: BridgeOwnershipState;
  turnState: BridgeTurnState;
  lastActivityAt: number;
  pendingCount: number;
  activeTurnId?: string;
  currentSummary?: string;
  model?: string;
  effort?: BridgeEffort;
  configurationPending?: boolean;
  fallbackConfirmed?: boolean;
  desktopRegistration?: BridgeDesktopRegistrationInfo;
  activeLaneId?: string;
  activeProviderProfileId?: string;
  routeState?: BridgeRouteState;
  allowedActions?: BridgeSessionAllowedActions;
  pendingHandoff?: BridgeHandoff;
}

export interface BridgeModelInfo {
  value: string;
  displayName: string;
  description?: string;
  resolvedModel?: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: BridgeEffort[];
}

export interface BridgeSessionContextUsage {
  totalTokens: number;
  maxTokens: number;
  percentage: number;
  model?: string;
  estimated: boolean;
}

export interface BridgeSessionConfiguration {
  sessionId: string;
  model?: string;
  effort?: BridgeEffort;
  inheritedModel?: string;
  inheritedEffort?: BridgeEffort;
  overrideModel?: string;
  overrideEffort?: BridgeEffort;
  modelSource: BridgeConfigurationSource;
  effortSource: BridgeConfigurationSource;
  availableModels: BridgeModelInfo[];
  availableEffortLevels: BridgeEffort[];
  modelsComplete: boolean;
  appliesAfterTurn: boolean;
  permissionPolicy?: BridgePermissionPolicy;
  context?: BridgeSessionContextUsage;
}

export interface BridgePermissionPolicy {
  hostMode: BridgePermissionMode;
  sessionMode?: BridgePermissionMode;
  effectiveMode: BridgePermissionMode;
  source: BridgePermissionPolicySource;
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
  canAllowAlways: boolean;
}

export interface BridgePermissionResolution {
  requestId: string;
  decision: BridgePermissionDecision;
  resolvedByDeviceId: string;
  resolvedByName: string;
  resolvedAt: number;
  automatic?: boolean;
  reason?: BridgePermissionResolutionReason;
}

export interface BridgeRuntimeStatus {
  state: "ready" | "working" | "auth-required" | "unavailable";
  detail: string;
  version?: string;
  credentialSource?: "third-party-host";
  activeTurns: number;
  maxParallelTurns: number;
  desktopIntegration: {
    state: ClaudeDesktopIntegrationState;
    detail: string;
    enabled: boolean;
    canRestart: boolean;
    appVersion?: string;
    buildFingerprint?: string;
    lastError?: string;
  };
}

export interface BridgeConnectionStatus {
  path: BridgeEndpointKind;
  state: "idle" | "connecting" | "connected" | "reconnecting" | "closed";
  rttMs?: number;
  lastConnectedAt?: number;
  pendingCount: number;
  relayHealthy: boolean;
}

export interface ClaudeDesktopAppStatus {
  state: "running" | "stopped" | "unavailable";
  detail: string;
  canLaunch: boolean;
  canQuit: boolean;
}

export interface BridgeHostSnapshot {
  host: {
    hostId: string;
    pairingEpoch: number;
    name: string;
    relayUrl: string;
    online: boolean;
    lastSeenAt: number;
    version: string;
    capabilities: BridgeCapability[];
    defaultPermissionMode?: BridgePermissionMode;
  };
  projects: BridgeProjectInfo[];
  sessions: BridgeSessionInfo[];
  devices: BridgeDeviceInfo[];
  runtime: BridgeRuntimeStatus;
  transport?: BridgeConnectionStatus;
  claudeDesktop?: ClaudeDesktopAppStatus;
  runtimes?: BridgeDesktopRuntime[];
  permissions: BridgePermissionInfo[];
  providers?: BridgeProviderProfile[];
  latestSeq: number;
}

export interface DesktopControlSnapshot extends BridgeHostSnapshot {
  connection: "idle" | "connecting" | "connected" | "reconnecting" | "closed";
  launchAtLogin: boolean;
  managedDesktopEnabled: boolean;
  claudeDesktop: ClaudeDesktopAppStatus;
  pairingUrl?: string;
  pairingExpiresAt?: number;
}

export type BridgeMethod =
  | "snapshot.get"
  | "runtime.list"
  | "runtime.refresh"
  | "project.list"
  | "session.list"
  | "session.open"
  | "session.create"
  | "session.history"
  | "session.configuration"
  | "session.configure"
  | "session.desktop.register"
  | "session.fallback.confirm"
  | "message.delivery.resolve"
  | "claude.desktop.status"
  | "claude.desktop.launch"
  | "claude.desktop.quit"
  | "turn.start"
  | "turn.steer"
  | "turn.interrupt"
  | "permission.resolve"
  | "permission.policy.configure"
  | "events.resume"
  | "evidence.list"
  | "evidence.get"
  | "artifact.preview"
  | "artifact.transfer.open"
  | "artifact.transfer.read"
  | "artifact.transfer.close"
  | "provider.list"
  | "provider.refresh"
  | "conversation.route.get"
  | "conversation.switch.preview"
  | "conversation.switch.commit"
  | "conversation.switch.cancel"
  | "handoff.get"
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
  | "session.configuration"
  | "session.desktop-registration"
  | "session.transport"
  | "session.ownership-conflict"
  | "user.message.accepted"
  | "message.delivery"
  | "assistant.delta"
  | "assistant.completed"
  | "tool.started"
  | "tool.progress"
  | "tool.completed"
  | "permission.requested"
  | "permission.resolved"
  | "permission.policy.changed"
  | "question.requested"
  | "question.resolved"
  | "turn.queued"
  | "turn.started"
  | "turn.completed"
  | "turn.failed"
  | "turn.interrupted"
  | "evidence.started"
  | "evidence.updated"
  | "evidence.ready"
  | "evidence.failed"
  | "provider.updated"
  | "conversation.route.changed"
  | "lane.created"
  | "lane.updated"
  | "handoff.started"
  | "handoff.ready"
  | "handoff.applied"
  | "handoff.failed"
  | "device.paired"
  | "device.revoked"
  | "runtime.compatibility"
  | "runtime.updated"
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

export type BridgePeerSignalAction =
  | "offer"
  | "answer"
  | "candidate"
  | "end-of-candidates"
  | "ack"
  | "bye";

export interface BridgePeerSignalPayload {
  kind: "peer-signal";
  connectionId: string;
  action: BridgePeerSignalAction;
  description?: {
    type: "offer" | "answer";
    sdp: string;
  };
  candidate?: {
    candidate: string;
    sdpMid?: string | null;
    sdpMLineIndex?: number | null;
    usernameFragment?: string | null;
  };
  ids?: string[];
}

export type BridgePayload =
  | BridgeRequest
  | BridgeResponse
  | BridgeEventPayload
  | BridgeSnapshotPayload
  | BridgePeerSignalPayload;

export interface EnvelopeHeader {
  // Local vault migration may read legacy envelopes; network validation accepts V3 only.
  version: number;
  id: string;
  roomId: string;
  from: BridgeRole;
  fromDeviceId: string;
  to: MessageTarget;
  toDeviceId?: string;
  sentAt: number;
  expiresAt: number;
  temporary?: true;
}

export interface EncryptedEnvelope extends EnvelopeHeader {
  nonce: string;
  ciphertext: string;
}

export interface EncryptedEnvelopeChunk {
  version: typeof PROTOCOL_VERSION;
  transferId: string;
  roomId: string;
  from: BridgeRole;
  fromDeviceId: string;
  to: MessageTarget;
  toDeviceId?: string;
  sentAt: number;
  expiresAt: number;
  temporary?: true;
  index: number;
  total: number;
  sha256: string;
  data: string;
}

export type EnvelopeChunkManifest = Omit<EncryptedEnvelopeChunk, "index" | "data">;

export type RelayEnvelopeItem = EncryptedEnvelope | EncryptedEnvelopeChunk;

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

export interface ClientEnvelopeChunkMessage {
  type: "envelope-chunk";
  chunk: EncryptedEnvelopeChunk;
}

export interface ClientChunkQuery {
  type: "chunk-query";
  manifest: EnvelopeChunkManifest;
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
  migrate?: boolean;
  pairedAt?: number;
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
  | ClientEnvelopeChunkMessage
  | ClientChunkQuery
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

export interface ServerEnvelopeChunkMessage {
  type: "envelope-chunk";
  chunk: EncryptedEnvelopeChunk;
}

export interface ServerChunkMissing {
  type: "chunk-missing";
  transferId: string;
  indexes: number[];
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
  envelopeId?: string;
}

export interface ServerPong {
  type: "pong";
  at: number;
}

export type ServerFrame =
  | ServerReady
  | ServerEnvelopeMessage
  | ServerEnvelopeChunkMessage
  | ServerChunkMissing
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
