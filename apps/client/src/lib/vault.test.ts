import { BridgeCrypto, type BridgeHostSnapshot } from "@bridge/protocol";
import { indexedDB } from "fake-indexeddb";
import { beforeAll, describe, expect, it } from "vitest";
import { BridgeVault } from "./vault.js";

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("error", () => reject(transaction.error));
    transaction.addEventListener("abort", () => reject(transaction.error));
  });
}

async function seedLegacyIdentity(
  crypto: BridgeCrypto,
  snapshot: BridgeHostSnapshot,
): Promise<void> {
  const request = indexedDB.open("claude-bridge", 3);
  request.addEventListener("upgradeneeded", () => {
    const database = request.result;
    database.createObjectStore("identity", { keyPath: "key" });
    database.createObjectStore("messages", { keyPath: "id" });
    database.createObjectStore("outbox", { keyPath: "id" });
  });
  const database = await requestResult(request);
  const envelope = await crypto.encrypt(
    { kind: "snapshot", snapshot },
    "desktop",
    "mobile",
    Date.now(),
    30 * 24 * 60 * 60 * 1_000,
    crypto.identity.deviceId,
  );
  const transaction = database.transaction(["identity", "messages"], "readwrite");
  transaction.objectStore("identity").put({
    key: `host:${crypto.identity.roomId}`,
    identity: crypto.identity,
    encryptionKey: crypto.encryptionKey,
    updatedAt: 1_000,
  });
  transaction.objectStore("messages").put({ id: envelope.id, envelope });
  await transactionDone(transaction);
  database.close();
}

beforeAll(() => {
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: indexedDB,
  });
});

describe("BridgeVault pairing migration", () => {
  it("marks protocol v2 hosts for repair and reconnects encrypted cache by stable hostId", async () => {
    const oldHostId = "stable-desktop-host";
    const oldPair = await BridgeCrypto.createDevicePairing({
      hostId: oldHostId,
      pairingEpoch: 1,
      roomId: "legacy-room-12345678",
      relayUrl: "wss://relay.example/ws",
      desktopName: "Studio Mac",
      now: Date.now(),
    });
    const currentOldCrypto = await BridgeCrypto.fromPairing(oldPair.pairing);
    const legacyCrypto = new BridgeCrypto({
      encryptionKey: currentOldCrypto.encryptionKey,
      identity: {
        version: 2,
        roomId: currentOldCrypto.identity.roomId,
        relayUrl: currentOldCrypto.identity.relayUrl,
        desktopName: currentOldCrypto.identity.desktopName,
        deviceId: currentOldCrypto.identity.deviceId,
        authToken: currentOldCrypto.identity.authToken,
      },
    });
    const snapshot: BridgeHostSnapshot = {
      host: {
        hostId: oldHostId,
        pairingEpoch: 1,
        name: "Studio Mac",
        relayUrl: "wss://relay.example/ws",
        online: false,
        lastSeenAt: 1_000,
        version: "0.3.6",
        capabilities: [],
      },
      projects: [],
      sessions: [],
      devices: [],
      runtime: {
        state: "ready",
        detail: "Ready",
        activeTurns: 0,
        maxParallelTurns: 2,
        desktopIntegration: {
          state: "not-managed",
          detail: "Not managed",
          enabled: false,
          canRestart: false,
        },
      },
      permissions: [],
      latestSeq: 0,
    };
    await seedLegacyIdentity(legacyCrypto, snapshot);
    const vault = new BridgeVault();
    const legacyMessages = await vault.listMessages("legacy-room-12345678");
    expect(legacyMessages).toHaveLength(1);
    await expect(legacyCrypto.decrypt(legacyMessages[0]!)).resolves.toMatchObject({
      payload: {
        kind: "snapshot",
        snapshot: { host: { hostId: oldHostId } },
      },
    });
    expect(await vault.listHosts()).toEqual([
      expect.objectContaining({
        hostId: "legacy-room-12345678",
        roomId: "legacy-room-12345678",
        needsRepair: true,
      }),
    ]);

    const newHost = await BridgeCrypto.createHost("wss://relay.example/ws", "Studio Mac");
    const replacement = await BridgeCrypto.createDevicePairing({
      hostId: oldHostId,
      pairingEpoch: 1,
      roomId: newHost.crypto.identity.roomId,
      relayUrl: "wss://relay.example/ws",
      desktopName: "Studio Mac",
    });
    const replacementCrypto = await vault.importPairing(replacement.pairing);
    const hosts = await vault.listHosts();
    const migratedMessages = await vault.listMessages(replacement.pairing.roomId);
    const decrypted = await Promise.all(
      migratedMessages.map((envelope) => replacementCrypto.decrypt(envelope)),
    );

    expect(hosts).toHaveLength(1);
    expect(hosts[0]).toMatchObject({
      hostId: oldHostId,
      roomId: replacement.pairing.roomId,
      needsRepair: false,
    });
    expect(decrypted.some((message) => (
      message.payload.kind === "snapshot" &&
      message.payload.snapshot.host.hostId === oldHostId
    ))).toBe(true);
    expect(await vault.listMessages("legacy-room-12345678")).toEqual([]);
    await vault.clear();
  });
});
