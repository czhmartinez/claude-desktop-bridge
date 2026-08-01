export function createWindowsInstallerConfig({
  buildResourcesDirectory,
  electronVersion,
  environment = process.env,
  outputDirectory,
  version,
}) {
  const certificateFile = environment.BRIDGE_WIN_CERTIFICATE_FILE?.trim();
  const signtoolOptions = certificateFile
    ? {
        certificateFile,
        ...(environment.BRIDGE_WIN_CERTIFICATE_PASSWORD !== undefined
          ? { certificatePassword: environment.BRIDGE_WIN_CERTIFICATE_PASSWORD }
          : {}),
      }
    : undefined;

  return {
    appId: "com.localbridge.desktop",
    productName: "Bridge",
    electronVersion,
    directories: {
      buildResources: buildResourcesDirectory,
      output: outputDirectory,
    },
    files: ["dist/**/*", "package.json"],
    asar: true,
    asarUnpack: ["**/*.node"],
    npmRebuild: false,
    nodeGypRebuild: false,
    win: {
      target: [{ target: "nsis", arch: ["x64"] }],
      executableName: "bridge",
      icon: "icon.ico",
      ...(signtoolOptions ? { signtoolOptions } : {}),
    },
    nsis: {
      oneClick: false,
      allowElevation: true,
      allowToChangeInstallationDirectory: true,
      perMachine: false,
      selectPerMachineByDefault: false,
      runAfterFinish: false,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      deleteAppDataOnUninstall: false,
      installerIcon: "icon.ico",
      uninstallerIcon: "icon.ico",
      installerLanguages: ["zh_CN", "en_US"],
      multiLanguageInstaller: true,
      shortcutName: "Bridge",
      uninstallDisplayName: "Bridge",
      artifactName: `Bridge-${version}-Setup.exe`,
    },
  };
}
