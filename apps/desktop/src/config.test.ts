import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DesktopConfigRepository, fileSecretProtector, type SecretProtector } from "./config.js";
import { connectorInstallationState, installConnector } from "./connector.js";

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
  it("uses a user-file protector without invoking an operating-system keychain", () => {
    const fileProtector = fileSecretProtector();
    const protectedValue = fileProtector.protect("pairing-secret");

    expect(protectedValue).toMatch(/^file:/u);
    expect(protectedValue).not.toContain("pairing-secret");
    expect(fileProtector.unprotect(protectedValue)).toBe("pairing-secret");
    expect(() => fileProtector.unprotect("os:legacy-value")).toThrow("Unsupported secret protection format");
  });

  it("persists a protected pairing secret", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-config-"));
    directories.push(directory);
    const path = join(directory, "bridge-config.json");
    const repository = new DesktopConfigRepository(path, protector, { relayUrl: "wss://relay.example/ws", desktopName: "Test PC" });
    const created = await repository.loadOrCreate();
    const raw = await readFile(path, "utf8");

    expect(raw).not.toContain(created.pairing.secret);
    expect((await repository.load())?.pairing).toEqual(created.pairing);
  });

  it("migrates an old loopback pairing to the current LAN relay without replacing its secret", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-config-"));
    directories.push(directory);
    const path = join(directory, "bridge-config.json");
    const oldRepository = new DesktopConfigRepository(path, protector, { relayUrl: "ws://127.0.0.1:8788/ws", desktopName: "Test PC" });
    const created = await oldRepository.loadOrCreate();
    const repository = new DesktopConfigRepository(path, protector, { relayUrl: "ws://192.168.1.20:8788/ws", desktopName: "Test PC" });
    const migrated = await repository.loadOrCreate();

    expect(migrated.pairing.roomId).toBe(created.pairing.roomId);
    expect(migrated.pairing.secret).toBe(created.pairing.secret);
    expect(migrated.pairing.relayUrl).toBe("ws://192.168.1.20:8788/ws");
  });

  it("persists paired-phone timestamps", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-config-"));
    directories.push(directory);
    const path = join(directory, "bridge-config.json");
    const repository = new DesktopConfigRepository(path, protector, { relayUrl: "wss://relay.example/ws", desktopName: "Test PC" });
    const config = await repository.loadOrCreate();
    config.mobilePairedAt = 1_000;
    config.mobileLastSeenAt = 2_000;
    await repository.save(config);

    expect(await repository.load()).toEqual(expect.objectContaining({ mobilePairedAt: 1_000, mobileLastSeenAt: 2_000 }));
  });

  it("merges the connector without replacing existing settings", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-connector-"));
    directories.push(directory);
    const desktop = join(directory, "desktop.json");
    const desktop3p = join(directory, "desktop-3p.json");
    const code = join(directory, "code.json");
    const settings = join(directory, "settings.json");
    await import("node:fs/promises").then(({ writeFile }) => writeFile(desktop, JSON.stringify({ preferences: { theme: "dark" } })));
    await import("node:fs/promises").then(({ writeFile }) => writeFile(settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [] }] } })));
    const spec = { command: "/Applications/Bridge", args: ["--mcp"] };
    const hook = { url: "http://127.0.0.1:8790/hooks/claude", authorization: "Bearer test-token" };
    const paths = { claudeDesktop: [desktop, desktop3p], claudeCode: code, claudeSettings: settings };
    await installConnector(paths, spec, hook);
    const updated = JSON.parse(await readFile(desktop, "utf8")) as Record<string, unknown>;
    const updatedSettings = JSON.parse(await readFile(settings, "utf8")) as { hooks: Record<string, unknown[]> };

    expect(updated.preferences).toEqual({ theme: "dark" });
    expect((updated.mcpServers as Record<string, unknown>)["claude-bridge"]).toEqual(spec);
    expect(updatedSettings.hooks.PreToolUse).toHaveLength(1);
    expect(updatedSettings.hooks.SessionStart).toEqual([{
      hooks: [{
        type: "http",
        url: hook.url,
        headers: { Authorization: hook.authorization },
        timeout: 5,
      }],
    }]);
    expect(await connectorInstallationState(paths, spec, hook)).toBe("installed");
  });
});
