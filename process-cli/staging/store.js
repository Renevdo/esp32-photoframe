/**
 * Staging store: albums mirrored to the SD layout plus a deployment journal.
 *
 * Layout under storeDir:
 *   albums/<album>/<name>.epdgz|.jpg   processed, device-ready files
 *   originals/<album>/<name>.<ext>     uploaded originals (for reprocessing)
 *   state.json                         { latestSeq, manifest, deployments, devices }
 *
 * `manifest` is the single snapshot of the last deployed state, and
 * `deployments` holds only the ops per seq. Keeping a manifest per deployment
 * made state.json grow with (files x deployments), which with auto-deploy is
 * one deployment per photo. Entries every known device has acked are pruned,
 * so a device that falls behind the retained window is told to reset and
 * restarts from a snapshot.
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
    this.state = { latestSeq: 0, manifest: {}, deployments: [], devices: {} };
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
      this.#migrate();
    } else {
      this.saveState();
    }
  }

  // Pre-manifest-split stores kept a full manifest on every deployment and
  // derived latestSeq from the journal tail.
  #migrate() {
    if (this.state.manifest !== undefined) {
      return;
    }
    const deployments = this.state.deployments ?? [];
    const last = deployments[deployments.length - 1];
    this.state.latestSeq = last ? last.seq : 0;
    this.state.manifest = last?.manifest ?? {};
    this.state.deployments = deployments.map(({ seq, ops, at }) => ({
      seq,
      ops,
      at,
    }));
    this.state.devices = this.state.devices ?? {};
    this.saveState();
  }

  saveState() {
    const tmp = this.statePath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    fs.renameSync(tmp, this.statePath);
  }

  get latestSeq() {
    return this.state.latestSeq ?? 0;
  }

  lastDeployedManifest() {
    return this.state.manifest ?? {};
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
    this.state.latestSeq = seq;
    this.state.manifest = manifest;
    this.state.deployments.push({ seq, ops, at: new Date().toISOString() });
    this.#pruneAckedDeployments();
    this.saveState();
    return { seq, ops };
  }

  // Journal entries below every known device's acked seq can never be
  // requested again, so they are dropped to keep state.json bounded.
  #pruneAckedDeployments() {
    const acked = Object.values(this.state.devices);
    if (acked.length === 0) {
      return;
    }
    const floor = Math.min(...acked);
    this.state.deployments = this.state.deployments.filter(
      (d) => d.seq > floor,
    );
  }

  // The seq of the oldest journal entry still available for replay.
  get #oldestRetainedSeq() {
    const d = this.state.deployments;
    return d.length ? d[0].seq : this.latestSeq + 1;
  }

  changesSince(sinceSeq) {
    if (sinceSeq > this.latestSeq) {
      return { reset: true };
    }
    // A device at seq 0 holds nothing, so replaying history would just send
    // deletes for files it never had. Send what is staged right now instead.
    if (sinceSeq === 0) {
      return {
        latestSeq: this.latestSeq,
        ops: computeOps({}, this.lastDeployedManifest()),
      };
    }
    if (sinceSeq < this.#oldestRetainedSeq - 1) {
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
    this.#pruneAckedDeployments();
    this.saveState();
  }

  deviceStatus() {
    return { ...this.state.devices };
  }
}
