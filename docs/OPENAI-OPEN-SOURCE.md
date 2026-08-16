# OpenAI 开源申请与推广手册

## 一、申请入口（两个可以都投）

| 项目 | 内容 | 申请地址 |
| --- | --- | --- |
| Codex for Open Source | 入选维护者可获得 6 个月 ChatGPT Pro（含 Codex）、Codex Security 条件访问，以及维护/发布工作流相关 API 额度 | https://openai.com/form/codex-for-oss/ |
| Codex Open Source Fund | 总额 100 万美元，单个项目最高 25,000 美元 API credits，滚动审核 | https://openai.com/form/codex-open-source-fund/ |

官方说明强调：公开项目核心维护者、或运营被广泛使用的公共项目都可以申请。项目暂时
不满足典型门槛，但如果在生态中承担了独特作用，也建议“申请并说明原因”。审核时会看
仓库使用情况、生态重要性、持续维护证据、申请人在仓库中的角色，以及计划容量。

## 二、项目速览（用于表单填写）

| 字段 | 内容 |
| --- | --- |
| 项目名称 | Bridge |
| 仓库 | https://github.com/czhmartinez/claude-desktop-bridge |
| 当前版本 | 0.7.8 |
| License | MIT |
| 平台 | macOS / Windows 桌面端；Android / iOS 移动端 |
| 技术栈 | TypeScript、Electron、React、Capacitor、Node.js、SQLite、WebRTC |
| 核心能力 | 端到端加密的手机遥控 Claude/Codex/Hermes/DSH Desktop；跨 Desktop 手动接力；会话同步、审批、成果预览、离线恢复 |

## 三、申请定位与英文文案草稿

### Project name

Bridge

### One-line summary

An open-source, end-to-end encrypted remote and collaboration layer that lets one phone
control Claude Desktop, Codex Desktop, Hermes Desktop, and DSH Desktop while keeping each native session,
account, model, and permission fully separate.

### Tell us about your project

Bridge is a multi-desktop collaboration product, not a remote desktop or input automator.
It unifies session list, streaming output, approvals, questions, interrupts, and recovery
across Claude Desktop, Codex Desktop, Hermes Desktop, and DSH Desktop. Phones pair with the desktop host
over an encrypted QR handshake, prefer a WebRTC data channel, and fall back to a
self-hostable WSS relay that only sees ciphertext.

The project also implements cross-desktop serial relay: with two explicit human
confirmations, a bounded, redacted, encrypted task context can be handed from one desktop
runtime to a new native session on another runtime. The target runtime first produces a
read-only plan, the user approves it, and only then does execution begin. There is no
automatic failover and no credential migration.

### Why is this project important?

Desktop AI agents increasingly hold real work: repositories, file changes, tool calls, and
long-running goals. Most agents remain locked to a single machine, and no mainstream
open-source option provides a consistent phone remote for Claude, Codex, and Hermes at the
same time without merging their native boundaries. Bridge addresses that gap with a
privacy-first model:

- No accessibility permissions, synthetic clicks, clipboard access, private CDP, or OAuth
  extraction.
- Per-device AES-256-GCM encryption; the relay never sees conversation content.
- Strict native ownership; sessions never silently migrate between runtimes.
- Official local integration points only: Claude Agent SDK/JSONL, `codex app-server
  --stdio`, and a loopback-only Hermes Gateway.

### How does the project use Codex or OpenAI models?

Codex Desktop is a first-class supported runtime. Bridge starts its own official
`codex app-server --stdio` subprocess and uses the native session, plan, goal, stream,
approval, and interrupt interfaces, so a phone can remotely drive Codex Desktop while the
desktop app remains the owner of identity, credentials, model selection, and permissions.

The repository is also developed with Codex CLI, including agent-driven implementation,
refactors, test generation, and release workflows. Using this program would let the
maintainer continue investing those resources in broader cross-runtime reliability,
self-hosted relay testing, and international documentation.

### What is the current adoption or maintenance evidence?

- Public GitHub repository with MIT license, active main branch, and a current release
  pipeline that builds desktop installers and Android APKs.
- CI for typecheck, unit tests, full builds, Windows packaged QA, Android installed-APK QA,
  and visual QA.
- Architecture, security, and release documentation plus a real changelog.
- Recent releases include mobile/desktop session archive and delete, live running-task
  indicators, image rendering, file-change previews, reconnect performance fixes, and
  Claude-style authorization policies for Codex and Hermes.

The project is at an early adoption stage, which is exactly why ecosystem support matters:
it fills a niche no existing open-source project covers and needs validation, contributors,
and device coverage to mature.

### What would the support be used for?

- Public relay and push infrastructure for real-world cross-network testing.
- Additional device and OS coverage (Windows, iOS, self-hosted relay).
- Documentation, internationalization, and community onboarding.
- Long-running goal and cross-desktop relay reliability work.

## 四、提交前清单

- [ ] 仓库保持 Public，默认分支为 `main`。
- [ ] 英文 README 已就绪：`README_EN.md`。
- [ ] 落地页已上线：https://czhmartinez.github.io/claude-desktop-bridge/ 。
- [ ] 仓库描述覆盖 Claude/Codex/Hermes，而非只写 Claude。
- [ ] 仓库 Topics 已添加：`claude-desktop`、`codex`、`electron`、`android`、`webrtc`、
  `end-to-end-encryption`、`remote-control`、`typescript`、`open-source`。
- [ ] README 首屏有架构图、功能列表、快速开始和 Release 下载链接。
- [ ] 提供一个演示视频或动态 GIF（手机遥控 + 跨 Desktop 接力）。
- [ ] 有可点开的 Release 与 CI 徽章。
- [ ] GitHub Discussions 已有欢迎帖与 Q&A 入口。
- [ ] 确认申请表单中的 ChatGPT/GitHub 账号信息正确，并由本人提交。
- [ ] 提交后记录申请日期与邮箱，滚动审核通常需要等待。

## 五、如果入选后的计划

- 用 API credits 覆盖真实公网 Relay、WebRTC/TURN 和大规模重连压测。
- 用 Codex 加速 issue 分诊、PR review、迁移和文档维护。
- 建立公开 Roadmap，邀请更多维护者参与 adapter 与移动端测试。
- 将 Bridge 的会话、接力与安全协议沉淀成可独立复用的规范。
