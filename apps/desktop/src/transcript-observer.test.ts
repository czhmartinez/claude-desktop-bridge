import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionEventLog } from "./session-event-log.js";
import { TranscriptObserver } from "./transcript-observer.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (!check()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("Timed out waiting for transcript observation");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("TranscriptObserver", () => {
  it("publishes an updated observed message when an assistant chain grows", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-observer-"));
    directories.push(root);
    const desktopSessions = join(root, "desktop-sessions");
    const paths = {
      sessions: join(root, "sessions"),
      tasks: join(root, "tasks"),
      projects: join(root, "projects"),
      desktopSessions: [desktopSessions],
    };
    await Promise.all([
      mkdir(paths.sessions, { recursive: true }),
      mkdir(paths.tasks, { recursive: true }),
      mkdir(paths.projects, { recursive: true }),
      mkdir(desktopSessions, { recursive: true }),
    ]);
    const sessionId = "session-observer";
    const cwd = join(root, "work");
    await mkdir(cwd, { recursive: true });
    await writeFile(join(paths.sessions, `${sessionId}.json`), JSON.stringify({
      sessionId,
      cwd,
      startedAt: Date.now(),
    }));
    const transcript = join(paths.projects, `${sessionId}.jsonl`);
    await writeFile(transcript, [
      JSON.stringify({
        type: "user",
        uuid: "user-1",
        parentUuid: null,
        timestamp: new Date().toISOString(),
        message: { content: "Start" },
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "assistant-1",
        parentUuid: "user-1",
        timestamp: new Date().toISOString(),
        message: { content: "First" },
      }),
      "",
    ].join("\n"));

    const eventLog = new SessionEventLog(join(root, "events.jsonl"));
    const observer = new TranscriptObserver({
      paths,
      eventLog,
      pollIntervalMs: 20,
    });
    await observer.start();
    expect(eventLog.replay()).toHaveLength(0);

    await new Promise((resolve) => setTimeout(resolve, 30));
    await appendFile(transcript, `${JSON.stringify({
      type: "assistant",
      uuid: "assistant-2",
      parentUuid: "assistant-1",
      timestamp: new Date().toISOString(),
      message: { content: "Second" },
    })}\n`);
    await waitFor(() => eventLog.replay().filter((event) => event.itemId === "assistant-1").length === 1);

    expect(eventLog.latestItem(sessionId, "session.observed", "assistant-1")?.data.text)
      .toBe("First\n\nSecond");
    await observer.close();
    await eventLog.close();
  });
});
