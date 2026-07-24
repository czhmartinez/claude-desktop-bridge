import { createRequire } from "node:module";

const nativeRequire = createRequire(import.meta.url);
let cleanup: (() => void) | undefined;

export function loadDesktopPeerConnection(): typeof RTCPeerConnection {
  const polyfill = nativeRequire("node-datachannel/polyfill") as {
    RTCPeerConnection: typeof RTCPeerConnection;
  };
  const runtime = nativeRequire("node-datachannel") as {
    preload?: () => void;
    cleanup?: () => void;
  };
  runtime.preload?.();
  cleanup = runtime.cleanup;
  return polyfill.RTCPeerConnection;
}

export function cleanupDesktopPeerConnection(): void {
  cleanup?.();
  cleanup = undefined;
}
