# Virtual PhotoFrame Proxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The mobile companion app discovers the staging server as a photo frame via mDNS and manages albums/photos while the real device sleeps; edits flow to the device through the phase 1 pull sync.

**Architecture:** Proxy routes implementing the device REST API subset are mounted into the existing staging server (same port; device paths /api/albums, /api/upload, ... do not collide with /api/staging/* or /api/sync/*). An mDNS advertisement (`_esp32-pframe._tcp`) with device-format TXT records makes the app list it as a separate frame. Mutations auto-deploy by default so app edits reach the frame on its next wake without opening the staging UI.

**Tech Stack:** Node.js >= 18, `bonjour-service` (pure JS mDNS, the one new dependency), jest.

## Global Constraints

- Branch `feature/virtual-photoframe-proxy` off `feature/offline-album-sync`; PR base `feature/offline-album-sync` on the fork, closes #2, noted as stacked on #3
- No em-dash characters in created content
- Never claim the real device identity: own hostname, own instance name, never `photoframe.local`
- Device API response shapes mirror `main/http_server.c` exactly:
  - `GET /api/albums` -> `[{name, enabled}]`
  - `POST /api/albums {name}` / `DELETE /api/albums?name=` / `PUT /api/albums/enabled?name= {enabled}` -> `{status:"success"}`
  - `GET /api/images?album=` -> `[{filename, album, thumbnail?}]` (filename = display file, thumbnail = jpg name when present)
  - `POST /api/upload?album=` multipart fields `image` (png/epdgz, filename preserved) + `thumbnail` (jpg) -> `{status:"success", filepath}`
  - `POST /api/delete {filepath:"album/file.ext"}` -> `{status:"success"}` (thumbnail removed too)
  - `GET /api/image?filepath=album/file.jpg` -> image bytes
  - `GET /api/battery`, `GET /api/system-info`, `GET/POST/PATCH /api/config`, `GET/POST /api/settings/processing`, `GET/POST /api/settings/palette`, `GET /api/current_image`, `POST /api/keep_alive`, `POST /api/rotate`, `POST /api/sleep` implemented as synthetic/stub responses seeded from cached device data
- webapp/package.json and package-lock.json stay uncommitted

### Task 1: Minimal multipart parser (`staging/multipart.js` + jest)

`parseMultipart(buffer, contentTypeHeader) -> [{name, filename?, data:Buffer}]`. Boundary from header (quoted or bare), parts split on `--boundary`, headers parsed for `name` and `filename`, body is raw bytes between header blank line and trailing CRLF. Tests: two-part image+thumbnail body round trip, quoted boundary, missing boundary throws, preserves binary bytes (0x00-0xff).

### Task 2: Virtual device state (`staging/virtual-device.js` + jest)

`class VirtualDevice { constructor(store, ctx) }`:
- `config()` -> synthetic /api/config object: cached real-device config (stored by the CLI at `<store>/device-config.json` when reachable) merged with local overrides (`<store>/proxy-config.json`); always overrides `device_name` to the staging instance name and forces `sync_server_url` to its own URL is NOT done (leave device values as cached).
- `applyConfig(patch)` -> persists overrides, returns merged.
- `systemInfo()` -> device-shaped object: cached width/height/board/version when known, `device_id` = `"VIRTUAL-" + hash of store path`, storage totals from the staging disk usage, `project_name: "esp32-photoframe-staging"`.
- `battery()` -> `{battery_level:100, battery_voltage:5000, charging:false, usb_connected:true, battery_connected:false}`.
- Tests: overrides persist across reload; synthetic ids stable; battery/system shapes contain the required keys.

### Task 3: Proxy routes (`staging/proxy-routes.js` + jest)

`proxyRoute(req, res, u, seg, {store, virtual, autoDeploy}) -> handled:boolean`, called from the staging server router before its 404. Implements the endpoint list from Global Constraints against the staging store (albums = directories, enabled state kept in `<store>/proxy-albums.json`, default enabled true). Uploads parse multipart, store image+thumbnail into `albumsDir`, then `store.deploy()` when autoDeploy. Delete removes pair. `GET /api/current_image` serves the newest jpg in the store or 404. Stubs return device-shaped success JSON. Tests: full app flow (create album, upload multipart, list images, thumbnail fetch, delete, config get/post) plus auto-deploy bumping `store.latestSeq`.

### Task 4: mDNS advertisement (`staging/mdns.js`) + CLI wiring

`advertise({port, instanceName, board, version}) -> {stop()}` using `bonjour-service`: type `esp32-pframe`, protocol tcp, TXT `{name, host: os.hostname()+".local", board, version}`. CLI: `--staging` now also mounts proxy routes and advertises; new flags `--staging-name <name>` (default "PhotoFrame Staging"), `--no-staging-mdns`, `--no-staging-auto-deploy`. The CLI caches the full real-device /api/config to `device-config.json` when `--device-parameters` succeeds. Manual smoke test with `dns-sd -B _esp32-pframe._tcp` on macOS.

### Task 5: Docs + PR

Extend docs/OFFLINE_ALBUM_SYNC.md with a "Companion app (virtual frame)" section: discovery caveats (same LAN, SRV port), auto-deploy semantics, settings passthrough limits (settings changes apply to the virtual frame only in v1). PR to base `feature/offline-album-sync`, closes #2.
