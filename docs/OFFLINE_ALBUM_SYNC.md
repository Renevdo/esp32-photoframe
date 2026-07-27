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
  loss mid-download never corrupts an album.
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

## Troubleshooting

- The device settings page shows the last sync problem under the same
  "last fetch error" field used by URL rotation (for example "Album sync
  paused (budget), resumes next wake").
- `GET http://<server>:8090/api/staging/status` shows the latest deployed
  sequence, pending (undeployed) changes, and per-device acknowledged
  sequences.
- Firmware logs the sync under the `sync_client` tag (enable the debug log
  in Settings to capture it across sleeps).
