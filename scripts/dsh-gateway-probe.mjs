/**
 * Live contract probe for the DSH Desktop runtime adapter.
 *
 * Read-only by default: discovers the running DSH host (pgrep + lsof +
 * host.describe), checks the unary envelope, and opens both downlink
 * WebSockets. `--exercise` additionally creates a throwaway session in
 * os.tmpdir() and sends one minimal prompt, asserting the turn lifecycle
 * frames (turn/start → assistant/chunk → assistant/message → turn/end).
 *
 * Usage: node scripts/dsh-gateway-probe.mjs [--exercise]
 * Override discovery with BRIDGE_DSH_GATEWAY_URL=http://127.0.0.1:<port>.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const exercise = process.argv.includes("--exercise");
const timeoutMs = Number(process.env.BRIDGE_DSH_PROBE_TIMEOUT_MS ?? 10_000);

async function run(command, args) {
  try {
    const { stdout } = await execFileAsync(command, args, { timeout: 5_000 });
    return stdout;
  } catch {
    return "";
  }
}

async function discover() {
  if (process.env.BRIDGE_DSH_GATEWAY_URL) return process.env.BRIDGE_DSH_GATEWAY_URL;
  const pidsOut = await run("pgrep", ["-f", "DSH Desktop.app/Contents/MacOS/DSH Desktop|dsh-desktop|dsh web"]);
  const pids = pidsOut.split("\n").map((line) => line.trim()).filter(Boolean);
  assert.ok(pids.length > 0, "no DSH Desktop process found (start DSH Desktop first)");
  const lsofOut = await run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", pids.join(",")]);
  const ports = new Set();
  for (const line of lsofOut.split("\n")) {
    const match = /TCP (?:127\.0\.0\.1|localhost|\[::1\]|\*):(\d+) \(LISTEN\)/u.exec(line);
    if (match) ports.add(Number.parseInt(match[1], 10));
  }
  for (const port of ports) {
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      await rpc(baseUrl, "host.describe", {});
      return baseUrl;
    } catch {
      // not the DSH web server; keep scanning
    }
  }
  throw new Error("no listening port answered the DSH host.describe contract");
}

async function rpc(baseUrl, method, payload) {
  const response = await fetch(`${baseUrl}/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "client-request", rpcId: crypto.randomUUID(), method, payload }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  assert.equal(response.status, 200, `${method} HTTP ${response.status}`);
  const body = await response.json();
  assert.equal(body.type, "server-response", `${method} envelope type`);
  if (body.result?.ok !== true) {
    throw new Error(`${method} failed: ${body.result?.error?.code ?? "unknown"} ${body.result?.error?.message ?? ""}`);
  }
  return body.result.value;
}

function openStream(baseUrl, path, onFrame) {
  const url = `ws://${new URL(baseUrl).host}${path}`;
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timeout = setTimeout(() => reject(new Error(`${path} open timed out`)), timeoutMs);
    socket.addEventListener("open", () => {
      clearTimeout(timeout);
      resolve(socket);
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error(`${path} open failed`));
    }, { once: true });
    socket.addEventListener("message", (event) => {
      try {
        onFrame(JSON.parse(String(event.data)));
      } catch {
        // malformed frames are skipped by contract; never fatal to the pump
      }
    });
  });
}

const baseUrl = await discover();
console.log(`gateway: ${baseUrl}`);

const description = await rpc(baseUrl, "host.describe", {});
assert.equal(typeof description.cwd, "string");
assert.equal(typeof description.attachedSessions, "number");
console.log(`host.describe: provider=${description.provider} model=${description.model} sessions=${description.attachedSessions}`);

const listed = await rpc(baseUrl, "session.list", {});
assert.ok(Array.isArray(listed.items), "session.list items");
console.log(`session.list: ${listed.items.length} session(s)`);

const frames = [];
const mux = await openStream(baseUrl, "/api/events.mux", (frame) => frames.push(frame));
const host = await openStream(baseUrl, "/api/events.host", (frame) => frames.push(frame));
console.log("downlink streams: events.mux + events.host open");

if (exercise) {
  const created = await rpc(baseUrl, "session.create", { cwd: join(tmpdir(), "bridge-dsh-probe") });
  const sessionId = created.sessionId;
  assert.ok(typeof sessionId === "string" && sessionId.length > 0);
  console.log(`session.create: ${sessionId}`);

  await rpc(baseUrl, "session.prompt", {
    sessionId,
    mode: "queue",
    content: [{ type: "text", text: "只回复两个字：完成。不要调用任何工具。" }],
  });
  console.log("session.prompt accepted; waiting for the turn lifecycle…");

  const deadline = Date.now() + 120_000;
  let sawTurnStart = false;
  let sawAssistantMessage = false;
  let sawTurnEnd = false;
  while (Date.now() < deadline && !sawTurnEnd) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    for (const frame of frames) {
      if (frame.payload?.sessionId !== sessionId) continue;
      const type = frame.payload?.event?.type ?? frame.payload?.type;
      if (type === "turn/start") sawTurnStart = true;
      if (type === "assistant/message") sawAssistantMessage = true;
      if (type === "turn/end") sawTurnEnd = true;
    }
  }
  assert.ok(sawTurnStart, "turn/start frame");
  assert.ok(sawAssistantMessage, "assistant/message frame");
  assert.ok(sawTurnEnd, "turn/end frame");
  console.log("turn lifecycle: turn/start → assistant/message → turn/end ✓");

  const history = await rpc(baseUrl, "session.history", { sessionId, maxMessages: 10 });
  assert.ok(Array.isArray(history.events) && history.events.length > 0, "session.history events");
  console.log(`session.history: ${history.events.length} event(s)`);
}

mux.close();
host.close();
console.log("dsh gateway probe passed");
