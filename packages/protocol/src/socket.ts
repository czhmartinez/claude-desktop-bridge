import { BridgeCrypto } from "./crypto.js";
import { decodeUtf8, fromBase64Url, toBase64Url, utf8 } from "./encoding.js";
import { isEncryptedEnvelope, parseServerFrame } from "./validation.js";
import {
  ENVELOPE_CHUNK_BYTES,
  PROTOCOL_VERSION,
  type BridgePayload,
  type BridgeRole,
  type DecryptedEnvelope,
  type EncryptedEnvelopeChunk,
  type EncryptedEnvelope,
  type EnvelopeChunkManifest,
  type MessageTarget,
  type ServerFrame,
} from "./types.js";

export type SocketState = "idle" | "connecting" | "connected" | "reconnecting" | "closed";

export interface BridgeSocketOptions {
  crypto: BridgeCrypto;
  role: BridgeRole;
  createRoom?: boolean;
  WebSocketImpl?: typeof WebSocket;
  reconnect?: boolean;
  resolveCrypto?: (envelope: EncryptedEnvelope) => BridgeCrypto | undefined | Promise<BridgeCrypto | undefined>;
}

export interface SendOptions {
  toDeviceId?: string;
  crypto?: BridgeCrypto;
  ttlMs?: number;
}

export interface DeviceRegistrationOptions {
  migrate?: boolean;
  pairedAt?: number;
}

export type MessageListener = (message: DecryptedEnvelope, encrypted: EncryptedEnvelope) => void;
export type StateListener = (state: SocketState) => void;
export type FrameListener = (frame: ServerFrame) => void;

interface IncomingTransfer {
  chunk: EncryptedEnvelopeChunk;
  parts: Array<Uint8Array<ArrayBuffer> | undefined>;
  received: number;
  byteLength: number;
}

function sameChunkTransfer(left: EncryptedEnvelopeChunk, right: EncryptedEnvelopeChunk): boolean {
  return (
    left.transferId === right.transferId &&
    left.roomId === right.roomId &&
    left.from === right.from &&
    left.fromDeviceId === right.fromDeviceId &&
    left.to === right.to &&
    left.toDeviceId === right.toDeviceId &&
    left.sentAt === right.sentAt &&
    left.expiresAt === right.expiresAt &&
    left.total === right.total &&
    left.sha256 === right.sha256
  );
}

export class BridgeSocket {
  private readonly crypto: BridgeCrypto;
  private readonly role: BridgeRole;
  private readonly createRoom: boolean;
  private readonly WebSocketImpl: typeof WebSocket;
  private readonly shouldReconnect: boolean;
  private readonly resolveCrypto?: BridgeSocketOptions["resolveCrypto"];
  private ws: WebSocket | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectAttempt = 0;
  private stopped = false;
  private stateValue: SocketState = "idle";
  private messageListeners = new Set<MessageListener>();
  private stateListeners = new Set<StateListener>();
  private frameListeners = new Set<FrameListener>();
  private incomingTransfers = new Map<string, IncomingTransfer>();
  private deliveredIds = new Set<string>();
  private missingChunkRequests = new Map<string, {
    resolve(indexes: number[] | undefined): void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(options: BridgeSocketOptions) {
    this.crypto = options.crypto;
    this.role = options.role;
    this.createRoom = options.createRoom ?? false;
    this.WebSocketImpl = options.WebSocketImpl ?? WebSocket;
    this.shouldReconnect = options.reconnect ?? true;
    this.resolveCrypto = options.resolveCrypto;
  }

  get state(): SocketState {
    return this.stateValue;
  }

  connect(): void {
    if (this.ws && (this.ws.readyState === this.WebSocketImpl.OPEN || this.ws.readyState === this.WebSocketImpl.CONNECTING)) return;
    this.stopped = false;
    this.setState(this.reconnectAttempt > 0 ? "reconnecting" : "connecting");
    const ws = new this.WebSocketImpl(this.crypto.identity.relayUrl);
    this.ws = ws;
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({
        type: "hello",
        version: PROTOCOL_VERSION,
        roomId: this.crypto.identity.roomId,
        role: this.role,
        deviceId: this.crypto.identity.deviceId,
        ...(this.crypto.identity.instanceId ? { instanceId: this.crypto.identity.instanceId } : {}),
        authToken: this.crypto.identity.authToken,
        create: this.createRoom,
      }));
    });
    ws.addEventListener("message", (event) => void this.handleMessage(String(event.data)));
    ws.addEventListener("close", () => this.handleClose());
    ws.addEventListener("error", () => {
      if (ws.readyState === this.WebSocketImpl.OPEN) ws.close();
    });
  }

  close(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close(1000, "client closed");
    this.ws = undefined;
    this.incomingTransfers.clear();
    for (const pending of this.missingChunkRequests.values()) {
      clearTimeout(pending.timer);
      pending.resolve(undefined);
    }
    this.missingChunkRequests.clear();
    this.setState("closed");
  }

  async send(payload: BridgePayload, to: MessageTarget, options: SendOptions = {}): Promise<string> {
    if (!this.ws || this.stateValue !== "connected" || this.ws.readyState !== this.WebSocketImpl.OPEN) {
      throw new Error("Bridge is not connected");
    }
    const selectedCrypto = options.crypto ?? this.crypto;
    const envelope = await selectedCrypto.encrypt(
      payload,
      this.role,
      to,
      Date.now(),
      options.ttlMs,
      options.toDeviceId,
    );
    await this.sendEnvelope(envelope);
    return envelope.id;
  }

  async sendEnvelope(envelope: EncryptedEnvelope): Promise<void> {
    if (!this.ws || this.stateValue !== "connected" || this.ws.readyState !== this.WebSocketImpl.OPEN) {
      throw new Error("Bridge is not connected");
    }
    const serialized = utf8(JSON.stringify(envelope));
    if (serialized.byteLength <= ENVELOPE_CHUNK_BYTES) {
      this.ws.send(JSON.stringify({ type: "envelope", envelope }));
      return;
    }
    const digest = toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", serialized)));
    const total = Math.ceil(serialized.byteLength / ENVELOPE_CHUNK_BYTES);
    const manifest: EnvelopeChunkManifest = {
      version: envelope.version,
      transferId: envelope.id,
      roomId: envelope.roomId,
      from: envelope.from,
      fromDeviceId: envelope.fromDeviceId,
      to: envelope.to,
      ...(envelope.toDeviceId ? { toDeviceId: envelope.toDeviceId } : {}),
      sentAt: envelope.sentAt,
      expiresAt: envelope.expiresAt,
      total,
      sha256: digest,
    };
    const missing = await this.queryMissingChunks(manifest);
    const indexes = missing ?? Array.from({ length: total }, (_, index) => index);
    for (const index of indexes) {
      if (index < 0 || index >= total) continue;
      if (!this.ws || this.stateValue !== "connected" || this.ws.readyState !== this.WebSocketImpl.OPEN) {
        throw new Error("Bridge disconnected while sending an attachment");
      }
      const start = index * ENVELOPE_CHUNK_BYTES;
      const chunk: EncryptedEnvelopeChunk = {
        ...manifest,
        index,
        data: toBase64Url(serialized.slice(start, start + ENVELOPE_CHUNK_BYTES)),
      };
      this.ws.send(JSON.stringify({ type: "envelope-chunk", chunk }));
    }
  }

  ack(ids: string[]): void {
    if (!ids.length || !this.ws || this.ws.readyState !== this.WebSocketImpl.OPEN) return;
    this.ws.send(JSON.stringify({ type: "ack", ids }));
  }

  registerDevice(
    deviceId: string,
    authToken: string,
    expiresAt: number,
    options: DeviceRegistrationOptions = {},
  ): void {
    if (this.role !== "desktop") throw new Error("Only desktop hosts can register devices");
    if (!this.ws || this.stateValue !== "connected" || this.ws.readyState !== this.WebSocketImpl.OPEN) {
      throw new Error("Bridge is not connected");
    }
    this.ws.send(JSON.stringify({
      type: "device-register",
      deviceId,
      authToken,
      expiresAt,
      ...(options.migrate ? { migrate: true } : {}),
      ...(options.pairedAt !== undefined ? { pairedAt: options.pairedAt } : {}),
    }));
  }

  revokeDevice(deviceId: string): void {
    if (this.role !== "desktop") throw new Error("Only desktop hosts can revoke devices");
    if (!this.ws || this.stateValue !== "connected" || this.ws.readyState !== this.WebSocketImpl.OPEN) {
      throw new Error("Bridge is not connected");
    }
    this.ws.send(JSON.stringify({ type: "device-revoke", deviceId }));
  }

  registerPushToken(platform: "android" | "ios", pushToken: string): void {
    if (this.role !== "mobile") throw new Error("Only mobile clients can register push tokens");
    if (!this.ws || this.stateValue !== "connected" || this.ws.readyState !== this.WebSocketImpl.OPEN) {
      throw new Error("Bridge is not connected");
    }
    this.ws.send(JSON.stringify({ type: "push-register", platform, pushToken }));
  }

  ping(at = Date.now()): void {
    if (!this.ws || this.stateValue !== "connected" || this.ws.readyState !== this.WebSocketImpl.OPEN) return;
    this.ws.send(JSON.stringify({ type: "ping", at }));
  }

  onMessage(listener: MessageListener): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onState(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    listener(this.stateValue);
    return () => this.stateListeners.delete(listener);
  }

  onFrame(listener: FrameListener): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  private async handleMessage(raw: string): Promise<void> {
    let frame: ServerFrame;
    try {
      frame = parseServerFrame(raw);
    } catch {
      return;
    }
    for (const listener of this.frameListeners) listener(frame);
    if (frame.type === "ready") {
      this.reconnectAttempt = 0;
      this.setState("connected");
      return;
    }
    if (frame.type === "error") {
      if (
        frame.code === "AUTH_FAILED" ||
        frame.code === "ROOM_NOT_FOUND" ||
        frame.code === "DEVICE_REVOKED" ||
        frame.code === "PAIRING_EXPIRED"
      ) {
        this.stopped = true;
      }
      return;
    }
    if (frame.type === "chunk-missing") {
      const pending = this.missingChunkRequests.get(frame.transferId);
      if (pending) {
        clearTimeout(pending.timer);
        this.missingChunkRequests.delete(frame.transferId);
        pending.resolve(frame.indexes);
      }
      return;
    }
    if (frame.type === "envelope-chunk") {
      const envelope = await this.acceptChunk(frame.chunk);
      if (envelope) await this.deliverEnvelope(envelope);
      return;
    }
    if (frame.type !== "envelope") return;
    await this.deliverEnvelope(frame.envelope);
  }

  private async deliverEnvelope(envelope: EncryptedEnvelope): Promise<void> {
    if (this.deliveredIds.has(envelope.id)) {
      this.ack([envelope.id]);
      return;
    }
    try {
      const selectedCrypto = await this.resolveCrypto?.(envelope) ?? this.crypto;
      const decrypted = await selectedCrypto.decrypt(envelope);
      this.deliveredIds.add(envelope.id);
      if (this.deliveredIds.size > 2_048) {
        const oldest = this.deliveredIds.values().next().value as string | undefined;
        if (oldest) this.deliveredIds.delete(oldest);
      }
      for (const listener of this.messageListeners) listener(decrypted, envelope);
    } catch {
      // The relay cannot forge valid payloads. Invalid or cross-device ciphertext is ignored.
    }
  }

  private async acceptChunk(chunk: EncryptedEnvelopeChunk): Promise<EncryptedEnvelope | undefined> {
    this.pruneTransfers();
    let transfer = this.incomingTransfers.get(chunk.transferId);
    if (!transfer) {
      if (this.incomingTransfers.size >= 8) {
        const oldest = this.incomingTransfers.keys().next().value as string | undefined;
        if (oldest) this.incomingTransfers.delete(oldest);
      }
      transfer = {
        chunk,
        parts: new Array(chunk.total),
        received: 0,
        byteLength: 0,
      };
      this.incomingTransfers.set(chunk.transferId, transfer);
    }
    if (!sameChunkTransfer(transfer.chunk, chunk)) {
      this.incomingTransfers.delete(chunk.transferId);
      return undefined;
    }
    if (!transfer.parts[chunk.index]) {
      const part = fromBase64Url(chunk.data);
      transfer.parts[chunk.index] = part;
      transfer.received += 1;
      transfer.byteLength += part.byteLength;
    }
    if (transfer.received !== chunk.total) return undefined;
    this.incomingTransfers.delete(chunk.transferId);
    if (transfer.byteLength > 16 * 1024 * 1024) return undefined;
    const serialized = new Uint8Array(transfer.byteLength);
    let offset = 0;
    for (const part of transfer.parts) {
      if (!part) return undefined;
      serialized.set(part, offset);
      offset += part.byteLength;
    }
    const digest = toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", serialized)));
    if (digest !== chunk.sha256) return undefined;
    let envelope: unknown;
    try {
      envelope = JSON.parse(decodeUtf8(serialized));
    } catch {
      return undefined;
    }
    if (
      !isEncryptedEnvelope(envelope) ||
      envelope.id !== chunk.transferId ||
      envelope.roomId !== chunk.roomId ||
      envelope.from !== chunk.from ||
      envelope.fromDeviceId !== chunk.fromDeviceId ||
      envelope.to !== chunk.to ||
      envelope.toDeviceId !== chunk.toDeviceId ||
      envelope.sentAt !== chunk.sentAt ||
      envelope.expiresAt !== chunk.expiresAt
    ) return undefined;
    return envelope;
  }

  private pruneTransfers(): void {
    const now = Date.now();
    for (const [id, transfer] of this.incomingTransfers) {
      if (transfer.chunk.expiresAt <= now || now - transfer.chunk.sentAt > 24 * 60 * 60 * 1_000) {
        this.incomingTransfers.delete(id);
      }
    }
  }

  private queryMissingChunks(manifest: EnvelopeChunkManifest): Promise<number[] | undefined> {
    if (!this.ws || this.stateValue !== "connected" || this.ws.readyState !== this.WebSocketImpl.OPEN) {
      return Promise.reject(new Error("Bridge is not connected"));
    }
    const previous = this.missingChunkRequests.get(manifest.transferId);
    if (previous) {
      clearTimeout(previous.timer);
      previous.resolve(undefined);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.missingChunkRequests.delete(manifest.transferId);
        resolve(undefined);
      }, 2_000);
      this.missingChunkRequests.set(manifest.transferId, { resolve, timer });
      this.ws!.send(JSON.stringify({ type: "chunk-query", manifest }));
    });
  }

  private handleClose(): void {
    this.ws = undefined;
    if (this.stopped || !this.shouldReconnect) {
      this.setState("closed");
      return;
    }
    this.reconnectAttempt += 1;
    this.setState("reconnecting");
    const delay = Math.min(30_000, 750 * 2 ** Math.min(this.reconnectAttempt - 1, 5));
    const jitter = Math.floor(Math.random() * 400);
    this.reconnectTimer = setTimeout(() => this.connect(), delay + jitter);
  }

  private setState(state: SocketState): void {
    if (state === this.stateValue) return;
    this.stateValue = state;
    for (const listener of this.stateListeners) listener(state);
  }
}
