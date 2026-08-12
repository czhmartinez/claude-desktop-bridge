import { dirname, resolve } from "node:path";
import { scheduleRelayBackups } from "./backup.js";
import { JsonFileRelayStore } from "./store.js";
import { SqliteRelayStore } from "./sqlite-store.js";
import { startRelayServer } from "./server.js";

const host = process.env.BRIDGE_RELAY_HOST ?? "127.0.0.1";
const port = Number(process.env.BRIDGE_RELAY_PORT ?? 8788);
const dataPath = resolve(process.env.BRIDGE_RELAY_DATA ?? "./data/bridge-relay.db");
const backupDirectory = resolve(
  process.env.BRIDGE_RELAY_BACKUP_DIR ?? `${dirname(dataPath)}/backups`,
);
const allowedOrigins = (process.env.BRIDGE_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const maxFramesPerMinute = Number(process.env.BRIDGE_RELAY_MAX_FRAMES_PER_MINUTE ?? 6000);

const store = dataPath.endsWith(".json")
  ? new JsonFileRelayStore(dataPath)
  : new SqliteRelayStore(dataPath);
const relay = await startRelayServer({
  host,
  port,
  store,
  trustProxy: process.env.BRIDGE_TRUST_PROXY === "1",
  maxFramesPerMinute: Number.isFinite(maxFramesPerMinute) && maxFramesPerMinute > 0
    ? maxFramesPerMinute
    : 6000,
  ...(allowedOrigins.length ? { allowedOrigins } : {}),
});
const backups = scheduleRelayBackups(store, backupDirectory);
void backups.run();

console.info(`Claude Bridge relay listening at ${relay.url}`);

async function shutdown(): Promise<void> {
  backups.stop();
  await relay.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
