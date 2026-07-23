import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanClaudeCatalog } from "./claude-session-catalog.js";

const directories: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) child.kill("SIGTERM");
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  delete process.env.BRIDGE_DISABLE_PROCESS_SCAN;
});

describe("Claude session process catalog", () => {
  it("retains every live writer registered for the same session instead of overwriting by sessionId", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-session-catalog-"));
    directories.push(root);
    const sessions = join(root, "sessions");
    const desktopSessions = join(root, "desktop-sessions");
    const project = join(root, "project");
    const sessionId = "11111111-1111-4111-8111-111111111111";
    await Promise.all([mkdir(sessions), mkdir(desktopSessions), mkdir(project)]);
    const desktopProcess = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
    const bridgeProcess = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
    children.push(desktopProcess, bridgeProcess);
    if (!desktopProcess.pid || !bridgeProcess.pid) throw new Error("Test process failed to start");
    await Promise.all([
      writeFile(join(sessions, "desktop.json"), JSON.stringify({
        pid: desktopProcess.pid,
        sessionId,
        cwd: project,
        startedAt: 1,
        entrypoint: "claude-desktop-3p",
        peerProtocol: "stream-json",
      })),
      writeFile(join(sessions, "bridge.json"), JSON.stringify({
        pid: bridgeProcess.pid,
        sessionId,
        cwd: project,
        startedAt: 2,
        entrypoint: "claude-bridge",
        peerProtocol: "agent-sdk",
      })),
      writeFile(join(desktopSessions, "desktop-session.json"), JSON.stringify({
        sessionId: "local-1",
        cliSessionId: sessionId,
        cwd: project,
        lastFocusedAt: 1,
      })),
    ]);
    process.env.BRIDGE_DISABLE_PROCESS_SCAN = "1";

    const catalog = await scanClaudeCatalog({
      sessions,
      tasks: join(root, "tasks"),
      projects: join(root, "projects"),
      desktopSessions: [desktopSessions],
    });
    expect(catalog.sessions[0]).toMatchObject({
      sessionId,
      processAlive: true,
      desktopProcessAlive: true,
      bridgeProcessAlive: true,
      processConflict: true,
    });
    expect(catalog.sessions[0]?.activeProcesses).toEqual(expect.arrayContaining([
      expect.objectContaining({ pid: desktopProcess.pid, entrypoint: "claude-desktop-3p" }),
      expect.objectContaining({ pid: bridgeProcess.pid, entrypoint: "claude-bridge" }),
    ]));
    expect(catalog.sessions[0]?.activeProcesses).toHaveLength(2);
  });
});
