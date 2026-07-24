import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BridgeEffort } from "@bridge/protocol";
import type { ModelInfo, SDKControlGetContextUsageResponse } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeSessionHostOptions, SessionHostEvent } from "./claude-session-host.js";
import type { ClaudeCatalogSnapshot, ObservedClaudeSession } from "./claude-session-catalog.js";
import {
  SessionBroker,
  type ManagedDesktopRuntime,
  type ManagedDesktopTransportRuntime,
  type SessionHostRuntime,
  type TranscriptObserverRuntime,
} from "./session-broker.js";
import { SessionEventLog } from "./session-event-log.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

class FakeObserver extends EventEmitter implements TranscriptObserverRuntime {
  busy = false;
  writer: boolean | undefined;

  constructor(readonly catalog: ClaudeCatalogSnapshot) {
    super();
  }

  isDesktopBusy(): boolean {
    return this.busy;
  }

  hasDesktopWriter(): boolean {
    return this.writer ?? this.busy;
  }

  onCatalog(listener: (catalog: ClaudeCatalogSnapshot) => void): () => void {
    this.on("catalog", listener);
    return () => this.off("catalog", listener);
  }

  publish(): void {
    this.emit("catalog", this.catalog);
  }
}

class FakeHost implements SessionHostRuntime {
  readonly events = new EventEmitter();
  sends = 0;
  current: { turnId: string; messageId: string } | undefined;
  model: string | undefined;
  effort: BridgeEffort | undefined;
  closed = false;

  constructor(readonly options: ClaudeSessionHostOptions) {
    this.model = options.model;
    this.effort = options.effort;
  }

  start(): void {}

  async setModel(model?: string): Promise<void> {
    this.model = model;
  }

  async setEffort(effort?: BridgeEffort): Promise<void> {
    this.effort = effort;
  }

  async supportedModels(): Promise<ModelInfo[]> {
    return [
      {
        value: "claude-fable-5",
        displayName: "Fable 5",
        description: "Fast model",
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high", "xhigh"],
      },
      {
        value: "claude-fable-5[1m]",
        displayName: "Fable 5 · 1M",
        description: "Long context",
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high", "xhigh"],
      },
    ];
  }

  async contextUsage(): Promise<SDKControlGetContextUsageResponse> {
    return {
      categories: [],
      totalTokens: 120_000,
      maxTokens: 1_000_000,
      rawMaxTokens: 1_000_000,
      percentage: 12,
      gridRows: [],
      model: this.model ?? "claude-fable-5[1m]",
      memoryFiles: [],
      mcpTools: [],
      agents: [],
      isAutoCompactEnabled: true,
      apiUsage: null,
    };
  }

  send(input: Parameters<SessionHostRuntime["send"]>[0], origin: Parameters<SessionHostRuntime["send"]>[1]) {
    this.sends += 1;
    const turnId = randomUUID();
    const messageId = randomUUID();
    const text = typeof input === "string" ? input : input.text;
    this.current = { turnId, messageId };
    this.emit({ type: "turn.started", sessionId: this.options.sessionId, turnId, at: Date.now() });
    this.emit({
      type: "user.accepted",
      sessionId: this.options.sessionId,
      turnId,
      messageId,
      text,
      attachments: [],
      origin,
      at: Date.now(),
    });
    return { turnId, messageId };
  }

  async interrupt(): Promise<void> {
    if (!this.current) return;
    this.emit({
      type: "turn.interrupted",
      sessionId: this.options.sessionId,
      turnId: this.current.turnId,
      at: Date.now(),
    });
    this.current = undefined;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  onEvent(listener: (event: SessionHostEvent) => void): () => void {
    this.events.on("event", listener);
    return () => this.events.off("event", listener);
  }

  complete(result = "Done"): void {
    if (!this.current) return;
    this.emit({
      type: "assistant.completed",
      sessionId: this.options.sessionId,
      turnId: this.current.turnId,
      itemId: randomUUID(),
      text: result,
      at: Date.now(),
    });
    this.emit({
      type: "turn.completed",
      sessionId: this.options.sessionId,
      turnId: this.current.turnId,
      result,
      at: Date.now(),
    });
    this.current = undefined;
  }

  private emit(event: SessionHostEvent): void {
    this.events.emit("event", event);
  }
}

class FakeManagedDesktop extends EventEmitter implements ManagedDesktopRuntime {
  ready = true;
  enabled = true;
  stopped = false;

  status() {
    return {
      state: this.ready ? "ready" as const : "disconnected" as const,
      detail: this.ready ? "Ready" : "Disconnected",
      enabled: this.enabled,
      canRestart: true,
    };
  }

  applyToRuntimeStatus(status: Parameters<ManagedDesktopRuntime["applyToRuntimeStatus"]>[0]) {
    return { ...status, desktopIntegration: this.status() };
  }

  async stopClaudeForFallback(): Promise<void> {
    this.stopped = true;
    this.ready = false;
  }
}

class FakeManagedTransport extends EventEmitter implements ManagedDesktopTransportRuntime {
  ready = true;
  sends: Array<Parameters<ManagedDesktopTransportRuntime["send"]>[0]> = [];

  updateCatalog(): void {}

  desktopSessionId(sessionId: string): string {
    return `desktop-${sessionId}`;
  }

  async send(input: Parameters<ManagedDesktopTransportRuntime["send"]>[0]) {
    this.sends.push(input);
    return {
      messageId: input.messageId ?? randomUUID(),
      turnId: input.turnId ?? randomUUID(),
      desktopSessionId: input.session.desktopSessionId ?? `desktop-${input.session.sessionId}`,
    };
  }

  async interrupt(): Promise<void> {}
  async setModel(): Promise<void> {}
  async setEffort(): Promise<void> {}
  async getContextUsage(): Promise<undefined> { return undefined; }
  clearIntent(): void {}

  onEvent(listener: (event: SessionHostEvent) => void): () => void {
    this.on("host-event", listener);
    return () => this.off("host-event", listener);
  }

  onDeliveryUncertain(listener: Parameters<ManagedDesktopTransportRuntime["onDeliveryUncertain"]>[0]): () => void {
    this.on("uncertain", listener);
    return () => this.off("uncertain", listener);
  }

  close(): void {
    this.removeAllListeners();
  }

  emitHost(event: SessionHostEvent): void {
    this.emit("host-event", event);
  }
}

function observed(sessionId: string, cwd: string): ObservedClaudeSession {
  return {
    sessionId,
    desktopSessionId: `desktop-${sessionId}`,
    projectId: `project-${sessionId}`,
    projectName: "project",
    cwd,
    title: `Session ${sessionId}`,
    source: "desktop",
    transport: "bridge-host",
    ownership: "DESKTOP_OBSERVED",
    turnState: "idle",
    lastActivityAt: Date.now(),
    pendingCount: 0,
    transcriptMtimeMs: Date.now(),
    processAlive: true,
    desktopProcessAlive: false,
    bridgeProcessAlive: false,
    processConflict: false,
    activeProcesses: [],
    activeTask: false,
    hostModel: "claude-fable-5[1m]",
    hostEffort: "high",
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("Timed out waiting for broker state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("SessionBroker", () => {
  it("detects a Claude Host credential created after Bridge startup", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-broker-"));
    directories.push(root);
    const eventLog = new SessionEventLog(join(root, "events.jsonl"), 1);
    const observer = new FakeObserver({ projects: [], sessions: [], observedAt: Date.now() });
    let credentialAvailable = false;
    const broker = new SessionBroker({
      paths: {
        sessions: join(root, "runtime-sessions"),
        tasks: join(root, "tasks"),
        projects: join(root, "projects"),
        desktopSessions: [],
      },
      eventLog,
      observer,
      sessionsPath: join(root, "sessions.json"),
      queuePath: join(root, "queue.json"),
      runtimeRetryDelayMs: 5,
      prepareRuntime: async () => ({
        executablePath: "/fake/claude",
        ...(credentialAvailable ? { credentialPath: "/fake/host-creds.json" } : {}),
        environment: {},
        version: "test",
      }),
    });

    await broker.initialize();
    expect(broker.runtimeStatus().state).toBe("auth-required");

    credentialAvailable = true;
    await waitFor(() => broker.runtimeStatus().state === "ready");
    expect(broker.runtimeStatus().credentialSource).toBe("third-party-host");

    await broker.close();
    await eventLog.close();
  });

  it("waits for desktop idle, resumes exactly once, and deduplicates delivery", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-broker-"));
    directories.push(root);
    const cwd = join(root, "project");
    const projects = join(root, "projects");
    const sessionId = randomUUID();
    await mkdir(join(projects, cwd.replace(/[:\\/]/gu, "-")), { recursive: true });
    await writeFile(join(projects, cwd.replace(/[:\\/]/gu, "-"), `${sessionId}.jsonl`), "");
    await mkdir(cwd, { recursive: true });
    const observer = new FakeObserver({
      projects: [],
      sessions: [observed(sessionId, cwd)],
      observedAt: Date.now(),
    });
    observer.busy = true;
    const hosts: FakeHost[] = [];
    const eventLog = new SessionEventLog(join(root, "events.jsonl"), 1);
    const sessionsPath = join(root, "sessions.json");
    const queuePath = join(root, "queue.json");
    const runtimePaths = {
      sessions: join(root, "runtime-sessions"),
      tasks: join(root, "tasks"),
      projects,
      desktopSessions: [],
    };
    const broker = new SessionBroker({
      paths: runtimePaths,
      eventLog,
      observer,
      sessionsPath,
      queuePath,
      hostFactory: (options) => {
        const host = new FakeHost(options);
        hosts.push(host);
        return host;
      },
      prepareRuntime: async () => ({
        executablePath: "/fake/claude",
        credentialPath: "/fake/host-creds.json",
        environment: {},
        version: "test",
      }),
    });
    await broker.initialize();
    const first = await broker.startTurn({
      requestId: "request-1",
      idempotencyKey: "same-command",
      sessionId,
      text: "Continue",
      origin: "mobile",
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(hosts).toHaveLength(0);

    observer.busy = false;
    observer.publish();
    await waitFor(() => hosts[0]?.sends === 1);
    expect(hosts[0]!.options.resume).toBe(true);
    expect(hosts[0]!.options.model).toBe("claude-fable-5[1m]");
    expect(hosts[0]!.options.effort).toBe("high");
    const duplicate = await broker.startTurn({
      requestId: "request-duplicate",
      idempotencyKey: "same-command",
      sessionId,
      text: "Continue",
      origin: "mobile",
    });
    expect(duplicate.commandId).toBe(first.commandId);
    expect(hosts[0]!.sends).toBe(1);
    hosts[0]!.complete();
    await waitFor(() => eventLog.replay().some((event) => event.type === "turn.completed"));
    const completedDuplicate = await broker.startTurn({
      requestId: "request-duplicate-after-completion",
      idempotencyKey: "same-command",
      sessionId,
      text: "Continue",
      origin: "mobile",
    });
    expect(completedDuplicate).toMatchObject({
      commandId: first.commandId,
      requestId: "request-1",
      state: "completed",
    });
    expect(eventLog.replay().find((event) => event.type === "turn.completed")?.data)
      .toMatchObject({ commandId: first.commandId, requestId: "request-1" });
    expect(hosts[0]!.sends).toBe(1);
    expect(broker.session(sessionId)?.turnState).toBe("idle");
    await broker.close();
    await eventLog.close();

    const reopenedHosts: FakeHost[] = [];
    const reopenedLog = new SessionEventLog(join(root, "events.jsonl"));
    const reopened = new SessionBroker({
      paths: runtimePaths,
      eventLog: reopenedLog,
      observer,
      sessionsPath,
      queuePath,
      hostFactory: (options) => {
        const host = new FakeHost(options);
        reopenedHosts.push(host);
        return host;
      },
      prepareRuntime: async () => ({
        executablePath: "/fake/claude",
        credentialPath: "/fake/host-creds.json",
        environment: {},
        version: "test",
      }),
    });
    await reopened.initialize();
    await expect(reopened.startTurn({
      requestId: "request-after-restart",
      idempotencyKey: "same-command",
      sessionId,
      text: "Continue",
      origin: "mobile",
    })).resolves.toMatchObject({ commandId: first.commandId, state: "completed" });
    expect(reopenedHosts).toHaveLength(0);
    await reopened.close();
    await reopenedLog.close();
  });

  it("never starts a second host while a Claude Desktop writer remains alive after transcript silence", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-broker-writer-"));
    directories.push(root);
    const cwd = join(root, "project");
    const sessionId = randomUUID();
    await mkdir(cwd, { recursive: true });
    const desktopSession = observed(sessionId, cwd);
    desktopSession.desktopProcessAlive = true;
    desktopSession.processAlive = true;
    desktopSession.activeProcesses = [{
      pid: process.pid,
      cwd,
      startedAt: Date.now(),
      processAlive: true,
      entrypoint: "claude-desktop-3p",
      peerProtocol: "stream-json",
      source: "registration",
    }];
    const observer = new FakeObserver({
      projects: [],
      sessions: [desktopSession],
      observedAt: Date.now(),
    });
    observer.busy = false;
    observer.writer = true;
    const hosts: FakeHost[] = [];
    const eventLog = new SessionEventLog(join(root, "events.jsonl"));
    const broker = new SessionBroker({
      paths: {
        sessions: join(root, "runtime-sessions"),
        tasks: join(root, "tasks"),
        projects: join(root, "projects"),
        desktopSessions: [],
      },
      eventLog,
      observer,
      sessionsPath: join(root, "sessions.json"),
      queuePath: join(root, "queue.json"),
      hostFactory: (options) => {
        const host = new FakeHost(options);
        hosts.push(host);
        return host;
      },
      prepareRuntime: async () => ({
        executablePath: "/fake/claude",
        credentialPath: "/fake/host-creds.json",
        environment: {},
      }),
    });
    await broker.initialize();
    await broker.startTurn({
      requestId: "request-writer",
      idempotencyKey: "command-writer",
      sessionId,
      text: "Do not fork this session",
      origin: "mobile",
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    observer.publish();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(hosts).toHaveLength(0);
    expect(broker.session(sessionId)).toMatchObject({
      ownership: "DESKTOP_OBSERVED",
      turnState: "queued",
      pendingCount: 1,
    });

    observer.writer = false;
    desktopSession.desktopProcessAlive = false;
    desktopSession.processAlive = false;
    desktopSession.activeProcesses = [];
    observer.publish();
    await waitFor(() => hosts[0]?.sends === 1);
    await broker.close();
    await eventLog.close();
  });

  it("uses the managed Desktop transport as the only writer and preserves its event order", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-broker-managed-"));
    directories.push(root);
    const cwd = join(root, "project");
    const sessionId = randomUUID();
    await mkdir(cwd, { recursive: true });
    const desktopSession = observed(sessionId, cwd);
    desktopSession.desktopProcessAlive = true;
    desktopSession.processAlive = true;
    const observer = new FakeObserver({
      projects: [],
      sessions: [desktopSession],
      observedAt: Date.now(),
    });
    observer.writer = true;
    const hosts: FakeHost[] = [];
    const managedDesktop = new FakeManagedDesktop();
    const managedTransport = new FakeManagedTransport();
    const eventLog = new SessionEventLog(join(root, "events.jsonl"));
    const broker = new SessionBroker({
      paths: {
        sessions: join(root, "runtime-sessions"),
        tasks: join(root, "tasks"),
        projects: join(root, "projects"),
        desktopSessions: [],
      },
      eventLog,
      observer,
      sessionsPath: join(root, "sessions.json"),
      queuePath: join(root, "queue.json"),
      managedDesktop,
      managedTransport,
      hostFactory: (options) => {
        const host = new FakeHost(options);
        hosts.push(host);
        return host;
      },
      prepareRuntime: async () => ({
        executablePath: "/fake/claude",
        credentialPath: "/fake/host-creds.json",
        environment: {},
      }),
    });
    await broker.initialize();
    const receipt = await broker.startTurn({
      requestId: "request-managed",
      idempotencyKey: "command-managed",
      sessionId,
      text: "Run in Claude Desktop",
      origin: "mobile",
    });
    await waitFor(() => managedTransport.sends.length === 1);
    expect(hosts).toHaveLength(0);
    expect(managedTransport.sends[0]).toMatchObject({
      session: { sessionId },
      text: "Run in Claude Desktop",
      messageId: receipt.commandId,
      mode: "start",
    });
    const turnId = managedTransport.sends[0]?.turnId;
    if (!turnId) throw new Error("Managed turn did not receive an id");
    managedTransport.emitHost({
      type: "turn.started",
      sessionId,
      turnId,
      at: 10,
    });
    managedTransport.emitHost({
      type: "user.accepted",
      sessionId,
      turnId,
      messageId: receipt.commandId,
      text: "Run in Claude Desktop",
      attachments: [],
      origin: "mobile",
      at: 11,
    });
    managedTransport.emitHost({
      type: "assistant.completed",
      sessionId,
      turnId,
      itemId: "assistant-1",
      text: "Done",
      at: 12,
    });
    managedTransport.emitHost({
      type: "turn.completed",
      sessionId,
      turnId,
      result: "Done",
      at: 13,
    });
    await waitFor(() => broker.session(sessionId)?.turnState === "idle");
    expect(broker.session(sessionId)).toMatchObject({
      transport: "claude-desktop-managed",
      ownership: "DESKTOP_MANAGED_IDLE",
    });
    expect(eventLog.replay().filter((event) => event.sessionId === sessionId).map((event) => event.type))
      .toEqual(expect.arrayContaining([
        "session.transport",
        "turn.started",
        "user.message.accepted",
        "assistant.completed",
        "turn.completed",
      ]));
    await broker.close();
    await eventLog.close();
  });

  it("runs at most two turns and leaves the third durably queued", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-broker-"));
    directories.push(root);
    const projects = join(root, "projects");
    const sessions = [0, 1, 2].map((index) => observed(randomUUID(), join(root, `project-${index}`)));
    await Promise.all(sessions.map((session) => mkdir(session.cwd, { recursive: true })));
    const observer = new FakeObserver({ projects: [], sessions, observedAt: Date.now() });
    const hosts: FakeHost[] = [];
    const eventLog = new SessionEventLog(join(root, "events.jsonl"));
    const broker = new SessionBroker({
      paths: {
        sessions: join(root, "runtime-sessions"),
        tasks: join(root, "tasks"),
        projects,
        desktopSessions: [],
      },
      eventLog,
      observer,
      sessionsPath: join(root, "sessions.json"),
      queuePath: join(root, "queue.json"),
      maxParallelTurns: 2,
      hostFactory: (options) => {
        const host = new FakeHost(options);
        hosts.push(host);
        return host;
      },
      prepareRuntime: async () => ({
        executablePath: "/fake/claude",
        credentialPath: "/fake/host-creds.json",
        environment: {},
      }),
    });
    await broker.initialize();
    await Promise.all(sessions.map((session, index) => broker.startTurn({
      requestId: `request-${index}`,
      idempotencyKey: `command-${index}`,
      sessionId: session.sessionId,
      text: `Turn ${index}`,
      origin: "mobile",
    })));
    await waitFor(() => hosts.reduce((sum, host) => sum + host.sends, 0) === 2);

    expect(broker.runtimeStatus().activeTurns).toBe(2);
    expect(broker.listSessions().reduce((sum, session) => sum + session.pendingCount, 0)).toBe(1);
    await broker.close();
    await eventLog.close();
  });

  it("marks a running session as waiting and records the first permission resolver", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-broker-permission-"));
    directories.push(root);
    const cwd = join(root, "project");
    const sessionId = randomUUID();
    await mkdir(cwd, { recursive: true });
    const observer = new FakeObserver({
      projects: [],
      sessions: [observed(sessionId, cwd)],
      observedAt: Date.now(),
    });
    const hosts: FakeHost[] = [];
    const eventLog = new SessionEventLog(join(root, "events.jsonl"), 1);
    const broker = new SessionBroker({
      paths: {
        sessions: join(root, "runtime-sessions"),
        tasks: join(root, "tasks"),
        projects: join(root, "projects"),
        desktopSessions: [],
      },
      eventLog,
      observer,
      sessionsPath: join(root, "sessions.json"),
      queuePath: join(root, "queue.json"),
      hostFactory: (options) => {
        const host = new FakeHost(options);
        hosts.push(host);
        return host;
      },
      prepareRuntime: async () => ({
        executablePath: "/fake/claude",
        credentialPath: "/fake/host-creds.json",
        environment: {},
      }),
    });
    await broker.initialize();
    await broker.startTurn({
      requestId: "request-permission",
      idempotencyKey: "command-permission",
      sessionId,
      text: "Update the file",
      origin: "mobile",
    });
    await waitFor(() => hosts[0]?.sends === 1);

    const controller = new AbortController();
    const pending = broker.permissionBroker.request(sessionId, "Write", {
      file_path: join(cwd, "demo.ts"),
      content: "export const ready = true;",
    }, {
      signal: controller.signal,
      toolUseId: "tool-write",
      suggestions: [{
        type: "addDirectories",
        directories: [cwd],
        destination: "localSettings",
      }],
    });
    await waitFor(() => broker.session(sessionId)?.turnState === "waiting");
    await waitFor(() => eventLog.replay().some((event) => event.type === "permission.requested"));
    const [request] = broker.permissionBroker.list(sessionId);
    expect(eventLog.replay().find((event) => event.type === "permission.requested")?.data)
      .toMatchObject({
        requestId: request!.requestId,
        toolName: "Write",
        canAllowAlways: true,
      });

    expect(broker.resolvePermission(
      request!.requestId,
      "allow-always",
      undefined,
      undefined,
      { deviceId: "phone-1", name: "Android 手机" },
    )).toBe(true);
    expect(broker.resolvePermission(request!.requestId, "deny")).toBe(false);
    await expect(pending).resolves.toMatchObject({
      behavior: "allow",
      updatedPermissions: [expect.objectContaining({ destination: "localSettings" })],
    });
    await waitFor(() => eventLog.replay().some((event) => event.type === "permission.resolved"));
    expect(eventLog.replay().find((event) => event.type === "permission.resolved")?.data)
      .toMatchObject({
        requestId: request!.requestId,
        decision: "allow-always",
        resolvedByDeviceId: "phone-1",
        resolvedByName: "Android 手机",
      });
    expect(broker.session(sessionId)?.turnState).toBe("running");

    hosts[0]!.complete();
    await waitFor(() => broker.session(sessionId)?.turnState === "idle");
    await broker.close();
    await eventLog.close();
  });

  it("persists model and effort per session and blocks an unsafe context downgrade", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-broker-config-"));
    directories.push(root);
    const cwd = join(root, "project");
    const projects = join(root, "projects");
    const sessionId = randomUUID();
    const projectDirectory = join(projects, cwd.replace(/[:\\/]/gu, "-"));
    await Promise.all([mkdir(cwd, { recursive: true }), mkdir(projectDirectory, { recursive: true })]);
    await writeFile(join(projectDirectory, `${sessionId}.jsonl`), JSON.stringify({
      type: "assistant",
      uuid: randomUUID(),
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        model: "k3",
        content: "done",
        usage: {
          input_tokens: 1_000,
          cache_read_input_tokens: 300_000,
          cache_creation_input_tokens: 0,
        },
      },
    }));
    const observer = new FakeObserver({
      projects: [],
      sessions: [observed(sessionId, cwd)],
      observedAt: Date.now(),
    });
    const hosts: FakeHost[] = [];
    const eventLog = new SessionEventLog(join(root, "events.jsonl"));
    const sessionsPath = join(root, "sessions.json");
    const broker = new SessionBroker({
      paths: {
        sessions: join(root, "runtime-sessions"),
        tasks: join(root, "tasks"),
        projects,
        desktopSessions: [],
      },
      eventLog,
      observer,
      sessionsPath,
      queuePath: join(root, "queue.json"),
      hostFactory: (options) => {
        const host = new FakeHost(options);
        hosts.push(host);
        return host;
      },
      prepareRuntime: async () => ({
        executablePath: "/fake/claude",
        credentialPath: "/fake/host-creds.json",
        environment: {},
      }),
    });
    await broker.initialize();

    await expect(broker.configuration(sessionId)).resolves.toMatchObject({
      model: "claude-fable-5[1m]",
      effort: "high",
      modelsComplete: true,
    });
    await expect(broker.configureSession({
      sessionId,
      effort: "xhigh",
    })).resolves.toMatchObject({
      model: "claude-fable-5[1m]",
      effort: "xhigh",
      effortSource: "bridge",
    });
    expect(hosts[0]?.options.sessionId).not.toBe(sessionId);
    expect(hosts[0]?.closed).toBe(true);
    expect(broker.session(sessionId)).toMatchObject({
      model: "claude-fable-5[1m]",
      effort: "xhigh",
    });
    await expect(broker.configureSession({
      sessionId,
      model: "claude-fable-5",
    })).rejects.toThrow(/301,000 tokens/u);
    const saved = JSON.parse(await readFile(sessionsPath, "utf8")) as {
      configurations: Array<{ sessionId: string; model?: string; effort?: BridgeEffort; updatedAt: number }>;
    };
    expect(saved.configurations).toEqual([
      expect.objectContaining({ sessionId, effort: "xhigh" }),
    ]);

    await broker.close();
    await eventLog.close();
  });

  it("discovers provider models without attaching to the desktop session", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-broker-discovery-"));
    directories.push(root);
    const cwd = join(root, "project");
    const sessionId = randomUUID();
    await mkdir(cwd, { recursive: true });
    const observer = new FakeObserver({
      projects: [],
      sessions: [observed(sessionId, cwd)],
      observedAt: Date.now(),
    });
    observer.busy = true;
    const hosts: FakeHost[] = [];
    const eventLog = new SessionEventLog(join(root, "events.jsonl"));
    const broker = new SessionBroker({
      paths: {
        sessions: join(root, "runtime-sessions"),
        tasks: join(root, "tasks"),
        projects: join(root, "projects"),
        desktopSessions: [],
      },
      eventLog,
      observer,
      sessionsPath: join(root, "sessions.json"),
      queuePath: join(root, "queue.json"),
      hostFactory: (options) => {
        const host = new FakeHost(options);
        hosts.push(host);
        return host;
      },
      prepareRuntime: async () => ({
        executablePath: "/fake/claude",
        credentialPath: "/fake/host-creds.json",
        environment: {},
      }),
    });
    await broker.initialize();

    await expect(broker.configuration(sessionId)).resolves.toMatchObject({
      model: "claude-fable-5[1m]",
      modelsComplete: true,
    });
    expect(hosts).toHaveLength(1);
    expect(hosts[0]?.options.sessionId).not.toBe(sessionId);
    expect(hosts[0]?.closed).toBe(true);
    expect(broker.session(sessionId)?.ownership).toBe("DESKTOP_OBSERVED");

    await broker.close();
    await eventLog.close();
  });
});
