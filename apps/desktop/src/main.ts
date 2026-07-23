import { join } from "node:path";
import { rename, writeFile } from "node:fs/promises";
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, powerMonitor, shell, Tray } from "electron";
import { DesktopConfigRepository, fileSecretProtector } from "./config.js";
import { removeLegacyConnector } from "./connector.js";
import { DesktopController, type LocalBridgeRequest } from "./controller.js";
import { claudeRuntimePaths, connectorPaths, defaultDesktopName, networkReachableUrl } from "./platform.js";
import { SessionBroker } from "./session-broker.js";
import { SessionEventLog } from "./session-event-log.js";
import { TranscriptObserver } from "./transcript-observer.js";
import { ClaudeDesktopManager } from "./claude-desktop-manager.js";

declare const __BRIDGE_DEFAULT_RELAY__: string;
declare const __BRIDGE_DEFAULT_PAIRING_BASE__: string;

const DEFAULT_RELAY = process.env.BRIDGE_RELAY_URL
  ?? networkReachableUrl(__BRIDGE_DEFAULT_RELAY__);
const DEFAULT_PAIRING_BASE = process.env.BRIDGE_PAIRING_BASE_URL
  ?? networkReachableUrl(__BRIDGE_DEFAULT_PAIRING_BASE__);

function configPath(): string {
  const base = process.env.BRIDGE_USER_DATA ?? app.getPath("userData");
  return join(base, "bridge-config.json");
}

async function archiveLegacyQueue(userDataPath: string): Promise<void> {
  const path = join(userDataPath, "bridge-claude-sessions.json");
  await rename(path, `${path}.v1-archive-${Date.now()}`).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

async function desktopMain(): Promise<void> {
  app.enableSandbox();
  const singleInstance = app.requestSingleInstanceLock();
  if (!singleInstance) {
    app.quit();
    return;
  }
  await app.whenReady();

  const userDataPath = app.getPath("userData");
  await archiveLegacyQueue(userDataPath);
  await removeLegacyConnector(connectorPaths()).catch(() => undefined);

  const repository = new DesktopConfigRepository(configPath(), fileSecretProtector(), {
    relayUrl: DEFAULT_RELAY,
    desktopName: defaultDesktopName(),
  });
  const eventLog = new SessionEventLog(join(userDataPath, "events-v2.jsonl"));
  const runtimePaths = claudeRuntimePaths();
  const observer = new TranscriptObserver({ paths: runtimePaths, eventLog });
  await observer.start();
  const managedDesktop = new ClaudeDesktopManager({
    userDataPath,
    helperEntryPath: join(__dirname, "claude-desktop-helper.cjs"),
    enabled: false,
    hasActiveDesktopTask: () => observer.catalog.sessions.some((session) => (
      session.activeTask || observer.isDesktopBusy(session.sessionId)
    )),
  });
  const broker = new SessionBroker({
    paths: runtimePaths,
    eventLog,
    observer,
    sessionsPath: join(userDataPath, "sessions-v2.json"),
    queuePath: join(userDataPath, "turn-queue-v2.json"),
    managedDesktop,
  });
  const controller = new DesktopController(
    app,
    repository,
    DEFAULT_PAIRING_BASE,
    broker,
    eventLog,
    managedDesktop,
  );

  let mainWindow: BrowserWindow | undefined;
  let tray: Tray | undefined;
  let quitting = false;
  let cleanupStarted = false;

  function showWindow(): void {
    if (!mainWindow) return;
    mainWindow.show();
    mainWindow.focus();
  }

  function validSender(frame: Electron.WebFrameMain | null): boolean {
    if (!frame) return false;
    const url = new URL(frame.url);
    if (process.env.BRIDGE_DEV_SERVER_URL) {
      return url.origin === new URL(process.env.BRIDGE_DEV_SERVER_URL).origin;
    }
    return url.protocol === "file:";
  }

  const handle = <T extends unknown[]>(channel: string, action: (...args: T) => unknown) => {
    ipcMain.handle(channel, (event, ...args: T) => {
      if (!validSender(event.senderFrame)) throw new Error("Untrusted renderer");
      return action(...args);
    });
  };
  handle("bridge:get-snapshot", () => controller.snapshot());
  handle("bridge:create-pairing", () => controller.createPairing());
  handle("bridge:revoke-device", (deviceId: string) => controller.revokeDevice(deviceId));
  handle("bridge:set-launch-at-login", (enabled: boolean) => controller.setLaunchAtLogin(Boolean(enabled)));
  handle("bridge:set-managed-desktop-enabled", (enabled: boolean) => (
    controller.setManagedDesktopEnabled(Boolean(enabled))
  ));
  handle("bridge:restart-managed-claude", async () => {
    const options: Electron.MessageBoxOptions = {
      type: "warning",
      title: "重启并连接 Claude Desktop",
      message: "Bridge 将先检查当前 Claude Desktop 是否支持受管通道",
      detail: "仅在兼容时才会正常退出并重新打开 Claude Desktop。Bridge 不会绕过应用签名、强制终止进程或自动降级为独立会话。",
      buttons: ["重启并连接", "取消"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    };
    const result = mainWindow
      ? await dialog.showMessageBox(mainWindow, options)
      : await dialog.showMessageBox(options);
    if (result.response !== 0) return controller.snapshot();
    return controller.restartManagedClaude();
  });
  handle("bridge:request", (request: LocalBridgeRequest) => controller.dispatchLocal(request));
  handle("bridge:export-diagnostics", async () => {
    const result = await dialog.showSaveDialog({
      title: "导出 Bridge 诊断",
      defaultPath: `bridge-diagnostics-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (result.canceled || !result.filePath) return { saved: false };
    await writeFile(result.filePath, `${JSON.stringify(controller.diagnostics(), null, 2)}\n`, "utf8");
    return { saved: true, path: result.filePath };
  });

  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 860,
    minHeight: 620,
    show: !process.argv.includes("--hidden"),
    backgroundColor: "#f5f6f7",
    title: "Bridge",
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });
  mainWindow.removeMenu();
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  mainWindow.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  if (process.env.BRIDGE_DEV_SERVER_URL) await mainWindow.loadURL(process.env.BRIDGE_DEV_SERVER_URL);
  else await mainWindow.loadFile(join(__dirname, "renderer", "index.html"));

  const trayIconPath = join(__dirname, "renderer", "icon-192.png");
  tray = new Tray(nativeImage.createFromPath(trayIconPath).resize({ width: 18, height: 18 }));
  tray.setToolTip("Bridge");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "打开 Bridge", click: showWindow },
    { type: "separator" },
    { label: "退出", click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on("click", showWindow);

  controller.on("snapshot", (snapshot) => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send("bridge:snapshot", snapshot);
    }
  });
  controller.on("event", (event) => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send("bridge:event", event);
    }
  });
  await controller.initialize();
  powerMonitor.on("suspend", () => controller.pauseForSleep());
  powerMonitor.on("resume", () => void controller.reconnect());
  app.on("second-instance", showWindow);
  app.on("activate", showWindow);
  app.on("before-quit", (event) => {
    if (cleanupStarted) return;
    event.preventDefault();
    cleanupStarted = true;
    quitting = true;
    controller.close();
    void (async () => {
      await broker.close().catch(() => undefined);
      await managedDesktop.close().catch(() => undefined);
      await observer.close().catch(() => undefined);
      await eventLog.close().catch(() => undefined);
      app.quit();
    })();
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") mainWindow?.hide();
  });
}

desktopMain().catch((error: unknown) => {
  process.stderr.write(`Bridge failed: ${error instanceof Error ? error.message : String(error)}\n`);
  app.exit(1);
});
