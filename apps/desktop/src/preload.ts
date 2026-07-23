import { contextBridge, ipcRenderer } from "electron";
import type { DesktopSnapshot } from "./controller.js";

contextBridge.exposeInMainWorld("bridgeDesktop", {
  getSnapshot: () => ipcRenderer.invoke("bridge:get-snapshot") as Promise<DesktopSnapshot>,
  regeneratePairing: () => ipcRenderer.invoke("bridge:regenerate-pairing") as Promise<DesktopSnapshot>,
  installClaudeConnector: () => ipcRenderer.invoke("bridge:install-connector") as Promise<DesktopSnapshot>,
  setLaunchAtLogin: (enabled: boolean) => ipcRenderer.invoke("bridge:set-launch-at-login", enabled) as Promise<DesktopSnapshot>,
  sendTestUpdate: () => ipcRenderer.invoke("bridge:send-test-update") as Promise<void>,
  onSnapshot: (listener: (snapshot: DesktopSnapshot) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: DesktopSnapshot) => listener(snapshot);
    ipcRenderer.on("bridge:snapshot", handler);
    return () => ipcRenderer.off("bridge:snapshot", handler);
  },
});
