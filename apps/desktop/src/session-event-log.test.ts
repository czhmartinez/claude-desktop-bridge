import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionEventLog } from "./session-event-log.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("SessionEventLog", () => {
  it("persists monotonic events and resumes after a cursor", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-events-"));
    directories.push(directory);
    const path = join(directory, "events.jsonl");
    const first = new SessionEventLog(path, 1);
    await first.append({
      sessionId: "session-1",
      origin: "mobile",
      type: "user.message.accepted",
      itemId: "user-1",
      data: { text: "Continue" },
    });
    first.appendCoalescedDelta({
      sessionId: "session-1",
      origin: "claude-host",
      type: "assistant.delta",
      itemId: "assistant-1",
    }, "Hel");
    first.appendCoalescedDelta({
      sessionId: "session-1",
      origin: "claude-host",
      type: "assistant.delta",
      itemId: "assistant-1",
    }, "lo");
    await first.flushDeltas();
    await first.append({
      sessionId: "session-1",
      origin: "claude-desktop",
      type: "session.observed",
      itemId: "interrupted-control",
      data: { role: "user", text: "[Request interrupted by user]" },
    });
    await first.append({
      sessionId: "session-1",
      origin: "claude-desktop",
      type: "session.observed",
      itemId: "synthetic-control",
      data: { role: "assistant", text: "No response requested." },
    });
    await first.close();

    const reopened = new SessionEventLog(path);
    await reopened.initialize();
    expect(reopened.replay()).toHaveLength(4);
    expect(reopened.replay(1)[0]).toMatchObject({ seq: 2, data: { text: "Hello" } });
    expect(reopened.latestItem("session-1", "user.message.accepted", "user-1")).toMatchObject({
      seq: 1,
      data: { text: "Continue" },
    });
    expect(reopened.history("session-1").items).toMatchObject([
      { role: "user", text: "Continue" },
    ]);
    await reopened.close();
  });
});
