import { resolve } from "node:path";
import { JsonFileRelayStore } from "./store.js";
import { startRelayServer } from "./server.js";

const host = process.env.BRIDGE_RELAY_HOST ?? "127.0.0.1";
const port = Number(process.env.BRIDGE_RELAY_PORT ?? 8788);
const dataPath = resolve(process.env.BRIDGE_RELAY_DATA ?? "./data/relay-store.json");
const allowedOrigins = (process.env.BRIDGE_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const relay = await startRelayServer({
  host,
  port,
  store: new JsonFileRelayStore(dataPath),
  ...(allowedOrigins.length ? { allowedOrigins } : {}),
});

console.info(`Claude Bridge relay listening at ${relay.url}`);

async function shutdown(): Promise<void> {
  await relay.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
