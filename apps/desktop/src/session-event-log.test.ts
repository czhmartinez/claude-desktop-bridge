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

  it("compacts an oversized log, dropping registration churn and stream deltas", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-events-"));
    directories.push(directory);
    const path = join(directory, "events.jsonl");
    const first = new SessionEventLog(path, 1);
    // Junk that used to flood the log: no-op registration events and deltas.
    for (let index = 0; index < 5; index += 1) {
      await first.append({
        sessionId: "session-1",
        origin: "system",
        type: "session.desktop-registration",
        data: { state: "registered", updatedAt: index },
      });
    }
    await first.append({
      sessionId: "session-1",
      origin: "claude-host",
      type: "assistant.delta",
      itemId: "assistant-1",
      data: { text: "partial" },
    });
    await first.append({
      sessionId: "session-1",
      origin: "mobile",
      type: "user.message.accepted",
      itemId: "user-1",
      data: { text: "Continue" },
    });
    await first.append({
      sessionId: "session-1",
      origin: "claude-host",
      type: "assistant.completed",
      itemId: "assistant-1",
      data: { text: "Done" },
    });
    const lastSeq = first.latestSeq();
    await first.close();

    // A 1-byte threshold forces the compaction path on reopen.
    const reopened = new SessionEventLog(path, 80, { bytesThreshold: 1 });
    await reopened.initialize();
    expect(reopened.replay().map((event) => event.type)).toEqual([
      "user.message.accepted",
      "assistant.completed",
    ]);
    // Sequences stay monotonic across compaction; dedup indexes survive.
    expect(reopened.latestSeq()).toBe(lastSeq);
    expect(reopened.hasItem("session-1", "user.message.accepted", "user-1")).toBe(true);
    expect(reopened.latestItem("session-1", "assistant.completed", "assistant-1")).toMatchObject({
      data: { text: "Done" },
    });
    await reopened.append({
      sessionId: "session-1",
      origin: "system",
      type: "session.archived",
      data: { sessionId: "session-1", archived: true, archivedAt: 1 },
    });
    expect(reopened.latestSeq()).toBe(lastSeq + 1);
    await reopened.close();
  });

  it("keeps only the bounded tail when the retained window overflows", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-events-"));
    directories.push(directory);
    const path = join(directory, "events.jsonl");
    const first = new SessionEventLog(path, 1);
    for (let index = 0; index < 6; index += 1) {
      await first.append({
        sessionId: "session-1",
        origin: "claude-desktop",
        type: "session.observed",
        itemId: `message-${index}`,
        data: { role: "assistant", text: `m${index}` },
      });
    }
    await first.close();

    const reopened = new SessionEventLog(path, 80, { bytesThreshold: 1, retainEvents: 3 });
    await reopened.initialize();
    expect(reopened.replay().map((event) => event.data.text)).toEqual(["m3", "m4", "m5"]);
    expect(reopened.latestSeq()).toBe(6);
    await reopened.close();
  });
});
