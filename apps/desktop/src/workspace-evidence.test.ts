import {
  mkdtemp,
  open,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  WorkspaceEvidenceCapture,
  artifactMetadata,
  sensitiveArtifactReason,
  unifiedEvidenceDiff,
} from "./workspace-evidence.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe("WorkspaceEvidenceCapture", () => {
  it("excludes pre-existing dirty files and attributes create, modify, delete and rename", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-workspace-"));
    directories.push(directory);
    await writeFile(join(directory, "unchanged.txt"), "user dirt before task\n");
    await writeFile(join(directory, "modified.txt"), "before\n");
    await writeFile(join(directory, "deleted.txt"), "remove me\n");
    await writeFile(join(directory, "old-name.txt"), "same body\n");
    const capture = await WorkspaceEvidenceCapture.start(directory);

    await writeFile(join(directory, "modified.txt"), "after\n");
    await writeFile(join(directory, "created.txt"), "new artifact\n");
    await writeFile(join(directory, ".env.local"), "TOKEN=not-for-remote\n");
    await unlink(join(directory, "deleted.txt"));
    await rename(join(directory, "old-name.txt"), join(directory, "new-name.txt"));
    const result = await capture.finalize();
    const changes = new Map(result.changes.map((change) => [change.relativePath, change]));

    expect(changes.has("unchanged.txt")).toBe(false);
    expect(changes.get("modified.txt")).toMatchObject({
      changeKind: "modified",
      previewMode: "diff",
    });
    expect(changes.get("created.txt")).toMatchObject({
      changeKind: "created",
      snapshot: Buffer.from("new artifact\n"),
    });
    expect(changes.get("deleted.txt")).toMatchObject({ changeKind: "deleted" });
    expect(changes.get("new-name.txt")).toMatchObject({
      changeKind: "renamed",
      previousPath: "old-name.txt",
    });
    expect(changes.get(".env.local")).toMatchObject({
      changeKind: "created",
      blockedReason: "环境变量文件不允许远程读取",
    });
    expect(changes.get(".env.local")?.snapshot).toBeUndefined();
  });

  it("downgrades an artifact larger than 20 MiB to metadata-only evidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-workspace-"));
    directories.push(directory);
    const capture = await WorkspaceEvidenceCapture.start(directory);
    const file = await open(join(directory, "large.bin"), "w");
    await file.truncate(20 * 1024 * 1024 + 1);
    await file.close();
    const result = await capture.finalize();

    expect(result.partial).toBe(true);
    expect(result.changes[0]).toMatchObject({
      relativePath: "large.bin",
      size: 20 * 1024 * 1024 + 1,
      partial: true,
    });
    expect(result.changes[0]?.snapshot).toBeUndefined();
  });

  it("recognizes sensitive paths and produces bounded text diffs", () => {
    expect(sensitiveArtifactReason(".git/config")).toContain("Git");
    expect(sensitiveArtifactReason("keys/id_ed25519")).toContain("凭据");
    expect(sensitiveArtifactReason(".docker/config.json")).toContain("凭据");
    expect(sensitiveArtifactReason(".kube/config")).toContain("凭据");
    expect(sensitiveArtifactReason("firebase-adminsdk-prod.json")).toContain("凭据");
    expect(sensitiveArtifactReason("src/index.ts")).toBeUndefined();
    expect(artifactMetadata("preview.png")).toMatchObject({ kind: "image", previewMode: "image" });
    expect(artifactMetadata("preview.html")).toMatchObject({ kind: "html", previewMode: "html-screenshot" });
    expect(artifactMetadata("report.pdf")).toMatchObject({ kind: "pdf", previewMode: "none" });
    expect(unifiedEvidenceDiff(
      "src/index.ts",
      Buffer.from("one\ntwo\n"),
      Buffer.from("one\nthree\n"),
    )?.toString("utf8")).toContain("+three");
  });
});
