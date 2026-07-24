import { contextBridge, ipcRenderer } from "electron";
import type { BridgeEvent, BridgeResponse, DesktopControlSnapshot } from "@bridge/protocol";
import type { LocalBridgeRequest } from "./controller.js";

contextBridge.exposeInMainWorld("bridgeDesktop", {
  getSnapshot: () => ipcRenderer.invoke("bridge:get-snapshot") as Promise<DesktopControlSnapshot>,
  createPairing: () => ipcRenderer.invoke("bridge:create-pairing") as Promise<DesktopControlSnapshot>,
  revokeDevice: (deviceId: string) => (
    ipcRenderer.invoke("bridge:revoke-device", deviceId) as Promise<DesktopControlSnapshot>
  ),
  setLaunchAtLogin: (enabled: boolean) => (
    ipcRenderer.invoke("bridge:set-launch-at-login", enabled) as Promise<DesktopControlSnapshot>
  ),
  request: (request: LocalBridgeRequest) => (
    ipcRenderer.invoke("bridge:request", request) as Promise<BridgeResponse>
  ),
  exportDiagnostics: () => (
    ipcRenderer.invoke("bridge:export-diagnostics") as Promise<{ saved: boolean; path?: string }>
  ),
  onSnapshot: (listener: (snapshot: DesktopControlSnapshot) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: DesktopControlSnapshot) => listener(snapshot);
    ipcRenderer.on("bridge:snapshot", handler);
    return () => ipcRenderer.off("bridge:snapshot", handler);
  },
  onEvent: (listener: (event: BridgeEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, event: BridgeEvent) => listener(event);
    ipcRenderer.on("bridge:event", handler);
    return () => ipcRenderer.off("bridge:event", handler);
  },
});
