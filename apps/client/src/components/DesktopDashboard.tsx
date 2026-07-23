import {
  AlertTriangle,
  Check,
  CheckCircle2,
  CircleHelp,
  Copy,
  GitBranch,
  Laptop,
  LoaderCircle,
  Moon,
  Power,
  QrCode,
  RefreshCw,
  Send,
  ShieldCheck,
  Smartphone,
  Sun,
  Unplug,
  WandSparkles,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useState } from "react";
import type { Theme } from "../hooks/useTheme.js";
import type { ClaudeBridgeActivity, DesktopSnapshot } from "../runtime/desktop.js";
import { BrandMark } from "./BrandMark.js";
import { ConfirmationDialog } from "./ConfirmationDialog.js";
import { IconButton } from "./IconButton.js";

function ConnectionDot({ online }: { online: boolean }) {
  return <span className={`status-dot ${online ? "online" : ""}`} aria-hidden="true" />;
}

function relayEndpoint(value: string): string {
  try {
    const url = new URL(value);
    return `${url.hostname}${url.port ? `:${url.port}` : ""}`;
  } catch {
    return value;
  }
}

function formatLastSeen(value: number | undefined, online: boolean): string {
  if (online) return "当前在线";
  if (!value) return "尚未建立连接";
  const elapsed = Math.max(0, Date.now() - value);
  if (elapsed < 60_000) return "刚刚在线";
  if (elapsed < 60 * 60_000) return `${Math.floor(elapsed / 60_000)} 分钟前在线`;
  if (elapsed < 24 * 60 * 60_000) return `${Math.floor(elapsed / (60 * 60_000))} 小时前在线`;
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(value);
}

function activityStateLabel(state: ClaudeBridgeActivity["state"]): string {
  if (state === "queued") return "排队中";
  if (state === "working") return "处理中";
  if (state === "completed") return "已完成";
  return "等待重试";
}

export function DesktopDashboard({ theme, onToggleTheme }: { theme: Theme; onToggleTheme(): void }) {
  const api = window.bridgeDesktop;
  const [snapshot, setSnapshot] = useState<DesktopSnapshot>();
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [testSent, setTestSent] = useState(false);
  const [pairingVisible, setPairingVisible] = useState(false);
  const [replaceConfirmOpen, setReplaceConfirmOpen] = useState(false);
  const [regenerating, setRegenerating] = useState(false);

  useEffect(() => {
    if (!api) return;
    void api.getSnapshot().then(setSnapshot);
    const stopSnapshots = api.onSnapshot(setSnapshot);
    return stopSnapshots;
  }, [api]);

  if (!api || !snapshot) return <div className="desktop-loading"><BrandMark /><span>正在准备</span></div>;

  async function copyPairing(): Promise<void> {
    await navigator.clipboard.writeText(snapshot!.pairingUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1_500);
  }

  async function installConnector(): Promise<void> {
    setBusy(true);
    try { setSnapshot(await api!.installClaudeConnector()); }
    finally { setBusy(false); }
  }

  async function sendTest(): Promise<void> {
    setTestSent(false);
    await api!.sendTestUpdate();
    setTestSent(true);
    setTimeout(() => setTestSent(false), 1_800);
  }

  async function regeneratePairing(): Promise<void> {
    setRegenerating(true);
    try {
      setSnapshot(await api!.regeneratePairing());
      setPairingVisible(true);
      setReplaceConfirmOpen(false);
    } finally {
      setRegenerating(false);
    }
  }

  const connected = snapshot.connection === "connected";
  const paired = snapshot.mobilePaired || snapshot.mobileOnline;
  const primarySession = snapshot.claudeSessions[0];
  const sessionRunning = primarySession?.state === "running";
  const transportReady = snapshot.claudeTransport.state === "ready"
    || snapshot.claudeTransport.state === "working";
  const transportWorking = snapshot.claudeTransport.state === "working";
  const transportNeedsAttention = snapshot.connector === "installed" && !transportReady;
  const activities = snapshot.claudeActivities ?? [];
  const latestActivity = activities[0];
  const claudeDetail = primarySession
    ? [
        primarySession.projectName,
        primarySession.totalTasks > 0 ? `${primarySession.completedTasks}/${primarySession.totalTasks}` : "会话已识别",
        sessionRunning ? "桌面已打开" : "历史可续写",
        primarySession.currentTask,
        snapshot.pendingCommands > 0 ? `${snapshot.pendingCommands} 条手机指令待送达` : undefined,
      ].filter(Boolean).join(" · ")
    : snapshot.connector === "installed" ? "连接器已安装，等待 Claude 会话" : "尚未接入";

  return (
    <main className="desktop-shell">
      <aside className="desktop-rail">
        <BrandMark compact />
        <nav aria-label="主导航">
          <button className="rail-button active" type="button" title="设备" aria-label="设备"><Laptop size={19} /></button>
          <button className="rail-button" type="button" title="帮助" aria-label="帮助"><CircleHelp size={19} /></button>
        </nav>
        <IconButton label={theme === "dark" ? "切换浅色" : "切换深色"} onClick={onToggleTheme}>
          {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
        </IconButton>
      </aside>

      <section className="desktop-main">
        <header className="desktop-heading">
          <div>
            <div className="eyebrow">设备状态</div>
            <h1>{snapshot.desktopName}</h1>
          </div>
          <div className={`connection-badge ${connected ? "connected" : ""}`}>
            <Power size={15} /><span>{connected ? "Bridge 已在线" : "正在重新连接"}</span>
          </div>
        </header>

        <div className="desktop-grid">
          <section className="surface device-surface" aria-labelledby="devices-title">
            <div className="section-heading">
              <div><span className="section-kicker">运行概览</span><h2 id="devices-title">连接链路</h2></div>
            </div>
            <div className="device-row">
              <span className="device-icon"><Laptop size={20} /></span>
              <div><strong>{snapshot.desktopName}</strong><span>中继 {relayEndpoint(snapshot.relayUrl)}</span></div>
              <span className="state-label"><ConnectionDot online={connected} />{connected ? "在线" : "连接中"}</span>
            </div>
            <div className="device-row">
              <span className="device-icon mobile"><Smartphone size={20} /></span>
              <div><strong>手机 Bridge</strong><span>{formatLastSeen(snapshot.mobileLastSeenAt, snapshot.mobileOnline)}</span></div>
              <span className="state-label"><ConnectionDot online={snapshot.mobileOnline} />{snapshot.mobileOnline ? "在线" : paired ? "已配对" : "未配对"}</span>
            </div>
            <div className="device-row">
              <span className="device-icon agent"><WandSparkles size={20} /></span>
              <div><strong>Claude Desktop</strong><span title={claudeDetail}>{claudeDetail}</span></div>
              <span className="state-label"><ConnectionDot online={snapshot.agentOnline} />{primarySession ? sessionRunning ? "已打开" : "已识别" : "待命"}</span>
            </div>

            <div className="diagnostic-list" aria-label="链路详情">
              <div><span>Claude 会话</span><strong>{snapshot.claudeSessions.length} 个</strong></div>
              <div><span>待送指令</span><strong>{snapshot.pendingCommands} 条</strong></div>
              <div><span>手机加密</span><strong>{paired ? "已建立" : "等待配对"}</strong></div>
            </div>
          </section>

          <section className="surface phone-surface" aria-labelledby="phone-title">
            <div className="section-heading">
              <div><span className="section-kicker">手机设备</span><h2 id="phone-title">{paired ? "已配对手机" : "连接手机"}</h2></div>
              <span className={`connector-state ${snapshot.mobileOnline ? "ready" : paired ? "paired" : ""}`}>
                <ConnectionDot online={snapshot.mobileOnline} />{snapshot.mobileOnline ? "在线" : paired ? "待机" : "未配对"}
              </span>
            </div>

            <div className="phone-summary">
              <span className="phone-summary-icon"><Smartphone size={25} /></span>
              <div>
                <strong>{snapshot.mobileOnline ? "手机已连接" : paired ? "等待手机上线" : "扫码即可连接"}</strong>
                <span>{formatLastSeen(snapshot.mobileLastSeenAt, snapshot.mobileOnline)}</span>
              </div>
            </div>

            {pairingVisible ? (
              <div className="pairing-details">
                <div className="qr-wrap"><QRCodeSVG value={snapshot.pairingUrl} size={174} level="M" marginSize={2} title="手机配对二维码" /></div>
                <p>{paired ? "再次扫码会修复这台手机的连接信息。" : "使用手机 Bridge 扫描，不需要手动配置。"}</p>
                <div className="pairing-actions">
                  <button type="button" className="secondary-button" onClick={() => void copyPairing()}>
                    {copied ? <Check size={16} /> : <Copy size={16} />}<span>{copied ? "已复制" : "复制链接"}</span>
                  </button>
                  <IconButton label="生成全新配对" onClick={() => setReplaceConfirmOpen(true)}><RefreshCw size={17} /></IconButton>
                </div>
              </div>
            ) : (
              <div className="phone-actions">
                {snapshot.mobileOnline && (
                  <button type="button" className="secondary-button" onClick={() => void sendTest()}>
                    {testSent ? <Check size={16} /> : <Send size={16} />}<span>{testSent ? "已发送" : "发送测试消息"}</span>
                  </button>
                )}
                <button type="button" className={paired ? "secondary-button" : "primary-button"} onClick={() => setPairingVisible(true)}>
                  <QrCode size={17} /><span>{paired ? "显示修复二维码" : "显示配对二维码"}</span>
                </button>
              </div>
            )}
          </section>

          <section className="surface connector-surface" aria-labelledby="connector-title">
            <div className="section-heading">
              <div><span className="section-kicker">电脑助手</span><h2 id="connector-title">Claude 接入</h2></div>
              <span className={`connector-state ${transportNeedsAttention ? "warning" : snapshot.connector === "installed" ? "ready" : ""}`}>
                {transportReady
                  ? <ShieldCheck size={14} />
                  : snapshot.connector === "installed" ? <Unplug size={14} /> : <Unplug size={14} />}
                {transportWorking
                  ? "处理中"
                  : transportReady
                    ? "续写就绪"
                    : snapshot.claudeTransport.state === "auth-required"
                      ? "第三方通道未就绪"
                      : snapshot.connector === "installed" ? "等待通道" : "未接入"}
              </span>
            </div>
            <div className="connector-copy">
              <div className="connector-mark"><WandSparkles size={25} /></div>
              <strong>{transportWorking
                ? "手机指令正在独立续写"
                : transportReady
                  ? "后台续写已就绪"
                  : snapshot.claudeTransport.state === "auth-required"
                    ? "等待 Claude Desktop 第三方通道"
                    : snapshot.connector === "installed" ? "正在启动后台续写通道" : "让 Claude 历史与手机互通"}</strong>
              <span>{snapshot.connector === "installed"
                ? snapshot.claudeTransport.detail
                : "一次接入，之后由 Bridge 独立续写并同步结果，不控制 Claude Desktop 前台窗口。"}</span>
            </div>
            {snapshot.connector !== "installed" && (
              <button type="button" className="primary-button full-button" onClick={() => void installConnector()} disabled={busy}>
                <WandSparkles size={17} /><span>{busy ? "正在接入" : "一键接入"}</span>
              </button>
            )}
          </section>

          <section className="surface activity-surface" aria-labelledby="activity-title">
            <div className="section-heading">
              <div><span className="section-kicker">Bridge 后台</span><h2 id="activity-title">手机指令与回复</h2></div>
              <span className={`connector-state ${latestActivity?.state === "completed" ? "ready" : latestActivity ? "warning" : ""}`}>
                <GitBranch size={14} />
                {latestActivity ? activityStateLabel(latestActivity.state) : "暂无记录"}
              </span>
            </div>
            {activities.length === 0 ? (
              <div className="activity-empty">
                <GitBranch size={22} aria-hidden="true" />
                <div><strong>等待第一条手机指令</strong><span>Bridge 的后台续写和真实回复会显示在这里。</span></div>
              </div>
            ) : (
              <div className="activity-list">
                {activities.slice(0, 5).map((activity) => (
                  <article className={`activity-row ${activity.state}`} key={activity.id}>
                    <span className="activity-icon" aria-hidden="true">
                      {activity.state === "completed"
                        ? <CheckCircle2 size={17} />
                        : activity.state === "retrying"
                          ? <AlertTriangle size={17} />
                          : <LoaderCircle className={activity.state === "working" ? "is-spinning" : ""} size={17} />}
                    </span>
                    <div className="activity-copy">
                      <div className="activity-meta">
                        <strong>{activity.projectName} · {activity.sessionTitle}</strong>
                        <time>{new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(activity.updatedAt)}</time>
                      </div>
                      <p className="activity-command">{activity.command}</p>
                      <p className="activity-summary">{activity.summary
                        ?? (activity.state === "working" ? "Claude 正在独立后台处理，完成后会自动同步回复。" : "等待后台通道接收。")}</p>
                    </div>
                    <span className="activity-state">{activityStateLabel(activity.state)}</span>
                  </article>
                ))}
              </div>
            )}
          </section>
        </div>

        <footer className="desktop-footer">
          <label className="toggle-row">
            <span><strong>开机自动运行</strong><small>无需每次手动打开</small></span>
            <input type="checkbox" checked={snapshot.launchAtLogin} onChange={(event) => void api.setLaunchAtLogin(event.target.checked).then(setSnapshot)} />
            <i aria-hidden="true" />
          </label>
          <span>Bridge {snapshot.version}</span>
        </footer>
      </section>

      <ConfirmationDialog
        open={replaceConfirmOpen}
        title="生成全新配对？"
        description="这会让旧手机上的当前配对失效。仅在二维码泄露或需要彻底更换手机时使用；普通断线请直接再次扫描现有二维码。"
        confirmLabel="生成新配对"
        danger
        busy={regenerating}
        onCancel={() => setReplaceConfirmOpen(false)}
        onConfirm={() => void regeneratePairing()}
      />
    </main>
  );
}
