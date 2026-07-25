import type { Html5Qrcode } from "html5-qrcode";

export const QR_SCANNER_FPS = 12;
export const QR_SCANNER_CAMERA_CONSTRAINTS: MediaTrackConstraints = {
  facingMode: { ideal: "environment" },
  width: { ideal: 1920 },
  height: { ideal: 1920 },
  aspectRatio: { ideal: 1 },
};

interface ExtendedTrackCapabilities extends MediaTrackCapabilities {
  focusMode?: string[];
  zoom?: { min: number; max: number };
}

interface ExtendedTrackConstraintSet extends MediaTrackConstraintSet {
  focusMode?: string;
  zoom?: number;
}

type QrScannerCamera = Pick<
  Html5Qrcode,
  "applyVideoConstraints" | "getRunningTrackCapabilities"
>;

export function qrScannerLayout(width: number, height: number): {
  aspectRatio: string;
  guideSize: number;
} {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { aspectRatio: "1 / 1", guideSize: 0 };
  }
  return {
    aspectRatio: `${width} / ${height}`,
    guideSize: Math.floor(Math.min(width, height) * 0.86),
  };
}

export async function tuneQrScannerCamera(scanner: QrScannerCamera): Promise<void> {
  let capabilities: ExtendedTrackCapabilities;
  try {
    capabilities = scanner.getRunningTrackCapabilities() as ExtendedTrackCapabilities;
  } catch {
    return;
  }

  const cameraTuning: ExtendedTrackConstraintSet = {};
  if (capabilities.focusMode?.includes("continuous")) {
    cameraTuning.focusMode = "continuous";
  }
  const zoom = capabilities.zoom;
  if (
    zoom &&
    Number.isFinite(zoom.min) &&
    Number.isFinite(zoom.max) &&
    zoom.max > zoom.min
  ) {
    cameraTuning.zoom = Math.min(zoom.max, Math.max(zoom.min, 1.25));
  }
  if (Object.keys(cameraTuning).length > 0) {
    await scanner.applyVideoConstraints({ advanced: [cameraTuning] }).catch(() => undefined);
  }
}
