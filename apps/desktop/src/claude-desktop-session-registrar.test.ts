import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ClaudeDesktopSessionRegistrar,
  parseClaudeDesktopProfiles,
  parseWindowsClaudeDesktopProfiles,
} from "./claude-desktop-session-registrar.js";
import type { ClaudeRuntimePaths } from "./platform.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, {
      recursive: true,
      force: true,
    })),
  );
});

async function fixture(): Promise<{
  root: string;
  paths: ClaudeRuntimePaths;
  profileRoot: string;
  accountDir: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "bridge-desktop-register-"));
  directories.push(root);
  const projects = join(root, ".claude", "projects");
  const profileRoot = join(root, "Claude-active", "claude-code-sessions");
  const accountDir = join(profileRoot, randomUUID(), randomUUID());
  await mkdir(accountDir, { recursive: true });
  await mkdir(projects, { recursive: true });
  await writeFile(join(accountDir, `local_${randomUUID()}.json`), JSON.stringify({
    sessionId: `local_${randomUUID()}`,
    cliSessionId: randomUUID(),
    cwd: root,
    title: "Existing",
    titleSource: "auto",
    createdAt: 1,
    lastActivityAt: 2,
  }), "utf8");
  return {
    root,
    profileRoot,
    accountDir,
    paths: {
      sessions: join(root, ".claude", "sessions"),
      tasks: join(root, ".claude", "tasks"),
      projects,
      desktopSessions: [profileRoot],
    },
  };
}

async function transcript(
  paths: ClaudeRuntimePaths,
  sessionId: string,
  cwd: string,
): Promise<string> {
  const path = join(paths.projects, "project", `${sessionId}.jsonl`);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, [
    JSON.stringify({
      type: "user",
      sessionId,
      cwd,
      timestamp: "2026-07-27T01:00:00.000Z",
      message: { role: "user", content: "hello" },
    }),
    "",
  ].join("\n"), "utf8");
  return path;
}

describe("parseClaudeDesktopProfiles", () => {
  it("maps helper user-data directories to their Claude main process", () => {
    const output = [
      "  100     1 /Applications/Claude.app/Contents/MacOS/Claude",
      "  101   100 /Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper --type=gpu-process --user-data-dir=/Users/me/Library/Application Support/Claude-3p --lang=en",
      "  200     1 /Applications/Other.app/Contents/MacOS/Other",
      "  201   200 /Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper --user-data-dir=/tmp/not-claude --type=renderer",
    ].join("\n");

    expect(parseClaudeDesktopProfiles(output)).toEqual([{
      pid: 100,
      userDataDir: "/Users/me/Library/Application Support/Claude-3p",
    }]);
  });

  it("maps Windows Claude Helper processes to their Claude.exe profile", () => {
    const output = JSON.stringify([
      {
        ProcessId: 400,
        ParentProcessId: 1,
        Name: "Claude.exe",
        CommandLine: '"C:\\Users\\me\\AppData\\Local\\Programs\\Claude\\Claude.exe"',
      },
      {
        ProcessId: 401,
        ParentProcessId: 400,
        Name: "Claude Helper.exe",
        CommandLine: '"C:\\Users\\me\\AppData\\Local\\Programs\\Claude\\Claude Helper.exe" --type=renderer --user-data-dir="C:\\Users\\me\\AppData\\Roaming\\Claude"',
      },
    ]);

    expect(parseWindowsClaudeDesktopProfiles(output)).toEqual([{
      pid: 400,
      userDataDir: "C:\\Users\\me\\AppData\\Roaming\\Claude",
    }]);
  });
});

describe("ClaudeDesktopSessionRegistrar", () => {
  it("waits for the first trusted transcript before writing metadata", async () => {
    const { paths, profileRoot } = await fixture();
    const sessionId = randomUUID();
    const registrar = new ClaudeDesktopSessionRegistrar({
      paths,
      platform: "darwin",
      listProfiles: async () => [{ pid: 10, userDataDir: join(profileRoot, "..") }],
      findTranscript: async () => undefined,
      now: () => 10,
    });

    await expect(registrar.register({
      sessionId,
      cwd: paths.projects,
      title: "Bridge task",
      createdAt: 1,
      lastActivityAt: 2,
    })).resolves.toMatchObject({
      state: "waiting-transcript",
      updatedAt: 10,
    });
  });

  it("writes deterministic metadata once and marks it registered after restart", async () => {
    const { paths, profileRoot, accountDir, root } = await fixture();
    const sessionId = randomUUID();
    const transcriptPath = await transcript(paths, sessionId, root);
    let pid = 20;
    let now = 100;
    const registrar = new ClaudeDesktopSessionRegistrar({
      paths,
      platform: "darwin",
      listProfiles: async () => [{ pid, userDataDir: join(profileRoot, "..") }],
      findTranscript: async () => transcriptPath,
      now: () => now,
    });
    const input = {
      sessionId,
      cwd: root,
      title: "Bridge task",
      createdAt: 1,
      lastActivityAt: 2,
      model: "claude-fable-5",
      effort: "high" as const,
    };

    const first = await registrar.register(input);
    expect(first).toMatchObject({
      state: "restart-required",
      desktopSessionId: `local_${sessionId}`,
      claudePidAtRegistration: 20,
      registeredAt: 100,
    });
    const metadataPath = join(accountDir, `local_${sessionId}.json`);
    const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as Record<string, unknown>;
    expect(metadata).toMatchObject({
      sessionId: `local_${sessionId}`,
      cliSessionId: sessionId,
      cwd: root,
      originCwd: root,
      title: "Bridge task",
      titleSource: "custom",
      model: "claude-fable-5",
      effort: "high",
      isArchived: false,
    });
    expect((await stat(metadataPath)).mode & 0o777).toBe(0o600);

    now = 200;
    const unchanged = await registrar.register(input, first);
    expect(unchanged).toEqual(first);

    pid = 21;
    const registered = await registrar.register(input, first);
    expect(registered).toMatchObject({
      state: "registered",
      desktopSessionId: `local_${sessionId}`,
      updatedAt: 200,
    });
    expect(registered.claudePidAtRegistration).toBeUndefined();
    expect(await registrar.removeOwned(sessionId, registered)).toBe(true);
    await expect(access(metadataPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed when the active profile has multiple account directories", async () => {
    const { paths, profileRoot, root } = await fixture();
    const second = join(profileRoot, randomUUID(), randomUUID());
    await mkdir(second, { recursive: true });
    await writeFile(join(second, `local_${randomUUID()}.json`), JSON.stringify({
      sessionId: `local_${randomUUID()}`,
      cliSessionId: randomUUID(),
      cwd: root,
      title: "Second",
      titleSource: "auto",
      createdAt: 1,
      lastActivityAt: 2,
    }), "utf8");
    const sessionId = randomUUID();
    const transcriptPath = await transcript(paths, sessionId, root);
    const registrar = new ClaudeDesktopSessionRegistrar({
      paths,
      platform: "darwin",
      listProfiles: async () => [{ pid: 30, userDataDir: join(profileRoot, "..") }],
      findTranscript: async () => transcriptPath,
      now: () => 300,
    });

    await expect(registrar.register({
      sessionId,
      cwd: root,
      title: "Bridge task",
      createdAt: 1,
      lastActivityAt: 2,
    })).resolves.toMatchObject({
      state: "unavailable",
      detail: expect.stringContaining("多个账号"),
    });
  });

  it("does not overwrite a conflicting deterministic metadata file", async () => {
    const { paths, profileRoot, accountDir, root } = await fixture();
    const sessionId = randomUUID();
    const transcriptPath = await transcript(paths, sessionId, root);
    await writeFile(join(accountDir, `local_${sessionId}.json`), JSON.stringify({
      sessionId: `local_${sessionId}`,
      cliSessionId: randomUUID(),
      cwd: root,
    }), "utf8");
    const registrar = new ClaudeDesktopSessionRegistrar({
      paths,
      platform: "darwin",
      listProfiles: async () => [{ pid: 40, userDataDir: join(profileRoot, "..") }],
      findTranscript: async () => transcriptPath,
    });

    await expect(registrar.register({
      sessionId,
      cwd: root,
      title: "Bridge task",
      createdAt: 1,
      lastActivityAt: 2,
    })).rejects.toThrow("指向其他 transcript");
  });

  it("ignores a persisted metadata path outside configured Claude roots", async () => {
    const { paths, profileRoot, accountDir, root } = await fixture();
    const sessionId = randomUUID();
    const transcriptPath = await transcript(paths, sessionId, root);
    const outside = join(root, `local_${sessionId}.json`);
    await writeFile(outside, JSON.stringify({
      sessionId: `local_${sessionId}`,
      cliSessionId: sessionId,
      cwd: root,
    }), "utf8");
    const registrar = new ClaudeDesktopSessionRegistrar({
      paths,
      platform: "darwin",
      listProfiles: async () => [{ pid: 50, userDataDir: join(profileRoot, "..") }],
      findTranscript: async () => transcriptPath,
      now: () => 500,
    });

    const result = await registrar.register({
      sessionId,
      cwd: root,
      title: "Bridge task",
      createdAt: 1,
      lastActivityAt: 2,
    }, {
      state: "restart-required",
      detail: "untrusted",
      updatedAt: 1,
      desktopSessionId: `local_${sessionId}`,
      metadataPath: outside,
      profileSessionsRoot: profileRoot,
      claudePidAtRegistration: 50,
    });

    expect(result.metadataPath).toBe(join(
      await realpath(accountDir),
      `local_${sessionId}.json`,
    ));
    expect(result.state).toBe("restart-required");
    await expect(readFile(outside, "utf8")).resolves.toContain(sessionId);
  });
});
