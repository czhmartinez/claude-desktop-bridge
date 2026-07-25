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
  it("quits the Claude Desktop main process only after every Desktop session is idle", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-observer-release-"));
    directories.push(root);
    const paths = {
      sessions: join(root, "sessions"),
      tasks: join(root, "tasks"),
      projects: join(root, "projects"),
      desktopSessions: [],
    };
    await Promise.all([
      mkdir(paths.sessions, { recursive: true }),
      mkdir(paths.tasks, { recursive: true }),
      mkdir(paths.projects, { recursive: true }),
    ]);
    const sessionId = "session-release";
    const childPid = 43284;
    const mainPid = 73;
    const cwd = join(root, "work");
    const transcript = join(root, "completed.jsonl");
    await mkdir(cwd, { recursive: true });
    await writeFile(join(paths.sessions, `${childPid}.json`), JSON.stringify({
      pid: childPid,
      sessionId,
      cwd,
      startedAt: Date.now(),
      entrypoint: "claude-desktop-3p",
    }));
    await writeFile(transcript, [
      JSON.stringify({
        type: "user",
        uuid: "user-1",
        parentUuid: null,
        message: { role: "user", content: "Run" },
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "assistant-1",
        parentUuid: "user-1",
        message: { role: "assistant", content: "Done", stop_reason: "end_turn" },
      }),
    ].join("\n"));
    let running = true;
    const signalled: number[] = [];
    const eventLog = new SessionEventLog(join(root, "events.jsonl"));
    const observer = new TranscriptObserver({
      paths,
      eventLog,
      idleGraceMs: 0,
      resolveDesktopMainProcessId: async (pid) => (
        pid === childPid || pid === 555 ? mainPid : undefined
      ),
      signalProcess: (pid) => {
        signalled.push(pid);
        running = false;
      },
      processExists: () => running,
      sleep: async () => undefined,
    });
    observer.catalog.sessions.push({
      sessionId,
      desktopSessionId: "desktop-release",
      projectId: "project-release",
      projectName: "work",
      cwd,
      title: "Release test",
      source: "desktop",
      transport: "bridge-host",
      ownership: "DESKTOP_OBSERVED",
      turnState: "idle",
      lastActivityAt: Date.now() - 10_000,
      pendingCount: 0,
      transcriptPath: transcript,
      transcriptMtimeMs: Date.now() - 10_000,
      processAlive: true,
      desktopProcessAlive: true,
      bridgeProcessAlive: false,
      processConflict: false,
      activeProcesses: [{
        pid: childPid,
        cwd,
        startedAt: Date.now() - 10_000,
        processAlive: true,
        entrypoint: "claude-desktop-3p",
        source: "registration",
      }],
      activeTask: false,
    });
    observer.catalog.sessions.push({
      ...observer.catalog.sessions[0]!,
      sessionId: "session-busy",
      desktopSessionId: "desktop-busy",
      projectId: "project-busy",
      title: "Busy session",
      activeTask: true,
      activeProcesses: [{
        pid: 555,
        cwd,
        startedAt: Date.now() - 10_000,
        processAlive: true,
        entrypoint: "claude-desktop-3p",
        source: "registration",
      }],
    });

    await expect(observer.releaseDesktopWriter(sessionId)).resolves.toBe(false);
    expect(signalled).toEqual([]);
    observer.catalog.sessions[1]!.activeTask = false;
    await expect(observer.releaseDesktopWriter(sessionId)).resolves.toBe(true);
    expect(signalled).toEqual([mainPid]);
    expect(observer.catalog.sessions.every((candidate) => (
      !candidate.desktopProcessAlive && !candidate.processAlive
    ))).toBe(true);
    await observer.close();
    await eventLog.close();
  });

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
