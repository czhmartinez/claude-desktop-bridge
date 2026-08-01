import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  BridgeHistoryPage,
  BridgeProviderProfile,
  BridgeSessionInfo,
} from "@bridge/protocol";
import {
  ANTHROPIC_API_PROFILE_ID,
  CLAUDE_OFFICIAL_PROFILE_ID,
  ConversationStateStore,
} from "./conversation-state-store.js";
import { HandoffService } from "./handoff-service.js";
import type { ClaudeCatalogSnapshot } from "./claude-session-catalog.js";
import type { EvidenceManager } from "./evidence-manager.js";
import type { ProviderRegistry } from "./provider-registry.js";
import { ProviderRuntimePool } from "./provider-runtime-pool.js";
import type { SessionBroker, TurnReceipt } from "./session-broker.js";
import { SessionEventLog } from "./session-event-log.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

class Observer extends EventEmitter {
  aliases = new Map<string, string>();

  constructor(readonly catalog: ClaudeCatalogSnapshot) {
    super();
  }

  onCatalog(listener: (catalog: ClaudeCatalogSnapshot) => void): () => void {
    this.on("catalog", listener);
    return () => this.off("catalog", listener);
  }

  setSessionAlias(nativeSessionId: string, logicalSessionId: string): void {
    this.aliases.set(nativeSessionId, logicalSessionId);
  }

  publish(): void {
    this.emit("catalog", this.catalog);
  }
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for handoff state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "bridge-handoff-"));
  directories.push(root);
  const cwd = join(root, "project");
  const projects = join(root, "projects");
  await Promise.all([mkdir(cwd), mkdir(projects)]);
  const state = new ConversationStateStore({
    databasePath: join(root, "state.sqlite"),
    sessionsPath: join(root, "sessions.json"),
    queuePath: join(root, "queue.json"),
    masterSecret: "handoff-test",
  });
  await state.initialize();
  const sessionId = "11111111-1111-4111-8111-111111111111";
  state.ensureConversation({
    conversationId: sessionId,
    cwd,
    title: "Bridge conversation",
    source: "bridge",
  });
  const apiProfile: BridgeProviderProfile = {
    id: ANTHROPIC_API_PROFILE_ID,
    kind: "anthropic-api",
    name: "Anthropic API",
    status: "ready",
    detail: "Ready",
    configured: true,
    localOnlyConfiguration: true,
    readOnly: false,
    models: [{
      id: "claude-test",
      displayName: "Claude Test",
      capabilities: {},
    }],
    defaultModel: "claude-test",
  };
  const officialProfile: BridgeProviderProfile = {
    id: CLAUDE_OFFICIAL_PROFILE_ID,
    kind: "claude-official",
    name: "Claude 官方订阅",
    status: "ready",
    detail: "Ready",
    configured: true,
    localOnlyConfiguration: false,
    readOnly: true,
    models: [],
  };
  state.saveProviderProfile(apiProfile);
  state.saveProviderProfile(officialProfile);
  const profiles = new Map([
    [apiProfile.id, apiProfile],
    [officialProfile.id, officialProfile],
  ]);
  const registry = {
    get: (profileId: string) => profiles.get(profileId),
    anthropicApiKey: async () => "sk-ant-test",
  } as unknown as ProviderRegistry;
  const runtimePool = new ProviderRuntimePool(registry);
  const session: BridgeSessionInfo = {
    sessionId,
    projectId: "project",
    projectName: "project",
    cwd,
    title: "Bridge conversation",
    source: "bridge",
    transport: "bridge-host",
    ownership: "BRIDGE_IDLE",
    turnState: "idle",
    lastActivityAt: Date.now(),
    pendingCount: 0,
  };
  const commands: string[] = [];
  const broker = {
    hasActiveOrPending: () => false,
    conversationRoute: () => state.route(sessionId)!,
    session: (id: string) => id === sessionId ? session : undefined,
    history: async (): Promise<BridgeHistoryPage> => ({
      sessionId,
      items: [
        {
          id: "user-1",
          sessionId,
          role: "user",
          text: "必须继续实现，不要泄露 sk-ant-secret-1234567890",
          createdAt: Date.now() - 1_000,
          origin: "desktop",
        },
        {
          id: "assistant-1",
          sessionId,
          role: "assistant",
          text: "已完成第一步。",
          createdAt: Date.now() - 500,
          origin: "claude-host",
        },
      ],
      hasMore: false,
    }),
    startHandoffTurn: async (input: { handoffId: string }) => {
      const commandId = `command:${input.handoffId}`;
      commands.push(commandId);
      return {
        commandId,
        requestId: input.handoffId,
        idempotencyKey: `handoff:${input.handoffId}`,
        sessionId,
        laneId: "lane-api",
        text: "handoff",
        attachments: [],
        origin: "system",
        requestedAt: Date.now(),
        priority: 200,
        attempts: 0,
        state: "queued",
      };
    },
    interruptTurn: async () => true,
  } as unknown as SessionBroker;
  const evidence = {
    list: () => ({
      sessionId,
      items: [],
      hasMore: false,
    }),
  } as unknown as EvidenceManager;
  const eventLog = new SessionEventLog(join(root, "events.jsonl"), 0);
  const observer = new Observer({ projects: [], sessions: [], observedAt: Date.now() });
  const opened: string[] = [];
  const createService = () => new HandoffService({
    state,
    broker,
    eventLog,
    evidence,
    providers: registry,
    runtimePool,
    observer,
    paths: {
      sessions: join(root, "sessions"),
      tasks: join(root, "tasks"),
      projects,
      desktopSessions: [],
    },
    openExternal: async (url) => {
      opened.push(url);
    },
  });
  const service = createService();
  await service.initialize();
  return {
    root,
    cwd,
    projects,
    state,
    sessionId,
    service,
    createService,
    eventLog,
    observer,
    commands,
    opened,
  };
}

async function addOfficialCandidate(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  nativeSessionId: string,
  prompt: string,
  activityOffset: number,
): Promise<void> {
  const transcriptPath = join(fixture.projects, `${nativeSessionId}.jsonl`);
  await writeFile(transcriptPath, `${JSON.stringify({
    type: "user",
    uuid: randomCandidateMessageId(nativeSessionId),
    parentUuid: null,
    timestamp: new Date().toISOString(),
    message: {
      role: "user",
      content: [{ type: "text", text: prompt }],
    },
  })}\n`, "utf8");
  fixture.observer.catalog.sessions.push({
    sessionId: nativeSessionId,
    projectId: "project",
    projectName: "project",
    cwd: fixture.cwd,
    title: "Official handoff",
    source: "desktop",
    transport: "bridge-host",
    ownership: "DESKTOP_OBSERVED",
    turnState: "idle",
    lastActivityAt: Date.now() + activityOffset,
    pendingCount: 0,
    transcriptPath,
    transcriptMtimeMs: Date.now(),
    processAlive: true,
    desktopProcessAlive: true,
    bridgeProcessAlive: false,
    processOverlap: false,
    activeProcesses: [],
    activeTask: false,
    sourceProfile: "claude",
  });
}

function randomCandidateMessageId(nativeSessionId: string): string {
  return nativeSessionId.replace(/^./u, "3");
}

describe("HandoffService", () => {
  it("keeps the old lane active until the executable target accepts the first message", async () => {
    const fixture = await createFixture();
    const sourceLaneId = fixture.state.route(fixture.sessionId)!.activeLaneId;
    const preview = await fixture.service.preview({
      sessionId: fixture.sessionId,
      targetProviderProfileId: ANTHROPIC_API_PROFILE_ID,
      model: "claude-test",
    });
    expect(preview.handoff.state).toBe("previewed");
    expect(fixture.state.route(fixture.sessionId)?.activeLaneId).toBe(sourceLaneId);
    const stored = fixture.state.handoffPackage(preview.handoff.handoffId);
    expect(JSON.stringify(stored?.package)).not.toContain("sk-ant-secret");
    expect(JSON.stringify(stored?.package)).toContain("[REDACTED_API_KEY]");

    const committed = await fixture.service.commit({ handoffId: preview.handoff.handoffId });
    expect(committed.handoff.state).toBe("activating");
    expect(fixture.state.route(fixture.sessionId)?.activeLaneId).toBe(sourceLaneId);
    const commandId = fixture.commands[0]!;

    await fixture.eventLog.append({
      sessionId: fixture.sessionId,
      origin: "system",
      type: "user.message.accepted",
      data: { commandId, delivery: "session-received" },
    });
    await waitFor(() => fixture.state.handoff(preview.handoff.handoffId)?.state === "applied");
    expect(fixture.state.route(fixture.sessionId)).toMatchObject({
      activeProviderProfileId: ANTHROPIC_API_PROFILE_ID,
      state: "ready",
    });
    await fixture.service.close();
    fixture.state.close();
  });

  it("fails closed on uncertain activation and preserves the source route", async () => {
    const fixture = await createFixture();
    const sourceLaneId = fixture.state.route(fixture.sessionId)!.activeLaneId;
    const preview = await fixture.service.preview({
      sessionId: fixture.sessionId,
      targetProviderProfileId: ANTHROPIC_API_PROFILE_ID,
    });
    await fixture.service.commit({ handoffId: preview.handoff.handoffId });
    await fixture.eventLog.append({
      sessionId: fixture.sessionId,
      origin: "system",
      type: "runtime.error",
      data: {
        commandId: fixture.commands[0],
        error: "delivery uncertain",
      },
    });
    await waitFor(() => fixture.state.handoff(preview.handoff.handoffId)?.state === "failed");
    expect(fixture.state.route(fixture.sessionId)?.activeLaneId).toBe(sourceLaneId);
    await fixture.service.close();
    fixture.state.close();
  });

  it("does not replay an activating handoff after a Bridge restart", async () => {
    const fixture = await createFixture();
    const sourceLaneId = fixture.state.route(fixture.sessionId)!.activeLaneId;
    const preview = await fixture.service.preview({
      sessionId: fixture.sessionId,
      targetProviderProfileId: ANTHROPIC_API_PROFILE_ID,
    });
    await fixture.service.commit({ handoffId: preview.handoff.handoffId });
    expect(fixture.commands).toHaveLength(1);
    await fixture.service.close();

    const restarted = fixture.createService();
    await restarted.initialize();

    expect(fixture.commands).toHaveLength(1);
    expect(fixture.state.handoff(preview.handoff.handoffId)).toMatchObject({
      state: "failed",
      error: expect.stringContaining("避免重复发送"),
    });
    expect(fixture.state.route(fixture.sessionId)?.activeLaneId).toBe(sourceLaneId);
    await restarted.close();
    fixture.state.close();
  });

  it("opens the public Claude deep link and activates only after exact transcript association", async () => {
    const fixture = await createFixture();
    const preview = await fixture.service.preview({
      sessionId: fixture.sessionId,
      targetProviderProfileId: CLAUDE_OFFICIAL_PROFILE_ID,
    });
    const waiting = await fixture.service.commit({ handoffId: preview.handoff.handoffId });
    expect(waiting.handoff.state).toBe("awaiting_user_confirmation");
    expect(fixture.opened).toHaveLength(1);
    const prompt = new URL(fixture.opened[0]!).searchParams.get("q")!;
    expect(prompt).toContain(preview.handoff.handoffId);

    const officialSessionId = "22222222-2222-4222-8222-222222222222";
    await writeFile(join(fixture.projects, `${officialSessionId}.jsonl`), `${JSON.stringify({
      type: "user",
      uuid: "33333333-3333-4333-8333-333333333333",
      parentUuid: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "user",
        content: [{ type: "text", text: prompt }],
      },
    })}\n`, "utf8");
    fixture.observer.catalog.sessions.push({
      sessionId: officialSessionId,
      projectId: "project",
      projectName: "project",
      cwd: fixture.cwd,
      title: "Official handoff",
      source: "desktop",
      transport: "bridge-host",
      ownership: "DESKTOP_OBSERVED",
      turnState: "idle",
      lastActivityAt: Date.now() + 100,
      pendingCount: 0,
      transcriptPath: join(fixture.projects, `${officialSessionId}.jsonl`),
      transcriptMtimeMs: Date.now(),
      processAlive: true,
      desktopProcessAlive: true,
      bridgeProcessAlive: false,
      processOverlap: false,
      activeProcesses: [],
      activeTask: false,
      sourceProfile: "claude",
    });
    fixture.observer.publish();

    await waitFor(() => fixture.state.handoff(preview.handoff.handoffId)?.state === "applied");
    expect(fixture.state.route(fixture.sessionId)).toMatchObject({
      activeProviderProfileId: CLAUDE_OFFICIAL_PROFILE_ID,
      allowedActions: {
        canSend: false,
        canContinueOfficial: true,
      },
    });
    expect(fixture.observer.aliases.get(officialSessionId)).toBe(fixture.sessionId);
    await fixture.service.close();
    fixture.state.close();
  });

  it("requires an explicit choice when more than one official session matches", async () => {
    const fixture = await createFixture();
    const sourceLaneId = fixture.state.route(fixture.sessionId)!.activeLaneId;
    const preview = await fixture.service.preview({
      sessionId: fixture.sessionId,
      targetProviderProfileId: CLAUDE_OFFICIAL_PROFILE_ID,
    });
    await fixture.service.commit({ handoffId: preview.handoff.handoffId });
    const prompt = new URL(fixture.opened[0]!).searchParams.get("q")!;
    const first = "44444444-4444-4444-8444-444444444444";
    const second = "55555555-5555-4555-8555-555555555555";
    await addOfficialCandidate(fixture, first, prompt, 100);
    await addOfficialCandidate(fixture, second, prompt, 200);
    fixture.observer.publish();

    await waitFor(() => fixture.state.handoff(preview.handoff.handoffId)?.state === "awaiting_target");
    expect(fixture.state.route(fixture.sessionId)).toMatchObject({
      activeLaneId: sourceLaneId,
      state: "awaiting-target-selection",
      pendingHandoff: {
        candidateNativeSessionIds: [first, second],
      },
    });

    await fixture.service.commit({
      handoffId: preview.handoff.handoffId,
      targetNativeSessionId: second,
    });
    expect(fixture.state.route(fixture.sessionId)).toMatchObject({
      activeProviderProfileId: CLAUDE_OFFICIAL_PROFILE_ID,
      state: "ready",
    });
    expect(fixture.state.activeLane(fixture.sessionId)?.nativeSessionId).toBe(second);
    await fixture.service.close();
    fixture.state.close();
  });
});
