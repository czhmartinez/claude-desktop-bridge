import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Arch, Platform, build } from "electron-builder";
import { createWindowsInstallerConfig } from "./windows-installer-config.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(root, "../..");
const outputDirectory = resolve(root, "out/make/nsis.windows/x64");
const buildResourcesDirectory = resolve(root, "assets");

const [desktopPackage, electronPackage] = await Promise.all([
  readFile(resolve(root, "package.json"), "utf8").then(JSON.parse),
  readFile(resolve(repositoryRoot, "node_modules/electron/package.json"), "utf8").then(JSON.parse),
]);

const stageDirectory = await mkdtemp(join(tmpdir(), "bridge-windows-installer-"));
await rm(outputDirectory, { recursive: true, force: true });
await Promise.all([
  cp(resolve(root, "dist"), resolve(stageDirectory, "dist"), { recursive: true }),
  writeFile(
    resolve(stageDirectory, "package.json"),
    `${JSON.stringify({
      name: "bridge",
      productName: "Bridge",
      description: desktopPackage.description,
      author: desktopPackage.author,
      version: desktopPackage.version,
      main: "dist/main.cjs",
    }, null, 2)}\n`,
    "utf8",
  ),
]);

const config = createWindowsInstallerConfig({
  buildResourcesDirectory,
  electronVersion: electronPackage.version,
  outputDirectory,
  version: desktopPackage.version,
});

try {
  await build({
    projectDir: stageDirectory,
    targets: Platform.WINDOWS.createTarget("nsis", Arch.x64),
    config,
  });
} finally {
  await rm(stageDirectory, { recursive: true, force: true });
}
