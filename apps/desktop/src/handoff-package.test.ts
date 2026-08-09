import { describe, expect, it } from "vitest";
import {
  EXECUTABLE_PROMPT_LIMIT,
  compact,
  extractConstraints,
  extractLatestGoal,
  handoffContextBlock,
  normalizeConversation,
  packageHash,
  redact,
} from "./handoff-package.js";

describe("handoff-package shared helpers", () => {
  it("compacts whitespace and bounds length", () => {
    expect(compact("  多  行\n文本  ", 100)).toBe("多 行 文本");
    expect(compact("x".repeat(100), 10)).toHaveLength(10);
  });

  it("redacts credentials and paths outside the project", () => {
    const cwd = "/Users/me/project";
    expect(redact("token sk-ant-abc12345678", cwd)).toContain("[REDACTED_API_KEY]");
    const auth = redact("Authorization: Bearer abcdefghijkl", cwd);
    expect(auth).not.toContain("abcdefghijkl");
    expect(auth).toContain("[REDACTED]");
    expect(redact("api_key=supersecretvalue", cwd)).toBe("api_key=[REDACTED]");
    expect(redact("读 /etc/passwd 和 /Users/me/project/src/a.ts", cwd)).toBe(
      "读 [OUTSIDE_PROJECT_PATH] 和 /Users/me/project/src/a.ts",
    );
  });

  it("normalizes conversation windows with per-item limits", () => {
    const items: Array<{ role: "user" | "assistant" | "tool" | "system"; text: string; createdAt: number }> = Array.from({ length: 40 }, (_, index) => ({
      role: index % 2 ? "assistant" : "user",
      text: `消息 ${index} ${"长".repeat(3_000)}`,
      createdAt: index,
    }));
    items.push({ role: "tool", text: "tool output", createdAt: 100 });
    const normalized = normalizeConversation(items, "/project");
    expect(normalized).toHaveLength(24);
    expect(normalized.every((item) => item.text.length <= 2_000)).toBe(true);
    expect(normalized.some((item) => item.role === "tool")).toBe(false);
  });

  it("extracts goals and constraints from visible conversation", () => {
    const entries = [
      { role: "user" as const, text: "先做个原型", createdAt: 1 },
      { role: "assistant" as const, text: "好的", createdAt: 2 },
      { role: "user" as const, text: "不要改数据库结构，必须保留旧接口", createdAt: 3 },
    ];
    expect(extractLatestGoal(entries, [undefined, "标题"])).toBe("不要改数据库结构，必须保留旧接口");
    expect(extractLatestGoal([], ["摘要"])).toBe("摘要");
    expect(extractLatestGoal([], [undefined])).toBe("继续当前可见任务");
    expect(extractConstraints(entries)).toHaveLength(1);
  });

  it("builds a context block within the executable prompt limit", () => {
    const block = handoffContextBlock({
      handoffId: "h1",
      objective: "目标",
      constraints: ["约束一"],
      incompleteItems: ["未完成一"],
      recentConversation: [{ role: "user", text: "历史", createdAt: 1 }],
      toolsAndCommands: ["Bash: ls"],
      artifacts: [{ path: "src/a.ts", change: "modified", size: 10, sha256: "abc" }],
      workspace: { cwd: "/project", gitBranch: "main", gitHead: "deadbeef", dirty: true, changedFiles: ["src/a.ts"] },
      sourceEventSeq: 7,
      integrityHash: packageHash("probe"),
    });
    expect(block).toContain("目标");
    expect(block).toContain("约束一");
    expect(block).toContain("未完成一");
    expect(block).toContain("src/a.ts");
    expect(block.length).toBeLessThanOrEqual(EXECUTABLE_PROMPT_LIMIT);
  });
});
