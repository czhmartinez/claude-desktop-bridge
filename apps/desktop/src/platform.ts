import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, hostname, networkInterfaces } from "node:os";
import { join } from "node:path";
import type { App } from "electron";
import type { ConnectorPaths } from "./connector.js";

export function defaultDesktopName(): string {
  return hostname().replace(/\.local$/u, "") || "My computer";
}

export function supportsClaudeDesktop(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin" || platform === "win32";
}

export function localNetworkAddress(): string {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal && !address.address.startsWith("169.254.")) {
        return address.address;
      }
    }
  }
  return "127.0.0.1";
}

/** Rewrite a private-IPv4 ws:// relay URL to this machine's current primary
 *  address (port/path preserved). Anything else passes through unchanged. */
export function refreshPrivateRelayUrl(value: string): string {
  try {
    const url = new URL(value);
    const host = url.hostname;
    const isPrivateV4 = /^10\./.test(host)
      || /^192\.168\./.test(host)
      || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
    if (!isPrivateV4) return value;
    const current = localNetworkAddress();
    if (host === current) return value;
    url.hostname = current;
    return url.toString();
  } catch {
    return value;
  }
}

export function firstNonEmpty(values: readonly (string | undefined)[]): string | undefined {
  for (const value of values) {
    const configured = value?.trim();
    if (configured) return configured;
  }
  return undefined;
}

export function networkReachableUrl(value: string): string {
  const url = new URL(value);
  if (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]") {
    url.hostname = localNetworkAddress();
  }
  return url.toString();
}

export function connectorPaths(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): ConnectorPaths {
  if (platform === "darwin") {
    return {
      claudeDesktop: [
        join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
        join(home, "Library", "Application Support", "Claude-3p", "claude_desktop_config.json"),
      ],
      claudeCode: join(home, ".claude.json"),
      claudeSettings: join(home, ".claude", "settings.json"),
    };
  }
  if (platform === "win32") {
    const appData = environment.APPDATA ?? join(home, "AppData", "Roaming");
    return {
      claudeDesktop: [
        join(appData, "Claude", "claude_desktop_config.json"),
        join(appData, "Claude-3p", "claude_desktop_config.json"),
      ],
      claudeCode: join(home, ".claude.json"),
      claudeSettings: join(home, ".claude", "settings.json"),
    };
  }
  const configHome = environment.XDG_CONFIG_HOME ?? join(home, ".config");
  return {
    claudeDesktop: [
      join(configHome, "Claude", "claude_desktop_config.json"),
      join(configHome, "Claude-3p", "claude_desktop_config.json"),
    ],
    claudeCode: join(home, ".claude.json"),
    claudeSettings: join(home, ".claude", "settings.json"),
  };
}

export interface ClaudeRuntimePaths {
  sessions: string;
  tasks: string;
  projects: string;
  desktopSessions: string[];
}

export function claudeRuntimePaths(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): ClaudeRuntimePaths {
  const root = join(home, ".claude");
  if (platform === "darwin") {
    return {
      sessions: join(root, "sessions"),
      tasks: join(root, "tasks"),
      projects: join(root, "projects"),
      desktopSessions: [
        join(home, "Library", "Application Support", "Claude", "claude-code-sessions"),
        join(home, "Library", "Application Support", "Claude-3p", "claude-code-sessions"),
      ],
    };
  }
  if (platform === "win32") {
    const appData = environment.APPDATA ?? join(home, "AppData", "Roaming");
    return {
      sessions: join(root, "sessions"),
      tasks: join(root, "tasks"),
      projects: join(root, "projects"),
      desktopSessions: [
        join(appData, "Claude", "claude-code-sessions"),
        join(appData, "Claude-3p", "claude-code-sessions"),
      ],
    };
  }
  const configHome = environment.XDG_CONFIG_HOME ?? join(home, ".config");
  return {
    sessions: join(root, "sessions"),
    tasks: join(root, "tasks"),
    projects: join(root, "projects"),
    desktopSessions: [
      join(configHome, "Claude", "claude-code-sessions"),
      join(configHome, "Claude-3p", "claude-code-sessions"),
    ],
  };
}

export async function setLaunchAtLogin(app: App, enabled: boolean): Promise<void> {
  if (process.platform === "darwin" || process.platform === "win32") {
    app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: true });
    return;
  }
  const autostartDir = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "autostart");
  const desktopFile = join(autostartDir, "claude-bridge.desktop");
  if (!enabled) {
    await rm(desktopFile, { force: true });
    return;
  }
  await mkdir(autostartDir, { recursive: true });
  await writeFile(desktopFile, [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Bridge",
    `Exec=\"${process.execPath.replaceAll('"', '\\"')}\" --hidden`,
    "Terminal=false",
    "X-GNOME-Autostart-enabled=true",
    "",
  ].join("\n"), "utf8");
}

export async function isLaunchAtLoginEnabled(app: App): Promise<boolean> {
  if (process.platform === "darwin" || process.platform === "win32") return app.getLoginItemSettings().openAtLogin;
  const desktopFile = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "autostart", "claude-bridge.desktop");
  return access(desktopFile).then(() => true, () => false);
}
