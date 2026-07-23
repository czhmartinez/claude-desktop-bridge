import { chromium } from "playwright-core";
import { WebSocket } from "ws";

const desktopCdp = process.env.BRIDGE_DESKTOP_CDP ?? "http://127.0.0.1:9223";
const androidCdp = process.env.BRIDGE_ANDROID_CDP ?? "http://127.0.0.1:9224";
const expectedSession = process.env.BRIDGE_E2E_SESSION_TITLE?.trim();

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  static async connect(baseUrl) {
    const targets = await fetch(`${baseUrl}/json/list`).then((response) => response.json());
    const target = targets.find((candidate) => candidate.type === "page" && candidate.url.startsWith("https://localhost"));
    if (!target) throw new Error("Android Bridge WebView target was not found");
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    return new CdpClient(socket);
  }

  call(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const response = await this.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.text ?? "Android evaluation failed");
    return response.result.value;
  }

  close() {
    this.socket.close();
  }
}

const desktopBrowser = await chromium.connectOverCDP(desktopCdp);
const desktopPage = desktopBrowser.contexts().flatMap((context) => context.pages()).find((page) => page.url().startsWith("file:"));
if (!desktopPage) throw new Error("Desktop Bridge renderer was not found");
const pairingUrl = await desktopPage.evaluate(async () => {
  const snapshot = await window.bridgeDesktop.getSnapshot();
  return snapshot.pairingUrl ?? (await window.bridgeDesktop.createPairing()).pairingUrl;
});
if (!pairingUrl) throw new Error("Desktop did not create a pairing URL");
await desktopBrowser.close();

const android = await CdpClient.connect(androidCdp);
try {
  while (await android.evaluate("Boolean(document.querySelector('button[aria-label^=\"删除 \"]'))")) {
    await android.evaluate("document.querySelector('button[aria-label^=\"删除 \"]')?.click()");
    await sleep(150);
    await android.evaluate("Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.trim() === '删除主机')?.click()");
    await sleep(300);
  }

  const pairingHash = new URL(pairingUrl).hash;
  await android.evaluate(`location.hash = ${JSON.stringify(pairingHash)}; location.reload()`);

  let result;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await sleep(500);
    try {
      result = await android.evaluate(`({
        status: document.querySelector('.mobile-device span')?.textContent ?? '',
        sessions: document.querySelectorAll('.session-row-v2').length,
        hasExpectedSession: ${JSON.stringify(expectedSession ?? "")}
          ? (document.body.textContent?.includes(${JSON.stringify(expectedSession ?? "")}) ?? false)
          : document.querySelectorAll('.session-row-v2').length > 0
      })`);
    } catch {
      continue;
    }
    if (result.sessions > 0 && result.hasExpectedSession) break;
  }
  if (!result?.hasExpectedSession || result.sessions < 1) {
    throw new Error("Android did not receive the Claude project and session catalog");
  }
  process.stdout.write(`${JSON.stringify({ ...result, pairedAndSynced: true })}\n`);
} finally {
  android.close();
}
