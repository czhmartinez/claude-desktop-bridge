# Bridge 推广手册

## 一、定位一句话

一个开源、端到端加密的“手机遥控 + 跨 Desktop 协作层”，把 Claude Desktop、Codex
Desktop、Hermes Desktop 统一成一套会话体验，但不合并任何原生账号、模型、权限与历史。

## 二、目标人群

- Claude Desktop / Codex Desktop / Hermes Desktop 的重度用户
- 床上、通勤、会议中想继续控制电脑 Agent 的人
- 自托管优先的隐私敏感用户
- 关注 AI Agent 生态和跨平台工作流的技术写作者

## 三、内容支柱

1. **痛点**：Agent 工作锁死在电脑上，官方 Remote Control 覆盖有限。
2. **方案**：手机与电脑端同步、WebRTC 直连优先、WSS Relay 回退、二维码配对。
3. **边界**：不合并账号/模型/历史，不做自动故障转移，不迁移凭据。
4. **安全**：AES-256-GCM、无辅助功能权限、无剪贴板、无私有 CDP、不读取隐藏思考。
5. **可验证**：CI、真实配对测试、打包 QA、架构与安全文档、自动 Release。

## 四、GitHub 阵地

- 仓库描述建议：
  `Open-source, end-to-end encrypted remote control and cross-desktop relay for Claude, Codex, and Hermes Desktop`
- Topics：`claude-desktop`、`codex`、`hermes`、`electron`、`android`、`ios`、`capacitor`、
  `webrtc`、`end-to-end-encryption`、`remote-control`、`typescript`、`selfhosted`
- README 首屏：徽章 + 一句话价值 + 架构图 + 快速开始 + Release 下载。
- Social Preview：使用 `assets/social-preview.png`，1280x640。

## 五、英文发布渠道草稿

### Hacker News（Show HN）

Title: Show HN: Bridge - encrypted phone remote for Claude, Codex, and Hermes Desktop

Body:

Desktop agents now hold real work: repositories, tools, approvals, and long-running goals.
They are still locked to one machine. Bridge gives phones a unified, end-to-end encrypted
remote for Claude Desktop, Codex Desktop, and Hermes Desktop without merging native
accounts, models, permissions, or history.

Highlights:
- WebRTC direct connection with encrypted WSS relay fallback; relay only sees ciphertext.
- QR pairing, offline queues, event replay, push wake, and fast reconnect.
- Cross-desktop relay: two confirmations, read-only plan, then execution. No auto failover,
  no credential migration.
- No accessibility permissions, no synthetic clicks, no clipboard access, no private CDP.
- MIT, TypeScript monorepo, CI, real packaging QA, and docs.

Repo: https://github.com/czhmartinez/claude-desktop-bridge

### Reddit

- r/ClaudeAI: “I made an open-source encrypted phone remote for Claude Desktop”
- r/CodexAI: “Control Codex Desktop from your phone; also supports cross-desktop relay”
- r/selfhosted: “Self-hosted, end-to-end encrypted relay for controlling desktop AI agents”
- r/androidapps: “Open-source Android companion for Claude/Codex/Hermes Desktop”

发帖时贴 15-30 秒演示 GIF，标题只讲一个核心场景，正文给架构图和安装命令。

### X / Twitter 线程

1. 一句痛点：Agent 跑在电脑上，人却不在电脑前。
2. 一张手机遥控截图/短视频。
3. 强调 E2EE 与无自动迁移的安全边界。
4. 强调 Codex Desktop 是 first-class runtime。
5. 附仓库链接和 Release 下载。

## 六、博客 / 长文

- 标题候选：《I built an encrypted phone remote for Claude, Codex, and Hermes Desktop》
- 结构：问题 -> 现有方案为什么不满足 -> 设计边界 -> 加密与协议 -> 跨 Desktop 接力 ->
  踩坑 -> 路线图。
- 发布：个人博客、Dev.to、Medium、掘金、少数派。

## 七、产品与社区动作

- Product Hunt 发布页：演示视频 + GitHub 链接 + 安装包。
- GitHub Discussions 开启后放 Q&A 和 Roadmap。
- 每周处理 issue/PR，保证“持续维护”证据。
- 邀请 2-3 位不同平台用户做真实跨网络测试并写成使用反馈。

## 八、指标与节奏

建议按周检查：

- Stars、Forks、Watchers
- Release 下载数
- Open issues 回复时长
- 外部 PR / 测试反馈数量
- 演示视频播放与点击来源

前两周聚焦：英文 README、演示 GIF、HN + 3 个 Reddit + X 线程；第二个月再做长文和
Product Hunt，避免一次性铺开导致后续维护跟不上。
