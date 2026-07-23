import { BridgeCrypto } from "./crypto.js";
import { parseServerFrame } from "./validation.js";
import {
  PROTOCOL_VERSION,
  type BridgePayload,
  type BridgeRole,
  type DecryptedEnvelope,
  type EncryptedEnvelope,
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

type MessageListener = (message: DecryptedEnvelope, encrypted: EncryptedEnvelope) => void;
type StateListener = (state: SocketState) => void;
type FrameListener = (frame: ServerFrame) => void;

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
    this.sendEnvelope(envelope);
    return envelope.id;
  }

  sendEnvelope(envelope: EncryptedEnvelope): void {
    if (!this.ws || this.stateValue !== "connected" || this.ws.readyState !== this.WebSocketImpl.OPEN) {
      throw new Error("Bridge is not connected");
    }
    this.ws.send(JSON.stringify({ type: "envelope", envelope }));
  }

  ack(ids: string[]): void {
    if (!ids.length || !this.ws || this.ws.readyState !== this.WebSocketImpl.OPEN) return;
    this.ws.send(JSON.stringify({ type: "ack", ids }));
  }

  registerDevice(deviceId: string, authToken: string, expiresAt: number): void {
    if (this.role !== "desktop") throw new Error("Only desktop hosts can register devices");
    if (!this.ws || this.stateValue !== "connected" || this.ws.readyState !== this.WebSocketImpl.OPEN) {
      throw new Error("Bridge is not connected");
    }
    this.ws.send(JSON.stringify({ type: "device-register", deviceId, authToken, expiresAt }));
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
    if (frame.type !== "envelope") return;
    try {
      const selectedCrypto = await this.resolveCrypto?.(frame.envelope) ?? this.crypto;
      const decrypted = await selectedCrypto.decrypt(frame.envelope);
      for (const listener of this.messageListeners) listener(decrypted, frame.envelope);
    } catch {
      // The relay cannot forge valid payloads. Invalid or cross-device ciphertext is ignored.
    }
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
