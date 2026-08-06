import {
  isEnvelopeFromConnection,
  type EncryptedEnvelope,
} from "@bridge/protocol";

export interface MobileOutboxIdentity {
  roomId: string;
  deviceId: string;
}

export function isReplayableMobileEnvelope(
  envelope: EncryptedEnvelope,
  identity: MobileOutboxIdentity,
  now = Date.now(),
): boolean {
  return (
    isEnvelopeFromConnection(envelope, {
      roomId: identity.roomId,
      role: "mobile",
      deviceId: identity.deviceId,
    }, now) &&
    envelope.to === "desktop" &&
    envelope.toDeviceId === undefined &&
    envelope.expiresAt > now
  );
}
