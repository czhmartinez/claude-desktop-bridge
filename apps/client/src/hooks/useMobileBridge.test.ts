import type { BridgeEvent } from "@bridge/protocol";
import { describe, expect, it } from "vitest";
import { applyEventToTurns, mergeBridgeEvents, type LocalTurn } from "./useMobileBridge.js";

function event(seq: number, eventId = `event-${seq}`): BridgeEvent {
  return {
    eventId,
    seq,
    timestamp: seq,
    origin: "claude-host",
    type: "assistant.delta",
    data: { text: String(seq) },
  };
}

describe("mergeBridgeEvents", () => {
  it("deduplicates replayed events and restores sequence order", () => {
    expect(mergeBridgeEvents([event(2), event(1)], [event(2), event(3)]).map((item) => item.seq))
      .toEqual([1, 2, 3]);
  });

  it("applies a terminal event only to its matching queued turn", () => {
    const turns: LocalTurn[] = ["one", "two"].map((id) => ({
      requestId: `request-${id}`,
      idempotencyKey: `key-${id}`,
      sessionId: "session-1",
      text: id,
      attachments: [],
      createdAt: 1,
      delivery: "host-received",
      commandId: `command-${id}`,
    }));
    const completed: BridgeEvent = {
      eventId: "completed-one",
      seq: 4,
      timestamp: 4,
      origin: "claude-host",
      type: "turn.completed",
      sessionId: "session-1",
      data: {
        requestId: "request-one",
        commandId: "command-one",
        delivery: "completed",
      },
    };
    expect(applyEventToTurns(turns, completed).map((turn) => turn.delivery))
      .toEqual(["completed", "host-received"]);
  });
});
