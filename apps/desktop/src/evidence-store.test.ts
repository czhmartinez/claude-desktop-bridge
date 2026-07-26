import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BridgeArtifactManifest, BridgeEvidenceBundle } from "@bridge/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { EvidenceStore } from "./evidence-store.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

function bundle(id = "evidence-1"): BridgeEvidenceBundle {
  return {
    id,
    sessionId: "session-1",
    turnId: "turn-1",
    source: "bridge-host",
    confidence: "exact",
    state: "ready",
    startedAt: 1_000,
    completedAt: 2_000,
    toolCount: 0,
    changeCount: 1,
    artifactCount: 1,
    tools: [],
    artifacts: [],
    warnings: [],
  };
}

function manifest(evidenceId = "evidence-1"): BridgeArtifactManifest {
  return {
    id: "artifact-1",
    evidenceId,
    relativePath: "reports/result.txt",
    name: "result.txt",
    kind: "text",
    changeKind: "created",
    mimeType: "text/plain",
    size: 23,
    availability: "snapshot",
    previewMode: "text",
    downloadAllowed: true,
  };
}

describe("EvidenceStore", () => {
  it("stores encrypted content-addressed snapshots while keeping manifests queryable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-evidence-store-"));
    directories.push(directory);
    const blobsPath = join(directory, "blobs");
    const store = new EvidenceStore({
      databasePath: join(directory, "evidence.sqlite"),
      blobsPath,
      masterSecret: "test-evidence-master-secret",
    });
    await store.initialize();
    const plaintext = Buffer.from("private report contents", "utf8");
    store.saveBundle(bundle());
    await store.replaceArtifacts("evidence-1", [{
      manifest: manifest(),
      rootPath: directory,
      snapshot: plaintext,
    }]);

    const [blobName] = await readdir(blobsPath);
    const encrypted = await readFile(join(blobsPath, blobName!));
    expect(encrypted.includes(plaintext)).toBe(false);
    expect(await store.readArtifact("artifact-1")).toEqual(plaintext);
    expect(store.list("session-1").items[0]).toMatchObject({
      id: "evidence-1",
      artifactCount: 1,
      artifacts: [{ id: "artifact-1", availability: "snapshot" }],
    });
    await store.close();
  });

  it("expires snapshot bodies without deleting their evidence manifests", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-evidence-store-"));
    directories.push(directory);
    const store = new EvidenceStore({
      databasePath: join(directory, "evidence.sqlite"),
      blobsPath: join(directory, "blobs"),
      masterSecret: "test-evidence-master-secret",
      retentionMs: 1,
    });
    await store.initialize();
    store.saveBundle(bundle());
    await store.replaceArtifacts("evidence-1", [{
      manifest: manifest(),
      rootPath: directory,
      snapshot: Buffer.from("snapshot"),
      preview: {
        bytes: Buffer.from("preview"),
        mimeType: "text/plain",
      },
    }]);
    await store.prune(Date.now() + 10);

    expect(store.get("evidence-1")?.artifacts[0]).toMatchObject({
      id: "artifact-1",
      availability: "expired",
    });
    expect(await store.readArtifact("artifact-1")).toBeUndefined();
    expect(await store.readPreview("artifact-1")).toBeUndefined();
    await store.close();
  });

  it("rejects a valid encrypted blob placed under the wrong content address", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-evidence-store-"));
    directories.push(directory);
    const blobsPath = join(directory, "blobs");
    const store = new EvidenceStore({
      databasePath: join(directory, "evidence.sqlite"),
      blobsPath,
      masterSecret: "test-evidence-master-secret",
    });
    await store.initialize();
    const first = Buffer.from("first snapshot");
    const second = Buffer.from("second snapshot");
    store.saveBundle(bundle("evidence-1"));
    store.saveBundle(bundle("evidence-2"));
    await store.replaceArtifacts("evidence-1", [{
      manifest: manifest("evidence-1"),
      rootPath: directory,
      snapshot: first,
    }]);
    await store.replaceArtifacts("evidence-2", [{
      manifest: { ...manifest("evidence-2"), id: "artifact-2" },
      rootPath: directory,
      snapshot: second,
    }]);
    const firstKey = createHash("sha256").update(first).digest("hex");
    const secondKey = createHash("sha256").update(second).digest("hex");
    await writeFile(
      join(blobsPath, `${firstKey}.blob`),
      await readFile(join(blobsPath, `${secondKey}.blob`)),
    );

    await expect(store.readArtifact("artifact-1")).rejects.toThrow("content address");
    await store.close();
  });
});
