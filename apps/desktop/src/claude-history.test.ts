import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findClaudeTranscriptFile,
  parseClaudeTranscript,
  readClaudeSessionContextEstimate,
  readClaudeSessionHistory,
} from "./claude-history.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function line(value: Record<string, unknown>): string {
  return JSON.stringify({ sessionId: "session-1", timestamp: "2026-07-22T10:00:00.000Z", ...value });
}

describe("Claude transcript history", () => {
  it("rebuilds the latest branch and keeps only visible user and assistant text", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-claude-history-"));
    directories.push(root);
    const projects = join(root, "projects");
    const project = join(projects, "-work-ega-pms");
    const transcript = join(project, "session-1.jsonl");
    await mkdir(project, { recursive: true });
    await writeFile(transcript, [
      line({ type: "user", uuid: "user-1", parentUuid: null, message: { role: "user", content: "先检查当前实现" } }),
      line({ type: "assistant", uuid: "abandoned", parentUuid: "user-1", message: { role: "assistant", content: [{ type: "text", text: "旧分支" }] } }),
      line({ type: "assistant", uuid: "thinking-1", parentUuid: "user-1", message: { role: "assistant", content: [{ type: "thinking", thinking: "private" }] } }),
      line({ type: "assistant", uuid: "assistant-1", parentUuid: "thinking-1", message: { role: "assistant", content: [{ type: "text", text: "我先读取项目。" }] } }),
      line({ type: "assistant", uuid: "tool-1", parentUuid: "assistant-1", message: { role: "assistant", content: [{ type: "tool_use", name: "Read" }] } }),
      line({ type: "user", uuid: "result-1", parentUuid: "tool-1", toolUseResult: { ok: true }, message: { role: "user", content: [{ type: "tool_result", content: "secret tool output" }] } }),
      line({ type: "assistant", uuid: "assistant-2", parentUuid: "result-1", message: { role: "assistant", content: [{ type: "text", text: "已经定位问题。" }] } }),
      line({ type: "user", uuid: "user-2", parentUuid: "assistant-2", message: { role: "user", content: "[来自手机 Bridge]\n\n继续修复\n\n<!-- bridge-command:phone-1 -->" } }),
      line({ type: "assistant", uuid: "assistant-3", parentUuid: "user-2", message: { role: "assistant", content: [{ type: "text", text: "修复完成。" }] } }),
    ].join("\n"), "utf8");

    expect(await findClaudeTranscriptFile(projects, "session-1", "/work/ega-pms")).toBe(transcript);
    expect(await parseClaudeTranscript(transcript)).toEqual({
      available: true,
      truncated: false,
      messages: [
        expect.objectContaining({ id: "user-1", role: "user", text: "先检查当前实现" }),
        expect.objectContaining({ id: "assistant-1", role: "assistant", text: "我先读取项目。\n\n已经定位问题。" }),
        expect.objectContaining({ id: "user-2", role: "user", text: "继续修复" }),
        expect.objectContaining({ id: "assistant-3", role: "assistant", text: "修复完成。" }),
      ],
    });
  });

  it("reports a missing local transcript without exposing another file", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-claude-history-missing-"));
    directories.push(root);
    expect(await readClaudeSessionHistory(join(root, "projects"), "../settings", "/work/demo")).toEqual({
      available: false,
      messages: [],
      truncated: false,
    });
  });

  it("caps large histories below the encrypted relay frame budget", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-claude-history-large-"));
    directories.push(root);
    const transcript = join(root, "large.jsonl");
    await writeFile(transcript, [
      line({ type: "user", uuid: "user-large", parentUuid: null, message: { role: "user", content: "检查长回复" } }),
      line({ type: "assistant", uuid: "assistant-large", parentUuid: "user-large", message: { role: "assistant", content: [{ type: "text", text: "长".repeat(20_000) }] } }),
    ].join("\n"), "utf8");

    const result = await parseClaudeTranscript(transcript);
    expect(result.available).toBe(true);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(60 * 1024);
    expect(result.messages.at(-1)?.text).toContain("已省略中间部分");
  });

  it("pages backward by the visible message cursor", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-claude-history-pages-"));
    directories.push(root);
    const transcript = join(root, "pages.jsonl");
    const rows: string[] = [];
    let parentUuid: string | null = null;
    for (let index = 0; index < 8; index += 1) {
      const uuid = `message-${index}`;
      const role = index % 2 === 0 ? "user" : "assistant";
      rows.push(line({
        type: role,
        uuid,
        parentUuid,
        timestamp: new Date(Date.UTC(2026, 6, 22, 10, 0, index)).toISOString(),
        message: { role, content: `Message ${index}` },
      }));
      parentUuid = uuid;
    }
    await writeFile(transcript, rows.join("\n"), "utf8");

    const newest = await parseClaudeTranscript(transcript, { limit: 4 });
    expect(newest.messages.map((message) => message.id))
      .toEqual(["message-4", "message-5", "message-6", "message-7"]);
    const older = await parseClaudeTranscript(transcript, {
      limit: 4,
      before: {
        createdAt: newest.messages[0]!.createdAt,
        id: newest.messages[0]!.id,
      },
    });
    expect(older.messages.map((message) => message.id))
      .toEqual(["message-0", "message-1", "message-2", "message-3"]);
  });

  it("reads the latest context usage without loading message bodies into memory", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-claude-context-"));
    directories.push(root);
    const projects = join(root, "projects");
    const project = join(projects, "-work-demo");
    const transcript = join(project, "session-1.jsonl");
    await mkdir(project, { recursive: true });
    await writeFile(transcript, [
      line({
        type: "assistant",
        uuid: "assistant-1",
        message: {
          role: "assistant",
          model: "wire-model",
          content: "first",
          usage: {
            input_tokens: 100,
            cache_read_input_tokens: 270_000,
            cache_creation_input_tokens: 1_000,
          },
        },
      }),
      line({
        type: "assistant",
        uuid: "assistant-2",
        message: {
          role: "assistant",
          model: "wire-model",
          content: "after compact",
          usage: {
            input_tokens: 500,
            cache_read_input_tokens: 80_000,
            cache_creation_input_tokens: 500,
          },
        },
      }),
    ].join("\n"), "utf8");

    await expect(readClaudeSessionContextEstimate(projects, "session-1", "/work/demo")).resolves.toEqual({
      totalTokens: 81_000,
      model: "wire-model",
    });
  });
});
