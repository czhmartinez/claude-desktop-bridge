import type { ClaudeDesktopIntegrationState } from "@bridge/protocol";

export interface ManagedDesktopHelperStatus {
  state: ClaudeDesktopIntegrationState;
  detail: string;
  claudePid?: number;
  appVersion?: string;
  buildFingerprint?: string;
  lastError?: string;
}

export type ManagedDesktopHelperRequest =
  | {
      id: string;
      token: string;
      method: "status" | "subscribe";
    }
  | {
      id: string;
      token: string;
      method: "launch";
      params: { executablePath: string; appVersion: string };
    }
  | {
      id: string;
      token: string;
      method: "call";
      params: { name: string; args: unknown[] };
    }
  | {
      id: string;
      token: string;
      method: "stop";
    };

export interface ManagedDesktopHelperResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface ManagedDesktopHelperEvent {
  type: "status" | "session-event" | "permission-request";
  data: unknown;
}
