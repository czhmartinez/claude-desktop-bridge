import { describe, expect, it, vi } from "vitest";
import {
  BridgeCrypto,
  TransportRouter,
  cryptoWithRelayEndpoint,
  relayPathForUrl,
  type BridgePayload,
  type BridgeTransport,
  type BridgeTransportMetrics,
  type BridgeTransportPath,
  type DecryptedEnvelope,
  type EncryptedEnvelope,
  type MessageTarget,
  type SendOptions,
  type ServerFrame,
  type SocketState,
} from "./index.js";

class FakeTransport implements BridgeTransport {
  state: SocketState = "idle";
  rttMs: number | undefined;
  readonly sendEnvelope = vi.fn();
  readonly ack = vi.fn();
  readonly registerDevice = vi.fn();
  readonly revokeDevice = vi.fn();
  readonly registerPushToken = vi.fn();
  private messageListeners = new Set<(message: DecryptedEnvelope, encrypted: EncryptedEnvelope) => void>();
  private stateListeners = new Set<(state: SocketState) => void>();
  private frameListeners = new Set<(frame: ServerFrame) => void>();
  private errorListeners = new Set<(error: Error) => void>();
  private metricsListeners = new Set<(metrics: BridgeTransportMetrics) => void>();

  constructor(
    readonly path: BridgeTransportPath,
    readonly endpoint: string,
  ) {}

  connect(): void {
    this.setState("connecting");
  }

  close(): void {
    this.setState("closed");
  }

  async send(_payload: BridgePayload, _to: MessageTarget, _options?: SendOptions): Promise<string> {
    return "envelope-1";
  }

  onMessage(listener: (message: DecryptedEnvelope, encrypted: EncryptedEnvelope) => void): () => void {
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

  onError(listener: (error: Error) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  onMetrics(listener: (metrics: BridgeTransportMetrics) => void): () => void {
    this.metricsListeners.add(listener);
    listener({ path: this.path, endpoint: this.endpoint, state: this.state });
    return () => this.metricsListeners.delete(listener);
  }

  setState(state: SocketState): void {
    this.state = state;
    for (const listener of this.stateListeners) listener(state);
  }
}

const payload: BridgePayload = {
  kind: "request",
  requestId: "request-1",
  idempotencyKey: "request-1",
  method: "project.list",
  params: {},
};

describe("BridgeTransport", () => {
  it("selects the lowest-priority candidate and delegates the protocol contract", async () => {
    const publicRelay = new FakeTransport("public-relay", "wss://bridge.example/ws");
    const lanRelay = new FakeTransport("lan-relay", "ws://192.168.1.2:8788/ws");
    const router = new TransportRouter([
      { id: "lan", path: lanRelay.path, endpoint: lanRelay.endpoint, priority: 20, create: () => lanRelay },
      {
        id: "public",
        path: publicRelay.path,
        endpoint: publicRelay.endpoint,
        priority: 10,
        create: () => publicRelay,
      },
    ]);

    router.connect();
    expect(router.path).toBe("public-relay");
    expect(router.state).toBe("connecting");
    expect(await router.send(payload, "desktop")).toBe("envelope-1");
    router.ack(["envelope-1"]);
    expect(publicRelay.ack).toHaveBeenCalledWith(["envelope-1"]);
    expect(lanRelay.state).toBe("idle");
    router.close();
  });

  it("moves to the next candidate when the active transport closes", () => {
    const first = new FakeTransport("public-relay", "wss://bridge.example/ws");
    const second = new FakeTransport("lan-relay", "ws://192.168.1.2:8788/ws");
    const router = new TransportRouter([
      { id: "public", path: first.path, endpoint: first.endpoint, priority: 10, create: () => first },
      { id: "lan", path: second.path, endpoint: second.endpoint, priority: 20, create: () => second },
    ]);

    router.connect();
    first.setState("closed");

    expect(router.path).toBe("lan-relay");
    expect(second.state).toBe("connecting");
    router.close();
  });

  it("changes only the relay endpoint when preparing a crypto identity for failover", async () => {
    const host = await BridgeCrypto.createHost("ws://192.168.1.2:8788/ws", "Mac");
    const moved = cryptoWithRelayEndpoint(host.crypto, "wss://bridge.example/ws");

    expect(moved.identity).toMatchObject({
      roomId: host.crypto.identity.roomId,
      deviceId: host.crypto.identity.deviceId,
      authToken: host.crypto.identity.authToken,
      relayUrl: "wss://bridge.example/ws",
    });
    expect(relayPathForUrl(host.crypto.identity.relayUrl)).toBe("lan-relay");
    expect(relayPathForUrl(moved.identity.relayUrl)).toBe("public-relay");
  });
});
