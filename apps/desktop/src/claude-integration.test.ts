import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildClaudeSessionCatalog,
  ClaudeIntegration,
  hookStatusPayload,
  primaryProjectSessions,
  scanClaudeSessions,
  sessionStatusPayload,
} from "./claude-integration.js";
import type { DesktopController } from "./controller.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Claude integration", () => {
  it("discovers live sessions and summarizes task progress", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-claude-state-"));
    directories.push(root);
    const sessions = join(root, "sessions");
    const tasks = join(root, "tasks");
    const sessionId = "session-1";
    await mkdir(join(tasks, sessionId), { recursive: true });
    await mkdir(sessions, { recursive: true });
    await writeFile(join(sessions, "42.json"), JSON.stringify({
      pid: 42,
      sessionId,
      cwd: "/work/ega-pms",
      startedAt: 1234,
      name: "EGA PMS",
    }));
    await Promise.all([
      writeFile(join(tasks, sessionId, "1.json"), JSON.stringify({ id: "1", subject: "Build shell", activeForm: "Building shell", status: "completed" })),
      writeFile(join(tasks, sessionId, "2.json"), JSON.stringify({ id: "2", subject: "Wire resource API", activeForm: "Wiring API", status: "in_progress" })),
      writeFile(join(tasks, sessionId, "3.json"), JSON.stringify({ id: "3", subject: "Verify", activeForm: "Verifying", status: "pending" })),
    ]);

    const result = await scanClaudeSessions({ sessions, tasks, projects: join(root, "projects"), desktopSessions: [] }, (pid) => pid === 42);
    expect(result).toEqual([expect.objectContaining({
      sessionId,
      projectName: "ega-pms",
      completedTasks: 1,
      totalTasks: 3,
      pendingTasks: 1,
      currentTask: "Wire resource API",
    })]);
    expect(sessionStatusPayload(result[0]!)).toEqual({
      kind: "status",
      step: "ega-pms",
      message: "当前：Wire resource API；已完成 1/3 项",
      progress: 33,
      level: "info",
      sessionId,
    });
  });

  it("keeps hooks observation-only and does not repeat final replies", () => {
    expect(hookStatusPayload({
      hook_event_name: "Stop",
      last_assistant_message: "收到，Bridge 真机已确认接通。",
    }, "ega-pms")).toBeUndefined();
    expect(hookStatusPayload({ hook_event_name: "Stop" }, "ega-pms")).toBeUndefined();
    expect(hookStatusPayload({ hook_event_name: "SessionEnd" }, "ega-pms")).toBeUndefined();
  });

  it("keeps the most recently focused Claude Desktop project available while idle", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-idle-session-"));
    directories.push(root);
    const sessions = join(root, "sessions");
    const tasks = join(root, "tasks");
    const desktopSessions = join(root, "desktop-sessions");
    const cliSessionId = "idle-cli-session";
    await Promise.all([
      mkdir(sessions, { recursive: true }),
      mkdir(join(tasks, cliSessionId), { recursive: true }),
      mkdir(desktopSessions, { recursive: true }),
    ]);
    await writeFile(join(desktopSessions, "local_idle.json"), JSON.stringify({
      sessionId: "local_idle",
      cliSessionId,
      cwd: "/work/ega-pms",
      createdAt: 1_000,
      lastFocusedAt: 2_000,
      lastActivityAt: 1_900,
      isArchived: false,
      title: "EGA PMS",
    }));
    await writeFile(join(tasks, cliSessionId, "1.json"), JSON.stringify({
      id: "1",
      subject: "Verify release",
      activeForm: "Verifying release",
      status: "completed",
    }));

    const result = await scanClaudeSessions({ sessions, tasks, projects: join(root, "projects"), desktopSessions: [desktopSessions] });
    expect(result).toEqual([expect.objectContaining({
      sessionId: cliSessionId,
      desktopSessionId: "local_idle",
      projectName: "ega-pms",
      state: "idle",
      completedTasks: 1,
      totalTasks: 1,
    })]);
    expect(sessionStatusPayload(result[0]!)).toEqual({
      kind: "status",
      step: "ega-pms",
      message: "任务清单已完成 1/1 项；可从手机在 Bridge 后台继续。",
      progress: 100,
      level: "success",
      sessionId: cliSessionId,
    });
  });

  it("builds a selectable catalog with running sessions first and idle history retained", () => {
    const desktopSessions = [
      {
        sessionId: "local_history",
        cliSessionId: "history",
        cwd: "/work/history-analysis",
        lastFocusedAt: 2_000,
        createdAt: 1_000,
        lastActivityAt: 1_900,
        title: "历史经营分析",
      },
      {
        sessionId: "local_active",
        cliSessionId: "active",
        cwd: "/work/ega-pms",
        lastFocusedAt: 3_000,
        createdAt: 2_500,
        lastActivityAt: 3_100,
        title: "EGA PMS",
      },
    ];
    const observed = [{
      sessionId: "active",
      desktopSessionId: "local_active",
      cwd: "/work/ega-pms",
      projectName: "ega-pms",
      name: "EGA PMS 当前实施",
      startedAt: 2_500,
      lastActivityAt: 3_200,
      state: "running" as const,
      completedTasks: 4,
      totalTasks: 6,
      pendingTasks: 1,
      currentTask: "组织图拖拽",
    }];

    expect(buildClaudeSessionCatalog(desktopSessions, observed)).toEqual([
      expect.objectContaining({
        sessionId: "active",
        desktopSessionId: "local_active",
        title: "EGA PMS 当前实施",
        state: "running",
        completedTasks: 4,
        totalTasks: 6,
      }),
      expect.objectContaining({
        sessionId: "history",
        desktopSessionId: "local_history",
        title: "历史经营分析",
        state: "idle",
      }),
    ]);
  });

  it("orders concurrent desktop sessions by real activity and publishes one session per project", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-active-session-order-"));
    directories.push(root);
    const sessions = join(root, "sessions");
    const tasks = join(root, "tasks");
    const desktopSessions = join(root, "desktop-sessions");
    await Promise.all([mkdir(sessions, { recursive: true }), mkdir(tasks, { recursive: true }), mkdir(desktopSessions, { recursive: true })]);
    await Promise.all([
      writeFile(join(sessions, "101.json"), JSON.stringify({ pid: 101, sessionId: "working", cwd: "/work/ega-pms", startedAt: 1_000 })),
      writeFile(join(sessions, "202.json"), JSON.stringify({ pid: 202, sessionId: "warm", cwd: "/work/ega-pms", startedAt: 2_000 })),
      writeFile(join(desktopSessions, "local_working.json"), JSON.stringify({
        sessionId: "local_working", cliSessionId: "working", cwd: "/work/ega-pms",
        createdAt: 1_000, lastFocusedAt: 4_000, lastActivityAt: 5_000,
      })),
      writeFile(join(desktopSessions, "local_warm.json"), JSON.stringify({
        sessionId: "local_warm", cliSessionId: "warm", cwd: "/work/ega-pms",
        createdAt: 2_000, lastFocusedAt: 3_000, lastActivityAt: 2_500,
      })),
    ]);

    const result = await scanClaudeSessions({ sessions, tasks, projects: join(root, "projects"), desktopSessions: [desktopSessions] }, () => true);
    expect(result.map((session) => session.sessionId)).toEqual(["working", "warm"]);
    expect(result[0]).toEqual(expect.objectContaining({ desktopSessionId: "local_working", lastActivityAt: 5_000 }));
    expect(primaryProjectSessions(result).map((session) => session.sessionId)).toEqual(["working"]);
  });

  it("publishes the selected Claude transcript when the phone requests history", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-history-request-"));
    directories.push(root);
    const sessions = join(root, "sessions");
    const tasks = join(root, "tasks");
    const projects = join(root, "projects");
    const desktopSessions = join(root, "desktop-sessions");
    const sessionId = "history-session";
    await Promise.all([
      mkdir(sessions, { recursive: true }),
      mkdir(tasks, { recursive: true }),
      mkdir(join(projects, "-work-ega-pms"), { recursive: true }),
      mkdir(desktopSessions, { recursive: true }),
    ]);
    await writeFile(join(desktopSessions, "local_history.json"), JSON.stringify({
      sessionId: "local_history",
      cliSessionId: sessionId,
      cwd: "/work/ega-pms",
      createdAt: 1_000,
      lastFocusedAt: 2_000,
      lastActivityAt: 2_000,
      title: "History session",
    }));
    await writeFile(join(projects, "-work-ega-pms", `${sessionId}.jsonl`), [
      JSON.stringify({ type: "user", uuid: "user-1", parentUuid: null, timestamp: "2026-07-22T10:00:00.000Z", message: { role: "user", content: "同步历史" } }),
      JSON.stringify({ type: "assistant", uuid: "assistant-1", parentUuid: "user-1", timestamp: "2026-07-22T10:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "历史已同步" }] } }),
    ].join("\n"));

    const sent: unknown[] = [];
    const controller = Object.assign(new EventEmitter(), {
      setClaudeSessions() {},
      setClaudeTransport() {},
      setClaudeActivity() {},
      assignPendingCommands() {},
      peekPendingCommands() { return []; },
      async sendMobile(payload: unknown) { sent.push(payload); },
    }) as unknown as DesktopController;
    const integration = new ClaudeIntegration({
      controller,
      paths: { sessions, tasks, projects, desktopSessions: [desktopSessions] },
      authorization: "Bearer test",
      port: 0,
      pollIntervalMs: 60_000,
    });
    await integration.start();
    controller.emit("history-request", { kind: "history-request", sessionId });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await integration.close();

    expect(sent).toContainEqual(expect.objectContaining({
      kind: "history",
      sessionId,
      available: true,
      messages: [
        expect.objectContaining({ role: "user", text: "同步历史" }),
        expect.objectContaining({ role: "assistant", text: "历史已同步" }),
      ],
    }));
  });

  it("leases a phone command to the background worker and completes it once", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-background-delivery-"));
    directories.push(root);
    const sessions = join(root, "sessions");
    const tasks = join(root, "tasks");
    const desktopSessions = join(root, "desktop-sessions");
    await Promise.all([
      mkdir(sessions, { recursive: true }),
      mkdir(tasks, { recursive: true }),
      mkdir(desktopSessions, { recursive: true }),
    ]);
    await writeFile(join(desktopSessions, "local_delivery.json"), JSON.stringify({
      sessionId: "local_delivery",
      cliSessionId: "delivery-session",
      cwd: "/work/ega-pms",
      createdAt: 1_000,
      lastFocusedAt: 2_000,
      lastActivityAt: 2_000,
      title: "EGA PMS",
    }));

    const command = {
      id: "phone-command-1",
      text: "只发送一次",
      receivedAt: "2026-07-23T01:00:00.000Z",
      targetSessionId: "delivery-session",
    };
    let pending = [command];
    let acknowledgmentCalls = 0;
    const sent: unknown[] = [];
    const activities: unknown[] = [];
    const controller = Object.assign(new EventEmitter(), {
      setClaudeSessions() {},
      setClaudeTransport() {},
      setClaudeActivity(activity: unknown) { activities.push(activity); },
      assignPendingCommands() {},
      peekPendingCommands(limit: number) { return pending.slice(0, limit); },
      ackPendingCommands(ids: string[]) {
        acknowledgmentCalls += 1;
        const acknowledged = pending.filter((item) => ids.includes(item.id)).map((item) => item.id);
        pending = pending.filter((item) => !ids.includes(item.id));
        return acknowledged;
      },
      async sendMobile(payload: unknown) { sent.push(payload); },
    }) as unknown as DesktopController;
    const integration = new ClaudeIntegration({
      controller,
      paths: { sessions, tasks, projects: join(root, "projects"), desktopSessions: [desktopSessions] },
      authorization: "Bearer test",
      port: 0,
      pollIntervalMs: 60_000,
      bridgeSessionsPath: join(root, "bridge-sessions.json"),
    });

    await integration.start();
    const port = integration.localPort();
    expect(port).toBeTypeOf("number");
    const headers = { Authorization: "Bearer test", "Content-Type": "application/json" };
    const leaseResponse = await fetch(`http://127.0.0.1:${port}/workers/lease`, {
      method: "POST",
      headers,
      body: JSON.stringify({ workerId: "worker-1", available: true, authenticated: true, version: "2.1.217" }),
    });
    const leaseBody = await leaseResponse.json() as { lease: { commandId: string; text: string; forkSession: boolean } };
    expect(leaseBody.lease).toEqual(expect.objectContaining({
      commandId: "phone-command-1",
      text: "只发送一次",
      forkSession: false,
    }));
    const health = await fetch(`http://127.0.0.1:${port}/health`).then((response) => response.json()) as {
      backgroundWorkers: number;
      availableWorkers: number;
      authenticatedWorkers: number;
    };
    expect(health).toEqual(expect.objectContaining({
      backgroundWorkers: 1,
      availableWorkers: 1,
      authenticatedWorkers: 1,
    }));
    const resultResponse = await fetch(`http://127.0.0.1:${port}/workers/result`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        workerId: "worker-1",
        commandId: "phone-command-1",
        ok: true,
        summary: "后台执行完成",
        sessionId: "delivery-session",
        resumedFromSource: true,
      }),
    });
    expect(resultResponse.ok).toBe(true);
    await integration.close();

    expect(acknowledgmentCalls).toBe(1);
    expect(pending).toEqual([]);
    expect(sent).toContainEqual({ kind: "completion", summary: "后台执行完成", sessionId: "delivery-session" });
    expect(activities).toContainEqual(expect.objectContaining({
      id: "phone-command-1",
      state: "completed",
      command: "只发送一次",
      summary: "后台执行完成",
    }));
    expect(sent).not.toContainEqual(expect.objectContaining({ message: expect.stringContaining("正在打开") }));
  });

  it("does not announce an unchanged live session as ended", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-stable-session-"));
    directories.push(root);
    const sessions = join(root, "sessions");
    const tasks = join(root, "tasks");
    await Promise.all([mkdir(sessions, { recursive: true }), mkdir(tasks, { recursive: true })]);
    await writeFile(join(sessions, "42.json"), JSON.stringify({
      pid: 42,
      sessionId: "stable-session",
      cwd: "/work/ega-pms",
      startedAt: 1_000,
    }));

    const sent: unknown[] = [];
    const controller = Object.assign(new EventEmitter(), {
      setClaudeSessions() {},
      setClaudeTransport() {},
      setClaudeActivity() {},
      assignPendingCommands() {},
      peekPendingCommands() { return []; },
      async sendMobile(payload: unknown) { sent.push(payload); },
    }) as unknown as DesktopController;
    const integration = new ClaudeIntegration({
      controller,
      paths: { sessions, tasks, projects: join(root, "projects"), desktopSessions: [] },
      authorization: "Bearer test",
      port: 0,
      pollIntervalMs: 15,
      processAlive: (pid) => pid === 42,
    });

    await integration.start();
    await new Promise((resolve) => setTimeout(resolve, 70));
    await integration.close();

    expect(sent).toEqual([
      expect.objectContaining({ kind: "sessions" }),
      expect.objectContaining({ kind: "status", step: "ega-pms", sessionId: "stable-session" }),
    ]);
    expect(sent).not.toContainEqual(expect.objectContaining({ message: "Claude 会话已结束。" }));
  });
});
