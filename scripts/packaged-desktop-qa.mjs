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
  await page.waitForFunction(async () => (
    (await window.bridgeDesktop.getSnapshot()).connection === "connected"
  ));
  await page.getByRole("button", { name: "会话", exact: true }).waitFor();
  await page.waitForFunction(async () => (
    (await window.bridgeDesktop.getSnapshot()).connection === "connected"
  ));
  const snapshot = await page.evaluate(() => window.bridgeDesktop.getSnapshot());
  assert.equal(snapshot.host.version, desktopPackage.version);
  assert.ok(Number.isInteger(snapshot.host.pairingEpoch) && snapshot.host.pairingEpoch >= 1);
  assert.deepEqual(
    [...snapshot.host.capabilities].sort(),
    [
      "artifact.preview.v1",
      "artifact.transfer.v1",
      "conversation.handoff.v1",
      "conversation.lanes.v1",
      "evidence.v1",
      "permission.policy.v1",
      "provider.profile.v1",
    ],
  );
  assert.ok(["standard", "full-access"].includes(snapshot.host.defaultPermissionMode));
  assert.ok(Array.isArray(snapshot.projects));
  assert.ok(Array.isArray(snapshot.sessions));
  assert.ok(Array.isArray(snapshot.devices));
  assert.ok(Array.isArray(snapshot.providers));
  assert.equal(snapshot.connection, "connected");
  assert.ok(["ready", "working", "auth-required", "unavailable"].includes(snapshot.runtime.state));

  const providerResponse = await page.evaluate(() => window.bridgeDesktop.request({
    method: "provider.list",
    params: {},
  }));
  assert.equal(providerResponse.ok, true, providerResponse.error?.message);
  const providers = providerResponse.result.providers;
  assert.deepEqual(
    providers.map((provider) => provider.kind).sort(),
    ["anthropic-api", "claude-3p", "claude-official"],
  );
  for (const provider of providers) {
    assert.equal("apiKey" in provider, false);
    assert.equal("authorization" in provider, false);
    assert.equal("headers" in provider, false);
  }

  let configurationProof;
  let evidenceProof;
  let routeProof;
  const selectedSession = snapshot.sessions[0];
  if (selectedSession) {
    const routeResponse = await page.evaluate(async (sessionId) => (
      window.bridgeDesktop.request({
        method: "conversation.route.get",
        params: { sessionId },
      })
    ), selectedSession.sessionId);
    assert.equal(routeResponse.ok, true, routeResponse.error?.message);
    const route = routeResponse.result.route;
    assert.equal(route.conversationId, selectedSession.sessionId);
    assert.ok(route.lanes.some((lane) => lane.laneId === route.activeLaneId));
    assert.ok(providers.some((provider) => provider.id === route.activeProviderProfileId));
    routeProof = {
      sessionId: selectedSession.sessionId,
      laneCount: route.lanes.length,
      activeProviderProfileId: route.activeProviderProfileId,
      state: route.state,
    };

    const permissionConfigurationResponse = await page.evaluate(async (sessionId) => (
      window.bridgeDesktop.request({
        method: "session.configuration",
        params: { sessionId },
      })
    ), selectedSession.sessionId);
    assert.equal(
      permissionConfigurationResponse.ok,
      true,
      permissionConfigurationResponse.error?.message,
    );
    assert.ok(
      ["standard", "full-access"].includes(
        permissionConfigurationResponse.result.configuration.permissionPolicy.effectiveMode,
      ),
    );

    const evidenceResponse = await page.evaluate(async (sessionId) => (
      window.bridgeDesktop.request({
        method: "evidence.list",
        params: { sessionId, limit: 30 },
      })
    ), selectedSession.sessionId);
    assert.equal(evidenceResponse.ok, true, evidenceResponse.error?.message);
    assert.equal(evidenceResponse.result.evidence.sessionId, selectedSession.sessionId);
    assert.ok(Array.isArray(evidenceResponse.result.evidence.items));
    evidenceProof = {
      sessionId: selectedSession.sessionId,
      items: evidenceResponse.result.evidence.items.length,
    };
  }

  const longContextSession = snapshot.sessions.find((session) => session.model?.includes("[1m]"));
  if (longContextSession) {
    const configurationResponse = await page.evaluate(async (sessionId) => (
      window.bridgeDesktop.request({
        method: "session.configuration",
        params: { sessionId },
      })
    ), longContextSession.sessionId);
    assert.equal(configurationResponse.ok, true, configurationResponse.error?.message);
    const configuration = configurationResponse.result.configuration;
    assert.equal(configuration.sessionId, longContextSession.sessionId);
    assert.ok(Array.isArray(configuration.availableModels));
    assert.ok(configuration.availableModels.length > 0);
    assert.ok(Array.isArray(configuration.availableEffortLevels));
    assert.ok(configuration.availableEffortLevels.includes("high"));

    const context = configuration.context;
    if (context?.totalTokens > 262_144) {
      assert.ok(context.maxTokens >= 1_000_000);
      const downgrade = configuration.availableModels.find((model) => !model.value.includes("[1m]"));
      if (downgrade) {
        const downgradeResponse = await page.evaluate(async ({ sessionId, model }) => (
          window.bridgeDesktop.request({
            method: "session.configure",
            params: { sessionId, model },
          })
        ), { sessionId: longContextSession.sessionId, model: downgrade.value });
        assert.equal(downgradeResponse.ok, false, "Unsafe context downgrade should be rejected");
        assert.match(downgradeResponse.error?.message ?? "", /上下文|context/i);
      }
    }
    configurationProof = {
      sessionId: configuration.sessionId,
      model: configuration.model,
      effort: configuration.effort,
      models: configuration.availableModels.length,
      context,
    };
  }

  const configurationButton = page.getByRole("button", { name: "模型与 Effort" });
  await configurationButton.click();
  const configurationDialog = page.getByRole("dialog");
  await configurationDialog.waitFor();
  await configurationDialog.getByText("上下文", { exact: true }).waitFor();
  await configurationDialog.getByRole("button", { name: "关闭" }).click();
  await page.locator(".session-view-switch").getByRole("button", { name: /^成果/ }).click();
  await page.locator(".evidence-panel, .evidence-empty").waitFor();
  assert.deepEqual(errors, []);
  await page.screenshot({ path: resolve(artifacts, "desktop-evidence.png"), fullPage: true });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    url: page.url(),
    version: snapshot.host.version,
    projects: snapshot.projects.length,
    sessions: snapshot.sessions.length,
    devices: snapshot.devices.length,
    runtime: snapshot.runtime.state,
    providers: providers.map(({ id, kind, status, configured, readOnly }) => ({
      id,
      kind,
      status,
      configured,
      readOnly,
    })),
    route: routeProof,
    configuration: configurationProof,
    evidence: evidenceProof,
    screenshot: resolve(artifacts, "desktop-evidence.png"),
  }, null, 2)}\n`);
} finally {
  await browser.close();
}
