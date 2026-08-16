import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  ARTIFACT_MAX_BYTES,
  ARTIFACT_TRANSFER_CHUNK_BYTES,
  ARTIFACT_TRANSFER_TTL_MS,
  type BridgeArtifactManifest,
  type BridgeArtifactPreview,
  type BridgeArtifactTransferChunk,
  type BridgeArtifactTransferInfo,
  type BridgeEvidenceBundle,
  type BridgeEvidencePage,
  type BridgeDesktopRuntimeId,
  type BridgeEventType,
  type BridgeToolEvidence,
  type BridgeTokenUsage,
} from "@bridge/protocol";
import {
  EvidenceStore,
  type EvidenceArtifactInput,
} from "./evidence-store.js";
import type { SessionEventLog } from "./session-event-log.js";
import {
  WorkspaceEvidenceCapture,
  artifactDisplayName,
  artifactMetadata,
  sensitiveArtifactReason,
} from "./workspace-evidence.js";

const TOOL_OUTPUT_SNAPSHOT_BYTES = 256 * 1024;
const TURN_TOOL_OUTPUT_BYTES = 2 * 1024 * 1024;
const TOOL_INPUT_SNAPSHOT_BYTES = 4 * 1024;
const PREVIEW_TEXT_BYTES = 1024 * 1024;
const TURN_DIFF_PREVIEW_BYTES = 5 * 1024 * 1024;
const MAX_ACTIVE_TRANSFERS = 16;
const MAX_ACTIVE_TRANSFERS_PER_OWNER = 4;

interface ActiveEvidence {
  bundle: BridgeEvidenceBundle;
  cwd: string;
  capture?: WorkspaceEvidenceCapture;
  toolOutputs: Map<string, Buffer>;
  toolOutputBytes: number;
  sharedWorkspace: boolean;
  finalizing: boolean;
}

interface TransferRecord {
  owner: string;
  info: BridgeArtifactTransferInfo;
  bytes: Buffer;
}

export interface ObservedDesktopTool {
  id: string;
  toolName: string;
  input: unknown;
  output?: unknown;
  startedAt: number;
  completedAt?: number;
}

export interface ObservedDesktopEvidence {
  id: string;
  sessionId: string;
  cwd: string;
  turnId?: string;
  startedAt: number;
  completedAt: number;
  tools: ObservedDesktopTool[];
  paths: string[];
  warnings?: string[];
}

export interface EvidencePreviewRenderer {
  image(bytes: Buffer, mimeType: string): Promise<{ bytes: Buffer; mimeType: string }>;
  html(bytes: Buffer): Promise<{ bytes: Buffer; mimeType: string }>;
}

export interface EvidenceManagerOptions {
  store: EvidenceStore;
  eventLog: SessionEventLog;
  previewRenderer?: EvidencePreviewRenderer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableId(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("base64url").slice(0, 32);
}

function textFromOutput(value: unknown): string {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

export function redactEvidenceText(value: string): string {
  return value
    .replace(
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gu,
      "[已隐藏私钥]",
    )
    .replace(
      /(authorization\s*:\s*)(?:bearer\s+)?["']?[^\s"',;\\}]+/giu,
      "$1[已隐藏]",
    )
    .replace(
      /\b(api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password)\b(\s*[:=]\s*)(["']?)[^\s"',;]+/giu,
      "$1$2$3[已隐藏]",
    )
    .replace(/\b(sk-[A-Za-z0-9_-]{16,}|gh[opurs]_[A-Za-z0-9_]{20,})\b/gu, "[已隐藏令牌]");
}

function formatEvidenceBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function lineCount(bytes: Buffer): number {
  if (bytes.byteLength === 0) return 0;
  let lines = 1;
  for (const byte of bytes) {
    if (byte === 0x0a) lines += 1;
  }
  if (bytes.at(-1) === 0x0a) lines -= 1;
  return lines;
}

function outputShape(value: unknown): {
  byteLength: number;
  lineCount: number;
  truncated: boolean;
  bodyOmitted: boolean;
} {
  if (
    isRecord(value) &&
    value.bodyOmitted === true &&
    typeof value.byteLength === "number" &&
    typeof value.lineCount === "number"
  ) {
    return {
      byteLength: value.byteLength,
      lineCount: value.lineCount,
      truncated: value.truncated === true,
      bodyOmitted: true,
    };
  }
  const bytes = Buffer.from(redactEvidenceText(textFromOutput(value)), "utf8");
  return {
    byteLength: bytes.byteLength,
    lineCount: lineCount(bytes),
    truncated: false,
    bodyOmitted: false,
  };
}

function outputSummary(
  shape: ReturnType<typeof outputShape>,
  source: "bridge-host" | "claude-desktop",
): string | undefined {
  if (shape.byteLength === 0) return undefined;
  const size = formatEvidenceBytes(shape.byteLength);
  return source === "bridge-host"
    ? `已捕获 ${shape.lineCount.toLocaleString()} 行输出 · ${size}，正文按需打开`
    : `已恢复 ${shape.lineCount.toLocaleString()} 行工具结果 · ${size}，正文未自动传输`;
}

function findExitCode(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  if (value.isError === true) return 1;
  for (const key of ["exitCode", "exit_code", "code"]) {
    const candidate = value[key];
    if (typeof candidate === "number" && Number.isInteger(candidate)) return candidate;
  }
  for (const child of Object.values(value)) {
    const nested = findExitCode(child);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function toolSummary(toolName: string, input: unknown): string {
  if (!isRecord(input)) return toolName;
  for (const key of ["command", "file_path", "path", "notebook_path", "query", "pattern"]) {
    const value = input[key];
    if (typeof value !== "string" || !value.trim()) continue;
    const compact = redactEvidenceText(value.replace(/\s+/gu, " ").trim());
    return `${toolName}: ${compact.length > 160 ? `${compact.slice(0, 159)}…` : compact}`;
  }
  return toolName;
}

function normalizedProjectPath(root: string, candidate: string): {
  relativePath?: string;
  absolutePath?: string;
  blockedReason?: string;
} {
  const absolutePath = isAbsolute(candidate) ? resolve(candidate) : resolve(root, candidate);
  const path = relative(root, absolutePath);
  if (!path || path === "." || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    return { blockedReason: "项目目录之外的文件不允许远程读取" };
  }
  const relativePath = path.split(sep).join("/");
  const blockedReason = sensitiveArtifactReason(relativePath);
  return {
    relativePath,
    absolutePath,
    ...(blockedReason ? { blockedReason } : {}),
  };
}

export class EvidenceManager {
  private readonly active = new Map<string, ActiveEvidence>();
  private readonly rootOwners = new Map<string, number>();
  private readonly transfers = new Map<string, TransferRecord>();

  constructor(private readonly options: EvidenceManagerOptions) {}

  async initialize(): Promise<void> {
    await this.options.store.initialize();
    const interrupted = this.options.store.failCollectingBundles(
      "Bridge 在成果归档完成前重新启动，本轮证据已停止且可能不完整",
    );
    for (const bundle of interrupted) {
      await this.emitEvidence("evidence.failed", bundle);
    }
  }

  async close(): Promise<void> {
    this.transfers.clear();
    await this.options.store.close();
  }

  async startBridgeTurn(input: {
    sessionId: string;
    cwd: string;
    commandId: string;
    laneId?: string;
    providerProfileId?: string;
    source?: "bridge-host" | "runtime-host";
    runtimeId?: BridgeDesktopRuntimeId;
    startedAt?: number;
  }): Promise<string> {
    const id = randomUUID();
    const startedAt = input.startedAt ?? Date.now();
    const initialBundle: BridgeEvidenceBundle = {
      id,
      sessionId: input.sessionId,
      ...(input.laneId ? { laneId: input.laneId } : {}),
      ...(input.providerProfileId ? { providerProfileId: input.providerProfileId } : {}),
      ...(input.runtimeId ? { runtimeId: input.runtimeId } : {}),
      source: input.source ?? "bridge-host",
      confidence: "partial",
      state: "collecting",
      startedAt,
      toolCount: 0,
      changeCount: 0,
      artifactCount: 0,
      tools: [],
      artifacts: [],
      warnings: [],
    };
    const active: ActiveEvidence = {
      bundle: initialBundle,
      cwd: resolve(input.cwd),
      toolOutputs: new Map(),
      toolOutputBytes: 0,
      sharedWorkspace: false,
      finalizing: false,
    };
    this.active.set(id, active);
    this.options.store.saveBundle(initialBundle);
    await this.emitEvidence("evidence.started", initialBundle);

    let capture: WorkspaceEvidenceCapture | undefined;
    let root = resolve(input.cwd);
    const warnings: string[] = [];
    try {
      capture = await WorkspaceEvidenceCapture.start(input.cwd);
      root = capture.rootPath;
    } catch (error) {
      warnings.push(`工作区基线不可用：${error instanceof Error ? error.message : String(error)}`);
    }
    active.cwd = root;
    const owners = [...this.active.values()].filter((candidate) => candidate.cwd === root).length;
    this.rootOwners.set(root, owners);
    if (capture) active.capture = capture;
    active.bundle = {
      ...active.bundle,
      confidence: capture && owners === 1 ? "exact" : "partial",
      warnings,
    };
    if (owners > 1) {
      const concurrentWarning = "同一工作区存在并发任务，文件归因已降级";
      for (const candidate of this.active.values()) {
        if (candidate.cwd !== root) continue;
        candidate.sharedWorkspace = true;
        candidate.bundle = {
          ...candidate.bundle,
          confidence: "partial",
          warnings: [...new Set([...candidate.bundle.warnings, concurrentWarning])],
        };
        this.options.store.saveBundle(candidate.bundle);
        await this.emitEvidence("evidence.updated", candidate.bundle);
      }
    } else {
      this.options.store.saveBundle(active.bundle);
      await this.emitEvidence("evidence.updated", active.bundle);
    }
    return id;
  }

  async attachTurn(evidenceId: string, turnId: string): Promise<void> {
    const active = this.active.get(evidenceId);
    if (!active) return;
    active.bundle = { ...active.bundle, turnId };
    this.options.store.saveBundle(active.bundle);
  }

  async recordToolStarted(input: {
    sessionId: string;
    turnId?: string;
    itemId: string;
    toolName: string;
    toolInput: unknown;
    at: number;
  }): Promise<void> {
    const active = this.findActive(input.sessionId, input.turnId);
    if (!active) return;
    active.capture?.addToolInput(input.toolInput);
    const existing = active.bundle.tools.find((tool) => tool.id === input.itemId);
    if (!existing) {
      const redactedInput = input.toolInput === undefined || input.toolInput === null
        ? ""
        : redactEvidenceText(textFromOutput(input.toolInput)).slice(0, TOOL_INPUT_SNAPSHOT_BYTES);
      active.bundle.tools.push({
        id: input.itemId,
        toolName: input.toolName,
        status: "running",
        summary: toolSummary(input.toolName, input.toolInput),
        startedAt: input.at,
        ...(redactedInput ? { input: redactedInput } : {}),
        truncated: false,
      });
    }
    active.bundle.toolCount = active.bundle.tools.length;
    this.options.store.saveBundle(active.bundle);
    await this.emitEvidence("evidence.updated", active.bundle);
  }

  async recordToolCompleted(input: {
    sessionId: string;
    turnId?: string;
    itemId: string;
    output: unknown;
    at: number;
  }): Promise<void> {
    const active = this.findActive(input.sessionId, input.turnId);
    if (!active) return;
    const index = active.bundle.tools.findIndex((tool) => tool.id === input.itemId);
    const raw = Buffer.from(redactEvidenceText(textFromOutput(input.output)), "utf8");
    const allowed = Math.max(
      0,
      Math.min(TOOL_OUTPUT_SNAPSHOT_BYTES, TURN_TOOL_OUTPUT_BYTES - active.toolOutputBytes),
    );
    const storedOutput = raw.subarray(0, allowed);
    if (storedOutput.byteLength > 0) {
      active.toolOutputs.set(input.itemId, storedOutput);
      active.toolOutputBytes += storedOutput.byteLength;
    }
    const exitCode = findExitCode(input.output);
    const capturedOutputSummary = outputSummary({
      byteLength: raw.byteLength,
      lineCount: lineCount(raw),
      truncated: raw.byteLength > storedOutput.byteLength,
      bodyOmitted: false,
    }, "bridge-host");
    const current = index >= 0
      ? active.bundle.tools[index]!
      : {
          id: input.itemId,
          toolName: "工具",
          status: "running" as const,
          summary: "工具",
          startedAt: input.at,
          truncated: false,
        };
    const completed: BridgeToolEvidence = {
      ...current,
      status: exitCode !== undefined && exitCode !== 0 ? "failed" : "completed",
      completedAt: input.at,
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(capturedOutputSummary ? { outputSummary: capturedOutputSummary } : {}),
      truncated: raw.byteLength > storedOutput.byteLength,
    };
    if (index >= 0) active.bundle.tools[index] = completed;
    else active.bundle.tools.push(completed);
    active.bundle.toolCount = active.bundle.tools.length;
    this.options.store.saveBundle(active.bundle);
    await this.emitEvidence("evidence.updated", active.bundle);
  }

  async finalizeBridgeTurn(input: {
    sessionId: string;
    turnId?: string;
    failed?: boolean;
    error?: string;
    completedAt?: number;
    usage?: BridgeTokenUsage;
  }): Promise<BridgeEvidenceBundle | undefined> {
    const entry = [...this.active.entries()].find(([, active]) => (
      !active.finalizing &&
      active.bundle.sessionId === input.sessionId &&
      (!input.turnId || active.bundle.turnId === input.turnId)
    ));
    if (!entry) return undefined;
    const [evidenceId, active] = entry;
    active.finalizing = true;
    try {
      const capture = active.capture ? await active.capture.finalize() : undefined;
      const artifacts: EvidenceArtifactInput[] = [];
      let diffPreviewBytes = 0;
      let diffPreviewTruncated = false;
      for (const change of capture?.changes ?? []) {
        const artifactId = stableId(evidenceId, change.relativePath, change.changeKind);
        const remainingDiffBytes = Math.max(0, TURN_DIFF_PREVIEW_BYTES - diffPreviewBytes);
        const diffPreview = change.diff?.subarray(0, remainingDiffBytes);
        if (diffPreview) diffPreviewBytes += diffPreview.byteLength;
        if (change.diff && diffPreview?.byteLength !== change.diff.byteLength) {
          diffPreviewTruncated = true;
        }
        const previewMode = change.diff && !diffPreview?.byteLength
          ? change.snapshot && ["code", "text", "log"].includes(change.kind)
            ? "text"
            : "none"
          : change.previewMode;
        const manifest: BridgeArtifactManifest = {
          id: artifactId,
          evidenceId,
          relativePath: change.relativePath,
          ...(change.previousPath ? { previousPath: change.previousPath } : {}),
          name: artifactDisplayName(change.relativePath),
          kind: change.kind,
          changeKind: change.changeKind,
          mimeType: change.mimeType,
          size: change.size,
          ...(change.sha256 ? { sha256: change.sha256 } : {}),
          availability: change.blockedReason
            ? "blocked"
            : change.snapshot
              ? "snapshot"
              : "current-file",
          previewMode,
          downloadAllowed: !change.blockedReason && Boolean(change.snapshot) && change.size <= ARTIFACT_MAX_BYTES,
          ...(change.blockedReason ? { blockedReason: change.blockedReason } : {}),
          ...(change.snapshot ? { capturedAt: Date.now() } : {}),
        };
        artifacts.push({
          manifest,
          rootPath: capture!.rootPath,
          ...(change.absolutePath ? { sourcePath: change.absolutePath } : {}),
          ...(change.snapshot && !change.blockedReason ? { snapshot: change.snapshot } : {}),
          ...(diffPreview?.byteLength
            ? { preview: { bytes: diffPreview, mimeType: "text/x-diff" } }
            : {}),
        });
      }
      for (const tool of active.bundle.tools) {
        const output = active.toolOutputs.get(tool.id);
        if (!output) continue;
        const relativePath = `.bridge-evidence/${tool.toolName}-${tool.id.slice(0, 8)}.log`;
        artifacts.push({
          manifest: {
            id: stableId(evidenceId, "tool-output", tool.id),
            evidenceId,
            relativePath,
            name: `${tool.toolName} 输出`,
            kind: "log",
            changeKind: "observed",
            mimeType: "text/plain",
            size: output.byteLength,
            sha256: createHash("sha256").update(output).digest("hex"),
            availability: "snapshot",
            previewMode: "text",
            downloadAllowed: true,
            capturedAt: Date.now(),
          },
          rootPath: active.cwd,
          snapshot: output,
        });
      }
      const warnings = [
        ...active.bundle.warnings,
        ...(capture?.warnings ?? []),
        ...(active.toolOutputBytes >= TURN_TOOL_OUTPUT_BYTES ? ["工具输出超过每轮 2 MiB，已截断"] : []),
        ...(diffPreviewTruncated ? ["文本差异超过每轮 5 MiB，已截断"] : []),
        ...(input.error ? [input.error] : []),
      ];
      const confidence = (
        active.sharedWorkspace ||
        !capture ||
        capture.partial ||
        artifacts.some((artifact) => artifact.manifest.availability === "current-file")
      ) ? "partial" : "exact";
      const bundle: BridgeEvidenceBundle = {
        ...active.bundle,
        confidence,
        state: input.failed ? "failed" : "ready",
        completedAt: input.completedAt ?? Date.now(),
        ...(input.usage ? { usage: input.usage } : {}),
        toolCount: active.bundle.tools.length,
        changeCount: capture?.changes.length ?? 0,
        artifactCount: artifacts.filter((artifact) => artifact.manifest.changeKind !== "deleted").length,
        artifacts: artifacts.map((artifact) => artifact.manifest),
        warnings: [...new Set(warnings)],
      };
      this.options.store.saveBundle(bundle);
      await this.options.store.replaceArtifacts(evidenceId, artifacts);
      await this.options.store.prune();
      const persisted = this.options.store.get(evidenceId) ?? bundle;
      await this.emitEvidence(input.failed ? "evidence.failed" : "evidence.ready", persisted);
      return persisted;
    } catch (error) {
      const bundle: BridgeEvidenceBundle = {
        ...active.bundle,
        confidence: "partial",
        state: "failed",
        completedAt: Date.now(),
        warnings: [
          ...active.bundle.warnings,
          error instanceof Error ? error.message : String(error),
        ],
      };
      this.options.store.saveBundle(bundle);
      await this.emitEvidence("evidence.failed", bundle);
      return bundle;
    } finally {
      this.active.delete(evidenceId);
      const owners = Math.max(0, (this.rootOwners.get(active.cwd) ?? 1) - 1);
      if (owners === 0) this.rootOwners.delete(active.cwd);
      else this.rootOwners.set(active.cwd, owners);
    }
  }

  async upsertDesktopEvidence(input: ObservedDesktopEvidence): Promise<BridgeEvidenceBundle> {
    const existing = this.options.store.get(input.id);
    let desktopOutputBytes = 0;
    let desktopOutputTruncated = false;
    const tools = input.tools.map((tool): BridgeToolEvidence => {
      const shape = tool.output === undefined ? undefined : outputShape(tool.output);
      const allowed = shape
        ? Math.max(
            0,
            Math.min(
              TOOL_OUTPUT_SNAPSHOT_BYTES,
              TURN_TOOL_OUTPUT_BYTES - desktopOutputBytes,
              shape.byteLength,
            ),
          )
        : 0;
      desktopOutputBytes += allowed;
      const outputWasTruncated = Boolean(
        shape && (shape.truncated || shape.byteLength > allowed),
      );
      desktopOutputTruncated ||= outputWasTruncated;
      const exitCode = findExitCode(tool.output);
      const recoveredOutputSummary = shape
        ? outputSummary(shape, "claude-desktop")
        : undefined;
      return {
        id: tool.id,
        toolName: tool.toolName,
        status: tool.completedAt
          ? exitCode !== undefined && exitCode !== 0 ? "failed" : "completed"
          : "running",
        summary: toolSummary(tool.toolName, tool.input),
        startedAt: tool.startedAt,
        ...(tool.completedAt ? { completedAt: tool.completedAt } : {}),
        ...(exitCode !== undefined ? { exitCode } : {}),
        ...(recoveredOutputSummary ? { outputSummary: recoveredOutputSummary } : {}),
        truncated: outputWasTruncated,
      };
    });
    const artifactsByPath = new Map<string, EvidenceArtifactInput>();
    for (const candidate of [...new Set(input.paths)]) {
      const normalized = normalizedProjectPath(input.cwd, candidate);
      const relativePath = normalized.relativePath ?? `[项目外]/${artifactDisplayName(candidate)}`;
      if (artifactsByPath.has(relativePath)) continue;
      const metadata = artifactMetadata(relativePath);
      const blockedReason = normalized.blockedReason ?? sensitiveArtifactReason(relativePath);
      const manifest: BridgeArtifactManifest = {
        id: stableId(input.id, relativePath),
        evidenceId: input.id,
        relativePath,
        name: artifactDisplayName(relativePath),
        ...metadata,
        changeKind: "observed",
        size: 0,
        availability: blockedReason ? "blocked" : "current-file",
        downloadAllowed: !blockedReason,
        ...(blockedReason ? { blockedReason } : {}),
      };
      artifactsByPath.set(relativePath, {
        manifest,
        rootPath: input.cwd,
        ...(normalized.absolutePath ? { sourcePath: normalized.absolutePath } : {}),
      });
    }
    const artifacts = [...artifactsByPath.values()];
    const bundle: BridgeEvidenceBundle = {
      id: input.id,
      sessionId: input.sessionId,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      source: "claude-desktop",
      confidence: "inferred",
      state: "ready",
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      toolCount: tools.length,
      changeCount: artifacts.length,
      artifactCount: artifacts.filter((artifact) => !artifact.manifest.blockedReason).length,
      tools,
      artifacts: artifacts.map((artifact) => artifact.manifest),
      warnings: [...new Set([
        "来自 Claude Desktop 事后记录，不代表实时或完整工作区差异",
        ...(desktopOutputTruncated ? ["工具结果超过恢复上限，已按 256 KiB/次、2 MiB/轮截断"] : []),
        ...(input.warnings ?? []),
      ])],
    };
    if (
      existing &&
      existing.source === bundle.source &&
      existing.sessionId === bundle.sessionId &&
      existing.turnId === bundle.turnId &&
      existing.startedAt === bundle.startedAt &&
      existing.completedAt === bundle.completedAt &&
      JSON.stringify(existing.tools) === JSON.stringify(bundle.tools) &&
      JSON.stringify(existing.warnings) === JSON.stringify(bundle.warnings) &&
      existing.artifacts.length === bundle.artifacts.length &&
      existing.artifacts.every((artifact) => bundle.artifacts.some((candidate) => (
        candidate.id === artifact.id &&
        candidate.relativePath === artifact.relativePath &&
        candidate.blockedReason === artifact.blockedReason
      )))
    ) return existing;
    this.options.store.saveBundle(bundle);
    await this.options.store.replaceArtifacts(input.id, artifacts);
    const persisted = this.options.store.get(input.id) ?? bundle;
    await this.emitEvidence(existing ? "evidence.updated" : "evidence.ready", persisted);
    return persisted;
  }

  list(sessionId: string, cursor?: string, limit?: number): BridgeEvidencePage {
    return this.options.store.list(sessionId, cursor, limit);
  }

  get(evidenceId: string): BridgeEvidenceBundle | undefined {
    return this.options.store.get(evidenceId);
  }

  async preview(artifactId: string): Promise<BridgeArtifactPreview> {
    const artifact = this.options.store.artifact(artifactId);
    if (!artifact) throw new Error("Artifact not found");
    if (artifact.manifest.previewMode === "none") throw new Error("This artifact has no embedded preview");
    const cached = await this.options.store.readPreview(artifactId);
    if (cached) {
      return {
        artifactId,
        mode: artifact.manifest.previewMode,
        mimeType: cached.mimeType,
        encoding: cached.mimeType.startsWith("text/") ? "utf8" : "base64",
        data: cached.mimeType.startsWith("text/") ? cached.bytes.toString("utf8") : cached.bytes.toString("base64"),
        truncated: false,
        generatedAt: Date.now(),
      };
    }
    const bytes = await this.ensureArtifactSnapshot(artifactId);
    if (artifact.manifest.previewMode === "image") {
      const rendered = this.options.previewRenderer
        ? await this.options.previewRenderer.image(bytes, artifact.manifest.mimeType)
        : { bytes, mimeType: artifact.manifest.mimeType };
      await this.options.store.cachePreview(artifactId, rendered.bytes, rendered.mimeType);
      return {
        artifactId,
        mode: "image",
        mimeType: rendered.mimeType,
        encoding: "base64",
        data: rendered.bytes.toString("base64"),
        truncated: rendered.bytes.byteLength < bytes.byteLength,
        generatedAt: Date.now(),
      };
    }
    if (artifact.manifest.previewMode === "html-screenshot") {
      if (!this.options.previewRenderer) throw new Error("HTML preview is unavailable");
      const rendered = await this.options.previewRenderer.html(bytes);
      await this.options.store.cachePreview(artifactId, rendered.bytes, rendered.mimeType);
      return {
        artifactId,
        mode: "html-screenshot",
        mimeType: rendered.mimeType,
        encoding: "base64",
        data: rendered.bytes.toString("base64"),
        truncated: false,
        generatedAt: Date.now(),
      };
    }
    const clipped = bytes.subarray(0, PREVIEW_TEXT_BYTES);
    return {
      artifactId,
      mode: artifact.manifest.previewMode === "diff" ? "diff" : "text",
      mimeType: artifact.manifest.previewMode === "diff" ? "text/x-diff" : artifact.manifest.mimeType,
      encoding: "utf8",
      data: clipped.toString("utf8"),
      truncated: clipped.byteLength < bytes.byteLength,
      generatedAt: Date.now(),
    };
  }

  async openTransfer(artifactId: string, owner: string): Promise<BridgeArtifactTransferInfo> {
    this.pruneTransfers();
    const previous = [...this.transfers.entries()].find(([, transfer]) => (
      transfer.owner === owner && transfer.info.artifactId === artifactId
    ));
    if (previous) this.transfers.delete(previous[0]);
    if (
      this.transfers.size >= MAX_ACTIVE_TRANSFERS ||
      [...this.transfers.values()].filter((transfer) => transfer.owner === owner).length
        >= MAX_ACTIVE_TRANSFERS_PER_OWNER
    ) {
      throw new Error("Too many artifact transfers are active");
    }
    const artifact = this.options.store.artifact(artifactId);
    if (!artifact) throw new Error("Artifact not found");
    if (!artifact.manifest.downloadAllowed) {
      throw new Error(artifact.manifest.blockedReason ?? "Artifact download is unavailable");
    }
    const bytes = await this.ensureArtifactSnapshot(artifactId);
    if (bytes.byteLength > ARTIFACT_MAX_BYTES) throw new Error("Artifact exceeds the 20 MiB limit");
    const transferId = randomUUID();
    const info: BridgeArtifactTransferInfo = {
      transferId,
      artifactId,
      name: artifact.manifest.name,
      mimeType: artifact.manifest.mimeType,
      size: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      chunkBytes: ARTIFACT_TRANSFER_CHUNK_BYTES,
      totalChunks: Math.max(1, Math.ceil(bytes.byteLength / ARTIFACT_TRANSFER_CHUNK_BYTES)),
      expiresAt: Date.now() + ARTIFACT_TRANSFER_TTL_MS,
    };
    this.transfers.set(transferId, { owner, info, bytes });
    return info;
  }

  readTransfer(transferId: string, index: number, owner: string): BridgeArtifactTransferChunk {
    this.pruneTransfers();
    const transfer = this.transfers.get(transferId);
    if (!transfer || transfer.owner !== owner) throw new Error("Artifact transfer expired");
    if (!Number.isInteger(index) || index < 0 || index >= transfer.info.totalChunks) {
      throw new Error("Artifact chunk index is invalid");
    }
    const start = index * transfer.info.chunkBytes;
    return {
      transferId,
      index,
      data: transfer.bytes.subarray(start, start + transfer.info.chunkBytes).toString("base64"),
    };
  }

  closeTransfer(transferId: string, owner: string): boolean {
    const transfer = this.transfers.get(transferId);
    if (!transfer || transfer.owner !== owner) return false;
    return this.transfers.delete(transferId);
  }

  private findActive(sessionId: string, turnId?: string): ActiveEvidence | undefined {
    return [...this.active.values()].find((active) => (
      active.bundle.sessionId === sessionId &&
      (!turnId || !active.bundle.turnId || active.bundle.turnId === turnId)
    ));
  }

  private async ensureArtifactSnapshot(artifactId: string): Promise<Buffer> {
    const cached = await this.options.store.readArtifact(artifactId);
    if (cached) return cached;
    const artifact = this.options.store.artifact(artifactId);
    if (!artifact) throw new Error("Artifact not found");
    if (artifact.manifest.blockedReason) throw new Error(artifact.manifest.blockedReason);
    if (!artifact.sourcePath) throw new Error("Artifact snapshot has expired");
    const [rootPath, sourcePath] = await Promise.all([
      realpath(artifact.rootPath),
      realpath(artifact.sourcePath),
    ]);
    const normalized = normalizedProjectPath(rootPath, sourcePath);
    if (!normalized.relativePath || normalized.blockedReason) {
      throw new Error(normalized.blockedReason ?? "Artifact is outside the project");
    }
    const metadata = await stat(sourcePath);
    if (!metadata.isFile()) throw new Error("Artifact is not a regular file");
    if (metadata.size > ARTIFACT_MAX_BYTES) throw new Error("Artifact exceeds the 20 MiB limit");
    const bytes = await readFile(sourcePath);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (artifact.manifest.sha256 && artifact.manifest.sha256 !== digest) {
      throw new Error("Artifact changed after this evidence was captured");
    }
    await this.options.store.cacheArtifact(artifactId, bytes, {
      relativePath: normalized.relativePath,
      downloadAllowed: true,
    });
    return bytes;
  }

  private async emitEvidence(type: BridgeEventType, bundle: BridgeEvidenceBundle): Promise<void> {
    await this.options.eventLog.append({
      sessionId: bundle.sessionId,
      ...(bundle.turnId ? { turnId: bundle.turnId } : {}),
      itemId: bundle.id,
      timestamp: type === "evidence.started" ? bundle.startedAt : Date.now(),
      origin: bundle.source === "bridge-host" ? "claude-host" : "claude-desktop",
      type,
      data: { evidence: bundle },
    });
  }

  private pruneTransfers(): void {
    const now = Date.now();
    for (const [id, transfer] of this.transfers) {
      if (transfer.info.expiresAt <= now) this.transfers.delete(id);
    }
  }
}
