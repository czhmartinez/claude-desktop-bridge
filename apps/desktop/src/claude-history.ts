import { createReadStream } from "node:fs";
import { access, readdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import type { BridgeHistoryPage, ClaudeHistoryMessage } from "@bridge/protocol";

const SAFE_SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const MAX_HISTORY_MESSAGES = 50;
const MAX_HISTORY_TEXT_BYTES = 256 * 1024;
const MAX_MESSAGE_TEXT_BYTES = 10 * 1024;
const OMITTED_TEXT = "\n\n[内容较长，已省略中间部分]\n\n";

interface TranscriptNode {
  index: number;
  uuid: string;
  parentUuid?: string;
  role?: ClaudeHistoryMessage["role"];
  text?: string;
  createdAt: number;
}

export interface ClaudeHistoryReadResult {
  available: boolean;
  messages: ClaudeHistoryMessage[];
  truncated: boolean;
}

export interface ClaudeHistoryReadOptions {
  beforeCursor?: string;
  before?: { createdAt: number; id: string };
  limit?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textFromContent(content: unknown): string {
  const blocks = Array.isArray(content) ? content : [content];
  const parts: string[] = [];
  for (const block of blocks) {
    if (typeof block === "string") {
      parts.push(block);
      continue;
    }
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block.type === "image") parts.push("[图片]");
    else if (block.type === "document") parts.push("[附件]");
  }
  return parts.map((part) => part.trim()).filter(Boolean).join("\n\n");
}

function cleanUserText(value: string): string {
  return value
    .replace(/^\s*\[来自手机 Bridge\]\s*/u, "")
    .replace(/\s*<!--\s*bridge-command:[A-Za-z0-9_-]{1,64}\s*-->\s*/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function visibleMessage(value: Record<string, unknown>): Pick<TranscriptNode, "role" | "text"> | undefined {
  if (value.type !== "user" && value.type !== "assistant") return undefined;
  if (!isRecord(value.message)) return undefined;
  if (value.type === "user" && (value.toolUseResult !== undefined || value.isMeta === true)) return undefined;
  const text = textFromContent(value.message.content);
  if (!text) return undefined;
  return value.type === "user"
    ? { role: "user", text: cleanUserText(text) }
    : { role: "assistant", text: text.trim() };
}

function takePrefixByBytes(value: string, maxBytes: number): string {
  let size = 0;
  let result = "";
  for (const character of value) {
    const next = Buffer.byteLength(character);
    if (size + next > maxBytes) break;
    result += character;
    size += next;
  }
  return result;
}

function takeSuffixByBytes(value: string, maxBytes: number): string {
  let size = 0;
  const characters = [...value];
  let result = "";
  for (let index = characters.length - 1; index >= 0; index -= 1) {
    const character = characters[index]!;
    const next = Buffer.byteLength(character);
    if (size + next > maxBytes) break;
    result = character + result;
    size += next;
  }
  return result;
}

function clipText(value: string, maxBytes: number): { text: string; clipped: boolean } {
  if (Buffer.byteLength(value) <= maxBytes) return { text: value, clipped: false };
  const markerBytes = Buffer.byteLength(OMITTED_TEXT);
  const available = Math.max(2, maxBytes - markerBytes);
  const prefixBytes = Math.ceil(available * 0.6);
  const suffixBytes = available - prefixBytes;
  return {
    text: `${takePrefixByBytes(value, prefixBytes).trimEnd()}${OMITTED_TEXT}${takeSuffixByBytes(value, suffixBytes).trimStart()}`,
    clipped: true,
  };
}

function trimHistory(
  messages: ClaudeHistoryMessage[],
  options: ClaudeHistoryReadOptions = {},
): { messages: ClaudeHistoryMessage[]; truncated: boolean; nextCursor?: string } {
  let candidateMessages = messages;
  if (options.before) {
    candidateMessages = messages.filter((message) => (
      message.createdAt < options.before!.createdAt ||
      (message.createdAt === options.before!.createdAt && message.id < options.before!.id)
    ));
  } else if (options.beforeCursor) {
    const beforeIndex = messages.findIndex((message) => message.id === options.beforeCursor);
    candidateMessages = beforeIndex >= 0 ? messages.slice(0, beforeIndex) : [];
  }
  const maxMessages = Math.max(1, Math.min(options.limit ?? MAX_HISTORY_MESSAGES, 10_000));
  const selected: ClaudeHistoryMessage[] = [];
  let bytes = 0;
  let truncated = candidateMessages.length > maxMessages;
  for (let index = candidateMessages.length - 1; index >= 0 && selected.length < maxMessages; index -= 1) {
    const message = candidateMessages[index]!;
    const clipped = clipText(message.text, MAX_MESSAGE_TEXT_BYTES);
    const cost = Buffer.byteLength(clipped.text) + 180;
    if (selected.length > 0 && bytes + cost > MAX_HISTORY_TEXT_BYTES) {
      truncated = true;
      break;
    }
    selected.unshift({ ...message, text: clipped.text });
    bytes += cost;
    truncated ||= clipped.clipped;
  }
  if (selected.length < candidateMessages.length) truncated = true;
  if (truncated && selected[0]?.role === "assistant") {
    const firstUser = selected.findIndex((message) => message.role === "user");
    if (firstUser > 0) selected.splice(0, firstUser);
  }
  return {
    messages: selected,
    truncated,
    ...(truncated && selected[0] ? { nextCursor: selected[0].id } : {}),
  };
}

function projectDirectoryName(cwd: string): string {
  return cwd.replace(/[:\\/]/gu, "-");
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

export async function findClaudeTranscriptFile(
  projectsRoot: string,
  sessionId: string,
  cwd?: string,
): Promise<string | undefined> {
  if (!SAFE_SESSION_ID.test(sessionId)) return undefined;
  const filename = `${sessionId}.jsonl`;
  const directCandidates = [
    join(projectsRoot, filename),
    ...(cwd ? [join(projectsRoot, projectDirectoryName(cwd), filename)] : []),
  ];
  for (const candidate of directCandidates) {
    if (await exists(candidate)) return candidate;
  }

  let directories;
  try {
    directories = (await readdir(projectsRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory());
  } catch {
    return undefined;
  }
  for (let offset = 0; offset < directories.length; offset += 40) {
    const candidates = directories.slice(offset, offset + 40).map((entry) => join(projectsRoot, entry.name, filename));
    const matches = await Promise.all(candidates.map(async (candidate) => await exists(candidate) ? candidate : undefined));
    const match = matches.find((candidate): candidate is string => candidate !== undefined);
    if (match) return match;
  }
  return undefined;
}

export async function parseClaudeTranscript(
  path: string,
  options: ClaudeHistoryReadOptions = {},
): Promise<ClaudeHistoryReadResult & { nextCursor?: string }> {
  const nodes = new Map<string, TranscriptNode>();
  const referencedParents = new Set<string>();
  let index = 0;
  try {
    const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of lines) {
      index += 1;
      let value: unknown;
      try {
        value = JSON.parse(line) as unknown;
      } catch {
        continue;
      }
      if (!isRecord(value) || typeof value.uuid !== "string" || !value.uuid) continue;
      const parentUuid = typeof value.parentUuid === "string" && value.parentUuid ? value.parentUuid : undefined;
      if (parentUuid) referencedParents.add(parentUuid);
      const visible = visibleMessage(value);
      const parsedAt = typeof value.timestamp === "string" ? Date.parse(value.timestamp) : Number.NaN;
      nodes.set(value.uuid, {
        index,
        uuid: value.uuid,
        ...(parentUuid ? { parentUuid } : {}),
        ...(visible?.role ? { role: visible.role } : {}),
        ...(visible?.text ? { text: visible.text } : {}),
        createdAt: Number.isFinite(parsedAt) ? parsedAt : 0,
      });
    }
  } catch {
    return { available: false, messages: [], truncated: false };
  }

  const terminal = [...nodes.values()]
    .filter((node) => !referencedParents.has(node.uuid))
    .sort((left, right) => right.index - left.index)[0];
  if (!terminal) return { available: true, messages: [], truncated: false };

  const chain: TranscriptNode[] = [];
  const seen = new Set<string>();
  let current: TranscriptNode | undefined = terminal;
  while (current && !seen.has(current.uuid)) {
    seen.add(current.uuid);
    chain.push(current);
    current = current.parentUuid ? nodes.get(current.parentUuid) : undefined;
  }
  chain.reverse();

  const messages: ClaudeHistoryMessage[] = [];
  for (const node of chain) {
    if (!node.role || !node.text) continue;
    const previous = messages.at(-1);
    if (node.role === "assistant" && previous?.role === "assistant") {
      previous.text = `${previous.text}\n\n${node.text}`;
      continue;
    }
    messages.push({ id: node.uuid, role: node.role, text: node.text, createdAt: node.createdAt });
  }
  return { available: true, ...trimHistory(messages, options) };
}

export async function readClaudeSessionHistory(
  projectsRoot: string,
  sessionId: string,
  cwd?: string,
  options: ClaudeHistoryReadOptions = {},
): Promise<ClaudeHistoryReadResult & { nextCursor?: string }> {
  const path = await findClaudeTranscriptFile(projectsRoot, sessionId, cwd);
  if (!path) return { available: false, messages: [], truncated: false };
  return parseClaudeTranscript(path, options);
}

export async function readClaudeSessionHistoryPage(
  projectsRoot: string,
  sessionId: string,
  cwd?: string,
  options: ClaudeHistoryReadOptions = {},
): Promise<BridgeHistoryPage> {
  const result = await readClaudeSessionHistory(projectsRoot, sessionId, cwd, options);
  return {
    sessionId,
    items: result.messages.map((message) => ({
      id: message.id,
      sessionId,
      role: message.role,
      text: message.text,
      createdAt: message.createdAt,
      origin: "claude-desktop",
    })),
    hasMore: result.truncated,
    ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
  };
}
