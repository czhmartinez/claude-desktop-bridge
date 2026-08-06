import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ANTHROPIC_API_PROFILE_ID,
  CLAUDE_OFFICIAL_PROFILE_ID,
  ConversationStateStore,
} from "./conversation-state-store.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

async function createStore(): Promise<{
  directory: string;
  sessionsPath: string;
  queuePath: string;
  databasePath: string;
  store: ConversationStateStore;
}> {
  const directory = await mkdtemp(join(tmpdir(), "bridge-conversation-state-"));
  directories.push(directory);
  const sessionsPath = join(directory, "sessions-v2.json");
  const queuePath = join(directory, "turn-queue-v2.json");
  const databasePath = join(directory, "conversation-state-v1.sqlite");
  const store = new ConversationStateStore({
    databasePath,
    sessionsPath,
    queuePath,
    masterSecret: "test-conversation-state-secret",
  });
  return { directory, sessionsPath, queuePath, databasePath, store };
}

describe("ConversationStateStore", () => {
  it("transactionally migrates legacy sessions and fixes every queued item to its lane", async () => {
    const fixture = await createStore();
    await writeFile(fixture.sessionsPath, JSON.stringify({
      version: 2,
      sessions: [{
        sessionId: "session-1",
        cwd: "/tmp/project-one",
        title: "Project one",
        createdAt: 1_000,
      }],
      configurations: [{
        sessionId: "session-1",
        model: "claude-fable-5",
        updatedAt: 1_100,
      }],
    }), "utf8");
    await writeFile(fixture.queuePath, JSON.stringify({
      version: 2,
      pending: [{
        commandId: "command-1",
        requestId: "request-1",
        idempotencyKey: "idempotency-1",
        sessionId: "session-1",
        text: "continue",
        attachments: [],
        origin: "mobile",
        requestedAt: 1_200,
        priority: 0,
        attempts: 0,
        state: "queued",
      }],
      completedIdempotencyKeys: ["already-complete"],
      terminalTurns: [],
    }), "utf8");

    await fixture.store.initialize();
    const state = fixture.store.loadBrokerState();
    expect(state.sessions).toHaveLength(1);
    expect(state.configurations).toHaveLength(1);
    expect(state.pending).toEqual([
      expect.objectContaining({
        commandId: "command-1",
        laneId: "lane:claude-3p:session-1",
      }),
    ]);
    expect(fixture.store.route("session-1")).toMatchObject({
      activeLaneId: "lane:claude-3p:session-1",
      activeProviderProfileId: "provider:claude-3p:default",
      state: "ready",
    });

    expect(await fixture.store.recordSuccessfulStartup()).toBe(1);
    await expect(stat(fixture.sessionsPath)).resolves.toBeDefined();
    expect(await fixture.store.recordSuccessfulStartup()).toBe(2);
    await expect(stat(`${fixture.sessionsPath}.migrated`)).resolves.toBeDefined();
    await expect(stat(`${fixture.queuePath}.migrated`)).resolves.toBeDefined();
    await expect(stat(fixture.sessionsPath)).rejects.toMatchObject({ code: "ENOENT" });

    fixture.store.close();
    const reopened = new ConversationStateStore({
      databasePath: fixture.databasePath,
      sessionsPath: fixture.sessionsPath,
      queuePath: fixture.queuePath,
      masterSecret: "test-conversation-state-secret",
    });
    await reopened.initialize();
    expect(reopened.loadBrokerState().pending[0]?.laneId).toBe("lane:claude-3p:session-1");
    reopened.close();
  });

  it("normalizes fractional observed timestamps for strict SQLite columns", async () => {
    const fixture = await createStore();
    await fixture.store.initialize();
    const route = fixture.store.ensureConversation({
      conversationId: "fractional-time",
      cwd: "/tmp/project",
      title: "Observed conversation",
      source: "desktop",
      createdAt: 1_000.75,
    });
    expect(route.lanes[0]).toMatchObject({
      createdAt: 1_000,
      updatedAt: 1_000,
      lastUsedAt: 1_000,
    });

    const lane = fixture.store.createLane({
      conversationId: "fractional-time",
      providerProfileId: ANTHROPIC_API_PROFILE_ID,
      providerKind: "anthropic-api",
      nativeSessionId: "fractional-native",
      access: "read-write",
      createdAt: 2_000.9,
    });
    expect(lane).toMatchObject({ createdAt: 2_000, updatedAt: 2_000 });
    expect(fixture.store.updateLane(lane.laneId, {
      lastUsedAt: 2_001.9,
    }).lastUsedAt).toBe(2_001);

    expect(fixture.store.saveHandoff({
      handoffId: "fractional-handoff",
      conversationId: "fractional-time",
      sourceLaneId: route.activeLaneId,
      targetProviderProfileId: ANTHROPIC_API_PROFILE_ID,
      targetLaneId: lane.laneId,
      state: "previewed",
      summary: "Continue",
      requiresUserConfirmation: false,
      createdAt: 3_000.8,
      updatedAt: 3_001.8,
      expiresAt: 3_002.8,
    })).toMatchObject({
      createdAt: 3_000,
      updatedAt: 3_001,
      expiresAt: 3_002,
    });
    fixture.store.close();
  });

  it("keys native sessions by provider profile instead of native ID alone", async () => {
    const fixture = await createStore();
    await fixture.store.initialize();
    fixture.store.ensureConversation({
      conversationId: "conversation-1",
      cwd: "/tmp/project",
      title: "Conversation",
      source: "bridge",
    });
    const apiLane = fixture.store.createLane({
      conversationId: "conversation-1",
      providerProfileId: ANTHROPIC_API_PROFILE_ID,
      providerKind: "anthropic-api",
      nativeSessionId: "same-native-id",
      access: "read-write",
    });
    const officialLane = fixture.store.createLane({
      conversationId: "conversation-1",
      providerProfileId: CLAUDE_OFFICIAL_PROFILE_ID,
      providerKind: "claude-official",
      nativeSessionId: "same-native-id",
      access: "read-only",
    });
    expect(apiLane.nativeSessionId).toBe(officialLane.nativeSessionId);
    expect(() => fixture.store.createLane({
      conversationId: "conversation-1",
      providerProfileId: ANTHROPIC_API_PROFILE_ID,
      providerKind: "anthropic-api",
      nativeSessionId: "same-native-id",
      access: "read-write",
    })).toThrow();
    fixture.store.close();
  });

  it("encrypts complete handoff packages and only changes routes atomically", async () => {
    const fixture = await createStore();
    await fixture.store.initialize();
    const route = fixture.store.ensureConversation({
      conversationId: "conversation-1",
      cwd: "/tmp/project",
      title: "Conversation",
      source: "bridge",
    });
    const targetLane = fixture.store.createLane({
      laneId: "lane-api",
      conversationId: "conversation-1",
      providerProfileId: ANTHROPIC_API_PROFILE_ID,
      providerKind: "anthropic-api",
      nativeSessionId: "api-native-session",
      access: "read-write",
      status: "preparing",
    });
    fixture.store.saveHandoff({
      handoffId: "handoff-1",
      conversationId: "conversation-1",
      sourceLaneId: route.activeLaneId,
      targetProviderProfileId: ANTHROPIC_API_PROFILE_ID,
      targetLaneId: targetLane.laneId,
      state: "activating",
      summary: "Continue the visible task",
      requiresUserConfirmation: false,
      package: {
        latestGoal: "PRIVATE_HANDOFF_PACKAGE_SENTINEL",
        cwd: "/tmp/project",
      },
      executablePrompt: "bounded prompt",
    });

    expect(fixture.store.handoffPackage("handoff-1")).toEqual({
      package: {
        latestGoal: "PRIVATE_HANDOFF_PACKAGE_SENTINEL",
        cwd: "/tmp/project",
      },
      executablePrompt: "bounded prompt",
    });
    expect(() => fixture.store.applyHandoff("handoff-1", "missing-lane")).toThrow(
      "target lane is invalid",
    );
    expect(fixture.store.route("conversation-1")?.activeLaneId).toBe(route.activeLaneId);

    const applied = fixture.store.applyHandoff("handoff-1", targetLane.laneId);
    expect(applied).toMatchObject({
      activeLaneId: targetLane.laneId,
      activeProviderProfileId: ANTHROPIC_API_PROFILE_ID,
      state: "ready",
    });
    expect(fixture.store.handoff("handoff-1")?.state).toBe("applied");
    fixture.store.close();

    const bytes = await readFile(fixture.databasePath);
    expect(bytes.includes(Buffer.from("PRIVATE_HANDOFF_PACKAGE_SENTINEL"))).toBe(false);
  });
});
