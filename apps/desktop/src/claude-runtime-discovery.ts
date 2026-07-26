import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function pathIsWithin(root: string, candidate: string): boolean {
  const relation = relative(resolve(root), resolve(candidate));
  return relation === "" || (
    relation !== ".." &&
    !relation.startsWith(`..${sep}`) &&
    !isAbsolute(relation)
  );
}

/**
 * PATH is ambient process state, not an explicit project selection. Avoid
 * probing privacy-protected folders while Bridge is only looking for a CLI.
 */
export function isSafeForBackgroundRuntimeScan(
  candidate: string,
  home = homedir(),
  platform = process.platform,
): boolean {
  if (platform !== "darwin") return true;
  const protectedRoots = [
    join(home, "Desktop"),
    join(home, "Documents"),
    join(home, "Downloads"),
    join(home, "Movies"),
    join(home, "Music"),
    join(home, "Pictures"),
    join(home, "Library", "CloudStorage"),
    join(home, "Library", "Mobile Documents"),
    "/Volumes",
  ];
  return !protectedRoots.some((root) => pathIsWithin(root, candidate));
}

async function isExecutable(path: string): Promise<boolean> {
  return access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK)
    .then(() => true, () => false);
}

function credentialRoots(home: string, environment: NodeJS.ProcessEnv): string[] {
  if (process.platform === "darwin") {
    return [
      join(home, "Library", "Application Support", "Claude-3p"),
      join(home, "Library", "Application Support", "Claude"),
    ];
  }
  if (process.platform === "win32") {
    const appData = environment.APPDATA ?? join(home, "AppData", "Roaming");
    return [join(appData, "Claude-3p"), join(appData, "Claude")];
  }
  const configHome = environment.XDG_CONFIG_HOME ?? join(home, ".config");
  return [join(configHome, "Claude-3p"), join(configHome, "Claude")];
}

async function protectedCredential(path: string): Promise<{ path: string; mtimeMs: number } | undefined> {
  try {
    const metadata = await stat(path);
    if (!metadata.isFile()) return undefined;
    if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) return undefined;
    await access(path, constants.R_OK);
    return { path, mtimeMs: metadata.mtimeMs };
  } catch {
    return undefined;
  }
}

export async function findClaudeHostCredentials(
  environment: NodeJS.ProcessEnv = process.env,
  home = homedir(),
  roots = credentialRoots(home, environment),
): Promise<string | undefined> {
  if (environment.CLAUDE_CODE_HOST_CREDS_FILE) {
    const explicit = await protectedCredential(environment.CLAUDE_CODE_HOST_CREDS_FILE);
    if (explicit) return explicit.path;
  }
  const candidates: Array<{ path: string; mtimeMs: number }> = [];
  for (const root of roots) {
    let names: string[];
    try {
      names = await readdir(root);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!/^host-creds-[a-z0-9-]+\.json$/iu.test(name)) continue;
      const candidate = await protectedCredential(join(root, name));
      if (candidate) candidates.push(candidate);
    }
  }
  return candidates.sort((left, right) => right.mtimeMs - left.mtimeMs)[0]?.path;
}

export function applyClaudeHostCredentials(environment: NodeJS.ProcessEnv, path: string): void {
  environment.CLAUDE_CODE_HOST_CREDS_FILE = path;
  environment.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = "1";
  environment.CLAUDE_CODE_HOST_AUTH_ENV_VAR = "ANTHROPIC_AUTH_TOKEN";
  environment.CLAUDE_CODE_HOST_SESSION_ID ??= `bridge-${process.pid}`;
  environment.CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH = "1";
}

async function bundledClaudeCandidates(home: string): Promise<string[]> {
  if (process.platform !== "darwin") return [];
  const roots = [
    join(home, "Library", "Application Support", "Claude-3p", "claude-code"),
    join(home, "Library", "Application Support", "Claude", "claude-code"),
  ];
  const candidates: string[] = [];
  for (const root of roots) {
    let versions: string[];
    try {
      versions = (await readdir(root)).sort((left, right) => (
        right.localeCompare(left, undefined, { numeric: true })
      ));
    } catch {
      continue;
    }
    for (const version of versions) {
      candidates.push(join(root, version, "claude.app", "Contents", "MacOS", "claude"));
    }
  }
  return candidates;
}

export async function findClaudeExecutable(
  environment: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): Promise<string | undefined> {
  const names = process.platform === "win32" ? ["claude.exe", "claude.cmd", "claude"] : ["claude"];
  const pathCandidates = (environment.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .flatMap((directory) => names.map((name) => join(directory, name)))
    .filter((candidate) => isSafeForBackgroundRuntimeScan(candidate, home));
  const configured = [environment.BRIDGE_CLAUDE_PATH, environment.CLAUDE_CODE_EXECUTABLE]
    .filter((value): value is string => Boolean(value));
  const local = process.platform === "win32"
    ? [join(home, ".local", "bin", "claude.exe"), join(home, ".local", "bin", "claude.cmd")]
    : [join(home, ".local", "bin", "claude"), join(home, ".claude", "local", "claude")];
  const bundled = await bundledClaudeCandidates(home);
  for (const candidate of [...configured, ...bundled, ...local, ...pathCandidates]) {
    if (await isExecutable(candidate)) return candidate;
  }
  return undefined;
}

export function buildClaudeRuntimeEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const runtimeEnvironment: NodeJS.ProcessEnv = {
    ...environment,
    CLAUDE_CODE_ENTRYPOINT: "claude-bridge",
    CLAUDE_AGENT_SDK_CLIENT_APP: "claude-bridge/0.4.0",
    BRIDGE_SESSION_RUNTIME: "1",
  };
  delete runtimeEnvironment.CLAUDECODE;
  return runtimeEnvironment;
}

export interface ClaudeRuntime {
  environment: NodeJS.ProcessEnv;
  executablePath?: string;
  credentialPath?: string;
  version?: string;
}

export async function prepareClaudeRuntime(
  environment: NodeJS.ProcessEnv = process.env,
  previous?: ClaudeRuntime,
): Promise<ClaudeRuntime> {
  const prepared = buildClaudeRuntimeEnvironment(environment);
  const credentialPath = await findClaudeHostCredentials(prepared);
  if (credentialPath) applyClaudeHostCredentials(prepared, credentialPath);
  const previousExecutable = previous?.executablePath && await isExecutable(previous.executablePath)
    ? previous.executablePath
    : undefined;
  const executablePath = previousExecutable ?? await findClaudeExecutable(prepared);
  let version = executablePath === previous?.executablePath ? previous?.version : undefined;
  if (executablePath && !version) {
    try {
      const result = await execFileAsync(executablePath, ["--version"], {
        cwd: homedir(),
        env: prepared,
        timeout: 8_000,
        maxBuffer: 64 * 1024,
      });
      version = result.stdout.trim().slice(0, 100) || undefined;
    } catch {
      version = undefined;
    }
  }
  return {
    environment: prepared,
    ...(executablePath ? { executablePath } : {}),
    ...(credentialPath ? { credentialPath } : {}),
    ...(version ? { version } : {}),
  };
}
