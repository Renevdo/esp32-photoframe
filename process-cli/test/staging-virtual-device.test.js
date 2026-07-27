import fs from "fs";
import os from "os";
import path from "path";
import { StagingStore } from "../staging/store.js";
import { VirtualDevice } from "../staging/virtual-device.js";

let dir, store;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "vdev-"));
  store = new StagingStore(dir);
  store.init();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

test("config merges cached device config with local overrides", () => {
  fs.writeFileSync(
    path.join(dir, "device-config.json"),
    JSON.stringify({ device_name: "Real Frame", timezone: "CET-1CEST", auto_rotate: true }),
  );
  const v = new VirtualDevice(store, { instanceName: "Staging Frame" });
  const cfg = v.config();
  expect(cfg.timezone).toBe("CET-1CEST");
  expect(cfg.device_name).toBe("Staging Frame");

  v.applyConfig({ timezone: "UTC0" });
  expect(v.config().timezone).toBe("UTC0");

  const v2 = new VirtualDevice(store, { instanceName: "Staging Frame" });
  expect(v2.config().timezone).toBe("UTC0");
});

test("systemInfo has device shape with stable virtual id", () => {
  const v = new VirtualDevice(store, {
    instanceName: "Staging Frame",
    width: 1600,
    height: 1200,
    board: "seeedstudio_xiao_ee02",
    version: "2.15.0",
  });
  const info = v.systemInfo();
  expect(info.width).toBe(1600);
  expect(info.height).toBe(1200);
  expect(info.board_name).toBe("seeedstudio_xiao_ee02");
  expect(info.device_name).toBe("Staging Frame");
  expect(info.device_id).toMatch(/^VIRTUAL/);
  expect(info.device_id).toBe(new VirtualDevice(store, {}).systemInfo().device_id);
  for (const key of [
    "has_sdcard",
    "sdcard_inserted",
    "has_flash_storage",
    "storage_total",
    "storage_used",
    "version",
    "project_name",
  ]) {
    expect(info).toHaveProperty(key);
  }
});

test("battery returns full synthetic charge", () => {
  const v = new VirtualDevice(store, {});
  expect(v.battery()).toEqual({
    battery_level: 100,
    battery_voltage: 5000,
    charging: false,
    usb_connected: true,
    battery_connected: false,
  });
});
