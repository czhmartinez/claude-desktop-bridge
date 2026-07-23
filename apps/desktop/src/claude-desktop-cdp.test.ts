import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { ClaudeDesktopCdpAdapter, CdpPipeClient } from "./claude-desktop-cdp.js";

const requiredMethods = [
  "start",
  "getAll",
  "getSession",
  "getTranscript",
  "getTranscriptTail",
  "sendMessage",
  "interrupt",
  "setModel",
  "setEffort",
  "getContextUsage",
  "onOnEvent",
  "onOnToolPermissionRequest",
  "respondToToolPermission",
];

function response(
  reader: PassThrough,
  value: Record<string, unknown>,
  split = false,
): void {
  const encoded = Buffer.from(`${JSON.stringify(value)}\0`);
  if (!split) {
    reader.write(encoded);
    return;
  }
  const middle = Math.max(1, Math.floor(encoded.length / 2));
  reader.write(encoded.subarray(0, middle));
  queueMicrotask(() => reader.write(encoded.subarray(middle)));
}

describe("Claude Desktop CDP pipe", () => {
  it("uses null-delimited requests and accepts split responses", async () => {
    const reader = new PassThrough();
    const writer = new PassThrough();
    const client = new CdpPipeClient({ reader, writer });
    let raw = "";
    writer.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
      const delimiter = raw.indexOf("\0");
      if (delimiter < 0) return;
      const request = JSON.parse(raw.slice(0, delimiter)) as { id: number; method: string };
      response(reader, { id: request.id, result: { acknowledged: request.method } }, true);
    });

    await expect(client.request("Runtime.enable")).resolves.toEqual({
      acknowledged: "Runtime.enable",
    });
    expect(raw.endsWith("\0")).toBe(true);
    client.shutdown();
  });

  it("handshakes with LocalSessions, validates its shape, and forwards renderer events", async () => {
    const reader = new PassThrough();
    const writer = new PassThrough();
    const client = new CdpPipeClient({ reader, writer });
    const adapter = new ClaudeDesktopCdpAdapter(client);
    let input = "";
    let bindingName = "";

    writer.on("data", (chunk: Buffer) => {
      input += chunk.toString("utf8");
      let delimiter = input.indexOf("\0");
      while (delimiter >= 0) {
        const raw = input.slice(0, delimiter);
        input = input.slice(delimiter + 1);
        const request = JSON.parse(raw) as {
          id: number;
          method: string;
          sessionId?: string;
          params?: Record<string, unknown>;
        };
        let result: Record<string, unknown> = {};
        if (request.method === "Target.getTargets") {
          result = {
            targetInfos: [{
              targetId: "target-main",
              type: "page",
              url: "app://localhost/index.html",
            }],
          };
        } else if (request.method === "Target.attachToTarget") {
          result = { sessionId: "renderer-1" };
        } else if (request.method === "Runtime.addBinding") {
          bindingName = String(request.params?.name ?? "");
        } else if (request.method === "Runtime.evaluate") {
          const expression = String(request.params?.expression ?? "");
          if (expression === "globalThis['claude.web']?.LocalSessions") {
            result = { result: { type: "object", objectId: "local-sessions-1" } };
          } else if (expression.includes("const required")) {
            result = {
              result: {
                type: "object",
                value: { appVersion: "v22.0.0", methods: requiredMethods },
              },
            };
          } else {
            result = { result: { type: "boolean", value: true } };
          }
        } else if (request.method === "Runtime.callFunctionOn") {
          const args = request.params?.arguments as Array<{ value?: unknown }> | undefined;
          const method = args?.[0]?.value;
          result = {
            result: {
              type: "object",
              value: method === "getAll"
                ? [{ sessionId: "desktop-1", cwd: "/tmp/project", isRunning: false }]
                : undefined,
            },
          };
        }
        response(reader, { id: request.id, result, ...(request.sessionId ? { sessionId: request.sessionId } : {}) });
        if (
          request.method === "Runtime.evaluate" &&
          String(request.params?.expression ?? "").includes("api.onOnEvent")
        ) {
          queueMicrotask(() => response(reader, {
            method: "Runtime.bindingCalled",
            sessionId: "renderer-1",
            params: {
              name: bindingName,
              payload: JSON.stringify({ kind: "binding-ready", payload: { ok: true } }),
            },
          }));
        }
        delimiter = input.indexOf("\0");
      }
    });

    const handshake = await adapter.attach();
    expect(handshake).toMatchObject({
      appVersion: "v22.0.0",
      sessionCount: 1,
      methods: requiredMethods,
    });

    const received = new Promise<unknown>((resolve) => adapter.once("session-event", resolve));
    response(reader, {
      method: "Runtime.bindingCalled",
      sessionId: "renderer-1",
      params: {
        name: bindingName,
        payload: JSON.stringify({
          kind: "event",
          payload: { type: "session_updated", sessionId: "desktop-1" },
        }),
      },
    });
    await expect(received).resolves.toEqual({
      type: "session_updated",
      sessionId: "desktop-1",
    });
    await adapter.detach();
    client.shutdown();
  });
});
