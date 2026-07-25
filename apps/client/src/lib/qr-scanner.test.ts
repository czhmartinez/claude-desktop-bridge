import { describe, expect, it, vi } from "vitest";
import {
  QR_SCANNER_CAMERA_CONSTRAINTS,
  qrScannerLayout,
  tuneQrScannerCamera,
} from "./qr-scanner.js";

describe("QR scanner camera setup", () => {
  it("requests the rear camera at a high square resolution", () => {
    expect(QR_SCANNER_CAMERA_CONSTRAINTS).toMatchObject({
      facingMode: { ideal: "environment" },
      width: { ideal: 1920 },
      height: { ideal: 1920 },
      aspectRatio: { ideal: 1 },
    });
  });

  it("keeps the decoding surface at the native video aspect ratio", () => {
    expect(qrScannerLayout(360, 480)).toEqual({
      aspectRatio: "360 / 480",
      guideSize: 309,
    });
    expect(qrScannerLayout(0, 480)).toEqual({
      aspectRatio: "1 / 1",
      guideSize: 0,
    });
  });

  it("enables continuous focus and a conservative zoom when supported", async () => {
    const applyVideoConstraints = vi.fn().mockResolvedValue(undefined);
    await tuneQrScannerCamera({
      getRunningTrackCapabilities: () => ({
        focusMode: ["manual", "continuous"],
        zoom: { min: 1, max: 4 },
      }) as MediaTrackCapabilities,
      applyVideoConstraints,
    });

    expect(applyVideoConstraints).toHaveBeenCalledTimes(1);
    expect(applyVideoConstraints).toHaveBeenCalledWith({
      advanced: [{ focusMode: "continuous", zoom: 1.25 }],
    });
  });
});
