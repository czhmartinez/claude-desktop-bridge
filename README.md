# Bridge

> English: [README_EN.md](README_EN.md) · Contributing: [CONTRIBUTING.md](CONTRIBUTING.md)

Bridge 0.7 是一个独立的多 Desktop 协作产品：它给 Claude Desktop、Codex Desktop 和 Hermes Desktop
提供一致的会话、发送、流式输出、审批、追问和中断体验，并支持把一段任务经用户确认后
跨 Desktop 串行接力，但不会把三者的原生会话、账号、模型、权限或历史合并到一起。

## 早期背景

这段是我自己写的：

天下苦Anthropic久矣，3天内封了我5个Max订阅账号，A➗你是真的➗。

但是架不住Claude Desktop确实好用(她真的不一样），尤其是K3发布之后接进了Claude Desktop，实际体验直追原生Cladue Desktop+Fable5，远超kimi自家应用体验，kimi的桌面端真的是一坨。

然鹅CD3P有个硬伤就是没法remote control，遍寻github好像也没有专门给CD解决remote control的方案，比较成熟的方案都是给cc的（沟槽的A➗把这个功能跟CD1P绑死了，你把我号封了我还怎么用 remote control）。

很想找回之前使用官方订阅时躺在床上控制电脑端开发的那种松弛感，干脆自己搓一个（Codex你给点力啊）

第一阶段先确保能在局域网环境下使用，基于我现在 Macbook+Android 这种奇妙搭配，做到之前 remote control 能做到的一切

（沟槽的A➗做了私有协议没法做到会话3端实时同步，退而求其次，bridge 电脑端和手机端实时同步，CCDesktop 能做到重启后同步bridge 全部进度）

V0.3自测可用，公网中继暂时使用自己的域名。同网环境下优先手机 PC 直连和本地中继

然后下面这些都是Codex写的：

## 当前开发版：0.7.0

Bridge 0.7 在 0.6 的统一操作体验上新增**跨 Desktop 串行接力**：任何会话顶栏的「接力」
按钮可以把当前任务交给另一个 Desktop 运行时接手。接力不是会话迁移——Bridge 会安全中断
源任务，把有界、脱敏、加密的可见上下文包交给目标运行时上**新建的原生会话**，两个会话
通过接力链双向链接，原生身份与历史始终各自独立。

- **先计划，后执行**：目标运行时先只读制定计划（Codex 使用原生 plan 协作模式，
  Claude/Hermes 使用只读规划约定）；Bridge 展示完整计划，用户确认或修改执行目标后，
  才以 goal 模式开始执行。
- **goal 模式**：Codex 目标使用原生 thread goal 持续执行并镜像状态回 Bridge；
  Claude/Hermes 目标由 Bridge 编排目标循环（`GOAL_STATUS` 标记、最多 20 次自动续跑、
  受阻/完成上报）。在目标会话点停止会同时暂停 goal，暂停或受阻的 goal 可以随时恢复。
- **两次确认，永不自动**：接力需要「确认接力」和「确认计划」两次人工确认；没有自动
  故障转移，没有凭据迁移，接力包不含隐藏思维、OAuth、API Key 或项目外内容。
- **故障闭合**：接力各阶段持久化在 `conversation-state-v1.sqlite`；Bridge 重启时
  准备/执行中的接力安全停止且绝不重发，已完成计划从目标历史恢复，活动 goal 与目标
  运行时对账恢复。

协议仍为 V3、配对 schema 仍为 V4；0.4-0.6 客户端会忽略接力事件与元数据并隐藏接力
入口，已配对设备无需重配。

## 0.6 多 Desktop 运行时（延续）

Bridge 0.6 不再把自己定义为 Claude 的单一 tunnel。它保留一条加密的手机与 Bridge Host
连接，并在 Host 内注册独立的 Desktop adapter：Claude 继续使用既有 `SessionBroker`；Codex
通过 Bridge 自己启动的本地 `codex app-server --stdio` 接入；Hermes 通过 Bridge 自己启动的
仅环回 Gateway 接入。统一列表只是入口索引，原生会话身份始终是
`(runtimeId, nativeSessionId)`。

- **统一操作，不统一会话**：任何任务都可在 Bridge 中查看、继续、steer、审批、回答追问和中断；
  Claude、Codex 与 Hermes 不会互相迁移、共享上下文或自动故障转移。
  0.7 新增的跨 Desktop 接力是例外中的严格手动路径：它只在用户两次确认后，把有界可见
  上下文交给目标运行时的新会话，不迁移原生会话本身。
- **本地最小权限**：Codex adapter 不附着或改写已经运行的 Desktop 进程；Hermes adapter 只接受
  环回 WebSocket，Bridge 为自己启动的 Gateway 生成进程级随机令牌，且不读取 Hermes Desktop 的
  token/keychain。
- **能力按运行时声明**：文本会话、流、工具、审批和中断是 0.6 的共同基线；图片附件和模型配置
  只在对应 adapter 确认支持时开放。Codex/Hermes 的会话配置通过各自 Desktop 的原生接口应用，
  不会变成 Bridge 的跨运行时 provider 或全局凭据配置。
- **Claude 域内功能保持独立**：原有多 provider lane 与 handoff 仍只在 Claude 域内工作，不能用于
  Codex/Hermes 跨应用迁移。

协议仍为 V3、配对 schema 仍为 V4；`runtimes`、`runtimeId` 与 `nativeSessionId` 是可选快照字段，
旧客户端会忽略它们，新客户端会显示 Desktop 归属与筛选。

## Claude 域功能（延续自 0.5）

Bridge 0.5.3 将 Windows 无交互 Squirrel 安装器替换为辅助式 NSIS 安装向导。安装时会
显示目录选择页，用户可以改到任意有写权限的位置；Windows 门禁会把安装包静默安装到
随机自定义目录，再从该目录完成冷启动、界面和加密配对检查。0.5.2 的空发布变量
`Invalid URL` 修复继续保留；0.5.3 兼容 0.5.1/0.5.2 手机端，不需要重新配对。

Bridge 0.5.1 增加电脑级“标准授权 / 完全授权”、单会话覆盖和手机后台连续性。
完全授权由电脑端 `PermissionBroker` 自动批准命令与文件修改，Claude 提问仍必须由
用户回答；手机退到后台或进程被回收不会停止电脑任务，重新打开后会恢复最近主机、
会话和遗漏事件。

Bridge 0.5.0 引入的“多提供方会话接力层”继续保留。Bridge `sessionId` 是稳定逻辑对话
ID；Claude-3p、Anthropic API 与 Claude 官方订阅分别作为同一逻辑对话下的执行
lane。切换只迁移用户可见、可验证且有界的上下文，不声称迁移隐藏 CoT、服务端缓存
或原生运行态。

- **Claude-3p**：继续使用 Agent SDK 与当前 Host Credentials，支持执行、审批、
  工具、成果和精确证据。
- **Anthropic API**：API Key 只能在 Bridge 电脑端显式输入，并只由 Electron
  `safeStorage` 保存；不存在明文或 base64 降级。Bridge 使用 `GET /v1/models`
  验证 Key 与模型清单，调用费用由 Anthropic API 单独计费，不继承 Host/OAuth
  凭据、第三方 Base URL 或云提供方路由。
- **Claude 官方订阅**：只通过公开
  `claude://code/new?q=...&folder=...` Deep Link 新建官方会话。用户在 Bridge 电脑上确认
  目录并发送第一条接力消息后，Bridge 才会按官方 profile、`realpath` cwd、不透明
  handoff ID、首条消息哈希与十分钟窗口完成关联。激活后 Bridge 只读观察，输入区
  替换为“在 Claude 官方继续”；不提取或代理 Pro/Max OAuth，不使用私有 CDP，也不
  修改 Claude 私有侧边栏元数据。
- 切换只能手动触发。有运行中或待发送任务时会被阻止；失败、取消、超时、崩溃或
  首条消息投递不确定时，原 lane 保持活动且不会自动重发。零匹配或多匹配不会猜测。
- 完整接力包在 Host 本机加密保存，包含目标、近期可见对话、约束、未完成事项、
  工具和成果摘要、文件/哈希、cwd、Git 状态、源事件序号与完整性哈希。可执行通道
  最多 48,000 字符，官方 Deep Link 最多 12,000 字符；凭据、认证头、敏感正文、
  项目外内容与无界工具输出不会进入接力包。
- 新的 `conversation-state-v1.sqlite` 持久化逻辑对话、lane、接力、队列、终态回执
  和迁移标记。旧 `sessions-v2.json` 与 `turn-queue-v2.json` 幂等迁移；连续两次
  成功启动后只改名为 `.migrated`，不删除。
- V0.4.2 的跨 Claude/Claude-3p profile 原始恢复阻止、ultracode 1M 上下文识别和
  synthetic `Prompt is too long` 去重继续生效。

0.6.1 继续使用协议 V3 和配对 schema V4；已配对的 0.4/0.5 设备无需重配。V0.6 客户端
连接 V0.4 Host 时会按能力缺失隐藏新增入口；V0.4/0.5 客户端连接 V0.6 Host 时会忽略
`runtimeId`、`nativeSessionId` 和 `runtimes`，仍可沿用既有 Claude 可写 lane；需要
Desktop 归属筛选和外部 adapter 的统一体验时应升级到 V0.6。它仍不兼容
0.3 配对：从 0.3 升级后会保留稳定主机 ID、
设置、会话历史与本地事件，但会轮换房间和端到端密钥并清空旧设备授权；手机会将
旧主机标记为“需要重新配对”，扫描新二维码后按同一主机接回本地缓存。

Relay 始终保留一个低流量控制连接，用于信令、设备撤销、离线队列、推送唤醒和
直连失败回退。界面显示“直连”时业务数据不经过 Relay；显示“安全中继”或
“局域网连接”时业务数据使用相应 Relay 路径。

Claude Desktop 仍保留其既有会话与 lane 行为。它面向已经通过第三方 Host 或 Gateway
登录 Claude Desktop、但不能使用官方 Remote Control 的用户；也可以把一段 Claude 域内
Bridge 工作手动接力到 Claude 官方本机应用，但官方 lane 不提供 Bridge 远程写入。

## 使用方式

1. 在电脑安装并打开 Bridge，启动需要使用的 Claude Desktop、Codex Desktop 或 Hermes Desktop。
2. Bridge 会发现本机 adapter；在桌面或手机的“项目与会话”中按 Desktop 归属筛选，或在创建任务时
   选择目标 runtime。
3. 手机依次进入“主机 -> 项目 -> 会话”，即可查看历史、继续对话、审批工具、回答追问、调整或停止任务。
   Claude 域内的 provider handoff 仍在会话顶栏单独触发；跨 Desktop 接力则在任意会话
   顶栏通过「接力」按钮发起，先确认接力、再在计划就绪后确认执行。

Bridge 不点击输入框，不粘贴内容，不申请辅助功能权限，也不读写系统剪贴板。
Bridge 接管 Claude Desktop 已有会话后，电脑端 Bridge 是主要桌面界面，手机是远程
界面；原 Claude Desktop 窗口不承诺即时刷新，但可以随时打开并只读查看同一份会话
历史，单纯点击不会中断 Bridge。只有在 Claude Desktop 中实际发送新消息时才会触发
写入冲突保护。直接在 Bridge 新建的会话仍由独立 Agent SDK session 执行；首轮
transcript 可验证后，Bridge 只登记它与 Claude Desktop `local_*` 会话 ID 的映射。
电脑端出现“等待 Claude Desktop 重启”时，点击“重启并登记”即可让它出现在侧边栏。
登记只改变可发现性，不改变执行归属，所以 Bridge 中仍如实显示“Bridge 运行中 /
Bridge 待机”，不会把它伪装成 Desktop 原生任务。
手机向空闲的 Claude Desktop 会话发送指令时，Bridge 会确认目标 transcript 已到达
安全完成边界后直接接续，无需退出 Claude Desktop；电脑端仍有任务执行时保持排队。
Claude Desktop 正在回复、调用工具或等待工具结果时统一显示“桌面运行中”；只有
观察到明确的回合完成边界后才显示“桌面待机”。
提供方接力不会复制原生会话。切回 Claude-3p 或 Anthropic API 时，Bridge 只复用
同一 provider 下仍安全可用的历史 lane；否则创建新 lane 并注入新的结构化接力。

## 发布下载

最新桌面安装包与 Android APK 见
[GitHub Releases](https://github.com/czhmartinez/claude-desktop-bridge/releases/latest)。
自 0.9.0 起，Windows、Linux 和 iOS 与 macOS、Android 同为常态化发布平台：
版本推送到 `main` 后会自动打 release tag 并在 tag 上构建桌面
（macOS `adhoc-ci`、Windows `installer-ci`、Linux `installers-ci`）与移动端
（Android 调试 APK、iOS 模拟器与未签名设备包）产物，草稿 Release 集齐 `-ci`
附件后才公开（兼容 immutable releases）。
Windows 附件默认可能未签名，正式分发必须追加 Authenticode 签名；macOS
`adhoc-ci` 与 iOS 未签名包只用于构建验证，正式 macOS/iOS 分发仍由独立签名
流程处理，Release 正式附件使用本机稳定签名以保留 macOS Files & Folders 授权。

Windows 版与 macOS 版共享 Bridge Host、Claude Code/Claude-3p Host、Anthropic API、
Relay、证据、普通 Claude Desktop 启动/退出控制，以及官方 Deep Link、首条消息关联和
Claude Desktop 会话清单登记。Windows 使用 `%APPDATA%\Claude\claude-code-sessions`
并通过 PowerShell/tasklist 做进程检查；用户无需手工复制配置。私有 CDP 和隐藏协议仍在
两个平台都不启用，避免绕过 Anthropic 授权。

0.6.1 的“标准授权 / 完全授权”、单会话覆盖、手机离线继续执行和 `events.resume`
同样运行在 Windows Host。`windows-2022` 门禁会执行完整 typecheck/test、NSIS
自定义目录安装、打包版 UI 检查和真实加密配对；Windows 真机上的 DPAPI 跨重启、托盘常驻和
手机断线恢复仍必须在发布前单独验收。

版本号文件推送到 `main` 后，`release.yml` 会先校验根包、全部 workspace、
`package-lock.json`、Android `versionName` 和 iOS `MARKETING_VERSION` 完全一致，
再执行完整验证并创建 release tag；`release-assets.yml` 随后构建桌面与移动端
全部产物、生成提交日志，并在草稿中集齐 `-ci` 附件后公开 GitHub Release。
未签名附件一律以 `-ci` 命名标注，不会把 ad-hoc macOS 构建或未签名 iOS 包
冒充正式安装包。

**固定发布规则：**本地开发只负责更新代码与 README、提交并推送。新版本号升级由
GitHub Copilot 发起，tag 和 GitHub Release 交给自动工作流；正式签名附件仍由独立
发布流程处理。本地不介入，也不检查 Release 是否发布成功。

## 0.6.1 当前能力

- `RuntimeAdapterRegistry` 和 `RuntimeSessionBroker` 将 Claude、Codex、Hermes 的会话统一呈现为
  同一套列表、对话、流、审批、追问、调整与中断操作，同时用 `(runtimeId, nativeSessionId)`
  彻底隔离会话身份。
- Codex 使用 Bridge 自己启动的官方 `codex app-server --stdio`；Hermes 使用 Bridge 自己启动的
  仅环回 Gateway 和进程级随机令牌。Codex 只读取 `config.toml` 中 provider section 的名称元数据，
  不提取、不记录或传输原生 Desktop 的账号、token/keychain。
- 运行时能力决定可见控件：当前外部 adapter 支持文本、流、工具、审批、追问、调整和中断；
  图片附件与模型、provider、思考强度和快速模式配置只在相应 adapter 声明支持时开放；Codex/Hermes
  的这些会话级设置由 Bridge 转发给各自 Desktop，账号、token、keychain 和其他全局配置仍由原生 Desktop 管理。
- 电脑默认与单会话授权模式、切换后立即处理待授权队列、自动批准审计，以及
  `AskUserQuestion` 始终等待用户回答。Claude 会话使用全局电脑默认；Codex 与 Hermes
  会话使用各自运行时的电脑默认（互不影响），授权请求由 Bridge 在完全授权下立即自动批准。
- 会话归档与删除（0.7.4）：归档把会话收入"已归档"分组、保留全部历史且可一键恢复；
  删除清除 Bridge 侧记录（会话配置、排队、回执、授权覆盖）并写入墓碑，Claude 目录扫描
  与 Codex/Hermes 原生重发现都不会让会话复活；原生应用内的数据不受影响。运行中或接力中的
  会话拒绝删除。
- 手机后台、网络恢复和推送唤醒统一重连 `events.resume`；进程重启后恢复最近主机、
  会话和去重后的完成事件。
- 稳定逻辑对话 ID、每对话多 lane 单活动路由、手动接力状态机，以及 Desktop /
  Android 一致的提供方入口和等待状态。
- Provider profile、lane、handoff、路由允许动作和证据归属的协议 V3 向后兼容扩展。
- Anthropic API 模型发现、本机安全 Key 管理、独立计费提示与凭据环境隔离。
- Claude 官方公开 Deep Link、一次本机确认、严格 transcript 关联和只读观察。
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

0.6.1 不包含隐藏 CoT、官方 OAuth 代理、自动故障转移、跨 Desktop 会话/账号/模型/权限
迁移、Claude Desktop 实时工具镜像、私有 CDP、完整项目浏览、远程编辑、动态站点直播、
自动启动服务、PDF 内嵌渲染或超过 20 MiB 的产物传输。

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

Windows 安装包必须在 Windows 上构建：

```powershell
npm run make:windows
npm run build -w @bridge/relay
npm run test:desktop:packaged:windows
```

产物位于 `apps/desktop/out/make/nsis.windows/x64/`，其中 `Bridge-0.6.1-Setup.exe`
会打开辅助式安装向导并显示目录选择页，不再静默固定到 Squirrel 的用户目录。应选择
当前账户可写的位置，受管电脑可使用例如 `F:\Apps\Bridge`，不要选择被 IT 策略锁定的
`ProgramData`。未签名包可能出现 SmartScreen 提示，仅适合本机/CI 验收。正式分发前在
Windows CI 或本机注入 `BRIDGE_WIN_CERTIFICATE_FILE` 与
`BRIDGE_WIN_CERTIFICATE_PASSWORD`，也可使用 electron-builder 标准的 `WIN_CSC_LINK` 与
`WIN_CSC_KEY_PASSWORD` 完成 Authenticode 签名；仓库不会保存证书或密码。

Linux 安装包必须在 Linux（本机或 `ubuntu-latest` runner）上构建：

```bash
sudo apt-get install -y rpm fakeroot dpkg
npm run make:linux
```

产物位于 `apps/desktop/out/make/`（ZIP/DEB/RPM），未签名包仅适合本机/CI 验收。
iOS 常态化构建与 CI、发布工作流共用同一入口：

```bash
npm run build:ios:simulator   # 模拟器 App（未签名）
npm run build:ios:device      # 设备 App（未签名，仅构建验证）
```

M0 真实闸门使用一次性项目和可丢弃会话验证同一 transcript 的多轮持久输入、
流式回复、真实工具审批、中断和断线恢复，并检查活动应用与剪贴板前后不变。
没有签名身份时仅可用 `npm run make:adhoc -w @bridge/desktop` 生成一次性测试包；
ad-hoc 包覆盖升级会导致 macOS 再次请求“文稿 / 桌面”等 Files & Folders 授权。
个人 Mac 可按发布手册显式执行一次 `signing:setup-local`，之后用
`make:local-signed` 生成身份稳定的本机测试包；对外发布仍必须使用 Developer ID。
V0.6 的本机验收必须同时交付 DMG 与 Android APK；除非改动明确仅限桌面原生层，
不得只更新其中一个安装包。两端本机包统一使用
`npm run make:local:desktop-android` 生成。

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

Bridge 0.8 默认构建使用国内 Relay `wss://relay.alioxis.com/ws`，并优先使用
`stun:stun.alioxis.com:3478`，保留 Cloudflare 公共 STUN 作为备用。升级后的桌面端和
移动端会保留已存自定义 ICE 与 Relay 端点；历史 Cloudflare 单项默认值会平滑升级，
不需要清空既有配对。自托管部署必须提供自己的固定 HTTPS/WSS，并显式配置
STUN/TURN。FCM/APNs 凭据、各平台签名和自动更新渠道仍属于正式发布条件。
详见 [发布手册](docs/RELEASE.md)、[Relay 部署手册](docs/RELAY-REDEPLOY.md) 与 [安全模型](docs/SECURITY.md)。

License: MIT

申请 OpenAI 开源计划与推广材料见
[OpenAI 开源申请与推广手册](docs/OPENAI-OPEN-SOURCE.md) 与
[推广手册](docs/PROMOTION.md)。
