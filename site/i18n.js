const I18N = {
  "brand.home": {
    en: "Bridge home",
    zh: "Bridge 首页"
  },
  "nav.features": { en: "Features", zh: "功能" },
  "nav.architecture": { en: "Architecture", zh: "架构" },
  "nav.security": { en: "Security", zh: "安全" },
  "nav.download": { en: "Download", zh: "下载" },
  "hero.eyebrow": {
    en: "Open source \u00B7 MIT \u00B7 End-to-end encrypted",
    zh: "开源 \u00B7 MIT \u00B7 端到端加密"
  },
  "hero.lede": {
    en: "One encrypted remote for Claude, Codex, and Hermes Desktop.",
    zh: "一个加密遥控，接管 Claude、Codex 和 Hermes Desktop。"
  },
  "hero.text": {
    en: "Control desktop AI agents from your phone, keep every native session, account, model, and permission separate, and hand work between desktops only when you explicitly approve it.",
    zh: "在手机上控制桌面 AI Agent，同时保持每个原生会话、账号、模型和权限相互独立；只有你明确确认后，才把任务交给另一台桌面接手。"
  },
  "hero.download": { en: "Download", zh: "下载" },
  "hero.github": { en: "View on GitHub", zh: "查看 GitHub" },
  "hero.alt": {
    en: "Bridge remote control for Claude, Codex, and Hermes Desktop",
    zh: "Bridge：Claude、Codex 和 Hermes Desktop 的加密遥控"
  },
  "features.eyebrow": { en: "What it does", zh: "它能做什么" },
  "features.title": {
    en: "Unified control. Separate native worlds.",
    zh: "统一控制，各自独立。"
  },
  "features.subtitle": {
    en: "Bridge is not a remote desktop and not an input automator. It is a protocol and host layer that gives one consistent interface to three desktop runtimes.",
    zh: "Bridge 不是远程桌面，也不是输入自动化工具。它是一层协议和 Host，为三种桌面运行时提供一致的接口。"
  },
  "features.one.title": { en: "One session surface", zh: "统一的会话界面" },
  "features.one.text": {
    en: "Send, stream, approve, ask, steer, and stop Claude, Codex, and Hermes sessions from desktop or mobile.",
    zh: "在桌面或手机发送、流式输出、审批、追问、调整和停止 Claude、Codex、Hermes 会话。"
  },
  "features.two.title": { en: "End-to-end encryption", zh: "端到端加密" },
  "features.two.text": {
    en: "Per-device AES-256-GCM keys, WebRTC direct connections, and an encrypted WSS relay that never sees message content.",
    zh: "每台设备独立 AES-256-GCM 密钥，优先 WebRTC 直连，回退到永远看不到消息内容的加密 WSS 中继。"
  },
  "features.three.title": { en: "Cross-desktop relay", zh: "跨 Desktop 接力" },
  "features.three.text": {
    en: "Hand a bounded, redacted, encrypted task context to another runtime after two human confirmations and a read-only plan.",
    zh: "经过两次人工确认和只读计划后，把有界、脱敏、加密的任务上下文交给另一个运行时。"
  },
  "features.four.title": { en: "Local-first adapters", zh: "本地优先适配器" },
  "features.four.text": {
    en: "Claude Agent SDK, official Codex app-server over stdio, and a loopback-only Hermes Gateway with process-scoped tokens.",
    zh: "Claude 使用 Agent SDK，Codex 使用官方 app-server stdio 接口，Hermes 使用仅环回、带进程级令牌的 Gateway。"
  },
  "features.five.title": { en: "Real evidence", zh: "真实成果" },
  "features.five.text": {
    en: "Image attachments, file-change summaries, artifact previews, and host-side file opening render as actual content, not paths.",
    zh: "图片附件、文件变更摘要、成果预览和主机端文件打开都以真实内容呈现，而不是一串路径。"
  },
  "features.six.title": { en: "Built to recover", zh: "为恢复而设计" },
  "features.six.text": {
    en: "Offline queues, event replay, push wake, fast reconnect, session archive, delete, and crash-safe relay recovery.",
    zh: "离线队列、事件重放、推送唤醒、快速重连、会话归档/删除，以及崩溃安全的接力恢复。"
  },
  "architecture.eyebrow": { en: "Architecture", zh: "架构" },
  "architecture.title": {
    en: "Phone, desktop host, and relay.",
    zh: "手机、桌面 Host 与中继。"
  },
  "architecture.subtitle": {
    en: "Devices prefer a direct WebRTC data channel. When they cannot connect directly, traffic falls back to a self-hostable relay that stores only ciphertext and routing metadata.",
    zh: "设备优先建立 WebRTC 直连；无法直连时，流量回退到可自托管的中继，中继只保存密文和路由元数据。"
  },
  "architecture.diagram.aria": {
    en: "Architecture diagram showing mobile clients connecting to Bridge Desktop through WebRTC or an encrypted relay, with adapters for Claude, Codex, and Hermes",
    zh: "架构图：移动端通过 WebRTC 或加密中继连接 Bridge Desktop，并接入 Claude、Codex、Hermes 适配器"
  },
  "architecture.note": {
    en: 'Read the full <a href="https://github.com/czhmartinez/claude-desktop-bridge/blob/main/docs/ARCHITECTURE.md">architecture document</a> for adapter contracts, ownership states, and the relay state machine.',
    zh: '查看完整 <a href="https://github.com/czhmartinez/claude-desktop-bridge/blob/main/docs/ARCHITECTURE.md">架构文档</a>，了解 adapter 契约、会话所有权和接力状态机。'
  },
  "security.eyebrow": { en: "Security", zh: "安全" },
  "security.title": {
    en: "Safe boundaries are a product feature.",
    zh: "安全边界本身就是产品功能。"
  },
  "security.subtitle": {
    en: "Bridge deliberately refuses the shortcuts that make agent remotes risky.",
    zh: "Bridge 刻意拒绝那些让 Agent 远程控制变得危险的捷径。"
  },
  "security.one.title": { en: "No accessibility access", zh: "不使用辅助功能权限" },
  "security.one.text": {
    en: "No synthetic clicks, keyboard events, or clipboard reads.",
    zh: "不做模拟点击、键鼠事件或剪贴板读取。"
  },
  "security.two.title": { en: "No private CDP", zh: "不使用私有 CDP" },
  "security.two.text": {
    en: "Bridge uses public interfaces and read-only transcript observation.",
    zh: "Bridge 只使用公开接口和只读 transcript 观察。"
  },
  "security.three.title": { en: "No OAuth extraction", zh: "不提取 OAuth" },
  "security.three.text": {
    en: "Credentials stay inside each desktop runtime.",
    zh: "凭据始终留在各自的桌面运行时内。"
  },
  "security.four.title": {
    en: "No hidden chain-of-thought",
    zh: "不读取隐藏思考过程"
  },
  "security.four.text": {
    en: "Only bounded, user-visible context travels between devices.",
    zh: "只有有界、用户可见的上下文才会在设备间传输。"
  },
  "security.five.title": { en: "No automatic failover", zh: "不自动故障转移" },
  "security.five.text": {
    en: "Cross-desktop relay always waits for explicit human approval.",
    zh: "跨 Desktop 接力始终等待用户明确确认。"
  },
  "security.six.title": { en: "No credential migration", zh: "不迁移凭据" },
  "security.six.text": {
    en: "Relay packages never contain keys, OAuth tokens, or API secrets.",
    zh: "接力包永远不包含密钥、OAuth token 或 API 密钥。"
  },
  "security.note": {
    en: 'Full details in the <a href="https://github.com/czhmartinez/claude-desktop-bridge/blob/main/docs/SECURITY.md">security model</a>.',
    zh: '完整细节见<a href="https://github.com/czhmartinez/claude-desktop-bridge/blob/main/docs/SECURITY.md">安全模型</a>。'
  },
  "download.eyebrow": { en: "Download", zh: "下载" },
  "download.title": { en: "Try it today.", zh: "现在就来试试。" },
  "download.subtitle": {
    en: "Prebuilt desktop installers and Android APKs are published for every release. The repository is MIT licensed and ready to build yourself.",
    zh: "每个版本都会发布桌面安装包和 Android APK。仓库采用 MIT 协议，也可以自己构建。"
  },
  "download.desktop.title": { en: "Desktop", zh: "桌面端" },
  "download.desktop.text": {
    en: "macOS and Windows installers",
    zh: "macOS 和 Windows 安装包"
  },
  "download.android.title": { en: "Android", zh: "Android" },
  "download.android.text": {
    en: "APK builds for side loading",
    zh: "可直接侧载的 APK"
  },
  "download.source.title": { en: "Source", zh: "源码" },
  "download.source.text": {
    en: "TypeScript monorepo with CI and QA",
    zh: "带 CI 与 QA 的 TypeScript monorepo"
  },
  "download.note": {
    en: "Quick start: <code>npm ci</code> then <code>npm run dev:desktop</code>. Requires Node.js 22.13 or newer.",
    zh: "快速开始：<code>npm ci</code>，然后 <code>npm run dev:desktop</code>。需要 Node.js 22.13 或更高版本。"
  },
  "footer.text": {
    en: "MIT licensed. Built for people who want their desktop agents to follow them.",
    zh: "MIT 协议开源。为想让桌面 Agent 跟着自己走的人而建。"
  },
  "footer.releases": { en: "Releases", zh: "发布" },
  "page.title": {
    en: "Bridge - Encrypted remote control for Claude, Codex, and Hermes Desktop",
    zh: "Bridge - Claude、Codex 和 Hermes Desktop 的加密遥控"
  },
  "page.description": {
    en: "Bridge is an open-source, end-to-end encrypted remote and collaboration layer for Claude Desktop, Codex Desktop, and Hermes Desktop.",
    zh: "Bridge 是一个开源、端到端加密的远程与协作层，为 Claude Desktop、Codex Desktop 和 Hermes Desktop 提供统一遥控。"
  }
};

function setLanguage(lang) {
  const target = lang === "zh" ? "zh" : "en";
  document.documentElement.lang = target;
  try {
    localStorage.setItem("bridge-lang", target);
  } catch {
    // file:// and privacy modes may not expose localStorage.
  }

  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = I18N[el.dataset.i18n][target];
  });
  document.querySelectorAll("[data-i18n-html]").forEach((el) => {
    el.innerHTML = I18N[el.dataset.i18nHtml][target];
  });
  document.querySelectorAll("[data-i18n-aria-label]").forEach((el) => {
    el.setAttribute("aria-label", I18N[el.dataset.i18nAriaLabel][target]);
  });
  document.querySelectorAll("[data-i18n-alt]").forEach((el) => {
    el.alt = I18N[el.dataset.i18nAlt][target];
  });

  document.title = I18N["page.title"][target];
  document.querySelector('meta[name="description"]').setAttribute("content", I18N["page.description"][target]);
  document.querySelectorAll("[data-lang-btn]").forEach((btn) => {
    btn.setAttribute("aria-pressed", String(btn.dataset.langBtn === target));
  });
}

document.querySelectorAll("[data-lang-btn]").forEach((btn) => {
  btn.addEventListener("click", () => setLanguage(btn.dataset.langBtn));
});

let storedLang = "en";
try {
  storedLang = localStorage.getItem("bridge-lang") || "en";
} catch {
  // Keep English when storage is unavailable.
}
setLanguage(storedLang);
