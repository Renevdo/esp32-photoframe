# Offline Album Staging and Deploy-on-Wake Sync

Prepare photo albums on your computer at any time, even while the frame is in
deep sleep, and let the frame pull the changes on its next scheduled wake. No
button presses on the device, no need to catch it awake.

## How it works

```
+-----------------+   Deploy    +-----------------+   pull on wake   +-----------+
| You: add photos | ----------> | Staging server  | <--------------- | The frame |
| in the web UI   |             | (your computer) |  changes + files |  (30 min) |
+-----------------+             +-----------------+   then ack       +-----------+
```

- The **staging server** (part of `process-cli`) keeps albums on your disk,
  processes every uploaded photo to the device-ready format (epdgz plus
  thumbnail) with the same pipeline as the web UI, and journals **Deploy**
  actions as numbered deployments.
- The **frame** checks the server on every scheduled wake (when a Sync Server
  URL is configured), downloads new or changed files straight to its SD card,
  deletes removed ones, acknowledges the deployment sequence, then rotates
  and goes back to sleep.
- If the server is off or unreachable, the frame just rotates from the SD
  card as usual and tries again on the next wake.

## Quick start

1. Start the staging server (once, on a machine on the same LAN):

   ```bash
   cd process-cli && npm install
   node cli.js --staging ~/PhotoframeStaging --staging-port 8090 --device-parameters --host photoframe.local
   ```

   `--device-parameters` fetches the display size, processing settings, and
   measured palette when the device happens to be awake and caches them in
   the store (`device-params.json`), so later starts work with the device
   asleep. Without a cache the defaults are 800x480 landscape, so fetch the
   parameters at least once for a 13.3 inch or portrait frame.

2. Set the **Sync Server URL** on the device (Settings > Auto Rotate), e.g.
   `http://192.168.1.50:8090`. Do this once while the device is awake (press
   the rotate button or catch the post-rotation window), or bake it into the
   deployment via the mobile app when provisioning.

3. Open `http://localhost:8090`, create an album, drop photos in, and press
   **Deploy**. The UI shows how many changes are pending and, once the frame
   has synced, which sequence each device has acknowledged.

## Details

- **Sequence and ack**: every Deploy creates sequence N. The device stores
  the last acknowledged sequence in NVS and asks for `changes?since=N`. Ops
  (put/delete/rmdir) are coalesced server-side, so a photo added and removed
  between two syncs costs nothing.
- **Budget and resume**: the device spends at most 120 seconds per wake
  applying changes (`SYNC_WAKE_BUDGET_SEC`). A large first deployment simply
  spreads over several wakes; files already present with the right size are
  skipped, so resumes are cheap.
- **Atomicity**: files are downloaded to a temp name and renamed, so a power
  loss mid-download never corrupts an album. A transfer cut short is detected
  by comparing the bytes written against the size the server advertised, and
  the op is retried on the next wake rather than acked.
- **Journal size**: `state.json` keeps the deployed manifest once plus the ops
  per sequence. Entries acknowledged by every device the server has seen are
  pruned, so the file grows with the number of staged files, not with the
  number of deploys.
- **Fresh devices get a snapshot**: `changes?since=0` returns a put for every
  currently staged file instead of replaying the whole journal, since a device
  at sequence 0 has nothing to delete. A device that falls so far behind that
  its ops have been pruned is answered with a reset and restarts from that
  snapshot.
- **Device-only albums are safe**: sync only touches files named in ops.
  Albums that exist only on the device (e.g. Downloads) are never modified.
- **Store reset**: if you delete the staging store's `state.json` (or the
  whole store), the server answers with a reset signal, the device restarts
  from sequence 0, and re-downloads everything the store now contains. Files
  from deployments that the reset orphaned stay on the SD card until you
  remove them via the device web UI.
- **Battery**: with a Sync Server URL configured the frame connects to WiFi
  on every scheduled wake, also in SD card rotation mode where it previously
  did not. This costs a few seconds of WiFi per wake, comparable to URL
  rotation mode.

## Companion app (virtual frame)

The staging server also impersonates a photo frame for the
[mobile companion app](https://github.com/aitjcize/esp32-photoframe-app):
it advertises `_esp32-pframe._tcp` via mDNS under its own name (default
"PhotoFrame Staging", change with `--staging-name`), so the app lists it as
a second frame that is always reachable. Albums and photos managed through
the app land in the staging store and reach the real frame on its next wake.

- **Auto-deploy**: edits made through the app deploy immediately by default
  so no visit to the staging UI is needed. Disable with
  `--no-staging-auto-deploy` to batch app edits behind an explicit Deploy.
- **Discovery**: phone and staging server must be on the same LAN, and the
  app must honor the advertised service port (the virtual frame does not run
  on port 80 unless you pass `--staging-port 80`, which needs elevated
  privileges). Disable advertising with `--no-staging-mdns`.
- **Settings and album toggles**: settings changed on the virtual frame, and
  album enable/disable toggles, apply to the virtual frame only in this
  version; the deploy-on-wake sync carries album content, not metadata.
  Change real device settings through the device web UI or Home Assistant.
- **Identity**: the virtual frame reports cached real-device values (board,
  resolution, firmware version) when `--device-parameters` has succeeded at
  least once, a synthetic `VIRTUAL...` device id, and a full battery.

## Troubleshooting

- The device settings page shows the last sync problem under the same
  "last fetch error" field used by URL rotation (for example "Album sync
  paused (budget), resumes next wake").
- `GET http://<server>:8090/api/staging/status` shows the latest deployed
  sequence, pending (undeployed) changes, and per-device acknowledged
  sequences.
- Firmware logs the sync under the `sync_client` tag (enable the debug log
  in Settings to capture it across sleeps).
