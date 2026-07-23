import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { BridgeCrypto, PROTOCOL_VERSION } from "@bridge/protocol";

export interface SecretProtector {
  available(): boolean;
  protect(value: string): string;
  unprotect(value: string): string;
}

export function fileSecretProtector(): SecretProtector {
  return {
    available: () => true,
    protect: (value) => `file:${Buffer.from(value, "utf8").toString("base64")}`,
    unprotect: (value) => {
      if (!value.startsWith("file:")) throw new Error("Unsupported secret protection format");
      return Buffer.from(value.slice(5), "base64").toString("utf8");
    },
  };
}

interface StoredDeviceConfig {
  deviceId: string;
  name: string;
  platform: "android" | "ios" | "web" | "unknown";
  protectedSecret: string;
  createdAt: number;
  expiresAt: number;
  pairedAt?: number;
  lastSeenAt?: number;
  revokedAt?: number;
}

interface DesktopConfigFile {
  version: 2;
  protocolVersion: typeof PROTOCOL_VERSION;
  roomId: string;
  relayUrl: string;
  desktopName: string;
  hostDeviceId: string;
  protectedHostSecret: string;
  createdAt: number;
  launchAtLogin: boolean;
  devices: StoredDeviceConfig[];
}

export interface LoadedDeviceConfig {
  deviceId: string;
  name: string;
  platform: "android" | "ios" | "web" | "unknown";
  secret: string;
  createdAt: number;
  expiresAt: number;
  pairedAt?: number;
  lastSeenAt?: number;
  revokedAt?: number;
}

export interface LoadedDesktopConfig {
  protocolVersion: typeof PROTOCOL_VERSION;
  roomId: string;
  relayUrl: string;
  desktopName: string;
  hostDeviceId: string;
  hostSecret: string;
  createdAt: number;
  launchAtLogin: boolean;
  devices: LoadedDeviceConfig[];
}

export interface DesktopConfigDefaults {
  relayUrl: string;
  desktopName: string;
}

export function bridgeLocalToken(hostSecret: string): string {
  return createHash("sha256").update("claude-bridge/local/v2\0").update(hostSecret).digest("base64url");
}

function assertConfig(value: unknown): DesktopConfigFile {
  if (!value || typeof value !== "object") throw new Error("Desktop config is not an object");
  const config = value as Partial<DesktopConfigFile>;
  if (
    config.version !== 2 ||
    config.protocolVersion !== PROTOCOL_VERSION ||
    typeof config.roomId !== "string" ||
    typeof config.relayUrl !== "string" ||
    typeof config.desktopName !== "string" ||
    typeof config.hostDeviceId !== "string" ||
    typeof config.protectedHostSecret !== "string" ||
    typeof config.createdAt !== "number" ||
    typeof config.launchAtLogin !== "boolean" ||
    !Array.isArray(config.devices)
  ) throw new Error("Desktop config is incomplete");
  for (const device of config.devices) {
    if (
      typeof device.deviceId !== "string" ||
      typeof device.name !== "string" ||
      typeof device.protectedSecret !== "string" ||
      typeof device.createdAt !== "number" ||
      typeof device.expiresAt !== "number"
    ) throw new Error("Desktop device config is incomplete");
  }
  return config as DesktopConfigFile;
}

function isLoopbackRelay(value: string): boolean {
  try {
    const hostname = new URL(value).hostname;
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
  } catch {
    return false;
  }
}

export class DesktopConfigRepository {
  private saveQueue: Promise<void> = Promise.resolve();

  constructor(
    readonly path: string,
    private readonly protector: SecretProtector,
    private readonly defaults: DesktopConfigDefaults,
  ) {}

  async load(): Promise<LoadedDesktopConfig | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const config = assertConfig(JSON.parse(raw));
    const relayUrl = isLoopbackRelay(config.relayUrl) && !isLoopbackRelay(this.defaults.relayUrl)
      ? this.defaults.relayUrl
      : config.relayUrl;
    return {
      protocolVersion: PROTOCOL_VERSION,
      roomId: config.roomId,
      relayUrl,
      desktopName: config.desktopName,
      hostDeviceId: config.hostDeviceId,
      hostSecret: this.protector.unprotect(config.protectedHostSecret),
      createdAt: config.createdAt,
      launchAtLogin: config.launchAtLogin,
      devices: config.devices.map((device) => ({
        deviceId: device.deviceId,
        name: device.name,
        platform: device.platform,
        secret: this.protector.unprotect(device.protectedSecret),
        createdAt: device.createdAt,
        expiresAt: device.expiresAt,
        ...(device.pairedAt !== undefined ? { pairedAt: device.pairedAt } : {}),
        ...(device.lastSeenAt !== undefined ? { lastSeenAt: device.lastSeenAt } : {}),
        ...(device.revokedAt !== undefined ? { revokedAt: device.revokedAt } : {}),
      })),
    };
  }

  async loadOrCreate(): Promise<LoadedDesktopConfig> {
    try {
      const existing = await this.load();
      if (existing) return existing;
    } catch {
      await rename(this.path, `${this.path}.v1-archive-${Date.now()}`).catch(() => undefined);
    }
    return this.regenerate(false);
  }

  async regenerate(launchAtLogin: boolean): Promise<LoadedDesktopConfig> {
    const { crypto, secret } = await BridgeCrypto.createHost(this.defaults.relayUrl, this.defaults.desktopName);
    const loaded: LoadedDesktopConfig = {
      protocolVersion: PROTOCOL_VERSION,
      roomId: crypto.identity.roomId,
      relayUrl: crypto.identity.relayUrl,
      desktopName: crypto.identity.desktopName,
      hostDeviceId: crypto.identity.deviceId,
      hostSecret: secret,
      createdAt: Date.now(),
      launchAtLogin,
      devices: [],
    };
    await this.save(loaded);
    return loaded;
  }

  async save(config: LoadedDesktopConfig): Promise<void> {
    const stored: DesktopConfigFile = {
      version: 2,
      protocolVersion: PROTOCOL_VERSION,
      roomId: config.roomId,
      relayUrl: config.relayUrl,
      desktopName: config.desktopName,
      hostDeviceId: config.hostDeviceId,
      protectedHostSecret: this.protector.protect(config.hostSecret),
      createdAt: config.createdAt,
      launchAtLogin: config.launchAtLogin,
      devices: config.devices.map((device) => ({
        deviceId: device.deviceId,
        name: device.name,
        platform: device.platform,
        protectedSecret: this.protector.protect(device.secret),
        createdAt: device.createdAt,
        expiresAt: device.expiresAt,
        ...(device.pairedAt !== undefined ? { pairedAt: device.pairedAt } : {}),
        ...(device.lastSeenAt !== undefined ? { lastSeenAt: device.lastSeenAt } : {}),
        ...(device.revokedAt !== undefined ? { revokedAt: device.revokedAt } : {}),
      })),
    };
    const contents = `${JSON.stringify(stored, null, 2)}\n`;
    this.saveQueue = this.saveQueue.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${process.pid}.tmp`;
      await writeFile(temporary, contents, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.path);
      await chmod(this.path, 0o600).catch(() => undefined);
    });
    await this.saveQueue;
  }
}
