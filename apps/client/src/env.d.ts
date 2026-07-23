/// <reference types="vite/client" />

import type { DesktopApi } from "./runtime/desktop.js";

declare global {
  interface Window {
    bridgeDesktop?: DesktopApi;
  }
}

export {};
