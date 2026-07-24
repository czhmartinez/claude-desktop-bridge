import { mkdir, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { RelayStore } from "./store.js";

const DAY_MS = 24 * 60 * 60 * 1_000;

function backupName(now: number): string {
  return `bridge-relay-${new Date(now).toISOString().replaceAll(":", "-")}.db`;
}

export async function createRelayBackup(
  store: RelayStore,
  directory: string,
  retain = 7,
  now = Date.now(),
): Promise<string | undefined> {
  if (!store.backup) return undefined;
  await mkdir(directory, { recursive: true });
  const destination = join(directory, backupName(now));
  await store.backup(destination);
  const backups = (await readdir(directory))
    .filter((name) => /^bridge-relay-.+\.db$/u.test(name))
    .sort()
    .reverse();
  await Promise.all(backups.slice(retain).map((name) => unlink(join(directory, name))));
  return destination;
}

export function scheduleRelayBackups(
  store: RelayStore,
  directory: string,
  logger: Pick<Console, "info" | "warn"> = console,
  intervalMs = DAY_MS,
): { run(): Promise<string | undefined>; stop(): void } {
  const run = async () => {
    try {
      const path = await createRelayBackup(store, directory);
      if (path) logger.info(`Relay backup completed: ${path}`);
      return path;
    } catch (error) {
      logger.warn("Relay backup failed", error);
      return undefined;
    }
  };
  const timer = setInterval(() => void run(), intervalMs);
  timer.unref?.();
  return {
    run,
    stop: () => clearInterval(timer),
  };
}
