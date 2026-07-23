# Bridge

Bridge 让手机安全地查看并继续电脑上的 Claude 工作。面向最终用户的流程只有三步：

1. 电脑安装 Bridge 并打开。
2. 保持已使用第三方/Gateway 登录的 Claude Desktop 运行，Bridge 会自动识别它的后台通道。
3. 手机扫码，之后可直接使用。

不需要公网 IP、端口映射、Tailscale、Python 或手改 JSON。Android/iOS 共用 Capacitor 应用，macOS/Windows/Linux 共用 Electron 桌面端。

## 当前完成度

这是 `0.1.12` 可运行纵向版本，已包含：

- 端到端加密配对与二维码链接。
- WSS 中继、断线重连、离线密文排队、投递确认、限流与单节点持久化。
- 手机 PWA 工作界面、原生内置扫码、离线指令队列、本地密文历史。
- 保存多台已配对电脑，并通过“主机 → 项目 → 会话”逐级进入；可删除旧主机、诊断失效配对并随时重新扫码。
- 同步 Claude Desktop 会话列表；手机可选择已打开或历史会话，并在 Bridge 的独立后台续写。
- 打开会话时按需同步 Claude 本地历史，只显示用户与 Claude 的可见消息；思考、工具调用和工具结果不会外传。
- 桌面托盘、开机启动、配对管理和 Claude Desktop / Claude Code 配置合并。
- 桌面端设备状态页，集中显示手机最近在线、中继、Claude 会话、待送指令，以及手机发起的指令、处理状态和真实回复，并按需展开配对二维码。
- Claude MCP 的进度与完成工具。
- 手机指令由 Bridge 桌面端的常驻后台 worker 执行；Claude 会话内的 MCP worker 只作为补充。两者都不激活 Claude/Codex，不读取或改写前台输入框，也不使用键盘、鼠标或剪贴板。
- 常驻 worker 复用 Claude Desktop 已有的第三方/Gateway Host 凭据：Bridge 只校验凭据文件路径和权限，文件内容始终由 Claude CLI 自己读取；Bridge 不发起官方 Claude OAuth 登录，也不会回退到本机官方 OAuth 凭据。
- 空闲会话在后台直接续接；仍在运行的桌面会话先创建隔离分支，避免两个进程同时写入同一份会话历史。
- Hooks 只负责观察状态，不再注入指令或重复回传最终回复。
- Electron、Android、iOS 与 Docker 部署骨架。

手机可主动继续空闲会话，不要求用户先在电脑上制造一次活动。电脑只需保持开机、Bridge 在线且第三方登录的 Claude Desktop 正常运行；后台运行时可以自由切换到 Codex 或其他应用。第三方通道暂不可用时，Bridge 会保留加密指令并在通道恢复后自动重试。

Claude Desktop 没有向第三方程序公开“向当前打开的 Code 会话注入用户消息”的本地 API。为避免重新采用会抢焦点的输入框自动化，Bridge 会读取原会话历史并建立独立后台续写；回复同步到手机与电脑端 Bridge，当前 Claude Desktop 窗口不会自动变化。

Bridge 的目标用户是使用第三方/Gateway 登录、无法使用 Claude 官方 Remote Control 的场景。官方 Claude 账户已有 Remote Control 时，不需要额外使用 Bridge。

## 本地运行

要求 Node.js 22.13 以上。

```bash
npm install
npm run dev:desktop
```

会启动：

- Relay：`ws://127.0.0.1:8788/ws`
- 手机/PWA：`http://localhost:5188`
- Electron 桌面端

开发模式会自动使用本机局域网地址。在同一 Wi-Fi 下用手机 Bridge 扫描桌面二维码，即可完成真实手机到电脑的端到端联调；也可以复制配对链接后在浏览器打开。

## 验证

```bash
npm run verify
npm run test:mcp-e2e
npm run test:visual
```

协议与 Relay 测试覆盖加密往返、篡改拒绝、在线投递、离线重放和配置安全合并。`npm run test:android:installed` 是安装态 Android 驱动：在已启动的打包桌面端和 Android WebView CDP 上，选择一个已空闲会话，验证手机主动发送、常驻 worker 领取、单次完成回执和队列归零；截图写入 `artifacts/installed-android-e2e`。

## 目录

```text
apps/client     手机 PWA 与桌面渲染界面
apps/desktop    Electron 常驻端与 MCP 适配器
apps/mobile     Android / iOS Capacitor 壳
apps/relay      密文中继
packages/protocol 共享协议与加密
deploy          Docker / Caddy / Nginx
docs            架构、安全与发布说明
```

## 生产发布

生产环境需要一个固定域名承载手机页面和 Relay，并需要各应用商店/操作系统的签名证书。完整步骤见 [发布手册](docs/RELEASE.md)，威胁边界见 [安全模型](docs/SECURITY.md)。

## 技术依据

- MCP 本地连接使用官方 TypeScript SDK 的 stdio transport。
- Electron 渲染层采用 sandbox、context isolation、受限 preload 与本地静态资源。
- Capacitor 将同一套 Web App 打包到 Android 与 iOS。

License: MIT
