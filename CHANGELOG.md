## 0.9.0

- Make Windows, Linux and iOS standing release platforms alongside macOS and
  Android; every future release ships all of them:
  - Cutting a release now automatically dispatches the desktop installer
    matrix (macOS `adhoc-ci`, Windows `installer-ci`, Linux `installers-ci`)
    and the mobile builds (Android debug APK, iOS simulator and unsigned
    device apps) on the release tag, and attaches the `-ci` artifacts to the
    GitHub Release. Tags created by `release.yml` use GITHUB_TOKEN, which
    never fires `push: tags` triggers, so the dispatch is explicit.
  - Linux desktop graduates from "builds locally only" to a gated platform:
    a new `make:linux` script produces ZIP/DEB/RPM via electron-forge, a
    `desktop-linux` CI job proves the build on every push and pull request,
    and the release matrix publishes the installers with SHA-256 evidence.
  - iOS gains reproducible build entry points (`build:ios:simulator`,
    `build:ios:device`) shared by local development, CI and the release
    workflow. CI now builds both the simulator app and an unsigned device app
    on every push; signed distribution still requires Apple Developer
    credentials through the separate signing process.
- Fix the release version gate drift: workspace manifests, the lockfile and
  the `@bridge/protocol` pins were stuck at 0.7.9 while packages read 0.8.5,
  which would have failed the next release validation. Every manifest,
  lockfile entry, Android `versionCode`/`versionName` and iOS
  `MARKETING_VERSION`/`CURRENT_PROJECT_VERSION` now move together at 0.9.0.
- Update the visible product label from "Bridge 0.8" to "Bridge 0.9".

## 0.8.5

- Prefer the self-hosted STUN server `stun:stun.alioxis.com:3478` and keep
  Cloudflare's public STUN as a fallback across desktop, Android, iOS and web.
  Historical Cloudflare-only pairings migrate in place without clearing
  pairings, keys or messages; custom ICE servers stay untouched. The packaged
  default still contains only STUN (no TURN URLs or long-term credentials).
- Add an independent pairing-sync screen. After a successful QR scan the mobile
  client now shows "扫码连接成功，正在同步" with a progress bar and explicit
  connecting → verifying → syncing stages, instead of appearing unresponsive
  until the full sync completes.
- Stream session and rollout activity in real time between the desktop Bridge
  and paired mobile clients. Desktop now polls the native Codex rollout files
  and Claude transcripts on a sub-second cadence and broadcasts the first
  snapshot plus every change, so switching conversations or tapping sync is no
  longer required.
- Restore assistant answer finalization for native Desktop runtimes that only
  expose the final history record instead of an `assistant.completed` event, so
  a prior streaming delta no longer sits beside the imported final answer.
- Fix the broken in-app logo asset path and switch the mobile splash background
  to the dark theme. Update the visible product label from "Bridge 0.7" to
  "Bridge 0.8".

## 0.8.0

- Redesign the entire frontend on the Sunstone 2030 (renew) visual baseline:
  - Dark is now the flagship theme and the default for new installs: a pure-black
    base with warm white-opacity surface steps replaces the cool gray palette,
    and the accent moves from green to terracotta clay (dark `#E0885F`, light
    `#D97757`). The light theme keeps the same language on a warm ivory axis.
    Returning users keep their stored theme choice.
  - Typography is finalized: DM Sans for UI text (self-hosted variable woff2 via
    Fontsource, CSP `font-src 'self'` compliant), Inter for tabular numerals,
    JetBrains Mono for code, system PingFang/YaHei stack for Chinese.
  - Liquid glass material, restricted to transient layers per the glass
    discipline: dialogs, sheets, permission prompts, artifact previews, the
    mobile top chrome, the floating composer, and the pairing hero card are
    glass (blur 26px + saturate 180%, hairline border, top highlight, deep
    shadow); canvas content cards stay flat with the four-piece treatment
    (fill + 1px hairline + top 1px highlight + soft shadow). Glass panels get a
    pointer-follow specular highlight (fine-pointer devices only).
  - Motion is spring-disciplined: staggered-rise entrances for first-paint
    lists (55ms steps, capped at the 8th item), glass-pop dialog entrances
    (scale 0.97, never from 0), scrim fades, press states scale to 0.94-0.97,
    interactions ≤200ms and entrances ≤320ms, transform/opacity only, and the
    global `prefers-reduced-motion` guard collapses it all; glass falls back to
    solid surfaces under `prefers-reduced-transparency`.
  - Contrast is WCAG AA clean in both themes: on-tint semantic text uses
    dedicated ink tokens (`--accent-ink`/`--warm-ink`/`--danger-ink`/
    `--success-ink`), primary buttons pair deep clay with white text in light
    (5.6:1) and bright clay with dark warm ink in dark (~6.8:1), and
    informational microcopy no longer uses the decorative faint tone.
  - Brand assets unify on the new neon-sign logo (master: `assets/logo.png`):
    a photoreal orange neon arch between a monitor and a phone, joined by a
    glowing lock node on a rain-damp concrete wall. Desktop icons
    (icns/ico/png), Android and iOS launchers with adaptive foregrounds,
    splash screens, PWA icons and favicons, the in-app BrandMark, the site
    mark, and both social previews all derive from that single master, and
    the architecture diagram on the site is recolored to match.
- Restyle the landing site (site/) to the same baseline: pure-black warm dark,
  self-hosted DM Sans, liquid-glass sticky header, asymmetric hero with the
  real product conversation in a floating phone frame, a runtime-name marquee,
  four-piece feature/security/download cards, and GSAP scroll entrances gated
  behind `prefers-reduced-motion` with a no-CDN fallback that keeps content
  visible.
- Extend `scripts/visual-qa.mjs` with a theme matrix: `BRIDGE_QA_THEME=light|dark`
  renders the full screenshot + axe matrix per theme into separate artifact
  folders, and axe now waits for entrance animations to settle before measuring
  contrast so mid-fade opacity no longer reads as false violations.

## 0.7.9

- Fix relay tunnel drops and mobile pairing failures on the hosted relay:
  - The relay no longer rejects native WebView origins. Capacitor mobile clients
    connect from `capacitor://localhost` (iOS), `http://localhost`/`https://localhost`
    (Android) and Electron loads `file://`, which the strict `BRIDGE_ALLOWED_ORIGINS`
    allowlist previously answered with HTTP 403 — pairing appeared to work only
    from browsers or clients that sent no Origin header. Non-browser origins and
    loopback origins are now always allowed; the allowlist still rejects remote
    web pages.
  - The per-connection frame budget is configurable and raised from 600 to
    `BRIDGE_RELAY_MAX_FRAMES_PER_MINUTE` (default 6000). The desktop fans out every
    event to every paired device, so a busy session with a phone attached could
    trip the old 600/min cap and have its tunnel killed with `RATE_LIMITED`,
    forcing repeated reconnects and making the host look offline.
  - Mobile pairing retries no longer burn the QR: the relay binds a device to the
    first installation `instanceId`, and a transient handshake failure used to mint
    a fresh random instanceId on retry, producing `PAIRING_ALREADY_USED` until a new
    QR was generated. The provisional instanceId is now persisted per room/device
    and reused on re-scan, then cleared after a successful import.

## 0.7.8

- Make session tool actions a first-class strip on mobile: provider, relay, model/effort
  configuration, stop and sync now live in a horizontally scrollable chip bar under the
  conversation title instead of competing for topbar icon space, so every runtime shows
  the buttons it actually supports (Claude gets configuration, Codex/Hermes get provider,
  and static placeholders disappear).
- Fix a runtime action gap that made Claude sessions look incomplete: desktop-observed
  Claude sessions without route-level actions now inherit canConfigure by default instead
  of dropping the model/effort/permission configuration button.
- Enable image attachments for Codex sessions: the app-server capability now advertises
  attachment.image, mobile uploads are materialized into host-side temp files and sent as
  localImage turn input items (turn/start and turn/steer), and the accepted event echoes
  the attachments so the sender renders immediately.
- Render conversation images on both clients: history attachments can now carry base64
  image data (Codex thread items store host paths, so the adapter reads the files at
  history time and fills data), and desktop/mobile show real <img> previews instead of
  bare file names or paths; transports that cannot replay bytes (Claude transcripts) keep
  a name chip.
- Make Codex file-change cards actionable: each changed file row opens the real file in
  the host's default app via a workspace-contained `runtime.file.open` RPC (desktop and
  mobile), so the tidy 成果 list is no longer dead UI.

## 0.7.7
## 0.7.7

- Add a composer-level liveness indicator on desktop and mobile: while a session is
  queued or running, a line above the input box shows pulsing dots, the current
  activity (排队等待中 / 思考中 / 正在生成回复 / 正在运行 · tool) and a ticking
  elapsed-time counter — so a silent stretch is visibly "still working" instead of
  looking interrupted, and the line disappearing means the turn settled.

## 0.7.6

- Fix the reconnect slowdown that forced re-pairing: a no-op metadata rewrite in the
  Claude Desktop session registrar minted a fresh `updatedAt` on every reconcile, so
  `registrationChanged` was permanently true and the event log accumulated ~240k
  useless `session.desktop-registration` events (490 MB JSONL parsed into memory on
  every desktop start). The registrar now returns the previous record when nothing
  meaningful changed, and the event log streams oversized files through a compactor
  on startup: registration churn and superseded stream deltas are dropped, only a
  bounded tail (30k events / 32 MB) is retained, and the transcript dedup index is
  preserved across the full history. Event-driven snapshot republishes are
  trailing-debounced (120ms) so event bursts no longer rebuild the snapshot per
  event, and mobile catch-up replay now applies events in a single indexed pass
  instead of mapping every session per event.
- Move mobile session archive/delete into the session list: each row (active and
  archived) has its own ⋯ action opening the bottom sheet, so managing a session no
  longer requires opening it. The conversation topbar loses the theme toggle (it
  already lives on the home page) and keeps only conversation actions.

## 0.7.5

- Give the conversation stream motion: newly arrived messages, tool lines and evidence
  summaries rise in with a 200ms ease-out transform/opacity entrance, while permission
  prompts and status banners fade-slide on mount. A shared `StreamEntrance` tracker
  guarantees the initial history load and bulk "load older" prepends never replay
  entrance animations, and reduced-motion users keep the existing instant behavior.
  Auto-scroll is now pin-aware on both clients: the view follows new content smoothly
  only while you are at the bottom (streaming text included), scrolling up to read is
  never yanked back down, and loading older history keeps the reading position anchored.

## 0.7.4

- Add session archive and delete on desktop and mobile behind the additive
  `session.visibility.v1` capability. Archiving hides a session from the default
  lists into a collapsed 已归档 section (full history preserved, one-tap restore);
  deleting removes Bridge-side records (session configuration, queued turns,
  terminal receipts, permission overrides) and writes a tombstone so native
  re-discovery by the Claude catalog or the Codex/Hermes adapters never brings
  the session back. Native apps keep their own data untouched. Sessions with a
  running/queued/waiting turn or an active cross-Desktop relay refuse deletion;
  `session.archived` / `session.deleted` events keep phones in sync live.
- Fix the desktop relay dialog losing its only confirm path: once the session snapshot
  picked up the freshly previewed handoff, the dialog jumped straight to the
  "等待确认接力" progress view with no way to accept. A server-driven `previewed`
  handoff now renders the preview phase with the objective editor and
  确认接力 / 取消接力 actions, so confirming also survives a reload or a second device.
- Add Claude-style authorization configuration to Codex and Hermes sessions: the session
  configuration dialog now offers 标准授权 / 完全授权 with 整台电脑 (per-runtime host
  default, persisted in the desktop config) and 当前会话 (per-session override, persisted
  in the conversation state store) scopes. Under 完全授权, Bridge auto-approves the
  runtime's command and file-change approvals with an audited `Bridge 完全授权`
  resolution and immediately sweeps already-pending approvals; questions still wait for
  a human answer, and each runtime's host default is independent from Claude's global
  default and from the other runtime.

- Fix mobile-created Codex and Hermes sessions failing immediately with an unreadable history
  and a failed first message. Both runtimes keep a brand-new session only in memory until its
  first user message: Codex rejects `thread/read`/`thread/resume` for threads without a
  rollout and Hermes rejects `session.resume` for lazy aliases, and neither lists them, so a
  later refresh silently dropped the session and every follow-up call fell through to the
  Claude broker. The adapters now track unmaterialized threads and live aliases explicitly:
  history resolves empty, the first turn skips resume and goes straight to `turn/start` /
  `prompt.submit`, refreshes preserve sessions the native side cannot list yet, and the Hermes
  stored-id row folds back into the live alias once the session persists so the open
  conversation never jumps to a new id.
- Route requests by runtime session id ownership instead of adapter cache membership, so an
  external-runtime session that is momentarily unknown never falls through to the Claude
  broker with a misleading "Session not found".
- Make the mobile force-sync button actually force: it now asks the desktop to re-discover
  native sessions (`runtime.refresh`) before pulling events and the snapshot, and confirms a
  successful sync with a brief check mark. The desktop also re-polls ready runtime adapters
  (debounced) when serving `snapshot.get`, so sessions created directly inside the Codex or
  Hermes Desktop apps reach the phone without waiting for a window activation or reconnect.

## 0.7.3

- De-bubble agent output on desktop and mobile: assistant messages render as continuous
  Codex-style flowing text without cards or per-message headers, tool activity becomes
  subtle muted work lines, and only user messages keep their accent bubble.

## 0.7.2

- Aggregate Codex file edits Codex-style: the conversation no longer renders one
  "File change" card per edit; a single 已编辑 N 个文件 card with per-file
  +additions/−deletions lives in the 成果 column on both desktop and mobile.
  File-change summaries flow from the Codex adapter through history and live tool
  events as structured data.

## 0.7.1

- Fix mobile parity for relay sessions: the host now pushes a full snapshot resync to
  paired devices whenever the session id set changes, because event deltas only update
  existing sessions. Relay-created sessions (and any new Claude/Codex/Hermes session)
  appear on phones live instead of waiting for a manual refresh or reconnect.
- Follow the relay plan gate live on mobile: `runtime.handoff.*` events now update the
  source session's pending gate on phones, so plan confirmation and cancellation work
  entirely from mobile; handoff event payloads use the public snapshot shape.
- Fix Hermes session identity stability: `session.create` now exposes the persisted
  `stored_session_id` as the canonical identity instead of the gateway's per-process live
  alias. Relay chains, goal tracking and mobile session references survive Bridge restarts
  instead of breaking with "未知会话" links and lost goal state; live RPC still uses the
  alias for lazy sessions and folds gateway events back onto the canonical id.
- Relay-created sessions now keep their 接力自/接力至 chain badges and goal status on both
  desktop and mobile after restart.

## 0.7.0

- Add cross-Desktop serial relay behind the additive `runtime.handoff.v1` capability: any Claude,
  Codex or Hermes session can be handed off to another Desktop runtime from the Bridge desktop
  and mobile UIs. The source task is interrupted safely, a bounded encrypted context package
  moves to a brand-new native session on the target runtime, and the relay chain links both
  sessions bidirectionally without merging runtime domains.
- The target runtime always plans first: Codex uses the native app-server plan collaboration
  mode while Claude and Hermes use a read-only planning contract enforced through the existing
  approval flow. The full plan is shown in Bridge and goal-mode execution only starts after an
  explicit user confirmation with an editable objective.
- Codex targets execute with native `thread/goal` tracking mirrored into Bridge; Claude and
  Hermes targets run a Bridge-orchestrated goal loop with `GOAL_STATUS` markers, bounded
  auto-continuation and blocked/complete reporting. Stopping a goal session pauses its goal so
  the supervisor never fights a user stop, and paused or blocked goals can be resumed.
- Relay handoffs persist in `conversation-state-v1.sqlite` (`runtime_handoffs`,
  `runtime_goals`) with fail-closed crash recovery: preparing/executing stages stop without
  re-sending, completed plans are recovered from target history, and active goals reconcile
  with the target runtime on restart.
- Protocol stays V3 and pairing schema V4; 0.4-0.6 clients ignore the new events and metadata
  and simply hide the relay entry.
- Fix handoff redaction so `Authorization`/`api_key` style secrets keep their key name when
  the value is removed.

## 0.6.9

- Add model, provider, reasoning-effort and fast-mode configuration for Codex Desktop and Hermes
  Desktop sessions from the Bridge desktop and mobile UIs through each runtime's native interface.
- Codex uses the app-server model catalog and `thread/settings/update`, falls back to per-turn
  `thread/resume` parameters on older app-servers, and mirrors Desktop-side changes via
  `thread/settings/updated` notifications.
- Hermes uses `model.options` plus session `config.set` for model/provider/reasoning/fast, with
  `session.info` event sync.

# Changelog

## 0.6.8

- Detect running Hermes Desktop instances from the standard Applications bundle and the local
  Hermes Agent macOS release bundle under `~/.hermes`.

## 0.6.7

- Detect the macOS ChatGPT bundle as Codex Desktop so lifecycle status, launch, and quit controls
  reflect the application that actually hosts Codex.
- Let message composers without an image-attachment capability use their full width instead of
  reserving a hidden attachment column.

## 0.6.6

- Make pairing a two-phase handshake: a Relay claim is provisional until Mobile and Desktop
  complete an encrypted `snapshot.get` request/response and verify the QR host identity.
- Revoke stale Relay device claims when Desktop no longer has their local device key, and derive
  Mobile online state only from successfully decrypted Desktop traffic instead of Relay presence.
- Preserve the previous Mobile identity while replacement pairing is in progress and discard only
  the provisional device's ciphertext when confirmation fails or times out.

## 0.6.1

- Add Codex Desktop and Hermes Desktop adapters behind the same Bridge session, streaming,
  approval, question, steer and interrupt experience while keeping native runtime identities isolated.
- Add Tencent Cloud domestic Relay at `relay.alioxis.com` with HTTPS/WSS termination, persistent
  SQLite storage, health checks and a deterministic migration path from the previous public Relay.
- Prefer the domestic Relay in packaged Desktop and Android clients while retaining the previous
  public endpoint as a lower-priority fallback.

## 0.5.3

- Replace the no-prompt Windows Squirrel installer with an assisted NSIS wizard that exposes the
  installation directory page instead of silently forcing a policy-restricted user location.
- Install the Windows package into a randomized custom directory in CI, then launch that installed
  executable for cold-start, packaged UI, encrypted pairing and device-revocation checks.
- Keep optional Authenticode signing through electron-builder certificate settings while retaining
  protocol V3, pairing schema V4 and compatibility with existing 0.5 mobile clients.

## 0.5.2

- Treat blank release variables as absent so Windows packages retain the built-in Relay, pairing,
  service-origin and ICE defaults instead of crashing in `networkReachableUrl` on first launch.
- Add a packaged Windows cold-start gate with all Bridge transport variables removed before the
  existing encrypted pairing and device-revocation checks.
- Ship Windows Squirrel as an upgrade from 0.5.1; protocol V3, pairing schema V4 and existing
  mobile pairings remain unchanged.

## 0.5.1

- Add computer-default and per-session `standard` / `full-access` permission policies behind the
  additive `permission.policy.v1` capability while retaining protocol V3 and pairing schema V4.
- Keep Agent SDK permission mode at `default`; auto-approve tools in Desktop `PermissionBroker`,
  keep `AskUserQuestion` interactive, preserve managed denials, and audit automatic decisions.
- Drain pending tool requests immediately after enabling full access, retain first-resolver-wins
  behavior, and mark turn-end cleanup so automatic denials no longer flood conversation history.
- Reconnect and resume events on native app activation, network recovery and push wake without
  interrupting Desktop work. Restore the last valid host and session after a Mobile process restart.
- Ship Android `versionCode` 31 alongside version 0.5.1 Desktop and Mobile artifacts.

## 0.5.0

- Promote Bridge `sessionId` to a stable logical conversation ID with durable provider profiles,
  historical execution lanes, one active lane, route-level allowed actions and lane-scoped evidence.
- Add an isolated `conversation-state-v1.sqlite` store for conversations, providers, lanes,
  handoffs, queued turns, terminal receipts and idempotent legacy JSON migration. Rename legacy
  files to `.migrated` only after two successful startups.
- Keep Claude-3p on the existing Agent SDK and Host Credentials path. Add a separate Anthropic API
  runtime that accepts a Console API Key only through local Desktop IPC, persists it only through
  Electron `safeStorage`, validates it with `GET /v1/models`, strips inherited Host/OAuth/gateway
  routing, and makes the separate API billing boundary explicit.
- Add Claude official handoff through the public `claude://code/new` Deep Link only. Require one
  local Mac confirmation and exact profile, realpath cwd, opaque handoff ID, first-message hash and
  ten-minute-window association before activating a read-only observed lane.
- Add encrypted, bounded structured handoff packages with visible goals, recent conversation,
  constraints, incomplete work, tool and artifact summaries, hashes, workspace/Git state, source
  event sequence and integrity hash. Exclude hidden thinking, credentials, sensitive bodies,
  unbounded output and content outside the project.
- Fail closed while work is active and preserve the source lane on cancellation, timeout, crash,
  ambiguous official matches or uncertain first-message delivery. Never auto-failover or replay an
  uncertain handoff message.
- Add capability-gated provider switching to Desktop and Android. Official lanes replace the
  composer with “在 Claude 官方继续”; API Key configuration remains unavailable over Mobile or Relay.
- Preserve protocol V3 and pairing schema V4. V0.5 clients hide provider UI against V0.4 Hosts;
  V0.4 clients keep normal writable-lane execution against V0.5 Hosts, while official read-only
  lanes reject legacy writes before queueing and tell the client to upgrade.
- Ship the shared-client release as paired macOS DMG and Android APK artifacts.

## 0.4.2

- Refuse a native resume before writing any user message when the source session belongs to a
  different Claude or Claude-3p profile than the active Bridge Host credentials.
- Preserve Claude Desktop's `sessionSettings.ultracode` signal and treat that route as a 1M-context
  model for capacity checks and Agent SDK resume configuration.
- Suppress duplicate synthetic `Prompt is too long` and related SDK failure messages in both
  recovered history and the live streaming path.
- Keep protocol V3 and pairing schema V4 unchanged. This desktop-native hotfix remains compatible
  with the existing 0.4.1 Android APK and does not require pairing again.

## 0.4.1

- Register Bridge-created Agent SDK sessions in the active Claude Desktop sidebar after their
  first trusted transcript record, while preserving the same CLI session ID and JSONL history.
- Discover the active Claude profile and account directory from the running process, validate the
  existing metadata schema, write one deterministic mode-0600 metadata file atomically, and fail
  closed on ambiguous profiles, accounts, formats or conflicts.
- Add explicit waiting, retry, restart-required and registered states. The desktop can safely quit
  and relaunch Claude on demand, while Bridge execution labels remain truthful after registration.
- Distinguish Bridge-created sessions from Claude Desktop-native sessions across desktop and mobile
  labels, creation dialogs and composer copy.
- Recover orphaned Bridge tasks after desktop replacement without replaying them, expose an
  independent force-stop action, and archive interrupted evidence instead of leaving it collecting.

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
- Recover evidence interrupted by a desktop restart as failed/partial instead of leaving it
  collecting forever. Surface queued work orphaned by a Claude Desktop session-ID rotation without
  replaying it, and expose an independent force-stop control for running, waiting or queued turns.
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
