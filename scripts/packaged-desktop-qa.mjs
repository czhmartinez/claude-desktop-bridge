import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

const endpoint = process.env.BRIDGE_DESKTOP_CDP ?? "http://127.0.0.1:9223";
const artifacts = resolve("artifacts", "packaged-desktop");
const desktopPackage = JSON.parse(await readFile(resolve("apps", "desktop", "package.json"), "utf8"));
await mkdir(artifacts, { recursive: true });

const browser = await chromium.connectOverCDP(endpoint);
try {
  let page;
  const startedAt = Date.now();
  while (!page && Date.now() - startedAt < 5_000) {
    page = browser.contexts()
      .flatMap((context) => context.pages())
      .find((candidate) => candidate.url().startsWith("file:"));
    if (!page) await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  assert.ok(page, "Packaged Bridge renderer was not found");
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(() => Boolean(window.bridgeDesktop));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean(window.bridgeDesktop));
  await page.getByRole("button", { name: "会话", exact: true }).waitFor();
  await page.waitForFunction(async () => (
    (await window.bridgeDesktop.getSnapshot()).connection === "connected"
  ));
  const snapshot = await page.evaluate(() => window.bridgeDesktop.getSnapshot());
  assert.equal(snapshot.host.version, desktopPackage.version);
  assert.ok(Array.isArray(snapshot.projects));
  assert.ok(Array.isArray(snapshot.sessions));
  assert.ok(Array.isArray(snapshot.devices));
  assert.equal(snapshot.connection, "connected");
  assert.ok(["ready", "working", "auth-required", "unavailable"].includes(snapshot.runtime.state));
  assert.deepEqual(errors, []);
  await page.screenshot({ path: resolve(artifacts, "desktop.png"), fullPage: true });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    url: page.url(),
    version: snapshot.host.version,
    projects: snapshot.projects.length,
    sessions: snapshot.sessions.length,
    devices: snapshot.devices.length,
    runtime: snapshot.runtime.state,
    screenshot: resolve(artifacts, "desktop.png"),
  }, null, 2)}\n`);
} finally {
  await browser.close();
}
