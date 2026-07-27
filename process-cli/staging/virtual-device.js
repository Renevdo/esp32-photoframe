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
  }

  readJson(p) {
    try {
      return JSON.parse(fs.readFileSync(p, "utf8"));
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
    const overrides = { ...this.readJson(this.overridesPath), ...patch };
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

    let storageUsed = 0;
    for (const [, meta] of Object.entries(this.store.currentManifest())) {
      storageUsed += meta.size;
    }

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
