import type { SocketState } from "@bridge/protocol";

export type ConnectorState = "not-installed" | "installed" | "needs-repair";

export interface ClaudeSessionSnapshot {
  sessionId: string;
  desktopSessionId?: string;
  pid?: number;
  cwd: string;
  projectName: string;
  name: string;
  startedAt: number;
  lastActivityAt: number;
  state: "running" | "idle";
  completedTasks: number;
  totalTasks: number;
  pendingTasks: number;
  currentTask?: string;
}

export interface DesktopSnapshot {
  desktopName: string;
  relayUrl: string;
  connection: SocketState;
  mobileOnline: boolean;
  mobilePaired: boolean;
  mobilePairedAt?: number;
  mobileLastSeenAt?: number;
  agentOnline: boolean;
  pairingUrl: string;
  connector: ConnectorState;
  claudeTransport: ClaudeTransportSnapshot;
  claudeSessions: ClaudeSessionSnapshot[];
  claudeActivities: ClaudeBridgeActivity[];
  pendingCommands: number;
  launchAtLogin: boolean;
  version: string;
}

export interface ClaudeTransportSnapshot {
  state: "waiting" | "ready" | "working" | "auth-required" | "unavailable";
  detail: string;
  lastSeenAt?: number;
  version?: string;
}

export interface ClaudeBridgeActivity {
  id: string;
  sessionId: string;
  projectName: string;
  sessionTitle: string;
  state: "queued" | "working" | "completed" | "retrying";
  command: string;
  summary?: string;
  updatedAt: number;
}

export interface DesktopApi {
  getSnapshot(): Promise<DesktopSnapshot>;
  regeneratePairing(): Promise<DesktopSnapshot>;
  installClaudeConnector(): Promise<DesktopSnapshot>;
  setLaunchAtLogin(enabled: boolean): Promise<DesktopSnapshot>;
  sendTestUpdate(): Promise<void>;
  onSnapshot(listener: (snapshot: DesktopSnapshot) => void): () => void;
}
