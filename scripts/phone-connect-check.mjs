import { chromium } from "playwright-core";

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.argv[2] ?? process.env.BRIDGE_CDP_PORT ?? "9333"}`);
const page = browser.contexts().flatMap((context) => context.pages())
  .find((candidate) => candidate.url().startsWith("https://localhost"));
if (!page) throw new Error("Bridge webview not found");

// 点进主机（HostBrowser 的主机行）
await page.getByText("Martinezs-MacBook-Pro").first().click().catch(() => undefined);
await page.waitForTimeout(4_000);
// 连接建立过程读三次
for (let attempt = 0; attempt < 4; attempt += 1) {
  const state = await page.evaluate(() => {
    const text = (selector) => document.querySelector(selector)?.textContent?.trim() ?? null;
    return {
      topbar: text(".mobile-device"),
      band: text(".mobile-transport-band"),
      heading: text("h1"),
    };
  });
  console.log(`[t+${(attempt + 1) * 5}s]`, JSON.stringify(state));
  await page.waitForTimeout(5_000);
}

await browser.close();
