/**
 * Live contract test against a running DSH Desktop host. Skipped unless
 * BRIDGE_DSH_REAL=1; creates a throwaway session in the OS temp dir and runs
 * one minimal turn end to end through the real adapter + real wire format.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DshDesktopAdapter, discoverRunningDshGateway } from "./dsh-desktop-adapter.js";
import type { RuntimeAdapterEvent } from "./runtime-adapter.js";

const live = process.env.BRIDGE_DSH_REAL === "1";

describe("DshDesktopAdapter (live DSH host)", () => {
  it.skipIf(!live)("discovers the host, runs a turn, and reports usage + history", async () => {
    const gatewayUrl = await discoverRunningDshGateway();
    expect(gatewayUrl).toBeTruthy();
    const adapter = new DshDesktopAdapter({
      discoverGatewayUrl: async () => gatewayUrl,
    });
    const events: RuntimeAdapterEvent[] = [];
    adapter.on("event", (event) => events.push(event));
    try {
      await adapter.initialize();
      expect(adapter.status().state).toBe("ready");
      expect(adapter.status().capabilities).toContain("attachment.image");
      const cwd = await mkdtemp(join(tmpdir(), "bridge-dsh-real-"));
      const session = await adapter.createSession({ cwd, title: "bridge-live-probe" });
      expect(session.nativeSessionId).toMatch(/^session-/u);
      const turn = await adapter.startTurn({
        nativeSessionId: session.nativeSessionId,
        text: "只回复两个字：完成。不要调用任何工具。",
        commandId: `live-${Date.now()}`,
        requestId: `live-req-${Date.now()}`,
      });
      expect(turn.state).toBe("running");
      const deadline = Date.now() + 120_000;
      let completed: Extract<RuntimeAdapterEvent, { type: "turn.completed" }> | undefined;
      while (Date.now() < deadline && !completed) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        completed = events.find((event): event is Extract<RuntimeAdapterEvent, { type: "turn.completed" }> => event.type === "turn.completed");
      }
      expect(completed).toBeTruthy();
      expect(completed?.usage?.outputTokens).toBeGreaterThan(0);
      expect(events.some((event) => event.type === "assistant.completed")).toBe(true);
      const items = await adapter.history(session.nativeSessionId);
      expect(items.some((item) => item.role === "user" && item.text.includes("完成"))).toBe(true);
      expect(items.some((item) => item.role === "assistant" && item.text.includes("完成"))).toBe(true);
      const configuration = await adapter.configuration(session.nativeSessionId);
      expect(configuration.availableModels.length).toBeGreaterThan(0);
      expect(configuration.provider).toBeTruthy();
    } finally {
      await adapter.close();
    }
  }, 150_000);
});
