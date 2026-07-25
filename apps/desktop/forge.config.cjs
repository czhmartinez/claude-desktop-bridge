const { execFileSync, spawnSync } = require("node:child_process");
const path = require("node:path");

const platformIcon = process.platform === "darwin"
  ? path.join(__dirname, "assets", "icon.icns")
  : process.platform === "win32"
    ? path.join(__dirname, "assets", "icon.ico")
    : path.join(__dirname, "assets", "icon.png");
const macSignIdentity = process.env.BRIDGE_MAC_SIGN_IDENTITY?.trim();
const macSignKeychain = process.env.BRIDGE_MAC_SIGN_KEYCHAIN?.trim();
const macSignTimestamp = process.env.BRIDGE_MAC_SIGN_TIMESTAMP?.trim();
const macLocalSigning = process.env.BRIDGE_MAC_LOCAL_SIGNING === "1";
const allowAdHocMacSigning = process.env.BRIDGE_ALLOW_ADHOC_SIGNING === "1";

module.exports = {
  packagerConfig: {
    asar: {
      unpack: "**/*.node",
    },
    prune: false,
    name: "Bridge",
    executableName: "bridge",
    appBundleId: "com.localbridge.desktop",
    appCategoryType: "public.app-category.productivity",
    icon: platformIcon,
    usageDescription: {
      DocumentsFolder: "Bridge only accesses Documents when you send a task to a project stored there.",
      DesktopFolder: "Bridge only accesses Desktop when you send a task to a project stored there.",
      DownloadsFolder: "Bridge only accesses Downloads when you send a task to a project stored there.",
      NetworkVolumes: "Bridge only accesses a network volume when you send a task to a project stored there.",
      RemovableVolumes: "Bridge only accesses a removable volume when you send a task to a project stored there.",
    },
    ...(macSignIdentity && !macLocalSigning
      ? {
          osxSign: {
            identity: macSignIdentity,
            // osx-sign 1.3.3 omits the code-signing policy when validating a
            // custom keychain, so verify it in the wrapper and let codesign use
            // the exact identity hash here.
            identityValidation: false,
            hardenedRuntime: true,
            continueOnError: false,
            ...(macSignKeychain ? { keychain: macSignKeychain } : {}),
            ...(macSignTimestamp ? { timestamp: macSignTimestamp } : {}),
          },
        }
      : {}),
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
      for (const outputPath of result.outputPaths) {
        const appPath = path.join(outputPath, "Bridge.app");
        if (macLocalSigning) {
          if (!macSignIdentity || !macSignKeychain) {
            throw new Error(
              "Local macOS signing requires BRIDGE_MAC_SIGN_IDENTITY and BRIDGE_MAC_SIGN_KEYCHAIN.",
            );
          }
          execFileSync("codesign", [
            "--force",
            "--deep",
            "--timestamp=none",
            "--sign",
            macSignIdentity,
            "--keychain",
            macSignKeychain,
            appPath,
          ], { stdio: "inherit" });
        } else if (!macSignIdentity) {
          if (!allowAdHocMacSigning) {
            throw new Error(
              "Refusing an update with an ad-hoc macOS signature. Set BRIDGE_MAC_SIGN_IDENTITY "
              + "to a stable code-signing identity. For a disposable local build only, set "
              + "BRIDGE_ALLOW_ADHOC_SIGNING=1.",
            );
          }
          process.stderr.write(
            "WARNING: ad-hoc Bridge build; macOS Files & Folders consent will not survive updates.\n",
          );
          execFileSync("codesign", [
            "--force",
            "--deep",
            "--sign",
            "-",
            appPath,
          ], { stdio: "inherit" });
        }
        execFileSync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath], {
          stdio: "inherit",
        });
        const requirementResult = spawnSync("codesign", ["--display", "--requirements", "-", appPath], {
          encoding: "utf8",
        });
        if (requirementResult.status !== 0) {
          throw new Error(requirementResult.stderr || "Unable to read Bridge code requirement.");
        }
        const requirement = `${requirementResult.stdout}${requirementResult.stderr}`;
        if (!allowAdHocMacSigning && requirement.includes("cdhash")) {
          throw new Error(
            "Bridge has a version-specific cdhash designated requirement; macOS privacy consent "
            + "would be requested again after the next update.",
          );
        }
        if (macSignIdentity && !macLocalSigning) {
          const signatureResult = spawnSync("codesign", ["--display", "--verbose=4", appPath], {
            encoding: "utf8",
          });
          if (signatureResult.status !== 0) {
            throw new Error(signatureResult.stderr || "Unable to inspect the Bridge signature.");
          }
          const signature = `${signatureResult.stdout}${signatureResult.stderr}`;
          if (
            !/^Authority=Developer ID Application:/mu.test(signature)
            || !/^TeamIdentifier=[A-Z0-9]{10}$/mu.test(signature)
          ) {
            throw new Error(
              "Formal macOS packages require a Developer ID Application identity with a valid "
              + "TeamIdentifier. Use make:local-signed for this Mac only.",
            );
          }
        }
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
