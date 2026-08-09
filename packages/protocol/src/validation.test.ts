import { describe, expect, it } from "vitest";
import { isBridgePayload } from "./validation.js";

describe("isBridgePayload", () => {
  it("accepts 0.7 runtime handoff and goal methods", () => {
    for (const method of [
      "runtime.handoff.preview",
      "runtime.handoff.commit",
      "runtime.handoff.cancel",
      "runtime.handoff.get",
      "runtime.handoff.list",
      "runtime.handoff.confirm",
      "runtime.goal.pause",
      "runtime.goal.resume",
    ]) {
      expect(isBridgePayload({
        kind: "request",
        requestId: `request-${method}`,
        idempotencyKey: `key-${method}`,
        method,
        params: {},
      }), method).toBe(true);
    }
  });

  it("still rejects unknown methods", () => {
    expect(isBridgePayload({
      kind: "request",
      requestId: "request-1",
      idempotencyKey: "key-1",
      method: "runtime.handoff.destroy",
      params: {},
    })).toBe(false);
  });
});
