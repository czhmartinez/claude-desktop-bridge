import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import {
  BridgeCrypto,
  BridgeSocket,
  buildPairingUrl,
} from "../packages/protocol/dist/index.js";

const baseUrl = process.env.BRIDGE_QA_URL ?? "http://127.0.0.1:5188";
const relayUrl = process.env.BRIDGE_QA_RELAY ?? "ws://127.0.0.1:8788/ws";
const chrome = process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const artifactDir = resolve("artifacts", "visual-qa");
const axePath = resolve("node_modules", "axe-core", "axe.min.js");
const errors = [];
const now = Date.now();

await mkdir(artifactDir, { recursive: true });

const project = {
  projectId: "project-bridge",
  name: "Claude Bridge",
  cwd: "/Users/martinez/Documents/Claude Bridge",
  sessionCount: 2,
  runningCount: 1,
  pendingCount: 1,
  lastActivityAt: now,
};
const secondaryProject = {
  projectId: "project-pms",
  name: "ega-pms",
  cwd: "/Users/martinez/Desktop/ega-pms",
  sessionCount: 1,
  runningCount: 0,
  pendingCount: 0,
  lastActivityAt: now - 3_600_000,
};
const sessions = [
  {
    sessionId: "session-running",
    projectId: project.projectId,
    projectName: project.name,
    cwd: project.cwd,
    title: "Bridge 0.2 同会话联调",
    source: "desktop",
    ownership: "BRIDGE_RUNNING",
    turnState: "running",
    lastActivityAt: now,
    pendingCount: 1,
    activeTurnId: "turn-active",
    currentSummary: "验证手机与电脑共享同一条事件流",
    model: "claude-fable-5[1m]",
    effort: "high",
  },
  {
    sessionId: "session-idle",
    projectId: project.projectId,
    projectName: project.name,
    cwd: project.cwd,
    title: "协议 v2 与设备安全",
    source: "desktop",
    ownership: "DESKTOP_OBSERVED",
    turnState: "idle",
    lastActivityAt: now - 1_800_000,
    pendingCount: 0,
    model: "claude-sonnet-5",
    effort: "medium",
  },
  {
    sessionId: "session-pms",
    projectId: secondaryProject.projectId,
    projectName: secondaryProject.name,
    cwd: secondaryProject.cwd,
    title: "项目进展页面调整",
    source: "desktop",
    ownership: "DESKTOP_OBSERVED",
    turnState: "idle",
    lastActivityAt: now - 3_600_000,
    pendingCount: 0,
    model: "claude-opus-4-8",
    effort: "high",
  },
];
const history = {
  sessionId: "session-running",
  items: [
    {
      id: "history-user",
      sessionId: "session-running",
      role: "user",
      text: "把 Bridge 重构为同一会话的远程控制客户端。",
      createdAt: now - 120_000,
      origin: "claude-desktop",
    },
    {
      id: "history-assistant",
      sessionId: "session-running",
      role: "assistant",
      text: "会话内核已接管相同 sessionId，正在验证实时事件与审批。",
      createdAt: now - 90_000,
      origin: "claude-host",
    },
    {
      id: "history-tool",
      sessionId: "session-running",
      role: "tool",
      text: "npm run verify: 24 tests passed",
      createdAt: now - 30_000,
      origin: "claude-host",
      toolName: "Bash",
      state: "completed",
    },
  ],
  hasMore: true,
  nextCursor: "older-page",
};
let sessionConfiguration = {
  sessionId: "session-running",
  model: "claude-fable-5[1m]",
  effort: "high",
  inheritedModel: "claude-fable-5[1m]",
  inheritedEffort: "high",
  modelSource: "claude-desktop",
  effortSource: "claude-desktop",
  availableModels: [
    { value: "claude-fable-5[1m]", displayName: "Fable 5 · 1M", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh"] },
    { value: "claude-opus-4-8[1m]", displayName: "Opus 4.8 · 1M", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
    { value: "claude-sonnet-5[1m]", displayName: "Sonnet 5 · 1M", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh"] },
  ],
  availableEffortLevels: ["low", "medium", "high", "xhigh"],
  modelsComplete: true,
  appliesAfterTurn: true,
  context: {
    totalTokens: 301_611,
    maxTokens: 1_000_000,
    percentage: 30.1611,
    model: "k3",
    estimated: false,
  },
};

function watch(page, name) {
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`${name} console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`${name} page: ${error.message}`));
}

async function checkPage(page, name) {
  const overflow = await page.evaluate(() => ({
    horizontal: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    empty: document.body.getBoundingClientRect().height < 100,
  }));
  if (overflow.horizontal) errors.push(`${name} layout: horizontal overflow`);
  if (overflow.empty) errors.push(`${name} layout: empty document`);
  await page.addScriptTag({ path: axePath });
  const result = await page.evaluate(async () => globalThis.axe.run(document, {
    resultTypes: ["violations"],
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] },
  }));
  for (const violation of result.violations.filter((item) => ["serious", "critical"].includes(item.impact))) {
    const targets = violation.nodes.slice(0, 3).map((node) => node.target.join(" ")).join(", ");
    errors.push(`${name} accessibility: ${violation.id} - ${violation.help} [${targets}]`);
  }
}

async function waitForSocket(socket) {
  await new Promise((resolveReady, reject) => {
    const timeout = setTimeout(() => reject(new Error("QA desktop did not connect to Relay")), 5_000);
    const off = socket.onState((state) => {
      if (state !== "connected") return;
      clearTimeout(timeout);
      off();
      resolveReady();
    });
  });
}

const { crypto: desktopCrypto, pairing } = await BridgeCrypto.createDesktop(relayUrl, "Martinez-MacBook-Pro");
const pairingUrl = buildPairingUrl(baseUrl, pairing);
const hostSnapshot = {
  host: {
    hostId: desktopCrypto.identity.deviceId,
    name: "Martinez-MacBook-Pro",
    relayUrl,
    online: true,
    lastSeenAt: now,
    version: "0.2.2",
  },
  projects: [project, secondaryProject],
  sessions,
  devices: [{
    deviceId: pairing.deviceId,
    name: "Android 手机",
    platform: "android",
    online: true,
    createdAt: now - 86_400_000,
    lastSeenAt: now,
  }],
  runtime: {
    state: "working",
    detail: "1 个会话正在由 Bridge 托管。",
    version: "2.1.217",
    credentialSource: "third-party-host",
    activeTurns: 1,
    maxParallelTurns: 2,
  },
  permissions: [{
    requestId: "permission-bash",
    sessionId: "session-running",
    toolUseId: "tool-bash",
    toolName: "Bash",
    displayName: "运行验证命令",
    description: "在 Claude Bridge 项目中运行完整测试。",
    input: { command: "npm run verify" },
    createdAt: now - 5_000,
    canAllowAlways: true,
  }],
  latestSeq: 42,
};

let eventSeq = hostSnapshot.latestSeq;
const desktopSocket = new BridgeSocket({
  crypto: desktopCrypto,
  role: "desktop",
  createRoom: true,
  reconnect: false,
});

async function sendToMobile(payload, deviceId = pairing.deviceId) {
  await desktopSocket.send(payload, "mobile", {
    crypto: desktopCrypto,
    toDeviceId: deviceId,
  });
}

function event(type, data, options = {}) {
  eventSeq += 1;
  return {
    eventId: `qa-event-${eventSeq}`,
    sessionId: options.sessionId ?? "session-running",
    ...(options.turnId ? { turnId: options.turnId } : {}),
    ...(options.itemId ? { itemId: options.itemId } : {}),
    seq: eventSeq,
    timestamp: Date.now(),
    origin: options.origin ?? "claude-host",
    type,
    data,
  };
}

let deviceRegistered = false;
desktopSocket.onState((state) => {
  if (state !== "connected" || deviceRegistered) return;
  deviceRegistered = true;
  desktopSocket.registerDevice(pairing.deviceId, desktopCrypto.identity.authToken, pairing.expiresAt);
});
desktopSocket.onFrame((frame) => {
  if (frame.type === "presence" && frame.role === "mobile" && frame.online) {
    void sendToMobile({ kind: "snapshot", snapshot: hostSnapshot }, frame.deviceId);
  }
});
desktopSocket.onMessage((message, encrypted) => {
  void (async () => {
    if (message.payload.kind !== "request") {
      desktopSocket.ack([encrypted.id]);
      return;
    }
    const request = message.payload;
    let result = {};
    if (request.method === "events.resume") {
      result = { events: [], latestSeq: eventSeq };
    } else if (request.method === "session.open") {
      result = { session: sessions[0], history, latestSeq: eventSeq };
    } else if (request.method === "session.history") {
      result = { history: { ...history, items: history.items.slice(0, 1), hasMore: false } };
    } else if (request.method === "session.configuration") {
      result = { configuration: sessionConfiguration };
    } else if (request.method === "session.configure") {
      sessionConfiguration = {
        ...sessionConfiguration,
        ...(typeof request.params.model === "string" ? { model: request.params.model, overrideModel: request.params.model } : {}),
        ...(typeof request.params.effort === "string" ? { effort: request.params.effort, overrideEffort: request.params.effort } : {}),
      };
      result = { configuration: sessionConfiguration, session: sessions[0] };
    } else if (request.method === "project.list") {
      result = { projects: hostSnapshot.projects };
    } else if (request.method === "session.list") {
      result = { sessions: hostSnapshot.sessions };
    } else if (request.method === "turn.start" || request.method === "turn.steer") {
      result = { commandId: "qa-command", state: "running" };
    } else if (request.method === "turn.interrupt") {
      result = { interrupted: true };
    } else if (request.method === "permission.resolve") {
      result = { resolved: true };
    } else if (request.method === "session.create") {
      result = { session: { ...sessions[1], sessionId: "session-created", source: "bridge", title: "新建会话" } };
    }
    await sendToMobile({
      kind: "response",
      requestId: request.requestId,
      ok: true,
      result,
    }, message.header.fromDeviceId);
    desktopSocket.ack([encrypted.id]);

    if (request.method === "turn.start" || request.method === "turn.steer") {
      const text = typeof request.params.text === "string" ? request.params.text : "";
      const events = [
        event("turn.queued", {
          commandId: "qa-command",
          requestId: request.requestId,
          delivery: "host-received",
          text,
        }, { origin: "mobile", itemId: "qa-command" }),
        event("user.message.accepted", {
          commandId: "qa-command",
          requestId: request.requestId,
          text,
          delivery: "session-received",
        }, { origin: "mobile", itemId: "qa-user", turnId: "qa-turn" }),
        event("turn.started", { delivery: "running" }, { turnId: "qa-turn" }),
        event("assistant.completed", {
          text: "收到。回复与手机消息已经写入同一个 Claude 会话。",
        }, { itemId: "qa-assistant", turnId: "qa-turn" }),
        event("turn.completed", { delivery: "completed" }, { turnId: "qa-turn" }),
      ];
      for (const next of events) {
        await sendToMobile({ kind: "event", event: next }, message.header.fromDeviceId);
      }
    }
  })().catch((error) => errors.push(`mock desktop: ${error.message}`));
});
desktopSocket.connect();
await waitForSocket(desktopSocket);

const browser = await chromium.launch({ executablePath: chrome, headless: true });

try {
  const pairingContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    serviceWorkers: "block",
    bypassCSP: true,
  });
  const pairingPage = await pairingContext.newPage();
  watch(pairingPage, "pairing");
  await pairingPage.goto(baseUrl, { waitUntil: "networkidle" });
  await pairingPage.getByRole("heading", { name: "扫描电脑上的二维码" }).waitFor();
  await checkPage(pairingPage, "pairing");
  await pairingPage.screenshot({ path: resolve(artifactDir, "mobile-pairing-390x844.png"), fullPage: true });
  await pairingContext.close();

  const mobileContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    serviceWorkers: "block",
    bypassCSP: true,
  });
  const mobile = await mobileContext.newPage();
  watch(mobile, "mobile");
  await mobile.goto(pairingUrl, { waitUntil: "networkidle" });
  await mobile.getByRole("heading", { name: "项目与会话" }).waitFor({ timeout: 10_000 });
  const waitingSessionRow = mobile.locator(".session-row-v2").filter({ hasText: "Bridge 0.2 同会话联调" });
  await waitingSessionRow.waitFor();
  await checkPage(mobile, "mobile catalog");
  await mobile.screenshot({ path: resolve(artifactDir, "mobile-catalog-390x844.png"), fullPage: true });

  await waitingSessionRow.click();
  await mobile.getByText("会话内核已接管相同 sessionId，正在验证实时事件与审批。").waitFor();
  await mobile.getByText("Bash 请求权限").waitFor();
  await mobile.getByText("npm run verify", { exact: true }).waitFor();
  await checkPage(mobile, "mobile conversation");
  await mobile.screenshot({ path: resolve(artifactDir, "mobile-permission-390x844.png"), fullPage: true });
  await mobile.getByRole("button", { name: "允许一次" }).click();
  await mobile.getByText("Bash 请求权限").waitFor({ state: "detached" });
  await mobile.screenshot({ path: resolve(artifactDir, "mobile-conversation-390x844.png"), fullPage: true });

  await sendToMobile({
    kind: "event",
    event: event("permission.requested", {
      requestId: "permission-write-live",
      toolUseId: "tool-write-live",
      toolName: "Write",
      title: "Write 请求权限",
      description: "写入会话内核的状态测试文件。",
      input: {
        file_path: "/Users/martinez/Documents/Claude Bridge/tmp/permission-event.ts",
        content: "export const permissionEvent = true;\n".repeat(120),
      },
      createdAt: Date.now(),
      canAllowAlways: false,
    }, { itemId: "permission-write-live" }),
  });
  const livePermissionSheet = mobile.getByRole("dialog", { name: "Claude 等待授权" });
  await livePermissionSheet.getByText("Write 请求权限", { exact: true }).waitFor();
  await livePermissionSheet.locator(".permission-facts").getByText(
    "/Users/martinez/Documents/Claude Bridge/tmp/permission-event.ts",
    { exact: true },
  ).waitFor();
  if (await mobile.getByRole("button", { name: "始终允许" }).count()) {
    errors.push("mobile permission: always-allow shown without an SDK persistence suggestion");
  }
  await mobile.screenshot({ path: resolve(artifactDir, "mobile-live-permission-390x844.png"), fullPage: true });
  await mobile.getByRole("button", { name: "允许一次" }).click();
  await livePermissionSheet.waitFor({ state: "detached" });

  await mobile.getByRole("button", { name: "模型与 Effort" }).click();
  await mobile.getByText("Claude Host 实时用量").waitFor();
  await checkPage(mobile, "mobile session configuration");
  await mobile.screenshot({ path: resolve(artifactDir, "mobile-session-configuration-390x844.png"), fullPage: true });
  await mobile.getByRole("button", { name: "关闭" }).click();

  await mobile.getByLabel("给 Claude 发指令").fill("继续验证同一会话的手机消息。");
  await mobile.getByRole("button", { name: "发送", exact: true }).click();
  await mobile.getByText("收到。回复与手机消息已经写入同一个 Claude 会话。").waitFor();
  const sentCount = await mobile.getByText("继续验证同一会话的手机消息。", { exact: true }).count();
  if (sentCount !== 1) errors.push(`mobile conversation: sent command rendered ${sentCount} times`);
  await mobile.screenshot({ path: resolve(artifactDir, "mobile-completed-390x844.png"), fullPage: true });

  await mobile.getByLabel("返回会话列表").click();
  await mobile.getByLabel("返回主机列表").click();
  await mobile.getByRole("heading", { name: "主机" }).waitFor();
  await checkPage(mobile, "mobile hosts");
  await mobile.screenshot({ path: resolve(artifactDir, "mobile-hosts-390x844.png"), fullPage: true });
  await mobileContext.close();

  const desktopSnapshot = {
    ...hostSnapshot,
    connection: "connected",
    launchAtLogin: true,
  };
  const desktopContext = await browser.newContext({
    viewport: { width: 1200, height: 800 },
    serviceWorkers: "block",
    bypassCSP: true,
  });
  const desktop = await desktopContext.newPage();
  watch(desktop, "desktop");
  await desktop.addInitScript(({ snapshot, pairingUrl, history, sessionConfiguration }) => {
    let current = snapshot;
    let currentConfiguration = sessionConfiguration;
    const snapshotListeners = new Set();
    const eventListeners = new Set();
    const response = (request, result) => ({
      kind: "response",
      requestId: crypto.randomUUID(),
      ok: true,
      result,
    });
    window.bridgeDesktop = {
      getSnapshot: async () => current,
      createPairing: async () => {
        current = {
          ...current,
          pairingUrl,
          pairingExpiresAt: Date.now() + 10 * 60_000,
        };
        for (const listener of snapshotListeners) listener(current);
        return current;
      },
      revokeDevice: async (deviceId) => {
        current = {
          ...current,
          devices: current.devices.map((device) => device.deviceId === deviceId
            ? { ...device, revokedAt: Date.now(), online: false }
            : device),
        };
        return current;
      },
      setLaunchAtLogin: async (enabled) => {
        current = { ...current, launchAtLogin: enabled };
        return current;
      },
      request: async (request) => {
        if (request.method === "session.open") {
          return response(request, { session: current.sessions[0], history, latestSeq: current.latestSeq });
        }
        if (request.method === "session.create") {
          return response(request, { session: current.sessions[1] });
        }
        if (request.method === "session.configuration") {
          return response(request, { configuration: currentConfiguration });
        }
        if (request.method === "session.configure") {
          currentConfiguration = {
            ...currentConfiguration,
            ...(typeof request.params.model === "string" ? { model: request.params.model, overrideModel: request.params.model } : {}),
            ...(typeof request.params.effort === "string" ? { effort: request.params.effort, overrideEffort: request.params.effort } : {}),
          };
          return response(request, { configuration: currentConfiguration, session: current.sessions[0] });
        }
        if (request.method === "turn.interrupt") return response(request, { interrupted: true });
        if (request.method === "permission.resolve") return response(request, { resolved: true });
        return response(request, { commandId: "desktop-command", state: "queued" });
      },
      exportDiagnostics: async () => ({ saved: true, path: "/tmp/bridge-diagnostics.json" }),
      onSnapshot: (listener) => {
        snapshotListeners.add(listener);
        return () => snapshotListeners.delete(listener);
      },
      onEvent: (listener) => {
        eventListeners.add(listener);
        return () => eventListeners.delete(listener);
      },
    };
  }, { snapshot: desktopSnapshot, pairingUrl, history, sessionConfiguration });
  await desktop.goto(baseUrl, { waitUntil: "networkidle" });
  await desktop.getByRole("heading", { name: "会话", exact: true }).waitFor();
  await desktop.getByText("会话内核已接管相同 sessionId，正在验证实时事件与审批。").waitFor();
  await checkPage(desktop, "desktop sessions");
  await desktop.screenshot({ path: resolve(artifactDir, "desktop-sessions-1200x800.png"), fullPage: true });
  await desktop.getByRole("button", { name: "模型与 Effort" }).click();
  await desktop.getByText("Claude Host 实时用量").waitFor();
  await checkPage(desktop, "desktop session configuration");
  await desktop.screenshot({ path: resolve(artifactDir, "desktop-session-configuration-1200x800.png"), fullPage: true });
  await desktop.getByRole("button", { name: "关闭" }).click();

  await desktop.getByRole("button", { name: "设备", exact: true }).click();
  await desktop.getByRole("heading", { name: "设备", exact: true }).waitFor();
  await desktop.getByRole("button", { name: "添加手机" }).click();
  await desktop.getByText("一次性配对").waitFor();
  await checkPage(desktop, "desktop devices");
  await desktop.screenshot({ path: resolve(artifactDir, "desktop-devices-1200x800.png"), fullPage: true });

  await desktop.getByRole("button", { name: "状态", exact: true }).click();
  await desktop.getByRole("heading", { name: "状态", exact: true }).waitFor();
  await checkPage(desktop, "desktop status");
  await desktop.screenshot({ path: resolve(artifactDir, "desktop-status-1200x800.png"), fullPage: true });

  await desktop.setViewportSize({ width: 860, height: 620 });
  await checkPage(desktop, "desktop minimum viewport");
  await desktop.screenshot({ path: resolve(artifactDir, "desktop-status-860x620.png"), fullPage: true });
  await desktopContext.close();
} finally {
  desktopSocket.close();
  await browser.close();
}

if (errors.length > 0) {
  process.stderr.write(`${errors.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(`Visual QA passed. Screenshots: ${artifactDir}\n`);
