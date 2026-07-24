# Claude Bridge

这段是我自己写的：

天下苦Claude久矣，3天内封了我5个Max订阅账号，A➗你是真的➗。

但是架不住Claude Desktop确实好用，尤其是K3发布之后把接进了Claude Desktop，实际体验直追原生Cladue Desktop+Fable5。

CCDesktop 3P有个硬伤就是没法 remote control（沟槽的A➗把这个功能跟CD1P绑死了。。。你把我号封了我还怎么用 remote control）

很想找回之前使用官方订阅时躺在床上控制电脑端开发的那种松弛感，干脆自己搓一个（Codex你给点力啊）

第一阶段先确保能在局域网环境下使用，基于我现在 Macbook+Android 这种奇妙搭配，做到之前 remote control 能做到的一切

（沟槽的A➗做了私有协议没法做到会话3端实时同步，退而求其次，bridge 电脑端和手机端实时同步，CCDesktop 能做到重启后同步bridge 全部进度）

下一阶段 V0.3 开始研究怎么跨网实现

下面是Codex写的：

Bridge 0.2 是运行在电脑上的 Claude 会话客户端。电脑端 Bridge 与 Android/iOS
共享同一个 Claude `sessionId`、同一个持久执行进程和同一条有序事件流。

它面向已经通过第三方 Host 或 Gateway 登录 Claude Desktop、但不能使用官方
Remote Control 的用户。官方 Claude 账号已经具备 Remote Control 时，无需使用
Bridge。

## 使用方式

1. 在电脑安装并打开 Bridge，保持第三方登录的 Claude Desktop 可用。
2. 在 Bridge 的“设备”页生成二维码，用手机 Bridge 扫描一次。
3. 手机依次进入“主机 -> 项目 -> 会话”，即可查看历史、继续对话、审批工具、
   回答 Claude 提问、调整或停止任务。

Bridge 不点击输入框，不粘贴内容，不申请辅助功能权限，也不读写系统剪贴板。
Bridge 接管后，电脑端 Bridge 是主要桌面界面，手机是远程界面；原 Claude
Desktop 窗口不承诺即时刷新，释放后仍可重新打开同一份完整会话历史。

## 0.2 已实现

- Claude Agent SDK 持久 Streaming Input，准确 `resume`，`forkSession:false`。
- 主机、项目、会话三层导航，可创建会话、搜索、分页读取完整历史。
- `SessionBroker` 单写入者状态机，每台主机最多两个并行 turn，其余持久排队。
- 手机在桌面会话运行时可立即入队，空闲后自动接管，无需电脑先发送消息。
- 用户消息、助手流式输出、工具进度、审批、提问、完成、失败和中断实时同步。
- 本地追加式 JSONL 事件日志，单调递增 `seq`，断线后按 cursor 恢复。
- 协议 v2 请求/响应/事件/快照和六级投递状态，传输 ACK 不冒充任务完成。
- 每台手机独立凭据、独立 AES-256-GCM 密钥、定向信封和按设备 ACK。
- 十分钟单次二维码、单设备撤销、离线密文队列、重复投递去重。
- Android/iOS 内容为空的 FCM/APNs 唤醒通道，正文仅在 App 打开后端到端解密。
- 电脑端“会话 / 设备 / 状态”控制台、托盘、开机启动和脱敏诊断导出。
- 首次升级归档 0.1 队列，并只移除 Bridge 自己写入的 MCP 与 HTTP Hooks。

0.2 不再包含 MCP 主通道、一次性 `claude -p` worker、`--fork-session`、隐藏
旁路会话或 Claude 官方登录入口。

## 本地运行

要求 Node.js 22.13 以上。

```bash
npm install
npm run dev:desktop
```

默认启动：

- Relay：`ws://127.0.0.1:8788/ws`
- 手机/PWA：`http://localhost:5188`
- Electron 电脑端

开发模式会将环回地址转换为本机局域网地址，Android 与电脑在同一 Wi-Fi
即可扫码联调。

## 验证与构建

```bash
npm run verify
BRIDGE_M0_REAL=1 npm test -w @bridge/desktop -- \
  --run src/claude-session-host.real.test.ts
npm run test:visual
npm run build:android:debug
npm run make -w @bridge/desktop
```

M0 真实闸门使用一次性项目和可丢弃会话验证同一 transcript 的多轮持久输入、
流式回复、真实工具审批、中断和断线恢复，并检查活动应用与剪贴板前后不变。

## 目录

```text
apps/client        手机端与电脑端 React 界面
apps/desktop       Electron Host、会话内核和本地事件日志
apps/mobile        Android / iOS Capacitor 壳
apps/relay         密文中继与无正文推送唤醒
packages/protocol  协议 v2、加密和可靠 WebSocket
deploy             Docker / Caddy / Nginx
docs               架构、安全与发布说明
```

生产环境必须提供固定 HTTPS/WSS、FCM/APNs 凭据以及各平台签名和自动更新渠道。
详见 [发布手册](docs/RELEASE.md) 与 [安全模型](docs/SECURITY.md)。

License: MIT
