import { randomUUID } from "node:crypto";
import { BrowserWindow, nativeImage } from "electron";
import type { EvidencePreviewRenderer } from "./evidence-manager.js";

const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_EDGE = 2_048;
const ARTIFACT_SCHEME = "bridge-artifact";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ElectronEvidencePreviewRenderer implements EvidencePreviewRenderer {
  async image(bytes: Buffer, mimeType: string): Promise<{ bytes: Buffer; mimeType: string }> {
    const image = nativeImage.createFromBuffer(bytes);
    if (image.isEmpty()) throw new Error("Image preview could not be decoded");
    const size = image.getSize();
    if (bytes.byteLength <= MAX_PREVIEW_BYTES && Math.max(size.width, size.height) <= MAX_IMAGE_EDGE) {
      return { bytes, mimeType };
    }
    let scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(size.width, size.height));
    let output = bytes;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const width = Math.max(1, Math.round(size.width * scale));
      const height = Math.max(1, Math.round(size.height * scale));
      output = image.resize({ width, height, quality: "better" }).toJPEG(84);
      if (output.byteLength <= MAX_PREVIEW_BYTES) break;
      scale *= 0.75;
    }
    return { bytes: output, mimeType: "image/jpeg" };
  }

  async html(bytes: Buffer): Promise<{ bytes: Buffer; mimeType: string }> {
    if (bytes.byteLength > MAX_PREVIEW_BYTES) {
      throw new Error("HTML is too large for the static preview");
    }
    const window = new BrowserWindow({
      width: 1_440,
      height: 900,
      useContentSize: true,
      frame: false,
      show: false,
      backgroundColor: "#ffffff",
      webPreferences: {
        sandbox: true,
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: true,
        partition: `bridge-artifact-${randomUUID()}`,
      },
    });
    const previewSession = window.webContents.session;
    const previewUrl = `${ARTIFACT_SCHEME}://preview/index.html`;
    previewSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    previewSession.setPermissionCheckHandler(() => false);
    previewSession.on("will-download", (event) => event.preventDefault());
    previewSession.webRequest.onBeforeRequest((details, callback) => {
      const allowed = details.url === previewUrl || details.url.startsWith("data:");
      callback({ cancel: !allowed });
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.webContents.setAudioMuted(true);
    try {
      await previewSession.protocol.handle(ARTIFACT_SCHEME, (request) => {
        if (request.url !== previewUrl) return new Response("Not found", { status: 404 });
        return new Response(new Uint8Array(bytes), {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Content-Security-Policy": [
              "default-src 'none'",
              "script-src 'unsafe-inline'",
              "style-src 'unsafe-inline'",
              `img-src data: ${ARTIFACT_SCHEME}:`,
              "font-src data:",
              "media-src data:",
              "connect-src 'none'",
              "frame-src 'none'",
              "object-src 'none'",
              "base-uri 'none'",
              "form-action 'none'",
            ].join("; "),
          },
        });
      });
      const loaded = window.loadURL(previewUrl);
      await Promise.race([
        loaded,
        new Promise<never>((_resolve, reject) => (
          setTimeout(() => reject(new Error("HTML static preview timed out")), 5_000)
        )),
      ]);
      await delay(300);
      const captured = await window.webContents.capturePage();
      const image = captured.resize({ width: 1_440, height: 900, quality: "better" });
      let output = image.toJPEG(86);
      for (const quality of [72, 58, 44, 30]) {
        if (output.byteLength <= MAX_PREVIEW_BYTES) break;
        output = image.toJPEG(quality);
      }
      if (output.byteLength > MAX_PREVIEW_BYTES) {
        throw new Error("HTML screenshot exceeds the preview limit");
      }
      return { bytes: output, mimeType: "image/jpeg" };
    } finally {
      try {
        previewSession.protocol.unhandle(ARTIFACT_SCHEME);
      } catch {
        // The temporary session may already be gone after a renderer timeout.
      }
      if (!window.isDestroyed()) window.destroy();
    }
  }
}
