import { Capacitor } from "@capacitor/core";
import { Directory, Filesystem } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import type {
  BridgeArtifactManifest,
  BridgeArtifactTransferChunk,
  BridgeArtifactTransferInfo,
  BridgeRequest,
  BridgeResponse,
} from "@bridge/protocol";

type RequestArtifact = (
  method: BridgeRequest["method"],
  params: Record<string, unknown>,
  options?: { wait?: boolean; timeoutMs?: number },
) => Promise<BridgeResponse | undefined>;

function unwrap<T>(response: BridgeResponse | undefined): T {
  if (!response?.ok) throw new Error(response?.error?.message ?? "成果传输失败");
  return response.result as T;
}

function base64Bytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function safeFilename(value: string): string {
  const normalized = value.replace(/[\\/:*?"<>|\u0000-\u001f]/gu, "_").trim();
  return normalized.slice(0, 160) || "Bridge-artifact";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readChunkWithResume(
  request: RequestArtifact,
  transfer: BridgeArtifactTransferInfo,
  index: number,
): Promise<BridgeArtifactTransferChunk> {
  let waitMs = 500;
  while (Date.now() < transfer.expiresAt) {
    try {
      const response = unwrap<{ chunk: BridgeArtifactTransferChunk }>(await request(
        "artifact.transfer.read",
        { transferId: transfer.transferId, index },
        { wait: true, timeoutMs: 60_000 },
      ));
      return response.chunk;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/expired|index|校验|不存在/iu.test(message)) throw error;
      await delay(waitMs);
      waitMs = Math.min(5_000, waitMs * 2);
    }
  }
  throw new Error("成果传输租约已过期");
}

async function sha256Hex(chunks: Uint8Array[]): Promise<string> {
  const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function downloadBridgeArtifact(
  artifact: BridgeArtifactManifest,
  request: RequestArtifact,
  onProgress: (progress: number) => void,
): Promise<void> {
  const opened = unwrap<{ transfer: BridgeArtifactTransferInfo }>(await request(
    "artifact.transfer.open",
    { artifactId: artifact.id },
    { wait: true, timeoutMs: 60_000 },
  ));
  const transfer = opened.transfer;
  const chunks: Uint8Array[] = [];
  const native = Capacitor.isNativePlatform();
  const filename = safeFilename(transfer.name);
  const nativePath = `bridge-evidence/${transfer.transferId}-${filename}`;
  let nativeFileCreated = false;
  try {
    for (let index = 0; index < transfer.totalChunks; index += 1) {
      const chunk = await readChunkWithResume(request, transfer, index);
      if (chunk.transferId !== transfer.transferId || chunk.index !== index) {
        throw new Error("成果分块顺序校验失败");
      }
      const bytes = base64Bytes(chunk.data);
      chunks.push(bytes);
      if (native) {
        if (index === 0) {
          await Filesystem.writeFile({
            path: nativePath,
            directory: Directory.Cache,
            data: chunk.data,
            recursive: true,
          });
          nativeFileCreated = true;
        } else {
          await Filesystem.appendFile({
            path: nativePath,
            directory: Directory.Cache,
            data: chunk.data,
          });
        }
      }
      onProgress((index + 1) / transfer.totalChunks);
    }
    if (await sha256Hex(chunks) !== transfer.sha256) throw new Error("成果完整性校验失败");
    if (native) {
      const file = await Filesystem.getUri({ path: nativePath, directory: Directory.Cache });
      await Share.share({
        title: transfer.name,
        dialogTitle: "保存或打开成果",
        files: [file.uri],
      });
      return;
    }
    const blob = new Blob(
      chunks.map((chunk) => Uint8Array.from(chunk).buffer),
      { type: transfer.mimeType },
    );
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  } finally {
    await request(
      "artifact.transfer.close",
      { transferId: transfer.transferId },
      { wait: true, timeoutMs: 20_000 },
    ).catch(() => undefined);
    if (nativeFileCreated) {
      await Filesystem.deleteFile({
        path: nativePath,
        directory: Directory.Cache,
      }).catch(() => undefined);
    }
  }
}
