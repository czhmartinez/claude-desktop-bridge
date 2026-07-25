import { describe, expect, it } from "vitest";
import {
  dispatchMobileBack,
  isEdgeBackGesture,
  registerMobileBackHandler,
} from "./mobile-back-navigation.js";

describe("mobile back navigation", () => {
  it("offers back navigation to the highest layer before the app root", () => {
    const calls: string[] = [];
    const removeRoot = registerMobileBackHandler(() => {
      calls.push("root");
      return true;
    }, -100);
    const removeWorkspace = registerMobileBackHandler(() => {
      calls.push("workspace");
      return false;
    }, 100);

    expect(dispatchMobileBack()).toBe(true);
    expect(calls).toEqual(["workspace", "root"]);

    removeWorkspace();
    removeRoot();
  });

  it("stops after the topmost layer handles the gesture", () => {
    const calls: string[] = [];
    const removeRoot = registerMobileBackHandler(() => {
      calls.push("root");
      return true;
    }, -100);
    const removeDialog = registerMobileBackHandler(() => {
      calls.push("dialog");
      return true;
    }, 100);

    expect(dispatchMobileBack()).toBe(true);
    expect(calls).toEqual(["dialog"]);

    removeDialog();
    removeRoot();
  });

  it("recognizes only a quick horizontal swipe beginning at the left edge", () => {
    const start = { x: 10, y: 120, at: 1_000 };

    expect(isEdgeBackGesture(start, { x: 100, y: 126, at: 1_400 })).toBe(true);
    expect(isEdgeBackGesture({ ...start, x: 40 }, { x: 130, y: 126, at: 1_400 })).toBe(false);
    expect(isEdgeBackGesture(start, { x: 90, y: 220, at: 1_400 })).toBe(false);
    expect(isEdgeBackGesture(start, { x: 100, y: 126, at: 2_000 })).toBe(false);
  });
});
