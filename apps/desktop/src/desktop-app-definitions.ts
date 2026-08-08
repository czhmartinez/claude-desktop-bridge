import { homedir } from "node:os";
import { join, win32 as windowsPath } from "node:path";
import type { BridgeDesktopRuntimeId } from "@bridge/protocol";

export interface DesktopAppDefinition {
  id: BridgeDesktopRuntimeId;
  displayName: string;
  darwinBundle: string;
  darwinBundleCandidates?: string[];
  darwinPathCandidates?(home: string): string[];
  darwinExecutableName?: string;
  darwinExecutableCandidates?: string[];
  win32ExecutableName: string;
  envPathOverride?: string;
  win32PathCandidates?(environment: NodeJS.ProcessEnv, home: string): string[];
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value && value.trim())))];
}

function win32Roots(environment: NodeJS.ProcessEnv, home: string): { localAppData: string; programFiles: string[] } {
  return {
    localAppData: environment.LOCALAPPDATA ?? windowsPath.join(home, "AppData", "Local"),
    programFiles: [
      environment.ProgramW6432 ?? environment.ProgramFiles ?? "C:\\Program Files",
      environment["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
    ],
  };
}

export const CLAUDE_DESKTOP_APP: DesktopAppDefinition = {
  id: "claude-desktop",
  displayName: "Claude Desktop",
  darwinBundle: "/Applications/Claude.app",
  win32ExecutableName: "Claude.exe",
  envPathOverride: "BRIDGE_CLAUDE_DESKTOP_PATH",
  win32PathCandidates: (environment, home) => {
    const { localAppData, programFiles } = win32Roots(environment, home);
    return unique([
      environment.BRIDGE_CLAUDE_DESKTOP_PATH,
      windowsPath.join(localAppData, "Programs", "Claude", "Claude.exe"),
      windowsPath.join(localAppData, "Claude", "Claude.exe"),
      windowsPath.join(localAppData, "AnthropicClaude", "Claude.exe"),
      windowsPath.join(localAppData, "Microsoft", "WindowsApps", "Claude.exe"),
      ...programFiles.map((root) => windowsPath.join(root, "Claude", "Claude.exe")),
    ]);
  },
};

export const CODEX_DESKTOP_APP: DesktopAppDefinition = {
  id: "codex-desktop",
  displayName: "Codex（ChatGPT）",
  darwinBundle: "/Applications/ChatGPT.app",
  darwinBundleCandidates: ["/Applications/Codex.app"],
  darwinExecutableName: "ChatGPT",
  darwinExecutableCandidates: ["Codex"],
  win32ExecutableName: "Codex.exe",
  envPathOverride: "BRIDGE_CODEX_DESKTOP_PATH",
  win32PathCandidates: (environment, home) => {
    const { localAppData, programFiles } = win32Roots(environment, home);
    return unique([
      environment.BRIDGE_CODEX_DESKTOP_PATH,
      windowsPath.join(localAppData, "Programs", "Codex", "Codex.exe"),
      windowsPath.join(localAppData, "Codex", "Codex.exe"),
      ...programFiles.map((root) => windowsPath.join(root, "Codex", "Codex.exe")),
    ]);
  },
};

export const HERMES_DESKTOP_APP: DesktopAppDefinition = {
  id: "hermes-desktop",
  displayName: "Hermes",
  darwinBundle: "/Applications/Hermes.app",
  darwinPathCandidates: (home) => [
    join(home, ".hermes", "hermes-agent", "apps", "desktop", "release", "mac-arm64", "Hermes.app"),
    join(home, ".hermes", "hermes-agent", "apps", "desktop", "release", "mac-x64", "Hermes.app"),
  ],
  win32ExecutableName: "Hermes.exe",
  envPathOverride: "BRIDGE_HERMES_DESKTOP_PATH",
  win32PathCandidates: (environment, home) => {
    const { localAppData, programFiles } = win32Roots(environment, home);
    return unique([
      environment.BRIDGE_HERMES_DESKTOP_PATH,
      windowsPath.join(localAppData, "Programs", "Hermes", "Hermes.exe"),
      windowsPath.join(localAppData, "Hermes", "Hermes.exe"),
      ...programFiles.map((root) => windowsPath.join(root, "Hermes", "Hermes.exe")),
    ]);
  },
};

export const DESKTOP_APP_DEFINITIONS: DesktopAppDefinition[] = [
  CLAUDE_DESKTOP_APP,
  CODEX_DESKTOP_APP,
  HERMES_DESKTOP_APP,
];

/** Ordered executable candidates for the app; the first hit wins. */
export function desktopAppPathCandidates(
  definition: DesktopAppDefinition,
  environment: NodeJS.ProcessEnv = process.env,
  home = homedir(),
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform === "win32") {
    return definition.win32PathCandidates?.(environment, home)
      ?? unique([definition.envPathOverride ? environment[definition.envPathOverride] : undefined]);
  }
  return unique([
    definition.darwinBundle,
    ...(definition.darwinBundleCandidates ?? []),
    ...(definition.darwinPathCandidates?.(home) ?? []),
  ].map((bundle) => join(bundle)));
}
