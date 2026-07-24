# Bridge 0.2 安全模型

## 已保护

- 正文与事件使用每设备独立的 AES-256-GCM 密钥端到端加密。
- 房间、发送设备、目标设备、时间和过期时间属于认证数据，Relay 不能静默改写。
- Relay 只保存鉴权摘要和密文；设备 ACK、离线队列和撤销均按 `deviceId` 隔离。
- 大附件在端到端加密后分块，Relay 只能看到分块大小、序号和整体密文哈希。
- 二维码十分钟内单次有效，并由 Relay 绑定到首次使用它的移动实例。
- 在线撤销会立即移除 Relay 权限；手机删除主机时同时删除本地密钥和缓存。
- 主机与设备密钥保存在权限为 `0600` 的本地配置中，不调用系统钥匙串，避免临时
  签名或升级时弹出系统密码框。
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

FCM/APNs 请求只包含无正文唤醒标记。推送服务不会收到会话 ID、标题、摘要或消息
文本。

## 本机边界

`TranscriptObserver` 需要只读访问当前用户的 Claude 会话 JSONL 与元数据。
`ClaudeSessionHost` 以当前用户身份运行，并继承第三方 Host 环境，因此它拥有与
本机 Claude 工具相同的文件和命令权限。危险工具必须经过 `PermissionBroker`；
电脑或任一已授权手机的首次有效答复生效。

Bridge 不附加或注入 Claude Desktop 进程。桌面原会话运行时不会并发写 transcript，
手机消息会排队等待接管。

## 生产要求

- 公网只允许 HTTPS/WSS，并设置严格的 `BRIDGE_ALLOWED_ORIGINS`。
- Relay 使用 SQLite WAL 持久卷，密文默认保留七天，每房间最多 2,000 条或 128 MB；
  每日备份保留七份。
- Relay 数据目录、FCM 服务账号和 APNs 私钥不得进入镜像或源码。
- 配置 macOS notarization、Windows code signing、Android keystore 和 iOS
  provisioning profile。
- 为桌面安装包建立签名自动更新源；升级必须保留设备配置与事件日志。
- 丢失手机时，从另一台已授权设备或电脑“设备”页立即撤销。

## 仍需外部条件

仓库已实现 FCM/APNs 通道，但真实后台推送需要 Firebase 项目、
`google-services.json`、APNs Key、应用商店标识和已签名安装包。未提供这些外部
凭据时，App 前台与重新打开后的离线恢复可用，但不能宣称锁屏即时唤醒已发布。
