import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface ConnectorLaunchSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface ConnectorPaths {
  claudeDesktop: string[];
  claudeCode: string;
  claudeSettings: string;
}

export interface ConnectorHookSpec {
  url: string;
  authorization: string;
}

interface McpConfig {
  mcpServers?: Record<string, unknown>;
  hooks?: Record<string, unknown>;
  [key: string]: unknown;
}

export type ConnectorInstallationState = "not-installed" | "installed" | "needs-repair";
export const BRIDGE_LOCAL_BASE_URL = "http://127.0.0.1:8790";
export const BRIDGE_HOOK_URL = `${BRIDGE_LOCAL_BASE_URL}/hooks/claude`;

export const BRIDGE_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PostToolUse",
  "PostToolUseFailure",
  "Notification",
  "Stop",
  "SessionEnd",
  "TaskCreated",
  "TaskCompleted",
] as const;

async function readJson(path: string): Promise<McpConfig> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as McpConfig;
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

function hasMcpConnector(config: McpConfig, spec: ConnectorLaunchSpec): boolean {
  return JSON.stringify(config.mcpServers?.["claude-bridge"]) === JSON.stringify(spec);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function containsBridgeHook(value: unknown, hook: ConnectorHookSpec): boolean {
  if (!isRecord(value) || !Array.isArray(value.hooks)) return false;
  return value.hooks.some((candidate) => (
    isRecord(candidate) &&
    candidate.type === "http" &&
    candidate.url === hook.url &&
    isRecord(candidate.headers) &&
    candidate.headers.Authorization === hook.authorization
  ));
}

function hasAllBridgeHooks(config: McpConfig, hook: ConnectorHookSpec): boolean {
  return BRIDGE_HOOK_EVENTS.every((event) => {
    const handlers = config.hooks?.[event];
    return Array.isArray(handlers) && handlers.some((handler) => containsBridgeHook(handler, hook));
  });
}

function referencesBridgeHook(config: McpConfig, hook: ConnectorHookSpec): boolean {
  return Object.values(config.hooks ?? {}).some((handlers) => (
    Array.isArray(handlers) && handlers.some((handler) => {
      if (!isRecord(handler) || !Array.isArray(handler.hooks)) return false;
      return handler.hooks.some((candidate) => isRecord(candidate) && candidate.type === "http" && candidate.url === hook.url);
    })
  ));
}

export async function connectorInstallationState(
  paths: ConnectorPaths,
  spec: ConnectorLaunchSpec,
  hook: ConnectorHookSpec,
): Promise<ConnectorInstallationState> {
  const mcpConfigs = await Promise.all([...paths.claudeDesktop, paths.claudeCode].map(readJson));
  const settings = await readJson(paths.claudeSettings);
  if (mcpConfigs.every((config) => hasMcpConnector(config, spec)) && hasAllBridgeHooks(settings, hook)) {
    return "installed";
  }
  if (mcpConfigs.some((config) => config.mcpServers?.["claude-bridge"] !== undefined) || referencesBridgeHook(settings, hook)) {
    return "needs-repair";
  }
  return "not-installed";
}

export async function connectorInstalled(
  paths: ConnectorPaths,
  spec: ConnectorLaunchSpec,
  hook: ConnectorHookSpec,
): Promise<boolean> {
  return await connectorInstallationState(paths, spec, hook) === "installed";
}

function bridgeHookGroup(hook: ConnectorHookSpec): Record<string, unknown> {
  return {
    hooks: [{
      type: "http",
      url: hook.url,
      headers: { Authorization: hook.authorization },
      timeout: 5,
    }],
  };
}

function mergeBridgeHooks(config: McpConfig, hook: ConnectorHookSpec): void {
  const hooks = { ...config.hooks };
  for (const event of BRIDGE_HOOK_EVENTS) {
    const existing = Array.isArray(hooks[event]) ? hooks[event] : [];
    hooks[event] = [
      ...existing.filter((handler) => {
        if (!isRecord(handler) || !Array.isArray(handler.hooks)) return true;
        return !handler.hooks.some((candidate) => isRecord(candidate) && candidate.type === "http" && candidate.url === hook.url);
      }),
      bridgeHookGroup(hook),
    ];
  }
  config.hooks = hooks;
}

export async function installConnector(
  paths: ConnectorPaths,
  spec: ConnectorLaunchSpec,
  hook: ConnectorHookSpec,
): Promise<void> {
  for (const path of [...paths.claudeDesktop, paths.claudeCode]) {
    const config = await readJson(path);
    config.mcpServers = { ...config.mcpServers, "claude-bridge": spec };
    await writeJsonSafely(path, config);
  }
  const settings = await readJson(paths.claudeSettings);
  mergeBridgeHooks(settings, hook);
  await writeJsonSafely(paths.claudeSettings, settings);
}
