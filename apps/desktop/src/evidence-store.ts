import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  BridgeArtifactManifest,
  BridgeEvidenceBundle,
  BridgeEvidencePage,
} from "@bridge/protocol";

const STORE_VERSION = 1;
const BLOB_MAGIC = Buffer.from("BEV1");
const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024;

interface SqlRow {
  [key: string]: string | number | bigint | null;
}

export interface EvidenceArtifactInput {
  manifest: BridgeArtifactManifest;
  rootPath: string;
  sourcePath?: string;
  snapshot?: Buffer;
  preview?: {
    bytes: Buffer;
    mimeType: string;
  };
}

export interface EvidenceArtifactRecord {
  manifest: BridgeArtifactManifest;
  rootPath: string;
  sourcePath?: string;
  blobKey?: string;
  previewBlobKey?: string;
  previewMimeType?: string;
}

export interface EvidenceStoreOptions {
  databasePath: string;
  blobsPath: string;
  masterSecret: string;
  retentionMs?: number;
  maxBytes?: number;
}

function bundleFromRow(row: SqlRow): BridgeEvidenceBundle {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    ...(row.turn_id !== null ? { turnId: String(row.turn_id) } : {}),
    source: String(row.source) as BridgeEvidenceBundle["source"],
    confidence: String(row.confidence) as BridgeEvidenceBundle["confidence"],
    state: String(row.state) as BridgeEvidenceBundle["state"],
    startedAt: Number(row.started_at),
    ...(row.completed_at !== null ? { completedAt: Number(row.completed_at) } : {}),
    toolCount: Number(row.tool_count),
    changeCount: Number(row.change_count),
    artifactCount: Number(row.artifact_count),
    tools: JSON.parse(String(row.tools_json)) as BridgeEvidenceBundle["tools"],
    artifacts: [],
    warnings: JSON.parse(String(row.warnings_json)) as string[],
  };
}

function encodeCursor(bundle: BridgeEvidenceBundle): string {
  return Buffer.from(JSON.stringify({ at: bundle.startedAt, id: bundle.id }), "utf8").toString("base64url");
}

function decodeCursor(value: string | undefined): { at: number; id: string } | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as {
      at?: unknown;
      id?: unknown;
    };
    if (typeof parsed.at === "number" && typeof parsed.id === "string") {
      return { at: parsed.at, id: parsed.id };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export class EvidenceStore {
  private database: DatabaseSync | undefined;
  private readonly key: Buffer;
  private readonly retentionMs: number;
  private readonly maxBytes: number;

  constructor(private readonly options: EvidenceStoreOptions) {
    this.key = createHash("sha256")
      .update("claude-bridge/evidence/v1\0")
      .update(options.masterSecret)
      .digest();
    this.retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  async initialize(): Promise<void> {
    if (this.database) return;
    await Promise.all([
      mkdir(dirname(this.options.databasePath), { recursive: true }),
      mkdir(this.options.blobsPath, { recursive: true }),
    ]);
    const database = new DatabaseSync(this.options.databasePath);
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS evidence_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS evidence_bundles (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        turn_id TEXT,
        source TEXT NOT NULL,
        confidence TEXT NOT NULL,
        state TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        tool_count INTEGER NOT NULL,
        change_count INTEGER NOT NULL,
        artifact_count INTEGER NOT NULL,
        tools_json TEXT NOT NULL,
        warnings_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS evidence_bundles_session
        ON evidence_bundles(session_id, started_at DESC, id DESC);

      CREATE TABLE IF NOT EXISTS evidence_artifacts (
        id TEXT PRIMARY KEY,
        evidence_id TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        root_path TEXT NOT NULL,
        source_path TEXT,
        blob_key TEXT,
        preview_blob_key TEXT,
        preview_mime_type TEXT,
        last_accessed_at INTEGER NOT NULL,
        FOREIGN KEY (evidence_id) REFERENCES evidence_bundles(id) ON DELETE CASCADE
      ) STRICT;

      CREATE INDEX IF NOT EXISTS evidence_artifacts_bundle
        ON evidence_artifacts(evidence_id);

      CREATE TABLE IF NOT EXISTS evidence_blobs (
        key TEXT PRIMARY KEY,
        byte_size INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        last_accessed_at INTEGER NOT NULL
      ) STRICT;
    `);
    database.prepare(`
      INSERT INTO evidence_meta(key, value) VALUES ('version', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(String(STORE_VERSION));
    this.database = database;
    await this.prune();
  }

  async close(): Promise<void> {
    this.database?.close();
    this.database = undefined;
  }

  saveBundle(bundle: BridgeEvidenceBundle): void {
    this.db.prepare(`
      INSERT INTO evidence_bundles(
        id, session_id, turn_id, source, confidence, state, started_at,
        completed_at, tool_count, change_count, artifact_count,
        tools_json, warnings_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        session_id = excluded.session_id,
        turn_id = excluded.turn_id,
        source = excluded.source,
        confidence = excluded.confidence,
        state = excluded.state,
        started_at = excluded.started_at,
        completed_at = excluded.completed_at,
        tool_count = excluded.tool_count,
        change_count = excluded.change_count,
        artifact_count = excluded.artifact_count,
        tools_json = excluded.tools_json,
        warnings_json = excluded.warnings_json,
        updated_at = excluded.updated_at
    `).run(
      bundle.id,
      bundle.sessionId,
      bundle.turnId ?? null,
      bundle.source,
      bundle.confidence,
      bundle.state,
      bundle.startedAt,
      bundle.completedAt ?? null,
      bundle.toolCount,
      bundle.changeCount,
      bundle.artifactCount,
      JSON.stringify(bundle.tools),
      JSON.stringify(bundle.warnings),
      Date.now(),
    );
  }

  failCollectingBundles(
    warning: string,
    completedAt = Date.now(),
  ): BridgeEvidenceBundle[] {
    const rows = this.db.prepare(`
      SELECT * FROM evidence_bundles
      WHERE state = 'collecting'
      ORDER BY started_at ASC, id ASC
    `).all() as SqlRow[];
    const recovered = rows.map((row) => {
      const bundle = bundleFromRow(row);
      const next: BridgeEvidenceBundle = {
        ...bundle,
        confidence: "partial",
        state: "failed",
        completedAt,
        tools: bundle.tools.map((tool) => (
          tool.status === "running"
            ? { ...tool, status: "failed" as const, completedAt }
            : tool
        )),
        warnings: [...new Set([...bundle.warnings, warning])],
      };
      this.saveBundle(next);
      return this.bundleWithArtifacts(next);
    });
    return recovered;
  }

  async replaceArtifacts(evidenceId: string, artifacts: EvidenceArtifactInput[]): Promise<void> {
    const uniqueArtifacts = [...new Map(
      artifacts.map((artifact) => [artifact.manifest.id, artifact]),
    ).values()];
    const prepared = await Promise.all(uniqueArtifacts.map(async (artifact) => {
      const blobKey = artifact.snapshot
        ? await this.writeBlob(artifact.snapshot)
        : undefined;
      const previewBlobKey = artifact.preview
        ? await this.writeBlob(artifact.preview.bytes)
        : undefined;
      return { artifact, blobKey, previewBlobKey };
    }));
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM evidence_artifacts WHERE evidence_id = ?").run(evidenceId);
      const insert = this.db.prepare(`
        INSERT INTO evidence_artifacts(
          id, evidence_id, manifest_json, root_path, source_path,
          blob_key, preview_blob_key, preview_mime_type, last_accessed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const item of prepared) {
        const manifest = item.blobKey
          ? { ...item.artifact.manifest, availability: "snapshot" as const }
          : item.artifact.manifest;
        insert.run(
          manifest.id,
          evidenceId,
          JSON.stringify(manifest),
          item.artifact.rootPath,
          item.artifact.sourcePath ?? null,
          item.blobKey ?? null,
          item.previewBlobKey ?? null,
          item.artifact.preview?.mimeType ?? null,
          Date.now(),
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  list(sessionId: string, cursor?: string, limit = 30): BridgeEvidencePage {
    const boundedLimit = Math.max(1, Math.min(limit, 100));
    const before = decodeCursor(cursor);
    const rows = before
      ? this.db.prepare(`
          SELECT * FROM evidence_bundles
          WHERE session_id = ? AND (started_at < ? OR (started_at = ? AND id < ?))
          ORDER BY started_at DESC, id DESC
          LIMIT ?
        `).all(sessionId, before.at, before.at, before.id, boundedLimit + 1) as SqlRow[]
      : this.db.prepare(`
          SELECT * FROM evidence_bundles
          WHERE session_id = ?
          ORDER BY started_at DESC, id DESC
          LIMIT ?
        `).all(sessionId, boundedLimit + 1) as SqlRow[];
    const hasMore = rows.length > boundedLimit;
    const items = rows.slice(0, boundedLimit).map((row) => this.bundleWithArtifacts(bundleFromRow(row)));
    return {
      sessionId,
      items,
      hasMore,
      ...(hasMore && items.at(-1) ? { nextCursor: encodeCursor(items.at(-1)!) } : {}),
    };
  }

  get(evidenceId: string): BridgeEvidenceBundle | undefined {
    const row = this.db.prepare(
      "SELECT * FROM evidence_bundles WHERE id = ?",
    ).get(evidenceId) as SqlRow | undefined;
    return row ? this.bundleWithArtifacts(bundleFromRow(row)) : undefined;
  }

  artifact(artifactId: string): EvidenceArtifactRecord | undefined {
    const row = this.db.prepare(
      "SELECT * FROM evidence_artifacts WHERE id = ?",
    ).get(artifactId) as SqlRow | undefined;
    if (!row) return undefined;
    return {
      manifest: JSON.parse(String(row.manifest_json)) as BridgeArtifactManifest,
      rootPath: String(row.root_path),
      ...(row.source_path !== null ? { sourcePath: String(row.source_path) } : {}),
      ...(row.blob_key !== null ? { blobKey: String(row.blob_key) } : {}),
      ...(row.preview_blob_key !== null ? { previewBlobKey: String(row.preview_blob_key) } : {}),
      ...(row.preview_mime_type !== null ? { previewMimeType: String(row.preview_mime_type) } : {}),
    };
  }

  async readArtifact(artifactId: string): Promise<Buffer | undefined> {
    const artifact = this.artifact(artifactId);
    if (!artifact?.blobKey) return undefined;
    this.touchArtifact(artifactId);
    return this.readBlob(artifact.blobKey);
  }

  async readPreview(artifactId: string): Promise<{ bytes: Buffer; mimeType: string } | undefined> {
    const artifact = this.artifact(artifactId);
    if (!artifact?.previewBlobKey || !artifact.previewMimeType) return undefined;
    this.touchArtifact(artifactId);
    return {
      bytes: await this.readBlob(artifact.previewBlobKey),
      mimeType: artifact.previewMimeType,
    };
  }

  async cacheArtifact(
    artifactId: string,
    bytes: Buffer,
    manifestUpdate: Partial<BridgeArtifactManifest> = {},
  ): Promise<BridgeArtifactManifest> {
    const artifact = this.artifact(artifactId);
    if (!artifact) throw new Error("Artifact not found");
    const blobKey = await this.writeBlob(bytes);
    const manifest: BridgeArtifactManifest = {
      ...artifact.manifest,
      ...manifestUpdate,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.byteLength,
      availability: "snapshot",
      capturedAt: Date.now(),
    };
    this.db.prepare(`
      UPDATE evidence_artifacts
      SET manifest_json = ?, blob_key = ?, last_accessed_at = ?
      WHERE id = ?
    `).run(JSON.stringify(manifest), blobKey, Date.now(), artifactId);
    return manifest;
  }

  async cachePreview(artifactId: string, bytes: Buffer, mimeType: string): Promise<void> {
    const blobKey = await this.writeBlob(bytes);
    this.db.prepare(`
      UPDATE evidence_artifacts
      SET preview_blob_key = ?, preview_mime_type = ?, last_accessed_at = ?
      WHERE id = ?
    `).run(blobKey, mimeType, Date.now(), artifactId);
  }

  async prune(now = Date.now()): Promise<void> {
    if (!this.database) return;
    const rows = this.db.prepare(`
      SELECT key, byte_size, created_at, last_accessed_at
      FROM evidence_blobs
      ORDER BY last_accessed_at ASC
    `).all() as SqlRow[];
    let total = rows.reduce((sum, row) => sum + Number(row.byte_size), 0);
    const cutoff = now - this.retentionMs;
    for (const row of rows) {
      const expired = Number(row.created_at) <= cutoff;
      const overBudget = total > this.maxBytes;
      if (!expired && !overBudget) continue;
      const key = String(row.key);
      await rm(join(this.options.blobsPath, `${key}.blob`), { force: true });
      this.db.prepare("DELETE FROM evidence_blobs WHERE key = ?").run(key);
      const artifacts = this.db.prepare(`
        SELECT id, manifest_json, blob_key, preview_blob_key FROM evidence_artifacts
        WHERE blob_key = ? OR preview_blob_key = ?
      `).all(key, key) as SqlRow[];
      for (const artifact of artifacts) {
        const manifest = JSON.parse(String(artifact.manifest_json)) as BridgeArtifactManifest;
        const snapshotExpired = artifact.blob_key === key;
        const next = snapshotExpired && manifest.availability === "snapshot"
          ? { ...manifest, availability: "expired" as const }
          : manifest;
        this.db.prepare(`
          UPDATE evidence_artifacts
          SET manifest_json = ?,
              blob_key = CASE WHEN blob_key = ? THEN NULL ELSE blob_key END,
              preview_blob_key = CASE WHEN preview_blob_key = ? THEN NULL ELSE preview_blob_key END,
              preview_mime_type = CASE WHEN preview_blob_key = ? THEN NULL ELSE preview_mime_type END
          WHERE id = ?
        `).run(JSON.stringify(next), key, key, key, String(artifact.id));
      }
      total -= Number(row.byte_size);
    }
    const known = new Set(
      (this.db.prepare("SELECT key FROM evidence_blobs").all() as SqlRow[]).map((row) => String(row.key)),
    );
    for (const entry of await readdir(this.options.blobsPath, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isFile() || !entry.name.endsWith(".blob")) continue;
      const key = basename(entry.name, ".blob");
      if (!known.has(key)) await rm(join(this.options.blobsPath, entry.name), { force: true });
    }
  }

  private bundleWithArtifacts(bundle: BridgeEvidenceBundle): BridgeEvidenceBundle {
    const rows = this.db.prepare(`
      SELECT manifest_json FROM evidence_artifacts
      WHERE evidence_id = ?
      ORDER BY id
    `).all(bundle.id) as SqlRow[];
    const artifacts = rows.map((row) => (
      JSON.parse(String(row.manifest_json)) as BridgeArtifactManifest
    ));
    return {
      ...bundle,
      artifacts,
      artifactCount: artifacts.filter((artifact) => artifact.changeKind !== "deleted").length,
    };
  }

  private async writeBlob(plaintext: Buffer): Promise<string> {
    const key = createHash("sha256").update(plaintext).digest("hex");
    const path = join(this.options.blobsPath, `${key}.blob`);
    const existing = await stat(path).catch(() => undefined);
    if (!existing) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const payload = Buffer.concat([BLOB_MAGIC, nonce, cipher.getAuthTag(), ciphertext]);
      const temporary = `${path}.${process.pid}.tmp`;
      await writeFile(temporary, payload, { mode: 0o600 });
      await rename(temporary, path);
    }
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO evidence_blobs(key, byte_size, created_at, last_accessed_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET last_accessed_at = excluded.last_accessed_at
    `).run(key, plaintext.byteLength, now, now);
    return key;
  }

  private async readBlob(key: string): Promise<Buffer> {
    const payload = await readFile(join(this.options.blobsPath, `${key}.blob`));
    if (payload.byteLength < 32 || !payload.subarray(0, 4).equals(BLOB_MAGIC)) {
      throw new Error("Artifact snapshot is invalid");
    }
    const nonce = payload.subarray(4, 16);
    const tag = payload.subarray(16, 32);
    const decipher = createDecipheriv("aes-256-gcm", this.key, nonce);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(payload.subarray(32)), decipher.final()]);
    if (createHash("sha256").update(plaintext).digest("hex") !== key) {
      throw new Error("Artifact snapshot content address is invalid");
    }
    this.db.prepare(
      "UPDATE evidence_blobs SET last_accessed_at = ? WHERE key = ?",
    ).run(Date.now(), key);
    return plaintext;
  }

  private touchArtifact(artifactId: string): void {
    this.db.prepare(
      "UPDATE evidence_artifacts SET last_accessed_at = ? WHERE id = ?",
    ).run(Date.now(), artifactId);
  }

  private get db(): DatabaseSync {
    if (!this.database) throw new Error("Evidence store has not been initialized");
    return this.database;
  }
}
