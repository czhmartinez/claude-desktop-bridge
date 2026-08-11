import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { mkdir, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  BridgeConversationRoute,
  BridgeDesktopRuntimeId,
  BridgeExecutionLane,
  BridgeHandoff,
  BridgeHandoffState,
  BridgeProviderKind,
  BridgeProviderProfile,
  BridgeRouteState,
  BridgePermissionMode,
  BridgeRuntimeHandoff,
  BridgeRuntimeHandoffState,
  BridgeRuntimeGoalInfo,
  BridgeRuntimeGoalStatus,
  BridgeSessionAllowedActions,
} from "@bridge/protocol";
import { supportsClaudeDesktop } from "./platform.js";

const STORE_VERSION = 1;
const ENCRYPTED_PACKAGE_MAGIC = Buffer.from("BHS1");

export const CLAUDE_3P_PROFILE_ID = "provider:claude-3p:default";
export const ANTHROPIC_API_PROFILE_ID = "provider:anthropic-api:default";
export const CLAUDE_OFFICIAL_PROFILE_ID = "provider:claude-official:default";

interface SqlRow {
  [key: string]: string | number | bigint | Uint8Array | null;
}

export interface PersistedBridgeSession {
  sessionId: string;
  cwd: string;
  title: string;
  createdAt: number;
  desktopSessionId?: string;
  desktopRegistration?: unknown;
  fallbackConfirmedAt?: number;
}

export interface PersistedSessionConfiguration {
  sessionId: string;
  model?: string;
  effort?: string;
  permissionMode?: "standard" | "full-access";
  updatedAt: number;
}

export interface PersistedTerminalReceipt {
  idempotencyKey: string;
  commandId: string;
  requestId: string;
  sessionId: string;
  state: "completed" | "failed" | "cancelled";
}

export interface PersistedQueuedTurn extends Record<string, unknown> {
  commandId: string;
  requestId: string;
  idempotencyKey: string;
  sessionId: string;
  laneId: string;
  state: string;
}

export interface ConversationBrokerState {
  sessions: PersistedBridgeSession[];
  configurations: PersistedSessionConfiguration[];
  pending: PersistedQueuedTurn[];
  completedIdempotencyKeys: string[];
  terminalTurns: PersistedTerminalReceipt[];
}

export interface ConversationStateStoreOptions {
  databasePath: string;
  sessionsPath: string;
  queuePath: string;
  masterSecret: string;
}

export interface EnsureConversationInput {
  conversationId: string;
  cwd: string;
  title: string;
  source: "bridge" | "desktop";
  providerProfileId?: string;
  providerKind?: BridgeProviderKind;
  nativeSessionId?: string;
  access?: BridgeExecutionLane["access"];
  createdAt?: number;
}

export interface CreateLaneInput {
  laneId?: string;
  conversationId: string;
  providerProfileId: string;
  providerKind: BridgeProviderKind;
  nativeSessionId?: string;
  access: BridgeExecutionLane["access"];
  status?: BridgeExecutionLane["status"];
  model?: string;
  createdAt?: number;
}

export interface SaveHandoffInput extends Omit<BridgeHandoff, "createdAt" | "updatedAt"> {
  createdAt?: number;
  updatedAt?: number;
  package?: unknown;
  executablePrompt?: string;
}

interface StoredHandoffPackage {
  package?: unknown;
  executablePrompt?: string;
}

interface StoredRuntimeHandoffPackage {
  package?: unknown;
  planPrompt?: string;
  executionPrompt?: string;
}

export interface StoredRuntimeHandoff extends BridgeRuntimeHandoff {
  sourceNativeSessionId?: string;
  targetNativeSessionId?: string;
}

export interface SaveRuntimeHandoffInput extends Omit<StoredRuntimeHandoff, "createdAt" | "updatedAt"> {
  createdAt?: number;
  updatedAt?: number;
  package?: unknown;
  planPrompt?: string;
  executionPrompt?: string;
}

export interface StoredRuntimeGoal extends BridgeRuntimeGoalInfo {
  sessionId: string;
  handoffId: string;
  runtimeId: BridgeDesktopRuntimeId;
  nativeSessionId: string;
}

export interface StoredRuntimeSessionPermission {
  sessionId: string;
  permissionMode: BridgePermissionMode;
  updatedAt: number;
}

export type SessionVisibility = "archived" | "deleted";

export interface StoredSessionVisibility {
  sessionId: string;
  visibility: SessionVisibility;
  updatedAt: number;
}

function defaultProviderProfiles(): BridgeProviderProfile[] {
  const officialReady = supportsClaudeDesktop();
  return [
    {
      id: CLAUDE_3P_PROFILE_ID,
      kind: "claude-3p",
      name: "Claude-3p",
      status: "unavailable",
      detail: "正在检查 Claude-3p Host 凭据。",
      configured: false,
      localOnlyConfiguration: false,
      readOnly: false,
      models: [],
    },
    {
      id: ANTHROPIC_API_PROFILE_ID,
      kind: "anthropic-api",
      name: "Anthropic API",
      status: "needs-configuration",
      detail: "需要在电脑端输入 Claude Console API Key。",
      configured: false,
      localOnlyConfiguration: true,
      readOnly: false,
      models: [],
    },
    {
      id: CLAUDE_OFFICIAL_PROFILE_ID,
      kind: "claude-official",
      name: "Claude 官方订阅",
      status: officialReady ? "ready" : "unavailable",
      detail: officialReady
        ? "通过 Claude 官方 Deep Link 新建会话，激活后由 Bridge 只读观察。"
        : "当前平台不支持 Claude 官方 Deep Link。",
      configured: officialReady,
      localOnlyConfiguration: false,
      readOnly: true,
      models: [],
    },
  ];
}

export function legacyClaudeLaneId(conversationId: string): string {
  return `lane:claude-3p:${conversationId}`;
}

function laneFromRow(row: SqlRow): BridgeExecutionLane {
  return {
    laneId: String(row.id),
    conversationId: String(row.conversation_id),
    providerProfileId: String(row.provider_profile_id),
    providerKind: String(row.provider_kind) as BridgeProviderKind,
    status: String(row.status) as BridgeExecutionLane["status"],
    access: String(row.access) as BridgeExecutionLane["access"],
    ...(row.native_session_id !== null ? { nativeSessionId: String(row.native_session_id) } : {}),
    ...(row.model !== null ? { model: String(row.model) } : {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    ...(row.last_used_at !== null ? { lastUsedAt: Number(row.last_used_at) } : {}),
  };
}

function profileFromRow(row: SqlRow): BridgeProviderProfile {
  return {
    id: String(row.id),
    kind: String(row.kind) as BridgeProviderKind,
    name: String(row.name),
    status: String(row.status) as BridgeProviderProfile["status"],
    detail: String(row.detail),
    configured: Number(row.configured) === 1,
    localOnlyConfiguration: Number(row.local_only_configuration) === 1,
    readOnly: Number(row.read_only) === 1,
    models: JSON.parse(String(row.models_json)) as BridgeProviderProfile["models"],
    ...(row.default_model !== null ? { defaultModel: String(row.default_model) } : {}),
    ...(row.refreshed_at !== null ? { refreshedAt: Number(row.refreshed_at) } : {}),
  };
}

function handoffFromRow(row: SqlRow): BridgeHandoff {
  const candidates = JSON.parse(String(row.candidate_native_ids_json)) as string[];
  return {
    handoffId: String(row.id),
    conversationId: String(row.conversation_id),
    sourceLaneId: String(row.source_lane_id),
    targetProviderProfileId: String(row.target_provider_profile_id),
    ...(row.target_lane_id !== null ? { targetLaneId: String(row.target_lane_id) } : {}),
    state: String(row.state) as BridgeHandoffState,
    summary: String(row.summary),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    ...(row.expires_at !== null ? { expiresAt: Number(row.expires_at) } : {}),
    requiresUserConfirmation: Number(row.requires_user_confirmation) === 1,
    ...(candidates.length ? { candidateNativeSessionIds: candidates } : {}),
    ...(row.error !== null ? { error: String(row.error) } : {}),
  };
}

function runtimeHandoffFromRow(row: SqlRow): StoredRuntimeHandoff {
  return {
    handoffId: String(row.id),
    state: String(row.state) as BridgeRuntimeHandoffState,
    sourceRuntimeId: String(row.source_runtime) as BridgeDesktopRuntimeId,
    sourceSessionId: String(row.source_session_id),
    ...(row.source_native_session_id !== null ? { sourceNativeSessionId: String(row.source_native_session_id) } : {}),
    targetRuntimeId: String(row.target_runtime) as BridgeDesktopRuntimeId,
    ...(row.target_session_id !== null ? { targetSessionId: String(row.target_session_id) } : {}),
    ...(row.target_native_session_id !== null ? { targetNativeSessionId: String(row.target_native_session_id) } : {}),
    objective: String(row.objective),
    summary: String(row.summary),
    ...(row.plan_text !== null ? { planText: String(row.plan_text) } : {}),
    ...(row.error !== null ? { error: String(row.error) } : {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    ...(row.expires_at !== null ? { expiresAt: Number(row.expires_at) } : {}),
  };
}

function runtimeGoalFromRow(row: SqlRow): StoredRuntimeGoal {
  return {
    sessionId: String(row.session_id),
    handoffId: String(row.handoff_id),
    runtimeId: String(row.runtime_id) as BridgeDesktopRuntimeId,
    nativeSessionId: String(row.native_session_id),
    objective: String(row.objective),
    status: String(row.status) as BridgeRuntimeGoalStatus,
    native: Number(row.native) === 1,
    continuations: Number(row.continuations),
    ...(row.detail !== null ? { detail: String(row.detail) } : {}),
    updatedAt: Number(row.updated_at),
  };
}

function allowedActions(
  lane: BridgeExecutionLane,
  state: BridgeRouteState,
): BridgeSessionAllowedActions {
  const switching = state === "switching"
    || state === "awaiting-user-confirmation"
    || state === "awaiting-target-selection";
  const readOnly = lane.access === "read-only";
  return {
    canSend: !readOnly && !switching,
    canSteer: !readOnly && !switching,
    canInterrupt: !readOnly,
    canSwitchProvider: !switching,
    canContinueOfficial: readOnly,
    canConfigure: !readOnly && !switching,
    ...(readOnly
      ? {
          reason: "当前对话在 Claude 官方只读通道，不能写入、排队或回退；请在 Claude 官方继续，或升级 Bridge 后切换提供方。",
        }
      : switching
        ? { reason: "提供方接力尚未完成，原通道保持活动。" }
        : {}),
  };
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function readJsonFile(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function sqliteTimestamp(value: number): number {
  if (!Number.isFinite(value)) throw new Error("Timestamp must be finite");
  return Math.trunc(value);
}

export class ConversationStateStore {
  private database: DatabaseSync | undefined;
  private readonly key: Buffer;

  constructor(private readonly options: ConversationStateStoreOptions) {
    this.key = createHash("sha256")
      .update("claude-bridge/conversation-state/v1\0")
      .update(options.masterSecret)
      .digest();
  }

  async initialize(): Promise<void> {
    if (this.database) return;
    await mkdir(dirname(this.options.databasePath), { recursive: true });
    const database = new DatabaseSync(this.options.databasePath);
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS conversation_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS provider_profiles (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        detail TEXT NOT NULL,
        configured INTEGER NOT NULL,
        local_only_configuration INTEGER NOT NULL,
        read_only INTEGER NOT NULL,
        models_json TEXT NOT NULL,
        default_model TEXT,
        refreshed_at INTEGER
      ) STRICT;

      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        cwd TEXT NOT NULL,
        title TEXT NOT NULL,
        source TEXT NOT NULL,
        active_lane_id TEXT,
        active_provider_profile_id TEXT,
        route_state TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS lanes (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        provider_profile_id TEXT NOT NULL,
        provider_kind TEXT NOT NULL,
        native_session_id TEXT,
        status TEXT NOT NULL,
        access TEXT NOT NULL,
        model TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_used_at INTEGER,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
        FOREIGN KEY (provider_profile_id) REFERENCES provider_profiles(id)
      ) STRICT;

      CREATE UNIQUE INDEX IF NOT EXISTS lanes_provider_native
        ON lanes(provider_profile_id, native_session_id)
        WHERE native_session_id IS NOT NULL;

      CREATE INDEX IF NOT EXISTS lanes_conversation
        ON lanes(conversation_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS handoffs (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        source_lane_id TEXT NOT NULL,
        target_provider_profile_id TEXT NOT NULL,
        target_lane_id TEXT,
        state TEXT NOT NULL,
        summary TEXT NOT NULL,
        package_encrypted BLOB,
        requires_user_confirmation INTEGER NOT NULL,
        candidate_native_ids_json TEXT NOT NULL,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
        FOREIGN KEY (source_lane_id) REFERENCES lanes(id),
        FOREIGN KEY (target_lane_id) REFERENCES lanes(id),
        FOREIGN KEY (target_provider_profile_id) REFERENCES provider_profiles(id)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS handoffs_conversation
        ON handoffs(conversation_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS bridge_sessions (
        session_id TEXT PRIMARY KEY,
        session_json TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS session_configurations (
        session_id TEXT PRIMARY KEY,
        configuration_json TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS turn_queue (
        command_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        lane_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL,
        turn_json TEXT NOT NULL,
        FOREIGN KEY (lane_id) REFERENCES lanes(id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS completed_idempotency_keys (
        idempotency_key TEXT PRIMARY KEY,
        completed_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS terminal_receipts (
        idempotency_key TEXT PRIMARY KEY,
        receipt_json TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS migration_markers (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS runtime_handoffs (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        source_runtime TEXT NOT NULL,
        source_session_id TEXT NOT NULL,
        source_native_session_id TEXT,
        target_runtime TEXT NOT NULL,
        target_session_id TEXT,
        target_native_session_id TEXT,
        objective TEXT NOT NULL,
        summary TEXT NOT NULL,
        plan_text TEXT,
        package_encrypted BLOB,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER
      ) STRICT;

      CREATE INDEX IF NOT EXISTS runtime_handoffs_source
        ON runtime_handoffs(source_session_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS runtime_handoffs_target
        ON runtime_handoffs(target_session_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS runtime_goals (
        session_id TEXT PRIMARY KEY,
        handoff_id TEXT NOT NULL,
        runtime_id TEXT NOT NULL,
        native_session_id TEXT NOT NULL,
        objective TEXT NOT NULL,
        status TEXT NOT NULL,
        native INTEGER NOT NULL,
        continuations INTEGER NOT NULL,
        detail TEXT,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (handoff_id) REFERENCES runtime_handoffs(id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS runtime_session_permissions (
        session_id TEXT PRIMARY KEY,
        permission_mode TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS session_visibility (
        session_id TEXT PRIMARY KEY,
        visibility TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
    `);
    database.prepare(`
      INSERT INTO conversation_meta(key, value) VALUES ('version', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(String(STORE_VERSION));
    this.database = database;
    this.seedProviderProfiles();
    await this.migrateLegacyFiles();
  }

  close(): void {
    this.database?.close();
    this.database = undefined;
  }

  listProviderProfiles(): BridgeProviderProfile[] {
    return (this.db.prepare(
      "SELECT * FROM provider_profiles ORDER BY rowid ASC",
    ).all() as SqlRow[]).map(profileFromRow);
  }

  providerProfile(profileId: string): BridgeProviderProfile | undefined {
    const row = this.db.prepare(
      "SELECT * FROM provider_profiles WHERE id = ?",
    ).get(profileId) as SqlRow | undefined;
    return row ? profileFromRow(row) : undefined;
  }

  saveProviderProfile(profile: BridgeProviderProfile): void {
    this.db.prepare(`
      INSERT INTO provider_profiles(
        id, kind, name, status, detail, configured, local_only_configuration,
        read_only, models_json, default_model, refreshed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind,
        name = excluded.name,
        status = excluded.status,
        detail = excluded.detail,
        configured = excluded.configured,
        local_only_configuration = excluded.local_only_configuration,
        read_only = excluded.read_only,
        models_json = excluded.models_json,
        default_model = excluded.default_model,
        refreshed_at = excluded.refreshed_at
    `).run(
      profile.id,
      profile.kind,
      profile.name,
      profile.status,
      profile.detail,
      profile.configured ? 1 : 0,
      profile.localOnlyConfiguration ? 1 : 0,
      profile.readOnly ? 1 : 0,
      JSON.stringify(profile.models),
      profile.defaultModel ?? null,
      profile.refreshedAt !== undefined ? sqliteTimestamp(profile.refreshedAt) : null,
    );
  }

  ensureConversation(input: EnsureConversationInput): BridgeConversationRoute {
    const existing = this.route(input.conversationId);
    if (existing) return existing;
    const createdAt = sqliteTimestamp(input.createdAt ?? Date.now());
    const providerProfileId = input.providerProfileId ?? CLAUDE_3P_PROFILE_ID;
    const providerKind = input.providerKind ?? "claude-3p";
    const laneId = input.providerKind === "claude-3p" && providerProfileId === CLAUDE_3P_PROFILE_ID
      ? legacyClaudeLaneId(input.conversationId)
      : `lane:${randomBytes(16).toString("hex")}`;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`
        INSERT INTO conversations(
          id, cwd, title, source, active_lane_id, active_provider_profile_id,
          route_state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'ready', ?, ?)
      `).run(
        input.conversationId,
        input.cwd,
        input.title,
        input.source,
        laneId,
        providerProfileId,
        createdAt,
        createdAt,
      );
      this.db.prepare(`
        INSERT INTO lanes(
          id, conversation_id, provider_profile_id, provider_kind,
          native_session_id, status, access, model, created_at, updated_at, last_used_at
        ) VALUES (?, ?, ?, ?, ?, 'active', ?, NULL, ?, ?, ?)
      `).run(
        laneId,
        input.conversationId,
        providerProfileId,
        providerKind,
        input.nativeSessionId ?? input.conversationId,
        input.access ?? (providerKind === "claude-official" ? "read-only" : "read-write"),
        createdAt,
        createdAt,
        createdAt,
      );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.route(input.conversationId)!;
  }

  route(conversationId: string): BridgeConversationRoute | undefined {
    const conversation = this.db.prepare(
      "SELECT * FROM conversations WHERE id = ?",
    ).get(conversationId) as SqlRow | undefined;
    if (!conversation?.active_lane_id || !conversation.active_provider_profile_id) return undefined;
    const lanes = this.listLanes(conversationId);
    const activeLane = lanes.find((lane) => lane.laneId === conversation.active_lane_id);
    if (!activeLane) throw new Error("Conversation active lane is missing");
    const pendingHandoffRow = this.db.prepare(`
      SELECT * FROM handoffs
      WHERE conversation_id = ?
        AND state NOT IN ('applied', 'failed', 'cancelled', 'expired')
      ORDER BY created_at DESC
      LIMIT 1
    `).get(conversationId) as SqlRow | undefined;
    const state = String(conversation.route_state) as BridgeRouteState;
    return {
      conversationId,
      activeLaneId: String(conversation.active_lane_id),
      activeProviderProfileId: String(conversation.active_provider_profile_id),
      state,
      lanes,
      allowedActions: allowedActions(activeLane, state),
      ...(pendingHandoffRow ? { pendingHandoff: handoffFromRow(pendingHandoffRow) } : {}),
    };
  }

  activeLane(conversationId: string): BridgeExecutionLane | undefined {
    const route = this.route(conversationId);
    return route?.lanes.find((lane) => lane.laneId === route.activeLaneId);
  }

  listLanes(conversationId: string): BridgeExecutionLane[] {
    return (this.db.prepare(`
      SELECT * FROM lanes
      WHERE conversation_id = ?
      ORDER BY created_at ASC, id ASC
    `).all(conversationId) as SqlRow[]).map(laneFromRow);
  }

  listAllLanes(providerKind?: BridgeProviderKind): BridgeExecutionLane[] {
    const rows = providerKind
      ? this.db.prepare(`
          SELECT * FROM lanes WHERE provider_kind = ? ORDER BY created_at ASC, id ASC
        `).all(providerKind)
      : this.db.prepare("SELECT * FROM lanes ORDER BY created_at ASC, id ASC").all();
    return (rows as SqlRow[]).map(laneFromRow);
  }

  lane(laneId: string): BridgeExecutionLane | undefined {
    const row = this.db.prepare(
      "SELECT * FROM lanes WHERE id = ?",
    ).get(laneId) as SqlRow | undefined;
    return row ? laneFromRow(row) : undefined;
  }

  findLane(providerProfileId: string, nativeSessionId: string): BridgeExecutionLane | undefined {
    const row = this.db.prepare(`
      SELECT * FROM lanes
      WHERE provider_profile_id = ? AND native_session_id = ?
    `).get(providerProfileId, nativeSessionId) as SqlRow | undefined;
    return row ? laneFromRow(row) : undefined;
  }

  findLanesByNativeSessionId(nativeSessionId: string): BridgeExecutionLane[] {
    return (this.db.prepare(`
      SELECT * FROM lanes WHERE native_session_id = ? ORDER BY created_at ASC, id ASC
    `).all(nativeSessionId) as SqlRow[]).map(laneFromRow);
  }

  createLane(input: CreateLaneInput): BridgeExecutionLane {
    if (!this.route(input.conversationId)) throw new Error("Conversation not found");
    if (!this.providerProfile(input.providerProfileId)) throw new Error("Provider profile not found");
    const now = sqliteTimestamp(input.createdAt ?? Date.now());
    const laneId = input.laneId ?? `lane:${randomBytes(16).toString("hex")}`;
    this.db.prepare(`
      INSERT INTO lanes(
        id, conversation_id, provider_profile_id, provider_kind,
        native_session_id, status, access, model, created_at, updated_at, last_used_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(
      laneId,
      input.conversationId,
      input.providerProfileId,
      input.providerKind,
      input.nativeSessionId ?? null,
      input.status ?? "preparing",
      input.access,
      input.model ?? null,
      now,
      now,
    );
    return this.lane(laneId)!;
  }

  updateLane(
    laneId: string,
    change: Partial<Pick<
      BridgeExecutionLane,
      "nativeSessionId" | "status" | "model" | "lastUsedAt"
    >>,
  ): BridgeExecutionLane {
    const current = this.lane(laneId);
    if (!current) throw new Error("Lane not found");
    const next = {
      ...current,
      ...change,
      updatedAt: Date.now(),
    };
    this.db.prepare(`
      UPDATE lanes
      SET native_session_id = ?, status = ?, model = ?, updated_at = ?, last_used_at = ?
      WHERE id = ?
    `).run(
      next.nativeSessionId ?? null,
      next.status,
      next.model ?? null,
      next.updatedAt,
      next.lastUsedAt !== undefined ? sqliteTimestamp(next.lastUsedAt) : null,
      laneId,
    );
    return this.lane(laneId)!;
  }

  setRouteState(conversationId: string, state: BridgeRouteState): BridgeConversationRoute {
    const result = this.db.prepare(`
      UPDATE conversations SET route_state = ?, updated_at = ? WHERE id = ?
    `).run(state, Date.now(), conversationId);
    if (Number(result.changes) !== 1) throw new Error("Conversation not found");
    return this.route(conversationId)!;
  }

  saveHandoff(input: SaveHandoffInput): BridgeHandoff {
    const now = Date.now();
    const createdAt = sqliteTimestamp(input.createdAt ?? now);
    const updatedAt = sqliteTimestamp(input.updatedAt ?? now);
    const encrypted = input.package !== undefined || input.executablePrompt !== undefined
      ? this.encryptPackage({
          ...(input.package !== undefined ? { package: input.package } : {}),
          ...(input.executablePrompt !== undefined ? { executablePrompt: input.executablePrompt } : {}),
        })
      : null;
    this.db.prepare(`
      INSERT INTO handoffs(
        id, conversation_id, source_lane_id, target_provider_profile_id,
        target_lane_id, state, summary, package_encrypted,
        requires_user_confirmation, candidate_native_ids_json, error,
        created_at, updated_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        target_lane_id = excluded.target_lane_id,
        state = excluded.state,
        summary = excluded.summary,
        package_encrypted = COALESCE(excluded.package_encrypted, handoffs.package_encrypted),
        requires_user_confirmation = excluded.requires_user_confirmation,
        candidate_native_ids_json = excluded.candidate_native_ids_json,
        error = excluded.error,
        updated_at = excluded.updated_at,
        expires_at = excluded.expires_at
    `).run(
      input.handoffId,
      input.conversationId,
      input.sourceLaneId,
      input.targetProviderProfileId,
      input.targetLaneId ?? null,
      input.state,
      input.summary,
      encrypted,
      input.requiresUserConfirmation ? 1 : 0,
      JSON.stringify(input.candidateNativeSessionIds ?? []),
      input.error ?? null,
      createdAt,
      updatedAt,
      input.expiresAt !== undefined ? sqliteTimestamp(input.expiresAt) : null,
    );
    return this.handoff(input.handoffId)!;
  }

  handoff(handoffId: string): BridgeHandoff | undefined {
    const row = this.db.prepare(
      "SELECT * FROM handoffs WHERE id = ?",
    ).get(handoffId) as SqlRow | undefined;
    return row ? handoffFromRow(row) : undefined;
  }

  listPendingHandoffs(): BridgeHandoff[] {
    return (this.db.prepare(`
      SELECT * FROM handoffs
      WHERE state NOT IN ('applied', 'failed', 'cancelled', 'expired')
      ORDER BY created_at ASC, id ASC
    `).all() as SqlRow[]).map(handoffFromRow);
  }

  handoffPackage(handoffId: string): StoredHandoffPackage | undefined {
    const row = this.db.prepare(
      "SELECT package_encrypted FROM handoffs WHERE id = ?",
    ).get(handoffId) as SqlRow | undefined;
    if (!row?.package_encrypted) return undefined;
    return this.decryptPackage(Buffer.from(row.package_encrypted as Uint8Array)) as StoredHandoffPackage;
  }

  failHandoff(handoffId: string, error: string): BridgeHandoff {
    const handoff = this.handoff(handoffId);
    if (!handoff) throw new Error("Handoff not found");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`
        UPDATE handoffs SET state = 'failed', error = ?, updated_at = ? WHERE id = ?
      `).run(error, Date.now(), handoffId);
      this.db.prepare(`
        UPDATE conversations SET route_state = 'failed', updated_at = ? WHERE id = ?
      `).run(Date.now(), handoff.conversationId);
      this.db.exec("COMMIT");
    } catch (failure) {
      this.db.exec("ROLLBACK");
      throw failure;
    }
    return this.handoff(handoffId)!;
  }

  cancelHandoff(handoffId: string): BridgeHandoff {
    const handoff = this.handoff(handoffId);
    if (!handoff) throw new Error("Handoff not found");
    if (handoff.state === "applied") throw new Error("Applied handoff cannot be cancelled");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`
        UPDATE handoffs SET state = 'cancelled', updated_at = ? WHERE id = ?
      `).run(Date.now(), handoffId);
      this.db.prepare(`
        UPDATE conversations SET route_state = 'ready', updated_at = ? WHERE id = ?
      `).run(Date.now(), handoff.conversationId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.handoff(handoffId)!;
  }

  expireHandoff(handoffId: string): BridgeHandoff {
    const handoff = this.handoff(handoffId);
    if (!handoff) throw new Error("Handoff not found");
    if (handoff.state === "applied") throw new Error("Applied handoff cannot expire");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`
        UPDATE handoffs SET state = 'expired', error = ?, updated_at = ? WHERE id = ?
      `).run("接力确认已超过十分钟有效期", Date.now(), handoffId);
      this.db.prepare(`
        UPDATE conversations SET route_state = 'ready', updated_at = ? WHERE id = ?
      `).run(Date.now(), handoff.conversationId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.handoff(handoffId)!;
  }

  applyHandoff(handoffId: string, targetLaneId: string): BridgeConversationRoute {
    const handoff = this.handoff(handoffId);
    const target = this.lane(targetLaneId);
    if (
      !handoff ||
      !target ||
      target.conversationId !== handoff.conversationId ||
      target.providerProfileId !== handoff.targetProviderProfileId
    ) {
      throw new Error("Handoff target lane is invalid");
    }
    if (handoff.state !== "activating") throw new Error("Handoff is not ready to activate");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`
        UPDATE lanes SET status = 'inactive', updated_at = ?
        WHERE conversation_id = ? AND status = 'active'
      `).run(Date.now(), handoff.conversationId);
      this.db.prepare(`
        UPDATE lanes SET status = 'active', updated_at = ?, last_used_at = ?
        WHERE id = ?
      `).run(Date.now(), Date.now(), targetLaneId);
      this.db.prepare(`
        UPDATE conversations
        SET active_lane_id = ?, active_provider_profile_id = ?,
            route_state = 'ready', updated_at = ?
        WHERE id = ?
      `).run(targetLaneId, target.providerProfileId, Date.now(), handoff.conversationId);
      this.db.prepare(`
        UPDATE handoffs
        SET target_lane_id = ?, state = 'applied', error = NULL, updated_at = ?
        WHERE id = ?
      `).run(targetLaneId, Date.now(), handoffId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.route(handoff.conversationId)!;
  }

  saveRuntimeHandoff(input: SaveRuntimeHandoffInput): StoredRuntimeHandoff {
    const now = Date.now();
    const createdAt = sqliteTimestamp(input.createdAt ?? now);
    const updatedAt = sqliteTimestamp(input.updatedAt ?? now);
    const encrypted = input.package !== undefined || input.planPrompt !== undefined || input.executionPrompt !== undefined
      ? this.encryptPackage({
          ...(input.package !== undefined ? { package: input.package } : {}),
          ...(input.planPrompt !== undefined ? { planPrompt: input.planPrompt } : {}),
          ...(input.executionPrompt !== undefined ? { executionPrompt: input.executionPrompt } : {}),
        } satisfies StoredRuntimeHandoffPackage)
      : null;
    this.db.prepare(`
      INSERT INTO runtime_handoffs(
        id, state, source_runtime, source_session_id, source_native_session_id,
        target_runtime, target_session_id, target_native_session_id,
        objective, summary, plan_text, package_encrypted, error,
        created_at, updated_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        state = excluded.state,
        target_session_id = excluded.target_session_id,
        target_native_session_id = excluded.target_native_session_id,
        objective = excluded.objective,
        summary = excluded.summary,
        plan_text = excluded.plan_text,
        package_encrypted = COALESCE(excluded.package_encrypted, runtime_handoffs.package_encrypted),
        error = excluded.error,
        updated_at = excluded.updated_at,
        expires_at = excluded.expires_at
    `).run(
      input.handoffId,
      input.state,
      input.sourceRuntimeId,
      input.sourceSessionId,
      input.sourceNativeSessionId ?? null,
      input.targetRuntimeId,
      input.targetSessionId ?? null,
      input.targetNativeSessionId ?? null,
      input.objective,
      input.summary,
      input.planText ?? null,
      encrypted,
      input.error ?? null,
      createdAt,
      updatedAt,
      input.expiresAt !== undefined ? sqliteTimestamp(input.expiresAt) : null,
    );
    return this.runtimeHandoff(input.handoffId)!;
  }

  runtimeHandoff(handoffId: string): StoredRuntimeHandoff | undefined {
    const row = this.db.prepare(
      "SELECT * FROM runtime_handoffs WHERE id = ?",
    ).get(handoffId) as SqlRow | undefined;
    return row ? runtimeHandoffFromRow(row) : undefined;
  }

  runtimeHandoffPackage(handoffId: string): StoredRuntimeHandoffPackage | undefined {
    const row = this.db.prepare(
      "SELECT package_encrypted FROM runtime_handoffs WHERE id = ?",
    ).get(handoffId) as SqlRow | undefined;
    if (!row?.package_encrypted) return undefined;
    return this.decryptPackage(Buffer.from(row.package_encrypted as Uint8Array)) as StoredRuntimeHandoffPackage;
  }

  runtimeHandoffsForSession(sessionId: string): StoredRuntimeHandoff[] {
    return (this.db.prepare(`
      SELECT * FROM runtime_handoffs
      WHERE source_session_id = ? OR target_session_id = ?
      ORDER BY created_at ASC, id ASC
    `).all(sessionId, sessionId) as SqlRow[]).map(runtimeHandoffFromRow);
  }

  listRuntimeHandoffs(): StoredRuntimeHandoff[] {
    return (this.db.prepare(
      "SELECT * FROM runtime_handoffs ORDER BY created_at ASC, id ASC",
    ).all() as SqlRow[]).map(runtimeHandoffFromRow);
  }

  listActiveRuntimeHandoffs(): StoredRuntimeHandoff[] {
    return (this.db.prepare(`
      SELECT * FROM runtime_handoffs
      WHERE state NOT IN ('applied', 'cancelled', 'failed')
      ORDER BY created_at ASC, id ASC
    `).all() as SqlRow[]).map(runtimeHandoffFromRow);
  }

  saveRuntimeGoal(goal: StoredRuntimeGoal): StoredRuntimeGoal {
    this.db.prepare(`
      INSERT INTO runtime_goals(
        session_id, handoff_id, runtime_id, native_session_id,
        objective, status, native, continuations, detail, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        objective = excluded.objective,
        status = excluded.status,
        native = excluded.native,
        continuations = excluded.continuations,
        detail = excluded.detail,
        updated_at = excluded.updated_at
    `).run(
      goal.sessionId,
      goal.handoffId,
      goal.runtimeId,
      goal.nativeSessionId,
      goal.objective,
      goal.status,
      goal.native ? 1 : 0,
      goal.continuations,
      goal.detail ?? null,
      sqliteTimestamp(goal.updatedAt),
    );
    return this.runtimeGoal(goal.sessionId)!;
  }

  runtimeGoal(sessionId: string): StoredRuntimeGoal | undefined {
    const row = this.db.prepare(
      "SELECT * FROM runtime_goals WHERE session_id = ?",
    ).get(sessionId) as SqlRow | undefined;
    return row ? runtimeGoalFromRow(row) : undefined;
  }

  listRuntimeGoals(statuses?: BridgeRuntimeGoalStatus[]): StoredRuntimeGoal[] {
    const rows = statuses?.length
      ? this.db.prepare(`
          SELECT * FROM runtime_goals
          WHERE status IN (${statuses.map(() => "?").join(", ")})
          ORDER BY updated_at ASC, session_id ASC
        `).all(...statuses) as SqlRow[]
      : this.db.prepare(
         "SELECT * FROM runtime_goals ORDER BY updated_at ASC, session_id ASC",
       ).all() as SqlRow[];
    return rows.map(runtimeGoalFromRow);
  }

  saveRuntimeSessionPermission(
    sessionId: string,
    permissionMode: BridgePermissionMode | null,
  ): void {
    if (permissionMode === null) {
      this.db.prepare("DELETE FROM runtime_session_permissions WHERE session_id = ?").run(sessionId);
      return;
    }
    this.db.prepare(`
      INSERT INTO runtime_session_permissions(session_id, permission_mode, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        permission_mode = excluded.permission_mode,
        updated_at = excluded.updated_at
    `).run(sessionId, permissionMode, Date.now());
  }

  listRuntimeSessionPermissions(): StoredRuntimeSessionPermission[] {
    const rows = this.db.prepare(
      "SELECT * FROM runtime_session_permissions ORDER BY updated_at ASC, session_id ASC",
    ).all() as SqlRow[];
    const permissions: StoredRuntimeSessionPermission[] = [];
    for (const row of rows) {
      const mode = String(row.permission_mode);
      if (mode !== "standard" && mode !== "full-access") continue;
      permissions.push({
        sessionId: String(row.session_id),
        permissionMode: mode,
        updatedAt: Number(row.updated_at),
      });
    }
    return permissions;
  }

  setSessionVisibility(sessionId: string, visibility: SessionVisibility | null): void {
    if (visibility === null) {
      this.db.prepare("DELETE FROM session_visibility WHERE session_id = ?").run(sessionId);
      return;
    }
    this.db.prepare(`
      INSERT INTO session_visibility(session_id, visibility, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        visibility = excluded.visibility,
        updated_at = excluded.updated_at
    `).run(sessionId, visibility, Date.now());
  }

  listSessionVisibility(): StoredSessionVisibility[] {
    const rows = this.db.prepare(
      "SELECT * FROM session_visibility ORDER BY updated_at ASC, session_id ASC",
    ).all() as SqlRow[];
    const entries: StoredSessionVisibility[] = [];
    for (const row of rows) {
      const visibility = String(row.visibility);
      if (visibility !== "archived" && visibility !== "deleted") continue;
      entries.push({
        sessionId: String(row.session_id),
        visibility,
        updatedAt: Number(row.updated_at),
      });
    }
    return entries;
  }

  loadBrokerState(): ConversationBrokerState {
    const sessions = (this.db.prepare(
      "SELECT session_json FROM bridge_sessions ORDER BY rowid ASC",
    ).all() as SqlRow[]).map((row) => JSON.parse(String(row.session_json)) as PersistedBridgeSession);
    const configurations = (this.db.prepare(
      "SELECT configuration_json FROM session_configurations ORDER BY rowid ASC",
    ).all() as SqlRow[]).map(
      (row) => JSON.parse(String(row.configuration_json)) as PersistedSessionConfiguration,
    );
    const pending = (this.db.prepare(
      "SELECT turn_json FROM turn_queue ORDER BY rowid ASC",
    ).all() as SqlRow[]).map((row) => JSON.parse(String(row.turn_json)) as PersistedQueuedTurn);
    const completedIdempotencyKeys = (this.db.prepare(
      "SELECT idempotency_key FROM completed_idempotency_keys ORDER BY completed_at ASC",
    ).all() as SqlRow[]).map((row) => String(row.idempotency_key));
    const terminalTurns = (this.db.prepare(
      "SELECT receipt_json FROM terminal_receipts ORDER BY rowid ASC",
    ).all() as SqlRow[]).map(
      (row) => JSON.parse(String(row.receipt_json)) as PersistedTerminalReceipt,
    );
    return {
      sessions,
      configurations,
      pending,
      completedIdempotencyKeys,
      terminalTurns,
    };
  }

  saveBrokerSessions(
    sessions: PersistedBridgeSession[],
    configurations: PersistedSessionConfiguration[],
  ): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec("DELETE FROM bridge_sessions; DELETE FROM session_configurations;");
      const insertSession = this.db.prepare(
        "INSERT INTO bridge_sessions(session_id, session_json) VALUES (?, ?)",
      );
      for (const session of sessions) {
        insertSession.run(session.sessionId, JSON.stringify(session));
        const exists = this.db.prepare(
          "SELECT 1 FROM conversations WHERE id = ?",
        ).get(session.sessionId);
        if (!exists) this.insertLegacyConversation(session);
      }
      const insertConfiguration = this.db.prepare(
        "INSERT INTO session_configurations(session_id, configuration_json) VALUES (?, ?)",
      );
      for (const configuration of configurations) {
        insertConfiguration.run(configuration.sessionId, JSON.stringify(configuration));
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  saveBrokerQueue(
    pending: PersistedQueuedTurn[],
    completedIdempotencyKeys: string[],
    terminalTurns: PersistedTerminalReceipt[],
  ): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`
        DELETE FROM turn_queue;
        DELETE FROM completed_idempotency_keys;
        DELETE FROM terminal_receipts;
      `);
      const insertTurn = this.db.prepare(`
        INSERT INTO turn_queue(
          command_id, session_id, lane_id, idempotency_key, state, turn_json
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const turn of pending) {
        if (!turn.laneId || !this.lane(turn.laneId)) {
          throw new Error(`Queued turn ${turn.commandId} has no valid lane`);
        }
        insertTurn.run(
          turn.commandId,
          turn.sessionId,
          turn.laneId,
          turn.idempotencyKey,
          turn.state,
          JSON.stringify(turn),
        );
      }
      const insertKey = this.db.prepare(`
        INSERT INTO completed_idempotency_keys(idempotency_key, completed_at)
        VALUES (?, ?)
      `);
      for (const key of completedIdempotencyKeys.slice(-2_000)) insertKey.run(key, Date.now());
      const insertReceipt = this.db.prepare(`
        INSERT INTO terminal_receipts(idempotency_key, receipt_json) VALUES (?, ?)
      `);
      for (const receipt of terminalTurns.slice(-2_000)) {
        insertReceipt.run(receipt.idempotencyKey, JSON.stringify(receipt));
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async recordSuccessfulStartup(): Promise<number> {
    const marker = this.marker<{ count?: number }>("successful_startups");
    const count = (marker?.count ?? 0) + 1;
    this.saveMarker("successful_startups", { count, at: Date.now() });
    if (count < 2) return count;
    await this.archiveLegacyFile(this.options.sessionsPath);
    await this.archiveLegacyFile(this.options.queuePath);
    this.saveMarker("legacy_files_archived", { at: Date.now() });
    return count;
  }

  private seedProviderProfiles(): void {
    for (const profile of defaultProviderProfiles()) {
      if (!this.providerProfile(profile.id)) this.saveProviderProfile(profile);
    }
  }

  private async migrateLegacyFiles(): Promise<void> {
    if (this.marker("legacy_v2_imported")) return;
    const [sessionsValue, queueValue] = await Promise.all([
      readJsonFile(this.options.sessionsPath),
      readJsonFile(this.options.queuePath),
    ]);
    const sessionsFile = sessionsValue as {
      version?: unknown;
      sessions?: unknown;
      configurations?: unknown;
    } | undefined;
    const queueFile = queueValue as {
      version?: unknown;
      pending?: unknown;
      completedIdempotencyKeys?: unknown;
      terminalTurns?: unknown;
    } | undefined;
    if (
      sessionsFile &&
      (
        sessionsFile.version !== 2 ||
        !Array.isArray(sessionsFile.sessions) ||
        (sessionsFile.configurations !== undefined && !Array.isArray(sessionsFile.configurations))
      )
    ) throw new Error("Unsupported sessions-v2.json migration source");
    if (
      queueFile &&
      (
        queueFile.version !== 2 ||
        !Array.isArray(queueFile.pending) ||
        !Array.isArray(queueFile.completedIdempotencyKeys) ||
        (queueFile.terminalTurns !== undefined && !Array.isArray(queueFile.terminalTurns))
      )
    ) throw new Error("Unsupported turn-queue-v2.json migration source");

    const sessions = (sessionsFile?.sessions ?? []) as PersistedBridgeSession[];
    const configurations = (sessionsFile?.configurations ?? []) as PersistedSessionConfiguration[];
    const pending = (queueFile?.pending ?? []) as Array<Record<string, unknown>>;
    const completed = (queueFile?.completedIdempotencyKeys ?? []) as string[];
    const receipts = (queueFile?.terminalTurns ?? []) as PersistedTerminalReceipt[];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const insertSession = this.db.prepare(`
        INSERT OR REPLACE INTO bridge_sessions(session_id, session_json) VALUES (?, ?)
      `);
      for (const session of sessions) {
        if (
          !session ||
          typeof session.sessionId !== "string" ||
          typeof session.cwd !== "string" ||
          typeof session.title !== "string" ||
          typeof session.createdAt !== "number"
        ) throw new Error("Invalid Bridge session migration record");
        insertSession.run(session.sessionId, JSON.stringify(session));
        this.insertLegacyConversation(session);
      }
      const insertConfiguration = this.db.prepare(`
        INSERT OR REPLACE INTO session_configurations(session_id, configuration_json)
        VALUES (?, ?)
      `);
      for (const configuration of configurations) {
        insertConfiguration.run(configuration.sessionId, JSON.stringify(configuration));
      }
      const insertTurn = this.db.prepare(`
        INSERT OR REPLACE INTO turn_queue(
          command_id, session_id, lane_id, idempotency_key, state, turn_json
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const raw of pending) {
        const sessionId = typeof raw.sessionId === "string" ? raw.sessionId : "";
        if (
          !sessionId ||
          typeof raw.commandId !== "string" ||
          typeof raw.requestId !== "string" ||
          typeof raw.idempotencyKey !== "string" ||
          typeof raw.state !== "string"
        ) throw new Error("Invalid Bridge queue migration record");
        if (!this.route(sessionId)) {
          this.insertLegacyConversation({
            sessionId,
            cwd: typeof raw.sessionCwd === "string" ? raw.sessionCwd : process.cwd(),
            title: typeof raw.sessionTitle === "string" ? raw.sessionTitle : "恢复的 Bridge 会话",
            createdAt: typeof raw.requestedAt === "number" ? raw.requestedAt : Date.now(),
          });
        }
        const laneId = legacyClaudeLaneId(sessionId);
        const turn = { ...raw, laneId };
        insertTurn.run(
          raw.commandId,
          sessionId,
          laneId,
          raw.idempotencyKey,
          raw.state,
          JSON.stringify(turn),
        );
      }
      const insertKey = this.db.prepare(`
        INSERT OR REPLACE INTO completed_idempotency_keys(idempotency_key, completed_at)
        VALUES (?, ?)
      `);
      for (const key of completed) {
        if (typeof key === "string") insertKey.run(key, Date.now());
      }
      const insertReceipt = this.db.prepare(`
        INSERT OR REPLACE INTO terminal_receipts(idempotency_key, receipt_json)
        VALUES (?, ?)
      `);
      for (const receipt of receipts) {
        insertReceipt.run(receipt.idempotencyKey, JSON.stringify(receipt));
      }
      this.saveMarker("legacy_v2_imported", {
        at: Date.now(),
        sessions: sessions.length,
        pending: pending.length,
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private insertLegacyConversation(session: PersistedBridgeSession): void {
    const laneId = legacyClaudeLaneId(session.sessionId);
    const createdAt = sqliteTimestamp(session.createdAt);
    this.db.prepare(`
      INSERT OR IGNORE INTO conversations(
        id, cwd, title, source, active_lane_id, active_provider_profile_id,
        route_state, created_at, updated_at
      ) VALUES (?, ?, ?, 'bridge', ?, ?, 'ready', ?, ?)
    `).run(
      session.sessionId,
      session.cwd,
      session.title,
      laneId,
      CLAUDE_3P_PROFILE_ID,
      createdAt,
      createdAt,
    );
    this.db.prepare(`
      INSERT OR IGNORE INTO lanes(
        id, conversation_id, provider_profile_id, provider_kind,
        native_session_id, status, access, model, created_at, updated_at, last_used_at
      ) VALUES (?, ?, ?, 'claude-3p', ?, 'active', 'read-write', NULL, ?, ?, ?)
    `).run(
      laneId,
      session.sessionId,
      CLAUDE_3P_PROFILE_ID,
      session.sessionId,
      createdAt,
      createdAt,
      createdAt,
    );
  }

  private marker<T>(key: string): T | undefined {
    const row = this.db.prepare(
      "SELECT value_json FROM migration_markers WHERE key = ?",
    ).get(key) as SqlRow | undefined;
    return row ? JSON.parse(String(row.value_json)) as T : undefined;
  }

  private saveMarker(key: string, value: unknown): void {
    this.db.prepare(`
      INSERT INTO migration_markers(key, value_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
    `).run(key, JSON.stringify(value), Date.now());
  }

  private async archiveLegacyFile(path: string): Promise<void> {
    try {
      await rename(path, `${path}.migrated`);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }

  private encryptPackage(value: StoredHandoffPackage | StoredRuntimeHandoffPackage): Buffer {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(value), "utf8"),
      cipher.final(),
    ]);
    return Buffer.concat([
      ENCRYPTED_PACKAGE_MAGIC,
      nonce,
      cipher.getAuthTag(),
      ciphertext,
    ]);
  }

  private decryptPackage(value: Buffer): StoredHandoffPackage | StoredRuntimeHandoffPackage {
    if (
      value.byteLength < ENCRYPTED_PACKAGE_MAGIC.byteLength + 12 + 16 ||
      !value.subarray(0, ENCRYPTED_PACKAGE_MAGIC.byteLength).equals(ENCRYPTED_PACKAGE_MAGIC)
    ) throw new Error("Invalid encrypted handoff package");
    const nonceStart = ENCRYPTED_PACKAGE_MAGIC.byteLength;
    const tagStart = nonceStart + 12;
    const contentStart = tagStart + 16;
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      value.subarray(nonceStart, tagStart),
    );
    decipher.setAuthTag(value.subarray(tagStart, contentStart));
    return JSON.parse(Buffer.concat([
      decipher.update(value.subarray(contentStart)),
      decipher.final(),
    ]).toString("utf8")) as StoredHandoffPackage;
  }

  private get db(): DatabaseSync {
    if (!this.database) throw new Error("Conversation state store is not initialized");
    return this.database;
  }
}
