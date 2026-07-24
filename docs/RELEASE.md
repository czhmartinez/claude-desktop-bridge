# Bridge 0.3 发布手册

## 1. 发布闸门

```bash
npm ci
npm run verify
BRIDGE_M0_REAL=1 npm test -w @bridge/desktop -- \
  --run src/claude-session-host.real.test.ts
npm run test:visual
```

M0 必须证明手机/测试客户端消息与 Claude 回复落入同一 `sessionId` 和同一 JSONL，
且测试前后的活动应用和剪贴板不变。SDK 不通过时停止发布，不能退回单次任务。

## 2. 部署 Relay 与 Web

```bash
cp .env.example .env
# 修改域名、Origin 和推送凭据
docker compose up -d --build
curl https://你的域名/health
curl https://你的域名/ready
```

生产入口同时承载静态客户端与 `/ws`，必须使用固定 HTTPS/WSS。自托管属于高级
选项；面向普通用户的安装包应写入 Bridge 托管 Relay。Relay 数据位于
`/data/bridge-relay.db`，WAL 和每日七份备份都必须位于持久卷。

0.3.1 同时启动 STUN-only Coturn。域名 A 记录必须指向服务器，腾讯云安全组和
主机防火墙需放行 TCP/UDP `3478`；无需开放 TURN 的 `49152-65535` 端口范围。
客户端从 `BRIDGE_SERVICE_ORIGIN` 的主机名自动派生
`stun:你的域名:3478`。可用以下命令验证监听状态：

```bash
docker compose ps stun
docker compose logs --tail=50 stun
```

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
BRIDGE_PAIRING_BASE_URL=https://你的域名 \
npm run make -w @bridge/desktop
```

启动打包后的应用并开放临时 CDP 端口后，必须再执行：

```bash
BRIDGE_DESKTOP_CDP=http://127.0.0.1:9223 npm run test:desktop:packaged
BRIDGE_DESKTOP_CDP=http://127.0.0.1:9223 npm run test:desktop:pairing
```

该检查会验证 preload、`file://` 资源、三页控制台、运行时快照和渲染错误，避免
开发版正常但安装包白屏；配对检查还会使用真实 Relay 完成一次设备认领、加密
请求、主机快照和撤销失效闭环。

Electron 安装包必须在目标系统构建：macOS 产出 DMG/ZIP，Windows 产出 Squirrel，
Linux 产出 ZIP/DEB/RPM。没有 Developer ID、Authenticode 或仓库签名时只能标记为
“构建通过”，不能宣称可正式分发。

## 5. 构建移动端

```bash
VITE_BRIDGE_PUBLIC_RELAY_URL=wss://你的域名/ws \
VITE_BRIDGE_SERVICE_ORIGIN=https://你的域名 \
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
- App 前后台、锁屏唤醒、扫码过期、单次二维码和设备撤销。
- 桌面 `file://` 资源、托盘、开机启动、睡眠恢复和升级覆盖。

桌面原生 WebRTC 运行时使用真实 DataChannel 门禁测试：

```bash
npm run test:webrtc:native
```
- 活动应用、键盘焦点和剪贴板不变，系统中无辅助功能授权请求。

稳定版矩阵为 macOS/Windows/Linux x Android/iOS。只有实机、签名与固定公网
WSS 全部通过的平台才能标记“可分发”。
