# Offline Album Staging and Deploy-on-Wake Sync

Date: 2026-07-27
Status: Approved (approach level), phased implementation
Phases: 1. device-pull album sync, 2. virtual photoframe proxy for the companion app

## Problem

With deep sleep enabled the device is unreachable most of the time (30 minute
rotation schedule, awake for well under a minute per cycle). The web UI at
photoframe.local and the iOS companion app only work while the device is awake,
so photos cannot be prepared or uploaded on demand.

Timer-wake behavior today (main/main.c, deep_sleep_wake_main):

- SD rotation mode without Home Assistant: WiFi is never initialized on a
  timer wake. There is no window to reach the device at all.
- URL rotation mode: WiFi comes up to fetch the image. The HTTP server only
  starts afterwards when the image server responds with
  X-Post-Rotate-Wait-Sec, capped at 30 seconds (POST_ROTATE_WAIT_MAX_SEC),
  as a fixed delay that ends even mid-upload.
- HA configured: HTTP server is up during the wake plus a 10 second window
  (HA_CONFIG_WINDOW_SEC).

None of these windows is reliable for pushing a multi-photo album to a
13.3 inch panel (several hundred KB per epdgz file). The device must pull.

## Goals

- Prepare and organize photos locally at any time, with the same processing
  quality as the web UI (epaper-image-convert pipeline).
- Explicit "Deploy" action; the device picks up changes on its next
  scheduled wake. No button presses on the device.
- The frame keeps working from its SD card when the staging server is off.
- Phase 2: the iOS companion app works against the local staging server even
  while the device sleeps.

## Non-goals

- Instant sync (changes apply on the next 30 minute wake at the earliest).
- Multi-device fan-out in v1 (single device per staging store is enough;
  the manifest format should not preclude it).
- Replacing the esp32-photoframe-server (different use case: pull-per-image
  URL mode with cloud sources).

## Architecture overview

Two components share one staging store:

1. Staging server (Node.js, lives in this repo under `staging-server/`,
   reusing the epaper-image-convert pipeline already used by process-cli).
   Watches or accepts uploads into local albums, processes photos to
   device format (epdgz plus jpg thumbnail), and exposes a small sync API.
2. Firmware sync client (new module `main/sync_client.c`). On every timer
   wake, when a sync server URL is configured, connect WiFi, ask the server
   for pending operations, apply them to the SD card, acknowledge, then
   rotate and sleep. Unreachable server: log, skip, rotate as normal.

Phase 2 adds an app-facing front end to the same staging server: it
implements the subset of the device REST API the companion app uses and
advertises `_esp32-pframe._tcp` over mDNS, so the app discovers it as a
frame named after the staging server. Edits made from the app land in the
staging store and flow to the real device through the phase 1 sync path.

## Phase 1: device-pull album sync

### Staging store and deployment model

- Staging albums live on disk: `<store>/albums/<album>/<name>.epdgz` plus
  `<name>.jpg` thumbnails, mirroring the SD layout
  (`/sdcard/images/<album>/`).
- Originals are kept in `<store>/originals/` so photos can be reprocessed
  when device parameters change.
- The server keeps a monotonically increasing deployment sequence. "Deploy"
  snapshots the current staged state as a new deployment. The diff between
  two deployments is a list of idempotent operations:
  `{op: put|delete, album, file, size, url}` (put covers both image and its
  thumbnail; album create and delete are implied by file operations, empty
  album delete gets an explicit `{op: rmdir, album}`).

### Sync API (served by staging server)

- `GET /api/sync/changes?since=<seq>&device=<id>`: returns
  `{latest_seq, ops: [...]}`. Empty ops when up to date.
- `GET /api/sync/file/<seq>/<album>/<file>`: file download (epdgz or jpg).
- `POST /api/sync/ack {device, seq}`: device confirms it applied everything
  up to seq. The server keeps per-device acked seq for status display.

### Firmware changes

- config_manager: new persisted settings `sync_server_url` (empty = feature
  off) plus getters/setters, exposed via GET/POST/PATCH `/api/config` and the
  webapp settings panel.
- New `main/sync_client.c`:
  - stores last applied seq in NVS,
  - `sync_client_run()`: GET changes since last seq, apply ops one at a
    time (download to a temp file on SD, then rename; deletes by unlink),
    ack, update NVS seq. Uses esp_http_client like
    fetch_and_save_image_from_url in utils.c. Overall time budget per wake
    (default 120 s) so a huge first deploy spreads across wakes: ops are
    applied and acked incrementally, resume is free because ops are
    idempotent and seq only advances after ack.
- deep_sleep_wake_main: when sync_server_url is set, initialize WiFi on
  timer wakes too (today it is skipped in SD mode without HA), run
  `sync_client_run()` before trigger_image_rotation so a freshly deployed
  album can be shown immediately, then continue the normal flow.
- Battery note: this adds a WiFi connect on every scheduled wake in SD mode.
  That is the same cost URL mode already pays per wake. Documented in the
  settings UI.

### Staging server CLI and UI

- `staging-server` npm package in this repo: `photoframe-staging --store
  ~/PhotoframeStaging --port 8090`.
- Web UI (v1 minimal): album list, drag and drop upload (processing with
  the same defaults as process-cli, honoring device parameters fetched and
  cached from the device when it is awake), delete, and a Deploy button
  showing pending diff and per-device sync status.
- v1 UI may be plain HTML served by the staging server; reusing the Vue
  webapp components is a stretch goal, not a requirement.

### Error handling

- Server unreachable on wake: log once, skip sync, rotate from SD.
- Download failure mid-op: abort sync for this wake, do not ack; next wake
  retries the same op. Temp file plus rename keeps images atomic.
- SD full: abort, surface error through existing last_fetch_error mechanism.
- Clock or seq mismatch (server store reset): server responds 409 with
  `{reset: true}`; device resets its seq to 0 and does a full resync where
  the op list deletes unknown files in managed albums. Albums that exist
  only on the device (not in the staging store) are never touched.

### Testing

- Staging server: jest unit tests for diff/ops generation, seq handling,
  reset flow, plus HTTP tests for the sync API (supertest).
- Firmware: host_tests exist in this repo; add unit tests for op parsing
  and seq/NVS logic where the existing harness allows. On-target behavior
  (WiFi, SD) is verified manually with a build.
- Build gates: idf.py build for the EE02 board config plus existing CI.

## Phase 2: virtual photoframe proxy

### Behavior

- The staging server additionally advertises `_esp32-pframe._tcp` (port =
  its HTTP port) with TXT records `name`, `host`, `board`, `version`
  matching the real device format (mdns_service.c), instance name like
  "Photoframe Staging" so the app lists it as a separate frame.
- It implements the device API subset the app uses: `/api/albums` (GET,
  POST, DELETE), `/api/albums/enabled`, `/api/images`, `/api/upload`,
  `/api/delete`, `/api/config` (GET returns a synthetic config seeded from
  the last cached real-device config; POST/PATCH stores intended settings),
  `/api/battery`, `/api/system-info`, `/api/settings/processing`,
  `/api/settings/palette`, `/api/current_image`.
- Uploads through the proxy land in the staging store. Deploy policy is
  configurable: auto-deploy on upload (default) or manual Deploy in the UI.
- Settings changed through the proxy are queued and pushed to the real
  device during its post-rotate window (existing X-Post-Rotate-Wait-Sec
  hook) or applied via a sync op in a later firmware iteration; v1 of
  phase 2 queues album/image content only and passes settings through
  when the device happens to be awake.

### Discovery caveat

The proxy must never claim the real device hostname (photoframe.local).
It uses its own hostname and instance name; the app simply sees two frames.

### Testing

- Contract tests against recorded device API responses (shape parity).
- Manual verification with the iOS app on the same LAN.

## Rollout

1. PR 1 (issue 1): staging server + firmware sync client + webapp setting.
2. PR 2 (issue 2): proxy front end + mDNS advertisement + settings queue.

Both PRs target the Renevdo/esp32-photoframe fork main branch.
