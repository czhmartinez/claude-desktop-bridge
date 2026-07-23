import { chmod, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildClaudeCommandArgs,
  buildClaudeWorkerEnvironment,
  applyClaudeHostCredentials,
  findClaudeHostCredentials,
  hasClaudeTransportAuthentication,
} from "./claude-background-worker.js";

describe("Claude background worker", () => {
  it("uses non-interactive Claude Code with an isolated fork for a live source session", () => {
    const args = buildClaudeCommandArgs({
      commandId: "command-1",
      text: "继续完成测试",
      sourceSessionId: "source-session",
      resumeSessionId: "source-session",
      cwd: "/work/project",
      projectName: "project",
      forkSession: true,
    });

    expect(args).toEqual([
      "-p",
      "继续完成测试",
      "--output-format", "json",
      "--permission-mode", "acceptEdits",
      "--resume", "source-session",
      "--fork-session",
    ]);
    expect(args.join(" ")).not.toMatch(/osascript|open claude:|clipboard|paste/iu);
  });

  it("keeps inherited credentials but removes Claude Code's nested-session guard", () => {
    const environment = buildClaudeWorkerEnvironment({
      CLAUDECODE: "1",
      CLAUDE_CODE_HOST_CREDS_FILE: "/private/credentials",
    });

    expect(environment.CLAUDECODE).toBeUndefined();
    expect(environment.CLAUDE_CODE_HOST_CREDS_FILE).toBe("/private/credentials");
    expect(environment.CLAUDE_CODE_ENTRYPOINT).toBe("claude-bridge");
    expect(environment.BRIDGE_BACKGROUND_WORKER).toBe("1");
  });

  it("discovers the newest protected Claude host credential path without parsing its contents", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-host-creds-"));
    const older = join(root, "host-creds-older.json");
    const newer = join(root, "host-creds-newer.json");
    await Promise.all([
      writeFile(older, "not-json-and-never-opened-by-bridge"),
      writeFile(newer, "also-not-json-and-never-opened-by-bridge"),
    ]);
    await Promise.all([chmod(older, 0o600), chmod(newer, 0o600)]);
    await utimes(older, new Date(1_000), new Date(1_000));
    await utimes(newer, new Date(2_000), new Date(2_000));

    expect(await findClaudeHostCredentials({}, tmpdir(), [root])).toBe(newer);
    const environment: NodeJS.ProcessEnv = {};
    applyClaudeHostCredentials(environment, newer);
    expect(environment).toEqual(expect.objectContaining({
      CLAUDE_CODE_HOST_CREDS_FILE: newer,
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1",
      CLAUDE_CODE_HOST_AUTH_ENV_VAR: "ANTHROPIC_AUTH_TOKEN",
      CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH: "1",
    }));
    expect(await hasClaudeTransportAuthentication(environment)).toBe(true);
  });

  it("does not fall back to an official Claude OAuth login", async () => {
    expect(await hasClaudeTransportAuthentication({ CLAUDE_CODE_OAUTH_TOKEN: "official-oauth" })).toBe(false);
    expect(await hasClaudeTransportAuthentication({ ANTHROPIC_AUTH_TOKEN: "third-party-token" })).toBe(true);
  });
});
