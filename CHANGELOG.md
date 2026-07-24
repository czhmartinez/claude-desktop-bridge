# Changelog

## 0.3.1

- Add opportunistic WebRTC DataChannel transport between each paired phone and desktop.
- Keep the encrypted WSS Relay connected for signaling, presence, offline delivery and fallback.
- Encrypt SDP, ICE candidates and delayed acknowledgements inside the existing device envelope.
- Fall back to Relay after five seconds or immediately when a direct channel drops, preserving
  envelope IDs and exactly-once command semantics.
- Chunk direct encrypted envelopes with SHA-256 verification and DataChannel backpressure control.
- Bundle the native desktop WebRTC runtime and decouple explicit ICE configuration from Relay DNS.
- Default packaged clients to `relay.alioxis.uk` with Cloudflare STUN and WSS fallback.
- Reduce Relay chunks to 64 KiB after real Tunnel testing exposed delayed larger WebSocket frames.

Claude session ownership, Agent SDK runtime, history, approvals, model and effort behavior remain unchanged.

## 0.3.0

- Add public end-to-end encrypted WSS Relay transport with automatic LAN fallback.
- Migrate existing paired devices to endpoint schema v3 without rotating room or device keys.
- Persist rooms, devices, encrypted queues, ACKs and revocations in SQLite WAL.
- Add Relay readiness, metrics, capacity limits and seven-day daily backup retention.
- Split large encrypted envelopes into bounded chunks with SHA-256 validation and missing-chunk resume.
- Restore Android connections after foreground, network and content-free FCM wake events.
- Show connection path, latency, last connection health and pending sends on desktop and mobile.

Claude session ownership, Agent SDK runtime, history, approvals, model and effort behavior remain unchanged.
