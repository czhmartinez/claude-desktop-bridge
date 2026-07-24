import { access, readFile, rename, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { SqliteRelayStore } from "../apps/relay/dist/sqlite-store.js";

const source = resolve(process.argv[2] ?? "data/relay-store.json");
const destination = resolve(process.argv[3] ?? "data/bridge-relay.db");

await access(source);
await access(destination).then(
  () => {
    throw new Error(`Destination already exists: ${destination}`);
  },
  () => undefined,
);

const snapshot = JSON.parse(await readFile(source, "utf8"));
if (
  (snapshot.version !== 2 && snapshot.version !== 3) ||
  !Array.isArray(snapshot.rooms) ||
  !Array.isArray(snapshot.devices) ||
  !Array.isArray(snapshot.messages)
) {
  throw new Error("Unsupported Relay JSON snapshot");
}

const temporary = `${destination}.migration-${process.pid}`;
const store = new SqliteRelayStore(temporary);
try {
  await store.load();
  for (const room of snapshot.rooms) await store.createRoom(room);
  for (const device of snapshot.devices) await store.registerDevice(device);
  for (const message of snapshot.messages) await store.enqueue(message);
  const stats = store.stats();
  if (
    stats.rooms !== snapshot.rooms.length ||
    stats.devices !== snapshot.devices.length ||
    stats.queuedFrames !== snapshot.messages.length
  ) {
    throw new Error("Relay migration count mismatch");
  }
  await store.close();
  await rename(temporary, destination);
  process.stdout.write(
    `Migrated ${stats.rooms} rooms, ${stats.devices} devices and ${stats.queuedFrames} queued frames.\n`,
  );
} catch (error) {
  await store.close().catch(() => undefined);
  await Promise.all([
    rm(temporary, { force: true }),
    rm(`${temporary}-wal`, { force: true }),
    rm(`${temporary}-shm`, { force: true }),
  ]);
  throw error;
}
