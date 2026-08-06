import { decodePairingBundle, pairingBundleFromUrl, type PairingBundle } from "@bridge/protocol";
import { ArrowLeft, ArrowRight, Clipboard, Link2, ScanLine } from "lucide-react";
import { useEffect, useState } from "react";
import { BrandMark } from "./BrandMark.js";
import { IconButton } from "./IconButton.js";
import { WebQrScannerDialog } from "./WebQrScannerDialog.js";

function readPairing(value: string): PairingBundle | undefined {
  const trimmed = value.trim();
  const fromUrl = pairingBundleFromUrl(trimmed);
  if (fromUrl) return fromUrl;
  try {
    return decodePairingBundle(trimmed);
  } catch {
    return undefined;
  }
}

export function PairingScreen({
  loading,
  error,
  onPair,
  onCancel,
}: {
  loading: boolean;
  error?: string | undefined;
  onPair(pairing: PairingBundle): Promise<void>;
  onCancel?: (() => void) | undefined;
}) {
  const [value, setValue] = useState("");
  const [localError, setLocalError] = useState<string>();
  const [scanning, setScanning] = useState(false);
  const [webScannerOpen, setWebScannerOpen] = useState(false);

  useEffect(() => {
    const pairing = pairingBundleFromUrl(window.location.href);
    if (!pairing) return;
    history.replaceState(null, "", `${location.pathname}${location.search}`);
    void onPair(pairing);
  }, [onPair]);

  async function submit(): Promise<void> {
    const pairing = readPairing(value);
    if (!pairing) {
      setLocalError("没有识别到有效的配对链接");
      return;
    }
    setLocalError(undefined);
    await onPair(pairing);
  }

  async function paste(): Promise<void> {
    try {
      const text = await navigator.clipboard.readText();
      setValue(text);
      const pairing = readPairing(text);
      if (pairing) await onPair(pairing);
      else setLocalError("剪贴板里没有配对链接");
    } catch {
      setLocalError("请长按输入框粘贴配对链接");
    }
  }

  function scan(): void {
    setLocalError(undefined);
    setScanning(true);
    setWebScannerOpen(true);
  }

  function acceptWebScan(value: string): void {
    setWebScannerOpen(false);
    setScanning(false);
    const pairing = readPairing(value);
    if (!pairing) {
      setLocalError("这不是 Bridge 配对二维码");
      return;
    }
    void onPair(pairing);
  }

  return (
    <main className="pairing-shell">
      <header className="pairing-header pairing-nav">
        {onCancel && <IconButton label="返回主机列表" onClick={onCancel}><ArrowLeft size={19} /></IconButton>}
        <BrandMark />
      </header>
      <section className="pairing-panel" aria-labelledby="pair-title">
        <div className="pairing-visual" aria-hidden="true">
          <span className="device device-phone" />
          <span className="connection-line"><span /></span>
          <span className="device device-computer" />
        </div>
        <div className="eyebrow">连接自己的电脑</div>
        <h1 id="pair-title">扫描电脑上的二维码</h1>
        <p>打开相机对准电脑屏幕，或粘贴电脑端复制的配对链接。</p>
        <button type="button" className="primary-button full-button" onClick={scan} disabled={loading || scanning}>
          <ScanLine size={18} /><span>{scanning ? "正在扫描" : "扫描二维码"}</span>
        </button>
        <div className="pairing-divider"><span>或者粘贴电脑端复制的链接</span></div>
        <div className="pairing-input-wrap">
          <Link2 size={18} aria-hidden="true" />
          <input
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="粘贴电脑端复制的配对链接"
            aria-label="配对链接"
            autoCapitalize="none"
            autoCorrect="off"
          />
          <button type="button" className="paste-button" onClick={() => void paste()} aria-label="从剪贴板粘贴" title="粘贴">
            <Clipboard size={18} />
          </button>
        </div>
        {(localError ?? error) && <div className="inline-error" role="alert">{localError ?? error}</div>}
        <button type="button" className="secondary-button full-button" onClick={() => void submit()} disabled={!value.trim() || loading || scanning}>
          <span>{loading ? "正在连接" : "连接电脑"}</span><ArrowRight size={18} />
        </button>
      </section>
      <footer className="pairing-footer">配对后，只有这台手机能读到消息内容</footer>
      {webScannerOpen && (
        <WebQrScannerDialog
          onResult={acceptWebScan}
          onCancel={() => {
            setWebScannerOpen(false);
            setScanning(false);
          }}
          onError={() => {
            setWebScannerOpen(false);
            setScanning(false);
            setLocalError("无法使用相机，请在电脑端复制配对链接");
          }}
        />
      )}
    </main>
  );
}
