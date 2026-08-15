import { describe, expect, it } from "vitest";
import { splitFilePath } from "./FileChangesCard.js";

describe("splitFilePath", () => {
  it("splits absolute POSIX paths into elidable head, parent and basename", () => {
    expect(splitFilePath("/Users/me/Work/repo/apps/client/src/components/MobileWorkspace.tsx"))
      .toEqual({
        head: "/Users/me/Work/repo/apps/client/src",
        parent: "components",
        base: "MobileWorkspace.tsx",
      });
  });

  it("splits Windows paths", () => {
    expect(splitFilePath("C:\\Users\\me\\repo\\package.json"))
      .toEqual({ head: "C:\\Users\\me", parent: "repo", base: "package.json" });
  });

  it("keeps single-segment paths intact", () => {
    expect(splitFilePath("package.json")).toEqual({ head: "", parent: "", base: "package.json" });
    expect(splitFilePath("/package.json")).toEqual({ head: "", parent: "", base: "package.json" });
  });

  it("ignores trailing separators", () => {
    expect(splitFilePath("/Users/me/repo/")).toEqual({ head: "/Users", parent: "me", base: "repo" });
  });
});
