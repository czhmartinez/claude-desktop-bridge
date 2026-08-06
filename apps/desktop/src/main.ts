import { join } from "node:path";
import { rename, writeFile } from "node:fs/promises";
import { parseBridgeIceServers, relayPathForUrl } from "@bridge/protocol";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  powerMonitor,
  protocol,
  safeStorage,
  shell,
  Tray,
} from "electron";
import {
  DesktopConfigRepository,
  fileSecretProtector,
  safeStorageSecretProtector,
} from "./config.js";
import { removeLegacyConnector } from "./connector.js";
import { DesktopController, type LocalBridgeRequest } from "./controller.js";
import {
  claudeRuntimePaths,
  connectorPaths,
  defaultDesktopName,
  firstNonEmpty,
  networkReachableUrl,
} from "./platform.js";
import { SessionBroker } from "./session-broker.js";
import { SessionEventLog } from "./session-event-log.js";
import { TranscriptObserver } from "./transcript-observer.js";
import { ClaudeDesktopLifecycle } from "./claude-desktop-lifecycle.js";
import { ClaudeDesktopSessionRegistrar } from "./claude-desktop-session-registrar.js";
import { ElectronEvidencePreviewRenderer } from "./artifact-preview.js";
import { EvidenceManager } from "./evidence-manager.js";
import { EvidenceStore } from "./evidence-store.js";
import {
  cleanupDesktopPeerConnection,
  loadDesktopPeerConnection,
} from "./webrtc-runtime.js";
import { ConversationStateStore } from "./conversation-state-store.js";
import { ProviderRegistry } from "./provider-registry.js";
import { ProviderRuntimePool } from "./provider-runtime-pool.js";
import { HandoffService } from "./handoff-service.js";
import { CodexAppServerAdapter } from "./codex-app-server-adapter.js";
import { HermesGatewayAdapter } from "./hermes-gateway-adapter.js";
import { RuntimeAdapterRegistry } from "./runtime-adapter.js";
import { RuntimeSessionBroker } from "./runtime-session-broker.js";

declare const __BRIDGE_DEFAULT_RELAY__: string;
declare const __BRIDGE_DEFAULT_PUBLIC_RELAY__: string;
declare const __BRIDGE_DEFAULT_PAIRING_BASE__: string;
declare const __BRIDGE_DEFAULT_SERVICE_ORIGIN__: string;
declare const __BRIDGE_DEFAULT_ICE_SERVERS__: string;

protocol.registerSchemesAsPrivileged([{
  scheme: "bridge-artifact",
  privileges: {
    standard: true,
    secure: true,
  },
}]);

const CONFIGURED_RELAY = firstNonEmpty([
  process.env.BRIDGE_RELAY_URL,
  __BRIDGE_DEFAULT_RELAY__,
  "ws://127.0.0.1:8788/ws",
])!;
const DEFAULT_RELAY = networkReachableUrl(CONFIGURED_RELAY);
const DEFAULT_PAIRING_BASE = firstNonEmpty([process.env.BRIDGE_PAIRING_BASE_URL])
  ?? networkReachableUrl(firstNonEmpty([
    __BRIDGE_DEFAULT_PAIRING_BASE__,
    "http://localhost:5188",
  ])!);
const CONFIGURED_PUBLIC_RELAY = (
  process.env.BRIDGE_PUBLIC_RELAY_URL === undefined
    ? firstNonEmpty([__BRIDGE_DEFAULT_PUBLIC_RELAY__])
    : firstNonEmpty([process.env.BRIDGE_PUBLIC_RELAY_URL])
) ?? (relayPathForUrl(CONFIGURED_RELAY) === "public-relay" ? CONFIGURED_RELAY : undefined);
const DEFAULT_SERVICE_ORIGIN = firstNonEmpty([
  process.env.BRIDGE_SERVICE_ORIGIN,
  __BRIDGE_DEFAULT_SERVICE_ORIGIN__,
  DEFAULT_PAIRING_BASE,
])!;
const DEFAULT_ICE_SERVERS = parseBridgeIceServers(
  firstNonEmpty([
    process.env.BRIDGE_ICE_SERVERS,
    __BRIDGE_DEFAULT_ICE_SERVERS__,
    '[{"urls":"stun:stun.cloudflare.com:3478"}]',
  ])!,
);

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
  const isolatedPackagedQa = process.argv.includes("--bridge-packaged-qa");
  const singleInstance = isolatedPackagedQa || app.requestSingleInstanceLock();
  if (!singleInstance) {
    app.quit();
    return;
  }
  await app.whenReady();

  const userDataPath = app.getPath("userData");
  await archiveLegacyQueue(userDataPath);
  await removeLegacyConnector(connectorPaths()).catch(() => undefined);

  const identityProtector = fileSecretProtector();
  const evidenceProtector = isolatedPackagedQa
    ? fileSecretProtector()
    : safeStorageSecretProtector(safeStorage);
  if (!evidenceProtector.available()) {
    throw new Error("OS secret storage is required for the evidence encryption key");
  }
  const repository = new DesktopConfigRepository(
    configPath(),
    identityProtector,
    {
      relayUrl: DEFAULT_RELAY,
      ...(CONFIGURED_PUBLIC_RELAY ? { publicRelayUrl: CONFIGURED_PUBLIC_RELAY } : {}),
      serviceOrigin: DEFAULT_SERVICE_ORIGIN,
      iceServers: DEFAULT_ICE_SERVERS,
      desktopName: defaultDesktopName(),
    },
    evidenceProtector,
  );
  const pairingConfig = await repository.loadOrCreate();
  const eventLog = new SessionEventLog(join(userDataPath, "events-v2.jsonl"));
  const conversationState = new ConversationStateStore({
    databasePath: join(userDataPath, "conversation-state-v1.sqlite"),
    sessionsPath: join(userDataPath, "sessions-v2.json"),
    queuePath: join(userDataPath, "turn-queue-v2.json"),
    masterSecret: pairingConfig.evidenceKey,
  });
  await conversationState.initialize();
  const evidenceStore = new EvidenceStore({
    databasePath: join(userDataPath, "evidence-v1.sqlite"),
    blobsPath: join(userDataPath, "evidence-blobs-v1"),
    masterSecret: pairingConfig.evidenceKey,
  });
  const evidence = new EvidenceManager({
    store: evidenceStore,
    eventLog,
    previewRenderer: new ElectronEvidencePreviewRenderer(),
  });
  await evidence.initialize();
  const runtimePaths = claudeRuntimePaths();
  const observer = new TranscriptObserver({ paths: runtimePaths, eventLog, evidence });
  await observer.start();
  const desktopRegistrar = new ClaudeDesktopSessionRegistrar({ paths: runtimePaths });
  let runtimeStatus = (): ReturnType<SessionBroker["runtimeStatus"]> => ({
    state: "unavailable",
    detail: "Claude-3p 运行时尚未初始化。",
    activeTurns: 0,
    maxParallelTurns: 2,
    desktopIntegration: {
      state: "not-managed",
      detail: "尚未初始化。",
      enabled: false,
      canRestart: process.platform === "darwin" || process.platform === "win32",
    },
  });
  const providers = new ProviderRegistry({
    state: conversationState,
    apiKeyPath: join(userDataPath, "anthropic-api-key-v1.json"),
    safeStorage,
    claude3pStatus: () => runtimeStatus(),
  });
  const runtimePool = new ProviderRuntimePool(providers);
  const broker = new SessionBroker({
    paths: runtimePaths,
    eventLog,
    observer,
    sessionsPath: join(userDataPath, "sessions-v2.json"),
    queuePath: join(userDataPath, "turn-queue-v2.json"),
    conversationState,
    runtimePool,
    evidence,
    desktopRegistrar,
  });
  runtimeStatus = () => broker.runtimeStatus();
  const runtimeRegistry = new RuntimeAdapterRegistry([
    new CodexAppServerAdapter(),
    new HermesGatewayAdapter(),
  ]);
  const runtimeSessions = new RuntimeSessionBroker(runtimeRegistry, eventLog);
  const handoffs = new HandoffService({
    state: conversationState,
    broker,
    eventLog,
    evidence,
    providers,
    runtimePool,
    observer,
    paths: runtimePaths,
    openExternal: (url) => shell.openExternal(url),
  });
  const claudeDesktop = new ClaudeDesktopLifecycle();
  let RTCPeerConnectionImpl: typeof RTCPeerConnection | undefined;
  try {
    RTCPeerConnectionImpl = loadDesktopPeerConnection();
  } catch (error) {
    process.stderr.write(
      `Bridge WebRTC unavailable; Relay fallback remains active: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
  }
  const controller = new DesktopController(
    app,
    repository,
    DEFAULT_PAIRING_BASE,
    CONFIGURED_RELAY,
    broker,
    eventLog,
    evidence,
    claudeDesktop,
    RTCPeerConnectionImpl,
    providers,
    handoffs,
    runtimeSessions,
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
  handle("bridge:set-anthropic-api-key", (value: string) => controller.setAnthropicApiKey(value));
  handle("bridge:remove-anthropic-api-key", () => controller.removeAnthropicApiKey());
  handle("bridge:launch-claude-desktop", () => controller.launchClaudeDesktop());
  handle("bridge:quit-claude-desktop", async () => {
    const snapshot = await controller.snapshot();
    const desktopTurnRunning = snapshot.sessions.some((session) => (
      session.turnState === "running" &&
      (
        session.ownership === "DESKTOP_OBSERVED" ||
        session.ownership === "DESKTOP_MANAGED_RUNNING" ||
        session.ownership === "OWNERSHIP_CONFLICT"
      )
    ));
    if (desktopTurnRunning) {
      const options: Electron.MessageBoxOptions = {
        type: "warning",
        title: "退出 Claude Desktop",
        message: "Claude Desktop 仍有会话正在运行",
        detail: "现在退出会中断电脑端正在执行的内容。由 Bridge 接管的远程任务不会受到影响。",
        buttons: ["仍然退出", "取消"],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      };
      const result = mainWindow
        ? await dialog.showMessageBox(mainWindow, options)
        : await dialog.showMessageBox(options);
      if (result.response !== 0) return snapshot;
    }
    return controller.quitClaudeDesktop();
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
  await conversationState.recordSuccessfulStartup();
  powerMonitor.on("suspend", () => controller.pauseForSleep());
  powerMonitor.on("resume", () => void controller.reconnect());
  app.on("second-instance", () => {
    showWindow();
    void controller.refreshRuntime();
  });
  app.on("activate", () => {
    showWindow();
    void controller.refreshRuntime();
  });
  app.on("before-quit", (event) => {
    if (cleanupStarted) return;
    event.preventDefault();
    cleanupStarted = true;
    quitting = true;
    void (async () => {
      await controller.close().catch(() => undefined);
      await broker.close().catch(() => undefined);
      await observer.close().catch(() => undefined);
      await evidence.close().catch(() => undefined);
      await eventLog.close().catch(() => undefined);
      conversationState.close();
      cleanupDesktopPeerConnection();
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
