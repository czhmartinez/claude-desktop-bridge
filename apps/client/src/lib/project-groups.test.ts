import { describe, expect, it } from "vitest";
import {
  collapseProjects,
  expandAllProjects,
  expandProject,
  toggleCollapsedProject,
} from "./project-groups.js";

describe("project group collapse state", () => {
  it("collapses and expands projects independently", () => {
    const first = toggleCollapsedProject(new Set<string>(), "project-a");
    const second = toggleCollapsedProject(first, "project-b");

    expect([...second]).toEqual(["project-a", "project-b"]);
    expect([...toggleCollapsedProject(second, "project-a")]).toEqual(["project-b"]);
  });

  it("expands a newly selected project without changing other groups", () => {
    const collapsed = new Set(["project-a", "project-b"]);

    expect([...expandProject(collapsed, "project-a")]).toEqual(["project-b"]);
    expect(expandProject(collapsed, "project-c")).toBe(collapsed);
  });

  it("collapses and expands every visible project in one action", () => {
    expect([...collapseProjects(["project-a", "project-b"])]).toEqual(["project-a", "project-b"]);
    expect(expandAllProjects()).toEqual(new Set());
  });
});
