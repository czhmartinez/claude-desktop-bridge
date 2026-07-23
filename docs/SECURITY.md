# 安全模型

## 已保护

- 消息正文使用 AES-256-GCM 端到端加密。
- 配对根密钥不发送给 Relay。
- Relay 只持久化鉴权令牌的 SHA-256 摘要和加密信封。
- 信封元数据参与认证，不能被静默篡改。
- Bridge 配对密钥写入权限为 `0600` 的用户目录配置文件。它不是 Claude 登录令牌；不用系统钥匙串可避免本地临时签名升级时反复授权或阻塞后台启动。
- Electron 渲染进程启用 sandbox、context isolation，关闭 Node integration，并限制导航和 IPC 来源。
- Claude 配置采用结构化 JSON 合并，写入前保留备份，不覆盖其他连接器与偏好。
- Bridge 不申请辅助功能权限，不发送系统键鼠事件，不读写系统剪贴板，也不会激活或定位 Claude/Codex 窗口。
- 常驻 worker 只发现 Claude Desktop Host 凭据文件的路径并校验文件元数据，文件内容由 Claude CLI 自己读取；找不到时不会调用官方 OAuth 登录，也不会回退到 CLI 的官方 OAuth 存储。MCP 补充 worker 只继承 Claude 已授予连接器的第三方运行环境。所有路径的凭据都不经 Relay、不写入 Bridge 配置，也不会出现在状态接口或日志中。

## Relay 可以看到

Relay 必须知道房间 ID、发送角色、目标角色、时间、密文长度和在线状态，才能路由与清理消息。Relay 看不到正文，但恶意 Relay 仍可丢弃、延迟或重放密文；客户端通过消息 ID去重，无法阻止服务端拒绝服务。

配对密钥放在二维码 URL 的 fragment（`#` 后）中，因此不会进入 HTTP 请求、服务器访问日志或 Referer。不过，正在运行的网页代码可以读取 fragment。需要抵抗恶意或被入侵的 Web 托管方时，应使用签名后的原生移动应用，或把 PWA 部署在自己控制且不可被第三方改写的静态站点上。

## 操作要求

- 公网部署必须使用 HTTPS/WSS。
- Relay 数据目录不得公开。
- 生产环境应设置 `BRIDGE_ALLOWED_ORIGINS`。
- 不要通过聊天、工单或截图公开配对二维码；泄露后在桌面点击“更换配对二维码”。
- 发布安装包前完成 macOS notarization、Windows code signing 与移动商店签名。

## 尚未包含

- 多手机设备撤销列表。目前“更换配对二维码”会整体换钥。
- APNs/FCM 后台推送。手机重新打开后会收到离线队列，应用完全挂起时不会即时弹系统推送。
- 后台分支不会强行写入一个仍在运行的 Claude Desktop 会话；这是为避免 transcript 交错而保留的隔离边界。
- 多租户横向扩展存储。当前 JSON 持久化适合单节点个人/小团队部署。
