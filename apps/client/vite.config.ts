import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  base: "./",
  plugins: [react()],
  resolve: {
    alias: {
      "@bridge/protocol": resolve(root, "../../packages/protocol/src/index.ts"),
    },
  },
  server: { port: 5188, strictPort: true },
  preview: { port: 4188, strictPort: true },
  build: {
    target: "es2022",
    sourcemap: true,
    // Keep fonts as real files: inlined data: fonts violate the strict
    // font-src 'self' CSP in index.html and get blocked in packaged builds.
    assetsInlineLimit: (filePath) => (/\.woff2?$/i.test(filePath) ? false : undefined),
  },
});
