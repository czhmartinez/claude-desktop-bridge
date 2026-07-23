import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface ConnectorPaths {
  claudeDesktop: string[];
  claudeCode: string;
  claudeSettings: string;
}

interface ClaudeConfig {
  mcpServers?: Record<string, unknown>;
  hooks?: Record<string, unknown>;
  [key: string]: unknown;
}

export const BRIDGE_HOOK_URL = "http://127.0.0.1:8790/hooks/claude";

async function readJson(path: string): Promise<ClaudeConfig> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as ClaudeConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function writeJsonSafely(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  try {
    await readFile(path);
    await writeFile(`${path}.bridge-backup`, await readFile(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function removeBridgeHooks(config: ClaudeConfig): boolean {
  let changed = false;
  const nextHooks: Record<string, unknown> = {};
  for (const [event, handlersValue] of Object.entries(config.hooks ?? {})) {
    if (!Array.isArray(handlersValue)) {
      nextHooks[event] = handlersValue;
      continue;
    }
    const handlers = handlersValue.flatMap((handler) => {
      if (!isRecord(handler) || !Array.isArray(handler.hooks)) return [handler];
      const hooks = handler.hooks.filter((candidate) => !(
        isRecord(candidate)
        && candidate.type === "http"
        && candidate.url === BRIDGE_HOOK_URL
      ));
      if (hooks.length === handler.hooks.length) return [handler];
      changed = true;
      return hooks.length > 0 ? [{ ...handler, hooks }] : [];
    });
    if (handlers.length > 0) nextHooks[event] = handlers;
    else if (handlersValue.length > 0) changed = true;
  }
  if (changed) config.hooks = nextHooks;
  return changed;
}

export async function removeLegacyConnector(paths: ConnectorPaths): Promise<boolean> {
  let changed = false;
  for (const path of [...paths.claudeDesktop, paths.claudeCode]) {
    const config = await readJson(path);
    if (config.mcpServers?.["claude-bridge"] === undefined) continue;
    const mcpServers = { ...config.mcpServers };
    delete mcpServers["claude-bridge"];
    if (Object.keys(mcpServers).length > 0) config.mcpServers = mcpServers;
    else delete config.mcpServers;
    await writeJsonSafely(path, config);
    changed = true;
  }
  const settings = await readJson(paths.claudeSettings);
  if (removeBridgeHooks(settings)) {
    await writeJsonSafely(paths.claudeSettings, settings);
    changed = true;
  }
  return changed;
}
