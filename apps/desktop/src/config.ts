import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  BridgeCrypto,
  PROTOCOL_VERSION,
  randomId,
  type PairingBundle,
} from "@bridge/protocol";

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

interface PairingMetadata extends Omit<PairingBundle, "secret"> {}

interface DesktopConfigFile {
  version: 1;
  pairing: PairingMetadata;
  protectedSecret: string;
  deviceId: string;
  launchAtLogin: boolean;
  mobilePairedAt?: number;
  mobileLastSeenAt?: number;
}

export interface LoadedDesktopConfig {
  pairing: PairingBundle;
  deviceId: string;
  launchAtLogin: boolean;
  mobilePairedAt?: number;
  mobileLastSeenAt?: number;
}

export interface DesktopConfigDefaults {
  relayUrl: string;
  desktopName: string;
}

export function bridgeLocalToken(pairingSecret: string): string {
  return createHash("sha256").update("claude-bridge/local/v1\0").update(pairingSecret).digest("base64url");
}

function assertConfig(value: unknown): DesktopConfigFile {
  if (!value || typeof value !== "object") throw new Error("Desktop config is not an object");
  const config = value as Partial<DesktopConfigFile>;
  if (
    config.version !== 1 ||
    !config.pairing ||
    config.pairing.version !== PROTOCOL_VERSION ||
    typeof config.pairing.roomId !== "string" ||
    typeof config.pairing.relayUrl !== "string" ||
    typeof config.pairing.desktopName !== "string" ||
    typeof config.pairing.createdAt !== "number" ||
    typeof config.protectedSecret !== "string" ||
    typeof config.deviceId !== "string" ||
    typeof config.launchAtLogin !== "boolean" ||
    (config.mobilePairedAt !== undefined && typeof config.mobilePairedAt !== "number") ||
    (config.mobileLastSeenAt !== undefined && typeof config.mobileLastSeenAt !== "number")
  ) throw new Error("Desktop config is incomplete");
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
    const secret = this.protector.unprotect(config.protectedSecret);
    const relayUrl = isLoopbackRelay(config.pairing.relayUrl) && !isLoopbackRelay(this.defaults.relayUrl)
      ? this.defaults.relayUrl
      : config.pairing.relayUrl;
    return {
      pairing: { ...config.pairing, relayUrl, secret },
      deviceId: config.deviceId,
      launchAtLogin: config.launchAtLogin,
      ...(config.mobilePairedAt !== undefined ? { mobilePairedAt: config.mobilePairedAt } : {}),
      ...(config.mobileLastSeenAt !== undefined ? { mobileLastSeenAt: config.mobileLastSeenAt } : {}),
    };
  }

  async loadOrCreate(): Promise<LoadedDesktopConfig> {
    try {
      const existing = await this.load();
      if (existing) return existing;
    } catch {
      await rename(this.path, `${this.path}.unreadable-${Date.now()}`).catch(() => undefined);
    }
    return this.regenerate(false);
  }

  async regenerate(launchAtLogin: boolean): Promise<LoadedDesktopConfig> {
    const { pairing } = await BridgeCrypto.createDesktop(this.defaults.relayUrl, this.defaults.desktopName);
    const loaded = { pairing, deviceId: randomId(12), launchAtLogin };
    await this.save(loaded);
    return loaded;
  }

  async save(config: LoadedDesktopConfig): Promise<void> {
    const { secret, ...pairing } = config.pairing;
    const stored: DesktopConfigFile = {
      version: 1,
      pairing,
      protectedSecret: this.protector.protect(secret),
      deviceId: config.deviceId,
      launchAtLogin: config.launchAtLogin,
      ...(config.mobilePairedAt !== undefined ? { mobilePairedAt: config.mobilePairedAt } : {}),
      ...(config.mobileLastSeenAt !== undefined ? { mobileLastSeenAt: config.mobileLastSeenAt } : {}),
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
