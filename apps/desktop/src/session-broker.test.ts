import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  bridgeCanStart: boolean | undefined;
  writeVersion = 0;

  constructor(readonly catalog: ClaudeCatalogSnapshot) {
    super();
  }

  isDesktopBusy(): boolean {
    return this.busy;
  }

  externalWriteVersion(): number {
    return this.writeVersion;
  }

  async canStartBridgeHost(): Promise<boolean> {
    return this.bridgeCanStart ?? !this.busy;
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
  interrupts = 0;

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
    this.interrupts += 1;
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

  runTool(itemId: string, output: unknown): void {
    if (!this.current) return;
    this.emit({
      type: "tool.started",
      sessionId: this.options.sessionId,
      turnId: this.current.turnId,
      itemId,
      toolName: "Bash",
      input: { command: "npm test" },
      at: Date.now(),
    });
    this.emit({
      type: "tool.completed",
      sessionId: this.options.sessionId,
      turnId: this.current.turnId,
      itemId,
      output,
      at: Date.now(),
    });
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
  interrupts = 0;

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

  async interrupt(): Promise<void> {
    this.interrupts += 1;
  }
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
    processOverlap: false,
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
  it("creates metadata only for a discovered project without probing its protected path", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-broker-project-"));
    directories.push(root);
    const cwd = join(root, "Documents", "project-not-mounted");
    const sessionId = randomUUID();
    const eventLog = new SessionEventLog(join(root, "events.jsonl"), 1);
    const observer = new FakeObserver({
      projects: [],
      sessions: [observed(sessionId, cwd)],
      observedAt: Date.now(),
    });
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
      prepareRuntime: async () => ({
        executablePath: "/fake/claude",
        credentialPath: "/fake/host-creds.json",
        environment: {},
      }),
    });
    await broker.initialize();

    await expect(access(cwd)).rejects.toThrow();
    await expect(broker.createSession(cwd, "Explicit project")).resolves.toMatchObject({
      cwd,
      title: "Explicit project",
    });
    await expect(broker.createSession(join(root, "Documents", "unknown")))
      .rejects.toThrow(/selected from a discovered Claude project/u);

    await broker.close();
    await eventLog.close();
  });

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
    const managedDesktop = new FakeManagedDesktop();
    managedDesktop.enabled = false;
    managedDesktop.ready = false;
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
      managedDesktop,
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
    expect(managedDesktop.stopped).toBe(false);
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
    await waitFor(() => (
      eventLog.replay().some((event) => event.type === "turn.completed") &&
      broker.session(sessionId)?.turnState === "idle"
    ));
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

  it("rechecks live writers before spawning when the observer cache is stale", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-broker-live-writer-"));
    directories.push(root);
    const cwd = join(root, "project");
    const projects = join(root, "projects");
    const sessionId = randomUUID();
    const transcriptDirectory = join(projects, cwd.replace(/[:\\/]/gu, "-"));
    await Promise.all([
      mkdir(cwd, { recursive: true }),
      mkdir(transcriptDirectory, { recursive: true }),
    ]);
    await writeFile(join(transcriptDirectory, `${sessionId}.jsonl`), "");
    const observer = new FakeObserver({
      projects: [],
      sessions: [observed(sessionId, cwd)],
      observedAt: Date.now() - 10_000,
    });
    const hosts: FakeHost[] = [];
    let scans = 0;
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
      scanSessionProcesses: async () => {
        scans += 1;
        return [{
          pid: process.pid,
          cwd,
          startedAt: Date.now(),
          processAlive: true,
          entrypoint: "claude-desktop-3p",
          peerProtocol: "stream-json",
          source: "registration",
        }];
      },
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
      requestId: "request-live-writer",
      idempotencyKey: "command-live-writer",
      sessionId,
      text: "Continue without racing Claude Desktop",
      origin: "mobile",
    });
    await waitFor(() => scans > 0);

    expect(hosts).toHaveLength(0);
    expect(broker.session(sessionId)).toMatchObject({
      ownership: "DESKTOP_OBSERVED",
      turnState: "queued",
      pendingCount: 1,
    });
    expect(eventLog.replay().some((event) => (
      event.sessionId === sessionId
      && event.type === "session.ownership"
      && event.data.ownership === "DESKTOP_OBSERVED"
    ))).toBe(true);

    await broker.close();
    await eventLog.close();
  });

  it("waits for an active Desktop turn, then starts without closing an idle session viewer", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-broker-writer-"));
    directories.push(root);
    const cwd = join(root, "project");
    const projects = join(root, "projects");
    const sessionId = randomUUID();
    const transcriptDirectory = join(projects, cwd.replace(/[:\\/]/gu, "-"));
    await Promise.all([
      mkdir(cwd, { recursive: true }),
      mkdir(transcriptDirectory, { recursive: true }),
    ]);
    await writeFile(join(transcriptDirectory, `${sessionId}.jsonl`), "");
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
    observer.bridgeCanStart = false;
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

    observer.bridgeCanStart = true;
    observer.publish();
    await waitFor(() => hosts[0]?.sends === 1);
    expect(desktopSession.desktopProcessAlive).toBe(true);
    expect(broker.session(sessionId)).toMatchObject({
      ownership: "BRIDGE_RUNNING",
      turnState: "running",
    });
    await broker.close();
    await eventLog.close();
  });

  it("resumes beside a completed persistent Desktop viewer without quitting Claude Desktop", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-broker-takeover-"));
    directories.push(root);
    const cwd = join(root, "project");
    const projects = join(root, "projects");
    const sessionId = randomUUID();
    const transcriptDirectory = join(projects, cwd.replace(/[:\\/]/gu, "-"));
    await Promise.all([
      mkdir(cwd, { recursive: true }),
      mkdir(transcriptDirectory, { recursive: true }),
    ]);
    await writeFile(join(transcriptDirectory, `${sessionId}.jsonl`), "");
    const desktopSession = observed(sessionId, cwd);
    desktopSession.desktopProcessAlive = true;
    desktopSession.processAlive = true;
    const observer = new FakeObserver({
      projects: [],
      sessions: [desktopSession],
      observedAt: Date.now(),
    });
    const hosts: FakeHost[] = [];
    const managedDesktop = new FakeManagedDesktop();
    managedDesktop.enabled = false;
    managedDesktop.ready = false;
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
      managedDesktop,
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
      requestId: "request-takeover",
      idempotencyKey: "command-takeover",
      sessionId,
      text: "Continue in the same transcript",
      origin: "mobile",
    });

    await waitFor(() => hosts[0]?.sends === 1);
    expect(managedDesktop.stopped).toBe(false);
    expect(hosts[0]!.options).toMatchObject({ sessionId, resume: true });
    expect(broker.session(sessionId)).toMatchObject({
      ownership: "BRIDGE_RUNNING",
      transport: "bridge-host",
    });
    expect(desktopSession.desktopProcessAlive).toBe(true);

    await broker.close();
    await eventLog.close();
  });

  it("requeues a Bridge turn without cancelling it when Desktop creates a competing writer", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-broker-conflict-"));
    directories.push(root);
    const cwd = join(root, "project");
    const sessionId = randomUUID();
    await mkdir(cwd, { recursive: true });
    const desktopSession = observed(sessionId, cwd);
    const observer = new FakeObserver({
      projects: [],
      sessions: [desktopSession],
      observedAt: Date.now(),
    });
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
      requestId: "request-conflict",
      idempotencyKey: "command-conflict",
      sessionId,
      text: "Keep this command queued",
      origin: "mobile",
    });
    await waitFor(() => hosts[0]?.sends === 1);

    desktopSession.desktopProcessAlive = true;
    desktopSession.bridgeProcessAlive = true;
    desktopSession.processAlive = true;
    desktopSession.processOverlap = true;
    desktopSession.activeProcesses = [
      {
        pid: 101,
        startedAt: Date.now(),
        processAlive: true,
        entrypoint: "claude-desktop-3p",
        source: "process",
      },
      {
        pid: 102,
        startedAt: Date.now(),
        processAlive: true,
        entrypoint: "claude-bridge",
        source: "process",
      },
    ];
    observer.publish();

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(hosts[0]?.closed).toBe(false);
    expect(broker.session(sessionId)).toMatchObject({
      ownership: "BRIDGE_RUNNING",
      turnState: "running",
      pendingCount: 0,
    });
    expect(eventLog.replay().filter((event) => (
      event.sessionId === sessionId && event.type === "session.ownership-conflict"
    ))).toHaveLength(0);

    observer.writeVersion += 1;
    observer.publish();
    await waitFor(() => {
      const session = broker.session(sessionId);
      return (
        hosts[0]?.closed === true &&
        hosts.length === 1 &&
        session?.ownership === "OWNERSHIP_CONFLICT" &&
        session.turnState === "queued" &&
        session.pendingCount === 1
      );
    });
    expect(hosts[0]?.interrupts).toBe(0);
    expect(hosts).toHaveLength(1);
    expect(broker.session(sessionId)).toMatchObject({
      ownership: "OWNERSHIP_CONFLICT",
      turnState: "queued",
      pendingCount: 1,
    });
    expect(eventLog.replay().filter((event) => (
      event.sessionId === sessionId && event.type === "turn.interrupted"
    ))).toHaveLength(0);
    expect(eventLog.replay().filter((event) => (
      event.sessionId === sessionId && event.type === "session.ownership-conflict"
    ))).toHaveLength(1);
    expect([...eventLog.replay()].reverse().find((event) => (
      event.sessionId === sessionId && event.type === "turn.queued"
    ))?.data).toMatchObject({
      commandId: expect.any(String),
      retrying: true,
      reason: "ownership-conflict",
    });

    desktopSession.desktopProcessAlive = false;
    desktopSession.bridgeProcessAlive = false;
    desktopSession.processAlive = false;
    desktopSession.processOverlap = false;
    desktopSession.activeProcesses = [];
    observer.publish();
    await waitFor(() => hosts[1]?.sends === 1);
    expect(hosts[1]?.options.sessionId).toBe(sessionId);

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
    desktopSession.bridgeProcessAlive = true;
    desktopSession.processOverlap = true;
    desktopSession.activeProcesses = [
      {
        pid: 201,
        startedAt: Date.now(),
        processAlive: true,
        entrypoint: "claude-desktop-3p",
        source: "process",
      },
      {
        pid: 202,
        startedAt: Date.now(),
        processAlive: true,
        entrypoint: "claude-bridge",
        source: "process",
      },
    ];
    observer.publish();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(eventLog.replay().some((event) => (
      event.sessionId === sessionId && event.type === "session.ownership-conflict"
    ))).toBe(false);
    expect(managedTransport.interrupts).toBe(0);
    desktopSession.bridgeProcessAlive = false;
    desktopSession.processOverlap = false;
    desktopSession.activeProcesses = [];
    observer.publish();
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

  it("lets a force stop remove a Bridge turn restored as queued after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-broker-restart-stop-"));
    directories.push(root);
    const cwd = join(root, "project");
    const sessionId = randomUUID();
    const queuePath = join(root, "queue.json");
    await mkdir(cwd, { recursive: true });
    await writeFile(queuePath, JSON.stringify({
      version: 2,
      pending: [{
        commandId: "restart-command",
        requestId: "restart-request",
        idempotencyKey: "restart-idempotency",
        sessionId,
        text: "stale task",
        attachments: [],
        origin: "desktop",
        requestedAt: 1_000,
        priority: 0,
        attempts: 1,
        state: "running",
        mode: "start",
        transport: "bridge-host",
        turnId: "restart-turn",
        evidenceId: "restart-evidence",
      }],
      completedIdempotencyKeys: [],
      terminalTurns: [],
    }));
    const observer = new FakeObserver({
      projects: [],
      sessions: [observed(sessionId, cwd)],
      observedAt: Date.now(),
    });
    observer.busy = true;
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
      queuePath,
      prepareRuntime: async () => ({
        executablePath: "/fake/claude",
        credentialPath: "/fake/host-creds.json",
        environment: {},
      }),
    });
    await broker.initialize();
    expect(broker.session(sessionId)).toMatchObject({
      turnState: "queued",
      pendingCount: 1,
    });

    await expect(broker.interruptTurn(sessionId, undefined, true)).resolves.toBe(true);

    expect(broker.session(sessionId)).toMatchObject({
      ownership: "DESKTOP_OBSERVED",
      turnState: "running",
      pendingCount: 0,
    });
    expect(JSON.parse(await readFile(queuePath, "utf8"))).toMatchObject({
      pending: [],
      terminalTurns: [{
        commandId: "restart-command",
        state: "cancelled",
      }],
    });
    expect(eventLog.replay().at(-1)).toMatchObject({
      type: "turn.interrupted",
      itemId: "restart-command",
    });
    await broker.close();
    await eventLog.close();
  });

  it("surfaces a rotated-session queue as a blocked recovery task instead of replaying it", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-broker-orphan-stop-"));
    directories.push(root);
    const cwd = join(root, "project");
    const projectsRoot = join(root, "projects");
    const staleSessionId = randomUUID();
    const currentSessionId = randomUUID();
    const queuePath = join(root, "queue.json");
    await Promise.all([mkdir(cwd, { recursive: true }), mkdir(projectsRoot, { recursive: true })]);
    await writeFile(
      join(projectsRoot, `${staleSessionId}.jsonl`),
      `${JSON.stringify({ type: "attachment", sessionId: staleSessionId, cwd })}\n`,
    );
    await writeFile(queuePath, JSON.stringify({
      version: 2,
      pending: [{
        commandId: "orphan-command",
        requestId: "orphan-request",
        idempotencyKey: "orphan-idempotency",
        sessionId: staleSessionId,
        text: "stale task after install",
        attachments: [],
        origin: "desktop",
        requestedAt: 1_000,
        priority: 0,
        attempts: 0,
        state: "running",
        mode: "start",
        transport: "bridge-host",
      }],
      completedIdempotencyKeys: [],
      terminalTurns: [],
    }));
    const observer = new FakeObserver({
      projects: [],
      sessions: [observed(currentSessionId, cwd)],
      observedAt: Date.now(),
    });
    const hosts: FakeHost[] = [];
    const eventLog = new SessionEventLog(join(root, "events.jsonl"));
    const broker = new SessionBroker({
      paths: {
        sessions: join(root, "runtime-sessions"),
        tasks: join(root, "tasks"),
        projects: projectsRoot,
        desktopSessions: [],
      },
      eventLog,
      observer,
      sessionsPath: join(root, "sessions.json"),
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
      }),
    });

    await broker.initialize();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(hosts).toHaveLength(0);
    expect(broker.session(staleSessionId)).toMatchObject({
      cwd,
      title: "未完成任务：stale task after install",
      source: "bridge",
      ownership: "BRIDGE_IDLE",
      turnState: "queued",
      pendingCount: 1,
    });

    await expect(broker.interruptTurn(staleSessionId, undefined, true)).resolves.toBe(true);
    expect(broker.session(staleSessionId)).toBeUndefined();
    expect(JSON.parse(await readFile(queuePath, "utf8"))).toMatchObject({
      pending: [],
      terminalTurns: [{
        commandId: "orphan-command",
        state: "cancelled",
      }],
    });
    await broker.close();
    await eventLog.close();
  });

  it("force-stops an unavailable managed turn so later sessions can run", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-broker-uncertain-stop-"));
    directories.push(root);
    const staleSessionId = randomUUID();
    const nextSessionId = randomUUID();
    const staleCwd = join(root, "stale-project");
    const nextCwd = join(root, "next-project");
    const queuePath = join(root, "queue.json");
    await Promise.all([mkdir(staleCwd, { recursive: true }), mkdir(nextCwd, { recursive: true })]);
    await writeFile(queuePath, JSON.stringify({
      version: 2,
      pending: [{
        commandId: "uncertain-command",
        requestId: "uncertain-request",
        idempotencyKey: "uncertain-idempotency",
        sessionId: staleSessionId,
        text: "stale managed task",
        attachments: [],
        origin: "desktop",
        requestedAt: 1_000,
        priority: 0,
        attempts: 1,
        state: "running",
        mode: "start",
        transport: "claude-desktop-managed",
        turnId: "uncertain-turn",
      }],
      completedIdempotencyKeys: [],
      terminalTurns: [],
    }));
    const observer = new FakeObserver({
      projects: [],
      sessions: [
        observed(staleSessionId, staleCwd),
        observed(nextSessionId, nextCwd),
      ],
      observedAt: Date.now(),
    });
    const managedTransport = new FakeManagedTransport();
    managedTransport.ready = false;
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
      queuePath,
      maxParallelTurns: 1,
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
    await broker.startTurn({
      requestId: "next-request",
      idempotencyKey: "next-idempotency",
      sessionId: nextSessionId,
      text: "run after stale task",
      origin: "desktop",
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(hosts).toHaveLength(0);

    await expect(broker.interruptTurn(staleSessionId, undefined, true)).resolves.toBe(true);
    await waitFor(() => hosts[0]?.sends === 1);

    expect(broker.session(staleSessionId)).toMatchObject({
      turnState: "idle",
      pendingCount: 0,
    });
    expect(hosts[0]?.options.sessionId).toBe(nextSessionId);
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
    expect(hosts[0]?.options.cwd).toBe(root);
    expect(hosts[0]?.options.settingSources).toEqual([]);
    expect(hosts[0]?.options.persistSession).toBe(false);
    expect(hosts[0]?.closed).toBe(true);
    expect(broker.session(sessionId)?.ownership).toBe("DESKTOP_OBSERVED");

    await broker.close();
    await eventLog.close();
  });

  it("preserves complete Agent SDK tool results in the turn evidence lifecycle", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-broker-evidence-"));
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
    const calls: Array<{ type: string; value?: unknown }> = [];
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
      evidence: {
        async startBridgeTurn(input) {
          calls.push({ type: "start", value: input });
          return "evidence-1";
        },
        async attachTurn(_evidenceId, turnId) {
          calls.push({ type: "attach", value: turnId });
        },
        async recordToolStarted(input) {
          calls.push({ type: "tool-start", value: input });
        },
        async recordToolCompleted(input) {
          calls.push({ type: "tool-complete", value: input.output });
        },
        async finalizeBridgeTurn(input) {
          calls.push({ type: "finalize", value: input });
          return undefined;
        },
      },
    });
    await broker.initialize();
    await broker.startTurn({
      requestId: "request-1",
      idempotencyKey: "idempotency-1",
      sessionId,
      text: "Run tests",
      origin: "mobile",
    });
    await waitFor(() => hosts.some((host) => host.current));
    const host = hosts.find((candidate) => candidate.options.sessionId === sessionId)!;
    host.runTool("tool-1", {
      exitCode: 1,
      stdout: "full command output",
      stderr: "failed",
    });
    host.complete();
    await waitFor(() => calls.some((call) => call.type === "finalize"));

    expect(calls.map((call) => call.type)).toEqual(expect.arrayContaining([
      "start",
      "attach",
      "tool-start",
      "tool-complete",
      "finalize",
    ]));
    expect(calls.find((call) => call.type === "tool-complete")?.value).toEqual({
      exitCode: 1,
      stdout: "full command output",
      stderr: "failed",
    });
    expect(calls.findIndex((call) => call.type === "start"))
      .toBeLessThan(calls.findIndex((call) => call.type === "attach"));

    await broker.close();
    await eventLog.close();
  });
});
