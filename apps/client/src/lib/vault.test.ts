import {
  BridgeCrypto,
  DEFAULT_BRIDGE_ICE_SERVERS,
  bridgeEndpoint,
  type BridgeHostSnapshot,
} from "@bridge/protocol";
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
  it("heals a stale LAN relay in place when the desktop advertises a fresh one", async () => {
    const vault = new BridgeVault();
    await vault.clear();
    const pairing = await BridgeCrypto.createDevicePairing({
      hostId: "lan-heal-host",
      pairingEpoch: 1,
      roomId: "lan-heal-room",
      relayUrl: "ws://192.168.1.32:8788/ws",
      desktopName: "Studio Mac",
      relayEndpoints: [
        { id: "public", kind: "public-relay", url: "wss://relay.example/ws", priority: 10 },
        { id: "lan", kind: "lan-relay", url: "ws://192.168.1.32:8788/ws", priority: 20 },
      ],
      // Pairing-era state: the LAN relay was the active one back then, so both
      // the endpoint list and the identity URL carry the now-stale LAN IP.
      activeEndpoint: "lan",
    });
    await vault.importPairing(pairing.pairing);

    const changed = await vault.updateLanRelay("lan-heal-room", "ws://192.168.0.101:8788/ws");
    expect(changed).toBe(true);
    const healed = (await vault.listHosts())[0];
    expect(healed?.relayEndpoints.find((endpoint) => endpoint.kind === "lan-relay")?.url)
      .toBe("ws://192.168.0.101:8788/ws");

    // Re-applying the same advertisement is a no-op.
    expect(await vault.updateLanRelay("lan-heal-room", "ws://192.168.0.101:8788/ws")).toBe(false);
    await vault.clear();
  });

  it("upgrades the historical Cloudflare-only ICE default without removing the paired host", async () => {
    const vault = new BridgeVault();
    await vault.clear();
    const pairing = await BridgeCrypto.createDevicePairing({
      hostId: "ice-default-host",
      pairingEpoch: 1,
      roomId: "ice-default-room",
      relayUrl: "wss://relay.example/ws",
      desktopName: "Studio Mac",
      iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
    });

    const crypto = await vault.importPairing(pairing.pairing);
    const migrated = (await vault.listHosts())[0];
    expect(migrated).toMatchObject({
      hostId: "ice-default-host",
      roomId: "ice-default-room",
      crypto: expect.objectContaining({ identity: expect.objectContaining({ deviceId: crypto.identity.deviceId }) }),
      iceServers: DEFAULT_BRIDGE_ICE_SERVERS,
    });

    // A normal host touch persists the smooth transport upgrade without
    // changing any pairing identity or encrypted content.
    await vault.touchHost(crypto);
    expect((await vault.listHosts())[0]?.iceServers).toEqual(DEFAULT_BRIDGE_ICE_SERVERS);
    await vault.clear();
  });

  it("keeps an explicitly configured ICE list for an existing pairing", async () => {
    const vault = new BridgeVault();
    await vault.clear();
    const explicitIce = [{ urls: "stun:stun.example.net:3478" }];
    const pairing = await BridgeCrypto.createDevicePairing({
      hostId: "ice-custom-host",
      pairingEpoch: 1,
      roomId: "ice-custom-room",
      relayUrl: "wss://relay.example/ws",
      desktopName: "Studio Mac",
      iceServers: explicitIce,
    });

    await vault.importPairing(pairing.pairing);
    expect((await vault.listHosts())[0]?.iceServers).toEqual(explicitIce);
    await vault.clear();
  });

  it("prefers the packaged Relay while retaining an existing public Relay as fallback", async () => {
    const vault = new BridgeVault();
    await vault.clear();
    const pairing = await BridgeCrypto.createDevicePairing({
      hostId: "relay-migration-host",
      pairingEpoch: 1,
      roomId: "relay-migration-room",
      relayUrl: "wss://relay.alioxis.uk/ws",
      serviceOrigin: "https://relay.alioxis.uk",
      relayEndpoints: [bridgeEndpoint("wss://relay.alioxis.uk/ws", 10, "public")],
      activeEndpoint: "public",
      desktopName: "Studio Mac",
    });

    await vault.importPairing(pairing.pairing);
    expect(await vault.listHosts()).toEqual([expect.objectContaining({
      relayUrl: "wss://relay.alioxis.com/ws",
      activeEndpoint: "public",
      relayEndpoints: expect.arrayContaining([
        expect.objectContaining({ id: "public", url: "wss://relay.alioxis.com/ws", priority: 10 }),
        expect.objectContaining({
          id: "legacy-public-0",
          url: "wss://relay.alioxis.uk/ws",
          priority: 30,
        }),
      ]),
    })]);
    await vault.clear();
  });

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
    const migratedInstanceId = (await vault.listHosts())[0]?.crypto.identity.instanceId;
    expect(migratedInstanceId).toEqual(expect.any(String));
    expect((await vault.listHosts())[0]?.crypto.identity.instanceId).toBe(migratedInstanceId);

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

  it("commits the crypto instance that completed the handshake and only removes provisional artifacts", async () => {
    const vault = new BridgeVault();
    await vault.clear();
    const hostId = "two-phase-host";
    const roomId = "two-phase-room";
    const first = await BridgeCrypto.createDevicePairing({
      hostId,
      pairingEpoch: 1,
      roomId,
      relayUrl: "wss://relay.example/ws",
      desktopName: "Studio Mac",
    });
    const oldCrypto = await vault.importPairing(first.pairing);
    const replacement = await BridgeCrypto.createDevicePairing({
      hostId,
      pairingEpoch: 1,
      roomId,
      relayUrl: "wss://relay.example/ws",
      desktopName: "Studio Mac",
    });
    const preparedCrypto = await BridgeCrypto.fromPairing(replacement.pairing);
    const request = {
      kind: "request" as const,
      requestId: "handshake-request",
      idempotencyKey: "handshake-key",
      method: "snapshot.get" as const,
      params: {},
    };
    const oldEnvelope = await oldCrypto.encrypt(request, "mobile", "desktop");
    const provisionalEnvelope = await preparedCrypto.encrypt(request, "mobile", "desktop");
    await vault.saveMessage(oldEnvelope);
    await vault.saveMessage(provisionalEnvelope);
    await vault.addOutbox(oldEnvelope);
    await vault.addOutbox(provisionalEnvelope);

    await vault.removeDeviceArtifacts(roomId, preparedCrypto.identity.deviceId);

    expect((await vault.listMessages(roomId)).map((envelope) => envelope.id)).toEqual([oldEnvelope.id]);
    expect((await vault.listOutbox(roomId)).map((envelope) => envelope.id)).toEqual([oldEnvelope.id]);

    await vault.importPairing(replacement.pairing, preparedCrypto);
    const stored = await vault.getHost(roomId);
    expect(stored?.crypto.identity.deviceId).toBe(preparedCrypto.identity.deviceId);
    expect(stored?.crypto.identity.instanceId).toBe(preparedCrypto.identity.instanceId);
    await vault.clear();
  });
});
