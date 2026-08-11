import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import {
  BridgeCrypto,
  BridgeSocket,
  buildPairingUrl,
} from "../packages/protocol/dist/index.js";

const baseUrl = process.env.BRIDGE_QA_URL ?? "http://127.0.0.1:5188";
const relayUrl = process.env.BRIDGE_QA_RELAY ?? "ws://127.0.0.1:8788/ws";
function defaultChromePath() {
  const candidates = process.platform === "win32"
    ? [
        join(process.env.PROGRAMFILES ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
        join(process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
        join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Google", "Chrome", "Application", "chrome.exe"),
      ]
    : process.platform === "darwin"
      ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
      : [
          "/usr/bin/google-chrome",
          "/usr/bin/google-chrome-stable",
          "/usr/bin/chromium",
          "/usr/bin/chromium-browser",
        ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}
const chrome = process.env.CHROME_PATH ?? defaultChromePath();
const artifactDir = resolve("artifacts", "visual-qa");
const axePath = resolve("node_modules", "axe-core", "axe.min.js");
const errors = [];
const now = Date.now();

await mkdir(artifactDir, { recursive: true });

const project = {
  projectId: "project-bridge",
  name: "Claude Bridge",
  cwd: "/Users/martinez/Documents/Claude Bridge",
  runtimeId: "claude-desktop",
  sessionCount: 2,
  runningCount: 1,
  pendingCount: 1,
  lastActivityAt: now,
};
const secondaryProject = {
  projectId: "project-pms",
  name: "ega-pms",
  cwd: "/Users/martinez/Desktop/ega-pms",
  runtimeId: "claude-desktop",
  sessionCount: 1,
  runningCount: 0,
  pendingCount: 0,
  lastActivityAt: now - 3_600_000,
};
const codexProject = {
  projectId: "codex-desktop:/Users/martinez/Documents/Claude Bridge",
  name: "Claude Bridge",
  cwd: "/Users/martinez/Documents/Claude Bridge",
  runtimeId: "codex-desktop",
  sessionCount: 1,
  runningCount: 0,
  pendingCount: 0,
  lastActivityAt: now - 2_400_000,
};
const hermesProject = {
  projectId: "hermes-desktop:/Users/martinez/Documents/Claude Bridge",
  name: "Claude Bridge",
  cwd: "/Users/martinez/Documents/Claude Bridge",
  runtimeId: "hermes-desktop",
  sessionCount: 1,
  runningCount: 0,
  pendingCount: 0,
  lastActivityAt: now - 3_000_000,
};
const providerProfiles = [
  {
    id: "provider:claude-3p:default",
    kind: "claude-3p",
    name: "Claude-3p",
    status: "ready",
    detail: "Agent SDK 与 Claude-3p Host Credentials 已就绪。",
    configured: true,
    localOnlyConfiguration: false,
    readOnly: false,
    models: [],
    refreshedAt: now,
  },
  {
    id: "provider:anthropic-api:default",
    kind: "anthropic-api",
    name: "Anthropic API",
    status: "needs-configuration",
    detail: "需要在电脑端输入 Claude Console API Key。",
    configured: false,
    localOnlyConfiguration: true,
    readOnly: false,
    models: [],
    refreshedAt: now,
  },
  {
    id: "provider:claude-official:default",
    kind: "claude-official",
    name: "Claude 官方订阅",
    status: "ready",
    detail: "通过 Claude 公开 Deep Link 接力；激活后 Bridge 只读观察。",
    configured: true,
    localOnlyConfiguration: false,
    readOnly: true,
    models: [],
    refreshedAt: now,
  },
];
function writableRoute(sessionId) {
  return {
    activeLaneId: `lane:claude-3p:${sessionId}`,
    activeProviderProfileId: "provider:claude-3p:default",
    routeState: "ready",
    allowedActions: {
      canSend: true,
      canSteer: true,
      canInterrupt: true,
      canSwitchProvider: true,
      canContinueOfficial: false,
      canConfigure: true,
    },
  };
}
const sessions = [
  {
    sessionId: "session-running",
    projectId: project.projectId,
    projectName: project.name,
    cwd: project.cwd,
    title: "Bridge 0.6 Windows 安装目录选择",
    source: "desktop",
    ownership: "BRIDGE_RUNNING",
    turnState: "running",
    lastActivityAt: now,
    pendingCount: 1,
    activeTurnId: "turn-active",
    currentSummary: "验证手机与电脑共享同一条事件流",
    model: "claude-fable-5[1m]",
    effort: "high",
    ...writableRoute("session-running"),
  },
  {
    sessionId: "session-idle",
    projectId: project.projectId,
    projectName: project.name,
    cwd: project.cwd,
    title: "协议 V3 与设备安全",
    source: "desktop",
    ownership: "DESKTOP_OBSERVED",
    turnState: "idle",
    lastActivityAt: now - 1_800_000,
    pendingCount: 0,
    model: "claude-sonnet-5",
    effort: "medium",
    ...writableRoute("session-idle"),
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
    ...writableRoute("session-pms"),
  },
  {
    sessionId: "codex-desktop:thread-visual",
    runtimeId: "codex-desktop",
    nativeSessionId: "thread-visual",
    projectId: codexProject.projectId,
    projectName: codexProject.name,
    cwd: codexProject.cwd,
    title: "Codex Desktop 独立任务",
    source: "desktop",
    transport: "codex-app-server",
    ownership: "BRIDGE_IDLE",
    turnState: "idle",
    lastActivityAt: codexProject.lastActivityAt,
    pendingCount: 0,
    allowedActions: {
      canSend: true,
      canSteer: true,
      canInterrupt: true,
      canSwitchProvider: false,
      canContinueOfficial: false,
      canConfigure: true,
    },
  },
  {
    sessionId: "hermes-desktop:session-visual",
    runtimeId: "hermes-desktop",
    nativeSessionId: "session-visual",
    projectId: hermesProject.projectId,
    projectName: hermesProject.name,
    cwd: hermesProject.cwd,
    title: "Hermes Desktop 独立任务",
    source: "desktop",
    transport: "hermes-gateway",
    ownership: "BRIDGE_IDLE",
    turnState: "idle",
    lastActivityAt: hermesProject.lastActivityAt,
    pendingCount: 0,
    allowedActions: {
      canSend: true,
      canSteer: true,
      canInterrupt: true,
      canSwitchProvider: false,
      canContinueOfficial: false,
      canConfigure: true,
    },
  },
];
const history = {
  sessionId: "session-running",
  items: [
    {
      id: "history-user",
      sessionId: "session-running",
      turnId: "turn-evidence",
      role: "user",
      text: "把 Bridge 重构为同一会话的远程控制客户端。",
      createdAt: now - 120_000,
      origin: "claude-desktop",
    },
    {
      id: "history-assistant",
      sessionId: "session-running",
      turnId: "turn-evidence",
      role: "assistant",
      text: "会话内核已接管相同 sessionId，正在验证实时事件与审批。",
      createdAt: now - 90_000,
      origin: "claude-host",
    },
    {
      id: "history-current-user",
      sessionId: "session-running",
      turnId: "turn-active",
      role: "user",
      text: "继续执行当前验证任务。",
      createdAt: now - 45_000,
      origin: "mobile",
    },
    {
      id: "history-tool",
      sessionId: "session-running",
      turnId: "turn-active",
      role: "tool",
      text: "npm run verify: 24 tests passed",
      createdAt: now - 30_000,
      origin: "claude-host",
      toolName: "Bash",
      state: "running",
    },
  ],
  hasMore: true,
  nextCursor: "older-page",
};
const evidence = {
  sessionId: "session-running",
  items: [
    {
      id: "evidence-exact",
      sessionId: "session-running",
      turnId: "turn-evidence",
      source: "bridge-host",
      confidence: "exact",
      state: "ready",
      startedAt: now - 82_000,
      completedAt: now - 20_000,
      toolCount: 2,
      changeCount: 3,
      artifactCount: 3,
      tools: [
        {
          id: "tool-test",
          toolName: "Bash",
          status: "completed",
          summary: "npm run test",
          startedAt: now - 78_000,
          completedAt: now - 65_000,
          exitCode: 0,
          outputSummary: "104 tests passed",
          truncated: false,
        },
        {
          id: "tool-build",
          toolName: "Bash",
          status: "failed",
          summary: "npm run build:preview",
          startedAt: now - 60_000,
          completedAt: now - 55_000,
          exitCode: 1,
          outputSummary: "Preview command exited with code 1",
          truncated: false,
        },
      ],
      artifacts: [
        {
          id: "artifact-diff",
          evidenceId: "evidence-exact",
          relativePath: "apps/desktop/src/evidence-manager.ts",
          name: "evidence-manager.ts",
          kind: "code",
          changeKind: "modified",
          mimeType: "text/plain",
          size: 18_420,
          sha256: "f".repeat(64),
          availability: "snapshot",
          previewMode: "diff",
          downloadAllowed: true,
          capturedAt: now - 20_000,
        },
        {
          id: "artifact-image",
          evidenceId: "evidence-exact",
          relativePath: "artifacts/visual-qa/evidence-mobile.png",
          name: "evidence-mobile.png",
          kind: "image",
          changeKind: "created",
          mimeType: "image/png",
          size: 428_160,
          sha256: "e".repeat(64),
          availability: "snapshot",
          previewMode: "image",
          downloadAllowed: true,
          capturedAt: now - 20_000,
        },
        {
          id: "artifact-pdf",
          evidenceId: "evidence-exact",
          relativePath: "artifacts/release/V0.4.2-acceptance.pdf",
          name: "V0.4.2-acceptance.pdf",
          kind: "pdf",
          changeKind: "created",
          mimeType: "application/pdf",
          size: 1_284_992,
          sha256: "d".repeat(64),
          availability: "snapshot",
          previewMode: "none",
          downloadAllowed: true,
          capturedAt: now - 20_000,
        },
      ],
      warnings: [],
    },
    {
      id: "evidence-inferred",
      sessionId: "session-running",
      turnId: "turn-desktop",
      source: "claude-desktop",
      confidence: "inferred",
      state: "ready",
      startedAt: now - 1_200_000,
      completedAt: now - 1_100_000,
      toolCount: 1,
      changeCount: 1,
      artifactCount: 1,
      tools: [{
        id: "tool-desktop",
        toolName: "Write",
        status: "completed",
        summary: "写入 docs/SECURITY.md",
        startedAt: now - 1_190_000,
        completedAt: now - 1_180_000,
        truncated: false,
      }],
      artifacts: [{
        id: "artifact-inferred",
        evidenceId: "evidence-inferred",
        relativePath: "docs/SECURITY.md",
        name: "SECURITY.md",
        kind: "code",
        changeKind: "observed",
        mimeType: "text/plain",
        size: 0,
        availability: "current-file",
        previewMode: "text",
        downloadAllowed: false,
      }],
      warnings: ["来自 Claude Desktop 事后记录，不代表实时或完整工作区差异"],
    },
    {
      id: "evidence-collecting",
      sessionId: "session-running",
      turnId: "turn-active",
      source: "bridge-host",
      confidence: "exact",
      state: "collecting",
      startedAt: now - 45_000,
      toolCount: 1,
      changeCount: 0,
      artifactCount: 0,
      tools: [],
      artifacts: [],
      warnings: [],
    },
  ],
  hasMore: false,
};
const artifactPreview = {
  artifactId: "artifact-diff",
  mode: "diff",
  mimeType: "text/x-diff",
  encoding: "utf8",
  data: [
    "--- a/apps/desktop/src/evidence-manager.ts",
    "+++ b/apps/desktop/src/evidence-manager.ts",
    "@@ -1,3 +1,4 @@",
    "+const PROTOCOL_VERSION = 3;",
    " const evidence = true;",
  ].join("\n"),
  truncated: false,
  generatedAt: now,
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
  permissionPolicy: {
    hostMode: "standard",
    effectiveMode: "standard",
    source: "host",
  },
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
    hostId: desktopCrypto.identity.hostId ?? desktopCrypto.identity.deviceId,
    name: "Martinez-MacBook-Pro",
    relayUrl,
    online: true,
    lastSeenAt: now,
    version: "0.6.0",
    pairingEpoch: 1,
    capabilities: [
      "evidence.v1",
      "artifact.preview.v1",
      "artifact.transfer.v1",
      "provider.profile.v1",
      "conversation.lanes.v1",
      "conversation.handoff.v1",
      "permission.policy.v1",
      "runtime.adapter.v1",
      "session.visibility.v1",
    ],
    defaultPermissionMode: "standard",
  },
  projects: [project, secondaryProject, codexProject, hermesProject],
  sessions,
  desktopApps: [
    {
      id: "claude-desktop",
      name: "Claude Desktop",
      state: "running",
      detail: "Claude Desktop 正在运行。",
      canLaunch: false,
      canQuit: true,
    },
    {
      id: "codex-desktop",
      name: "Codex（ChatGPT）",
      state: "running",
      detail: "Codex（ChatGPT）正在运行。",
      canLaunch: false,
      canQuit: true,
    },
    {
      id: "hermes-desktop",
      name: "Hermes",
      state: "running",
      detail: "Hermes 正在运行。",
      canLaunch: false,
      canQuit: true,
    },
  ],
  runtimes: [
    {
      id: "claude-desktop",
      name: "Claude Desktop",
      state: "ready",
      detail: "Claude Desktop 已接入。",
      capabilities: ["session.list", "session.create", "session.history", "turn.start", "turn.steer", "turn.interrupt", "permission.resolve", "tool.events", "attachment.image"],
      sessionIsolation: "independent",
      sessionCount: 3,
      updatedAt: now,
    },
    {
      id: "codex-desktop",
      name: "Codex Desktop",
      state: "ready",
      detail: "Codex app-server 已接入。",
      capabilities: ["session.list", "session.create", "session.history", "turn.start", "turn.steer", "turn.interrupt", "permission.resolve", "tool.events"],
      sessionIsolation: "independent",
      sessionCount: 1,
      updatedAt: now,
    },
    {
      id: "hermes-desktop",
      name: "Hermes Desktop",
      state: "ready",
      detail: "Hermes Gateway 已接入。",
      capabilities: ["session.list", "session.create", "session.history", "turn.start", "turn.steer", "turn.interrupt", "permission.resolve", "tool.events"],
      sessionIsolation: "independent",
      sessionCount: 1,
      updatedAt: now,
    },
  ],
  providers: providerProfiles,
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
  transport: {
    path: "direct",
    state: "connected",
    rttMs: 18,
    lastConnectedAt: now,
    pendingCount: 0,
    relayHealthy: true,
  },
  claudeDesktop: {
    state: "running",
    detail: "Claude Desktop 正在运行。",
    canLaunch: false,
    canQuit: true,
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
    } else if (request.method === "snapshot.get") {
      result = { snapshot: hostSnapshot };
    } else if (request.method === "session.open") {
      const session = sessions.find((candidate) => candidate.sessionId === request.params.sessionId) ?? sessions[0];
      result = {
        session,
        history: session.sessionId === history.sessionId
          ? history
          : { sessionId: session.sessionId, items: [], hasMore: false },
        latestSeq: eventSeq,
      };
    } else if (request.method === "evidence.list") {
      result = { evidence };
    } else if (request.method === "artifact.preview") {
      result = { preview: artifactPreview };
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
    } else if (request.method === "permission.policy.configure") {
      const mode = request.params.mode;
      const scope = request.params.scope;
      const hostMode = scope === "host" && typeof mode === "string"
        ? mode
        : sessionConfiguration.permissionPolicy.hostMode;
      const sessionMode = scope === "session" && typeof mode === "string" ? mode : undefined;
      sessionConfiguration = {
        ...sessionConfiguration,
        permissionPolicy: {
          hostMode,
          ...(sessionMode ? { sessionMode } : {}),
          effectiveMode: sessionMode ?? hostMode,
          source: sessionMode ? "session" : "host",
        },
      };
      hostSnapshot.host.defaultPermissionMode = hostMode;
      result = {
        configuration: sessionConfiguration,
        defaultPermissionMode: hostMode,
        resolvedPending: 0,
      };
    } else if (request.method === "project.list") {
      result = { projects: hostSnapshot.projects };
    } else if (request.method === "session.list") {
      result = { sessions: hostSnapshot.sessions };
    } else if (request.method === "provider.refresh" || request.method === "provider.list") {
      result = { providers: hostSnapshot.providers };
    } else if (request.method === "claude.desktop.status") {
      result = { claudeDesktop: hostSnapshot.claudeDesktop };
    } else if (request.method === "claude.desktop.launch") {
      hostSnapshot.claudeDesktop = {
        state: "running",
        detail: "Claude Desktop 正在运行。",
        canLaunch: false,
        canQuit: true,
      };
      result = { claudeDesktop: hostSnapshot.claudeDesktop };
    } else if (request.method === "claude.desktop.quit") {
      hostSnapshot.claudeDesktop = {
        state: "stopped",
        detail: "Claude Desktop 已退出，Bridge 仍可继续处理远程会话。",
        canLaunch: true,
        canQuit: false,
      };
      result = { claudeDesktop: hostSnapshot.claudeDesktop };
    } else if (request.method === "desktop.app.status") {
      result = { desktopApps: hostSnapshot.desktopApps };
    } else if (request.method === "desktop.app.launch" || request.method === "desktop.app.quit") {
      const runtimeId = request.params.runtimeId;
      const app = hostSnapshot.desktopApps.find((candidate) => candidate.id === runtimeId);
      if (app) {
        const launching = request.method === "desktop.app.launch";
        Object.assign(app, {
          state: launching ? "running" : "stopped",
          detail: launching ? `${app.name} 正在运行。` : `${app.name} 已退出，Bridge 仍可继续处理远程会话。`,
          canLaunch: !launching,
          canQuit: launching,
        });
        if (runtimeId === "claude-desktop") hostSnapshot.claudeDesktop = app;
      }
      result = { desktopApps: hostSnapshot.desktopApps };
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
    if (request.method.startsWith("claude.desktop.") || request.method.startsWith("desktop.app.")) {
      await sendToMobile({ kind: "snapshot", snapshot: hostSnapshot }, message.header.fromDeviceId);
    }
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
  const waitingSessionRow = mobile.locator(".session-row-v2").filter({ hasText: "Bridge 0.6 Windows 安装目录选择" });
  await waitingSessionRow.waitFor();
  if (await mobile.locator(".session-row-v2").count() !== 5) {
    errors.push("mobile catalog: expected five expanded session rows");
  }
  const mobileRuntimeFilter = mobile.getByRole("navigation", { name: "Desktop 运行时筛选" });
  await mobileRuntimeFilter.getByRole("button", { name: "Codex Desktop", exact: true }).click();
  await mobile.getByText("Codex Desktop 独立任务", { exact: true }).waitFor();
  if (await mobile.locator(".session-row-v2").count() !== 1) {
    errors.push("mobile runtime filter: Codex should show one isolated session");
  }
  await mobileRuntimeFilter.getByRole("button", { name: "Hermes Desktop", exact: true }).click();
  await mobile.getByText("Hermes Desktop 独立任务", { exact: true }).waitFor();
  if (await mobile.locator(".session-row-v2").count() !== 1) {
    errors.push("mobile runtime filter: Hermes should show one isolated session");
  }
  await mobileRuntimeFilter.getByRole("button", { name: "全部", exact: true }).click();
  await mobile.getByRole("button", { name: "全部折叠" }).click();
  if (await mobile.locator(".session-row-v2").count() !== 0) {
    errors.push("mobile catalog: collapse all did not hide every session row");
  }
  await mobile.getByRole("button", { name: "全部展开" }).click();
  await waitingSessionRow.waitFor();
  const claudeMobileControl = mobile.locator(".mobile-desktop-control").filter({ hasText: "Claude Desktop" }).first();
  await claudeMobileControl.getByRole("button", { name: "退出", exact: true }).click();
  await mobile.getByRole("button", { name: "退出 Claude Desktop", exact: true }).click();
  await mobile.getByText("Claude Desktop 已退出，Bridge 仍可继续处理远程会话。").waitFor();
  await claudeMobileControl.getByRole("button", { name: "启动", exact: true }).click();
  await mobile.getByText("Claude Desktop 正在运行。").waitFor();
  await checkPage(mobile, "mobile catalog");
  await mobile.screenshot({ path: resolve(artifactDir, "mobile-catalog-390x844.png"), fullPage: true });

  await waitingSessionRow.click();
  await mobile.getByText("会话内核已接管相同 sessionId，正在验证实时事件与审批。").waitFor();
  if (await mobile.locator(".evidence-inline-summary").count() !== 1) {
    errors.push("mobile conversation: evidence summaries were not anchored to completed turns");
  }
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
  const livePermissionSheet = mobile.getByRole("dialog", { name: "Claude Desktop 等待授权" });
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

  await mobile.getByRole("button", { name: "Claude-3p", exact: true }).click();
  const mobileProviderDialog = mobile.getByRole("dialog", { name: "切换提供方" });
  await mobileProviderDialog.locator(".provider-option").filter({ hasText: "Anthropic API" }).click();
  await mobileProviderDialog.getByText("需要在电脑端配置 API Key", { exact: true }).waitFor();
  await checkPage(mobile, "mobile provider switching");
  await mobile.screenshot({ path: resolve(artifactDir, "mobile-provider-switch-390x844.png"), fullPage: true });
  await mobileProviderDialog.getByLabel("关闭").click();

  await mobile.getByRole("button", { name: /fable/ }).click();
  await mobile.getByText("Claude Host 实时用量").waitFor();
  await mobile.getByText("授权模式", { exact: true }).waitFor();
  await checkPage(mobile, "mobile session configuration");
  await mobile.screenshot({ path: resolve(artifactDir, "mobile-session-configuration-390x844.png"), fullPage: true });
  await mobile.setViewportSize({ width: 768, height: 1024 });
  await checkPage(mobile, "wide Android session configuration");
  await mobile.screenshot({ path: resolve(artifactDir, "mobile-session-configuration-768x1024.png"), fullPage: true });
  await mobile.setViewportSize({ width: 390, height: 844 });
  await mobile.getByRole("button", { name: "完全授权", exact: true }).click();
  await mobile.getByRole("button", { name: "保存授权模式", exact: true }).click();
  const fullAccessConfirmation = mobile.getByRole("alertdialog", { name: "启用完全授权" });
  await fullAccessConfirmation.waitFor();
  await fullAccessConfirmation.getByRole("button", { name: "启用完全授权", exact: true }).click();
  await mobile.getByText("当前生效：完全授权 · 电脑默认", { exact: true }).waitFor();
  await mobile.getByRole("button", { name: "关闭" }).click();

  await mobile.locator(".session-view-switch").getByRole("button", { name: /^成果/ }).click();
  const mobileExactEvidence = mobile.locator(".evidence-bundle").filter({ hasText: "2 工具" });
  await mobileExactEvidence.locator("summary").click();
  await mobile.getByText("evidence-manager.ts", { exact: true }).waitFor();
  await mobile.getByText("事后恢复", { exact: true }).waitFor();
  await checkPage(mobile, "mobile evidence");
  await mobile.screenshot({ path: resolve(artifactDir, "mobile-evidence-390x844.png"), fullPage: true });
  await mobile.getByLabel("预览 evidence-manager.ts").click();
  await mobile.getByRole("heading", { name: "evidence-manager.ts" }).waitFor();
  await checkPage(mobile, "mobile evidence preview");
  await mobile.screenshot({ path: resolve(artifactDir, "mobile-evidence-preview-390x844.png"), fullPage: true });
  await mobile.getByLabel("关闭预览").click();
  await mobile.getByRole("button", { name: "对话", exact: true }).click();

  await mobile.getByLabel("给 Claude Desktop 发指令").fill("继续验证同一会话的手机消息。");
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
    sessions: [
      {
        ...hostSnapshot.sessions[0],
        ownership: "DESKTOP_OBSERVED",
        turnState: "running",
        pendingCount: 0,
        activeTurnId: undefined,
      },
      {
        ...hostSnapshot.sessions[0],
        sessionId: "session-recovered-blocker",
        title: "未完成任务：覆盖安装前的任务",
        source: "bridge",
        ownership: "BRIDGE_IDLE",
        transport: "bridge-host",
        turnState: "queued",
        pendingCount: 1,
        activeTurnId: undefined,
        currentSummary: "恢复的未完成任务 · 覆盖安装前的任务",
        lastActivityAt: now - 10_000,
        ...writableRoute("session-recovered-blocker"),
        desktopRegistration: {
          state: "restart-required",
          detail: "已写入 Claude Desktop 会话清单，重启后可见。",
          updatedAt: now - 5_000,
          desktopSessionId: "local_session-recovered-blocker",
          registeredAt: now - 5_000,
        },
      },
      ...hostSnapshot.sessions.slice(1),
    ],
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
  await desktop.addInitScript(({
    snapshot,
    pairingUrl,
    history,
    evidence,
    artifactPreview,
    sessionConfiguration,
  }) => {
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
    window.__bridgeQaRequests = [];
    window.__bridgeQaClaudeActions = [];
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
      setAnthropicApiKey: async () => current,
      removeAnthropicApiKey: async () => current,
      launchClaudeDesktop: async () => {
        window.__bridgeQaClaudeActions.push("launch");
        current = {
          ...current,
          claudeDesktop: {
            state: "running",
            detail: "Claude Desktop 正在运行。",
            canLaunch: false,
            canQuit: true,
          },
        };
        for (const listener of snapshotListeners) listener(current);
        return current;
      },
      quitClaudeDesktop: async () => {
        window.__bridgeQaClaudeActions.push("quit");
        current = {
          ...current,
          claudeDesktop: {
            state: "stopped",
            detail: "Claude Desktop 已退出，Bridge 仍可继续处理远程会话。",
            canLaunch: true,
            canQuit: false,
          },
        };
        for (const listener of snapshotListeners) listener(current);
        return current;
      },
      launchDesktopApp: async (runtimeId) => {
        window.__bridgeQaClaudeActions.push(`launch:${runtimeId}`);
        current = {
          ...current,
          desktopApps: current.desktopApps.map((app) => app.id === runtimeId
            ? { ...app, state: "running", detail: `${app.name} 正在运行。`, canLaunch: false, canQuit: true }
            : app),
          ...(runtimeId === "claude-desktop" ? {
            claudeDesktop: {
              state: "running",
              detail: "Claude Desktop 正在运行。",
              canLaunch: false,
              canQuit: true,
            },
          } : {}),
        };
        for (const listener of snapshotListeners) listener(current);
        return current;
      },
      quitDesktopApp: async (runtimeId) => {
        window.__bridgeQaClaudeActions.push(`quit:${runtimeId}`);
        current = {
          ...current,
          desktopApps: current.desktopApps.map((app) => app.id === runtimeId
            ? { ...app, state: "stopped", detail: `${app.name} 已退出，Bridge 仍可继续处理远程会话。`, canLaunch: true, canQuit: false }
            : app),
          ...(runtimeId === "claude-desktop" ? {
            claudeDesktop: {
              state: "stopped",
              detail: "Claude Desktop 已退出，Bridge 仍可继续处理远程会话。",
              canLaunch: true,
              canQuit: false,
            },
          } : {}),
        };
        for (const listener of snapshotListeners) listener(current);
        return current;
      },
      request: async (request) => {
        window.__bridgeQaRequests.push(request);
        if (request.method === "session.open") {
          const session = current.sessions.find((candidate) => candidate.sessionId === request.params.sessionId) ?? current.sessions[0];
          return response(request, {
            session,
            history: session.sessionId === history.sessionId
              ? history
              : { sessionId: session.sessionId, items: [], hasMore: false },
            latestSeq: current.latestSeq,
          });
        }
        if (request.method === "evidence.list") {
          return response(request, { evidence });
        }
        if (request.method === "artifact.preview") {
          return response(request, { preview: artifactPreview });
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
        if (request.method === "permission.policy.configure") {
          const mode = request.params.mode;
          const scope = request.params.scope;
          const hostMode = scope === "host" && typeof mode === "string"
            ? mode
            : currentConfiguration.permissionPolicy.hostMode;
          const sessionMode = scope === "session" && typeof mode === "string" ? mode : undefined;
          currentConfiguration = {
            ...currentConfiguration,
            permissionPolicy: {
              hostMode,
              ...(sessionMode ? { sessionMode } : {}),
              effectiveMode: sessionMode ?? hostMode,
              source: sessionMode ? "session" : "host",
            },
          };
          current = {
            ...current,
            host: { ...current.host, defaultPermissionMode: hostMode },
          };
          return response(request, { configuration: currentConfiguration, defaultPermissionMode: hostMode });
        }
        if (request.method === "provider.refresh" || request.method === "provider.list") {
          return response(request, { providers: current.providers });
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
  }, {
    snapshot: desktopSnapshot,
    pairingUrl,
    history,
    evidence,
    artifactPreview,
    sessionConfiguration,
  });
  await desktop.goto(baseUrl, { waitUntil: "networkidle" });
  await desktop.getByRole("heading", { name: "会话", exact: true }).waitFor();
  await desktop.getByText("会话内核已接管相同 sessionId，正在验证实时事件与审批。").waitFor();
  const desktopStop = desktop.getByRole("button", { name: "停止阻塞的 Bridge 任务" });
  await desktopStop.waitFor();
  await desktopStop.click();
  const forceStopSent = await desktop.evaluate(() => (
    window.__bridgeQaRequests.some((request) => (
      request.method === "turn.interrupt"
      && request.params.force === true
      && request.params.sessionId === "session-recovered-blocker"
    ))
  ));
  if (!forceStopSent) errors.push("desktop blocker stop: recovered queue was not force interrupted");
  if (await desktop.locator(".evidence-inline-summary").count() !== 1) {
    errors.push("desktop conversation: evidence summaries were not anchored to completed turns");
  }
  await desktop.getByText("未完成任务：覆盖安装前的任务", { exact: true }).click();
  await desktop.locator(".desktop-conversation-heading").getByText(/等待 Desktop 重启/).waitFor();
  await desktop.getByRole("button", { name: "重启并登记" }).click();
  const registrationRestarted = await desktop.evaluate(() => (
    window.__bridgeQaClaudeActions.join(",") === "quit,launch"
    && window.__bridgeQaRequests.some((request) => (
      request.method === "session.desktop.register"
      && request.params.sessionId === "session-recovered-blocker"
    ))
  ));
  if (!registrationRestarted) {
    errors.push("desktop registration: restart and registration request were not completed");
  }
  if (await desktop.locator(".desktop-session-row").count() !== 6) {
    errors.push("desktop sessions: expected six expanded session rows");
  }
  await desktop.getByRole("button", { name: "全部折叠" }).click();
  if (await desktop.locator(".desktop-session-row").count() !== 0) {
    errors.push("desktop sessions: collapse all did not hide every session row");
  }
  await desktop.getByRole("button", { name: "全部展开" }).click();
  await desktop.locator(".desktop-session-row").first().waitFor();
  const desktopRuntimeFilter = desktop.locator(".desktop-runtime-filter");
  await desktopRuntimeFilter.getByRole("button", { name: "Codex Desktop", exact: true }).click();
  await desktop.getByText("Codex Desktop 独立任务", { exact: true }).waitFor();
  if (await desktop.locator(".desktop-session-row").count() !== 1) {
    errors.push("desktop runtime filter: Codex should show one isolated session");
  }
  await desktopRuntimeFilter.getByRole("button", { name: "Hermes Desktop", exact: true }).click();
  await desktop.getByText("Hermes Desktop 独立任务", { exact: true }).waitFor();
  if (await desktop.locator(".desktop-session-row").count() !== 1) {
    errors.push("desktop runtime filter: Hermes should show one isolated session");
  }
  await desktopRuntimeFilter.getByRole("button", { name: "全部", exact: true }).click();
  await desktop.locator(".desktop-session-row").first().waitFor();
  await checkPage(desktop, "desktop sessions");
  await desktop.screenshot({ path: resolve(artifactDir, "desktop-sessions-1200x800.png"), fullPage: true });
  await desktop.getByRole("button", { name: "切换执行提供方" }).click();
  const desktopProviderDialog = desktop.getByRole("dialog", { name: "切换提供方" });
  await desktopProviderDialog.locator(".provider-option").filter({ hasText: "Anthropic API" }).click();
  await desktopProviderDialog.getByText("在此电脑配置 API Key", { exact: true }).waitFor();
  await checkPage(desktop, "desktop provider switching");
  await desktop.screenshot({ path: resolve(artifactDir, "desktop-provider-switch-1200x800.png"), fullPage: true });
  await desktopProviderDialog.getByLabel("关闭").click();
  await desktop.getByRole("button", { name: "模型与运行模式" }).click();
  await desktop.getByText("Claude Host 实时用量").waitFor();
  await desktop.getByText("授权模式", { exact: true }).waitFor();
  await checkPage(desktop, "desktop session configuration");
  await desktop.screenshot({ path: resolve(artifactDir, "desktop-session-configuration-1200x800.png"), fullPage: true });
  await desktop.getByRole("button", { name: "关闭" }).click();
  await desktop.locator(".session-view-switch").getByRole("button", { name: /^成果/ }).click();
  const desktopExactEvidence = desktop.locator(".evidence-bundle").filter({ hasText: "2 工具" });
  await desktopExactEvidence.locator("summary").click();
  await desktop.getByText("evidence-manager.ts", { exact: true }).waitFor();
  await checkPage(desktop, "desktop evidence");
  await desktop.screenshot({ path: resolve(artifactDir, "desktop-evidence-1200x800.png"), fullPage: true });
  await desktop.getByLabel("预览 evidence-manager.ts").click();
  await desktop.getByRole("heading", { name: "evidence-manager.ts" }).waitFor();
  await checkPage(desktop, "desktop evidence preview");
  await desktop.screenshot({ path: resolve(artifactDir, "desktop-evidence-preview-1200x800.png"), fullPage: true });
  await desktop.getByLabel("关闭预览").click();

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
