import { createReadStream } from "node:fs";
import { access, readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import {
  isClaudeTranscriptControlMessage,
  type BridgeHistoryPage,
  type ClaudeHistoryMessage,
} from "@bridge/protocol";

const SAFE_SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const MAX_HISTORY_MESSAGES = 50;
const MAX_HISTORY_TEXT_BYTES = 256 * 1024;
const MAX_MESSAGE_TEXT_BYTES = 10 * 1024;
const MAX_TOOL_RESULT_BYTES = 256 * 1024;
const OMITTED_TEXT = "\n\n[内容较长，已省略中间部分]\n\n";

interface TranscriptNode {
  index: number;
  uuid: string;
  parentUuid?: string;
  type?: "user" | "assistant";
  stopReason?: string;
  interruptedBoundary?: boolean;
  role?: ClaudeHistoryMessage["role"];
  text?: string;
  createdAt: number;
}

interface TranscriptTurnNode {
  index: number;
  uuid: string;
  parentUuid?: string;
  type?: "user" | "assistant";
  stopReason?: string;
  interruptedBoundary?: boolean;
}

interface TranscriptEvidenceNode {
  index: number;
  uuid: string;
  parentUuid?: string;
  type?: "user" | "assistant";
  createdAt: number;
  userPrompt: boolean;
  completedBoundary: boolean;
  tools: Array<{ id: string; name: string; input: unknown }>;
  results: Array<{ id?: string; output: unknown }>;
}

export interface ClaudeTranscriptToolEvidence {
  id: string;
  toolName: string;
  input: unknown;
  output?: unknown;
  startedAt: number;
  completedAt?: number;
}

export interface ClaudeTranscriptEvidenceTurn {
  id: string;
  startedAt: number;
  completedAt: number;
  tools: ClaudeTranscriptToolEvidence[];
  paths: string[];
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

export interface ClaudeSessionContextEstimate {
  totalTokens: number;
  model?: string;
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

function evidencePaths(value: unknown): string[] {
  const paths: string[] = [];
  const visit = (candidate: unknown, key = ""): void => {
    if (typeof candidate === "string") {
      if (key === "command") {
        const matches = candidate.match(/(?:^|[\s"'=])((?:\.{0,2}\/|\/)[^\s"'<>|;&]+)/gu) ?? [];
        for (const match of matches) paths.push(match.trim().replace(/^[\s"'=]+/u, ""));
      } else if (/(^|_)(file_?path|path|notebook_?path|output_?path|destination|dest)$/iu.test(key)) {
        paths.push(candidate);
      }
      return;
    }
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item, key);
      return;
    }
    if (!isRecord(candidate)) return;
    for (const [childKey, child] of Object.entries(candidate)) visit(child, childKey);
  };
  visit(value);
  return paths;
}

function toolUses(content: unknown): Array<{ id: string; name: string; input: unknown }> {
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    if (
      !isRecord(block) ||
      block.type !== "tool_use" ||
      typeof block.id !== "string" ||
      typeof block.name !== "string"
    ) return [];
    return [{ id: block.id, name: block.name, input: block.input }];
  });
}

function toolResultExitCode(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of ["exitCode", "exit_code", "code"]) {
    const candidate = value[key];
    if (typeof candidate === "number" && Number.isInteger(candidate)) return candidate;
  }
  for (const child of Object.values(value)) {
    const nested = toolResultExitCode(child);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function toolResultMetadata(value: unknown, isError = false): Record<string, unknown> {
  let text: string;
  if (typeof value === "string") text = value;
  else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  const bytes = Buffer.byteLength(text, "utf8");
  const lineCount = text
    ? text.split(/\r?\n/u).length - (text.endsWith("\n") ? 1 : 0)
    : 0;
  const exitCode = toolResultExitCode(value);
  return {
    bodyOmitted: true,
    byteLength: bytes,
    lineCount,
    truncated: bytes > MAX_TOOL_RESULT_BYTES,
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(isError ? { isError: true } : {}),
  };
}

function toolResults(value: Record<string, unknown>): Array<{ id?: string; output: unknown }> {
  const message = isRecord(value.message) ? value.message : undefined;
  const blocks = message && Array.isArray(message.content) ? message.content : [];
  const results = blocks.flatMap((block) => (
    isRecord(block) && block.type === "tool_result"
      ? [{
          ...(typeof block.tool_use_id === "string" ? { id: block.tool_use_id } : {}),
          output: toolResultMetadata(block.content, block.is_error === true),
        }]
      : []
  ));
  const direct = value.toolUseResult ?? value.tool_use_result;
  if (results.length === 0 && direct !== undefined) {
    results.push({ output: toolResultMetadata(direct, value.is_error === true) });
  }
  return results;
}

function transcriptEvidenceNode(
  value: Record<string, unknown>,
  index: number,
): TranscriptEvidenceNode | undefined {
  if (typeof value.uuid !== "string" || !value.uuid) return undefined;
  const parentUuid = typeof value.parentUuid === "string" && value.parentUuid
    ? value.parentUuid
    : undefined;
  const type = value.type === "user" || value.type === "assistant"
    ? value.type
    : undefined;
  const message = isRecord(value.message) ? value.message : undefined;
  const parsedAt = typeof value.timestamp === "string" ? Date.parse(value.timestamp) : Number.NaN;
  const directToolResult = value.toolUseResult ?? value.tool_use_result;
  const text = message ? textFromContent(message.content) : "";
  const userPrompt = Boolean(
    type === "user" &&
    directToolResult === undefined &&
    value.isMeta !== true &&
    message &&
    !isClaudeTranscriptControlMessage("user", text),
  );
  const stopReason = message && typeof message.stop_reason === "string"
    ? message.stop_reason
    : undefined;
  return {
    index,
    uuid: value.uuid,
    ...(parentUuid ? { parentUuid } : {}),
    ...(type ? { type } : {}),
    createdAt: Number.isFinite(parsedAt) ? parsedAt : 0,
    userPrompt,
    completedBoundary: Boolean(
      type === "assistant" &&
      stopReason &&
      ["end_turn", "max_tokens", "stop_sequence", "refusal", "model_context_window_exceeded"]
        .includes(stopReason),
    ),
    tools: type === "assistant" && message ? toolUses(message.content) : [],
    results: type === "user" ? toolResults(value) : [],
  };
}

function evidenceTurns(
  nodes: Map<string, TranscriptEvidenceNode>,
): ClaudeTranscriptEvidenceTurn[] {
  const referencedParents = new Set(
    [...nodes.values()].flatMap((node) => node.parentUuid ? [node.parentUuid] : []),
  );
  const terminal = [...nodes.values()]
    .filter((node) => !referencedParents.has(node.uuid))
    .sort((left, right) => right.index - left.index)[0];
  if (!terminal) return [];
  const chain: TranscriptEvidenceNode[] = [];
  const seen = new Set<string>();
  let current: TranscriptEvidenceNode | undefined = terminal;
  while (current && !seen.has(current.uuid)) {
    seen.add(current.uuid);
    chain.push(current);
    current = current.parentUuid ? nodes.get(current.parentUuid) : undefined;
  }
  chain.reverse();

  const turns: ClaudeTranscriptEvidenceTurn[] = [];
  let turn: {
    id: string;
    startedAt: number;
    completedAt?: number;
    tools: ClaudeTranscriptToolEvidence[];
    paths: Set<string>;
  } | undefined;
  for (const node of chain) {
    if (node.userPrompt) {
      if (turn?.tools.length) {
        turns.push({
          id: turn.id,
          startedAt: turn.startedAt,
          completedAt: turn.completedAt ?? node.createdAt,
          tools: turn.tools,
          paths: [...turn.paths],
        });
      }
      turn = {
        id: node.uuid,
        startedAt: node.createdAt,
        tools: [],
        paths: new Set(),
      };
      continue;
    }
    if (!turn) continue;
    for (const tool of node.tools) {
      const existing = turn.tools.find((candidate) => candidate.id === tool.id);
      if (!existing) {
        turn.tools.push({
          id: tool.id,
          toolName: tool.name,
          input: tool.input,
          startedAt: node.createdAt,
        });
      }
      for (const candidate of evidencePaths(tool.input)) turn.paths.add(candidate);
    }
    if (node.completedBoundary) turn.completedAt = node.createdAt;
    for (const result of node.results) {
      let tool = result.id
        ? turn.tools.find((candidate) => candidate.id === result.id)
        : undefined;
      if (!tool && !result.id) {
        for (let toolIndex = turn.tools.length - 1; toolIndex >= 0; toolIndex -= 1) {
          if (turn.tools[toolIndex]?.output === undefined) {
            tool = turn.tools[toolIndex];
            break;
          }
        }
      }
      if (!tool) continue;
      tool.output = result.output;
      tool.completedAt = node.createdAt;
    }
  }
  if (turn?.tools.length) {
    turns.push({
      id: turn.id,
      startedAt: turn.startedAt,
      completedAt: turn.completedAt ?? turn.tools.at(-1)?.completedAt ?? turn.startedAt,
      tools: turn.tools,
      paths: [...turn.paths],
    });
  }
  return turns.filter((candidate) => candidate.tools.some((tool) => tool.completedAt));
}

export class ClaudeTranscriptEvidenceCursor {
  private identity = "";
  private offset = 0;
  private pending = Buffer.alloc(0);
  private readonly nodes = new Map<string, TranscriptEvidenceNode>();
  private index = 0;

  async read(path: string): Promise<ClaudeTranscriptEvidenceTurn[]> {
    let metadata;
    try {
      metadata = await stat(path);
    } catch {
      return [];
    }
    const identity = `${metadata.dev}:${metadata.ino}`;
    if (this.identity !== identity || metadata.size < this.offset) {
      this.identity = identity;
      this.offset = 0;
      this.pending = Buffer.alloc(0);
      this.nodes.clear();
      this.index = 0;
    }
    if (metadata.size > this.offset) {
      const chunks: Buffer[] = [];
      for await (const chunk of createReadStream(path, {
        start: this.offset,
        end: metadata.size - 1,
      })) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      this.offset = metadata.size;
      const bytes = Buffer.concat([this.pending, ...chunks]);
      let start = 0;
      for (let cursor = 0; cursor < bytes.byteLength; cursor += 1) {
        if (bytes[cursor] !== 0x0a) continue;
        this.acceptLine(bytes.subarray(start, cursor).toString("utf8"));
        start = cursor + 1;
      }
      this.pending = bytes.subarray(start);
      if (this.pending.byteLength > 0) {
        const tail = this.pending.toString("utf8");
        try {
          const parsed = JSON.parse(tail) as unknown;
          if (isRecord(parsed)) {
            this.acceptValue(parsed);
            this.pending = Buffer.alloc(0);
          }
        } catch {
          // Keep an incomplete final record until the next append.
        }
      }
    }
    return evidenceTurns(this.nodes);
  }

  private acceptLine(line: string): void {
    if (!line.trim()) return;
    try {
      const value = JSON.parse(line) as unknown;
      if (isRecord(value)) this.acceptValue(value);
    } catch {
      // A malformed or interrupted record is isolated to this line.
    }
  }

  private acceptValue(value: Record<string, unknown>): void {
    const node = transcriptEvidenceNode(value, ++this.index);
    if (node) this.nodes.set(node.uuid, node);
  }
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
  if (
    value.type === "user" &&
    (value.toolUseResult !== undefined || value.tool_use_result !== undefined || value.isMeta === true)
  ) return undefined;
  const text = textFromContent(value.message.content);
  if (!text) return undefined;
  const role = value.type;
  const cleaned = role === "user" ? cleanUserText(text) : text.trim();
  const syntheticFailure = role === "assistant" &&
    value.message.model === "<synthetic>" &&
    (
      value.message.stop_reason === "model_context_window_exceeded" ||
      /^(?:Prompt is too long|API Error:|Error:)/iu.test(cleaned)
    );
  if (syntheticFailure) return undefined;
  if (!cleaned || isClaudeTranscriptControlMessage(role, cleaned)) return undefined;
  return { role, text: cleaned };
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

export interface ClaudeTranscriptSnapshot extends ClaudeHistoryReadResult {
  nextCursor?: string;
  userMessages: ClaudeHistoryMessage[];
  atTurnBoundary?: boolean;
}

function transcriptTurnBoundary<T extends TranscriptTurnNode>(
  nodes: ReadonlyMap<string, T>,
  terminal: T,
): boolean {
  let current: T | undefined = terminal;
  const seen = new Set<string>();
  while (current && !seen.has(current.uuid)) {
    seen.add(current.uuid);
    if (current.type === "user") return current.interruptedBoundary === true;
    if (current.type === "assistant") {
      return [
        "end_turn",
        "max_tokens",
        "stop_sequence",
        "refusal",
        "model_context_window_exceeded",
      ].includes(current.stopReason ?? "");
    }
    current = current.parentUuid ? nodes.get(current.parentUuid) : undefined;
  }
  return false;
}

export async function parseClaudeTranscriptSnapshot(
  path: string,
  options: ClaudeHistoryReadOptions = {},
  userLimit = 200,
): Promise<ClaudeTranscriptSnapshot> {
  const nodes = new Map<string, TranscriptNode>();
  const referencedParents = new Set<string>();
  const userMessages: ClaudeHistoryMessage[] = [];
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
      const message = isRecord(value.message) ? value.message : undefined;
      const rawText = message ? textFromContent(message.content) : "";
      const parsedAt = typeof value.timestamp === "string" ? Date.parse(value.timestamp) : Number.NaN;
      const createdAt = Number.isFinite(parsedAt) ? parsedAt : 0;
      nodes.set(value.uuid, {
        index,
        uuid: value.uuid,
        ...(parentUuid ? { parentUuid } : {}),
        ...(value.type === "user" || value.type === "assistant" ? { type: value.type } : {}),
        ...(value.type === "user" && isClaudeTranscriptControlMessage("user", rawText)
          ? { interruptedBoundary: true }
          : {}),
        ...(message && typeof message.stop_reason === "string"
          ? { stopReason: message.stop_reason }
          : {}),
        ...(visible?.role ? { role: visible.role } : {}),
        ...(visible?.text ? { text: visible.text } : {}),
        createdAt,
      });
      if (visible?.role === "user" && visible.text) {
        userMessages.push({
          id: value.uuid,
          role: "user",
          text: clipText(visible.text, MAX_MESSAGE_TEXT_BYTES).text,
          createdAt,
        });
        if (userMessages.length > userLimit) userMessages.shift();
      }
    }
  } catch {
    return { available: false, messages: [], truncated: false, userMessages: [] };
  }

  const terminal = [...nodes.values()]
    .filter((node) => !referencedParents.has(node.uuid))
    .sort((left, right) => right.index - left.index)[0];
  if (!terminal) return { available: true, messages: [], truncated: false, userMessages };
  const atTurnBoundary = transcriptTurnBoundary(nodes, terminal);

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
  return {
    available: true,
    ...trimHistory(messages, options),
    userMessages,
    atTurnBoundary,
  };
}

export async function parseClaudeTranscriptEvidence(
  path: string,
): Promise<ClaudeTranscriptEvidenceTurn[]> {
  return new ClaudeTranscriptEvidenceCursor().read(path);
}

export async function parseClaudeTranscript(
  path: string,
  options: ClaudeHistoryReadOptions = {},
): Promise<ClaudeHistoryReadResult & { nextCursor?: string }> {
  const {
    userMessages: _userMessages,
    atTurnBoundary: _atTurnBoundary,
    ...result
  } = await parseClaudeTranscriptSnapshot(path, options);
  return result;
}

export async function readClaudeTranscriptUserMessages(
  path: string,
  limit = 200,
): Promise<ClaudeHistoryMessage[]> {
  return (await parseClaudeTranscriptSnapshot(path, {}, limit)).userMessages;
}

export async function isClaudeTranscriptAtTurnBoundary(path: string): Promise<boolean> {
  const nodes = new Map<string, TranscriptTurnNode>();
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
      const message = isRecord(value.message) ? value.message : undefined;
      const text = message ? textFromContent(message.content) : "";
      nodes.set(value.uuid, {
        index,
        uuid: value.uuid,
        ...(parentUuid ? { parentUuid } : {}),
        ...(value.type === "user" || value.type === "assistant" ? { type: value.type } : {}),
        ...(value.type === "user" && isClaudeTranscriptControlMessage("user", text)
          ? { interruptedBoundary: true }
          : {}),
        ...(message && typeof message.stop_reason === "string"
          ? { stopReason: message.stop_reason }
          : {}),
      });
    }
  } catch {
    return false;
  }

  const terminal = [...nodes.values()]
    .filter((node) => !referencedParents.has(node.uuid))
    .sort((left, right) => right.index - left.index)[0];
  return terminal ? transcriptTurnBoundary(nodes, terminal) : false;
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

export async function readClaudeSessionContextEstimate(
  projectsRoot: string,
  sessionId: string,
  cwd?: string,
): Promise<ClaudeSessionContextEstimate | undefined> {
  const path = await findClaudeTranscriptFile(projectsRoot, sessionId, cwd);
  if (!path) return undefined;
  let latest: ClaudeSessionContextEstimate | undefined;
  try {
    const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of lines) {
      let value: unknown;
      try {
        value = JSON.parse(line) as unknown;
      } catch {
        continue;
      }
      if (!isRecord(value) || value.type !== "assistant" || !isRecord(value.message)) continue;
      const usage = value.message.usage;
      if (!isRecord(usage)) continue;
      const inputTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
      const cacheReadTokens = typeof usage.cache_read_input_tokens === "number"
        ? usage.cache_read_input_tokens
        : 0;
      const cacheCreationTokens = typeof usage.cache_creation_input_tokens === "number"
        ? usage.cache_creation_input_tokens
        : 0;
      const totalTokens = inputTokens + cacheReadTokens + cacheCreationTokens;
      if (!Number.isFinite(totalTokens) || totalTokens <= 0) continue;
      latest = {
        totalTokens,
        ...(typeof value.message.model === "string" && value.message.model
          ? { model: value.message.model }
          : {}),
      };
    }
  } catch {
    return undefined;
  }
  return latest;
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
