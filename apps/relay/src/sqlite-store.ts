import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import type { BridgeRole, RelayEnvelopeItem } from "@bridge/protocol";
import {
  relayItemId,
  type DeviceRecord,
  type RelayStore,
  type RelayStoreStats,
  type RoomRecord,
} from "./store.js";

interface SqlRow {
  [key: string]: string | number | bigint | null;
}

type MaybeSqlValue = SqlRow[string] | undefined;

function numberValue(value: MaybeSqlValue): number {
  return typeof value === "bigint" ? Number(value) : Number(value);
}

function optionalNumber(value: MaybeSqlValue): number | undefined {
  return value === null || value === undefined ? undefined : numberValue(value);
}

function roomFromRow(row: SqlRow | undefined): RoomRecord | undefined {
  if (!row) return undefined;
  return {
    id: String(row.id),
    hostDeviceId: String(row.host_device_id),
    authHash: String(row.auth_hash),
    createdAt: numberValue(row.created_at),
    lastSeenAt: numberValue(row.last_seen_at),
  };
}

function deviceFromRow(row: SqlRow | undefined): DeviceRecord | undefined {
  if (!row) return undefined;
  const claimedAt = optionalNumber(row.claimed_at);
  const lastSeenAt = optionalNumber(row.last_seen_at);
  const revokedAt = optionalNumber(row.revoked_at);
  return {
    roomId: String(row.room_id),
    deviceId: String(row.device_id),
    role: "mobile",
    authHash: String(row.auth_hash),
    createdAt: numberValue(row.created_at),
    expiresAt: numberValue(row.expires_at),
    ...(row.claimed_instance_id !== null ? { claimedInstanceId: String(row.claimed_instance_id) } : {}),
    ...(claimedAt !== undefined ? { claimedAt } : {}),
    ...(lastSeenAt !== undefined ? { lastSeenAt } : {}),
    ...(revokedAt !== undefined ? { revokedAt } : {}),
    ...(row.push_platform === "android" || row.push_platform === "ios"
      ? { pushPlatform: row.push_platform }
      : {}),
    ...(row.push_token !== null ? { pushToken: String(row.push_token) } : {}),
  };
}

function itemKey(item: RelayEnvelopeItem): string {
  return "transferId" in item
    ? `chunk:${item.transferId}:${item.index}`
    : `envelope:${item.id}`;
}

function parseItem(value: MaybeSqlValue): RelayEnvelopeItem {
  return JSON.parse(String(value)) as RelayEnvelopeItem;
}

export class SqliteRelayStore implements RelayStore {
  private database: DatabaseSync | undefined;

  constructor(
    private readonly path: string,
    private readonly maxMessagesPerRoom = 2_000,
    private readonly maxBytesPerRoom = 128 * 1024 * 1024,
  ) {}

  async load(): Promise<void> {
    if (this.database) return;
    await mkdir(dirname(this.path), { recursive: true });
    const database = new DatabaseSync(this.path);
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS rooms (
        id TEXT PRIMARY KEY,
        host_device_id TEXT NOT NULL,
        auth_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS devices (
        room_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role = 'mobile'),
        auth_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        claimed_instance_id TEXT,
        claimed_at INTEGER,
        last_seen_at INTEGER,
        revoked_at INTEGER,
        push_platform TEXT CHECK (push_platform IN ('android', 'ios')),
        push_token TEXT,
        PRIMARY KEY (room_id, device_id),
        FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
      ) STRICT;

      CREATE TABLE IF NOT EXISTS messages (
        frame_key TEXT PRIMARY KEY,
        envelope_id TEXT NOT NULL,
        room_id TEXT NOT NULL,
        target_role TEXT NOT NULL,
        target_device_id TEXT,
        sender_device_id TEXT NOT NULL,
        sent_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        byte_size INTEGER NOT NULL,
        payload TEXT NOT NULL,
        FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
      ) STRICT;

      CREATE INDEX IF NOT EXISTS messages_delivery
        ON messages(room_id, target_role, target_device_id, sent_at);
      CREATE INDEX IF NOT EXISTS messages_expiry ON messages(expires_at);
      CREATE INDEX IF NOT EXISTS devices_expiry ON devices(expires_at);
    `);
    this.database = database;
  }

  getRoom(id: string): RoomRecord | undefined {
    const row = this.db.prepare("SELECT * FROM rooms WHERE id = ?").get(id) as SqlRow | undefined;
    return roomFromRow(row);
  }

  async createRoom(room: RoomRecord): Promise<boolean> {
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO rooms(id, host_device_id, auth_hash, created_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(room.id, room.hostDeviceId, room.authHash, room.createdAt, room.lastSeenAt);
    return Number(result.changes) > 0;
  }

  async touchRoom(id: string, at: number): Promise<void> {
    this.db.prepare("UPDATE rooms SET last_seen_at = ? WHERE id = ?").run(at, id);
  }

  getDevice(roomId: string, deviceId: string): DeviceRecord | undefined {
    const row = this.db.prepare(
      "SELECT * FROM devices WHERE room_id = ? AND device_id = ?",
    ).get(roomId, deviceId) as SqlRow | undefined;
    return deviceFromRow(row);
  }

  listDevices(roomId: string): DeviceRecord[] {
    return (this.db.prepare(
      "SELECT * FROM devices WHERE room_id = ? ORDER BY created_at",
    ).all(roomId) as SqlRow[]).flatMap((row) => {
      const device = deviceFromRow(row);
      return device ? [device] : [];
    });
  }

  async registerDevice(device: DeviceRecord): Promise<void> {
    this.db.prepare(`
      INSERT INTO devices(
        room_id, device_id, role, auth_hash, created_at, expires_at,
        claimed_instance_id, claimed_at, last_seen_at, revoked_at,
        push_platform, push_token
      ) VALUES (?, ?, 'mobile', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(room_id, device_id) DO UPDATE SET
        role = excluded.role,
        auth_hash = excluded.auth_hash,
        created_at = excluded.created_at,
        expires_at = excluded.expires_at
    `).run(
      device.roomId,
      device.deviceId,
      device.authHash,
      device.createdAt,
      device.expiresAt,
      device.claimedInstanceId ?? null,
      device.claimedAt ?? null,
      device.lastSeenAt ?? null,
      device.revokedAt ?? null,
      device.pushPlatform ?? null,
      device.pushToken ?? null,
    );
  }

  async claimDevice(roomId: string, deviceId: string, instanceId: string, at: number): Promise<boolean> {
    const result = this.db.prepare(`
      UPDATE devices
      SET
        claimed_instance_id = COALESCE(claimed_instance_id, ?),
        claimed_at = COALESCE(claimed_at, ?),
        last_seen_at = ?
      WHERE room_id = ? AND device_id = ? AND revoked_at IS NULL
        AND (claimed_instance_id IS NULL OR claimed_instance_id = ?)
    `).run(instanceId, at, at, roomId, deviceId, instanceId);
    return Number(result.changes) > 0;
  }

  async touchDevice(roomId: string, deviceId: string, at: number): Promise<void> {
    this.db.prepare(
      "UPDATE devices SET last_seen_at = ? WHERE room_id = ? AND device_id = ?",
    ).run(at, roomId, deviceId);
  }

  async registerPush(
    roomId: string,
    deviceId: string,
    platform: "android" | "ios",
    pushToken: string,
    at: number,
  ): Promise<boolean> {
    const result = this.db.prepare(`
      UPDATE devices
      SET push_platform = ?, push_token = ?, last_seen_at = ?
      WHERE room_id = ? AND device_id = ? AND revoked_at IS NULL AND claimed_at IS NOT NULL
    `).run(platform, pushToken, at, roomId, deviceId);
    return Number(result.changes) > 0;
  }

  async revokeDevice(roomId: string, deviceId: string, at: number): Promise<boolean> {
    const result = this.db.prepare(`
      UPDATE devices
      SET revoked_at = ?, push_platform = NULL, push_token = NULL
      WHERE room_id = ? AND device_id = ? AND revoked_at IS NULL
    `).run(at, roomId, deviceId);
    if (Number(result.changes) === 0) return false;
    this.db.prepare(
      "DELETE FROM messages WHERE room_id = ? AND target_device_id = ?",
    ).run(roomId, deviceId);
    return true;
  }

  async enqueue(item: RelayEnvelopeItem): Promise<void> {
    const payload = JSON.stringify(item);
    this.db.prepare(`
      INSERT OR REPLACE INTO messages(
        frame_key, envelope_id, room_id, target_role, target_device_id,
        sender_device_id, sent_at, expires_at, byte_size, payload
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      itemKey(item),
      relayItemId(item),
      item.roomId,
      item.to,
      item.toDeviceId ?? null,
      item.fromDeviceId,
      item.sentAt,
      item.expiresAt,
      Buffer.byteLength(payload),
      payload,
    );
    this.trimRoom(item.roomId);
  }

  chunkIndexes(roomId: string, transferId: string, fromDeviceId: string): number[] {
    return (this.db.prepare(`
      SELECT frame_key FROM messages
      WHERE room_id = ? AND envelope_id = ? AND sender_device_id = ?
        AND frame_key LIKE 'chunk:%'
      ORDER BY frame_key
    `).all(roomId, transferId, fromDeviceId) as SqlRow[])
      .map((row) => Number(String(row.frame_key).split(":").at(-1)))
      .filter((index) => Number.isInteger(index) && index >= 0)
      .sort((left, right) => left - right);
  }

  listQueued(roomId: string, target: BridgeRole, deviceId: string, now: number): RelayEnvelopeItem[] {
    return (this.db.prepare(`
      SELECT payload FROM messages
      WHERE room_id = ? AND target_role = ? AND expires_at > ?
        AND (target_device_id IS NULL OR target_device_id = ?)
      ORDER BY sent_at, frame_key
    `).all(roomId, target, now, deviceId) as SqlRow[]).map((row) => parseItem(row.payload));
  }

  async ack(
    roomId: string,
    target: BridgeRole,
    deviceId: string,
    ids: string[],
  ): Promise<RelayEnvelopeItem[]> {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    const params = [roomId, target, deviceId, ...ids];
    const rows = this.db.prepare(`
      SELECT payload FROM messages
      WHERE room_id = ? AND target_role = ?
        AND (target_device_id IS NULL OR target_device_id = ?)
        AND envelope_id IN (${placeholders})
      ORDER BY sent_at, frame_key
    `).all(...params) as SqlRow[];
    this.db.prepare(`
      DELETE FROM messages
      WHERE room_id = ? AND target_role = ?
        AND (target_device_id IS NULL OR target_device_id = ?)
        AND envelope_id IN (${placeholders})
    `).run(...params);
    return rows.map((row) => parseItem(row.payload));
  }

  async prune(now: number): Promise<void> {
    this.db.prepare("DELETE FROM messages WHERE expires_at <= ?").run(now);
    this.db.prepare(
      "DELETE FROM devices WHERE claimed_at IS NULL AND expires_at <= ?",
    ).run(now);
  }

  stats(): RelayStoreStats {
    const rooms = this.db.prepare("SELECT COUNT(*) AS value FROM rooms").get() as SqlRow;
    const devices = this.db.prepare("SELECT COUNT(*) AS value FROM devices").get() as SqlRow;
    const messages = this.db.prepare(
      "SELECT COUNT(*) AS frames, COALESCE(SUM(byte_size), 0) AS bytes FROM messages",
    ).get() as SqlRow;
    return {
      rooms: numberValue(rooms.value),
      devices: numberValue(devices.value),
      queuedFrames: numberValue(messages.frames),
      queuedBytes: numberValue(messages.bytes),
    };
  }

  async backup(destination: string): Promise<void> {
    await mkdir(dirname(destination), { recursive: true });
    await backup(this.db, destination);
  }

  async close(): Promise<void> {
    this.database?.close();
    this.database = undefined;
  }

  private get db(): DatabaseSync {
    if (!this.database) throw new Error("Relay store has not been loaded");
    return this.database;
  }

  private trimRoom(roomId: string): void {
    const rows = this.db.prepare(`
      SELECT envelope_id, MIN(sent_at) AS sent_at, SUM(byte_size) AS bytes
      FROM messages
      WHERE room_id = ?
      GROUP BY envelope_id
      ORDER BY sent_at
    `).all(roomId) as SqlRow[];
    let totalBytes = rows.reduce((sum, row) => sum + numberValue(row.bytes), 0);
    let count = rows.length;
    for (const row of rows) {
      if (count <= this.maxMessagesPerRoom && totalBytes <= this.maxBytesPerRoom) break;
      this.db.prepare(
        "DELETE FROM messages WHERE room_id = ? AND envelope_id = ?",
      ).run(roomId, String(row.envelope_id));
      totalBytes -= numberValue(row.bytes);
      count -= 1;
    }
  }
}
