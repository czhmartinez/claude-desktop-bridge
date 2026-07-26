import {
  mkdtemp,
  open,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EvidenceManager } from "./evidence-manager.js";
import { EvidenceStore } from "./evidence-store.js";
import { SessionEventLog } from "./session-event-log.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

async function managerFixture() {
  const directory = await mkdtemp(join(tmpdir(), "bridge-evidence-manager-"));
  directories.push(directory);
  const store = new EvidenceStore({
    databasePath: join(directory, "evidence.sqlite"),
    blobsPath: join(directory, "blobs"),
    masterSecret: "manager-test-secret",
  });
  const eventLog = new SessionEventLog(join(directory, "events.jsonl"));
  await eventLog.initialize();
  const manager = new EvidenceManager({ store, eventLog });
  await manager.initialize();
  return { directory, manager, eventLog };
}

describe("EvidenceManager", () => {
  it("redacts recovered tool output and blocks sensitive or project-external paths", async () => {
    const { directory, manager } = await managerFixture();
    await writeFile(join(directory, "report.txt"), "report body\n");
    await writeFile(join(directory, ".env"), "SECRET=hidden\n");
    const outside = join(directory, "..", `outside-${Date.now()}.txt`);
    await writeFile(outside, "outside\n");
    directories.push(outside);

    const evidence = await manager.upsertDesktopEvidence({
      id: "desktop-evidence-1",
      sessionId: "session-1",
      cwd: directory,
      turnId: "turn-1",
      startedAt: 1_000,
      completedAt: 2_000,
      tools: [{
        id: "tool-1",
        toolName: "Bash",
        input: { command: "cat ./report.txt" },
        output: {
          exitCode: 1,
          stdout: "Authorization: Bearer top-secret\napi_key=sk-1234567890abcdefgh",
        },
        startedAt: 1_100,
        completedAt: 1_200,
      }],
      paths: [
        "report.txt",
        "./report.txt",
        join(directory, "report.txt"),
        ".env",
        outside,
      ],
    });

    expect(evidence.confidence).toBe("inferred");
    expect(evidence.tools[0]).toMatchObject({ status: "failed", exitCode: 1 });
    expect(evidence.tools[0]?.outputSummary).not.toContain("top-secret");
    expect(evidence.tools[0]?.outputSummary).not.toContain("sk-1234567890abcdefgh");
    expect(evidence.artifacts.find((artifact) => artifact.relativePath === ".env"))
      .toMatchObject({ availability: "blocked", downloadAllowed: false });
    expect(evidence.artifacts.filter((artifact) => artifact.relativePath === "report.txt"))
      .toHaveLength(1);
    const external = evidence.artifacts.find((artifact) => artifact.relativePath.startsWith("[项目外]"));
    expect(external).toMatchObject({ availability: "blocked", downloadAllowed: false });
    expect(external?.relativePath).not.toContain(directory);
    await manager.close();
    await rm(outside, { force: true });
  });

  it("previews text and supports owner-bound out-of-order 256 KiB transfer chunks", async () => {
    const { directory, manager } = await managerFixture();
    const bytes = Buffer.alloc(300 * 1024, 0x61);
    await writeFile(join(directory, "result.txt"), bytes);
    await manager.upsertDesktopEvidence({
      id: "desktop-evidence-2",
      sessionId: "session-1",
      cwd: directory,
      startedAt: 1_000,
      completedAt: 2_000,
      tools: [{
        id: "tool-2",
        toolName: "Write",
        input: { file_path: "result.txt" },
        output: "ok",
        startedAt: 1_100,
        completedAt: 1_200,
      }],
      paths: ["result.txt"],
    });
    const artifact = manager.get("desktop-evidence-2")!.artifacts[0]!;
    const preview = await manager.preview(artifact.id);
    const transfer = await manager.openTransfer(artifact.id, "phone-1");

    expect(preview).toMatchObject({ mode: "text", truncated: false });
    expect(transfer.chunkBytes).toBe(256 * 1024);
    expect(transfer.totalChunks).toBe(2);
    const second = manager.readTransfer(transfer.transferId, 1, "phone-1");
    const first = manager.readTransfer(transfer.transferId, 0, "phone-1");
    expect(Buffer.concat([
      Buffer.from(first.data, "base64"),
      Buffer.from(second.data, "base64"),
    ])).toEqual(bytes);
    expect(() => manager.readTransfer(transfer.transferId, 0, "phone-2"))
      .toThrow("expired");
    expect(manager.closeTransfer(transfer.transferId, "phone-1")).toBe(true);
    await manager.close();
  });

  it("rejects symlink escapes and files above the 20 MiB hard limit", async () => {
    const { directory, manager } = await managerFixture();
    const outsideDirectory = await mkdtemp(join(tmpdir(), "bridge-evidence-outside-"));
    directories.push(outsideDirectory);
    await writeFile(join(outsideDirectory, "outside.txt"), "outside\n");
    await symlink(join(outsideDirectory, "outside.txt"), join(directory, "linked.txt"));
    const large = await open(join(directory, "large.bin"), "w");
    await large.truncate(20 * 1024 * 1024 + 1);
    await large.close();
    await manager.upsertDesktopEvidence({
      id: "desktop-evidence-3",
      sessionId: "session-1",
      cwd: directory,
      startedAt: 1_000,
      completedAt: 2_000,
      tools: [{
        id: "tool-3",
        toolName: "Read",
        input: { file_path: "linked.txt" },
        output: "ok",
        startedAt: 1_100,
        completedAt: 1_200,
      }],
      paths: ["linked.txt", "large.bin"],
    });
    const evidence = manager.get("desktop-evidence-3")!;
    const linked = evidence.artifacts.find((artifact) => artifact.relativePath === "linked.txt")!;
    const oversized = evidence.artifacts.find((artifact) => artifact.relativePath === "large.bin")!;

    await expect(manager.preview(linked.id)).rejects.toThrow("项目目录");
    await expect(manager.openTransfer(oversized.id, "phone-1")).rejects.toThrow("20 MiB");
    await manager.close();
  });

  it("transfers zero-byte files as one verifiable empty chunk", async () => {
    const { directory, manager } = await managerFixture();
    await writeFile(join(directory, "empty.txt"), "");
    await manager.upsertDesktopEvidence({
      id: "desktop-evidence-4",
      sessionId: "session-1",
      cwd: directory,
      startedAt: 1_000,
      completedAt: 2_000,
      tools: [{
        id: "tool-4",
        toolName: "Write",
        input: { file_path: "empty.txt" },
        output: "ok",
        startedAt: 1_100,
        completedAt: 1_200,
      }],
      paths: ["empty.txt"],
    });
    const artifact = manager.get("desktop-evidence-4")!.artifacts[0]!;
    const transfer = await manager.openTransfer(artifact.id, "phone-1");
    const chunk = manager.readTransfer(transfer.transferId, 0, "phone-1");

    expect(transfer).toMatchObject({ size: 0, totalChunks: 1 });
    expect(chunk.data).toBe("");
    await manager.close();
  });

  it("keeps tool bodies out of evidence events and exposes redacted output only on demand", async () => {
    const { directory, manager, eventLog } = await managerFixture();
    const evidenceId = await manager.startBridgeTurn({
      sessionId: "session-1",
      cwd: directory,
      commandId: "command-1",
    });
    await manager.attachTurn(evidenceId, "turn-1");
    await manager.recordToolStarted({
      sessionId: "session-1",
      turnId: "turn-1",
      itemId: "tool-1",
      toolName: "Bash",
      toolInput: { command: "printf result" },
      at: 1_100,
    });
    await manager.recordToolCompleted({
      sessionId: "session-1",
      turnId: "turn-1",
      itemId: "tool-1",
      output: {
        exitCode: 0,
        stdout: "project source body\nAuthorization: Bearer private-token",
      },
      at: 1_200,
    });
    const evidence = await manager.finalizeBridgeTurn({
      sessionId: "session-1",
      turnId: "turn-1",
      completedAt: 1_300,
    });

    expect(evidence?.tools[0]?.outputSummary).toContain("正文按需打开");
    expect(JSON.stringify(evidence)).not.toContain("project source body");
    expect(JSON.stringify(eventLog.replay())).not.toContain("project source body");
    const outputArtifact = evidence!.artifacts.find((artifact) => artifact.kind === "log")!;
    const preview = await manager.preview(outputArtifact.id);
    expect(preview.data).toContain("project source body");
    expect(preview.data).not.toContain("private-token");
    await manager.close();
  });

  it("fails orphaned collecting evidence after a desktop restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-evidence-restart-"));
    directories.push(directory);
    const databasePath = join(directory, "evidence.sqlite");
    const blobsPath = join(directory, "blobs");
    const previousStore = new EvidenceStore({
      databasePath,
      blobsPath,
      masterSecret: "restart-test-secret",
    });
    await previousStore.initialize();
    previousStore.saveBundle({
      id: "interrupted-evidence",
      sessionId: "session-1",
      turnId: "turn-1",
      source: "bridge-host",
      confidence: "exact",
      state: "collecting",
      startedAt: 1_000,
      toolCount: 1,
      changeCount: 0,
      artifactCount: 0,
      tools: [{
        id: "tool-1",
        toolName: "Bash",
        status: "running",
        summary: "npm test",
        startedAt: 1_100,
        truncated: false,
      }],
      artifacts: [],
      warnings: [],
    });
    await previousStore.close();

    const eventLog = new SessionEventLog(join(directory, "events.jsonl"));
    const manager = new EvidenceManager({
      store: new EvidenceStore({
        databasePath,
        blobsPath,
        masterSecret: "restart-test-secret",
      }),
      eventLog,
    });
    await manager.initialize();

    expect(manager.get("interrupted-evidence")).toMatchObject({
      confidence: "partial",
      state: "failed",
      tools: [{ status: "failed" }],
      warnings: [expect.stringContaining("重新启动")],
    });
    expect(eventLog.replay().at(-1)).toMatchObject({
      type: "evidence.failed",
      itemId: "interrupted-evidence",
    });
    await manager.close();
    await eventLog.close();
  });
});
