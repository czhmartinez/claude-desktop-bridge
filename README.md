# Claude Desktop Bridge

首先这是一个专门针对第三方登录Claude desktop时使用的手机同步开发工具，仅限此种使用场景。

这段是我自己写的：

天下苦Anthropic久矣，3天内封了我5个Max订阅账号，A➗你是真的➗。

但是架不住Claude Desktop确实好用(她真的不一样），尤其是K3发布之后接进了Claude Desktop，实际体验直追原生Cladue Desktop+Fable5，远超kimi自家应用体验，kimi的桌面端真的是一坨。

然鹅CD3P有个硬伤就是没法remote control，遍寻github好像也没有专门给CD解决remote control的方案，比较成熟的方案都是给cc的（沟槽的A➗把这个功能跟CD1P绑死了，你把我号封了我还怎么用 remote control）。

很想找回之前使用官方订阅时躺在床上控制电脑端开发的那种松弛感，干脆自己搓一个（Codex你给点力啊）

第一阶段先确保能在局域网环境下使用，基于我现在 Macbook+Android 这种奇妙搭配，做到之前 remote control 能做到的一切

（沟槽的A➗做了私有协议没法做到会话3端实时同步，退而求其次，bridge 电脑端和手机端实时同步，CCDesktop 能做到重启后同步bridge 全部进度）

V0.3自测可用，公网中继暂时使用自己的域名。同网环境下优先手机 PC 直连和本地中继

然后下面这些都是Codex写的：

## 当前稳定版：0.4.0

Bridge 0.4.0 新增“成果证据层”：手机不只远程控制 Claude 会话，还能验证这一轮
调用了什么工具、命令是否成功、哪些文件发生变化，以及有哪些成果可以预览或下载。

- Bridge 发起的任务保留 Agent SDK 工具输入、状态、脱敏输出和退出码，并以任务
  开始时的真实工作区为基线归因新增、修改、删除和重命名。
- 原生 Claude Desktop 会话从 JSONL 事后恢复工具、命令和路径线索，固定标记为
  “事后恢复”，不冒充实时或完整记录。
- 每轮显示“精确 / 事后恢复 / 部分”可信度；并发修改、扫描超限、权限不足和延迟
  写入都会明确降级。
- 对话增加成果摘要与“对话 / 成果”分段页。归档完成的证据只跟随对应轮次显示；
  正在采集的证据和无法匹配轮次的历史证据只进入“成果”页，不常驻堆在运行任务下方。
  文本、代码和 diff 可只读查看，图片直接预览，HTML 在禁网沙箱中渲染为静态截图。
- PDF 和普通二进制只显示元数据并按需下载。单文件上限 20 MiB，传输按 256 KiB
  分块、支持缺块重试，并在落地前校验 SHA-256。
- 文件正文不随证据事件自动发送；只有用户打开预览或下载时才端到端传输。已缓存
  预览可离线查看，Relay 不保存可解密成果。
- 不展示或推断隐藏 CoT，不依赖 Claude Desktop 私有 CDP，也不提供项目目录树、
  远程编辑器、动态站点托管或自动启动服务。

0.4.0 使用协议 V3 和配对 schema V4，不兼容 0.3 配对。升级后保留稳定主机 ID、
设置、会话历史与本地事件，但会轮换房间和端到端密钥并清空旧设备授权；手机会将
旧主机标记为“需要重新配对”，扫描新二维码后按同一主机接回本地缓存。

Relay 始终保留一个低流量控制连接，用于信令、设备撤销、离线队列、推送唤醒和
直连失败回退。界面显示“直连”时业务数据不经过 Relay；显示“安全中继”或
“局域网连接”时业务数据使用相应 Relay 路径。

Bridge 0.4.0 是运行在电脑上的 Claude 会话客户端。电脑端 Bridge 与 Android/iOS
共享同一个 Claude `sessionId`、同一个持久执行进程和同一条有序事件流。

它面向已经通过第三方 Host 或 Gateway 登录 Claude Desktop、但不能使用官方
Remote Control 的用户。官方 Claude 账号已经具备 Remote Control 时，无需使用
Bridge。

## 使用方式

1. 在电脑安装并打开 Bridge，保持第三方登录的 Claude Desktop 可用。
2. 将电脑端和手机端都升级到 0.4.0，在 Bridge 的“设备”页扫描新二维码完成强制重配。
3. 手机依次进入“主机 -> 项目 -> 会话”，即可查看历史、继续对话、审批工具、
   回答 Claude 提问、调整或停止任务。

Bridge 不点击输入框，不粘贴内容，不申请辅助功能权限，也不读写系统剪贴板。
Bridge 接管后，电脑端 Bridge 是主要桌面界面，手机是远程界面；原 Claude
Desktop 窗口不承诺即时刷新，但可以随时打开并只读查看同一份会话历史，单纯点击
不会中断 Bridge。只有在 Claude Desktop 中实际发送新消息时才会触发写入冲突保护。
手机向空闲的 Claude Desktop 会话发送指令时，Bridge 会确认目标 transcript 已到达
安全完成边界后直接接续，无需退出 Claude Desktop；电脑端仍有任务执行时保持排队。
Claude Desktop 正在回复、调用工具或等待工具结果时统一显示“桌面运行中”；只有
观察到明确的回合完成边界后才显示“桌面待机”。

## 发布下载

最新桌面安装包见 [GitHub Releases](https://github.com/czhmartinez/claude-desktop-bridge/releases/latest)。
当前桌面发布工作流只构建 macOS（`macos-15`）；Windows / Linux 桌面安装包暂不随 CI 发布。
Actions 中标注 `adhoc-ci` 的安装包只用于构建验证；Release 附件使用本机稳定签名，
用于保留 macOS Files & Folders 授权。

版本号文件推送到 `main` 后，`release.yml` 会先校验根包、全部 workspace、
`package-lock.json`、Android `versionName` 和 iOS `MARKETING_VERSION` 完全一致，
再执行完整验证、生成提交日志并创建 tag 和 GitHub Release。该流程不会把 ad-hoc
macOS 构建冒充正式安装包，也不会自动上传未签名附件。

**固定发布规则：**本地开发只负责更新代码与 README、提交并推送。新版本号升级由
GitHub Copilot 发起，tag 和 GitHub Release 交给自动工作流；正式签名附件仍由独立
发布流程处理。本地不介入，也不检查 Release 是否发布成功。

## 0.4.0 已实现

- `BridgeEvidenceBundle`、工具证据、产物清单、预览与分块传输的协议 V3 契约。
- SQLite 证据清单、Electron `safeStorage` 主密钥、AES-256-GCM 内容寻址快照，以及
  30 天或 1 GiB 的 LRU 正文清理；清单在正文过期后继续保留。
- Git 与非 Git 项目的有界工作区基线、文件监听、静默等待、脏改动排除和并发降级。
- Claude Desktop JSONL 按 inode、偏移量和消息 ID 增量恢复工具记录，兼容半写入、
  重复扫描、截断与轮转，并忽略 `thinking`。
- 敏感路径阻止、`realpath` 根目录约束、符号链接逃逸拒绝、工具输出凭据脱敏。
- 文本、代码、diff、图片与隔离 HTML 截图预览；PDF/二进制按需下载。
- 256 KiB 应用层分块、10 分钟租约、断线缺块重试、20 MiB 硬上限和最终哈希校验；
  正文响应带认证临时标记，只在线转发，不进入 Relay 持久队列。
- 桌面与移动端成果摘要、成果页、按轮次定位、可信度、失败状态、离线清单和缓存预览。
- 0.3 已有的持久 Agent SDK 会话、单写入者保护、可靠 WSS、WebRTC 直连、事件恢复、
  审批、提问、停止、推送唤醒、主机/项目/会话导航和稳定签名发布门继续保留。

0.4.0 不包含隐藏 CoT、Claude Desktop 实时工具镜像、私有 CDP、完整项目浏览、
远程编辑、动态站点直播、自动启动服务、PDF 内嵌渲染或超过 20 MiB 的产物传输。

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

开发模式会将环回地址转换为本机局域网地址。正式构建写入固定
`BRIDGE_PUBLIC_RELAY_URL` 后，Android 与电脑无需处于同一网络。

## 验证与构建

```bash
npm run audit:runtime
npm run verify
npm run probe:relay
npm run test:html-preview
BRIDGE_M0_REAL=1 npm test -w @bridge/desktop -- \
  --run src/claude-session-host.real.test.ts
npm run test:visual
npm run build:android:debug
BRIDGE_MAC_SIGN_IDENTITY='<代码签名身份 SHA-1>' npm run make -w @bridge/desktop
```

M0 真实闸门使用一次性项目和可丢弃会话验证同一 transcript 的多轮持久输入、
流式回复、真实工具审批、中断和断线恢复，并检查活动应用与剪贴板前后不变。
没有签名身份时仅可用 `npm run make:adhoc -w @bridge/desktop` 生成一次性测试包；
ad-hoc 包覆盖升级会导致 macOS 再次请求“文稿 / 桌面”等 Files & Folders 授权。
个人 Mac 可按发布手册显式执行一次 `signing:setup-local`，之后用
`make:local-signed` 生成身份稳定的本机测试包；对外发布仍必须使用 Developer ID。

## 目录

```text
apps/client        手机端与电脑端 React 界面
apps/desktop       Electron Host、会话内核和本地事件日志
apps/mobile        Android / iOS Capacitor 壳
apps/relay         密文中继与无正文推送唤醒
packages/protocol  协议 v3、加密和可靠 WebSocket
deploy             Docker / Caddy / Nginx
docs               架构、安全与发布说明
```

Bridge 0.4.0 默认构建已经配置固定公网 WSS 与 Cloudflare 公共 STUN。自托管部署
必须提供自己的固定 HTTPS/WSS，并显式配置 STUN/TURN。FCM/APNs 凭据、各平台
签名和自动更新渠道仍属于正式发布条件。
详见 [发布手册](docs/RELEASE.md) 与 [安全模型](docs/SECURITY.md)。

License: MIT
