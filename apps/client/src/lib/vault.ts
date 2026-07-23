import {
  BridgeCrypto,
  type EncryptedEnvelope,
  type PairingBundle,
  type StoredIdentity,
} from "@bridge/protocol";

const DATABASE_NAME = "claude-bridge";
const DATABASE_VERSION = 1;
const LEGACY_IDENTITY_KEY = "current";
const HOST_KEY_PREFIX = "host:";
const MESSAGE_LIMIT = 250;

interface StoredCrypto {
  key: string;
  identity: StoredIdentity;
  encryptionKey: CryptoKey;
  updatedAt?: number;
}

interface StoredMessage {
  id: string;
  envelope: EncryptedEnvelope;
}

export interface StoredBridgeHost {
  roomId: string;
  desktopName: string;
  relayUrl: string;
  updatedAt: number;
  crypto: BridgeCrypto;
}

function hostKey(roomId: string): string {
  return `${HOST_KEY_PREFIX}${roomId}`;
}

function isStoredCrypto(value: unknown): value is StoredCrypto {
  if (typeof value !== "object" || value === null) return false;
  const stored = value as Partial<StoredCrypto>;
  return (
    typeof stored.key === "string" &&
    typeof stored.identity === "object" &&
    stored.identity !== null &&
    typeof stored.identity.roomId === "string" &&
    stored.encryptionKey instanceof CryptoKey
  );
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error ?? new Error("Storage request failed")));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("abort", () => reject(transaction.error ?? new Error("Storage transaction aborted")));
    transaction.addEventListener("error", () => reject(transaction.error ?? new Error("Storage transaction failed")));
  });
}

export class BridgeVault {
  private databasePromise: Promise<IDBDatabase> | undefined;

  private open(): Promise<IDBDatabase> {
    if (this.databasePromise) return this.databasePromise;
    this.databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.addEventListener("upgradeneeded", () => {
        const database = request.result;
        if (!database.objectStoreNames.contains("identity")) database.createObjectStore("identity", { keyPath: "key" });
        if (!database.objectStoreNames.contains("messages")) database.createObjectStore("messages", { keyPath: "id" });
        if (!database.objectStoreNames.contains("outbox")) database.createObjectStore("outbox", { keyPath: "id" });
      });
      request.addEventListener("success", () => resolve(request.result));
      request.addEventListener("error", () => reject(request.error ?? new Error("Could not open secure storage")));
    });
    return this.databasePromise;
  }

  async importPairing(pairing: PairingBundle): Promise<BridgeCrypto> {
    const crypto = await BridgeCrypto.fromPairing(pairing);
    const database = await this.open();
    const transaction = database.transaction("identity", "readwrite");
    transaction.objectStore("identity").put({
      key: hostKey(crypto.identity.roomId),
      identity: crypto.identity,
      encryptionKey: crypto.encryptionKey,
      updatedAt: Date.now(),
    } satisfies StoredCrypto);
    await transactionDone(transaction);
    return crypto;
  }

  async listHosts(): Promise<StoredBridgeHost[]> {
    const database = await this.open();
    const transaction = database.transaction("identity", "readonly");
    const records = await requestResult(transaction.objectStore("identity").getAll()) as unknown[];
    const hosts = new Map<string, StoredBridgeHost>();
    for (const stored of records.filter(isStoredCrypto)) {
      const existing = hosts.get(stored.identity.roomId);
      const updatedAt = stored.updatedAt ?? 0;
      if (existing && existing.updatedAt > updatedAt) continue;
      hosts.set(stored.identity.roomId, {
        roomId: stored.identity.roomId,
        desktopName: stored.identity.desktopName,
        relayUrl: stored.identity.relayUrl,
        updatedAt,
        crypto: new BridgeCrypto({ identity: stored.identity, encryptionKey: stored.encryptionKey }),
      });
    }
    return [...hosts.values()].sort((left, right) => right.updatedAt - left.updatedAt);
  }

  async touchHost(crypto: BridgeCrypto): Promise<void> {
    const database = await this.open();
    const transaction = database.transaction("identity", "readwrite");
    const store = transaction.objectStore("identity");
    const legacy = await requestResult(store.get(LEGACY_IDENTITY_KEY)) as StoredCrypto | undefined;
    store.put({
      key: hostKey(crypto.identity.roomId),
      identity: crypto.identity,
      encryptionKey: crypto.encryptionKey,
      updatedAt: Date.now(),
    } satisfies StoredCrypto);
    if (legacy?.identity.roomId === crypto.identity.roomId) store.delete(LEGACY_IDENTITY_KEY);
    await transactionDone(transaction);
  }

  async saveMessage(envelope: EncryptedEnvelope): Promise<void> {
    const database = await this.open();
    const transaction = database.transaction("messages", "readwrite");
    const store = transaction.objectStore("messages");
    store.put({ id: envelope.id, envelope } satisfies StoredMessage);
    const all = await requestResult(store.getAll()) as StoredMessage[];
    if (all.length > MESSAGE_LIMIT) {
      all.sort((a, b) => a.envelope.sentAt - b.envelope.sentAt);
      for (const message of all.slice(0, all.length - MESSAGE_LIMIT)) store.delete(message.id);
    }
    await transactionDone(transaction);
  }

  async listMessages(roomId?: string): Promise<EncryptedEnvelope[]> {
    const database = await this.open();
    const transaction = database.transaction("messages", "readonly");
    const all = await requestResult(transaction.objectStore("messages").getAll()) as StoredMessage[];
    return all
      .map((entry) => entry.envelope)
      .filter((envelope) => !roomId || envelope.roomId === roomId)
      .sort((a, b) => a.sentAt - b.sentAt);
  }

  async addOutbox(envelope: EncryptedEnvelope): Promise<void> {
    const database = await this.open();
    const transaction = database.transaction("outbox", "readwrite");
    transaction.objectStore("outbox").put({ id: envelope.id, envelope } satisfies StoredMessage);
    await transactionDone(transaction);
  }

  async removeOutbox(id: string): Promise<void> {
    const database = await this.open();
    const transaction = database.transaction("outbox", "readwrite");
    transaction.objectStore("outbox").delete(id);
    await transactionDone(transaction);
  }

  async listOutbox(roomId?: string): Promise<EncryptedEnvelope[]> {
    const database = await this.open();
    const transaction = database.transaction("outbox", "readonly");
    const all = await requestResult(transaction.objectStore("outbox").getAll()) as StoredMessage[];
    return all
      .map((entry) => entry.envelope)
      .filter((envelope) => !roomId || envelope.roomId === roomId)
      .sort((a, b) => a.sentAt - b.sentAt);
  }

  async removeHost(roomId: string): Promise<void> {
    const database = await this.open();
    await Promise.all([
      (async () => {
        const transaction = database.transaction("identity", "readwrite");
        const store = transaction.objectStore("identity");
        const records = await requestResult(store.getAll()) as unknown[];
        for (const stored of records.filter(isStoredCrypto)) {
          if (stored.identity.roomId === roomId) store.delete(stored.key);
        }
        await transactionDone(transaction);
      })(),
      ...(["messages", "outbox"] as const).map(async (storeName) => {
        const transaction = database.transaction(storeName, "readwrite");
        const store = transaction.objectStore(storeName);
        const records = await requestResult(store.getAll()) as StoredMessage[];
        for (const stored of records) {
          if (stored.envelope.roomId === roomId) store.delete(stored.id);
        }
        await transactionDone(transaction);
      }),
    ]);
  }

  async clear(): Promise<void> {
    const database = await this.open();
    const transaction = database.transaction(["identity", "messages", "outbox"], "readwrite");
    transaction.objectStore("identity").clear();
    transaction.objectStore("messages").clear();
    transaction.objectStore("outbox").clear();
    await transactionDone(transaction);
  }
}

export const bridgeVault = new BridgeVault();
