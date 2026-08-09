import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import type {
  BridgeDesktopRuntimeId,
  BridgeHistoryItem,
} from "@bridge/protocol";

const execFileAsync = promisify(execFile);

export const EXECUTABLE_PROMPT_LIMIT = 48_000;
export const HANDOFF_HISTORY_ITEM_LIMIT = 24;
export const HANDOFF_HISTORY_TEXT_LIMIT = 2_000;

export interface HandoffConversationEntry {
  role: BridgeHistoryItem["role"];
  text: string;
  createdAt: number;
}

export interface HandoffWorkspaceSnapshot {
  cwd: string;
  gitHead?: string;
  gitBranch?: string;
  dirty: boolean;
  changedFiles: string[];
}

export interface HandoffArtifactSummary {
  path: string;
  change: string;
  size: number;
  sha256?: string;
}

/**
 * Cross-Desktop serial relay package (0.7). Carries bounded, user-visible
 * context from one runtime to a brand-new session on another runtime.
 * Never contains hidden reasoning, credentials, or runtime internals.
 */
export interface RuntimeHandoffPackage {
  version: 1;
  handoffId: string;
  sourceRuntimeId: BridgeDesktopRuntimeId;
  sourceSessionId: string;
  sourceNativeSessionId?: string;
  targetRuntimeId: BridgeDesktopRuntimeId;
  objective: string;
  recentConversation: HandoffConversationEntry[];
  constraints: string[];
  incompleteItems: string[];
  toolsAndCommands: string[];
  artifacts: HandoffArtifactSummary[];
  workspace: HandoffWorkspaceSnapshot;
  sourceEventSeq: number;
  integrityHash: string;
}

export function compact(value: string, limit: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}

export function redact(value: string, cwd?: string): string {
  let result = value
    .replace(/\bsk-ant-[A-Za-z0-9_-]{8,}\b/gu, "[REDACTED_API_KEY]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{8,}\b/giu, "Bearer [REDACTED]")
    .replace(/\b(api[_ -]?key|authorization|oauth|access[_ -]?token)\s*[:=]\s*\S+/giu, "$1=[REDACTED]");
  const pathIsWithinProject = (path: string): boolean => {
    if (!cwd) return false;
    const normalizeForCompare = (candidate: string) => candidate
      .replaceAll("\\", "/")
      .replace(/\/+$/u, "")
      .toLocaleLowerCase();
    const candidate = normalizeForCompare(path);
    const project = normalizeForCompare(cwd);
    return candidate === project || candidate.startsWith(`${project}/`);
  };
  result = result.replace(
    /\/(?:Users|private|Volumes|etc|var|tmp)\/[^\s"'`]+/gu,
    (path) => pathIsWithinProject(path) ? path : "[OUTSIDE_PROJECT_PATH]",
  );
  result = result.replace(
    /(?:[A-Za-z]:[\\/]|\\\\)[^\s"'`<>|;&]+/gu,
    (path) => pathIsWithinProject(path) ? path : "[OUTSIDE_PROJECT_PATH]",
  );
  return result;
}

export function packageHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export async function gitValue(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const value = result.stdout.trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

export function changedPaths(status: string | undefined): string[] {
  if (!status) return [];
  return status.split("\n").flatMap((line) => {
    const path = line.slice(3).trim();
    if (!path) return [];
    const renamed = path.includes(" -> ") ? path.split(" -> ").at(-1)! : path;
    return [renamed];
  }).slice(0, 200);
}

export async function captureWorkspace(cwd: string): Promise<HandoffWorkspaceSnapshot> {
  const [gitHead, gitBranch, status] = await Promise.all([
    gitValue(cwd, ["rev-parse", "HEAD"]),
    gitValue(cwd, ["branch", "--show-current"]),
    gitValue(cwd, ["status", "--porcelain=v1", "--untracked-files=normal"]),
  ]);
  return {
    cwd,
    ...(gitHead ? { gitHead } : {}),
    ...(gitBranch ? { gitBranch } : {}),
    dirty: Boolean(status),
    changedFiles: changedPaths(status),
  };
}

const CONSTRAINT_PATTERN = /(?:必须|不要|禁止|只能|保留|不得|must|never|only)/iu;

export function extractLatestGoal(
  entries: HandoffConversationEntry[],
  fallbacks: Array<string | undefined>,
): string {
  const fromConversation = [...entries].reverse().find((item) => item.role === "user")?.text;
  return fromConversation ?? fallbacks.find((value) => value && value.trim()) ?? "继续当前可见任务";
}

export function extractConstraints(entries: HandoffConversationEntry[]): string[] {
  return entries
    .filter((item) => item.role === "user" && CONSTRAINT_PATTERN.test(item.text))
    .slice(-8)
    .map((item) => compact(item.text, 500));
}

export function normalizeConversation(
  items: Array<{ role: BridgeHistoryItem["role"]; text: string; createdAt: number }>,
  cwd: string,
  itemLimit = HANDOFF_HISTORY_ITEM_LIMIT,
  textLimit = HANDOFF_HISTORY_TEXT_LIMIT,
): HandoffConversationEntry[] {
  return items
    .filter((item) => item.role === "user" || item.role === "assistant")
    .slice(-itemLimit)
    .map((item) => ({
      role: item.role,
      text: redact(compact(item.text, textLimit), cwd),
      createdAt: item.createdAt,
    }));
}

export function handoffContextBlock(input: {
  handoffId: string;
  objective: string;
  constraints: string[];
  incompleteItems: string[];
  recentConversation: HandoffConversationEntry[];
  toolsAndCommands: string[];
  artifacts: HandoffArtifactSummary[];
  workspace: HandoffWorkspaceSnapshot;
  sourceEventSeq: number;
  integrityHash: string;
}): string {
  const history = input.recentConversation
    .map((item) => `${item.role === "user" ? "用户" : "助手"}: ${item.text}`)
    .join("\n\n");
  const artifacts = input.artifacts
    .map((artifact) => `- ${artifact.change}: ${artifact.path}${artifact.sha256 ? ` sha256=${artifact.sha256}` : ""}`)
    .join("\n");
  return [
    `[Bridge 接力 ${input.handoffId}]`,
    "这是 Bridge 生成的结构化可见上下文接力，不包含隐藏思维、OAuth、API Key 或服务端运行态。",
    "",
    `当前目标：${input.objective}`,
    input.constraints.length ? `约束：\n${input.constraints.map((value) => `- ${value}`).join("\n")}` : "",
    input.incompleteItems.length
      ? `未完成事项：\n${input.incompleteItems.map((value) => `- ${value}`).join("\n")}`
      : "",
    history ? `近期可见对话：\n${history}` : "",
    input.toolsAndCommands.length
      ? `工具与命令摘要：\n${input.toolsAndCommands.map((value) => `- ${value}`).join("\n")}`
      : "",
    artifacts ? `成果与变更：\n${artifacts}` : "",
    `工作区：${input.workspace.cwd}`,
    `Git：${input.workspace.gitBranch ?? "detached/unknown"} @ ${input.workspace.gitHead ?? "unknown"}，`
      + `${input.workspace.dirty ? "有未提交改动" : "工作区干净"}`,
    `源事件序号：${input.sourceEventSeq}`,
    `完整性哈希：${input.integrityHash}`,
  ].filter(Boolean).join("\n\n");
}
