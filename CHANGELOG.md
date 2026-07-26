# Changelog

## 0.4.0

- Add the evidence layer with per-turn tool records, command outcomes, file changes, artifact
  manifests and explicit exact, inferred or partial confidence.
- Preserve complete Agent SDK tool lifecycle data for Bridge turns and attribute workspace changes
  against a bounded task-start baseline without claiming pre-existing dirty files.
- Recover Claude Desktop tool use and result records incrementally from JSONL by inode, offset and
  message ID while ignoring thinking content and avoiding project-directory scans.
- Store evidence manifests in SQLite and encrypt content-addressed snapshots with an Electron
  safeStorage-protected AES-256-GCM master key; retain manifests after 30-day/1-GiB LRU cleanup.
- Add root-confined artifact access, sensitive-file blocking, symlink escape rejection and
  credential redaction for captured tool output.
- Add read-only text/code/diff and image previews plus sandboxed, network-disabled HTML screenshots.
- Add on-demand 256-KiB artifact transfer with a ten-minute lease, missing-chunk retry, SHA-256
  verification and a hard 20-MiB file limit; authenticated temporary responses bypass the durable
  Relay queue entirely.
- Add Desktop and Android conversation evidence summaries, a dedicated results view, offline
  manifests, cached previews, native file save/share and transfer progress.
- Upgrade to protocol V3 and pairing schema V4. Preserve stable host identity, settings, history and
  local events while rotating rooms and keys, revoking V0.3 devices and requiring one fresh scan.
- Explicitly exclude hidden chain of thought, private Claude Desktop CDP, live Desktop tool mirroring,
  project browsing, remote editing, dynamic-site hosting and embedded PDF rendering.

## 0.3.6

- Unify the Bridge desktop, Android and iOS app icons around the desktop-phone bridge mark.
- Bump all package, native app and user-agent versions to 0.3.6 for the automated GitHub Release flow.

## 0.3.5

- Add a fail-closed release workflow that validates every package and native app version, runs the
  complete verification suite, generates commit notes, and creates a missing tag and GitHub Release.
- Treat opening or focusing a Claude Desktop session as read-only observation rather than a
  competing writer, so simply viewing a Bridge-controlled session does not interrupt its turn.
- Replace process-presence conflicts with an external-write lease that advances only when the
  transcript receives a new user message not attributable to Bridge.
- Scan recent user messages across every transcript branch so a real Desktop input cannot be
  hidden by later Bridge output on the terminal branch.
- Keep idle Claude Desktop windows and session processes running during Bridge takeover; wait for
  a safe transcript boundary instead of automatically quitting the Desktop application.
- Hold the session queue while conflict containment closes the previous Host and persists the
  requeued turn, preventing an immediate second writer from starting.
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
