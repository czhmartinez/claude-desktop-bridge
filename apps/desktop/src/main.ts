import { join } from "node:path";
import { app, BrowserWindow, ipcMain, Menu, nativeImage, shell, Tray } from "electron";
import { ClaudeBackgroundWorker } from "./claude-background-worker.js";
import { ClaudeIntegration } from "./claude-integration.js";
import { DesktopConfigRepository, fileSecretProtector } from "./config.js";
import { DesktopController } from "./controller.js";
import { runMcpServer } from "./mcp.js";
import { claudeRuntimePaths, connectorLaunchSpec, connectorPaths, defaultDesktopName, networkReachableUrl } from "./platform.js";

declare const __BRIDGE_DEFAULT_RELAY__: string;
declare const __BRIDGE_DEFAULT_PAIRING_BASE__: string;

const MCP_MODE = process.argv.includes("--mcp");
const DEFAULT_RELAY = process.env.BRIDGE_RELAY_URL
  ?? networkReachableUrl(__BRIDGE_DEFAULT_RELAY__);
const DEFAULT_PAIRING_BASE = process.env.BRIDGE_PAIRING_BASE_URL
  ?? networkReachableUrl(__BRIDGE_DEFAULT_PAIRING_BASE__);

function configPath(): string {
  const base = process.env.BRIDGE_USER_DATA ?? app.getPath("userData");
  return join(base, "bridge-config.json");
}

async function mcpMain(): Promise<void> {
  await app.whenReady();
  app.dock?.hide();
  const repository = new DesktopConfigRepository(configPath(), fileSecretProtector(), {
    relayUrl: DEFAULT_RELAY,
    desktopName: defaultDesktopName(),
  });
  await runMcpServer(repository);
}

async function desktopMain(): Promise<void> {
  app.enableSandbox();
  const singleInstance = app.requestSingleInstanceLock();
  if (!singleInstance) { app.quit(); return; }
  await app.whenReady();

  const userDataPath = app.getPath("userData");
  const repository = new DesktopConfigRepository(configPath(), fileSecretProtector(), {
    relayUrl: DEFAULT_RELAY,
    desktopName: defaultDesktopName(),
  });
  const controller = new DesktopController(
    app,
    repository,
    DEFAULT_PAIRING_BASE,
    connectorPaths(),
    connectorLaunchSpec(app, userDataPath),
  );

  let mainWindow: BrowserWindow | undefined;
  let tray: Tray | undefined;
  let integration: ClaudeIntegration | undefined;
  let backgroundWorker: ClaudeBackgroundWorker | undefined;
  let quitting = false;

  function showWindow(): void {
    if (!mainWindow) return;
    mainWindow.show();
    mainWindow.focus();
  }

  function validSender(frame: Electron.WebFrameMain | null): boolean {
    if (!frame) return false;
    const url = new URL(frame.url);
    if (process.env.BRIDGE_DEV_SERVER_URL) return url.origin === new URL(process.env.BRIDGE_DEV_SERVER_URL).origin;
    return url.protocol === "file:";
  }

  const handle = <T extends unknown[]>(channel: string, action: (...args: T) => unknown) => {
    ipcMain.handle(channel, (event, ...args: T) => {
      if (!validSender(event.senderFrame)) throw new Error("Untrusted renderer");
      return action(...args);
    });
  };
  handle("bridge:get-snapshot", () => controller.snapshot());
  handle("bridge:regenerate-pairing", () => controller.regeneratePairing());
  handle("bridge:install-connector", () => controller.installConnector());
  handle("bridge:set-launch-at-login", (enabled: boolean) => controller.setLaunchAtLogin(Boolean(enabled)));
  handle("bridge:send-test-update", () => controller.sendTestUpdate());

  mainWindow = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 760,
    minHeight: 600,
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
    if (!quitting) { event.preventDefault(); mainWindow?.hide(); }
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
  await controller.initialize();
  const runtimePaths = claudeRuntimePaths();
  integration = new ClaudeIntegration({
    controller,
    paths: runtimePaths,
    authorization: controller.localAuthorization(),
    bridgeSessionsPath: join(userDataPath, "bridge-claude-sessions.json"),
  });
  await integration.start();
  backgroundWorker = new ClaudeBackgroundWorker({ authorization: controller.localAuthorization() });
  backgroundWorker.start();
  await controller.repairConnectorIfNeeded();
  app.on("second-instance", showWindow);
  app.on("activate", showWindow);
  app.on("before-quit", () => {
    quitting = true;
    void backgroundWorker?.close();
    void integration?.close();
    controller.close();
  });
  app.on("window-all-closed", () => { if (process.platform !== "darwin") mainWindow?.hide(); });
}

(MCP_MODE ? mcpMain() : desktopMain()).catch((error: unknown) => {
  process.stderr.write(`Bridge failed: ${error instanceof Error ? error.message : String(error)}\n`);
  app.exit(1);
});
