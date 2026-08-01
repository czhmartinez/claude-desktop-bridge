# Bridge 0.5 发布手册

## 1. 发布闸门

```bash
npm ci
npm run audit:runtime
npm run verify
BRIDGE_M0_REAL=1 npm test -w @bridge/desktop -- \
  --run src/claude-session-host.real.test.ts
npm run test:visual
npm run test:html-preview
npm run make:local:desktop-android
```

凡是影响 `apps/client`、协议或跨端工作流的改动，本机验收包必须在同一轮同时更新
DMG 与 Android APK。先递增 Android `versionCode`，再运行
`npm run make:local:desktop-android`；只有明确限定为桌面原生层的改动才可跳过 APK。
V0.5 涉及共享协议与客户端，不属于例外：DMG 和 APK 必须来自同一提交。协议 V3、
配对 schema V4、Application Support、证据、Key、事件和已配对设备不得清空。

M0 必须证明手机/测试客户端消息与 Claude 回复落入同一 `sessionId` 和同一 JSONL，
且测试前后的活动应用和剪贴板不变。SDK 不通过时停止发布，不能退回单次任务。

V0.5 还必须检查根包、全部 workspace、Android `versionName` 和 iOS
`MARKETING_VERSION` 一致，并确认协议常量为 V3、配对 schema 为 V4。V0.3 客户端
必须收到升级拒绝；重配后稳定 `hostId`、会话历史、本地事件和手机缓存仍可接回。

Provider 发布闸门还必须覆盖：

- Anthropic API Key 只能由 Desktop 本地 IPC 设置/删除，磁盘只允许 `safeStorage`
  格式；手机与 Relay 方法集中不存在 Key 写接口。
- API lane 模型来自真实 `GET /v1/models`，且 Host/OAuth、第三方 Base URL 和云路由
  环境已经清除。没有用户 Key 时只报告“需配置”，不得用其他凭据替代。
- 官方接力只使用公开 Deep Link；必须验证 profile、`realpath` cwd、handoff ID、
  首条消息哈希和十分钟窗口。零/多匹配、超时、崩溃和不确定投递均保持原 lane。
- V0.4 Host 能隐藏新 UI；V0.4 客户端可在 V0.5 可写 lane 正常执行；官方只读 lane
  对旧客户端写入必须在入队前失败并提示升级。
- `sessions-v2.json` 和 `turn-queue-v2.json` 的幂等 SQLite 迁移、两次成功启动以及
  `.migrated` 改名必须在保留副本上验证。

## 2. 部署 Relay 与 Web

```bash
cp .env.example .env
# 修改域名、Origin 和推送凭据
docker compose up -d --build
curl https://你的域名/health
curl https://你的域名/ready
BRIDGE_RELAY_URL=wss://你的域名/ws npm run probe:relay
```

生产入口同时承载静态客户端与 `/ws`，必须使用固定 HTTPS/WSS。自托管属于高级
选项；面向普通用户的安装包应写入 Bridge 托管 Relay。Relay 数据位于
`/data/bridge-relay.db`，WAL 和每日七份备份都必须位于持久卷。

Bridge 不从 `BRIDGE_SERVICE_ORIGIN` 自动派生 STUN 地址。ICE 必须显式配置，
例如 Cloudflare 的公共 STUN：

```bash
BRIDGE_ICE_SERVERS='[{"urls":"stun:stun.cloudflare.com:3478"}]'
```

自托管 Coturn 仍是高级选项；使用时再开放 TCP/UDP `3478`。TURN 长期密钥不得
打进客户端，必须由服务端换取短期凭据后下发。

## 3. 推送配置

Android 需要 Firebase `google-services.json`、FCM HTTP v1 服务账号和签名
application ID。Relay 使用：

```text
BRIDGE_FCM_PROJECT_ID
BRIDGE_FCM_CLIENT_EMAIL
BRIDGE_FCM_PRIVATE_KEY
```

iOS 需要 APNs `.p8` Key、Team ID、Key ID、Bundle ID 和 Background Modes：

```text
BRIDGE_APNS_TEAM_ID
BRIDGE_APNS_KEY_ID
BRIDGE_APNS_BUNDLE_ID
BRIDGE_APNS_PRIVATE_KEY
BRIDGE_APNS_PRODUCTION=1
```

所有私钥只通过部署平台的 secret manager 注入。

## 4. 构建桌面端

```bash
BRIDGE_RELAY_URL=ws://127.0.0.1:8788/ws \
BRIDGE_PUBLIC_RELAY_URL=wss://你的域名/ws \
BRIDGE_SERVICE_ORIGIN=https://你的域名 \
BRIDGE_ICE_SERVERS='[{"urls":"stun:stun.cloudflare.com:3478"}]' \
BRIDGE_PAIRING_BASE_URL=https://你的域名 \
BRIDGE_MAC_SIGN_IDENTITY='Developer ID Application: 你的名称 (TEAMID)' \
npm run make -w @bridge/desktop
```

macOS 正式更新必须始终使用同一个签名身份。系统用代码的 designated requirement
记忆“文稿 / 桌面 / 下载”等隐私授权；临时 `-` 签名只生成与本次构建绑定的
`cdhash`，每次升级都会被识别成新代码并重新弹授权框。默认构建会拒绝这种安装包。
只有一次性本机调试可显式执行 `npm run make:adhoc -w @bridge/desktop`，该产物不可
用于覆盖日常使用中的 Bridge。

构建前先检查并优先使用输出中的身份 SHA-1：

```bash
security find-identity -v -p codesigning
BRIDGE_MAC_SIGN_IDENTITY='<身份 SHA-1>' npm run make -w @bridge/desktop
codesign -d -r- apps/desktop/out/Bridge-darwin-arm64/Bridge.app
```

最后一条的 designated requirement 不得是 `cdhash H"..."`。正式构建还会校验
`Authority=Developer ID Application` 和十位 `TeamIdentifier`，自签身份不能绕过
发布闸门。仓库不会自动创建或信任本地根证书，也不会在普通构建中向钥匙串写入
私钥。正式分发应由 Apple Developer 提供 Developer ID Application 身份。

### 4.1 单机本地稳定签名

仅在这台个人 Mac 上反复覆盖安装测试时，可以显式执行一次：

```bash
npm run signing:setup-local -w @bridge/desktop
# 阅读安全说明后，在 Terminal 输入 CREATE
npm run make:local-signed -w @bridge/desktop
```

初始化命令会在
`~/Library/Application Support/Bridge/build-signing` 创建专用钥匙串、随机密码和
只含 `codeSigning` 扩展用途的自签身份；信任策略限定为 `codeSign`，私钥只保存在
该钥匙串中，密码文件权限为 `0600`，并给 `/usr/bin/codesign` 设置专用 ACL。构建时
会先保存原 user keychain search list，临时追加该专用钥匙串，同时通过
`BRIDGE_MAC_SIGN_KEYCHAIN` 明确指定它；无论成功、失败或中断，`trap` 都会原样恢复
原 search list 并立即锁定专用钥匙串。

这是一次明确的本机信任变更，不会静默运行，也不能替代 Developer ID 和 notarization。
该包只适合这台 Mac，不能对外分发。首次从旧的 ad-hoc 包切换到这个稳定身份时，
macOS 仍会最后请求一次“文稿 / 桌面”等授权；之后保持此身份、Bundle ID 和钥匙串
不变，升级的 designated requirement 才会稳定。

本机流程只为固定这台 Mac 上的代码身份，使用单次深度签名且不启用 hardened
runtime。正式发布仍走上面的 Developer ID、逐组件签名和 hardened runtime 流程；
本机签名产物不得上传或交给其他设备安装。

不要直接复用正在运行的正式 Bridge 配置。用隔离的临时 profile 启动打包应用并
开放测试 CDP 端口：

```bash
QA_PROFILE="$(mktemp -d /tmp/bridge-packaged-qa.XXXXXX)"
BRIDGE_RELAY_URL=ws://127.0.0.1:8788/ws \
  apps/desktop/out/Bridge-darwin-arm64/Bridge.app/Contents/MacOS/Bridge \
  --bridge-packaged-qa --user-data-dir="$QA_PROFILE" --remote-debugging-port=9223
```

然后必须执行：

```bash
BRIDGE_DESKTOP_CDP=http://127.0.0.1:9223 npm run test:desktop:packaged
BRIDGE_DESKTOP_CDP=http://127.0.0.1:9223 npm run test:desktop:pairing
```

该检查会验证 preload、`file://` 资源、三页控制台、运行时快照和渲染错误，避免
开发版正常但安装包白屏；同时验证协议 V3 能力声明和打包态事后证据。配对检查还会
使用真实 Relay 完成一次设备认领、加密请求、主机快照和撤销失效闭环。

Electron 安装包必须在目标系统构建：macOS 产出 DMG/ZIP，Windows 产出辅助式 NSIS，
Linux 产出 ZIP/DEB/RPM。没有 Developer ID、Authenticode 或仓库签名时只能标记为
“构建通过”，不能宣称可正式分发。

### 4.2 Windows 桌面包

Windows 构建必须在 Windows（本地或 `windows-2022` runner）执行：

```powershell
npm run make:windows
```

electron-builder 使用 NSIS 生成 `apps/desktop/out/make/nsis.windows/x64/` 下的
`Bridge-<version>-Setup.exe`。安装向导必须显示目录选择页，不能把路径静默固定到
Squirrel 的用户目录。未提供签名材料时产物标记为 `installer-ci`，可以在本机
安装验收但不可作为正式下载附件。需要签名时，通过 CI secret
`BRIDGE_WIN_CERTIFICATE_BASE64` + `BRIDGE_WIN_CERTIFICATE_PASSWORD`，或本机环境变量注入：

```powershell
$env:BRIDGE_WIN_CERTIFICATE_FILE = "C:\secrets\bridge.p12"
$env:BRIDGE_WIN_CERTIFICATE_PASSWORD = "..."
npm run make:windows
```

也可以使用 electron-builder 标准的 `WIN_CSC_LINK` 与 `WIN_CSC_KEY_PASSWORD`。证书、
密码和签名私钥不得提交到仓库。Windows 使用 Electron `safeStorage`（由 DPAPI 保护）
保存 Anthropic API Key；Bridge 不读取 Windows Credential Manager 中的其他账户。

Windows 与 macOS 共享 Bridge Host、Claude Code/Claude-3p Host、Anthropic API、Relay、
证据、普通 Claude Desktop 启动/退出、官方 Deep Link、首条消息关联和会话清单登记。
Windows 读取 `%APPDATA%\Claude\claude-code-sessions`，并通过 PowerShell/tasklist
检查实例。私有 CDP 仍在两个平台都关闭，不属于发布能力。

0.5.3 的授权策略和手机后台连续性同样属于 Windows Host 的发布范围。Windows runner
必须先运行完整 typecheck/test，再生成辅助式 NSIS 包，并执行：

```powershell
npm run build -w @bridge/relay
npm run test:desktop:packaged:windows
```

这个门禁会先把安装包安装到随机的非默认目录，确认 `bridge.exe` 确实位于所选目录，
再启动隔离数据目录下的安装版程序和本地 Relay，验证 preload、
`file://` 渲染、`permission.policy.v1`、会话授权有效模式、真实加密配对、请求响应和
设备撤销。它不能代替 Windows 真机上的 Claude/Claude-3p 运行时、DPAPI 跨重启、
托盘常驻、手机断线后任务继续及恢复去重验收。

## 5. 构建移动端

```bash
VITE_BRIDGE_PUBLIC_RELAY_URL=wss://你的域名/ws \
VITE_BRIDGE_SERVICE_ORIGIN=https://你的域名 \
VITE_BRIDGE_ICE_SERVERS='[{"urls":"stun:stun.cloudflare.com:3478"}]' \
VITE_BRIDGE_PUSH_ENABLED=true \
npm run build:android:debug
npm run sync -w @bridge/mobile
```

Android Debug APK：
`apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk`。
生产 Release 不允许明文 `ws://`，并必须使用固定 keystore。

连接启用了 USB 调试的 Android 真机后，可使用 `adb install -r` 安装，再以
WebView 调试端口执行 `npm run test:android:installed`。该测试会重新配对、选择
空闲会话、主动发送唯一指令，并验证用户消息与 Claude 回复各出现一次。

iOS 需要 Xcode 中配置 Team、Bundle ID、Push Notifications、Background
Notifications 和 provisioning profile。没有 Apple Developer 条件时只能验证
模拟器构建。

## 6. 验收矩阵

每个平台至少覆盖：

- 空闲会话主动启动、桌面繁忙排队、断线一小时恢复和重复投递。
- P2P 成功后 Relay 不出现业务 Envelope；ICE 五秒失败、DataChannel 中断和
  Wi-Fi/5G 切换后自动回退 WSS，未确认指令仍只执行一次。
- 历史分页、实时 delta、工具进度、审批、提问、调整和停止。
- Bridge 任务的工具成功/失败、退出码、脱敏输出、既有脏改动排除，以及新增、修改、
  删除、重命名、二进制、非 Git、并发任务和延迟写入归因。
- Claude Desktop JSONL 的重复扫描、半写入、截断、轮转、仅 `thinking`、工具失败、
  无产物和会话恢复；所有结果必须标记“事后恢复”或“部分”。
- 文本、代码、diff、图片、HTML 截图、PDF 和普通二进制；PDF/二进制只下载，不
  内嵌渲染，也不自动启动服务。
- 路径穿越、符号链接逃逸、敏感文件、工具输出泄密、HTML 外网请求、导航、弹窗和
  恶意脚本超时均应失败关闭。
- 0 字节、256 KiB 边界、20 MiB、超过 20 MiB、断线续传和哈希不一致；成果正文
  不得进入 Relay 七天持久队列。
- Host 离线时清单可见、已缓存预览可打开、未缓存正文提示重新连接电脑。
- App 前后台、锁屏唤醒、扫码过期、单次二维码和设备撤销。
- 桌面 `file://` 资源、托盘、开机启动、睡眠恢复和升级覆盖。
- Claude-3p 创建并修改文件 -> Anthropic API 继续并生成精确证据 -> Claude 官方
  经 Bridge 电脑确认出现在官方侧边栏并完成一轮 -> 安全复用 Claude-3p lane 继续。
- Android 能发起 preview/commit/cancel，显示“等待本机确认”，并在
  `conversation.route.changed` 后呈现最终活动 provider；手机端绝不出现 Key 输入。

桌面原生 WebRTC 运行时使用真实 DataChannel 门禁测试：

```bash
npm run test:webrtc:native
```
- 活动应用、键盘焦点和剪贴板不变，系统中无辅助功能授权请求。

稳定版矩阵为 macOS/Windows/Linux x Android/iOS。只有实机、签名与固定公网
WSS 全部通过的平台才能标记“可分发”。

V0.5.3 必须同时生成本机稳定签名 DMG、Windows NSIS `Setup.exe` 与
Android APK，并记录版本、SHA-256、签名校验、打包态 CDP/配对结果和真机状态。
Windows 正式分发必须有有效 Authenticode；CI 会生成
`windows-release-evidence.json`，没有证书时只能标记为未签名验收包。没有 Anthropic
API Key、用户未在 Bridge 电脑确认官方首条消息、没有已授权 Android 真机、没有完成
Windows 真机连续性测试或缺少外部分发签名时，必须逐项标记为“外部条件未满足”，
不得把自动测试、安装包构建或 HTTP `/health` 冒充真实验收。
V0.4.2 的跨 profile 阻止、ultracode 1M 识别和 synthetic `Prompt is too long`
去重仍需回归；iOS/Web 共享代码必须保持可构建。
