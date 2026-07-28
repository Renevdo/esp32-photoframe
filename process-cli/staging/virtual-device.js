/**
 * Synthetic device state for the virtual photoframe proxy: a device-shaped
 * config/system-info/battery view backed by the staging store, seeded from
 * cached real-device data when available.
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";

export class VirtualDevice {
  constructor(store, opts = {}) {
    this.store = store;
    this.instanceName = opts.instanceName || "PhotoFrame Staging";
    this.width = opts.width || 800;
    this.height = opts.height || 480;
    this.board = opts.board || "virtual";
    this.version = opts.version || "staging";
    this.cachedConfigPath = path.join(store.storeDir, "device-config.json");
    this.overridesPath = path.join(store.storeDir, "proxy-config.json");
    // The app polls system-info and current_image, and answering either from
    // scratch means readdir + stat over the whole store (~1.8 ms per 300
    // photos, synchronously, so it stalls uploads in flight). Both are status
    // readouts, so a short cache window is fine. Nothing the sync protocol
    // depends on reads through here: deploy() and pendingOps() call
    // store.currentManifest() directly and are always exact.
    this.cacheMs = opts.cacheMs ?? 1000;
    this.storageCache = null;
    this.thumbnailCache = null;
  }

  // Called by the routes that change the store, so an app that uploads and
  // immediately re-reads never sees the previous state. Edits made elsewhere
  // (staging UI, files dropped in by hand) still fall out of cache on their
  // own within cacheMs.
  invalidate() {
    this.storageCache = null;
    this.thumbnailCache = null;
  }

  #cached(slot, compute) {
    const now = Date.now();
    const hit = this[slot];
    if (hit && now - hit.at < this.cacheMs) {
      return hit.value;
    }
    const value = compute();
    this[slot] = { at: now, value };
    return value;
  }

  storageUsed() {
    return this.#cached("storageCache", () => {
      let used = 0;
      for (const meta of Object.values(this.store.currentManifest())) {
        used += meta.size;
      }
      return used;
    });
  }

  // Path of the most recently written thumbnail, or null when the store holds
  // none. Backs GET /api/current_image.
  newestThumbnail() {
    return this.#cached("thumbnailCache", () => {
      let newest = null;
      for (const album of fs.readdirSync(this.store.albumsDir, {
        withFileTypes: true,
      })) {
        if (!album.isDirectory()) continue;
        const albumPath = path.join(this.store.albumsDir, album.name);
        for (const f of fs.readdirSync(albumPath)) {
          if (!f.endsWith(".jpg")) continue;
          const st = fs.statSync(path.join(albumPath, f));
          if (!newest || st.mtimeMs > newest.mtimeMs) {
            newest = { path: path.join(albumPath, f), mtimeMs: st.mtimeMs };
          }
        }
      }
      return newest;
    });
  }

  readJson(p) {
    try {
      const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
      // Guard against valid-JSON-but-not-an-object content (null, number,
      // array): spreading an array would persist its index keys into the
      // config, so only plain objects pass through.
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
      return {};
    } catch {
      return {};
    }
  }

  config() {
    const cached = this.readJson(this.cachedConfigPath);
    const overrides = this.readJson(this.overridesPath);
    return {
      ...cached,
      ...overrides,
      device_name: this.instanceName,
    };
  }

  applyConfig(patch) {
    // Drop prototype-polluting keys from the untrusted patch before merging.
    const clean = {};
    for (const [key, value] of Object.entries(patch || {})) {
      if (["__proto__", "constructor", "prototype"].includes(key)) continue;
      clean[key] = value;
    }
    const overrides = { ...this.readJson(this.overridesPath), ...clean };
    fs.writeFileSync(this.overridesPath, JSON.stringify(overrides, null, 2));
    return this.config();
  }

  systemInfo() {
    const id = crypto
      .createHash("sha256")
      .update(this.store.storeDir)
      .digest("hex")
      .slice(0, 12)
      .toUpperCase();

    const storageUsed = this.storageUsed();

    return {
      device_name: this.instanceName,
      device_id: `VIRTUAL${id}`,
      width: this.width,
      height: this.height,
      board_name: this.board,
      display_type: "virtual",
      wakeup_key_name: "none",
      has_sdcard: true,
      sdcard_inserted: true,
      has_flash_storage: false,
      storage_total: 32 * 1024 * 1024 * 1024,
      storage_used: storageUsed,
      version: this.version,
      project_name: "esp32-photoframe-staging",
      compile_time: "",
      compile_date: "",
      idf_version: "",
    };
  }

  battery() {
    return {
      battery_level: 100,
      battery_voltage: 5000,
      charging: false,
      usb_connected: true,
      battery_connected: false,
    };
  }
}
