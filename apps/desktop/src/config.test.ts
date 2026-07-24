import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DesktopConfigRepository, fileSecretProtector, type SecretProtector } from "./config.js";
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
    expect(raw).not.toContain("independent-device-secret");
    expect((await repository.load())?.devices[0]?.secret).toBe("independent-device-secret");
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

    expect(created.protocolVersion).toBe(2);
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
