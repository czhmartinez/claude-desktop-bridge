import { describe, expect, it } from "vitest";
import { formatElapsed, sessionActivity } from "./session-activity.js";

describe("sessionActivity", () => {
  it("disappears when the session is idle or waiting", () => {
    expect(sessionActivity({ turnState: "idle" }, [])).toBeUndefined();
    expect(sessionActivity({ turnState: "waiting" }, [])).toBeUndefined();
    expect(sessionActivity(undefined, [])).toBeUndefined();
  });

  it("reports queued sessions without a timer", () => {
    expect(sessionActivity({ turnState: "queued" }, [])).toEqual({ kind: "queued", label: "排队等待中" });
  });

  it("names the in-flight tool while one is running", () => {
    const activity = sessionActivity({ turnState: "running" }, [
      { role: "user", createdAt: 100 },
      { role: "tool", toolName: "Command", state: "running", createdAt: 200 },
    ]);
    expect(activity).toEqual({ kind: "running", label: "正在运行 · Command", since: 100 });
  });

  it("falls back to 思考中 once the last tool settled and nothing streams", () => {
    const activity = sessionActivity({ turnState: "running" }, [
      { role: "user", createdAt: 100 },
      { role: "tool", toolName: "Command", state: "completed", createdAt: 200 },
    ]);
    expect(activity?.kind).toBe("thinking");
  });

  it("reports 正在生成回复 while assistant text is the latest activity", () => {
    const activity = sessionActivity({ turnState: "running" }, [
      { role: "user", createdAt: 100 },
      { role: "assistant", createdAt: 300 },
    ]);
    expect(activity).toEqual({ kind: "generating", label: "正在生成回复", since: 100 });
  });

  it("times the current work from the latest user message, including steers", () => {
    const activity = sessionActivity({ turnState: "running" }, [
      { role: "user", createdAt: 100 },
      { role: "assistant", createdAt: 200 },
      { role: "user", createdAt: 400 },
    ]);
    expect(activity?.since).toBe(400);
  });
});

describe("formatElapsed", () => {
  it("formats seconds, minutes and hours", () => {
    expect(formatElapsed(0)).toBe("0 秒");
    expect(formatElapsed(59)).toBe("59 秒");
    expect(formatElapsed(60)).toBe("1 分钟");
    expect(formatElapsed(75)).toBe("1 分 15 秒");
    expect(formatElapsed(3600)).toBe("1 小时 0 分");
    expect(formatElapsed(3725)).toBe("1 小时 2 分");
  });
});
