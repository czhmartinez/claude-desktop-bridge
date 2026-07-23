import { ChevronRight, Laptop, Moon, ScanLine, Sun, Trash2 } from "lucide-react";
import { useState } from "react";
import type { PairedHost } from "../hooks/useMobileBridge.js";
import type { Theme } from "../hooks/useTheme.js";
import { BrandMark } from "./BrandMark.js";
import { ConfirmationDialog } from "./ConfirmationDialog.js";
import { IconButton } from "./IconButton.js";

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
                  <small>{openingHostId === host.roomId ? "正在连接" : host.needsRepair ? "旧版配对，需要重新扫码" : "已配对，点击进入"}</small>
                </span>
                <span className={`host-row-state ${host.needsRepair ? "warning" : ""}`}><i />{host.needsRepair ? "需修复" : "待机"}</span>
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
        description={`将从手机移除“${removeCandidate?.desktopName ?? "这台电脑"}”的配对和本地消息记录，电脑端不会被卸载。`}
        confirmLabel="删除主机"
        danger
        busy={removing}
        onCancel={() => setRemoveCandidate(undefined)}
        onConfirm={() => void removeHost()}
      />
    </main>
  );
}
