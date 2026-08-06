import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionEventLog } from "./session-event-log.js";
import type { ObservedDesktopEvidence } from "./evidence-manager.js";
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
  it("treats a focused Desktop session as a viewer until it writes a real user message", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-observer-viewer-"));
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
    const sessionId = "session-viewer";
    const cwd = join(root, "work");
    const transcript = join(paths.projects, `${sessionId}.jsonl`);
    const oldTimestamp = Date.now() - 60_000;
    await mkdir(cwd, { recursive: true });
    await writeFile(join(paths.sessions, `${process.pid}.json`), JSON.stringify({
      pid: process.pid,
      sessionId,
      cwd,
      startedAt: oldTimestamp,
      entrypoint: "claude-desktop-3p",
    }));
    const desktopSessionPath = join(desktopSessions, "local_viewer.json");
    await writeFile(desktopSessionPath, JSON.stringify({
      sessionId: "desktop-viewer",
      cliSessionId: sessionId,
      cwd,
      createdAt: oldTimestamp,
      lastFocusedAt: oldTimestamp,
      lastActivityAt: oldTimestamp,
      title: "Viewer",
    }));
    await writeFile(transcript, [
      JSON.stringify({
        type: "user",
        uuid: "user-1",
        parentUuid: null,
        timestamp: new Date(oldTimestamp).toISOString(),
        message: { role: "user", content: "Run" },
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "assistant-1",
        parentUuid: "user-1",
        timestamp: new Date(oldTimestamp + 1).toISOString(),
        message: { role: "assistant", content: "Done", stop_reason: "end_turn" },
      }),
      "",
    ].join("\n"));
    await utimes(transcript, oldTimestamp / 1_000, oldTimestamp / 1_000);

    const eventLog = new SessionEventLog(join(root, "events.jsonl"));
    const observer = new TranscriptObserver({
      paths,
      eventLog,
      platform: "linux",
      pollIntervalMs: 20,
      catalogIntervalMs: 20,
      idleGraceMs: 1_000,
    });
    await observer.start();
    await waitFor(() => observer.catalog.sessions.some((session) => session.sessionId === sessionId));

    expect(observer.catalog.sessions.find((session) => session.sessionId === sessionId)?.desktopProcessAlive)
      .toBe(true);
    await expect(observer.canStartBridgeHost(sessionId)).resolves.toBe(true);
    expect(observer.isDesktopBusy(sessionId)).toBe(false);
    expect(observer.externalWriteVersion(sessionId)).toBe(0);

    const focusedAt = Date.now();
    await writeFile(desktopSessionPath, JSON.stringify({
      sessionId: "desktop-viewer",
      cliSessionId: sessionId,
      cwd,
      createdAt: oldTimestamp,
      lastFocusedAt: focusedAt,
      lastActivityAt: oldTimestamp,
      title: "Viewer",
    }));
    await waitFor(() => (
      observer.catalog.sessions.find((session) => session.sessionId === sessionId)?.lastActivityAt === focusedAt
    ));
    expect(observer.isDesktopBusy(sessionId)).toBe(false);
    expect(observer.externalWriteVersion(sessionId)).toBe(0);

    const previousTranscriptMtime = observer.catalog.sessions.find(
      (session) => session.sessionId === sessionId,
    )?.transcriptMtimeMs ?? 0;
    await appendFile(transcript, `${JSON.stringify({
      type: "user",
      uuid: "control-interrupt",
      parentUuid: "assistant-1",
      timestamp: new Date().toISOString(),
      message: { role: "user", content: "[Request interrupted by user for tool use]" },
    })}\n`);
    await waitFor(() => (
      (observer.catalog.sessions.find((session) => session.sessionId === sessionId)?.transcriptMtimeMs ?? 0)
      > previousTranscriptMtime
    ));
    expect(observer.externalWriteVersion(sessionId)).toBe(0);

    await eventLog.append({
      sessionId,
      itemId: "bridge-user",
      timestamp: Date.now(),
      origin: "mobile",
      type: "user.message.accepted",
      data: { text: "Bridge command" },
    });
    await appendFile(transcript, `${JSON.stringify({
      type: "user",
      uuid: "bridge-user",
      parentUuid: "control-interrupt",
      timestamp: new Date().toISOString(),
      message: { role: "user", content: "Bridge command" },
    })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(observer.externalWriteVersion(sessionId)).toBe(0);

    await eventLog.append({
      sessionId,
      itemId: "bridge-assistant-late",
      timestamp: Date.now(),
      origin: "claude-host",
      type: "assistant.completed",
      data: { text: "Bridge continued" },
    });
    await appendFile(transcript, `${[
      JSON.stringify({
        type: "user",
        uuid: "desktop-user",
        parentUuid: "bridge-user",
        timestamp: new Date().toISOString(),
        message: { role: "user", content: "Desktop input" },
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "bridge-assistant-late",
        parentUuid: "bridge-user",
        timestamp: new Date().toISOString(),
        message: { role: "assistant", content: "Bridge continued" },
      }),
    ].join("\n")}\n`);
    await waitFor(() => observer.externalWriteVersion(sessionId) === 1);
    expect(eventLog.latestItem(sessionId, "session.observed", "desktop-user")?.data)
      .toMatchObject({ role: "user", text: "Desktop input" });

    await observer.close();
    await eventLog.close();
  });

  it("keeps a Desktop tool turn running until the transcript reaches an end-turn boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-observer-running-turn-"));
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
    const sessionId = "session-running-turn";
    const cwd = join(root, "work");
    const transcript = join(paths.projects, `${sessionId}.jsonl`);
    const oldTimestamp = Date.now() - 60_000;
    await mkdir(cwd, { recursive: true });
    await writeFile(join(paths.sessions, `${process.pid}.json`), JSON.stringify({
      pid: process.pid,
      sessionId,
      cwd,
      startedAt: oldTimestamp,
      entrypoint: "claude-desktop-3p",
    }));
    await writeFile(join(desktopSessions, "local_running-turn.json"), JSON.stringify({
      sessionId: "desktop-running-turn",
      cliSessionId: sessionId,
      cwd,
      createdAt: oldTimestamp,
      lastFocusedAt: oldTimestamp,
      lastActivityAt: oldTimestamp,
      title: "Running turn",
    }));
    await writeFile(transcript, [
      JSON.stringify({
        type: "user",
        uuid: "user-1",
        parentUuid: null,
        timestamp: new Date(oldTimestamp).toISOString(),
        message: { role: "user", content: "Run checks" },
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "tool-1",
        parentUuid: "user-1",
        timestamp: new Date(oldTimestamp + 1).toISOString(),
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "call-1", name: "Bash", input: { command: "npm test" } }],
          stop_reason: "tool_use",
        },
      }),
      JSON.stringify({
        type: "user",
        uuid: "result-1",
        parentUuid: "tool-1",
        timestamp: new Date(oldTimestamp + 2).toISOString(),
        toolUseResult: "passed",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "call-1", content: "passed" }],
        },
      }),
      "",
    ].join("\n"));
    await utimes(transcript, oldTimestamp / 1_000, oldTimestamp / 1_000);

    const eventLog = new SessionEventLog(join(root, "events.jsonl"));
    const observer = new TranscriptObserver({
      paths,
      eventLog,
      platform: "linux",
      pollIntervalMs: 20,
      catalogIntervalMs: 20,
      idleGraceMs: 1,
    });
    await observer.start();
    await waitFor(() => observer.catalog.sessions.some((session) => session.sessionId === sessionId));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(observer.isDesktopBusy(sessionId)).toBe(true);
    await expect(observer.canStartBridgeHost(sessionId)).resolves.toBe(false);

    await appendFile(transcript, `${JSON.stringify({
      type: "assistant",
      uuid: "assistant-final",
      parentUuid: "result-1",
      timestamp: new Date().toISOString(),
      message: { role: "assistant", content: "Finished", stop_reason: "end_turn" },
    })}\n`);
    await waitFor(() => !observer.isDesktopBusy(sessionId));

    await expect(observer.canStartBridgeHost(sessionId)).resolves.toBe(true);
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
      platform: "linux",
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

  it("primes an older session before Bridge writes to it", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-observer-older-session-"));
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
    const now = Date.now();
    for (let index = 0; index < 24; index += 1) {
      await writeFile(join(desktopSessions, `local_newer-${index}.json`), JSON.stringify({
        sessionId: `desktop-newer-${index}`,
        cliSessionId: `session-newer-${index}`,
        cwd: root,
        createdAt: now - index,
        lastFocusedAt: now - index,
        lastActivityAt: now - index,
        title: `Newer ${index}`,
      }));
    }

    const sessionId = "session-older";
    const oldTimestamp = now - 60_000;
    await writeFile(join(desktopSessions, "local_older.json"), JSON.stringify({
      sessionId: "desktop-older",
      cliSessionId: sessionId,
      cwd: root,
      createdAt: oldTimestamp,
      lastFocusedAt: oldTimestamp,
      lastActivityAt: oldTimestamp,
      title: "Older",
    }));
    const transcript = join(paths.projects, `${sessionId}.jsonl`);
    await writeFile(transcript, [
      JSON.stringify({
        type: "user",
        uuid: "older-user",
        parentUuid: null,
        timestamp: new Date(oldTimestamp).toISOString(),
        message: { role: "user", content: "Earlier work" },
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "older-assistant",
        parentUuid: "older-user",
        timestamp: new Date(oldTimestamp + 1).toISOString(),
        message: { role: "assistant", content: "Finished", stop_reason: "end_turn" },
      }),
      "",
    ].join("\n"));
    await utimes(transcript, oldTimestamp / 1_000, oldTimestamp / 1_000);

    const eventLog = new SessionEventLog(join(root, "events.jsonl"));
    const observer = new TranscriptObserver({
      paths,
      eventLog,
      platform: "linux",
      pollIntervalMs: 20,
      catalogIntervalMs: 20,
    });
    await observer.start();
    expect(observer.catalog.sessions.at(-1)?.sessionId).toBe(sessionId);
    await expect(observer.canStartBridgeHost(sessionId)).resolves.toBe(true);

    await eventLog.append({
      sessionId,
      itemId: "bridge-user",
      timestamp: now,
      origin: "mobile",
      type: "user.message.accepted",
      data: { text: "Continue" },
    });
    await appendFile(transcript, `${JSON.stringify({
      type: "user",
      uuid: "bridge-user",
      parentUuid: "older-assistant",
      timestamp: new Date().toISOString(),
      message: { role: "user", content: "Continue" },
    })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(observer.externalWriteVersion(sessionId)).toBe(0);

    await observer.close();
    await eventLog.close();
  });

  it("upserts Desktop tool evidence idempotently and never treats thinking as chat", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-observer-evidence-"));
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
    const sessionId = "session-evidence";
    const cwd = join(root, "work");
    await mkdir(cwd, { recursive: true });
    await writeFile(join(desktopSessions, "local_evidence.json"), JSON.stringify({
      sessionId: "desktop-evidence",
      cliSessionId: sessionId,
      cwd,
      createdAt: Date.now(),
      lastFocusedAt: Date.now(),
      lastActivityAt: Date.now(),
      title: "Evidence",
    }));
    const transcript = join(paths.projects, `${sessionId}.jsonl`);
    await writeFile(transcript, [
      JSON.stringify({
        type: "user",
        uuid: "user-1",
        parentUuid: null,
        timestamp: new Date().toISOString(),
        message: { role: "user", content: "Inspect" },
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "tool-node",
        parentUuid: "user-1",
        timestamp: new Date().toISOString(),
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "private analysis" },
            { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "report.txt" } },
          ],
          stop_reason: "tool_use",
        },
      }),
      JSON.stringify({
        type: "user",
        uuid: "result-1",
        parentUuid: "tool-node",
        timestamp: new Date().toISOString(),
        toolUseResult: "ok",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tool-1", content: "ok" }],
        },
      }),
      "",
    ].join("\n"));
    const recovered: ObservedDesktopEvidence[] = [];
    const eventLog = new SessionEventLog(join(root, "events.jsonl"));
    const observer = new TranscriptObserver({
      paths,
      eventLog,
      platform: "linux",
      pollIntervalMs: 20,
      catalogIntervalMs: 20,
      evidence: {
        async upsertDesktopEvidence(input) {
          recovered.push(input);
        },
      },
    });
    await observer.start();
    await waitFor(() => recovered.length === 1);

    expect(recovered[0]).toMatchObject({
      sessionId,
      tools: [{ id: "tool-1", toolName: "Read" }],
      paths: ["report.txt"],
    });
    expect(JSON.stringify(recovered)).not.toContain("private analysis");
    await appendFile(transcript, `${JSON.stringify({
      type: "assistant",
      uuid: "thinking-only",
      parentUuid: "result-1",
      timestamp: new Date().toISOString(),
      message: { role: "assistant", content: [{ type: "thinking", thinking: "still private" }] },
    })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(recovered).toHaveLength(1);

    await observer.close();
    await eventLog.close();
  });
});
