import { describe, expect, it } from "vitest";
import { createWindowsInstallerConfig } from "./windows-installer-config.mjs";

describe("Windows installer configuration", () => {
  it("builds an assisted NSIS installer with a directory selection page", () => {
    const config = createWindowsInstallerConfig({
      buildResourcesDirectory: "C:\\bridge\\assets",
      electronVersion: "43.1.1",
      outputDirectory: "C:\\bridge\\out",
      version: "0.5.3",
    });

    expect(config.win.target).toEqual([{ target: "nsis", arch: ["x64"] }]);
    expect(config.nsis).toMatchObject({
      oneClick: false,
      allowToChangeInstallationDirectory: true,
      perMachine: false,
      runAfterFinish: false,
    });
    expect(config.nsis.artifactName).toBe("Bridge-0.5.3-Setup.exe");
  });

  it("keeps optional certificate settings out of unsigned builds", () => {
    const config = createWindowsInstallerConfig({
      buildResourcesDirectory: "C:\\bridge\\assets",
      electronVersion: "43.1.1",
      environment: {},
      outputDirectory: "C:\\bridge\\out",
      version: "0.5.3",
    });

    expect(config.win.signtoolOptions).toBeUndefined();
  });

  it("passes an explicitly configured certificate to electron-builder", () => {
    const config = createWindowsInstallerConfig({
      buildResourcesDirectory: "C:\\bridge\\assets",
      electronVersion: "43.1.1",
      environment: {
        BRIDGE_WIN_CERTIFICATE_FILE: " C:\\certs\\bridge.pfx ",
        BRIDGE_WIN_CERTIFICATE_PASSWORD: "secret",
      },
      outputDirectory: "C:\\bridge\\out",
      version: "0.5.3",
    });

    expect(config.win.signtoolOptions).toEqual({
      certificateFile: "C:\\certs\\bridge.pfx",
      certificatePassword: "secret",
    });
  });
});
