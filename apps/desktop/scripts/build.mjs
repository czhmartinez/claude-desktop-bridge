import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "dist");
const mainOnly = process.argv.includes("--main-only");
const alias = { "@bridge/protocol": resolve(root, "../../packages/protocol/src/index.ts") };
const sharedDefine = {
  __BRIDGE_DEFAULT_RELAY__: JSON.stringify(process.env.BRIDGE_RELAY_URL ?? "ws://127.0.0.1:8788/ws"),
  __BRIDGE_DEFAULT_PAIRING_BASE__: JSON.stringify(process.env.BRIDGE_PAIRING_BASE_URL ?? "http://localhost:5188"),
};
const mainDefine = {
  ...sharedDefine,
  "import.meta.url": "__bridgeImportMetaUrl",
};
const mainBanner = {
  js: "const __bridgeImportMetaUrl = require('node:url').pathToFileURL(__filename).href;",
};

// Never let native helpers from an older build leak into a new package.
await rm(resolve(dist, "native"), { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await Promise.all([
  build({
    entryPoints: [resolve(root, "src/main.ts")],
    outfile: resolve(dist, "main.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["electron"],
    sourcemap: true,
    alias,
    define: mainDefine,
    banner: mainBanner,
  }),
  build({
    entryPoints: [resolve(root, "src/preload.ts")],
    outfile: resolve(dist, "preload.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["electron"],
    sourcemap: true,
    alias,
    define: sharedDefine,
  }),
  build({
    entryPoints: [resolve(root, "src/claude-desktop-helper.ts")],
    outfile: resolve(dist, "claude-desktop-helper.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    sourcemap: true,
    alias,
    define: sharedDefine,
  }),
]);

if (!mainOnly) {
  const renderer = resolve(dist, "renderer");
  await rm(renderer, { recursive: true, force: true });
  await cp(resolve(root, "../client/dist"), renderer, { recursive: true });

  const rendererIndex = await readFile(resolve(renderer, "index.html"), "utf8");
  if (/(?:src|href)=["']\/(?!\/)/.test(rendererIndex)) {
    throw new Error("Desktop renderer contains root-relative assets that cannot load from file://");
  }
}
