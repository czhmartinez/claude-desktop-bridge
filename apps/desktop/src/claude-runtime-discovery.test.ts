import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findClaudeHostCredentials,
  findClaudeExecutable,
  isSafeForBackgroundRuntimeScan,
  prepareClaudeRuntime,
} from "./claude-runtime-discovery.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

describe("Claude runtime discovery privacy", () => {
  it("does not automatically probe macOS privacy-protected user folders", () => {
    if (process.platform === "win32") return;
    const home = "/Users/test";
    expect(isSafeForBackgroundRuntimeScan("/usr/local/bin/claude", home, "darwin")).toBe(true);
    expect(isSafeForBackgroundRuntimeScan("/Users/test/.local/bin/claude", home, "darwin")).toBe(true);
    expect(isSafeForBackgroundRuntimeScan("/Users/test/Documents/tools/claude", home, "darwin")).toBe(false);
    expect(isSafeForBackgroundRuntimeScan("/Users/test/Desktop/claude", home, "darwin")).toBe(false);
    expect(isSafeForBackgroundRuntimeScan("/Volumes/External/claude", home, "darwin")).toBe(false);
    expect(isSafeForBackgroundRuntimeScan("/Users/test/Documents/tools/claude", home, "linux")).toBe(true);
  });

  it("skips protected PATH entries but honors an explicitly configured executable", async () => {
    if (process.platform !== "darwin") return;
    const home = await mkdtemp(join(tmpdir(), "bridge-runtime-home-"));
    directories.push(home);
    const executable = join(home, "Documents", "tools", "claude");
    await mkdir(join(home, "Documents", "tools"), { recursive: true });
    await writeFile(executable, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(executable, 0o755);

    await expect(findClaudeExecutable({ PATH: join(home, "Documents", "tools") }, home))
      .resolves.toBeUndefined();
    await expect(findClaudeExecutable({
      PATH: join(home, "Documents", "tools"),
      BRIDGE_CLAUDE_PATH: executable,
    }, home)).resolves.toBe(executable);
  });

  it("runs the automatic version probe from home instead of the app launch directory", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(join(tmpdir(), "bridge-runtime-version-"));
    directories.push(root);
    const cwdReport = join(root, "cwd.txt");
    const executable = join(root, "claude");
    await writeFile(
      executable,
      `#!/bin/sh\npwd > ${JSON.stringify(cwdReport)}\necho bridge-test\n`,
      "utf8",
    );
    await chmod(executable, 0o755);

    await expect(prepareClaudeRuntime({
      PATH: "",
      BRIDGE_CLAUDE_PATH: executable,
    })).resolves.toMatchObject({
      executablePath: executable,
      version: "bridge-test",
    });
    await expect(readFile(cwdReport, "utf8")).resolves.toBe(`${homedir()}\n`);
  });

  it("discovers Windows CLI shims from a Windows-style PATH", async () => {
    const home = await mkdtemp(join(tmpdir(), "bridge-runtime-windows-"));
    directories.push(home);
    const bin = join(home, "bin");
    const executable = join(bin, "claude.cmd");
    await mkdir(bin, { recursive: true });
    await writeFile(executable, "@echo off\r\necho bridge-windows\r\n", "utf8");

    await expect(findClaudeExecutable({ PATH: bin }, home, "win32"))
      .resolves.toBe(executable);
  });

  it("finds the newest Windows Host Credentials file under roaming AppData", async () => {
    const home = await mkdtemp(join(tmpdir(), "bridge-credentials-windows-"));
    directories.push(home);
    const appData = join(home, "AppData", "Roaming");
    const root = join(appData, "Claude-3p");
    const credential = join(root, "host-creds-windows.json");
    await mkdir(root, { recursive: true });
    await writeFile(credential, "{}\n", "utf8");

    await expect(findClaudeHostCredentials({ APPDATA: appData }, home, undefined, "win32"))
      .resolves.toBe(credential);
  });
});
