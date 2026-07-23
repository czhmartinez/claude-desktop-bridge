import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QRCodeSVG } from "qrcode.react";
import {
  BridgeCrypto,
  BridgeSocket,
  buildPairingUrl,
} from "../packages/protocol/dist/index.js";

const baseUrl = process.env.BRIDGE_QA_URL ?? "http://127.0.0.1:5188";
const relayUrl = process.env.BRIDGE_QA_RELAY ?? "ws://127.0.0.1:8788/ws";
const chrome = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const artifactDir = resolve("artifacts/visual-qa");
const axePath = resolve("node_modules/axe-core/axe.min.js");
await mkdir(artifactDir, { recursive: true });

const errors = [];

function watch(page, name) {
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`${name} console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`${name} page: ${error.message}`));
}

async function checkAccessibility(page, name) {
  await page.addScriptTag({ path: axePath });
  const result = await page.evaluate(async () => globalThis.axe.run(document, {
    resultTypes: ["violations"],
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] },
  }));
  for (const violation of result.violations.filter((item) => ["serious", "critical"].includes(item.impact))) {
    const targets = violation.nodes.slice(0, 4).map((node) => node.target.join(" ")).join(", ");
    errors.push(`${name} accessibility: ${violation.id} - ${violation.help} [${targets}]`);
  }
}

const { crypto: desktopCrypto, pairing } = await BridgeCrypto.createDesktop(relayUrl, "Martinez MacBook Pro");
const pairingUrl = buildPairingUrl(baseUrl, pairing);
const pairingQrSvg = renderToStaticMarkup(createElement(QRCodeSVG, {
  value: pairingUrl,
  size: 600,
  level: "M",
  marginSize: 4,
})).replace("<svg ", '<svg xmlns="http://www.w3.org/2000/svg" ');
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const desktopSocket = new BridgeSocket({ crypto: desktopCrypto, role: "desktop", createRoom: true, reconnect: false });
desktopSocket.onMessage((message, encrypted) => {
  desktopSocket.ack([encrypted.id]);
  if (message.payload.kind !== "history-request") return;
  void desktopSocket.send({
    kind: "history",
    sessionId: message.payload.sessionId,
    messages: [
      { id: "history-user-1", role: "user", text: "把手机端会话历史同步完整。", createdAt: Date.now() - 90_000 },
      { id: "history-assistant-1", role: "assistant", text: "已经定位到 Claude 本地会话记录，正在接入按需同步。", createdAt: Date.now() - 60_000 },
      { id: "history-user-2", role: "user", text: "继续完成并验证 Android。", createdAt: Date.now() - 30_000 },
    ],
    syncedAt: Date.now(),
    available: true,
    truncated: false,
  }, "mobile");
});
desktopSocket.connect();
await new Promise((resolveReady, reject) => {
  const timeout = setTimeout(() => reject(new Error("QA desktop did not connect")), 5_000);
  const off = desktopSocket.onState((state) => {
    if (state === "connected") {
      clearTimeout(timeout);
      off();
      resolveReady();
    }
  });
});

try {
  const pairingContext = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block", bypassCSP: true });
  const pairingPage = await pairingContext.newPage();
  await pairingPage.addInitScript(({ svg }) => {
    let canvas;
    let imageReady;

    function prepareCamera() {
      if (canvas) return canvas;
      canvas = document.createElement("canvas");
      canvas.width = 960;
      canvas.height = 960;
      const context = canvas.getContext("2d");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      const image = new Image();
      imageReady = new Promise((resolveImage, rejectImage) => {
        image.addEventListener("load", () => resolveImage(image));
        image.addEventListener("error", rejectImage);
      });
      image.src = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
      return canvas;
    }

    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: async () => prepareCamera().captureStream(12),
    });
    window.__bridgeShowPairingQr = async () => {
      const camera = prepareCamera();
      const image = await imageReady;
      const context = camera.getContext("2d");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, camera.width, camera.height);
      context.drawImage(image, 180, 180, 600, 600);
    };
  }, { svg: pairingQrSvg });
  watch(pairingPage, "pairing");
  await pairingPage.goto(baseUrl, { waitUntil: "networkidle" });
  await pairingPage.getByText("扫描电脑上的二维码").waitFor();
  const pairingOverflow = await pairingPage.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  if (pairingOverflow) errors.push("pairing layout: horizontal overflow");
  await checkAccessibility(pairingPage, "pairing");
  await pairingPage.screenshot({ path: resolve(artifactDir, "pairing-390x844.png"), fullPage: true });
  await pairingPage.getByRole("button", { name: "扫描二维码" }).click();
  await pairingPage.locator("#bridge-qr-reader video").waitFor({ state: "visible" });
  await checkAccessibility(pairingPage, "scanner");
  await pairingPage.getByRole("button", { name: "取消扫描" }).click();
  await pairingPage.getByRole("button", { name: "扫描二维码" }).waitFor();
  await pairingPage.getByRole("button", { name: "扫描二维码" }).click();
  await pairingPage.locator("#bridge-qr-reader video").waitFor({ state: "visible" });
  await pairingPage.evaluate(() => window.__bridgeShowPairingQr());
  await pairingPage.getByRole("heading", { name: "会话", exact: true }).waitFor();
  await pairingContext.close();

  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: "block", bypassCSP: true });
  const mobile = await mobileContext.newPage();
  watch(mobile, "mobile");
  await mobile.goto(pairingUrl, { waitUntil: "networkidle" });
  await mobile.getByRole("heading", { name: "会话", exact: true }).waitFor();
  await desktopSocket.send({
    kind: "sessions",
    sessions: [{
      sessionId: "qa-session",
      title: "Bridge 联调会话",
      projectName: "Claude Bridge",
      state: "running",
      lastActivityAt: Date.now(),
      completedTasks: 3,
      totalTasks: 5,
      currentTask: "验证手机与电脑状态同步",
    }],
  }, "mobile");
  await mobile.getByText("Bridge 联调会话").waitFor();
  const mobileOverflow = await mobile.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  if (mobileOverflow) errors.push("mobile layout: horizontal overflow");
  await checkAccessibility(mobile, "mobile");
  await mobile.screenshot({ path: resolve(artifactDir, "mobile-sessions-390x844.png"), fullPage: true });
  await mobile.getByRole("button", { name: /Bridge 联调会话/u }).click();
  await mobile.getByText("已经定位到 Claude 本地会话记录，正在接入按需同步。").waitFor();
  await checkAccessibility(mobile, "mobile history");
  await mobile.screenshot({ path: resolve(artifactDir, "mobile-history-390x844.png"), fullPage: true });
  await mobile.getByRole("button", { name: "返回会话列表" }).click();
  await mobile.getByRole("button", { name: "返回主机列表" }).click();
  await mobile.getByRole("heading", { name: "主机" }).waitFor();
  await mobile.screenshot({ path: resolve(artifactDir, "mobile-hosts-390x844.png"), fullPage: true });
  await mobile.getByRole("button", { name: "删除 Martinez MacBook Pro" }).click();
  await mobile.getByRole("alertdialog").waitFor();
  await mobile.getByRole("button", { name: "删除主机" }).click();
  await mobile.getByRole("heading", { name: "扫描电脑上的二维码" }).waitFor();
  await mobileContext.close();

  const desktopContext = await browser.newContext({ viewport: { width: 1200, height: 800 }, serviceWorkers: "block", bypassCSP: true });
  const desktop = await desktopContext.newPage();
  watch(desktop, "desktop");
  await desktop.addInitScript(({ pairingUrl }) => {
    const snapshot = {
      desktopName: "Martinez MacBook Pro",
      relayUrl: "wss://bridge.example/ws",
      connection: "connected",
      mobileOnline: true,
      mobilePaired: true,
      mobilePairedAt: Date.now() - 86_400_000,
      mobileLastSeenAt: Date.now(),
      agentOnline: false,
      pairingUrl,
      connector: "installed",
      claudeTransport: {
        state: "ready",
        detail: "Bridge 后台续写已就绪，不使用鼠标、键盘或剪贴板，也不会抢占 Claude Desktop。",
        lastSeenAt: Date.now(),
        version: "2.1.217",
      },
      claudeSessions: [{
        sessionId: "qa-session",
        cwd: "/Users/martinez/Documents/Claude Bridge",
        projectName: "Claude Bridge",
        name: "Bridge 联调会话",
        startedAt: Date.now() - 3_600_000,
        lastActivityAt: Date.now(),
        state: "running",
        completedTasks: 3,
        totalTasks: 5,
        pendingTasks: 2,
        currentTask: "验证手机与电脑状态同步",
      }],
      claudeActivities: [{
        id: "qa-command",
        sessionId: "qa-session",
        projectName: "Claude Bridge",
        sessionTitle: "Bridge 联调会话",
        state: "completed",
        command: "确认手机发来的指令可以安全执行",
        summary: "已完成后台续写，回复已经同步到手机与电脑端 Bridge。",
        updatedAt: Date.now(),
      }],
      pendingCommands: 1,
      launchAtLogin: true,
      version: "0.1.12",
    };
    let currentSnapshot = snapshot;
    const listeners = new Set();
    window.__bridgeVisualSetSnapshot = (nextSnapshot) => {
      currentSnapshot = nextSnapshot;
      for (const listener of listeners) listener(currentSnapshot);
    };
    window.bridgeDesktop = {
      getSnapshot: async () => currentSnapshot,
      regeneratePairing: async () => currentSnapshot,
      installClaudeConnector: async () => ({ ...currentSnapshot, connector: "installed" }),
      setLaunchAtLogin: async (enabled) => ({ ...currentSnapshot, launchAtLogin: enabled }),
      sendTestUpdate: async () => {},
      onSnapshot: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
  }, { pairingUrl });
  await desktop.goto(baseUrl, { waitUntil: "networkidle" });
  await desktop.getByText("Martinez MacBook Pro", { exact: true }).first().waitFor();
  const desktopOverflow = await desktop.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  if (desktopOverflow) errors.push("desktop layout: horizontal overflow");
  await checkAccessibility(desktop, "desktop");
  await desktop.screenshot({ path: resolve(artifactDir, "desktop-1200x800.png"), fullPage: true });
  await desktop.getByRole("button", { name: "显示修复二维码" }).click();
  await desktop.getByRole("img", { name: "手机配对二维码" }).waitFor();
  await desktop.screenshot({ path: resolve(artifactDir, "desktop-pairing-1200x800.png"), fullPage: true });
  await desktop.evaluate(async () => {
    const snapshot = await window.bridgeDesktop.getSnapshot();
    window.__bridgeVisualSetSnapshot({
      ...snapshot,
      claudeTransport: {
        state: "auth-required",
        detail: "未检测到 Claude Desktop 的第三方登录凭据。保持已登录的 Claude Desktop 运行，Bridge 会自动重连后台续写通道。",
        version: "2.1.217",
      },
    });
  });
  await desktop.getByText("等待 Claude Desktop 第三方通道", { exact: true }).waitFor();
  await desktop.screenshot({ path: resolve(artifactDir, "desktop-auth-required-1200x800.png"), fullPage: true });
  await desktop.setViewportSize({ width: 800, height: 600 });
  const compactOverflow = await desktop.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  if (compactOverflow) errors.push("desktop compact layout: horizontal overflow");
  await desktopContext.close();
} finally {
  desktopSocket.close();
  await browser.close();
}

if (errors.length) {
  process.stderr.write(`${errors.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(`Visual QA passed. Screenshots: ${artifactDir}\n`);
