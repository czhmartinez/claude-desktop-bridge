import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeCrypto } from "@bridge/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { createRelayBackup } from "./backup.js";
import { SqliteRelayStore } from "./sqlite-store.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("SqliteRelayStore", () => {
  it("persists rooms, claimed devices and encrypted queues across a restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-relay-sqlite-"));
    directories.push(directory);
    const path = join(directory, "bridge-relay.db");
    const now = Date.now();
    const host = await BridgeCrypto.createHost("wss://bridge.example/ws", "Test Mac");
    const pairing = await BridgeCrypto.createDevicePairing({
      roomId: host.crypto.identity.roomId,
      relayUrl: "wss://bridge.example/ws",
      desktopName: "Test Mac",
    });
    const mobile = await BridgeCrypto.fromPairing(pairing.pairing);
    const envelope = await mobile.encrypt({
      kind: "request",
      requestId: "request-sqlite",
      idempotencyKey: "request-sqlite",
      method: "project.list",
      params: {},
    }, "mobile", "desktop", now);

    const first = new SqliteRelayStore(path);
    await first.load();
    await first.createRoom({
      id: host.crypto.identity.roomId,
      hostDeviceId: host.crypto.identity.deviceId,
      authHash: "host-auth-hash",
      createdAt: now,
      lastSeenAt: now,
    });
    await first.registerDevice({
      roomId: host.crypto.identity.roomId,
      deviceId: pairing.pairing.deviceId,
      role: "mobile",
      authHash: "device-auth-hash",
      createdAt: now,
      expiresAt: now + 60_000,
    });
    expect(await first.claimDevice(
      host.crypto.identity.roomId,
      pairing.pairing.deviceId,
      "installation-1",
      now,
    )).toBe(true);
    await first.enqueue(envelope);
    await first.close();

    const reopened = new SqliteRelayStore(path);
    await reopened.load();
    expect(reopened.getRoom(host.crypto.identity.roomId)?.hostDeviceId).toBe(host.crypto.identity.deviceId);
    expect(reopened.getDevice(host.crypto.identity.roomId, pairing.pairing.deviceId)).toMatchObject({
      claimedInstanceId: "installation-1",
      claimedAt: now,
    });
    expect(reopened.listQueued(
      host.crypto.identity.roomId,
      "desktop",
      host.crypto.identity.deviceId,
      now,
    )).toEqual([envelope]);
    expect((await reopened.ack(
      host.crypto.identity.roomId,
      "desktop",
      host.crypto.identity.deviceId,
      [envelope.id],
    ))).toEqual([envelope]);
    expect(reopened.stats()).toMatchObject({ rooms: 1, devices: 1, queuedFrames: 0 });
    await reopened.close();
  });

  it("creates restorable daily database backups and applies retention", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bridge-relay-backup-"));
    directories.push(directory);
    const store = new SqliteRelayStore(join(directory, "bridge-relay.db"));
    await store.load();
    const backups = join(directory, "backups");
    for (let index = 0; index < 4; index += 1) {
      await createRelayBackup(store, backups, 2, Date.UTC(2026, 6, 20 + index));
    }
    expect((await readdir(backups)).sort()).toHaveLength(2);
    await store.close();
  });
});
