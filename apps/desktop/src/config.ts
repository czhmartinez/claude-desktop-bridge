import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  BridgeCrypto,
  DEFAULT_BRIDGE_ICE_SERVERS,
  PROTOCOL_VERSION,
  bridgeEndpoint,
  isBridgeIceServer,
  isBridgeEndpoint,
  normalizeBridgeIceServers,
  normalizeBridgeEndpoints,
  preferredBridgeIceServers,
  relayPathForUrl,
  selectBridgeEndpoint,
  type BridgeEndpoint,
  type BridgeIceServer,
  type BridgeDesktopRuntimeId,
  type BridgePermissionMode,
} from "@bridge/protocol";

const CONFIG_VERSION = 4 as const;

export type RuntimePermissionModes = Partial<Record<BridgeDesktopRuntimeId, BridgePermissionMode>>;

function isRuntimePermissionModes(value: unknown): value is RuntimePermissionModes {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).every(([runtimeId, mode]) => (
    (runtimeId === "codex-desktop" || runtimeId === "hermes-desktop") &&
    (mode === "standard" || mode === "full-access")
  ));
}

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

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

export function safeStorageSecretProtector(storage: SafeStorageLike): SecretProtector {
  const fallback = fileSecretProtector();
  return {
    available: () => storage.isEncryptionAvailable(),
    protect: (value) => storage.isEncryptionAvailable()
      ? `os:${storage.encryptString(value).toString("base64")}`
      : fallback.protect(value),
    unprotect: (value) => {
      if (value.startsWith("os:")) {
        if (!storage.isEncryptionAvailable()) throw new Error("OS secret storage is unavailable");
        return storage.decryptString(Buffer.from(value.slice(3), "base64"));
      }
      return fallback.unprotect(value);
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
  publicRelayClaimedAt?: number;
}

interface DesktopConfigFileV2 {
  version: 2;
  protocolVersion: number;
  roomId: string;
  relayUrl: string;
  desktopName: string;
  hostDeviceId: string;
  protectedHostSecret: string;
  createdAt: number;
  launchAtLogin: boolean;
  managedDesktopEnabled?: boolean;
  devices: StoredDeviceConfig[];
}

interface DesktopConfigFileV3 {
  version: 3;
  protocolVersion: number;
  roomId: string;
  serviceOrigin: string;
  relayEndpoints: BridgeEndpoint[];
  activeEndpoint: string;
  iceServers?: BridgeIceServer[];
  migratedAt?: number;
  desktopName: string;
  hostDeviceId: string;
  protectedHostSecret: string;
  createdAt: number;
  launchAtLogin: boolean;
  managedDesktopEnabled?: boolean;
  devices: StoredDeviceConfig[];
}

interface DesktopConfigFileV4 extends Omit<DesktopConfigFileV3, "version" | "protocolVersion"> {
  version: typeof CONFIG_VERSION;
  protocolVersion: typeof PROTOCOL_VERSION;
  pairingEpoch: number;
  protectedEvidenceKey?: string;
  defaultPermissionMode?: BridgePermissionMode;
  runtimePermissionModes?: RuntimePermissionModes;
}

type DesktopConfigFile = DesktopConfigFileV2 | DesktopConfigFileV3 | DesktopConfigFileV4;

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
  publicRelayClaimedAt?: number;
}

export interface LoadedDesktopConfig {
  configVersion: typeof CONFIG_VERSION;
  protocolVersion: typeof PROTOCOL_VERSION;
  pairingEpoch: number;
  roomId: string;
  serviceOrigin: string;
  relayEndpoints: BridgeEndpoint[];
  activeEndpoint: string;
  iceServers: BridgeIceServer[];
  migratedAt?: number;
  // Compatibility alias for renderer snapshots and older call sites.
  relayUrl: string;
  desktopName: string;
  hostDeviceId: string;
  hostSecret: string;
  evidenceKey: string;
  createdAt: number;
  launchAtLogin: boolean;
  managedDesktopEnabled: boolean;
  defaultPermissionMode: BridgePermissionMode;
  runtimePermissionModes: RuntimePermissionModes;
  devices: LoadedDeviceConfig[];
}

export interface DesktopConfigDefaults {
  relayUrl: string;
  publicRelayUrl?: string;
  serviceOrigin?: string;
  iceServers?: BridgeIceServer[];
  desktopName: string;
}

export function bridgeLocalToken(hostSecret: string): string {
  return createHash("sha256").update("claude-bridge/local/v2\0").update(hostSecret).digest("base64url");
}

function assertDevice(device: StoredDeviceConfig): void {
  if (
    typeof device.deviceId !== "string" ||
    typeof device.name !== "string" ||
    typeof device.protectedSecret !== "string" ||
    typeof device.createdAt !== "number" ||
    typeof device.expiresAt !== "number"
  ) throw new Error("Desktop device config is incomplete");
}

function assertConfig(value: unknown): DesktopConfigFile {
  if (!value || typeof value !== "object") throw new Error("Desktop config is not an object");
  const config = value as {
    version?: unknown;
    protocolVersion?: unknown;
    pairingEpoch?: unknown;
    roomId?: unknown;
    relayUrl?: unknown;
    serviceOrigin?: unknown;
    relayEndpoints?: unknown;
    activeEndpoint?: unknown;
    iceServers?: unknown;
    migratedAt?: unknown;
    desktopName?: unknown;
    hostDeviceId?: unknown;
    protectedHostSecret?: unknown;
    protectedEvidenceKey?: unknown;
    createdAt?: unknown;
    launchAtLogin?: unknown;
    managedDesktopEnabled?: unknown;
    defaultPermissionMode?: unknown;
    runtimePermissionModes?: unknown;
    devices?: unknown;
  };
  if (
    (config.version !== 2 && config.version !== 3 && config.version !== CONFIG_VERSION) ||
    typeof config.protocolVersion !== "number" ||
    typeof config.roomId !== "string" ||
    typeof config.desktopName !== "string" ||
    typeof config.hostDeviceId !== "string" ||
    typeof config.protectedHostSecret !== "string" ||
    typeof config.createdAt !== "number" ||
    typeof config.launchAtLogin !== "boolean" ||
    !Array.isArray(config.devices)
  ) throw new Error("Desktop config is incomplete");
  for (const device of config.devices as StoredDeviceConfig[]) assertDevice(device);
  if (config.version === 2) {
    if (typeof config.relayUrl !== "string") throw new Error("Desktop relay config is incomplete");
    return config as unknown as DesktopConfigFileV2;
  }
  if (
    typeof config.serviceOrigin !== "string" ||
    !Array.isArray(config.relayEndpoints) ||
    !config.relayEndpoints.every(isBridgeEndpoint) ||
    typeof config.activeEndpoint !== "string" ||
    (config.iceServers !== undefined && (
      !Array.isArray(config.iceServers) ||
      !config.iceServers.every(isBridgeIceServer)
    ))
  ) throw new Error("Desktop transport config is incomplete");
  if (
    config.version === CONFIG_VERSION &&
    (
      config.protocolVersion !== PROTOCOL_VERSION ||
      typeof config.pairingEpoch !== "number" ||
      !Number.isInteger(config.pairingEpoch) ||
      config.pairingEpoch < 1 ||
      (config.protectedEvidenceKey !== undefined && typeof config.protectedEvidenceKey !== "string") ||
      (
        config.defaultPermissionMode !== undefined &&
        config.defaultPermissionMode !== "standard" &&
        config.defaultPermissionMode !== "full-access"
      ) ||
      (
        config.runtimePermissionModes !== undefined &&
        !isRuntimePermissionModes(config.runtimePermissionModes)
      )
    )
  ) throw new Error("Desktop pairing epoch is invalid");
  return config as unknown as DesktopConfigFile;
}

function isLoopbackRelay(value: string): boolean {
  try {
    const hostname = new URL(value).hostname;
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
  } catch {
    return false;
  }
}

function isPrivateIpv4(hostname: string): boolean {
  const octets = hostname.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) return false;
  const [first, second] = octets;
  return (
    first === 10 ||
    (first === 172 && second! >= 16 && second! <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254) ||
    (first === 100 && second! >= 64 && second! <= 127)
  );
}

function shouldRefreshLocalRelay(stored: string, currentDefault: string): boolean {
  try {
    const previous = new URL(stored);
    const current = new URL(currentDefault);
    if (previous.toString() === current.toString()) return false;
    if (previous.protocol !== "ws:" || current.protocol !== "ws:") return false;
    if (
      previous.port !== current.port ||
      previous.pathname !== current.pathname ||
      previous.search !== current.search
    ) return false;
    const previousIsLocal = isLoopbackRelay(stored) || isPrivateIpv4(previous.hostname);
    const currentIsLocal = isLoopbackRelay(currentDefault) || isPrivateIpv4(current.hostname);
    return previousIsLocal && currentIsLocal;
  } catch {
    return false;
  }
}

function serviceOriginForRelay(relayUrl: string): string {
  try {
    const value = new URL(relayUrl);
    value.protocol = value.protocol === "wss:" ? "https:" : "http:";
    value.pathname = "/";
    value.search = "";
    value.hash = "";
    return value.toString().replace(/\/$/u, "");
  } catch {
    return "";
  }
}

function defaultEndpoints(defaults: DesktopConfigDefaults): BridgeEndpoint[] {
  const endpoints: BridgeEndpoint[] = [];
  if (defaults.publicRelayUrl) endpoints.push(bridgeEndpoint(defaults.publicRelayUrl, 10, "public"));
  const defaultKind = relayPathForUrl(defaults.relayUrl);
  endpoints.push(bridgeEndpoint(
    defaults.relayUrl,
    defaultKind === "public-relay" ? 10 : 20,
    defaultKind === "public-relay" ? "public" : "lan",
  ));
  return normalizeBridgeEndpoints(endpoints);
}

function migrateV2(config: DesktopConfigFileV2, defaults: DesktopConfigDefaults): {
  relayEndpoints: BridgeEndpoint[];
  activeEndpoint: string;
  serviceOrigin: string;
  iceServers: BridgeIceServer[];
  migratedAt: number;
} {
  const relayUrl = shouldRefreshLocalRelay(config.relayUrl, defaults.relayUrl)
    ? defaults.relayUrl
    : config.relayUrl;
  const legacyKind = relayPathForUrl(relayUrl);
  const relayEndpoints = normalizeBridgeEndpoints([
    ...defaultEndpoints(defaults),
    bridgeEndpoint(
      relayUrl,
      legacyKind === "public-relay" ? 10 : 30,
      legacyKind === "public-relay" ? "public" : "legacy-lan",
    ),
  ]);
  const active = relayEndpoints.find((endpoint) => endpoint.kind === "public-relay")
    ?? selectBridgeEndpoint(relayEndpoints);
  if (!active) throw new Error("No relay endpoint is configured");
  return {
    relayEndpoints,
    activeEndpoint: active.id,
    serviceOrigin: defaults.serviceOrigin ?? serviceOriginForRelay(active.url),
    iceServers: normalizeBridgeIceServers(defaults.iceServers),
    migratedAt: Date.now(),
  };
}

function refreshV3Endpoints(
  config: DesktopConfigFileV3 | DesktopConfigFileV4,
  defaults: DesktopConfigDefaults,
): BridgeEndpoint[] {
  const refreshed = config.relayEndpoints.map((endpoint, index) => {
    const updated = endpoint.kind === "lan-relay" && shouldRefreshLocalRelay(endpoint.url, defaults.relayUrl)
      ? { ...endpoint, url: defaults.relayUrl }
      : endpoint;
    if (
      defaults.publicRelayUrl &&
      updated.kind === "public-relay" &&
      updated.id === "public" &&
      updated.url !== defaults.publicRelayUrl
    ) {
      return {
        ...updated,
        id: `legacy-public-${index}`,
        priority: Math.max(updated.priority, 30),
      };
    }
    return updated;
  });
  return normalizeBridgeEndpoints([...defaultEndpoints(defaults), ...refreshed]);
}

function loadDevice(device: StoredDeviceConfig, protector: SecretProtector): LoadedDeviceConfig {
  return {
    deviceId: device.deviceId,
    name: device.name,
    platform: device.platform,
    secret: protector.unprotect(device.protectedSecret),
    createdAt: device.createdAt,
    expiresAt: device.expiresAt,
    ...(device.pairedAt !== undefined ? { pairedAt: device.pairedAt } : {}),
    ...(device.lastSeenAt !== undefined ? { lastSeenAt: device.lastSeenAt } : {}),
    ...(device.revokedAt !== undefined ? { revokedAt: device.revokedAt } : {}),
    ...(device.publicRelayClaimedAt !== undefined
      ? { publicRelayClaimedAt: device.publicRelayClaimedAt }
      : {}),
  };
}

export class DesktopConfigRepository {
  private saveQueue: Promise<void> = Promise.resolve();

  constructor(
    readonly path: string,
    private readonly protector: SecretProtector,
    private readonly defaults: DesktopConfigDefaults,
    private readonly evidenceProtector: SecretProtector = protector,
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
    const transport = config.version === 2
      ? migrateV2(config, this.defaults)
      : {
          relayEndpoints: refreshV3Endpoints(config, this.defaults),
          activeEndpoint: config.activeEndpoint,
          serviceOrigin: this.defaults.publicRelayUrl
            ? this.defaults.serviceOrigin || config.serviceOrigin || ""
            : config.serviceOrigin || this.defaults.serviceOrigin || "",
          // Preserve explicit ICE choices, but move the old packaged
          // Cloudflare-only default to the current self-hosted-first list.
          iceServers: preferredBridgeIceServers(
            config.iceServers,
            this.defaults.iceServers?.length
              ? this.defaults.iceServers
              : DEFAULT_BRIDGE_ICE_SERVERS,
          ),
          ...(config.migratedAt !== undefined ? { migratedAt: config.migratedAt } : {}),
        };
    const active = (
      this.defaults.publicRelayUrl
        ? transport.relayEndpoints.find((endpoint) => endpoint.kind === "public-relay")
        : undefined
    ) ?? selectBridgeEndpoint(transport.relayEndpoints, transport.activeEndpoint);
    if (!active) throw new Error("No active relay endpoint is configured");
    if (config.version !== CONFIG_VERSION || config.protocolVersion !== PROTOCOL_VERSION) {
      const rotated = await BridgeCrypto.createHost(active.url, config.desktopName);
      const migrated: LoadedDesktopConfig = {
        configVersion: CONFIG_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        pairingEpoch: 1,
        roomId: rotated.crypto.identity.roomId,
        serviceOrigin: transport.serviceOrigin || serviceOriginForRelay(active.url),
        relayEndpoints: transport.relayEndpoints,
        activeEndpoint: active.id,
        iceServers: transport.iceServers,
        migratedAt: Date.now(),
        relayUrl: active.url,
        desktopName: config.desktopName,
        hostDeviceId: config.hostDeviceId,
        hostSecret: rotated.secret,
        evidenceKey: randomBytes(32).toString("base64url"),
        createdAt: config.createdAt,
        launchAtLogin: config.launchAtLogin,
        managedDesktopEnabled: false,
        defaultPermissionMode: "standard",
        runtimePermissionModes: {},
        devices: [],
      };
      await this.save(migrated);
      return migrated;
    }
    const loaded: LoadedDesktopConfig = {
      configVersion: CONFIG_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      pairingEpoch: config.pairingEpoch,
      roomId: config.roomId,
      serviceOrigin: transport.serviceOrigin || serviceOriginForRelay(active.url),
      relayEndpoints: transport.relayEndpoints,
      activeEndpoint: active.id,
      iceServers: transport.iceServers,
      ...(transport.migratedAt !== undefined ? { migratedAt: transport.migratedAt } : {}),
      relayUrl: active.url,
      desktopName: config.desktopName,
      hostDeviceId: config.hostDeviceId,
      hostSecret: this.protector.unprotect(config.protectedHostSecret),
      evidenceKey: config.protectedEvidenceKey
        ? this.evidenceProtector.unprotect(config.protectedEvidenceKey)
        : randomBytes(32).toString("base64url"),
      createdAt: config.createdAt,
      launchAtLogin: config.launchAtLogin,
      // The unsupported managed Desktop experiment remains disabled during upgrade.
      managedDesktopEnabled: false,
      defaultPermissionMode: config.defaultPermissionMode ?? "standard",
      runtimePermissionModes: config.runtimePermissionModes ?? {},
      devices: config.devices.map((device) => loadDevice(device, this.protector)),
    };
    const storedIceServers = normalizeBridgeIceServers(config.iceServers);
    const iceServersMigrated = JSON.stringify(storedIceServers) !== JSON.stringify(transport.iceServers);
    if (!config.protectedEvidenceKey || iceServersMigrated) await this.save(loaded);
    return loaded;
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
    const relayEndpoints = defaultEndpoints(this.defaults);
    const active = selectBridgeEndpoint(
      relayEndpoints,
      relayEndpoints.find((endpoint) => endpoint.kind === "public-relay")?.id,
    );
    if (!active) throw new Error("No default relay endpoint is configured");
    const { crypto, secret } = await BridgeCrypto.createHost(active.url, this.defaults.desktopName);
    const loaded: LoadedDesktopConfig = {
      configVersion: CONFIG_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      pairingEpoch: 1,
      roomId: crypto.identity.roomId,
      serviceOrigin: this.defaults.serviceOrigin ?? serviceOriginForRelay(active.url),
      relayEndpoints,
      activeEndpoint: active.id,
      relayUrl: active.url,
      iceServers: normalizeBridgeIceServers(this.defaults.iceServers),
      desktopName: crypto.identity.desktopName,
      hostDeviceId: crypto.identity.deviceId,
      hostSecret: secret,
      evidenceKey: randomBytes(32).toString("base64url"),
      createdAt: Date.now(),
      launchAtLogin,
      managedDesktopEnabled: false,
      defaultPermissionMode: "standard",
      runtimePermissionModes: {},
      devices: [],
    };
    await this.save(loaded);
    return loaded;
  }

  async save(config: LoadedDesktopConfig): Promise<void> {
    const endpoints = normalizeBridgeEndpoints(config.relayEndpoints);
    const active = selectBridgeEndpoint(endpoints, config.activeEndpoint);
    if (!active) throw new Error("No active relay endpoint is configured");
    const stored: DesktopConfigFileV4 = {
      version: CONFIG_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      pairingEpoch: config.pairingEpoch,
      roomId: config.roomId,
      serviceOrigin: config.serviceOrigin,
      relayEndpoints: endpoints,
      activeEndpoint: active.id,
      iceServers: normalizeBridgeIceServers(config.iceServers),
      ...(config.migratedAt !== undefined ? { migratedAt: config.migratedAt } : {}),
      desktopName: config.desktopName,
      hostDeviceId: config.hostDeviceId,
      protectedHostSecret: this.protector.protect(config.hostSecret),
      protectedEvidenceKey: this.evidenceProtector.protect(config.evidenceKey),
      createdAt: config.createdAt,
      launchAtLogin: config.launchAtLogin,
      managedDesktopEnabled: config.managedDesktopEnabled,
      defaultPermissionMode: config.defaultPermissionMode,
      ...(Object.keys(config.runtimePermissionModes).length
        ? { runtimePermissionModes: config.runtimePermissionModes }
        : {}),
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
        ...(device.publicRelayClaimedAt !== undefined
          ? { publicRelayClaimedAt: device.publicRelayClaimedAt }
          : {}),
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
