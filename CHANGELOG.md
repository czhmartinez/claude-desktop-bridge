# Changelog

## 0.3.2

- Shrink pairing QR payloads by more than half while retaining legacy decode support.
- Enlarge desktop pairing codes, restore the camera aspect ratio, and request rear-camera
  focus, resolution, and conservative zoom settings for more reliable scanning.
- Hide Claude interruption and synthetic resume sentinels from history and live events.
- Keep immediate retries local until the interrupted SDK result drains; if an interrupt receipt
  says the old prompt would still run, retire that writer before resuming the session.
- Recheck live Claude writers immediately before takeover to close the observer-cache race.
- Keep conflict turns queued for automatic recheck instead of telling the phone user to resend.
- Avoid protected-folder probes during background runtime and model discovery on macOS.
- Require a stable macOS signing identity for update packages, with an explicit local-only
  signing workflow for one Mac and a fail-closed designated-requirement check.

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
