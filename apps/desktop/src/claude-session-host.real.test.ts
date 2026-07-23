import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { ClaudeSessionHost, type SessionHostEvent } from "./claude-session-host.js";
import { findClaudeTranscriptFile } from "./claude-history.js";
import { prepareClaudeRuntime } from "./claude-runtime-discovery.js";
import { PermissionBroker } from "./permission-broker.js";

const execFileAsync = promisify(execFile);
const runRealM0 = process.env.BRIDGE_M0_REAL === "1";

async function waitForCompletion(
  events: SessionHostEvent[],
  fromIndex: number,
  timeoutMs = 180_000,
): Promise<Extract<SessionHostEvent, { type: "turn.completed" }>> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const event = events.slice(fromIndex).find((candidate) => candidate.type === "turn.completed");
    if (event?.type === "turn.completed") return event;
    const failure = events.slice(fromIndex).find((candidate) => (
      candidate.type === "turn.failed" || candidate.type === "runtime.error"
    ));
    if (failure) throw new Error("error" in failure ? failure.error : "Claude session failed");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for the real Claude session");
}

async function waitForEvent<T extends SessionHostEvent["type"]>(
  events: SessionHostEvent[],
  fromIndex: number,
  type: T,
  timeoutMs = 60_000,
): Promise<Extract<SessionHostEvent, { type: T }>> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const event = events.slice(fromIndex).find((candidate) => candidate.type === type);
    if (event?.type === type) return event as Extract<SessionHostEvent, { type: T }>;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${type}`);
}

async function desktopState(): Promise<{ frontmost?: string; clipboard?: string }> {
  if (process.platform !== "darwin") return {};
  const [frontmost, clipboard] = await Promise.all([
    execFileAsync("/usr/bin/lsappinfo", ["front"]).then(
      ({ stdout }) => stdout.trim(),
      () => undefined,
    ),
    execFileAsync("/usr/bin/pbpaste", []).then(
      ({ stdout }) => createHash("sha256").update(stdout).digest("hex"),
      () => undefined,
    ),
  ]);
  return {
    ...(frontmost ? { frontmost } : {}),
    ...(clipboard ? { clipboard } : {}),
  };
}

describe.skipIf(!runRealM0)("ClaudeSessionHost real M0 gate", () => {
  it("keeps and resumes one transcript without touching foreground state", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "bridge-session-m0-"));
    const sessionId = randomUUID();
    const runtime = await prepareClaudeRuntime();
    expect(runtime.executablePath, "Claude executable was not found").toBeTruthy();
    expect(runtime.credentialPath, "Claude Desktop third-party credentials were not found").toBeTruthy();
    const before = await desktopState();
    const events: SessionHostEvent[] = [];
    const permissionBroker = new PermissionBroker();
    let permissionRequests = 0;
    permissionBroker.on("requested", (request) => {
      permissionRequests += 1;
      permissionBroker.resolveRequest(request.requestId, "allow-once");
    });
    const model = process.env.BRIDGE_M0_MODEL?.trim();
    const effort = process.env.BRIDGE_M0_EFFORT === "low" ||
      process.env.BRIDGE_M0_EFFORT === "medium" ||
      process.env.BRIDGE_M0_EFFORT === "high" ||
      process.env.BRIDGE_M0_EFFORT === "xhigh" ||
      process.env.BRIDGE_M0_EFFORT === "max"
      ? process.env.BRIDGE_M0_EFFORT
      : undefined;
    const firstHost = new ClaudeSessionHost({
      sessionId,
      cwd,
      executablePath: runtime.executablePath!,
      environment: runtime.environment,
      permissionBroker,
      resume: false,
      settingSources: [],
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
    });
    firstHost.onEvent((event) => events.push(event));

    firstHost.send("Reply with exactly BRIDGE_M0_ONE. Do not use tools or modify files.", "desktop");
    const first = await waitForCompletion(events, 0);
    expect(first.result).toContain("BRIDGE_M0_ONE");
    expect(events.some((event) => event.type === "assistant.delta")).toBe(true);
    const secondIndex = events.length;
    firstHost.send(
      "Use the Bash tool to run exactly: printf BRIDGE_M0_TOOL > m0-tool.txt. Then reply with exactly BRIDGE_M0_TWO.",
      "mobile",
    );
    const second = await waitForCompletion(events, secondIndex);
    expect(second.result).toContain("BRIDGE_M0_TWO");
    expect(permissionRequests).toBeGreaterThan(0);
    expect(events.slice(secondIndex).some((event) => event.type === "tool.started")).toBe(true);
    expect(await readFile(join(cwd, "m0-tool.txt"), "utf8")).toBe("BRIDGE_M0_TOOL");
    expect(firstHost.sessionId).toBe(sessionId);
    await firstHost.close();

    const resumedEvents: SessionHostEvent[] = [];
    const resumedHost = new ClaudeSessionHost({
      sessionId,
      cwd,
      executablePath: runtime.executablePath!,
      environment: runtime.environment,
      permissionBroker,
      resume: true,
      settingSources: [],
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
    });
    resumedHost.onEvent((event) => resumedEvents.push(event));
    resumedHost.send("Reply with exactly BRIDGE_M0_RESUMED. Do not use tools.", "mobile");
    const resumed = await waitForCompletion(resumedEvents, 0);
    expect(resumed.result).toContain("BRIDGE_M0_RESUMED");
    expect(resumedHost.sessionId).toBe(sessionId);
    const interruptIndex = resumedEvents.length;
    resumedHost.send(
      "Use the Bash tool to run exactly: sleep 30. After it finishes, reply BRIDGE_M0_SHOULD_NOT_FINISH.",
      "mobile",
    );
    await waitForEvent(resumedEvents, interruptIndex, "tool.started");
    await resumedHost.interrupt();
    await waitForEvent(resumedEvents, interruptIndex, "turn.interrupted");
    await resumedHost.close();

    const transcript = await findClaudeTranscriptFile(
      join(homedir(), ".claude", "projects"),
      sessionId,
      cwd,
    );
    expect(transcript, "Claude did not persist the expected transcript").toBeTruthy();
    const raw = await readFile(transcript!, "utf8");
    expect(raw).toContain("BRIDGE_M0_ONE");
    expect(raw).toContain("BRIDGE_M0_TWO");
    expect(raw).toContain("BRIDGE_M0_RESUMED");
    expect(await desktopState()).toEqual(before);

    await rm(cwd, { recursive: true, force: true });
  }, 420_000);
});
