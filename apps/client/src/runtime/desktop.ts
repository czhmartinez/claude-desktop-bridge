import type {
  BridgeEvent,
  BridgeRequest,
  BridgeResponse,
  DesktopControlSnapshot,
} from "@bridge/protocol";

export type { DesktopControlSnapshot };

export interface LocalBridgeRequest {
  method: BridgeRequest["method"];
  params?: Record<string, unknown>;
  idempotencyKey?: string;
}

export interface DesktopApi {
  getSnapshot(): Promise<DesktopControlSnapshot>;
  createPairing(): Promise<DesktopControlSnapshot>;
  revokeDevice(deviceId: string): Promise<DesktopControlSnapshot>;
  setLaunchAtLogin(enabled: boolean): Promise<DesktopControlSnapshot>;
  request(request: LocalBridgeRequest): Promise<BridgeResponse>;
  exportDiagnostics(): Promise<{ saved: boolean; path?: string }>;
  onSnapshot(listener: (snapshot: DesktopControlSnapshot) => void): () => void;
  onEvent(listener: (event: BridgeEvent) => void): () => void;
}

export type BridgeMethod = BridgeRequest["method"];
