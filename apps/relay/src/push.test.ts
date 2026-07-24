import { describe, expect, it } from "vitest";
import { apnsWakeRequestBody, fcmWakeRequestBody } from "./push.js";

describe("content-free push wake payloads", () => {
  it("contains only a wake marker for Android", () => {
    const payload = fcmWakeRequestBody("device-token");
    expect(payload).toEqual({
      message: {
        token: "device-token",
        data: { type: "bridge-wake" },
        android: { priority: "high" },
      },
    });
    expect(JSON.stringify(payload)).not.toMatch(/session|title|body|message text/iu);
  });

  it("uses an empty background notification for iOS", () => {
    expect(apnsWakeRequestBody()).toEqual({ aps: { "content-available": 1 } });
  });
});
