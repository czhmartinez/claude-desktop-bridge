# Bridge 0.4.2 安全模型

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
- Bridge 不申请辅助功能权限，不发送键鼠事件，不激活 Claude/Codex，不读写剪贴板。
- 第三方 Claude Host 凭据不写入 Bridge 配置，不经 Relay，不出现在诊断或日志中。
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

## 成果边界

Bridge 任务只快照本轮归因到的变化，不镜像整个项目。Claude Desktop 的事后记录
只保存 JSONL 中已经出现的工具、命令和路径线索；它不扫描项目目录，也不读取
`thinking`。用户打开预览或下载时才读取源文件。

所有远程文件请求只接受服务端生成的 `artifactId`。实际读取前必须通过 `realpath`
确认目标仍位于该会话项目根目录；路径穿越、项目外绝对路径和符号链接逃逸一律
拒绝。默认阻止 `.env*`、私钥、凭据文件、认证配置和 `.git` 内部数据，V0.4 没有
远程绕过开关。工具输出中的令牌、密钥和认证头在持久化前脱敏。

单文件硬上限为 20 MiB。文本 diff 每文件最多 1 MiB、每轮最多 5 MiB；工具输出
每次最多 256 KiB、每轮最多 2 MiB，并记录截断。图片预览最长边不超过 2048 像素
且不超过 2 MiB。HTML 在独立、只读、无 Node 的临时会话中渲染，禁用网络、导航、
弹窗和权限请求，固定 1440 x 900，五秒超时后只返回静态截图。

证据清单长期保留；加密快照和预览在 30 天或总量超过 1 GiB 时按 LRU 清理。缓存
失效后，只有源文件仍在项目根内且 SHA-256 与清单一致时才允许重建。

V0.4 不展示、存储或推断隐藏 CoT，不附加 Claude Desktop 私有 CDP，不提供远程
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
- 为桌面安装包建立签名自动更新源；升级必须保留设备配置与事件日志。
- 单机自签只允许存放在 Bridge 专用钥匙串中，信任策略必须限定为 `codeSign`，不得
  复用为 TLS/邮件证书或把私钥、钥匙串密码、`.p12` 放入仓库和发布产物。
- 丢失手机时，从另一台已授权设备或电脑“设备”页立即撤销。

## 仍需外部条件

仓库已实现 FCM/APNs 通道，但真实后台推送需要 Firebase 项目、
`google-services.json`、APNs Key、应用商店标识和已签名安装包。未提供这些外部
凭据时，App 前台与重新打开后的离线恢复可用，但不能宣称锁屏即时唤醒已发布。
