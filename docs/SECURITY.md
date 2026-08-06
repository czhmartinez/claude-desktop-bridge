# Bridge 0.6.0 安全模型

## 已保护

- 正文与事件使用每设备独立的 AES-256-GCM 密钥端到端加密。
- 房间、发送设备、目标设备、时间、过期时间和临时投递标记属于认证数据，Relay
  不能静默改写。
- Relay 只保存鉴权摘要和密文；设备 ACK、离线队列和撤销均按 `deviceId` 隔离。
- 普通信封在端到端加密后分块，Relay 只能看到分块大小、序号和整体密文哈希。
- 成果事件只包含摘要和清单，不包含文件正文；预览与下载仅在用户请求后临时发送。
- 二维码十分钟内单次有效，并由 Relay 绑定到首次使用它的移动实例。
- 在线撤销会立即移除 Relay 权限；手机删除主机时同时删除本地密钥和缓存。
- 主机与设备密钥保存在权限为 `0600` 的本地配置中，不调用系统钥匙串，避免临时
  签名或升级时弹出系统密码框。
- 证据正文使用独立 AES-256-GCM 主密钥加密为内容寻址 blob；主密钥由 Electron
  `safeStorage` 保护，不复用传输身份密钥。
- Electron 渲染进程启用 sandbox、context isolation，关闭 Node integration，
  并限制导航和 IPC 来源。
- Bridge 不申请辅助功能权限，不发送键鼠事件，不附着、注入或自动操作 Claude、Codex、Hermes
  的原生窗口，也不读写剪贴板。
- “完全授权”只在电脑端 `PermissionBroker` 自动批准工具请求，不启用 Agent SDK
  `bypassPermissions`；Claude 提问和受管策略的明确禁止仍不能被自动批准。
- 第三方 Claude Host 凭据不写入 Bridge 配置，不经 Relay，不出现在诊断或日志中。
- Anthropic Console API Key 只接受 Desktop 本地 IPC；保存前必须由 Electron
  `safeStorage` 加密，磁盘格式固定带 `os:` 标记，系统安全存储不可用时拒绝保存，
  不允许明文、base64 或手机/Relay 降级。
- `conversation-state-v1.sqlite` 与证据库分离；完整接力包使用独立派生密钥
  AES-256-GCM 加密，协议事件和手机快照只携带状态、摘要与路由。
- 0.2 首次启动只备份并移除 Bridge 自己写入的 `claude-bridge` MCP 与 HTTP Hooks；
  其他 Claude 配置保持不变。
- 诊断导出只包含版本、平台、连接状态和数量统计，不包含正文、密钥或凭据路径。

## Relay 可见内容

Relay 必须看到房间 ID、设备 ID、时间、密文长度、在线状态和推送平台，才能路由、
限流和清理。它看不到消息正文、项目路径、会话标题、审批内容或工具结果。

恶意 Relay 仍可丢弃、延迟或重放密文。客户端通过事件 ID、请求幂等键和单调
`seq` 去重并发现缺口，但无法阻止服务端拒绝服务。

FCM/APNs 请求只包含无正文唤醒标记。推送服务不会收到会话 ID、标题、摘要、消息
文本或成果正文。

WebRTC 的 SDP、ICE candidate 与断线 ACK 也封装在设备 AES-GCM 信封中，Relay
只能看到短时密文。直连数据同时受 WebRTC DTLS 和 Bridge AES-GCM 双层保护。
STUN 能看到发起 Binding 的公网 IP 和端口，但不接收 Claude 指令、回复或附件。
当前版本不使用 TURN；无法直连时继续使用端到端加密 WSS Relay。

成果预览和传输响应使用经过端到端认证的临时投递标记与十分钟 TTL。Relay 只向
当前在线设备转发并跳过 SQLite 入队，因此它们不进入七天持久离线队列。Relay
仍可观察加密响应的长度、时间与目标设备，但不能解密文件正文、文件名、项目路径
或 SHA-256。客户端只在完整分块通过最终哈希校验后保存或分享文件。

## 本机边界

### 多 Desktop adapter

Bridge 0.6 统一操作体验，不合并原生会话域。每个会话的本机身份是
`(runtimeId, nativeSessionId)`；运行时相同的原生 ID 不会相互覆盖，Bridge 也不会在
Claude、Codex、Hermes 间复制历史、认证、模型选择、权限规则或自动故障转移。

`CodexAppServerAdapter` 只启动 Bridge 自己拥有的官方 `codex app-server --stdio` 子进程，
不附着已有 app-server 或 Codex Desktop 进程。`HermesGatewayAdapter` 只连接 `localhost` /
`127.0.0.1` / `::1` WebSocket；未配置 Gateway 时由 Bridge 启动 Hermes sidecar，并为该进程
生成随机会话令牌。Bridge 不读取 Hermes Desktop 的 token、keychain 或远端 Gateway 地址。
adapter 启动超时、关闭或重试时必须关闭其自有子进程，不能保留后台访问通道。

Codex/Hermes 的模型、账号和原生配置只在相应 Desktop 内管理。外部 adapter 的图片附件、
模型配置和其他非共同能力默认关闭，只有显式能力声明才能在 Bridge UI 开放。

`TranscriptObserver` 需要只读访问当前用户的 Claude 会话 JSONL 与元数据。
`ClaudeSessionHost` 以当前用户身份运行，并继承第三方 Host 环境，因此它拥有与
本机 Claude 工具相同的文件和命令权限。危险工具必须经过 `PermissionBroker`；
电脑或任一已授权手机的首次有效答复生效。

会话目录发现只读取 `~/.claude` 与 Claude 的 Application Support 元数据，不探测
元数据中记录的项目 `cwd`。CLI 的后台 PATH / 版本发现和模型列表发现也固定避开
“文稿 / 桌面 / 下载”等受保护目录。只有用户选中某个真实项目并发送任务后，
`ClaudeSessionHost` 才以该项目为 `cwd` 启动；macOS 因而只会在真实项目首次执行时
请求相应的 Files & Folders 授权。后续版本必须维持相同的正式签名身份与 Bundle ID，
系统才能在升级后继续识别这次授权。

Bridge 直接新建的会话在首轮可信 JSONL 落盘后，可以向当前 Claude Desktop profile
写入一份最小会话映射。该能力只接受 Bridge 自身 UUID，动态识别唯一 active profile
与账号目录，要求现有原生元数据格式可验证，并对 transcript 根目录、`sessionId`、
`cwd`、目标文件名和最终父目录逐项校验。目标已存在、目录歧义、符号链接或格式未知
时一律停止；不会覆盖原生会话，不写 LevelDB，也不会把本机路径和哈希发送到手机或
Relay。

恢复原生会话时，Bridge 会在启动 Host 和写入用户消息前核对会话元数据来源与当前
Host 凭据目录。Claude 官方与 Claude-3p profile 不一致时保持原会话未写入并失败
关闭；不会尝试复制凭据、跨 profile 原始 resume 或自动改走其他执行通道。

Bridge 不附加或注入 Claude Desktop 进程，也不会为了接管自动退出 Claude Desktop
或向其 Claude Code 会话子进程发送终止信号。仅打开、聚焦和只读查看会话不会形成
写入冲突；目标 transcript 到达安全边界后，Bridge 可以与空闲 Desktop 会话进程
共存并继续同一 `sessionId`。

Bridge 为每个 Host 保存外部写入版本基线。只有 transcript 出现无法归因给 Bridge
的新用户消息时，才确认 Desktop 发生真实写入；检测同时覆盖非终端分支。真实双写
发生后只关闭 Bridge writer，手机原指令保持持久排队。Desktop 任务仍在执行、目标
transcript 未完成或状态无法验证时，Bridge 不启动 Host。

## 提供方与接力边界

Claude-3p lane 可以使用第三方 Host Credentials，但不会把凭据复制到 provider
profile、接力包或移动端。Anthropic API lane 每次建立 Host 计划时都先删除继承的
`ANTHROPIC_AUTH_TOKEN`、OAuth token、Host 凭据变量、第三方 Base URL、Custom
Headers 以及 Bedrock/Vertex/Foundry 路由，再仅注入本机解密出的显式 API Key。
Key 验证调用 Anthropic `GET /v1/models`，模型清单可以进入 profile；Key 和认证头
不会进入数据库、日志、事件、接力包或 Relay。

Claude 官方 lane 禁止抽取、复制或代理 Pro/Max OAuth。Bridge 只构造公开
`claude://code/new` Deep Link，并要求用户在 Bridge 电脑上确认目录和发送第一条消息。
关联前同时校验官方 profile、`realpath` 后的 cwd、不透明 handoff ID、完整首条消息
SHA-256 与十分钟创建窗口。零匹配不激活；多匹配只返回候选 ID 并等待用户选择。
激活后 route 为只读，`turn.start/steer/configure` 在入队前失败；旧客户端也不能
回退到其他 lane。

接力包只包含有界、用户可见且可验证的信息。凭据模式、Bearer/Authorization、
项目外绝对路径和敏感文件正文会被删除或脱敏；只保留工具摘要和相对产物清单，不
保留无界输出。失败、取消、超时、崩溃或首条消息投递不确定时，原 lane 继续活动，
目标 lane 不激活且首条消息禁止自动确认或重发。

## 成果边界

Bridge 任务只快照本轮归因到的变化，不镜像整个项目。Claude Desktop 的事后记录
只保存 JSONL 中已经出现的工具、命令和路径线索；它不扫描项目目录，也不读取
`thinking`。用户打开预览或下载时才读取源文件。

所有远程文件请求只接受服务端生成的 `artifactId`。实际读取前必须通过 `realpath`
确认目标仍位于该会话项目根目录；路径穿越、项目外绝对路径和符号链接逃逸一律
拒绝。默认阻止 `.env*`、私钥、凭据文件、认证配置和 `.git` 内部数据，V0.6 没有
远程绕过开关。工具输出中的令牌、密钥和认证头在持久化前脱敏。

单文件硬上限为 20 MiB。文本 diff 每文件最多 1 MiB、每轮最多 5 MiB；工具输出
每次最多 256 KiB、每轮最多 2 MiB，并记录截断。图片预览最长边不超过 2048 像素
且不超过 2 MiB。HTML 在独立、只读、无 Node 的临时会话中渲染，禁用网络、导航、
弹窗和权限请求，固定 1440 x 900，五秒超时后只返回静态截图。

证据清单长期保留；加密快照和预览在 30 天或总量超过 1 GiB 时按 LRU 清理。缓存
失效后，只有源文件仍在项目根内且 SHA-256 与清单一致时才允许重建。

V0.6 不展示、存储或推断隐藏 CoT，不附加 Claude Desktop 私有 CDP，不提供远程
项目浏览、编辑、动态服务启动或大文件绕过。

## 生产要求

- 公网只允许 HTTPS/WSS，并设置严格的 `BRIDGE_ALLOWED_ORIGINS`。
- 默认公共 STUN 不承载业务数据。自托管 STUN/TURN 时只开放实际使用的端口并设置
  速率保护；TURN 长期密钥只能留在服务端，客户端只接收短期凭据。
- Relay 使用 SQLite WAL 持久卷，密文默认保留七天，每房间最多 2,000 条或 128 MB；
  每日备份保留七份；成果临时响应不得进入该持久队列。
- Relay 数据目录、FCM 服务账号和 APNs 私钥不得进入镜像或源码。
- 配置 macOS notarization、Windows code signing、Android keystore 和 iOS
  provisioning profile。
- Windows 安装包必须使用 Authenticode 签名；Bridge 的 `safeStorage` 在 Windows
  由 DPAPI 保护，API Key 仍只经电脑端 IPC 写入，绝不进入 Relay、手机或安装包。
- 为桌面安装包建立签名自动更新源；升级必须保留设备配置与事件日志。
- 单机自签只允许存放在 Bridge 专用钥匙串中，信任策略必须限定为 `codeSign`，不得
  复用为 TLS/邮件证书或把私钥、钥匙串密码、`.p12` 放入仓库和发布产物。
- 丢失手机时，从另一台已授权设备或电脑“设备”页立即撤销。

## 仍需外部条件

仓库已实现 FCM/APNs 通道，但真实后台推送需要 Firebase 项目、
`google-services.json`、APNs Key、应用商店标识和已签名安装包。未提供这些外部
凭据时，App 前台与重新打开后的离线恢复可用，但不能宣称锁屏即时唤醒已发布。
