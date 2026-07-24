import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  BridgeRole,
  RelayEnvelopeItem,
} from "@bridge/protocol";

export interface RoomRecord {
  id: string;
  hostDeviceId: string;
  authHash: string;
  createdAt: number;
  lastSeenAt: number;
}

export interface DeviceRecord {
  roomId: string;
  deviceId: string;
  role: "mobile";
  authHash: string;
  createdAt: number;
  expiresAt: number;
  claimedInstanceId?: string;
  claimedAt?: number;
  lastSeenAt?: number;
  revokedAt?: number;
  pushPlatform?: "android" | "ios";
  pushToken?: string;
}

interface StoreSnapshot {
  version: 2 | 3;
  rooms: RoomRecord[];
  devices: DeviceRecord[];
  messages: RelayEnvelopeItem[];
}

export interface RelayStoreStats {
  rooms: number;
  devices: number;
  queuedFrames: number;
  queuedBytes: number;
}

export interface RelayStore {
  load(): Promise<void>;
  getRoom(id: string): RoomRecord | undefined;
  createRoom(room: RoomRecord): Promise<boolean>;
  touchRoom(id: string, at: number): Promise<void>;
  getDevice(roomId: string, deviceId: string): DeviceRecord | undefined;
  listDevices(roomId: string): DeviceRecord[];
  registerDevice(device: DeviceRecord): Promise<void>;
  claimDevice(roomId: string, deviceId: string, instanceId: string, at: number): Promise<boolean>;
  touchDevice(roomId: string, deviceId: string, at: number): Promise<void>;
  registerPush(
    roomId: string,
    deviceId: string,
    platform: "android" | "ios",
    pushToken: string,
    at: number,
  ): Promise<boolean>;
  revokeDevice(roomId: string, deviceId: string, at: number): Promise<boolean>;
  enqueue(envelope: RelayEnvelopeItem): Promise<void>;
  chunkIndexes(roomId: string, transferId: string, fromDeviceId: string): number[];
  listQueued(roomId: string, target: BridgeRole, deviceId: string, now: number): RelayEnvelopeItem[];
  ack(roomId: string, target: BridgeRole, deviceId: string, ids: string[]): Promise<RelayEnvelopeItem[]>;
  prune(now: number): Promise<void>;
  stats(): RelayStoreStats;
  backup?(destination: string): Promise<void>;
  close(): Promise<void>;
}

function deviceKey(roomId: string, deviceId: string): string {
  return `${roomId}\u001f${deviceId}`;
}

export function relayItemId(item: RelayEnvelopeItem): string {
  return "transferId" in item ? item.transferId : item.id;
}

function relayItemKey(item: RelayEnvelopeItem): string {
  return "transferId" in item
    ? `chunk:${item.transferId}:${item.index}`
    : `envelope:${item.id}`;
}

function relayItemBytes(item: RelayEnvelopeItem): number {
  return Buffer.byteLength(JSON.stringify(item));
}

export class MemoryRelayStore implements RelayStore {
  protected readonly rooms = new Map<string, RoomRecord>();
  protected readonly devices = new Map<string, DeviceRecord>();
  protected readonly messages = new Map<string, RelayEnvelopeItem>();
  private readonly maxMessagesPerRoom: number;
  private readonly maxBytesPerRoom: number;

  constructor(maxMessagesPerRoom = 2_000, maxBytesPerRoom = 128 * 1024 * 1024) {
    this.maxMessagesPerRoom = maxMessagesPerRoom;
    this.maxBytesPerRoom = maxBytesPerRoom;
  }

  async load(): Promise<void> {}

  getRoom(id: string): RoomRecord | undefined {
    return this.rooms.get(id);
  }

  async createRoom(room: RoomRecord): Promise<boolean> {
    if (this.rooms.has(room.id)) return false;
    this.rooms.set(room.id, room);
    await this.changed();
    return true;
  }

  async touchRoom(id: string, at: number): Promise<void> {
    const room = this.rooms.get(id);
    if (!room) return;
    room.lastSeenAt = at;
    await this.changed();
  }

  getDevice(roomId: string, deviceId: string): DeviceRecord | undefined {
    return this.devices.get(deviceKey(roomId, deviceId));
  }

  listDevices(roomId: string): DeviceRecord[] {
    return [...this.devices.values()].filter((device) => device.roomId === roomId);
  }

  async registerDevice(device: DeviceRecord): Promise<void> {
    const existing = this.getDevice(device.roomId, device.deviceId);
    this.devices.set(deviceKey(device.roomId, device.deviceId), {
      ...device,
      ...(existing?.claimedInstanceId ? {
        claimedInstanceId: existing.claimedInstanceId,
        claimedAt: existing.claimedAt,
      } : {}),
      ...(existing?.lastSeenAt ? { lastSeenAt: existing.lastSeenAt } : {}),
      ...(existing?.revokedAt ? { revokedAt: existing.revokedAt } : {}),
    });
    await this.changed();
  }

  async claimDevice(roomId: string, deviceId: string, instanceId: string, at: number): Promise<boolean> {
    const device = this.getDevice(roomId, deviceId);
    if (!device || device.revokedAt) return false;
    if (device.claimedInstanceId && device.claimedInstanceId !== instanceId) return false;
    device.claimedInstanceId = instanceId;
    device.claimedAt ??= at;
    device.lastSeenAt = at;
    await this.changed();
    return true;
  }

  async touchDevice(roomId: string, deviceId: string, at: number): Promise<void> {
    const device = this.getDevice(roomId, deviceId);
    if (!device) return;
    device.lastSeenAt = at;
    await this.changed();
  }

  async registerPush(
    roomId: string,
    deviceId: string,
    platform: "android" | "ios",
    pushToken: string,
    at: number,
  ): Promise<boolean> {
    const device = this.getDevice(roomId, deviceId);
    if (!device || device.revokedAt || !device.claimedAt) return false;
    device.pushPlatform = platform;
    device.pushToken = pushToken;
    device.lastSeenAt = at;
    await this.changed();
    return true;
  }

  async revokeDevice(roomId: string, deviceId: string, at: number): Promise<boolean> {
    const device = this.getDevice(roomId, deviceId);
    if (!device || device.revokedAt) return false;
    device.revokedAt = at;
    delete device.pushToken;
    delete device.pushPlatform;
    for (const [key, envelope] of this.messages) {
      if (envelope.roomId === roomId && envelope.toDeviceId === deviceId) this.messages.delete(key);
    }
    await this.changed();
    return true;
  }

  async enqueue(envelope: RelayEnvelopeItem): Promise<void> {
    this.messages.set(relayItemKey(envelope), envelope);
    const roomMessages = [...this.messages.values()]
      .filter((message) => message.roomId === envelope.roomId)
      .sort((a, b) => a.sentAt - b.sentAt);
    const groups = new Map<string, { id: string; sentAt: number; bytes: number; keys: string[] }>();
    for (const message of roomMessages) {
      const id = relayItemId(message);
      const group = groups.get(id) ?? { id, sentAt: message.sentAt, bytes: 0, keys: [] };
      group.sentAt = Math.min(group.sentAt, message.sentAt);
      group.bytes += relayItemBytes(message);
      group.keys.push(relayItemKey(message));
      groups.set(id, group);
    }
    let roomBytes = [...groups.values()].reduce((sum, group) => sum + group.bytes, 0);
    const ordered = [...groups.values()].sort((left, right) => left.sentAt - right.sentAt);
    while (groups.size > this.maxMessagesPerRoom || roomBytes > this.maxBytesPerRoom) {
      const oldest = ordered.shift();
      if (!oldest) break;
      for (const key of oldest.keys) this.messages.delete(key);
      roomBytes -= oldest.bytes;
      groups.delete(oldest.id);
    }
    await this.changed();
  }

  chunkIndexes(roomId: string, transferId: string, fromDeviceId: string): number[] {
    return [...this.messages.values()]
      .flatMap((message) => (
        "transferId" in message &&
        message.roomId === roomId &&
        message.transferId === transferId &&
        message.fromDeviceId === fromDeviceId
          ? [message.index]
          : []
      ))
      .sort((left, right) => left - right);
  }

  listQueued(roomId: string, target: BridgeRole, deviceId: string, now: number): RelayEnvelopeItem[] {
    return [...this.messages.values()]
      .filter((message) => (
        message.roomId === roomId &&
        message.to === target &&
        (!message.toDeviceId || message.toDeviceId === deviceId) &&
        message.expiresAt > now
      ))
      .sort((a, b) => (
        a.sentAt - b.sentAt ||
        (("index" in a ? a.index : -1) - ("index" in b ? b.index : -1))
      ));
  }

  async ack(
    roomId: string,
    target: BridgeRole,
    deviceId: string,
    ids: string[],
  ): Promise<RelayEnvelopeItem[]> {
    const acknowledged: RelayEnvelopeItem[] = [];
    const requested = new Set(ids);
    for (const [key, message] of this.messages) {
      if (
        requested.has(relayItemId(message)) &&
        message.roomId === roomId &&
        message.to === target &&
        (!message.toDeviceId || message.toDeviceId === deviceId)
      ) {
        this.messages.delete(key);
        acknowledged.push(message);
      }
    }
    if (acknowledged.length > 0) await this.changed();
    return acknowledged;
  }

  async prune(now: number): Promise<void> {
    let changed = false;
    for (const [id, message] of this.messages) {
      if (message.expiresAt <= now) {
        this.messages.delete(id);
        changed = true;
      }
    }
    for (const [key, device] of this.devices) {
      if (!device.claimedAt && device.expiresAt <= now) {
        this.devices.delete(key);
        changed = true;
      }
    }
    if (changed) await this.changed();
  }

  stats(): RelayStoreStats {
    return {
      rooms: this.rooms.size,
      devices: this.devices.size,
      queuedFrames: this.messages.size,
      queuedBytes: [...this.messages.values()].reduce((sum, message) => sum + relayItemBytes(message), 0),
    };
  }

  async close(): Promise<void> {
    await this.changed();
  }

  protected snapshot(): StoreSnapshot {
    return {
      version: 3,
      rooms: [...this.rooms.values()],
      devices: [...this.devices.values()],
      messages: [...this.messages.values()],
    };
  }

  protected async changed(): Promise<void> {}
}

export class JsonFileRelayStore extends MemoryRelayStore {
  private readonly path: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(path: string, maxMessagesPerRoom = 2_000) {
    super(maxMessagesPerRoom);
    this.path = path;
  }

  override async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as Partial<StoreSnapshot>;
      const legacy = parsed as Partial<StoreSnapshot> & { version?: number };
      if (
        (legacy.version !== 2 && legacy.version !== 3) ||
        !Array.isArray(parsed.rooms) ||
        !Array.isArray(parsed.devices) ||
        !Array.isArray(parsed.messages)
      ) {
        await rename(this.path, `${this.path}.v1-archive-${Date.now()}`).catch(() => undefined);
        return;
      }
      for (const room of parsed.rooms) this.rooms.set(room.id, room);
      for (const device of parsed.devices) this.devices.set(deviceKey(device.roomId, device.deviceId), device);
      for (const message of parsed.messages) this.messages.set(relayItemKey(message), message);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  protected override async changed(): Promise<void> {
    const contents = JSON.stringify(this.snapshot());
    this.writeQueue = this.writeQueue.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const temporaryPath = `${this.path}.${process.pid}.tmp`;
      await writeFile(temporaryPath, contents, { encoding: "utf8", mode: 0o600 });
      await rename(temporaryPath, this.path);
    });
    await this.writeQueue;
  }
}
