import { describe, expect, it } from "vitest";
import { StreamEntrance, STREAM_ENTRANCE_BULK_THRESHOLD } from "./stream-entrance.js";

describe("StreamEntrance", () => {
  it("plays no entrance on a view's first paint", () => {
    const tracker = new StreamEntrance();
    expect(tracker.entering("session-1", ["a", "b", "c"])).toEqual(new Set());
  });

  it("marks only items appended after the first paint", () => {
    const tracker = new StreamEntrance();
    tracker.entering("session-1", ["a", "b"]);
    expect(tracker.entering("session-1", ["a", "b", "c"])).toEqual(new Set(["c"]));
    // A repeat render of the same keys animates nothing.
    expect(tracker.entering("session-1", ["a", "b", "c"])).toEqual(new Set());
  });

  it("reseeds on session switches so existing history never animates", () => {
    const tracker = new StreamEntrance();
    tracker.entering("session-1", ["a"]);
    expect(tracker.entering("session-2", ["x", "y", "z"])).toEqual(new Set());
    expect(tracker.entering("session-2", ["x", "y", "z", "n"])).toEqual(new Set(["n"]));
    // Switching back reseeds again — no replay of session-1's history.
    expect(tracker.entering("session-1", ["a"])).toEqual(new Set());
  });

  it("suppresses bulk arrivals (initial load, load-older) above the threshold", () => {
    const tracker = new StreamEntrance();
    tracker.entering("session-1", ["a"]);
    const bulk = ["a", ...Array.from({ length: STREAM_ENTRANCE_BULK_THRESHOLD + 1 }, (_, index) => `h${index}`)];
    expect(tracker.entering("session-1", bulk)).toEqual(new Set());
    // ...but the next single append still animates.
    expect(tracker.entering("session-1", [...bulk, "tail"])).toEqual(new Set(["tail"]));
  });
});
