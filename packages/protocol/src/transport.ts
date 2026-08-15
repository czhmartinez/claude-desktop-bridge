import { BridgeCrypto } from "./crypto.js";
import type { DeviceRegistrationOptions, SendOptions, SocketState } from "./socket.js";
import type {
  BridgePayload,
  DecryptedEnvelope,
  EncryptedEnvelope,
  MessageTarget,
  ServerFrame,
} from "./types.js";

export type BridgeTransportPath = "public-relay" | "lan-relay" | "direct";

export interface BridgeTransportMetrics {
  path: BridgeTransportPath;
  endpoint: string;
  state: SocketState;
  rttMs?: number;
  lastConnectedAt?: number;
  lastError?: string;
}

export interface BridgeTransport {
  readonly path: BridgeTransportPath;
  readonly endpoint: string;
  readonly state: SocketState;
  readonly rttMs: number | undefined;

  connect(): void;
  close(): void;
  send(payload: BridgePayload, to: MessageTarget, options?: SendOptions): Promise<string>;
  sendEnvelope(envelope: EncryptedEnvelope): Promise<void>;
  ack(ids: string[]): void;
  registerDevice(
    deviceId: string,
    authToken: string,
    expiresAt: number,
    options?: DeviceRegistrationOptions,
  ): void;
  revokeDevice(deviceId: string): void;
  registerPushToken(platform: "android" | "ios", pushToken: string): void;
  onMessage(
    listener: (message: DecryptedEnvelope, encrypted: EncryptedEnvelope) => void,
  ): () => void;
  onState(listener: (state: SocketState) => void): () => void;
  onFrame(listener: (frame: ServerFrame) => void): () => void;
  onError(listener: (error: Error) => void): () => void;
  onMetrics(listener: (metrics: BridgeTransportMetrics) => void): () => void;
}

export interface BridgeTransportCandidate {
  id: string;
  path: BridgeTransportPath;
  endpoint: string;
  priority: number;
  create(): BridgeTransport;
}

type MessageListener = Parameters<BridgeTransport["onMessage"]>[0];
type StateListener = Parameters<BridgeTransport["onState"]>[0];
type FrameListener = Parameters<BridgeTransport["onFrame"]>[0];
type ErrorListener = Parameters<BridgeTransport["onError"]>[0];
type MetricsListener = Parameters<BridgeTransport["onMetrics"]>[0];

const FAILOVER_ERROR_NAMES = new Set([
  "AUTH_FAILED",
  "ROOM_NOT_FOUND",
  "PAIRING_EXPIRED",
  "PAIRING_ALREADY_USED",
  "UPGRADE_REQUIRED",
]);

function unavailable(): never {
  throw new Error("Bridge transport is not connected");
}

export class TransportRouter implements BridgeTransport {
  private readonly candidates: BridgeTransportCandidate[];
  private active: BridgeTransport | undefined;
  private activeIndex = -1;
  private stopped = false;
  private messageListeners = new Set<MessageListener>();
  private stateListeners = new Set<StateListener>();
  private frameListeners = new Set<FrameListener>();
  private errorListeners = new Set<ErrorListener>();
  private metricsListeners = new Set<MetricsListener>();
  private detachActive: Array<() => void> = [];
  private candidateTimer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private cycleAttempt = 0;

  constructor(candidates: BridgeTransportCandidate[]) {
    if (candidates.length === 0) throw new Error("At least one transport candidate is required");
    this.candidates = [...candidates].sort((left, right) => left.priority - right.priority);
  }

  get path(): BridgeTransportPath {
    return this.active?.path ?? this.candidates[0]!.path;
  }

  get endpoint(): string {
    return this.active?.endpoint ?? this.candidates[0]!.endpoint;
  }

  get state(): SocketState {
    return this.active?.state ?? "idle";
  }

  get rttMs(): number | undefined {
    return this.active?.rttMs;
  }

  connect(): void {
    this.stopped = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.active && this.active.state !== "closed") {
      this.active.connect();
      return;
    }
    this.activate(0);
  }

  close(): void {
    this.stopped = true;
    this.clearTimers();
    this.detach();
    this.active?.close();
    this.active = undefined;
    this.activeIndex = -1;
    this.emitState("closed");
  }

  /**
   * Abandon the current candidate and move to the next one immediately,
   * keeping the router alive. Used by client-side watchdogs that can prove
   * the current path is dead or useless (half-dead uplink, wrong relay
   * namespace): close() would park the router until an outside reconnect.
   */
  cycle(): void {
    if (this.stopped) return;
    const active = this.active;
    if (!active) {
      this.activate(0);
      return;
    }
    // Closing the active transport makes its state listener advance the
    // router; clear the candidate timer so it cannot double-advance.
    this.clearCandidateTimer();
    active.close();
    if (this.active === active && active.state === "closed") {
      // Defensive: advance even if a transport swallowed its closed state.
      this.advance();
    }
  }

  send(payload: BridgePayload, to: MessageTarget, options?: SendOptions): Promise<string> {
    return this.active?.send(payload, to, options) ?? unavailable();
  }

  sendEnvelope(envelope: EncryptedEnvelope): Promise<void> {
    return (this.active ?? unavailable()).sendEnvelope(envelope);
  }

  ack(ids: string[]): void {
    this.active?.ack(ids);
  }

  registerDevice(
    deviceId: string,
    authToken: string,
    expiresAt: number,
    options?: DeviceRegistrationOptions,
  ): void {
    (this.active ?? unavailable()).registerDevice(deviceId, authToken, expiresAt, options);
  }

  revokeDevice(deviceId: string): void {
    (this.active ?? unavailable()).revokeDevice(deviceId);
  }

  registerPushToken(platform: "android" | "ios", pushToken: string): void {
    (this.active ?? unavailable()).registerPushToken(platform, pushToken);
  }

  onMessage(listener: MessageListener): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onState(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    listener(this.state);
    return () => this.stateListeners.delete(listener);
  }

  onFrame(listener: FrameListener): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  onError(listener: ErrorListener): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  onMetrics(listener: MetricsListener): () => void {
    this.metricsListeners.add(listener);
    if (this.active) {
      listener({
        path: this.active.path,
        endpoint: this.active.endpoint,
        state: this.active.state,
        ...(this.active.rttMs !== undefined ? { rttMs: this.active.rttMs } : {}),
      });
    }
    return () => this.metricsListeners.delete(listener);
  }

  private activate(index: number): void {
    this.clearCandidateTimer();
    this.detach();
    this.active?.close();
    this.activeIndex = index % this.candidates.length;
    const candidate = this.candidates[this.activeIndex]!;
    const transport = candidate.create();
    this.active = transport;
    this.detachActive = [
      transport.onMessage((message, encrypted) => {
        for (const listener of this.messageListeners) listener(message, encrypted);
      }),
      transport.onFrame((frame) => {
        if (transport !== this.active) return;
        if (
          frame.type === "error" &&
          FAILOVER_ERROR_NAMES.has(frame.code)
        ) {
          const isLastCandidate = this.activeIndex === this.candidates.length - 1;
          if (!isLastCandidate) {
            this.advance();
            return;
          }
        }
        for (const listener of this.frameListeners) listener(frame);
      }),
      transport.onError((error) => {
        for (const listener of this.errorListeners) listener(error);
      }),
      transport.onMetrics((metrics) => {
        for (const listener of this.metricsListeners) listener(metrics);
      }),
      transport.onState((state) => {
        this.emitState(state);
        if (state === "connected") {
          this.clearCandidateTimer();
          this.cycleAttempt = 0;
        }
        if (
          state === "closed" &&
          !this.stopped &&
          transport === this.active
        ) {
          this.advance();
        }
      }),
    ];
    transport.connect();
    this.candidateTimer = setTimeout(() => {
      if (
        this.stopped ||
        transport !== this.active ||
        transport.state === "connected"
      ) return;
      this.detach();
      transport.close();
      this.advance();
    }, 8_000);
  }

  private advance(): void {
    this.clearCandidateTimer();
    if (this.activeIndex + 1 < this.candidates.length) {
      this.activate(this.activeIndex + 1);
      return;
    }
    this.detach();
    this.active?.close();
    this.active = undefined;
    this.activeIndex = -1;
    this.cycleAttempt += 1;
    this.emitState("reconnecting");
    const delay = Math.min(30_000, 750 * 2 ** Math.min(this.cycleAttempt - 1, 5));
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (!this.stopped) this.activate(0);
    }, delay);
  }

  private detach(): void {
    for (const stop of this.detachActive.splice(0)) stop();
  }

  private clearCandidateTimer(): void {
    if (this.candidateTimer) clearTimeout(this.candidateTimer);
    this.candidateTimer = undefined;
  }

  private clearTimers(): void {
    this.clearCandidateTimer();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  private emitState(state: SocketState): void {
    for (const listener of this.stateListeners) listener(state);
  }
}

export function cryptoWithRelayEndpoint(crypto: BridgeCrypto, relayUrl: string): BridgeCrypto {
  return new BridgeCrypto({
    encryptionKey: crypto.encryptionKey,
    identity: { ...crypto.identity, relayUrl },
  });
}
