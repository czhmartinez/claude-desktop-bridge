import { chromium } from "playwright-core";

// 真机 WebView 现场取证：经 adb forward 的 CDP 读取页面实时状态与保险库。
// 用法：adb -s <device> forward tcp:9333 localabstract:webview_devtools_remote_<pid>
//       node scripts/phone-inspect.mjs [cdpPort]
const cdpPort = process.argv[2] ?? process.env.BRIDGE_CDP_PORT ?? "9333";
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
const page = browser.contexts().flatMap((context) => context.pages())
  .find((candidate) => candidate.url().startsWith("https://localhost"));
if (!page) throw new Error("Bridge webview not found");

page.on("console", (message) => console.log("[console]", message.type(), message.text().slice(0, 200)));

const report = await page.evaluate(async () => {
  const text = (selector) => document.querySelector(selector)?.textContent?.trim() ?? null;
  const dom = {
    url: location.href,
    theme: document.documentElement.dataset.theme,
    family: document.documentElement.dataset.themeFamily,
    topbar: text(".mobile-device"),
    transportBand: text(".mobile-transport-band"),
    heading: text("h1"),
  };
  const openDb = () => new Promise((resolve, reject) => {
    const request = indexedDB.open("claude-bridge");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const db = await openDb();
  const stores = {};
  for (const name of db.objectStoreNames) {
    const tx = db.transaction(name, "readonly");
    const store = tx.objectStore(name);
    const rows = await new Promise((resolve) => {
      const all = [];
      const cursor = store.openCursor();
      cursor.onsuccess = () => {
        if (cursor.result) { all.push(cursor.result.value); cursor.result.continue(); }
        else resolve(all);
      };
      cursor.onerror = () => resolve(all);
    });
    stores[name] = rows.map((row) => JSON.stringify(row, (key, value) => (
      key === "encryptionKey" || key === "secret" || key === "authToken" ? "[redacted]" : value
    )).slice(0, 600));
  }
  return { dom, stores };
});

console.log("=== DOM ===");
console.log(JSON.stringify(report.dom, null, 1));
for (const [name, rows] of Object.entries(report.stores)) {
  console.log(`=== store ${name} (${rows.length}) ===`);
  for (const row of rows.slice(0, 6)) console.log(row);
}

await browser.close();
