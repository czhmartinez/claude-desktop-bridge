#!/usr/bin/env node

const args = process.argv.slice(2);

if (args.includes("--version")) {
  process.stdout.write("2.1.217-bridge-e2e\n");
  process.exit(0);
}

if (args[0] === "auth" && args[1] === "status") {
  process.stdout.write('{"loggedIn":true}\n');
  process.exit(0);
}

const promptIndex = args.indexOf("-p");
const prompt = promptIndex >= 0 ? args[promptIndex + 1] : "";
const resumeIndex = args.indexOf("--resume");
const resumedSession = resumeIndex >= 0 ? args[resumeIndex + 1] : undefined;
const sessionId = args.includes("--fork-session")
  ? "bridge-e2e-forked-session"
  : resumedSession ?? "bridge-e2e-session";

process.stdout.write(`${JSON.stringify({
  result: `E2E 后台已处理：${prompt}`,
  session_id: sessionId,
  is_error: false,
})}\n`);
