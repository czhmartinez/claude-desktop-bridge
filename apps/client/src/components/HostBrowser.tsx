import { ChevronRight, Laptop, Moon, ScanLine, Sun, Trash2 } from "lucide-react";
import { useState } from "react";
import type { PairedHost } from "../hooks/useMobileBridge.js";
import type { Theme } from "../hooks/useTheme.js";
import { BrandMark } from "./BrandMark.js";
import { ConfirmationDialog } from "./ConfirmationDialog.js";
import { IconButton } from "./IconButton.js";

function statusLabel(host: PairedHost): string {
  if (host.needsRepair) return "需修复";
  if (host.status === "running") return `${host.activeTurns} 个任务运行中`;
  if (host.status === "attention") return "需要处理";
  if (host.status === "offline") return "离线";
  return "待机";
}

function lastSeenLabel(host: PairedHost): string {
  if (host.needsRepair) return "旧版配对，需要重新扫码";
  if (!host.lastSeenAt) return "已配对";
  const elapsed = Math.max(0, Date.now() - host.lastSeenAt);
  if (elapsed < 60_000) return "刚刚在线";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前在线`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前在线`;
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(host.lastSeenAt);
}

export function HostBrowser({
  hosts,
  error,
  theme,
  onToggleTheme,
  onSelect,
  onRemove,
  onAdd,
}: {
  hosts: PairedHost[];
  error?: string | undefined;
  theme: Theme;
  onToggleTheme(): void;
  onSelect(roomId: string): Promise<void>;
  onRemove(roomId: string): Promise<void>;
  onAdd(): void;
}) {
  const [openingHostId, setOpeningHostId] = useState<string>();
  const [removeCandidate, setRemoveCandidate] = useState<PairedHost>();
  const [removing, setRemoving] = useState(false);

  async function openHost(roomId: string): Promise<void> {
    if (openingHostId) return;
    setOpeningHostId(roomId);
    try {
      await onSelect(roomId);
    } finally {
      setOpeningHostId(undefined);
    }
  }

  async function removeHost(): Promise<void> {
    if (!removeCandidate || removing) return;
    setRemoving(true);
    try {
      await onRemove(removeCandidate.roomId);
      setRemoveCandidate(undefined);
    } finally {
      setRemoving(false);
    }
  }

  return (
    <main className="mobile-workspace host-list-workspace">
      <header className="mobile-topbar">
        <BrandMark compact />
        <div className="mobile-device">
          <strong>我的电脑</strong>
          <span>{hosts.length} 台主机已配对</span>
        </div>
        <IconButton label={theme === "dark" ? "切换浅色" : "切换深色"} onClick={onToggleTheme}>
          {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
        </IconButton>
      </header>

      <section className="host-browser" aria-label="已配对的电脑">
        <div className="host-browser-heading">
          <div><span>Bridge</span><h1>主机</h1></div>
          <b>{hosts.length}</b>
        </div>
        <div className="host-rows">
          {hosts.map((host) => (
            <div className="host-row-shell" key={host.roomId}>
              <button
                type="button"
                className="host-row"
                onClick={() => void openHost(host.roomId)}
                disabled={Boolean(openingHostId) || removing}
              >
                <span className="host-row-icon"><Laptop size={19} /></span>
                <span className="host-row-copy">
                  <strong>{host.desktopName}</strong>
                  <small>{openingHostId === host.roomId ? "正在连接" : lastSeenLabel(host)}</small>
                </span>
                <span className={`host-row-state ${host.needsRepair || host.status === "attention" ? "warning" : host.status}`}>
                  <i />{statusLabel(host)}
                </span>
                <ChevronRight size={19} aria-hidden="true" />
              </button>
              <IconButton
                className="host-remove-button"
                label={`删除 ${host.desktopName}`}
                onClick={() => setRemoveCandidate(host)}
                disabled={Boolean(openingHostId) || removing}
              >
                <Trash2 size={17} />
              </IconButton>
            </div>
          ))}
        </div>
        {error && <div className="inline-error host-error" role="alert">{error}</div>}
        <button type="button" className="secondary-button add-host-button" onClick={onAdd}>
          <ScanLine size={18} /><span>添加电脑</span>
        </button>
      </section>
      <ConfirmationDialog
        open={Boolean(removeCandidate)}
        title="删除这台电脑？"
        description={`将清除“${removeCandidate?.desktopName ?? "这台电脑"}”在手机上的密钥和消息；电脑在线时也会同步撤销这台手机的权限。`}
        confirmLabel="删除主机"
        danger
        busy={removing}
        onCancel={() => setRemoveCandidate(undefined)}
        onConfirm={() => void removeHost()}
      />
    </main>
  );
}
