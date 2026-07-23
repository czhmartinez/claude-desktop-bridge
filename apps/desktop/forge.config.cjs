const { execFileSync } = require("node:child_process");
const path = require("node:path");

const platformIcon = process.platform === "darwin"
  ? path.join(__dirname, "assets", "icon.icns")
  : process.platform === "win32"
    ? path.join(__dirname, "assets", "icon.ico")
    : path.join(__dirname, "assets", "icon.png");

module.exports = {
  packagerConfig: {
    asar: true,
    prune: false,
    name: "Bridge",
    executableName: "bridge",
    appBundleId: "com.localbridge.desktop",
    appCategoryType: "public.app-category.productivity",
    icon: platformIcon,
    ignore: [
      /^\/node_modules($|\/)/,
      /^\/src($|\/)/,
      /^\/scripts($|\/)/,
      /^\/native($|\/)/,
      /^\/out($|\/)/,
      /^\/coverage($|\/)/,
      /^\/tsconfig\.json$/,
      /^\/forge\.config\.cjs$/,
    ],
  },
  rebuildConfig: {},
  hooks: {
    postPackage: async (_forgeConfig, result) => {
      if (result.platform !== "darwin") return;
      const identity = process.env.BRIDGE_MAC_SIGN_IDENTITY || "-";
      for (const outputPath of result.outputPaths) {
        execFileSync("codesign", [
          "--force",
          "--deep",
          "--sign",
          identity,
          path.join(outputPath, "Bridge.app"),
        ], { stdio: "inherit" });
      }
    },
  },
  makers: [
    {
      name: "@electron-forge/maker-squirrel",
      platforms: ["win32"],
      config: { name: "bridge", setupIcon: path.join(__dirname, "assets", "icon.ico") },
    },
    { name: "@electron-forge/maker-zip", platforms: ["darwin", "linux"] },
    { name: "@electron-forge/maker-dmg", platforms: ["darwin"], config: { name: "Bridge" } },
    { name: "@electron-forge/maker-deb", platforms: ["linux"], config: {} },
    { name: "@electron-forge/maker-rpm", platforms: ["linux"], config: {} },
  ],
};
