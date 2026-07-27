/**
 * Staging store: albums mirrored to the SD layout plus a deployment journal.
 *
 * Layout under storeDir:
 *   albums/<album>/<name>.epdgz|.jpg   processed, device-ready files
 *   originals/<album>/<name>.<ext>     uploaded originals (for reprocessing)
 *   state.json                         { deployments, devices }
 */

import fs from "fs";
import path from "path";
import { computeOps, coalesceOps } from "./ops.js";

export class StagingStore {
  constructor(storeDir) {
    this.storeDir = storeDir;
    this.albumsDir = path.join(storeDir, "albums");
    this.originalsDir = path.join(storeDir, "originals");
    this.statePath = path.join(storeDir, "state.json");
    this.state = { deployments: [], devices: {} };
  }

  init() {
    fs.mkdirSync(this.albumsDir, { recursive: true });
    fs.mkdirSync(this.originalsDir, { recursive: true });
    if (fs.existsSync(this.statePath)) {
      try {
        this.state = JSON.parse(fs.readFileSync(this.statePath, "utf8"));
      } catch {
        // Corrupt state (interrupted write, manual edit): keep the evidence
        // and restart from an empty journal. Devices whose acked seq is now
        // ahead get a reset response and do a full resync.
        const backup = `${this.statePath}.corrupt`;
        fs.copyFileSync(this.statePath, backup);
        console.error(
          `Warning: ${this.statePath} is corrupt, starting fresh (backup at ${backup})`,
        );
        this.saveState();
      }
    } else {
      this.saveState();
    }
  }

  saveState() {
    const tmp = this.statePath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.statePath);
  }

  get latestSeq() {
    const d = this.state.deployments;
    return d.length ? d[d.length - 1].seq : 0;
  }

  lastDeployedManifest() {
    const d = this.state.deployments;
    return d.length ? d[d.length - 1].manifest : {};
  }

  currentManifest() {
    const manifest = {};
    if (!fs.existsSync(this.albumsDir)) return manifest;
    for (const album of fs.readdirSync(this.albumsDir)) {
      const albumPath = path.join(this.albumsDir, album);
      if (!fs.statSync(albumPath).isDirectory()) continue;
      for (const file of fs.readdirSync(albumPath)) {
        const st = fs.statSync(path.join(albumPath, file));
        if (st.isFile()) {
          manifest[`${album}/${file}`] = { size: st.size, mtimeMs: st.mtimeMs };
        }
      }
    }
    return manifest;
  }

  pendingOps() {
    return computeOps(this.lastDeployedManifest(), this.currentManifest());
  }

  deploy() {
    const manifest = this.currentManifest();
    const ops = computeOps(this.lastDeployedManifest(), manifest);
    if (ops.length === 0) {
      return { seq: this.latestSeq, ops: [] };
    }
    const seq = this.latestSeq + 1;
    this.state.deployments.push({
      seq,
      ops,
      manifest,
      at: new Date().toISOString(),
    });
    this.saveState();
    return { seq, ops };
  }

  changesSince(sinceSeq) {
    if (sinceSeq > this.latestSeq) {
      return { reset: true };
    }
    const newer = this.state.deployments.filter((d) => d.seq > sinceSeq);
    return {
      latestSeq: this.latestSeq,
      ops: coalesceOps(newer.map((d) => d.ops)),
    };
  }

  ack(deviceId, seq) {
    this.state.devices[deviceId] = seq;
    this.saveState();
  }

  deviceStatus() {
    return { ...this.state.devices };
  }
}
