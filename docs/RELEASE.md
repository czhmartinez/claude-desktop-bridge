# 发布手册

## 1. 部署服务

准备一台有公网域名的 Linux 主机：

```bash
cp .env.example .env
# 将 BRIDGE_DOMAIN 改为自己的域名，并把 DNS A/AAAA 记录指向主机
docker compose up -d --build
curl https://你的域名/health
```

Caddy 自动申请 TLS 证书。生产入口同时承载手机 Web App 与 `/ws` Relay。

## 2. 构建桌面安装包

构建时将服务地址写入安装包：

```bash
BRIDGE_RELAY_URL=wss://你的域名/ws \
BRIDGE_PAIRING_BASE_URL=https://你的域名 \
npm run make -w @bridge/desktop
```

Electron 安装包必须在目标操作系统构建：macOS 产出 DMG/ZIP，Windows 产出 Squirrel 安装器，Linux 产出 ZIP/DEB/RPM。

## 3. 构建移动端

本地 Android 真机联调可直接生成 Debug APK：

```bash
npm run build:android:debug
```

产物位于 `apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk`，支持 Android 8.0 及以上。Debug 包仅为同一局域网联调放行明文 `ws://`；Release 构建不会继承该策略，生产环境仍必须使用 HTTPS/WSS。

首次创建或更新原生工程时使用：

```bash
npm run add:android -w @bridge/mobile
npm run add:ios -w @bridge/mobile
npm run sync -w @bridge/mobile
```

随后用 Android Studio / Xcode 签名发布。没有 Apple Developer 证书时只能构建模拟器版本，不能生成可安装到真实 iPhone 的正式包。

Android 原生扫码依赖最低 API 26（Android 8.0）；iOS 工程已包含相机用途说明。商店包仍需在真机上验证相机授权、扫码取消和弱网重连。

## 4. 发布前必做

- 配置 macOS Developer ID、notarization。
- 配置 Windows Authenticode 证书。
- 配置 Android keystore。
- 配置 Apple Developer Team 与 provisioning profile。
- 在真实公网 WSS 上执行端到端测试，而不只测 localhost。
