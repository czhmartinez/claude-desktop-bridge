import { beforeEach, describe, expect, it } from "vitest";
import {
  BridgeCrypto,
  WebRtcTransport,
  bridgeIceServers,
  parseBridgeIceServers,
  type BridgePayload,
  type BridgeTransport,
  type BridgeTransportMetrics,
  type DecryptedEnvelope,
  type EncryptedEnvelope,
  type MessageTarget,
  type SendOptions,
  type ServerFrame,
  type SocketState,
} from "./index.js";

class FakeDataChannel extends EventTarget {
  static instances: FakeDataChannel[] = [];
  readyState: RTCDataChannelState = "connecting";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  binaryType: BinaryType = "arraybuffer";
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  peer: FakeDataChannel | undefined;

  constructor() {
    super();
    FakeDataChannel.instances.push(this);
  }

  send(data: string): void {
    if (this.readyState !== "open" || !this.peer) throw new Error("channel closed");
    const target = this.peer;
    queueMicrotask(() => {
      if (target.readyState === "open") {
        target.onmessage?.(new MessageEvent("message", { data }));
      }
    });
  }

  open(): void {
    this.readyState = "open";
    this.onopen?.(new Event("open"));
  }

  close(): void {
    this.closeInternal(true);
  }

  private closeInternal(propagate: boolean): void {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.onclose?.(new Event("close"));
    if (propagate) this.peer?.closeInternal(false);
  }
}

class FakePeerConnection {
  static peers = new Map<string, FakePeerConnection>();
  static sequence = 0;
  static connectChannels = true;

  readonly id = `peer-${++FakePeerConnection.sequence}`;
  connectionState: RTCPeerConnectionState = "new";
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
  ondatachannel: ((event: RTCDataChannelEvent) => void) | null = null;
  onconnectionstatechange: ((event: Event) => void) | null = null;
  localChannel: FakeDataChannel | undefined;
  remoteCaller: FakePeerConnection | undefined;

  constructor(_configuration?: RTCConfiguration) {
    FakePeerConnection.peers.set(this.id, this);
  }

  createDataChannel(): RTCDataChannel {
    this.localChannel = new FakeDataChannel();
    return this.localChannel as unknown as RTCDataChannel;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: "offer", sdp: `offer:${this.id}` };
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: "answer", sdp: `answer:${this.id}:${this.remoteCaller?.id ?? ""}` };
  }

  async setLocalDescription(_description: RTCSessionDescriptionInit): Promise<void> {}

  async setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    const parts = description.sdp?.split(":") ?? [];
    if (description.type === "offer") {
      this.remoteCaller = FakePeerConnection.peers.get(parts[1] ?? "");
      return;
    }
    if (description.type !== "answer" || !FakePeerConnection.connectChannels) return;
    const responder = FakePeerConnection.peers.get(parts[1] ?? "");
    if (!responder || !this.localChannel) return;
    const remoteChannel = new FakeDataChannel();
    this.localChannel.peer = remoteChannel;
    remoteChannel.peer = this.localChannel;
    responder.ondatachannel?.({
      channel: remoteChannel as unknown as RTCDataChannel,
    } as RTCDataChannelEvent);
    this.connectionState = "connected";
    responder.connectionState = "connected";
    this.onconnectionstatechange?.(new Event("connectionstatechange"));
    responder.onconnectionstatechange?.(new Event("connectionstatechange"));
    remoteChannel.open();
    this.localChannel.open();
  }

  async addIceCandidate(_candidate?: RTCIceCandidateInit | null): Promise<void> {}

  close(): void {
    if (this.connectionState === "closed") return;
    this.connectionState = "closed";
    this.localChannel?.close();
    this.onconnectionstatechange?.(new Event("connectionstatechange"));
    FakePeerConnection.peers.delete(this.id);
  }
}

interface RelayEndpoint {
  transport: MemoryRelayTransport;
  role: "desktop" | "mobile";
  deviceId: string;
}

class MemoryRelayNetwork {
  endpoints = new Map<string, RelayEndpoint>();
  sources = new Map<string, RelayEndpoint>();
  signalIds = new Set<string>();
  businessEnvelopeCount = 0;

  connect(endpoint: RelayEndpoint): void {
    this.endpoints.set(endpoint.deviceId, endpoint);
    endpoint.transport.emitFrame({
      type: "ready",
      connectionId: `connection:${endpoint.deviceId}`,
      queued: 0,
      online: [...new Set([...this.endpoints.values()].map((value) => value.role))],
      onlineDevices: [...this.endpoints.values()].map((value) => ({
        role: value.role,
        deviceId: value.deviceId,
      })),
    });
    for (const other of this.endpoints.values()) {
      if (other === endpoint) continue;
      other.transport.emitFrame({
        type: "presence",
        role: endpoint.role,
        deviceId: endpoint.deviceId,
        online: true,
      });
      endpoint.transport.emitFrame({
        type: "presence",
        role: other.role,
        deviceId: other.deviceId,
        online: true,
      });
    }
  }

  disconnect(endpoint: RelayEndpoint): void {
    this.endpoints.delete(endpoint.deviceId);
    for (const other of this.endpoints.values()) {
      other.transport.emitFrame({
        type: "presence",
        role: endpoint.role,
        deviceId: endpoint.deviceId,
        online: false,
      });
    }
  }

  async deliver(source: RelayEndpoint, envelope: EncryptedEnvelope): Promise<void> {
    this.sources.set(envelope.id, source);
    if (!this.signalIds.delete(envelope.id)) this.businessEnvelopeCount += 1;
    const targets = [...this.endpoints.values()].filter((endpoint) => (
      endpoint.role === envelope.to &&
      (!envelope.toDeviceId || envelope.toDeviceId === endpoint.deviceId)
    ));
    for (const target of targets) await target.transport.receive(envelope);
  }

  acknowledge(source: RelayEndpoint, ids: string[]): void {
    for (const id of ids) {
      const sender = this.sources.get(id);
      sender?.transport.emitFrame({
        type: "acknowledged",
        ids: [id],
        byDeviceId: source.deviceId,
      });
    }
  }
}

class MemoryRelayTransport implements BridgeTransport {
  readonly path = "public-relay" as const;
  readonly endpoint = "wss://relay.example/ws";
  state: SocketState = "idle";
  rttMs = 5;
  private readonly endpointInfo: RelayEndpoint;
  private readonly messageListeners = new Set<
    (message: DecryptedEnvelope, encrypted: EncryptedEnvelope) => void
  >();
  private readonly stateListeners = new Set<(state: SocketState) => void>();
  private readonly frameListeners = new Set<(frame: ServerFrame) => void>();
  private readonly metricsListeners = new Set<(metrics: BridgeTransportMetrics) => void>();

  constructor(
    private readonly network: MemoryRelayNetwork,
    private readonly crypto: BridgeCrypto,
    private readonly role: "desktop" | "mobile",
    private readonly resolveCrypto?: (envelope: EncryptedEnvelope) => BridgeCrypto | undefined,
  ) {
    this.endpointInfo = {
      transport: this,
      role,
      deviceId: crypto.identity.deviceId,
    };
  }

  connect(): void {
    this.setState("connected");
    this.network.connect(this.endpointInfo);
  }

  close(): void {
    this.network.disconnect(this.endpointInfo);
    this.setState("closed");
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
    if (payload.kind === "peer-signal") this.network.signalIds.add(envelope.id);
    await this.sendEnvelope(envelope);
    return envelope.id;
  }

  async sendEnvelope(envelope: EncryptedEnvelope): Promise<void> {
    await this.network.deliver(this.endpointInfo, envelope);
  }

  ack(ids: string[]): void {
    this.network.acknowledge(this.endpointInfo, ids);
  }

  registerDevice(): void {}
  revokeDevice(): void {}
  registerPushToken(): void {}

  onMessage(
    listener: (message: DecryptedEnvelope, encrypted: EncryptedEnvelope) => void,
  ): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onState(listener: (state: SocketState) => void): () => void {
    this.stateListeners.add(listener);
    listener(this.state);
    return () => this.stateListeners.delete(listener);
  }

  onFrame(listener: (frame: ServerFrame) => void): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  onError(): () => void {
    return () => undefined;
  }

  onMetrics(listener: (metrics: BridgeTransportMetrics) => void): () => void {
    this.metricsListeners.add(listener);
    listener({
      path: this.path,
      endpoint: this.endpoint,
      state: this.state,
      rttMs: this.rttMs,
    });
    return () => this.metricsListeners.delete(listener);
  }

  async receive(envelope: EncryptedEnvelope): Promise<void> {
    const selectedCrypto = this.resolveCrypto?.(envelope) ?? this.crypto;
    const message = await selectedCrypto.decrypt(envelope);
    for (const listener of this.messageListeners) listener(message, envelope);
  }

  emitFrame(frame: ServerFrame): void {
    for (const listener of this.frameListeners) listener(frame);
  }

  private setState(state: SocketState): void {
    this.state = state;
    for (const listener of this.stateListeners) listener(state);
    const metrics = {
      path: this.path,
      endpoint: this.endpoint,
      state,
      rttMs: this.rttMs,
    } satisfies BridgeTransportMetrics;
    for (const listener of this.metricsListeners) listener(metrics);
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function transportPair(directTimeoutMs = 100) {
  const host = await BridgeCrypto.createHost("wss://relay.example/ws", "Mac");
  const paired = await BridgeCrypto.createDevicePairing({
    roomId: host.crypto.identity.roomId,
    relayUrl: host.crypto.identity.relayUrl,
    desktopName: host.crypto.identity.desktopName,
  });
  const desktopDeviceCrypto = paired.desktopCrypto.withSenderDevice(
    host.crypto.identity.deviceId,
  );
  const mobileCrypto = await BridgeCrypto.fromPairing(paired.pairing);
  const network = new MemoryRelayNetwork();
  const desktopRelay = new MemoryRelayTransport(
    network,
    host.crypto,
    "desktop",
    () => desktopDeviceCrypto,
  );
  const mobileRelay = new MemoryRelayTransport(network, mobileCrypto, "mobile");
  const PeerConnection = FakePeerConnection as unknown as typeof RTCPeerConnection;
  const desktop = new WebRtcTransport({
    relay: desktopRelay,
    crypto: host.crypto,
    role: "desktop",
    RTCPeerConnectionImpl: PeerConnection,
    directTimeoutMs,
    retryDelayMs: 50,
    resolveCrypto: () => desktopDeviceCrypto,
    resolvePeerCrypto: () => desktopDeviceCrypto,
  });
  const mobile = new WebRtcTransport({
    relay: mobileRelay,
    crypto: mobileCrypto,
    role: "mobile",
    RTCPeerConnectionImpl: PeerConnection,
    directTimeoutMs,
    retryDelayMs: 50,
  });
  return { desktop, mobile, network };
}

describe("WebRtcTransport", () => {
  beforeEach(() => {
    FakePeerConnection.peers.clear();
    FakePeerConnection.sequence = 0;
    FakePeerConnection.connectChannels = true;
    FakeDataChannel.instances = [];
  });

  it("upgrades to a direct encrypted channel and acknowledges without relaying payloads", async () => {
    const { desktop, mobile, network } = await transportPair();
    const received: Array<{ message: DecryptedEnvelope; encrypted: EncryptedEnvelope }> = [];
    const mobileFrames: ServerFrame[] = [];
    desktop.onMessage((message, encrypted) => received.push({ message, encrypted }));
    mobile.onFrame((frame) => mobileFrames.push(frame));

    desktop.connect();
    mobile.connect();
    await waitFor(() => desktop.path === "direct" && mobile.path === "direct");

    const payload: BridgePayload = {
      kind: "request",
      requestId: "request-direct",
      idempotencyKey: "request-direct",
      method: "turn.start",
      params: { sessionId: "session-1", text: "x".repeat(180_000) },
    };
    const id = await mobile.send(payload, "desktop");
    await waitFor(() => received.length === 1);
    desktop.ack([received[0]!.encrypted.id]);
    await waitFor(() => mobileFrames.some((frame) => (
      frame.type === "acknowledged" && frame.ids.includes(id)
    )));

    expect(received[0]!.message.payload).toEqual(payload);
    expect(network.businessEnvelopeCount).toBe(0);
    expect(mobile.endpoint).toBe("webrtc://peer");
    desktop.close();
    mobile.close();
  });

  it("keeps Relay as the data path when ICE does not connect within five seconds", async () => {
    FakePeerConnection.connectChannels = false;
    const { desktop, mobile, network } = await transportPair(20);
    const received: DecryptedEnvelope[] = [];
    desktop.onMessage((message) => received.push(message));

    desktop.connect();
    mobile.connect();
    await new Promise((resolve) => setTimeout(resolve, 40));

    const payload: BridgePayload = {
      kind: "request",
      requestId: "request-fallback",
      idempotencyKey: "request-fallback",
      method: "project.list",
      params: {},
    };
    await mobile.send(payload, "desktop");
    await waitFor(() => received.length === 1);

    expect(mobile.path).toBe("public-relay");
    expect(received[0]!.payload).toEqual(payload);
    expect(network.businessEnvelopeCount).toBe(1);
    desktop.close();
    mobile.close();
  });

  it("returns a direct acknowledgement through encrypted signaling after the channel drops", async () => {
    const { desktop, mobile } = await transportPair();
    const received: EncryptedEnvelope[] = [];
    const frames: ServerFrame[] = [];
    desktop.onMessage((_message, encrypted) => received.push(encrypted));
    mobile.onFrame((frame) => frames.push(frame));

    desktop.connect();
    mobile.connect();
    await waitFor(() => mobile.path === "direct");
    const id = await mobile.send({
      kind: "request",
      requestId: "request-ack-fallback",
      idempotencyKey: "request-ack-fallback",
      method: "project.list",
      params: {},
    }, "desktop");
    await waitFor(() => received.length === 1);

    FakeDataChannel.instances.find((channel) => channel.readyState === "open")?.close();
    await waitFor(() => mobile.path === "public-relay");
    desktop.ack([received[0]!.id]);
    await waitFor(() => frames.some((frame) => (
      frame.type === "acknowledged" && frame.ids.includes(id)
    )));

    desktop.close();
    mobile.close();
  });

  it("uses explicit ICE servers without deriving them from the Relay hostname", () => {
    const configured = parseBridgeIceServers(JSON.stringify([
      { urls: "stun:stun.cloudflare.com:3478" },
      {
        urls: ["turns:turn.example.com:443?transport=tcp"],
        username: "short-lived-user",
        credential: "short-lived-credential",
      },
    ]));
    expect(bridgeIceServers(configured)).toEqual([
      { urls: "stun:stun.cloudflare.com:3478" },
      {
        urls: ["turns:turn.example.com:443?transport=tcp"],
        username: "short-lived-user",
        credential: "short-lived-credential",
      },
    ]);
    expect(parseBridgeIceServers("stun:one.example:3478, stun:two.example:3478")).toEqual([
      { urls: "stun:one.example:3478" },
      { urls: "stun:two.example:3478" },
    ]);
    expect(bridgeIceServers([])).toEqual([]);
  });
});
