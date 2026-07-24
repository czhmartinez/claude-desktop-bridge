import { BridgeCrypto } from "./crypto.js";
import { decodeUtf8, fromBase64Url, randomId, toBase64Url, utf8 } from "./encoding.js";
import type { DeviceRegistrationOptions, SendOptions, SocketState } from "./socket.js";
import { MAX_ENVELOPE_CHUNKS } from "./types.js";
import type {
  BridgePayload,
  BridgePeerSignalPayload,
  BridgeRole,
  DecryptedEnvelope,
  EncryptedEnvelope,
  EncryptedEnvelopeChunk,
  EnvelopeChunkManifest,
  MessageTarget,
  ServerFrame,
} from "./types.js";
import { isEncryptedEnvelope, isEncryptedEnvelopeChunk } from "./validation.js";
import type {
  BridgeTransport,
  BridgeTransportMetrics,
  BridgeTransportPath,
} from "./transport.js";

const DIRECT_CHUNK_BYTES = 32 * 1024;
const DIRECT_BUFFER_HIGH_WATER = 512 * 1024;
const DIRECT_BUFFER_LOW_WATER = 128 * 1024;
const DIRECT_SIGNAL_TTL_MS = 60_000;
const DIRECT_ACK_TTL_MS = 5 * 60_000;
const DEFAULT_DIRECT_TIMEOUT_MS = 5_000;
const DEFAULT_RETRY_DELAY_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const HEARTBEAT_TIMEOUT_MS = 45_000;

type PeerRole = Extract<BridgeRole, "desktop" | "mobile">;
type PeerConnectionConstructor = new (configuration?: RTCConfiguration) => RTCPeerConnection;
type MessageListener = Parameters<BridgeTransport["onMessage"]>[0];
type StateListener = Parameters<BridgeTransport["onState"]>[0];
type FrameListener = Parameters<BridgeTransport["onFrame"]>[0];
type ErrorListener = Parameters<BridgeTransport["onError"]>[0];
type MetricsListener = Parameters<BridgeTransport["onMetrics"]>[0];
type PeerCandidate = NonNullable<BridgePeerSignalPayload["candidate"]>;

export interface WebRtcTransportOptions {
  relay: BridgeTransport;
  crypto: BridgeCrypto;
  role: PeerRole;
  RTCPeerConnectionImpl: PeerConnectionConstructor;
  iceServers?: RTCIceServer[];
  directTimeoutMs?: number;
  retryDelayMs?: number;
  resolveCrypto?: (
    envelope: EncryptedEnvelope,
  ) => BridgeCrypto | undefined | Promise<BridgeCrypto | undefined>;
  resolvePeerCrypto?: (
    deviceId: string,
  ) => BridgeCrypto | undefined | Promise<BridgeCrypto | undefined>;
}

interface PeerSession {
  deviceId: string;
  connectionId: string;
  initiator: boolean;
  pc: RTCPeerConnection;
  channel?: RTCDataChannel;
  remoteDescriptionReady: boolean;
  pendingCandidates: Array<RTCIceCandidateInit | null>;
  attemptTimer: ReturnType<typeof setTimeout> | undefined;
  disconnectTimer: ReturnType<typeof setTimeout> | undefined;
  heartbeat: ReturnType<typeof setInterval> | undefined;
  lastPongAt?: number;
  openedAt?: number;
  rttMs?: number;
  sendQueue: Promise<void>;
}

interface IncomingTransfer {
  chunk: EncryptedEnvelopeChunk;
  parts: Array<Uint8Array<ArrayBuffer> | undefined>;
  received: number;
  byteLength: number;
}

interface DirectRoute {
  deviceId: string;
  connectionId: string;
}

type DirectWireFrame =
  | { type: "envelope"; envelope: EncryptedEnvelope }
  | { type: "envelope-chunk"; chunk: EncryptedEnvelopeChunk }
  | { type: "ack"; ids: string[] }
  | { type: "ping"; at: number }
  | { type: "pong"; at: number };

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

function candidateInit(candidate: RTCIceCandidate): PeerCandidate {
  const value = candidate.toJSON();
  return {
    candidate: value.candidate ?? "",
    ...(value.sdpMid !== undefined ? { sdpMid: value.sdpMid } : {}),
    ...(value.sdpMLineIndex !== undefined ? { sdpMLineIndex: value.sdpMLineIndex } : {}),
    ...(value.usernameFragment !== undefined
      ? { usernameFragment: value.usernameFragment }
      : {}),
  };
}

function parseDirectFrame(raw: string): DirectWireFrame | undefined {
  if (raw.length > 800_000) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const frame = value as Record<string, unknown>;
  if (frame.type === "envelope" && isEncryptedEnvelope(frame.envelope)) {
    return { type: "envelope", envelope: frame.envelope };
  }
  if (frame.type === "envelope-chunk" && isEncryptedEnvelopeChunk(frame.chunk)) {
    return { type: "envelope-chunk", chunk: frame.chunk };
  }
  if (
    frame.type === "ack" &&
    Array.isArray(frame.ids) &&
    frame.ids.length <= 100 &&
    frame.ids.every((id) => typeof id === "string" && id.length <= 64)
  ) {
    return { type: "ack", ids: frame.ids as string[] };
  }
  if (
    (frame.type === "ping" || frame.type === "pong") &&
    typeof frame.at === "number" &&
    Number.isFinite(frame.at)
  ) {
    return { type: frame.type, at: frame.at };
  }
  return undefined;
}

function directMessageText(data: unknown): Promise<string | undefined> {
  if (typeof data === "string") return Promise.resolve(data);
  if (data instanceof ArrayBuffer) return Promise.resolve(decodeUtf8(data));
  if (ArrayBuffer.isView(data)) {
    return Promise.resolve(decodeUtf8(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)));
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return data.text().then((value) => value);
  }
  return Promise.resolve(undefined);
}

export function bridgeIceServers(serviceOrigin: string): RTCIceServer[] {
  try {
    const hostname = new URL(serviceOrigin).hostname;
    if (
      !hostname ||
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "[::1]"
    ) return [];
    return [{ urls: `stun:${hostname}:3478` }];
  } catch {
    return [];
  }
}

export class WebRtcTransport implements BridgeTransport {
  private readonly relay: BridgeTransport;
  private readonly crypto: BridgeCrypto;
  private readonly role: PeerRole;
  private readonly RTCPeerConnectionImpl: PeerConnectionConstructor;
  private readonly iceServers: RTCIceServer[];
  private readonly directTimeoutMs: number;
  private readonly retryDelayMs: number;
  private readonly resolveCrypto?: WebRtcTransportOptions["resolveCrypto"];
  private readonly resolvePeerCrypto?: WebRtcTransportOptions["resolvePeerCrypto"];
  private readonly peers = new Map<string, PeerSession>();
  private readonly knownDesktopDevices = new Set<string>();
  private readonly creatingPeers = new Set<string>();
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly orphanCandidates = new Map<string, Array<RTCIceCandidateInit | null>>();
  private readonly incomingTransfers = new Map<string, IncomingTransfer>();
  private readonly incomingRoutes = new Map<string, DirectRoute>();
  private readonly deliveredIds = new Set<string>();
  private readonly messageListeners = new Set<MessageListener>();
  private readonly stateListeners = new Set<StateListener>();
  private readonly frameListeners = new Set<FrameListener>();
  private readonly errorListeners = new Set<ErrorListener>();
  private readonly metricsListeners = new Set<MetricsListener>();
  private relayMetrics: BridgeTransportMetrics | undefined;
  private lastError: string | undefined;
  private lastState: SocketState = "idle";
  private stopped = false;

  constructor(options: WebRtcTransportOptions) {
    this.relay = options.relay;
    this.crypto = options.crypto;
    this.role = options.role;
    this.RTCPeerConnectionImpl = options.RTCPeerConnectionImpl;
    this.iceServers = options.iceServers ?? [];
    this.directTimeoutMs = options.directTimeoutMs ?? DEFAULT_DIRECT_TIMEOUT_MS;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.resolveCrypto = options.resolveCrypto;
    this.resolvePeerCrypto = options.resolvePeerCrypto;

    this.relay.onMessage((message, encrypted) => {
      void this.handleRelayMessage(message, encrypted).catch((error) => this.emitError(error));
    });
    this.relay.onFrame((frame) => {
      this.handleRelayFrame(frame);
      for (const listener of this.frameListeners) listener(frame);
    });
    this.relay.onError((error) => this.emitError(error));
    this.relay.onMetrics((metrics) => {
      this.relayMetrics = metrics;
      this.emitMetrics();
    });
    this.relay.onState(() => {
      this.emitState();
      this.emitMetrics();
      if (this.relay.state === "connected") this.initiateKnownDesktop();
    });
  }

  get path(): BridgeTransportPath {
    return this.openPeers().length > 0 ? "direct" : this.relay.path;
  }

  get endpoint(): string {
    return this.path === "direct" ? "webrtc://peer" : this.relay.endpoint;
  }

  get state(): SocketState {
    return this.openPeers().length > 0 ? "connected" : this.relay.state;
  }

  get rttMs(): number | undefined {
    const direct = this.openPeers().find((peer) => peer.rttMs !== undefined);
    return direct?.rttMs ?? this.relay.rttMs;
  }

  connect(): void {
    this.stopped = false;
    this.relay.connect();
    this.initiateKnownDesktop();
  }

  close(): void {
    this.stopped = true;
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    for (const deviceId of [...this.peers.keys()]) this.closePeer(deviceId, false);
    this.relay.close();
    this.emitState();
    this.emitMetrics();
  }

  async send(
    payload: BridgePayload,
    to: MessageTarget,
    options: SendOptions = {},
  ): Promise<string> {
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
    const peer = this.peerForEnvelope(envelope);
    if (!peer?.channel || peer.channel.readyState !== "open") {
      await this.relay.sendEnvelope(envelope);
      return;
    }
    const current = peer.sendQueue.then(() => this.sendDirectEnvelope(peer, envelope));
    peer.sendQueue = current.catch(() => undefined);
    try {
      await current;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.closePeer(peer.deviceId, true);
      await this.relay.sendEnvelope(envelope);
    }
  }

  ack(ids: string[]): void {
    if (ids.length === 0) return;
    const relayIds: string[] = [];
    const byPeer = new Map<string, { route: DirectRoute; ids: string[] }>();
    for (const id of ids) {
      const route = this.incomingRoutes.get(id);
      this.incomingRoutes.delete(id);
      if (!route) {
        relayIds.push(id);
        continue;
      }
      const current = byPeer.get(route.deviceId) ?? { route, ids: [] };
      current.ids.push(id);
      byPeer.set(route.deviceId, current);
    }
    if (relayIds.length > 0) this.relay.ack(relayIds);
    for (const { route, ids: peerIds } of byPeer.values()) {
      const peer = this.peers.get(route.deviceId);
      if (
        peer &&
        peer.connectionId === route.connectionId &&
        peer.channel?.readyState === "open"
      ) {
        void this.sendWire(peer.channel, { type: "ack", ids: peerIds }).catch(() => {
          void this.sendSignal(route.deviceId, {
            kind: "peer-signal",
            connectionId: route.connectionId,
            action: "ack",
            ids: peerIds,
          }).catch(() => undefined);
        });
      } else {
        void this.sendSignal(route.deviceId, {
          kind: "peer-signal",
          connectionId: route.connectionId,
          action: "ack",
          ids: peerIds,
        }).catch(() => undefined);
      }
    }
  }

  registerDevice(
    deviceId: string,
    authToken: string,
    expiresAt: number,
    options?: DeviceRegistrationOptions,
  ): void {
    this.relay.registerDevice(deviceId, authToken, expiresAt, options);
  }

  revokeDevice(deviceId: string): void {
    this.closePeer(deviceId, false);
    this.relay.revokeDevice(deviceId);
  }

  registerPushToken(platform: "android" | "ios", pushToken: string): void {
    this.relay.registerPushToken(platform, pushToken);
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
    listener(this.metrics());
    return () => this.metricsListeners.delete(listener);
  }

  private async handleRelayMessage(
    message: DecryptedEnvelope,
    encrypted: EncryptedEnvelope,
  ): Promise<void> {
    if (message.payload.kind === "peer-signal") {
      this.relay.ack([encrypted.id]);
      await this.handleSignal(message.header.fromDeviceId, message.payload);
      return;
    }
    if (this.deliveredIds.has(encrypted.id)) {
      this.relay.ack([encrypted.id]);
      return;
    }
    this.rememberDelivered(encrypted.id);
    this.incomingRoutes.delete(encrypted.id);
    for (const listener of this.messageListeners) listener(message, encrypted);
  }

  private handleRelayFrame(frame: ServerFrame): void {
    if (this.role !== "mobile") return;
    if (frame.type === "ready") {
      this.knownDesktopDevices.clear();
      for (const device of frame.onlineDevices) {
        if (device.role === "desktop") this.knownDesktopDevices.add(device.deviceId);
      }
      this.initiateKnownDesktop();
      return;
    }
    if (frame.type !== "presence" || frame.role !== "desktop") return;
    if (frame.online) {
      this.knownDesktopDevices.add(frame.deviceId);
      this.initiateKnownDesktop();
    } else {
      this.knownDesktopDevices.delete(frame.deviceId);
    }
  }

  private initiateKnownDesktop(): void {
    if (
      this.stopped ||
      this.role !== "mobile" ||
      this.relay.state !== "connected" ||
      this.openPeers().length > 0
    ) return;
    const deviceId = this.knownDesktopDevices.values().next().value as string | undefined;
    if (!deviceId || this.creatingPeers.has(deviceId) || this.peers.has(deviceId)) return;
    void this.initiate(deviceId).catch((error) => {
      this.emitError(error);
      this.scheduleRetry(deviceId);
    });
  }

  private async initiate(deviceId: string): Promise<void> {
    this.creatingPeers.add(deviceId);
    const connectionId = randomId(12);
    const peer = this.createPeer(deviceId, connectionId, true);
    try {
      const channel = peer.pc.createDataChannel("bridge-v2", {
        ordered: true,
        protocol: "bridge-envelope-v2",
      });
      this.bindChannel(peer, channel);
      const offer = await peer.pc.createOffer();
      await peer.pc.setLocalDescription(offer);
      await this.sendSignal(deviceId, {
        kind: "peer-signal",
        connectionId,
        action: "offer",
        description: { type: "offer", sdp: offer.sdp ?? "" },
      });
    } catch (error) {
      this.closePeer(deviceId, true);
      throw error;
    } finally {
      this.creatingPeers.delete(deviceId);
    }
  }

  private createPeer(
    deviceId: string,
    connectionId: string,
    initiator: boolean,
  ): PeerSession {
    this.closePeer(deviceId, false);
    const pc = new this.RTCPeerConnectionImpl({ iceServers: this.iceServers });
    const peer: PeerSession = {
      deviceId,
      connectionId,
      initiator,
      pc,
      remoteDescriptionReady: false,
      pendingCandidates: this.orphanCandidates.get(`${deviceId}:${connectionId}`) ?? [],
      attemptTimer: undefined,
      disconnectTimer: undefined,
      heartbeat: undefined,
      sendQueue: Promise.resolve(),
    };
    this.orphanCandidates.delete(`${deviceId}:${connectionId}`);
    this.peers.set(deviceId, peer);
    pc.onicecandidate = (event) => {
      const signal: BridgePeerSignalPayload = event.candidate
        ? {
            kind: "peer-signal",
            connectionId,
            action: "candidate",
            candidate: candidateInit(event.candidate),
          }
        : {
            kind: "peer-signal",
            connectionId,
            action: "end-of-candidates",
          };
      void this.sendSignal(deviceId, signal).catch((error) => this.emitError(error));
    };
    pc.ondatachannel = (event) => this.bindChannel(peer, event.channel);
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        this.closePeer(deviceId, true);
        return;
      }
      if (pc.connectionState === "disconnected") {
        if (peer.disconnectTimer) clearTimeout(peer.disconnectTimer);
        peer.disconnectTimer = setTimeout(() => {
          if (pc.connectionState === "disconnected") this.closePeer(deviceId, true);
        }, 3_000);
      } else if (peer.disconnectTimer) {
        clearTimeout(peer.disconnectTimer);
        peer.disconnectTimer = undefined;
      }
    };
    peer.attemptTimer = setTimeout(() => {
      if (peer.channel?.readyState !== "open") {
        this.lastError = "WebRTC direct connection timed out; using Relay";
        this.closePeer(deviceId, true);
      }
    }, this.directTimeoutMs);
    return peer;
  }

  private bindChannel(peer: PeerSession, channel: RTCDataChannel): void {
    if (peer.channel && peer.channel !== channel) peer.channel.close();
    peer.channel = channel;
    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold = DIRECT_BUFFER_LOW_WATER;
    channel.onopen = () => {
      if (this.peers.get(peer.deviceId) !== peer) {
        channel.close();
        return;
      }
      if (peer.attemptTimer) clearTimeout(peer.attemptTimer);
      peer.attemptTimer = undefined;
      peer.openedAt = Date.now();
      peer.lastPongAt = Date.now();
      this.lastError = undefined;
      this.clearRetry(peer.deviceId);
      this.startHeartbeat(peer);
      this.emitState();
      this.emitMetrics();
    };
    channel.onmessage = (event) => {
      void directMessageText(event.data)
        .then((raw) => {
          if (raw !== undefined) return this.handleDirectFrame(peer, raw);
          return undefined;
        })
        .catch((error) => this.emitError(error));
    };
    channel.onerror = () => {
      this.lastError = "WebRTC data channel failed; using Relay";
      this.emitMetrics();
    };
    channel.onclose = () => {
      if (this.peers.get(peer.deviceId) === peer) this.closePeer(peer.deviceId, true);
    };
  }

  private async handleSignal(
    deviceId: string,
    signal: BridgePeerSignalPayload,
  ): Promise<void> {
    if (signal.action === "ack") {
      if (signal.ids?.length) {
        const frame: ServerFrame = {
          type: "acknowledged",
          ids: signal.ids,
          byDeviceId: deviceId,
        };
        for (const listener of this.frameListeners) listener(frame);
      }
      return;
    }
    if (signal.action === "bye") {
      const current = this.peers.get(deviceId);
      if (current?.connectionId === signal.connectionId) this.closePeer(deviceId, true);
      return;
    }
    if (signal.action === "offer") {
      if (this.role !== "desktop" || !signal.description) return;
      const peer = this.createPeer(deviceId, signal.connectionId, false);
      try {
        await peer.pc.setRemoteDescription(signal.description);
        peer.remoteDescriptionReady = true;
        await this.flushCandidates(peer);
        const answer = await peer.pc.createAnswer();
        await peer.pc.setLocalDescription(answer);
        await this.sendSignal(deviceId, {
          kind: "peer-signal",
          connectionId: signal.connectionId,
          action: "answer",
          description: { type: "answer", sdp: answer.sdp ?? "" },
        });
      } catch (error) {
        this.closePeer(deviceId, true);
        throw error;
      }
      return;
    }
    const peer = this.peers.get(deviceId);
    if (!peer || peer.connectionId !== signal.connectionId) {
      if (signal.action === "candidate" || signal.action === "end-of-candidates") {
        const key = `${deviceId}:${signal.connectionId}`;
        const pending = this.orphanCandidates.get(key) ?? [];
        pending.push(signal.action === "candidate" ? signal.candidate ?? null : null);
        this.orphanCandidates.set(key, pending.slice(-64));
      }
      return;
    }
    if (signal.action === "answer") {
      if (this.role !== "mobile" || !signal.description) return;
      await peer.pc.setRemoteDescription(signal.description);
      peer.remoteDescriptionReady = true;
      await this.flushCandidates(peer);
      return;
    }
    if (signal.action === "candidate" || signal.action === "end-of-candidates") {
      peer.pendingCandidates.push(
        signal.action === "candidate" ? signal.candidate ?? null : null,
      );
      if (peer.remoteDescriptionReady) await this.flushCandidates(peer);
    }
  }

  private async flushCandidates(peer: PeerSession): Promise<void> {
    for (const candidate of peer.pendingCandidates.splice(0)) {
      await peer.pc.addIceCandidate(candidate);
    }
  }

  private async sendSignal(
    deviceId: string,
    payload: BridgePeerSignalPayload,
  ): Promise<void> {
    if (this.relay.state !== "connected") throw new Error("Relay signaling is unavailable");
    const selectedCrypto = this.role === "desktop"
      ? await this.resolvePeerCrypto?.(deviceId)
      : this.crypto;
    if (!selectedCrypto) throw new Error("Peer key is unavailable");
    await this.relay.send(
      payload,
      this.role === "desktop" ? "mobile" : "desktop",
      {
        toDeviceId: deviceId,
        crypto: selectedCrypto,
        ttlMs: payload.action === "ack" ? DIRECT_ACK_TTL_MS : DIRECT_SIGNAL_TTL_MS,
      },
    );
  }

  private peerForEnvelope(envelope: EncryptedEnvelope): PeerSession | undefined {
    if (envelope.to === this.role) return undefined;
    if (this.role === "desktop") {
      if (!envelope.toDeviceId) return undefined;
      const peer = this.peers.get(envelope.toDeviceId);
      return peer?.channel?.readyState === "open" ? peer : undefined;
    }
    return this.openPeers()[0];
  }

  private async sendDirectEnvelope(
    peer: PeerSession,
    envelope: EncryptedEnvelope,
  ): Promise<void> {
    const channel = peer.channel;
    if (!channel || channel.readyState !== "open") throw new Error("Direct channel is unavailable");
    const serialized = utf8(JSON.stringify(envelope));
    if (serialized.byteLength <= DIRECT_CHUNK_BYTES) {
      await this.sendWire(channel, { type: "envelope", envelope });
      return;
    }
    const digest = toBase64Url(
      new Uint8Array(await crypto.subtle.digest("SHA-256", serialized)),
    );
    const total = Math.ceil(serialized.byteLength / DIRECT_CHUNK_BYTES);
    if (total > MAX_ENVELOPE_CHUNKS) {
      throw new Error("Encrypted envelope is too large for the direct channel");
    }
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
    for (let index = 0; index < total; index += 1) {
      if (channel.readyState !== "open") throw new Error("Direct channel closed during transfer");
      const start = index * DIRECT_CHUNK_BYTES;
      await this.sendWire(channel, {
        type: "envelope-chunk",
        chunk: {
          ...manifest,
          index,
          data: toBase64Url(serialized.slice(start, start + DIRECT_CHUNK_BYTES)),
        },
      });
    }
  }

  private async sendWire(channel: RTCDataChannel, frame: DirectWireFrame): Promise<void> {
    if (channel.readyState !== "open") throw new Error("Direct channel is unavailable");
    if (channel.bufferedAmount > DIRECT_BUFFER_HIGH_WATER) {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          channel.removeEventListener("bufferedamountlow", drained);
          reject(new Error("Direct channel backpressure timed out"));
        }, 5_000);
        const drained = () => {
          clearTimeout(timeout);
          channel.removeEventListener("bufferedamountlow", drained);
          resolve();
        };
        channel.addEventListener("bufferedamountlow", drained, { once: true });
      });
    }
    channel.send(JSON.stringify(frame));
  }

  private async handleDirectFrame(peer: PeerSession, raw: string): Promise<void> {
    if (this.peers.get(peer.deviceId) !== peer) return;
    const frame = parseDirectFrame(raw);
    if (!frame) return;
    if (frame.type === "ping") {
      if (peer.channel?.readyState === "open") {
        await this.sendWire(peer.channel, { type: "pong", at: frame.at });
      }
      return;
    }
    if (frame.type === "pong") {
      peer.lastPongAt = Date.now();
      peer.rttMs = Math.max(0, Date.now() - frame.at);
      this.emitMetrics();
      return;
    }
    if (frame.type === "ack") {
      const acknowledged: ServerFrame = {
        type: "acknowledged",
        ids: frame.ids,
        byDeviceId: peer.deviceId,
      };
      for (const listener of this.frameListeners) listener(acknowledged);
      return;
    }
    if (frame.type === "envelope-chunk") {
      const envelope = await this.acceptChunk(peer, frame.chunk);
      if (envelope) await this.deliverDirectEnvelope(peer, envelope);
      return;
    }
    await this.deliverDirectEnvelope(peer, frame.envelope);
  }

  private async deliverDirectEnvelope(
    peer: PeerSession,
    envelope: EncryptedEnvelope,
  ): Promise<void> {
    if (
      envelope.roomId !== this.crypto.identity.roomId ||
      envelope.fromDeviceId !== peer.deviceId ||
      envelope.to !== this.role
    ) return;
    if (this.deliveredIds.has(envelope.id)) {
      if (peer.channel?.readyState === "open") {
        await this.sendWire(peer.channel, { type: "ack", ids: [envelope.id] });
      }
      return;
    }
    try {
      const selectedCrypto = await this.resolveCrypto?.(envelope) ?? this.crypto;
      const decrypted = await selectedCrypto.decrypt(envelope);
      if (decrypted.payload.kind === "peer-signal") return;
      this.rememberDelivered(envelope.id);
      this.incomingRoutes.set(envelope.id, {
        deviceId: peer.deviceId,
        connectionId: peer.connectionId,
      });
      for (const listener of this.messageListeners) listener(decrypted, envelope);
    } catch {
      // Invalid ciphertext cannot be turned into an application event.
    }
  }

  private async acceptChunk(
    peer: PeerSession,
    chunk: EncryptedEnvelopeChunk,
  ): Promise<EncryptedEnvelope | undefined> {
    if (chunk.fromDeviceId !== peer.deviceId || chunk.to !== this.role) return undefined;
    this.pruneTransfers();
    const key = `${peer.deviceId}:${chunk.transferId}`;
    let transfer = this.incomingTransfers.get(key);
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
      this.incomingTransfers.set(key, transfer);
    }
    if (!sameChunkTransfer(transfer.chunk, chunk)) {
      this.incomingTransfers.delete(key);
      return undefined;
    }
    if (!transfer.parts[chunk.index]) {
      const part = fromBase64Url(chunk.data);
      transfer.parts[chunk.index] = part;
      transfer.received += 1;
      transfer.byteLength += part.byteLength;
    }
    if (transfer.received !== chunk.total) return undefined;
    this.incomingTransfers.delete(key);
    if (transfer.byteLength > 16 * 1024 * 1024) return undefined;
    const serialized = new Uint8Array(transfer.byteLength);
    let offset = 0;
    for (const part of transfer.parts) {
      if (!part) return undefined;
      serialized.set(part, offset);
      offset += part.byteLength;
    }
    const digest = toBase64Url(
      new Uint8Array(await crypto.subtle.digest("SHA-256", serialized)),
    );
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
      if (
        transfer.chunk.expiresAt <= now ||
        now - transfer.chunk.sentAt > 24 * 60 * 60 * 1_000
      ) {
        this.incomingTransfers.delete(id);
      }
    }
  }

  private startHeartbeat(peer: PeerSession): void {
    if (peer.heartbeat) clearInterval(peer.heartbeat);
    peer.heartbeat = setInterval(() => {
      if (Date.now() - (peer.lastPongAt ?? 0) > HEARTBEAT_TIMEOUT_MS) {
        this.lastError = "WebRTC heartbeat timed out; using Relay";
        this.closePeer(peer.deviceId, true);
        return;
      }
      if (peer.channel?.readyState === "open") {
        void this.sendWire(peer.channel, { type: "ping", at: Date.now() })
          .catch(() => this.closePeer(peer.deviceId, true));
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private closePeer(deviceId: string, retry: boolean): void {
    const peer = this.peers.get(deviceId);
    if (!peer) {
      if (retry) this.scheduleRetry(deviceId);
      return;
    }
    this.peers.delete(deviceId);
    if (peer.attemptTimer) clearTimeout(peer.attemptTimer);
    if (peer.disconnectTimer) clearTimeout(peer.disconnectTimer);
    if (peer.heartbeat) clearInterval(peer.heartbeat);
    if (peer.channel) {
      peer.channel.onopen = null;
      peer.channel.onmessage = null;
      peer.channel.onerror = null;
      peer.channel.onclose = null;
    }
    peer.pc.onicecandidate = null;
    peer.pc.ondatachannel = null;
    peer.pc.onconnectionstatechange = null;
    peer.channel?.close();
    peer.pc.close();
    this.emitState();
    this.emitMetrics();
    if (retry) this.scheduleRetry(deviceId);
  }

  private scheduleRetry(deviceId: string): void {
    if (
      this.stopped ||
      this.role !== "mobile" ||
      !this.knownDesktopDevices.has(deviceId) ||
      this.retryTimers.has(deviceId)
    ) return;
    const timer = setTimeout(() => {
      this.retryTimers.delete(deviceId);
      this.initiateKnownDesktop();
    }, this.retryDelayMs);
    this.retryTimers.set(deviceId, timer);
  }

  private clearRetry(deviceId: string): void {
    const timer = this.retryTimers.get(deviceId);
    if (timer) clearTimeout(timer);
    this.retryTimers.delete(deviceId);
  }

  private openPeers(): PeerSession[] {
    return [...this.peers.values()].filter((peer) => peer.channel?.readyState === "open");
  }

  private rememberDelivered(id: string): void {
    this.deliveredIds.add(id);
    if (this.deliveredIds.size <= 2_048) return;
    const oldest = this.deliveredIds.values().next().value as string | undefined;
    if (oldest) {
      this.deliveredIds.delete(oldest);
      this.incomingRoutes.delete(oldest);
    }
  }

  private metrics(): BridgeTransportMetrics {
    const direct = this.openPeers()[0];
    if (direct) {
      return {
        path: "direct",
        endpoint: "webrtc://peer",
        state: "connected",
        ...(direct.rttMs !== undefined ? { rttMs: direct.rttMs } : {}),
        ...(direct.openedAt !== undefined ? { lastConnectedAt: direct.openedAt } : {}),
        ...(this.lastError !== undefined ? { lastError: this.lastError } : {}),
      };
    }
    return {
      path: this.relay.path,
      endpoint: this.relay.endpoint,
      state: this.relay.state,
      ...(this.relayMetrics?.rttMs !== undefined ? { rttMs: this.relayMetrics.rttMs } : {}),
      ...(this.relayMetrics?.lastConnectedAt !== undefined
        ? { lastConnectedAt: this.relayMetrics.lastConnectedAt }
        : {}),
      ...(this.lastError !== undefined
        ? { lastError: this.lastError }
        : this.relayMetrics?.lastError !== undefined
          ? { lastError: this.relayMetrics.lastError }
          : {}),
    };
  }

  private emitState(): void {
    const state = this.state;
    if (state === this.lastState) return;
    this.lastState = state;
    for (const listener of this.stateListeners) listener(state);
  }

  private emitMetrics(): void {
    const metrics = this.metrics();
    for (const listener of this.metricsListeners) listener(metrics);
  }

  private emitError(error: unknown): void {
    const normalized = error instanceof Error ? error : new Error(String(error));
    this.lastError = normalized.message;
    for (const listener of this.errorListeners) listener(normalized);
    this.emitMetrics();
  }
}
