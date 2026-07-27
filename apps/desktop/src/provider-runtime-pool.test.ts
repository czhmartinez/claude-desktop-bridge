import { describe, expect, it } from "vitest";
import type { BridgeExecutionLane } from "@bridge/protocol";
import {
  ClaudeOfficialProviderAdapter,
  ProviderRuntimePool,
} from "./provider-runtime-pool.js";
import type { ProviderRegistry } from "./provider-registry.js";

const apiLane: BridgeExecutionLane = {
  laneId: "lane-api",
  conversationId: "conversation-1",
  providerProfileId: "provider:anthropic-api:default",
  providerKind: "anthropic-api",
  status: "active",
  access: "read-write",
  nativeSessionId: "22222222-2222-4222-8222-222222222222",
  createdAt: 1,
  updatedAt: 1,
};

describe("ProviderRuntimePool", () => {
  it("uses the Agent SDK runtime with only the explicit API key for API lanes", async () => {
    const registry = {
      anthropicApiKey: async () => "sk-ant-local-only",
    } as ProviderRegistry;
    const pool = new ProviderRuntimePool(registry);
    const plan = await pool.hostPlan("conversation-1", apiLane, {
      executablePath: "/usr/local/bin/claude",
      credentialPath: "/private/host-creds.json",
      environment: {
        ANTHROPIC_AUTH_TOKEN: "host-token",
        CLAUDE_CODE_HOST_CREDS_FILE: "/private/host-creds.json",
        CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1",
        PATH: "/usr/bin",
      },
    });

    expect(plan.nativeSessionId).toBe(apiLane.nativeSessionId);
    expect(plan.environment.ANTHROPIC_API_KEY).toBe("sk-ant-local-only");
    expect(plan.environment.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(plan.environment.CLAUDE_CODE_HOST_CREDS_FILE).toBeUndefined();
    expect(plan.environment.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST).toBeUndefined();
  });

  it("builds only the public Claude Deep Link and enforces its prompt bound", () => {
    const official = new ClaudeOfficialProviderAdapter();
    const deepLink = new URL(official.deepLink("/tmp/project one", "handoff-opaque-id"));
    expect(deepLink.protocol).toBe("claude:");
    expect(deepLink.pathname).toBe("/new");
    expect(deepLink.searchParams.get("folder")).toBe("/tmp/project one");
    expect(deepLink.searchParams.get("q")).toBe("handoff-opaque-id");
    expect(() => official.deepLink("/tmp/project", "x".repeat(12_001))).toThrow("12,000");
  });
});
