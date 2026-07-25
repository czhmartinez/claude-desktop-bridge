import { Camera, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Html5Qrcode } from "html5-qrcode";
import {
  QR_SCANNER_CAMERA_CONSTRAINTS,
  QR_SCANNER_FPS,
  qrScannerLayout,
  tuneQrScannerCamera,
} from "../lib/qr-scanner.js";

const READER_ID = "bridge-qr-reader";

async function stopScanner(scanner: Html5Qrcode): Promise<void> {
  try {
    if (scanner.isScanning) await scanner.stop();
  } catch {
    // The browser may have already ended the media track while the dialog closes.
  }
  try {
    scanner.clear();
  } catch {
    // The reader can already be detached during navigation or permission failure.
  }
}

export function WebQrScannerDialog({
  onResult,
  onCancel,
  onError,
}: {
  onResult(value: string): void;
  onCancel(): void;
  onError(): void;
}) {
  const scannerRef = useRef<Html5Qrcode | undefined>(undefined);
  const readerRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let active = true;
    let handled = false;

    void (async () => {
      try {
        const { Html5Qrcode, Html5QrcodeSupportedFormats } = await import("html5-qrcode");
        if (!active) return;
        const scanner = new Html5Qrcode(READER_ID, {
          formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE],
          useBarCodeDetectorIfSupported: true,
          verbose: false,
        });
        scannerRef.current = scanner;
        await scanner.start(
          { facingMode: "environment" },
          {
            fps: QR_SCANNER_FPS,
            videoConstraints: QR_SCANNER_CAMERA_CONSTRAINTS,
          },
          (value) => {
            if (!active || handled) return;
            handled = true;
            active = false;
            void stopScanner(scanner).finally(() => onResult(value));
          },
          () => undefined,
        );
        if (!active) {
          await stopScanner(scanner);
          return;
        }
        const video = readerRef.current?.querySelector("video");
        if (video && stageRef.current) {
          const layout = qrScannerLayout(video.clientWidth, video.clientHeight);
          stageRef.current.style.aspectRatio = layout.aspectRatio;
          if (layout.guideSize > 0) {
            stageRef.current.style.setProperty("--qr-guide-size", `${layout.guideSize}px`);
          }
        }
        await tuneQrScannerCamera(scanner);
        setReady(true);
      } catch {
        if (active) onError();
      }
    })();

    return () => {
      active = false;
      const scanner = scannerRef.current;
      if (scanner) void stopScanner(scanner);
    };
  }, [onError, onResult]);

  return (
    <section className="qr-scanner-screen" role="dialog" aria-modal="true" aria-labelledby="qr-scanner-title">
      <div className="qr-scanner-toolbar">
        <div>
          <span className="qr-scanner-kicker"><Camera size={14} /> 安全配对</span>
          <h2 id="qr-scanner-title">扫描电脑二维码</h2>
        </div>
        <button type="button" className="qr-scanner-close" onClick={onCancel} aria-label="取消扫描" title="取消">
          <X size={22} />
        </button>
      </div>
      <div className="qr-scanner-stage" ref={stageRef}>
        <div id={READER_ID} className="qr-scanner-reader" ref={readerRef} />
        <span className="qr-scanner-guide" aria-hidden="true" />
      </div>
      <p className="qr-scanner-status" aria-live="polite">
        {ready ? "将电脑上的配对二维码放入框内" : "正在打开相机"}
      </p>
    </section>
  );
}
