import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SafeStorageLike } from "./config.js";
import {
  ANTHROPIC_API_PROFILE_ID,
  ConversationStateStore,
} from "./conversation-state-store.js";
import { ProviderRegistry } from "./provider-registry.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

function storage(): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`encrypted:${value}`, "utf8"),
    decryptString: (value) => value.toString("utf8").replace(/^encrypted:/u, ""),
  };
}

async function fixture(fetchImpl: typeof fetch, platform: NodeJS.Platform = "darwin") {
  const root = await mkdtemp(join(tmpdir(), "bridge-providers-"));
  directories.push(root);
  const state = new ConversationStateStore({
    databasePath: join(root, "state.sqlite"),
    sessionsPath: join(root, "sessions.json"),
    queuePath: join(root, "queue.json"),
    masterSecret: "provider-test",
  });
  await state.initialize();
  const apiKeyPath = join(root, "api-key.json");
  const registry = new ProviderRegistry({
    state,
    apiKeyPath,
    safeStorage: storage(),
    claude3pStatus: () => ({
      state: "ready",
      detail: "Ready",
      activeTurns: 0,
      maxParallelTurns: 2,
      desktopIntegration: {
        state: "not-managed",
        detail: "Not managed",
        enabled: false,
        canRestart: true,
      },
    }),
    fetchImpl,
    platform,
  });
  return { root, state, apiKeyPath, registry };
}

describe("ProviderRegistry", () => {
  it("keeps the official Deep Link provider available on Windows", async () => {
    const { state, registry } = await fixture(vi.fn() as unknown as typeof fetch, "win32");
    await registry.initialize();

    expect(registry.get("provider:claude-official:default")).toMatchObject({
      kind: "claude-official",
      status: "ready",
      configured: true,
      readOnly: true,
    });
    state.close();
  });

  it("validates the API key with GET /v1/models and only persists OS ciphertext", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("GET");
      expect(new Headers(init?.headers).get("x-api-key")).toBe("sk-ant-test-123456789012345");
      expect(new Headers(init?.headers).get("anthropic-version")).toBe("2023-06-01");
      return new Response(JSON.stringify({
        data: [{
          id: "claude-sonnet-test",
          display_name: "Claude Sonnet Test",
          created_at: "2026-01-01T00:00:00Z",
          max_input_tokens: 200_000,
          max_tokens: 64_000,
          capabilities: { vision: { supported: true } },
        }],
      }), { status: 200 });
    }) as typeof fetch;
    const { state, apiKeyPath, registry } = await fixture(fetchImpl);
    await registry.initialize();
    const profile = await registry.setAnthropicApiKey("sk-ant-test-123456789012345");

    expect(profile).toMatchObject({
      id: ANTHROPIC_API_PROFILE_ID,
      status: "ready",
      configured: true,
      models: [{
        id: "claude-sonnet-test",
        maxInputTokens: 200_000,
        capabilities: { vision: { supported: true } },
      }],
    });
    const stored = await readFile(apiKeyPath, "utf8");
    expect(stored).toContain("\"protectedKey\": \"os:");
    expect(stored).not.toContain("sk-ant-test");
    expect(await registry.anthropicApiKey()).toBe("sk-ant-test-123456789012345");
    state.close();
  });

  it("rejects plaintext fallback key files instead of decrypting them", async () => {
    const { state, apiKeyPath, registry } = await fixture(vi.fn() as unknown as typeof fetch);
    await writeFile(apiKeyPath, JSON.stringify({
      version: 1,
      protectedKey: `file:${Buffer.from("plaintext-key").toString("base64")}`,
      updatedAt: Date.now(),
    }), "utf8");

    await expect(registry.apiKeys.get()).rejects.toThrow("拒绝明文或降级格式");
    state.close();
  });

  it("does not save a key when model validation fails", async () => {
    const fetchImpl = vi.fn(async () => new Response("unauthorized", { status: 401 })) as typeof fetch;
    const { state, apiKeyPath, registry } = await fixture(fetchImpl);

    await expect(registry.setAnthropicApiKey("sk-ant-invalid-123456789012345"))
      .rejects.toThrow("返回 401");
    await expect(readFile(apiKeyPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    state.close();
  });
});
