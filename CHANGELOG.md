# Changelog

## 0.3.5

- Treat opening or focusing a Claude Desktop session as read-only observation rather than a
  competing writer, so simply viewing a Bridge-controlled session does not interrupt its turn.
- Replace process-presence conflicts with an external-write lease that advances only when the
  transcript receives a new user message not attributable to Bridge.
- Scan recent user messages across every transcript branch so a real Desktop input cannot be
  hidden by later Bridge output on the terminal branch.
- Keep idle Claude Desktop windows and session processes running during Bridge takeover; wait for
  a safe transcript boundary instead of automatically quitting the Desktop application.
- Hide the tool-use interruption sentinel and exclude it from external-write detection.

## 0.3.4

- Require every live Claude Desktop session to be idle and at a completed transcript boundary
  before quitting the Desktop application for Bridge takeover.
- Keep the requested mobile turn queued when any other Desktop session is active or cannot be
  verified safe, preventing takeover from interrupting unrelated computer-side work.
- Retain only Chinese and English Electron locale bundles in packaged macOS builds, reducing
  release size without changing application behavior or signing identity.

## 0.3.3

- Quit the idle Claude Desktop main application before takeover instead of terminating its
  Claude Code session child, preventing the visible `process exited with code 143` failure.
- Preserve an active mobile command when competing writers are detected: close only the Bridge
  writer, keep the command durably queued, and retry automatically after ownership is clear.
- Serialize conflict containment so one observer update cannot emit duplicate conflict events or
  perform the same cleanup twice.
- Keep managed Desktop turns intact during conflict observation rather than interrupting them.
- Make the macOS-only installer workflow produce explicitly labeled ad-hoc CI artifacts while
  stable locally signed packages remain the downloadable release assets.

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
