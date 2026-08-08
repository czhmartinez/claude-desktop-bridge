import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DesktopConfigRepository,
  fileSecretProtector,
  safeStorageSecretProtector,
  type SecretProtector,
} from "./config.js";
import { removeLegacyConnector } from "./connector.js";

const directories: string[] = [];
const protector: SecretProtector = {
  available: () => true,
  protect: (value) => `test:${Buffer.from(value).toString("base64")}`,
  unprotect: (value) => Buffer.from(value.slice(5), "base64").toString("utf8"),
};

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("desktop configuration", () => {
  it("uses a protected mode-0600 file fallback without plaintext secrets", () => {
    const fileProtector = fileSecretProtector();
    const protectedValue = fileProtector.protect("host-secret");

    expect(protectedValue).toMatch(/^file:/u);
    expect(protectedValue).not.toContain("host-secret");
    expect(fileProtector.unprotect(protectedValue)).toBe("host-secret");
  });

  it("uses Electron safeStorage for the evidence key when available", () => {
    const storage = {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(`sealed:${value}`, "utf8"),
      decryptString: (value: Buffer) => value.toString("utf8").slice("sealed:".length),
    };
    const safeProtector = safeStorageSecretProtector(storage);
    const protectedValue = safeProtector.protect("evidence-master-key");

    expect(protectedValue).toMatch(/^os:/u);
    expect(protectedValue).not.toContain("evidence-master-key");
    expect(safeProtector.unprotect(protectedValue)).toBe("evidence-master-key");
  });

  it("keeps transport identities in the mode-0600 config and seals only the evidence key", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-config-"));
    directories.push(directory);
    const path = join(directory, "bridge-config.json");
    const evidenceProtector = safeStorageSecretProtector({
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(`sealed:${value}`, "utf8"),
      decryptString: (value: Buffer) => value.toString("utf8").slice("sealed:".length),
    });
    const repository = new DesktopConfigRepository(
      path,
      fileSecretProtector(),
      {
        relayUrl: "wss://relay.example/ws",
        desktopName: "Test PC",
      },
      evidenceProtector,
    );
    await repository.loadOrCreate();
    const stored = JSON.parse(await readFile(path, "utf8")) as {
      protectedHostSecret: string;
      protectedEvidenceKey: string;
    };

    expect(stored.protectedHostSecret).toMatch(/^file:/u);
    expect(stored.protectedEvidenceKey).toMatch(/^os:/u);
    await expect(repository.load()).resolves.toBeTruthy();
  });

  it("persists the host secret and independent device secrets in protected form", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-config-"));
    directories.push(directory);
    const path = join(directory, "bridge-config.json");
    const repository = new DesktopConfigRepository(path, protector, {
      relayUrl: "wss://relay.example/ws",
      desktopName: "Test PC",
    });
    const created = await repository.loadOrCreate();
    created.devices.push({
      deviceId: "phone-1",
      name: "Android",
      platform: "android",
      secret: "independent-device-secret",
      createdAt: 1_000,
      expiresAt: 2_000,
    });
    await repository.save(created);
    const raw = await readFile(path, "utf8");

    expect(raw).not.toContain(created.hostSecret);
    expect(raw).not.toContain(created.evidenceKey);
    expect(raw).not.toContain("independent-device-secret");
    expect((await repository.load())?.devices[0]?.secret).toBe("independent-device-secret");
  });

  it("persists the computer permission mode across restarts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-config-"));
    directories.push(directory);
    const path = join(directory, "bridge-config.json");
    const repository = new DesktopConfigRepository(path, protector, {
      relayUrl: "wss://relay.example/ws",
      desktopName: "Test PC",
    });
    const created = await repository.loadOrCreate();
    expect(created.defaultPermissionMode).toBe("standard");

    created.defaultPermissionMode = "full-access";
    await repository.save(created);

    expect((await repository.load())?.defaultPermissionMode).toBe("full-access");
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      version: 4,
      defaultPermissionMode: "full-access",
    });
  });

  it("refreshes a stale LAN relay address without rotating pairing secrets", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-config-"));
    directories.push(directory);
    const path = join(directory, "bridge-config.json");
    const original = new DesktopConfigRepository(path, protector, {
      relayUrl: "ws://192.168.1.32:8788/ws",
      desktopName: "Test PC",
    });
    const created = await original.loadOrCreate();
    await original.save(created);

    const movedNetwork = new DesktopConfigRepository(path, protector, {
      relayUrl: "ws://10.245.46.37:8788/ws",
      desktopName: "Test PC",
    });
    const loaded = await movedNetwork.load();

    expect(loaded?.relayUrl).toBe("ws://10.245.46.37:8788/ws");
    expect(loaded?.roomId).toBe(created.roomId);
    expect(loaded?.hostSecret).toBe(created.hostSecret);
  });

  it("does not replace an explicit remote relay with the packaged default", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-config-"));
    directories.push(directory);
    const path = join(directory, "bridge-config.json");
    const remote = new DesktopConfigRepository(path, protector, {
      relayUrl: "wss://relay.example/ws",
      desktopName: "Test PC",
    });
    const created = await remote.loadOrCreate();
    await remote.save(created);

    const localDefault = new DesktopConfigRepository(path, protector, {
      relayUrl: "ws://10.245.46.37:8788/ws",
      desktopName: "Test PC",
    });

    expect((await localDefault.load())?.relayUrl).toBe("wss://relay.example/ws");
  });

  it("migrates v2 to pairing schema v4 while preserving host identity and rotating credentials", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-config-"));
    directories.push(directory);
    const path = join(directory, "bridge-config.json");
    await writeFile(path, JSON.stringify({
      version: 2,
      protocolVersion: 2,
      roomId: "room-legacy-12345678",
      relayUrl: "ws://192.168.1.32:8788/ws",
      desktopName: "Test PC",
      hostDeviceId: "desktop-1",
      protectedHostSecret: protector.protect("host-secret"),
      createdAt: 1_000,
      launchAtLogin: false,
      devices: [{
        deviceId: "phone-1",
        name: "Android",
        platform: "android",
        protectedSecret: protector.protect("phone-secret"),
        createdAt: 1_100,
        expiresAt: 601_100,
        pairedAt: 2_000,
      }],
    }));
    const repository = new DesktopConfigRepository(path, protector, {
      relayUrl: "ws://10.0.0.8:8788/ws",
      publicRelayUrl: "wss://bridge.example/ws",
      serviceOrigin: "https://bridge.example",
      iceServers: [{ urls: "stun:stun.example:3478" }],
      desktopName: "Test PC",
    });

    const loaded = await repository.loadOrCreate();
    expect(loaded).toMatchObject({
      configVersion: 4,
      protocolVersion: 3,
      pairingEpoch: 1,
      hostDeviceId: "desktop-1",
      relayUrl: "wss://bridge.example/ws",
      activeEndpoint: "public",
      serviceOrigin: "https://bridge.example",
      iceServers: [{ urls: "stun:stun.example:3478" }],
    });
    expect(loaded.roomId).not.toBe("room-legacy-12345678");
    expect(loaded.hostSecret).not.toBe("host-secret");
    expect(loaded.evidenceKey).toBeTruthy();
    expect(loaded.devices).toEqual([]);
    expect(loaded.relayEndpoints).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "public", kind: "public-relay" }),
      expect.objectContaining({ kind: "lan-relay", url: "ws://10.0.0.8:8788/ws" }),
    ]));

    await repository.save(loaded);
    const persisted = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    expect(persisted.version).toBe(4);
    expect(persisted.protocolVersion).toBe(3);
    expect(persisted).not.toHaveProperty("relayUrl");
    expect(JSON.stringify(persisted)).not.toContain("host-secret");
    expect(JSON.stringify(persisted)).not.toContain("phone-secret");
    expect(JSON.stringify(persisted)).not.toContain(loaded.evidenceKey);
  });

  it("migrates an existing public relay to a lower-priority fallback", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-config-"));
    directories.push(directory);
    const path = join(directory, "bridge-config.json");
    const legacy = new DesktopConfigRepository(path, protector, {
      relayUrl: "wss://relay.alioxis.uk/ws",
      desktopName: "Test PC",
    });
    const created = await legacy.loadOrCreate();
    await legacy.save(created);

    const publicBuild = new DesktopConfigRepository(path, protector, {
      relayUrl: "ws://192.168.1.32:8788/ws",
      publicRelayUrl: "wss://relay.alioxis.com/ws",
      serviceOrigin: "https://relay.alioxis.com",
      iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
      desktopName: "Test PC",
    });
    const loaded = await publicBuild.load();

    expect(loaded).toMatchObject({
      roomId: created.roomId,
      hostSecret: created.hostSecret,
      relayUrl: "wss://relay.alioxis.com/ws",
      serviceOrigin: "https://relay.alioxis.com",
      iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
    });
    expect(loaded?.relayEndpoints).toEqual(expect.arrayContaining([
      {
        id: "public",
        kind: "public-relay",
        url: "wss://relay.alioxis.com/ws",
        priority: 10,
      },
      {
        id: "legacy-public-0",
        kind: "public-relay",
        url: "wss://relay.alioxis.uk/ws",
        priority: 30,
      },
    ]));

    await publicBuild.save(loaded!);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      activeEndpoint: "public",
      serviceOrigin: "https://relay.alioxis.com",
      relayEndpoints: expect.arrayContaining([
        expect.objectContaining({ id: "legacy-public-0", url: "wss://relay.alioxis.uk/ws" }),
      ]),
    });
  });

  it("disables the retired managed Desktop experiment during upgrade", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-config-"));
    directories.push(directory);
    const path = join(directory, "bridge-config.json");
    const repository = new DesktopConfigRepository(path, protector, {
      relayUrl: "wss://relay.example/ws",
      desktopName: "Test PC",
    });
    const created = await repository.loadOrCreate();
    created.managedDesktopEnabled = true;
    await repository.save(created);

    expect((await repository.load())?.managedDesktopEnabled).toBe(false);
  });

  it("archives a v1 config and requires one-time re-pairing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-config-"));
    directories.push(directory);
    const path = join(directory, "bridge-config.json");
    await writeFile(path, JSON.stringify({ version: 1, pairing: {} }));
    const repository = new DesktopConfigRepository(path, protector, {
      relayUrl: "wss://relay.example/ws",
      desktopName: "Test PC",
    });
    const created = await repository.loadOrCreate();

    expect(created.protocolVersion).toBe(3);
    expect(created.configVersion).toBe(4);
    expect(created.devices).toEqual([]);
    expect((await import("node:fs/promises").then(({ readdir }) => readdir(directory))))
      .toEqual(expect.arrayContaining([expect.stringMatching(/^bridge-config\.json\.v1-archive-/u)]));
  });

  it("only removes Bridge-owned MCP and HTTP hook entries", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-connector-"));
    directories.push(directory);
    const desktop = join(directory, "desktop.json");
    const code = join(directory, "code.json");
    const settings = join(directory, "settings.json");
    await writeFile(desktop, JSON.stringify({
      preferences: { theme: "dark" },
      mcpServers: { "claude-bridge": { command: "Bridge" }, keep: { command: "keep" } },
    }));
    await writeFile(code, JSON.stringify({ mcpServers: { "claude-bridge": { command: "Bridge" } } }));
    await writeFile(settings, JSON.stringify({
      hooks: {
        SessionStart: [{
          hooks: [
            { type: "http", url: "http://127.0.0.1:8790/hooks/claude" },
            { type: "command", command: "keep-me" },
          ],
        }],
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "also-keep" }] }],
      },
    }));
    const changed = await removeLegacyConnector({
      claudeDesktop: [desktop],
      claudeCode: code,
      claudeSettings: settings,
    });
    const desktopConfig = JSON.parse(await readFile(desktop, "utf8")) as Record<string, unknown>;
    const settingsConfig = JSON.parse(await readFile(settings, "utf8")) as {
      hooks: Record<string, Array<{ hooks: Array<Record<string, unknown>> }>>;
    };

    expect(changed).toBe(true);
    expect((desktopConfig.mcpServers as Record<string, unknown>).keep).toBeDefined();
    expect((desktopConfig.mcpServers as Record<string, unknown>)["claude-bridge"]).toBeUndefined();
    expect(settingsConfig.hooks.SessionStart?.[0]?.hooks).toEqual([{ type: "command", command: "keep-me" }]);
    expect(settingsConfig.hooks.PreToolUse?.[0]?.hooks).toEqual([{ type: "command", command: "also-keep" }]);
  });
});
