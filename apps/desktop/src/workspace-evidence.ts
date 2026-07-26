import { createHash } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";
import type {
  BridgeArtifactChangeKind,
  BridgeArtifactKind,
  BridgeArtifactPreviewMode,
} from "@bridge/protocol";

const MAX_FILES = 20_000;
const MAX_SCAN_MS = 2_000;
const MAX_CAPTURE_BYTES = 64 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;
const MAX_DIFF_BYTES = 1024 * 1024;
const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "vendor",
  ".cache",
  ".next",
  ".turbo",
  ".gradle",
  "Pods",
]);

interface FileSnapshot {
  relativePath: string;
  absolutePath: string;
  size: number;
  mtimeMs: number;
  sha256?: string;
  bytes?: Buffer;
  blockedReason?: string;
}

interface ScanResult {
  files: Map<string, FileSnapshot>;
  truncated: boolean;
  warnings: string[];
}

export interface WorkspaceArtifactChange {
  relativePath: string;
  previousPath?: string;
  absolutePath?: string;
  changeKind: BridgeArtifactChangeKind;
  kind: BridgeArtifactKind;
  mimeType: string;
  previewMode: BridgeArtifactPreviewMode;
  size: number;
  sha256?: string;
  snapshot?: Buffer;
  diff?: Buffer;
  blockedReason?: string;
  partial: boolean;
}

export interface WorkspaceCaptureResult {
  rootPath: string;
  changes: WorkspaceArtifactChange[];
  partial: boolean;
  warnings: string[];
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizedRelative(root: string, absolutePath: string): string | undefined {
  const value = relative(root, absolutePath);
  if (!value || value === ".") return undefined;
  if (value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value)) return undefined;
  return value.split(sep).join("/");
}

export function sensitiveArtifactReason(relativePath: string): string | undefined {
  const normalized = relativePath.replaceAll("\\", "/");
  const segments = normalized.toLocaleLowerCase().split("/");
  const name = segments.at(-1) ?? "";
  const parent = segments.at(-2) ?? "";
  if (segments.includes(".git")) return "Git 内部数据不允许远程读取";
  if (name === ".env" || name.startsWith(".env.")) return "环境变量文件不允许远程读取";
  if (
    name === ".npmrc" ||
    name === ".pypirc" ||
    name === ".netrc" ||
    name === ".git-credentials" ||
    name === "credentials" ||
    name.startsWith("credentials.") ||
    name === "secrets" ||
    name.startsWith("secrets.") ||
    (name === "config" && parent === ".kube") ||
    (name === "config.json" && parent === ".docker") ||
    name === "google-services.json" ||
    /(?:^|[-_])service[-_]?account.*\.json$/u.test(name) ||
    /^firebase-adminsdk.*\.json$/u.test(name) ||
    /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/u.test(name) ||
    /\.(pem|key|p12|pfx|keystore)$/u.test(name)
  ) return "凭据或密钥文件不允许远程读取";
  return undefined;
}

export function artifactMetadata(relativePath: string): {
  kind: BridgeArtifactKind;
  mimeType: string;
  previewMode: BridgeArtifactPreviewMode;
} {
  const extension = extname(relativePath).toLocaleLowerCase();
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".avif"].includes(extension)) {
    const mimeType = extension === ".jpg" || extension === ".jpeg"
      ? "image/jpeg"
      : extension === ".svg"
        ? "image/svg+xml"
        : `image/${extension.slice(1)}`;
    return { kind: "image", mimeType, previewMode: "image" };
  }
  if (extension === ".html" || extension === ".htm") {
    return { kind: "html", mimeType: "text/html", previewMode: "html-screenshot" };
  }
  if (extension === ".pdf") return { kind: "pdf", mimeType: "application/pdf", previewMode: "none" };
  if ([".log", ".out"].includes(extension)) {
    return { kind: "log", mimeType: "text/plain", previewMode: "text" };
  }
  if (
    [
      ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".css", ".scss", ".less",
      ".md", ".mdx", ".py", ".rb", ".go", ".rs", ".java", ".kt", ".swift", ".c", ".cc",
      ".cpp", ".h", ".hpp", ".sh", ".zsh", ".fish", ".sql", ".yaml", ".yml", ".toml",
      ".xml", ".vue", ".svelte",
    ].includes(extension)
  ) {
    return { kind: "code", mimeType: "text/plain", previewMode: "text" };
  }
  if ([".txt", ".csv", ".tsv"].includes(extension) || !extension) {
    return { kind: "text", mimeType: "text/plain", previewMode: "text" };
  }
  return { kind: "binary", mimeType: "application/octet-stream", previewMode: "none" };
}

function looksText(bytes: Buffer): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.byteLength, 8_192));
  return !sample.includes(0);
}

export function unifiedEvidenceDiff(
  relativePath: string,
  before: Buffer,
  after: Buffer,
): Buffer | undefined {
  if (!looksText(before) || !looksText(after)) return undefined;
  const beforeLines = before.toString("utf8").split("\n");
  const afterLines = after.toString("utf8").split("\n");
  let prefix = 0;
  while (
    prefix < beforeLines.length &&
    prefix < afterLines.length &&
    beforeLines[prefix] === afterLines[prefix]
  ) prefix += 1;
  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) suffix += 1;
  const contextStart = Math.max(0, prefix - 3);
  const beforeEnd = Math.min(beforeLines.length, beforeLines.length - suffix + 3);
  const afterEnd = Math.min(afterLines.length, afterLines.length - suffix + 3);
  const output = [
    `--- a/${relativePath}`,
    `+++ b/${relativePath}`,
    `@@ -${contextStart + 1},${beforeEnd - contextStart} +${contextStart + 1},${afterEnd - contextStart} @@`,
  ];
  for (let index = contextStart; index < prefix; index += 1) output.push(` ${beforeLines[index] ?? ""}`);
  for (let index = prefix; index < beforeLines.length - suffix; index += 1) {
    output.push(`-${beforeLines[index] ?? ""}`);
  }
  for (let index = prefix; index < afterLines.length - suffix; index += 1) {
    output.push(`+${afterLines[index] ?? ""}`);
  }
  for (let index = Math.max(prefix, afterLines.length - suffix); index < afterEnd; index += 1) {
    output.push(` ${afterLines[index] ?? ""}`);
  }
  const bytes = Buffer.from(`${output.join("\n")}\n`, "utf8");
  return bytes.byteLength <= MAX_DIFF_BYTES ? bytes : bytes.subarray(0, MAX_DIFF_BYTES);
}

async function scanWorkspace(rootPath: string): Promise<ScanResult> {
  const startedAt = Date.now();
  const files = new Map<string, FileSnapshot>();
  const warnings: string[] = [];
  let capturedBytes = 0;
  let truncated = false;
  const queue = [rootPath];
  while (queue.length > 0) {
    if (files.size >= MAX_FILES || Date.now() - startedAt >= MAX_SCAN_MS) {
      truncated = true;
      break;
    }
    const directory = queue.shift()!;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      warnings.push("部分目录无法读取");
      truncated = true;
      continue;
    }
    for (const entry of entries) {
      if (files.size >= MAX_FILES || Date.now() - startedAt >= MAX_SCAN_MS) {
        truncated = true;
        break;
      }
      const absolutePath = resolve(directory, entry.name);
      const relativePath = normalizedRelative(rootPath, absolutePath);
      if (!relativePath) continue;
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name)) queue.push(absolutePath);
        continue;
      }
      if (entry.isSymbolicLink()) {
        truncated = true;
        warnings.push("符号链接未纳入自动快照");
        continue;
      }
      if (!entry.isFile()) continue;
      let metadata;
      try {
        metadata = await lstat(absolutePath);
      } catch {
        truncated = true;
        continue;
      }
      const blockedReason = sensitiveArtifactReason(relativePath);
      let bytes: Buffer | undefined;
      if (
        !blockedReason &&
        metadata.size <= MAX_ARTIFACT_BYTES &&
        capturedBytes + metadata.size <= MAX_CAPTURE_BYTES
      ) {
        try {
          bytes = await readFile(absolutePath);
          capturedBytes += bytes.byteLength;
        } catch {
          truncated = true;
        }
      } else if (!blockedReason && metadata.size <= MAX_ARTIFACT_BYTES) {
        truncated = true;
      }
      files.set(relativePath, {
        relativePath,
        absolutePath,
        size: metadata.size,
        mtimeMs: metadata.mtimeMs,
        ...(bytes ? { bytes, sha256: sha256(bytes) } : {}),
        ...(blockedReason ? { blockedReason } : {}),
      });
    }
  }
  if (files.size >= MAX_FILES) warnings.push(`工作区超过 ${MAX_FILES.toLocaleString()} 个文件，证据已降级`);
  if (capturedBytes >= MAX_CAPTURE_BYTES) warnings.push("工作区基线超过 64 MiB，部分文件仅记录元数据");
  if (Date.now() - startedAt >= MAX_SCAN_MS) warnings.push("工作区扫描超过 2 秒，部分文件仅按工具路径归因");
  return { files, truncated, warnings: [...new Set(warnings)] };
}

function toolPaths(input: unknown): string[] {
  const found: string[] = [];
  const visit = (value: unknown, key = ""): void => {
    if (typeof value === "string") {
      if (
        /(^|_)(file_?path|path|notebook_?path|output_?path|destination|dest)$/iu.test(key) ||
        key === "command"
      ) {
        if (key === "command") {
          const candidates = value.match(/(?:^|[\s"'=])((?:\.{0,2}\/|\/)[^\s"'<>|;&]+)/gu) ?? [];
          for (const candidate of candidates) found.push(candidate.trim().replace(/^[\s"'=]+/u, ""));
        } else {
          found.push(value);
        }
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
      visit(child, childKey);
    }
  };
  visit(input);
  return found;
}

export class WorkspaceEvidenceCapture {
  private watcher: FSWatcher | undefined;
  private readonly touched = new Set<string>();
  private readonly explicitPaths = new Set<string>();
  private lastMutationAt = Date.now();

  private constructor(
    readonly rootPath: string,
    private readonly baseline: ScanResult,
  ) {}

  static async start(cwd: string): Promise<WorkspaceEvidenceCapture> {
    const rootPath = await realpath(cwd);
    const baseline = await scanWorkspace(rootPath);
    const capture = new WorkspaceEvidenceCapture(rootPath, baseline);
    try {
      capture.watcher = watch(rootPath, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        const relativePath = String(filename).split(sep).join("/");
        if (!relativePath || relativePath.startsWith("../")) return;
        capture.touched.add(relativePath);
        capture.lastMutationAt = Date.now();
      });
      capture.watcher.on("error", () => {
        capture.baseline.truncated = true;
        capture.baseline.warnings.push("文件监听不可用，证据可能不完整");
      });
    } catch {
      baseline.truncated = true;
      baseline.warnings.push("文件监听不可用，证据可能不完整");
    }
    return capture;
  }

  addToolInput(input: unknown): void {
    for (const candidate of toolPaths(input)) {
      const absolutePath = isAbsolute(candidate)
        ? resolve(candidate)
        : resolve(this.rootPath, candidate);
      const relativePath = normalizedRelative(this.rootPath, absolutePath);
      if (relativePath) this.explicitPaths.add(relativePath);
    }
  }

  async finalize(): Promise<WorkspaceCaptureResult> {
    const waitStartedAt = Date.now();
    while (Date.now() - this.lastMutationAt < 1_000 && Date.now() - waitStartedAt < 5_000) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    this.watcher?.close();
    const current = await scanWorkspace(this.rootPath);
    const candidates = new Set([
      ...this.baseline.files.keys(),
      ...current.files.keys(),
      ...this.touched,
      ...this.explicitPaths,
    ]);
    const created: WorkspaceArtifactChange[] = [];
    const deleted: WorkspaceArtifactChange[] = [];
    const modified: WorkspaceArtifactChange[] = [];
    let partial = this.baseline.truncated || current.truncated;
    for (const relativePath of candidates) {
      const before = this.baseline.files.get(relativePath);
      const after = current.files.get(relativePath);
      if (!before && !after) continue;
      const unchanged = Boolean(
        before &&
        after &&
        (
          (before.sha256 && after.sha256 && before.sha256 === after.sha256) ||
          (!before.sha256 && !after.sha256 && before.size === after.size && before.mtimeMs === after.mtimeMs)
        ),
      );
      if (unchanged) continue;
      const metadata = artifactMetadata(relativePath);
      const blockedReason = after?.blockedReason ?? before?.blockedReason;
      const snapshot = after?.bytes ?? before?.bytes;
      const digest = after?.sha256 ?? before?.sha256;
      const changePartial = !blockedReason && !snapshot;
      partial ||= changePartial;
      const base: Omit<WorkspaceArtifactChange, "changeKind"> = {
        relativePath,
        ...(after?.absolutePath ? { absolutePath: after.absolutePath } : {}),
        ...metadata,
        size: after?.size ?? before?.size ?? 0,
        ...(digest ? { sha256: digest } : {}),
        ...(snapshot && !blockedReason ? { snapshot } : {}),
        ...(blockedReason ? { blockedReason } : {}),
        partial: changePartial,
      };
      if (!before && after) {
        created.push({ ...base, changeKind: "created" });
      } else if (before && !after) {
        deleted.push({ ...base, changeKind: "deleted" });
      } else {
        const diff = before?.bytes && after?.bytes
          ? unifiedEvidenceDiff(relativePath, before.bytes, after.bytes)
          : undefined;
        modified.push({
          ...base,
          changeKind: "modified",
          ...(diff ? { diff, previewMode: "diff" } : {}),
        });
      }
    }

    const consumedDeleted = new Set<number>();
    const renamed = created.flatMap((next): WorkspaceArtifactChange[] => {
      if (!next.sha256) return [];
      const index = deleted.findIndex((previous, candidateIndex) => (
        !consumedDeleted.has(candidateIndex) &&
        previous.sha256 === next.sha256
      ));
      if (index < 0) return [];
      consumedDeleted.add(index);
      return [{
        ...next,
        previousPath: deleted[index]!.relativePath,
        changeKind: "renamed",
      }];
    });
    const renamedPaths = new Set(renamed.map((item) => item.relativePath));
    const changes = [
      ...modified,
      ...created.filter((item) => !renamedPaths.has(item.relativePath)),
      ...deleted.filter((_item, index) => !consumedDeleted.has(index)),
      ...renamed,
    ].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    return {
      rootPath: this.rootPath,
      changes,
      partial,
      warnings: [...new Set([...this.baseline.warnings, ...current.warnings])],
    };
  }
}

export function artifactDisplayName(relativePath: string): string {
  return basename(relativePath) || relativePath;
}
