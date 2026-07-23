import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findClaudeDesktopSessionId, listClaudeDesktopSessions } from "./claude-desktop-sessions.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Claude Desktop session catalog", () => {
  it("reads session metadata without opening or controlling Claude", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-desktop-session-"));
    directories.push(root);
    const nested = join(root, "profile", "project");
    await mkdir(nested, { recursive: true });
    await Promise.all([
      writeFile(join(nested, "local_old.json"), JSON.stringify({
        sessionId: "local_old",
        cliSessionId: "cli-session",
        cwd: "/work/project",
        lastFocusedAt: 100,
      })),
      writeFile(join(nested, "local_current.json"), JSON.stringify({
        sessionId: "local_current",
        cliSessionId: "cli-session",
        cwd: "/work/project",
        lastFocusedAt: 200,
      })),
    ]);

    await expect(findClaudeDesktopSessionId([root], "cli-session")).resolves.toBe("local_current");
    await expect(listClaudeDesktopSessions([root])).resolves.toHaveLength(2);
  });
});
