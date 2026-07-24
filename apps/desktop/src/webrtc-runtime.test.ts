import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupDesktopPeerConnection,
  loadDesktopPeerConnection,
} from "./webrtc-runtime.js";

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 10_000,
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("WebRTC condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe.skipIf(process.env.BRIDGE_WEBRTC_REAL !== "1")("desktop WebRTC runtime", () => {
  afterEach(() => cleanupDesktopPeerConnection());

  it("opens a native local DataChannel and transfers a message", async () => {
    const RTCPeerConnectionImpl = loadDesktopPeerConnection();
    const caller = new RTCPeerConnectionImpl();
    const receiver = new RTCPeerConnectionImpl();
    const callerCandidates: RTCIceCandidateInit[] = [];
    const receiverCandidates: RTCIceCandidateInit[] = [];
    let callerRemoteReady = false;
    let receiverRemoteReady = false;
    let incoming: RTCDataChannel | undefined;
    let message = "";

    caller.onicecandidate = (event) => {
      if (!event.candidate) return;
      const candidate = event.candidate.toJSON();
      if (receiverRemoteReady) void receiver.addIceCandidate(candidate);
      else callerCandidates.push(candidate);
    };
    receiver.onicecandidate = (event) => {
      if (!event.candidate) return;
      const candidate = event.candidate.toJSON();
      if (callerRemoteReady) void caller.addIceCandidate(candidate);
      else receiverCandidates.push(candidate);
    };
    receiver.ondatachannel = (event) => {
      incoming = event.channel;
      incoming.onmessage = (messageEvent) => {
        message = String(messageEvent.data);
      };
    };

    const outgoing = caller.createDataChannel("bridge-runtime-test", { ordered: true });
    const offer = await caller.createOffer();
    await caller.setLocalDescription(offer);
    await receiver.setRemoteDescription(offer);
    receiverRemoteReady = true;
    for (const candidate of callerCandidates.splice(0)) {
      await receiver.addIceCandidate(candidate);
    }
    const answer = await receiver.createAnswer();
    await receiver.setLocalDescription(answer);
    await caller.setRemoteDescription(answer);
    callerRemoteReady = true;
    for (const candidate of receiverCandidates.splice(0)) {
      await caller.addIceCandidate(candidate);
    }

    await waitFor(() => outgoing.readyState === "open" && incoming?.readyState === "open");
    outgoing.send("bridge-direct-ok");
    await waitFor(() => message === "bridge-direct-ok");

    expect(message).toBe("bridge-direct-ok");
    outgoing.close();
    caller.close();
    receiver.close();
  }, 15_000);
});
