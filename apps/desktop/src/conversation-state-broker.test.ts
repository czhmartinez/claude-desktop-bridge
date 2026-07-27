import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationStateStore } from "./conversation-state-store.js";
import type { ClaudeCatalogSnapshot } from "./claude-session-catalog.js";
import { SessionBroker, type TranscriptObserverRuntime } from "./session-broker.js";
import { SessionEventLog } from "./session-event-log.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

class Observer extends EventEmitter implements TranscriptObserverRuntime {
  constructor(readonly catalog: ClaudeCatalogSnapshot) {
    super();
  }

  isDesktopBusy(): boolean {
    return false;
  }

  externalWriteVersion(): number {
    return 0;
  }

  async canStartBridgeHost(): Promise<boolean> {
    return true;
  }

  onCatalog(listener: (catalog: ClaudeCatalogSnapshot) => void): () => void {
    this.on("catalog", listener);
    return () => this.off("catalog", listener);
  }
}

describe("SessionBroker conversation state", () => {
  it("fixes a queued turn to the active lane at enqueue time", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-state-broker-"));
    directories.push(root);
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const cwd = join(root, "project");
    const observer = new Observer({
      projects: [],
      observedAt: Date.now(),
      sessions: [{
        sessionId,
        projectId: "project-1",
        projectName: "project",
        cwd,
        title: "Existing session",
        source: "desktop",
        transport: "bridge-host",
        ownership: "DESKTOP_OBSERVED",
        turnState: "idle",
        lastActivityAt: Date.now(),
        pendingCount: 0,
        transcriptMtimeMs: 0,
        processAlive: false,
        desktopProcessAlive: false,
        bridgeProcessAlive: false,
        processOverlap: false,
        activeProcesses: [],
        activeTask: false,
        sourceProfile: "claude-3p",
      }],
    });
    const state = new ConversationStateStore({
      databasePath: join(root, "conversation-state-v1.sqlite"),
      sessionsPath: join(root, "sessions-v2.json"),
      queuePath: join(root, "turn-queue-v2.json"),
      masterSecret: "broker-state-test",
    });
    const broker = new SessionBroker({
      paths: {
        sessions: join(root, "sessions"),
        tasks: join(root, "tasks"),
        projects: join(root, "projects"),
        desktopSessions: [],
      },
      eventLog: new SessionEventLog(join(root, "events.jsonl")),
      observer,
      sessionsPath: join(root, "sessions-v2.json"),
      queuePath: join(root, "turn-queue-v2.json"),
      conversationState: state,
      prepareRuntime: async () => ({ environment: {} }),
    });

    const turn = await broker.startTurn({
      requestId: "request-1",
      idempotencyKey: "idempotency-1",
      sessionId,
      text: "Continue",
      origin: "mobile",
    });

    expect("laneId" in turn && turn.laneId).toBe(`lane:claude-3p:${sessionId}`);
    expect(state.loadBrokerState().pending[0]?.laneId).toBe(`lane:claude-3p:${sessionId}`);
    await broker.close();
    state.close();
  });
});
