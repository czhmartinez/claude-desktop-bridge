import type { BridgeCrypto } from "./crypto.js";
import { relayPathForUrl } from "./endpoints.js";
import {
  BridgeSocket,
  type BridgeSocketOptions,
  type DeviceRegistrationOptions,
  type SendOptions,
  type SocketState,
} from "./socket.js";
import type {
  BridgePayload,
  DecryptedEnvelope,
  EncryptedEnvelope,
  MessageTarget,
  ServerFrame,
} from "./types.js";
import type {
  BridgeTransport,
  BridgeTransportMetrics,
  BridgeTransportPath,
} from "./transport.js";

const HEARTBEAT_INTERVAL_MS = 20_000;

export interface RelayTransportOptions extends BridgeSocketOptions {
  path?: Exclude<BridgeTransportPath, "direct">;
  heartbeatIntervalMs?: number;
}

type MessageListener = (message: DecryptedEnvelope, encrypted: EncryptedEnvelope) => void;
type StateListener = (state: SocketState) => void;
type FrameListener = (frame: ServerFrame) => void;
type ErrorListener = (error: Error) => void;
type MetricsListener = (metrics: BridgeTransportMetrics) => void;

export class RelayTransport implements BridgeTransport {
  readonly path: Exclude<BridgeTransportPath, "direct">;
  readonly endpoint: string;
  private readonly socket: BridgeSocket;
  private readonly heartbeatIntervalMs: number;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private rttValue: number | undefined;
  private lastConnectedAt: number | undefined;
  private lastError: string | undefined;
  private errorListeners = new Set<ErrorListener>();
  private metricsListeners = new Set<MetricsListener>();

  constructor(options: RelayTransportOptions) {
    this.path = options.path ?? relayPathForUrl(options.crypto.identity.relayUrl);
    this.endpoint = options.crypto.identity.relayUrl;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
    this.socket = new BridgeSocket(options);
    this.socket.onState((state) => {
      if (state === "connected") {
        this.lastConnectedAt = Date.now();
        this.startHeartbeat();
      } else if (state === "closed") {
        this.stopHeartbeat();
      }
      this.emitMetrics();
    });
    this.socket.onFrame((frame) => {
      if (frame.type === "pong") {
        this.rttValue = Math.max(0, Date.now() - frame.at);
        this.emitMetrics();
      } else if (frame.type === "error") {
        this.lastError = `${frame.code}: ${frame.message}`;
        const error = new Error(frame.message);
        error.name = frame.code;
        for (const listener of this.errorListeners) listener(error);
        this.emitMetrics();
      }
    });
  }

  get state(): SocketState {
    return this.socket.state;
  }

  get rttMs(): number | undefined {
    return this.rttValue;
  }

  connect(): void {
    this.socket.connect();
  }

  close(): void {
    this.stopHeartbeat();
    this.socket.close();
  }

  send(payload: BridgePayload, to: MessageTarget, options?: SendOptions): Promise<string> {
    return this.socket.send(payload, to, options);
  }

  sendEnvelope(envelope: EncryptedEnvelope): void {
    this.socket.sendEnvelope(envelope);
  }

  ack(ids: string[]): void {
    this.socket.ack(ids);
  }

  registerDevice(
    deviceId: string,
    authToken: string,
    expiresAt: number,
    options?: DeviceRegistrationOptions,
  ): void {
    this.socket.registerDevice(deviceId, authToken, expiresAt, options);
  }

  revokeDevice(deviceId: string): void {
    this.socket.revokeDevice(deviceId);
  }

  registerPushToken(platform: "android" | "ios", pushToken: string): void {
    this.socket.registerPushToken(platform, pushToken);
  }

  onMessage(listener: MessageListener): () => void {
    return this.socket.onMessage(listener);
  }

  onState(listener: StateListener): () => void {
    return this.socket.onState(listener);
  }

  onFrame(listener: FrameListener): () => void {
    return this.socket.onFrame(listener);
  }

  onError(listener: ErrorListener): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  onMetrics(listener: MetricsListener): () => void {
    this.metricsListeners.add(listener);
    listener(this.metrics());
    return () => this.metricsListeners.delete(listener);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.socket.ping();
    this.heartbeat = setInterval(() => this.socket.ping(), this.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }

  private metrics(): BridgeTransportMetrics {
    return {
      path: this.path,
      endpoint: this.endpoint,
      state: this.state,
      ...(this.rttValue !== undefined ? { rttMs: this.rttValue } : {}),
      ...(this.lastConnectedAt !== undefined ? { lastConnectedAt: this.lastConnectedAt } : {}),
      ...(this.lastError !== undefined ? { lastError: this.lastError } : {}),
    };
  }

  private emitMetrics(): void {
    const metrics = this.metrics();
    for (const listener of this.metricsListeners) listener(metrics);
  }
}
