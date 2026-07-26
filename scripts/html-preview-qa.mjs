import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import electronPath from "electron";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const work = await mkdtemp(resolve(tmpdir(), "bridge-html-preview-"));
const entry = resolve(work, "preview-qa.cjs");
const proof = resolve(work, "proof.json");
const screenshot = resolve(root, "artifacts", "html-preview", "sandboxed-preview.jpg");
await mkdir(resolve(root, "artifacts", "html-preview"), { recursive: true });

const source = `
const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const { writeFile } = require("node:fs/promises");
const { app, BrowserWindow, nativeImage, protocol } = require("electron");
const { ElectronEvidencePreviewRenderer } = require(
  ${JSON.stringify(resolve(root, "apps/desktop/src/artifact-preview.ts"))}
);

protocol.registerSchemesAsPrivileged([{
  scheme: "bridge-artifact",
  privileges: { standard: true, secure: true },
}]);

async function listen(server) {
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
}

void app.whenReady().then(async () => {
  const guardian = new BrowserWindow({ show: false });
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.end("network should be blocked");
  });
  try {
    await listen(server);
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const external = "http://127.0.0.1:" + address.port + "/leak";
    const renderer = new ElectronEvidencePreviewRenderer();
    const html = Buffer.from(
      "<!doctype html><meta charset=utf-8>" +
      "<style>body{margin:0;background:#fff;color:#111;font:48px sans-serif}</style>" +
      "<h1>Sandboxed HTML preview</h1>" +
      "<img src='" + external + "'>" +
      "<script>" +
      "fetch('" + external + "').catch(()=>{});" +
      "window.open('" + external + "');" +
      "const a=document.createElement('a');a.href='data:text/plain,blocked';a.download='blocked.txt';a.click();" +
      "</script>",
      "utf8",
    );
    const preview = await renderer.html(html);
    const image = nativeImage.createFromBuffer(preview.bytes);
    assert.equal(preview.mimeType, "image/jpeg");
    assert.deepEqual(image.getSize(), { width: 1440, height: 900 });
    assert.ok(preview.bytes.byteLength > 1_000);
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    assert.equal(requests, 0, "HTML preview made an external network request");
    await writeFile(${JSON.stringify(screenshot)}, preview.bytes);

    const startedAt = Date.now();
    await assert.rejects(
      renderer.html(Buffer.from("<script>while(true){}</script>", "utf8")),
      /timed out/i,
    );
    const maliciousElapsedMs = Date.now() - startedAt;
    assert.ok(maliciousElapsedMs >= 4_500, "Malicious HTML did not exercise the render timeout");
    assert.ok(maliciousElapsedMs < 7_000, "Malicious HTML timeout exceeded seven seconds");
    const proof = {
      ok: true,
      size: image.getSize(),
      bytes: preview.bytes.byteLength,
      externalRequests: requests,
      maliciousElapsedMs,
      screenshot: ${JSON.stringify(screenshot)},
    };
    await writeFile(${JSON.stringify(proof)}, JSON.stringify(proof), "utf8");
    process.stdout.write(JSON.stringify(proof, null, 2) + "\\n");
    server.close();
    guardian.destroy();
    app.exit(0);
  } catch (error) {
    server.close();
    guardian.destroy();
    process.stderr.write((error && error.stack ? error.stack : String(error)) + "\\n");
    app.exit(1);
  }
}, (error) => {
  process.stderr.write((error && error.stack ? error.stack : String(error)) + "\\n");
  app.exit(1);
});
`;

try {
  await build({
    stdin: {
      contents: source,
      resolveDir: root,
      sourcefile: "bridge-html-preview-qa.ts",
      loader: "ts",
    },
    outfile: entry,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["electron"],
  });
  const exitCode = await new Promise((resolveExit, reject) => {
    const child = spawn(electronPath, [entry], {
      cwd: root,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`HTML preview QA exited with signal ${signal}`));
      else resolveExit(code ?? 1);
    });
  });
  if (exitCode !== 0) process.exitCode = exitCode;
  else {
    const result = JSON.parse(await readFile(proof, "utf8"));
    if (result.ok !== true || result.externalRequests !== 0) {
      throw new Error("HTML preview QA did not produce a valid proof");
    }
  }
} finally {
  await rm(work, { recursive: true, force: true });
}
