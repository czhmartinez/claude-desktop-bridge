# Bridge Relay 部署留档

当前生产拓扑（2026-08-16 定稿）：

| 域名 | 定位 | 链路 | 后端 |
| --- | --- | --- | --- |
| `relay.alioxis.com` | 国内 relay | DNSPod 直连 → 腾讯云 CVM nginx → 容器 | `bridge-relay`（compose 起） |
| `relay.alioxis.uk` | 海外 relay | Cloudflare 边缘 → tunnel → 容器 | `bridge-relay`（DMIT 洛杉矶 VPS） |

两个 relay 是独立的房间命名空间；客户端端点表按优先级（国内 .com=10、
局域网=20、海外 .uk=30）自动漂移，无需干预。

## 国内 relay（腾讯云 CVM）

仓库 compose 直起：`deploy/relay.compose.yml`（relay + web/nginx，挂在
`suntong_default` 外部网络）。日常升级：替换源码后 `docker compose -f
deploy/relay.compose.yml up -d --build relay`。

## 海外 relay（DMIT LA / relay.alioxis.uk）

入站只走 Cloudflare 隧道 + SSH，主机不暴露任何 relay 端口。全部组件
docker 常驻（`restart: unless-stopped`）。

### 首次部署（Debian 13 实测）

```bash
# 1) Docker（Debian 13 的 CLI 在独立包）
apt-get update && apt-get install -y docker.io docker-cli
systemctl enable --now docker

# 2) 源码（在工作站打包，避免在 VPS 上配 GitHub 凭证）
#    tar --exclude=node_modules --exclude=dist -czf bridge-relay-src.tar.gz \
#      package.json package-lock.json tsconfig.base.json packages/protocol apps/relay deploy/relay.Dockerfile
#    scp 到 VPS 后：
mkdir -p /opt/bridge-relay && tar -xzf bridge-relay-src.tar.gz -C /opt/bridge-relay
cd /opt/bridge-relay/src && docker build -f deploy/relay.Dockerfile -t bridge-relay:<版本> .

# 3) relay 容器
docker network create bridge-net
docker volume create bridge-relay-data
docker run -d --name bridge-relay --restart unless-stopped --network bridge-net \
  -e BRIDGE_RELAY_HOST=0.0.0.0 -e BRIDGE_RELAY_PORT=8788 \
  -e BRIDGE_RELAY_DATA=/data/bridge-relay.db \
  -e BRIDGE_RELAY_BACKUP_DIR=/data/backups \
  -e BRIDGE_TRUST_PROXY=1 -e BRIDGE_RELAY_MAX_FRAMES_PER_MINUTE=6000 \
  -e BRIDGE_ALLOWED_ORIGINS="<见 relay.env.example>" \
  -v bridge-relay-data:/data bridge-relay:<版本>
docker exec bridge-relay node -e "fetch('http://127.0.0.1:8788/health').then(r=>r.text()).then(console.log)"

# 4) Cloudflare 隧道（CLI 本地管理隧道，凭证从 tunnel create 的机器复制）
#    /etc/cloudflared-uk/ 放 <uuid>.json + config.yml（样例见 relay.compose.yml 尾部注释）
docker run -d --name bridge-tunnel-uk --restart unless-stopped --network bridge-net \
  -v /etc/cloudflared-uk:/etc/cloudflared:ro \
  cloudflare/cloudflared:latest tunnel --no-autoupdate --config /etc/cloudflared/config.yml run

# 5) 验收
curl https://relay.alioxis.uk/health   # 期望 {"ok":true,"service":"claude-bridge-relay"}
```

### 升级

新源码 tarball → 重新 `docker build` → `docker rm -f bridge-relay` 后用同一
命令重跑（数据在 `bridge-relay-data` 卷里，升级不丢房间/队列）。

### 注意

- 同一 tunnel 不要在两台机器上同时跑连接器：Cloudflare 会把流量分给
  两个后端，房间命名空间分裂（2026-08-15 踩过：Mac 与 CVM 双连接器，
  已退役 Mac 侧 LaunchAgent 与 CVM 侧临时容器）。
- `/etc/cloudflared-uk/` 是隧道唯一凭证，别删、别进 git。
- 隧道是 CLI 本地管理模式；若改用 dashboard 远程管理隧道，换成
  `tunnel run --token <TOKEN>` 形态即可，不再需要 credentials-file。
