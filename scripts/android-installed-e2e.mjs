import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { bridgeEndpoint, encodePairingBundle, pairingBundleFromUrl } from "@bridge/protocol";
import { chromium } from "playwright-core";

const desktopCdp = process.env.BRIDGE_DESKTOP_CDP ?? "http://127.0.0.1:9223";
const androidCdp = process.env.BRIDGE_ANDROID_CDP ?? "http://127.0.0.1:9224";
const androidRelay = process.env.BRIDGE_ANDROID_RELAY ?? "ws://10.0.2.2:8788/ws";
const targetSessionTitle = process.env.BRIDGE_E2E_SESSION_TITLE?.trim();
const marker = `BRIDGE_ANDROID_E2E_${Date.now()}`;
const command = process.env.BRIDGE_E2E_COMMAND ?? `请只回复这段文本，不要调用工具：${marker}`;
const expectedReply = process.env.BRIDGE_E2E_EXPECTED_REPLY ?? marker;
const artifacts = resolve("artifacts", "installed-android-e2e");

await mkdir(artifacts, { recursive: true });

const desktopBrowser = await chromium.connectOverCDP(desktopCdp);

async function connectWebView(endpoint) {
  const targets = await fetch(`${endpoint}/json`).then((response) => response.json());
  const target = targets.find((candidate) => candidate.type === "page" && candidate.url === "https://localhost/");
  assert.ok(target?.webSocketDebuggerUrl, "Android Bridge WebView was not found");
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolveOpen, rejectOpen) => {
    socket.addEventListener("open", resolveOpen, { once: true });
    socket.addEventListener("error", rejectOpen, { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  const send = (method, params = {}) => new Promise((resolveRequest, rejectRequest) => {
    const id = nextId++;
    pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const response = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description ?? "Android WebView evaluation failed");
    }
    return response.result?.value;
  };
  const waitFor = async (expression, timeoutMs = 20_000) => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (await evaluate(expression)) return;
      await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    }
    throw new Error(`Android WebView condition timed out: ${expression}`);
  };
  const screenshot = async (path) => {
    const result = await send("Page.captureScreenshot", { format: "png", fromSurface: true });
    await writeFile(path, Buffer.from(result.data, "base64"));
  };
  await send("Runtime.enable");
  await send("Page.enable");
  return { evaluate, screenshot, waitFor, close: () => socket.close() };
}

const androidPage = await connectWebView(androidCdp);

try {
  const desktopPage = desktopBrowser.contexts()
    .flatMap((context) => context.pages())
    .find((page) => page.url().startsWith("file:"));
  assert.ok(desktopPage, "Packaged Bridge renderer was not found");

  const pairingSnapshot = await desktopPage.evaluate(async () => {
    const snapshot = await window.bridgeDesktop.getSnapshot();
    return snapshot.pairingUrl ? snapshot : window.bridgeDesktop.createPairing();
  });
  const pairing = pairingBundleFromUrl(pairingSnapshot.pairingUrl);
  assert.ok(pairing, "Desktop pairing bundle was not available");
  pairing.relayUrl = androidRelay;
  pairing.relayEndpoints = [bridgeEndpoint(androidRelay, 10, "android")];
  pairing.activeEndpoint = "android";

  await androidPage.screenshot(resolve(artifacts, "01-pairing.png"));
  const encodedPairing = encodePairingBundle(pairing);
  await androidPage.evaluate(`(() => {
    const input = document.querySelector('input[aria-label="配对链接"]');
    if (!input) throw new Error('Pairing input missing');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(encodedPairing)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  await androidPage.evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find((item) => item.textContent.includes('连接电脑'));
    if (!button || button.disabled) throw new Error('Pairing button unavailable');
    button.click();
  })()`);

  await androidPage.waitFor("Boolean(document.querySelector('.session-row-v2'))");
  await androidPage.screenshot(resolve(artifacts, "02-session-list.png"));
  const selectedSession = await androidPage.evaluate(`(() => {
    const rows = [...document.querySelectorAll('.session-row-v2')];
    const targetTitle = ${JSON.stringify(targetSessionTitle ?? "")};
    const row = targetTitle
      ? rows.find((candidate) => candidate.textContent.includes(targetTitle))
      : rows.find((candidate) => (
          candidate.textContent.includes('待机') ||
          candidate.textContent.includes('桌面会话')
        ));
    if (!row) throw new Error(targetTitle
      ? 'Requested Claude session was not found'
      : 'No idle Claude session is available for the proactive resume test');
    row.dataset.bridgeE2eSelected = 'true';
    return { label: row.innerText, sessionId: row.dataset.sessionId };
  })()`);
  assert.ok(selectedSession.sessionId, "Selected row must expose its session id");
  if (targetSessionTitle) assert.match(selectedSession.label, new RegExp(targetSessionTitle, "u"));
  else assert.match(selectedSession.label, /待机|桌面会话/u, "E2E must target an idle Claude session");
  await androidPage.evaluate("document.querySelector('[data-bridge-e2e-selected=true]').click()");

  await androidPage.waitFor("Boolean(document.querySelector('textarea[aria-label=\"给 Claude 发指令\"]'))", 10_000);
  await androidPage.evaluate(`(() => {
    const input = document.querySelector('textarea[aria-label="给 Claude 发指令"]');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(command)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  await androidPage.evaluate("document.querySelector('button[aria-label=\"发送\"]').click()");

  await androidPage.waitFor(
    `[...document.querySelectorAll('.conversation-item.assistant .conversation-text')].some((item) => item.textContent.includes(${JSON.stringify(expectedReply)}))`,
    180_000,
  );
  await androidPage.screenshot(resolve(artifacts, "03-completed.png"));

  const commandCount = await androidPage.evaluate(
    `[...document.querySelectorAll('.conversation-item.user .conversation-text')].filter((item) => item.textContent === ${JSON.stringify(command)}).length`,
  );
  const completionCount = await androidPage.evaluate(
    `[...document.querySelectorAll('.conversation-item.assistant .conversation-text')].filter((item) => item.textContent.includes(${JSON.stringify(expectedReply)})).length`,
  );
  assert.equal(commandCount, 1, "Command must render once");
  assert.equal(completionCount, 1, "Completion must render once");

  const finalSnapshot = await desktopPage.evaluate(() => window.bridgeDesktop.getSnapshot());
  const completedSession = finalSnapshot.sessions.find((session) => session.sessionId === selectedSession.sessionId);
  assert.ok(completedSession, "Selected session must remain in the desktop catalog");
  assert.equal(completedSession.pendingCount, 0, "Desktop queue must be empty after completion");
  assert.ok(
    finalSnapshot.runtime.state === "ready" || finalSnapshot.runtime.state === "working",
    `Unexpected runtime state: ${finalSnapshot.runtime.state}`,
  );

  process.stdout.write(`${JSON.stringify({
    ok: true,
    desktopVersion: finalSnapshot.host.version,
    androidRelay,
    sessionCount: finalSnapshot.sessions.length,
    pendingCommands: finalSnapshot.sessions.reduce((sum, session) => sum + session.pendingCount, 0),
    runtime: finalSnapshot.runtime.state,
    selectedIdleSession: true,
    commandRenderedOnce: true,
    completionRenderedOnce: true,
    artifacts,
  }, null, 2)}\n`);
} finally {
  androidPage.close();
  await desktopBrowser.close();
}
