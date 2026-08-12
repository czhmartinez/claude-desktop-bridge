# Bridge Relay 腾讯云 CVM 重新部署手册

> 面向 `relay.alioxis.com`（腾讯云 CVM，`49.233.218.252`）的中继升级/重部署。
> 本文档把 0.7.9 实际执行过的一整套步骤固化成可复用流程；升级到任何后续版本时
> 只需把 `v0.7.9` 换成目标 tag，其余不变。

## 0. 本次部署背景（0.7.9）

0.7.9 修复了两个线上中继问题，必须重建 relay 容器才能生效：

1. **原生客户端来源被 Origin 白名单拒绝（手机配对失败根因）**：
   - Capacitor 手机端在 iOS 上报 `capacitor://localhost`、Android 上报
     `http://localhost` / `https://localhost`，Electron 桌面加载 `file://` 时可能上报
     `null`。
   - 旧 `BRIDGE_ALLOWED_ORIGINS` 只有 `https://` 域名，导致这些 WebSocket 升级被
     HTTP 403 拒绝——手机配对应答不稳定，只有不发 Origin 头的客户端（Node 桌面
     主进程）正常。
   - 修复：relay 对非浏览器协议来源（`capacitor://`、`bridge://`、`file://`、
     `null` 等）和回环来源永远放行；白名单只拦截远程网页来源。
2. **每连接帧预算过低导致隧道被掐断**：
   - 桌面端把每条事件扇出给每个已配对设备，活跃会话很容易超过旧上限 600 帧/分钟，
     被 `RATE_LIMITED` 断开（close 1008），随后反复重连，手机看到主机反复掉线。
   - 修复：新增 `BRIDGE_RELAY_MAX_FRAMES_PER_MINUTE`，默认 6000。

## 1. 部署目录结构（CVM 上现状）

```text
/opt/bridge-relay/
├── .env                     # compose 变量（非敏感运行参数）
├── relay.compose.yml        # 构建/启动 bridge-relay（build context = ./source）
├── relay.nginx.conf         # 渲染好的 nginx 段（已挂入 suntong-frontend）
├── relay.nginx.conf.template
├── install-relay-nginx.sh
├── source/                  # 仓库源码（git clone，可 checkout 任意 tag）
└── web/                     # 静态客户端（挂载进 bridge-web，一般不用动）
```

关键事实：

- relay 数据在命名卷 `bridge-relay-data`（SQLite WAL + 每日备份），**重建容器不丢数据**。
- nginx（`suntong-frontend` 容器）已配置 `/ws` → `bridge-relay:8788`，
  `proxy_read_timeout 3600s`、`proxy_buffering off`，**重部署 relay 不需要改 nginx**。
- 宿主机 `127.0.0.1:8788` 连不上是正常的——compose 用 `expose`，relay 只在
  `suntong_default` 网络内监听，公网一律走 nginx。

## 2. 前置确认

```bash
# SSH 登录（本机已有密钥 ~/.ssh/czh-tencent-cvm.pem）
ssh -i ~/.ssh/czh-tencent-cvm.pem root@49.233.218.252

# 环境
docker --version && docker compose version
git --version
docker ps --format '{{.Names}}\t{{.Image}}' | grep -E 'bridge|nginx'
```

应看到 `bridge-relay`（当前旧版本）、`bridge-web`、`suntong-frontend` 等容器。

## 3. 备份

```bash
cd /opt/bridge-relay
cp .env .env.bak-$(date +%Y%m%d-%H%M%S)
cp relay.compose.yml relay.compose.yml.bak-$(date +%Y%m%d-%H%M%S)
cp relay.nginx.conf relay.nginx.conf.bak-$(date +%Y%m%d-%H%M%S)
# 给旧镜像打个 tag，方便回滚
docker tag bridge-relay-relay bridge-relay-relay:pre-0.7.9-$(date +%Y%m%d) || true
```

## 4. 拉取目标版本源码

```bash
cd /opt/bridge-relay
rm -rf source.github-partial-*   # 清理历史遗留的 partial clone（如有）
git clone --depth 1 --branch v0.7.9 \
  https://github.com/czhmartinez/claude-desktop-bridge.git source
cd source && git log --oneline -1   # 应显示 v0.7.9 提交
```

## 5. 更新 .env

`BRIDGE_ALLOWED_ORIGINS` 必须包含托管页面域名 + 全部原生 WebView 来源；
`BRIDGE_RELAY_MAX_FRAMES_PER_MINUTE` 必须存在（0.7.9 起生效）。

```bash
cd /opt/bridge-relay
cat > .env <<'EOF'
BRIDGE_ALLOWED_ORIGINS=https://relay.alioxis.com,https://alioxis.com,https://www.alioxis.com,https://localhost,capacitor://localhost,bridge://localhost,http://localhost,ionic://localhost,file://
BRIDGE_RELAY_HOST=0.0.0.0
BRIDGE_RELAY_PORT=8788
BRIDGE_RELAY_DATA=/data/bridge-relay.db
BRIDGE_RELAY_NETWORK=suntong_default
BRIDGE_TRUST_PROXY=1
BRIDGE_RELAY_MAX_FRAMES_PER_MINUTE=6000
EOF
```

> 若自托管其它域名，把 `relay.alioxis.com` / `alioxis.com` 换成自己的域名，
> 并保留 `capacitor://localhost,bridge://localhost,http://localhost,https://localhost,
> ionic://localhost,file://` 这些原生来源。

## 6. compose 透传帧预算变量

`relay.compose.yml` 的 relay 服务需要新增一行（0.7.9 之前的 compose 没有）：

```yaml
    environment:
      BRIDGE_ALLOWED_ORIGINS: ${BRIDGE_ALLOWED_ORIGINS}
      BRIDGE_RELAY_MAX_FRAMES_PER_MINUTE: ${BRIDGE_RELAY_MAX_FRAMES_PER_MINUTE:-6000}
```

```bash
cd /opt/bridge-relay
python3 - <<'PY'
path = "relay.compose.yml"
src = open(path).read()
if "BRIDGE_RELAY_MAX_FRAMES_PER_MINUTE" not in src:
    src = src.replace(
        "      BRIDGE_ALLOWED_ORIGINS: ${BRIDGE_ALLOWED_ORIGINS}",
        "      BRIDGE_ALLOWED_ORIGINS: ${BRIDGE_ALLOWED_ORIGINS}\n"
        "      BRIDGE_RELAY_MAX_FRAMES_PER_MINUTE: ${BRIDGE_RELAY_MAX_FRAMES_PER_MINUTE:-6000}",
    )
    open(path, "w").write(src)
    print("added")
PY
grep -n "BRIDGE_" relay.compose.yml
```

## 7. 重建并启动

```bash
cd /opt/bridge-relay
docker compose -f relay.compose.yml up -d --build
# 等健康检查通过（start_period 10s + interval 30s）
for i in $(seq 1 12); do
  st=$(docker inspect bridge-relay --format "{{.State.Health.Status}}" 2>/dev/null)
  echo "wait $i: $st"; [ "$st" = "healthy" ] && break; sleep 5
done
docker logs bridge-relay --tail 20
```

容器 `healthy` 且日志出现 `Claude Bridge relay listening at ws://0.0.0.0:8788/ws`
即成功。**不要**用宿主机 `curl 127.0.0.1:8788` 验证（expose 模式下连不通）。

## 8. 验证（从本地 Mac 执行）

```bash
# 8.1 健康 / 就绪 / 协议契约
curl -fsS https://relay.alioxis.com/health
curl -fsS https://relay.alioxis.com/ready
cd <repo> && npm run probe:relay

# 8.2 原生来源必须全部放行，远程恶意来源必须 403
node -e '
const { WebSocket } = require("ws");
const cases = ["https://relay.alioxis.com","capacitor://localhost","bridge://localhost",
  "http://localhost","https://localhost","ionic://localhost","null","file://","https://evil.example"];
let done = 0;
for (const origin of cases) {
  const ws = new WebSocket("wss://relay.alioxis.com/ws", { headers: { Origin: origin } });
  const t = setTimeout(() => { ws.terminate(); console.log(origin.padEnd(28), "TIMEOUT"); fin(); }, 8000);
  const fin = () => { clearTimeout(t); if (++done === cases.length) process.exit(0); };
  ws.on("open", () => { console.log(origin.padEnd(28), "OPEN (allowed)"); ws.close(); fin(); });
  ws.on("unexpected-response", (_r, res) => { console.log(origin.padEnd(28), res.statusCode); fin(); });
  ws.on("error", () => {});
}
'

# 8.3 帧预算：700 帧突发不应被 RATE_LIMITED 掐断
node -e '
const { WebSocket } = require("ws");
const { randomBytes } = require("crypto");
const rid = (n) => randomBytes(n).toString("base64url");
const ws = new WebSocket("wss://relay.alioxis.com/ws");
const errors = [];
ws.on("open", () => ws.send(JSON.stringify({ type: "hello", version: 3, roomId: rid(18),
  role: "desktop", deviceId: rid(12), authToken: rid(32), create: true })));
ws.on("message", (d) => {
  const f = JSON.parse(d.toString());
  if (f.type === "ready") {
    for (let i = 0; i < 700; i++) ws.send(JSON.stringify({ type: "ping", at: Date.now() }));
    setTimeout(() => { console.log("errors:", errors.length ? errors.join(",") : "none",
      errors.length ? "FAIL" : "PASS"); ws.close(); process.exit(0); }, 1500);
  }
  if (f.type === "error") errors.push(f.code);
});
ws.on("close", (c) => { if (!errors.length) { console.log("unexpected close", c); process.exit(1); } });
setTimeout(() => process.exit(1), 15000);
'
```

预期：8.2 原生来源全部 `OPEN`、`https://evil.example` 为 `403`；8.3 输出 `PASS`。

## 9. 回滚

```bash
cd /opt/bridge-relay
git -C source checkout v0.7.8        # 或任意旧 tag
docker compose -f relay.compose.yml up -d --build
# 旧配置也都有 .bak 备份，必要时一并还原
```

## 10. 常见排查

| 现象 | 检查 |
|---|---|
| 容器一直 `health: starting` | `docker logs bridge-relay --tail 50`，多半是 SQLite/数据卷权限 |
| 公网 `/ws` 403 | 确认 `.env` 的 `BRIDGE_ALLOWED_ORIGINS` 含原生来源；确认容器 env 已生效（`docker inspect bridge-relay --format "{{range .Config.Env}}{{println .}}{{end}}"`） |
| 手机配对仍失败 | 先跑 8.2 Origin 探测；再确认手机端/桌面端都是 0.7.9（配对 instanceId 修复在客户端） |
| 宿主连不上 8788 | 正常，relay 走 `expose`，公网经 nginx 代理 |
