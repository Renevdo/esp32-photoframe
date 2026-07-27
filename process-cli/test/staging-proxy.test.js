import { jest } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";
import { createCanvas } from "canvas";
import { getDefaultParams } from "@aitjcize/epaper-image-convert";
import { StagingStore } from "../staging/store.js";
import { VirtualDevice } from "../staging/virtual-device.js";
import { createStagingServer } from "../staging/staging-server.js";

jest.setTimeout(30000);

let dir, store, server, base;
const ctx = {
  params: getDefaultParams(),
  palette: null,
  width: 200,
  height: 120,
  orientation: "landscape",
};

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-"));
  store = new StagingStore(dir);
  store.init();
  const virtual = new VirtualDevice(store, { instanceName: "Test Staging" });
  server = await createStagingServer(store, ctx, {
    port: 0,
    silent: true,
    virtual,
    autoDeploy: true,
  });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterEach(() => {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function multipartBody(boundary, image, thumbnail) {
  return Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${image.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    ),
    image.data,
    Buffer.from(
      `\r\n--${boundary}\r\nContent-Disposition: form-data; name="thumbnail"; filename="${thumbnail.name}"\r\nContent-Type: image/jpeg\r\n\r\n`,
    ),
    thumbnail.data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
}

function pngBuffer() {
  const c = createCanvas(32, 32);
  c.getContext("2d").fillRect(0, 0, 32, 32);
  return c.toBuffer("image/png");
}

test("device API flow: album create, upload, images, image fetch, delete", async () => {
  let res = await fetch(`${base}/api/albums`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "FromApp" }),
  });
  expect((await res.json()).status).toBe("success");

  res = await fetch(`${base}/api/albums`);
  expect(await res.json()).toEqual([{ name: "FromApp", enabled: true }]);

  const body = multipartBody(
    "APPBOUND",
    { name: "shot.png", data: pngBuffer() },
    { name: "shot.jpg", data: Buffer.from("fakejpeg") },
  );
  res = await fetch(`${base}/api/upload?album=FromApp`, {
    method: "POST",
    headers: { "content-type": "multipart/form-data; boundary=APPBOUND" },
    body,
  });
  const uploadJson = await res.json();
  expect(uploadJson.status).toBe("success");
  expect(uploadJson.filepath).toContain("FromApp/shot.png");

  res = await fetch(`${base}/api/images?album=FromApp`);
  expect(await res.json()).toEqual([
    { filename: "shot.png", album: "FromApp", thumbnail: "shot.jpg" },
  ]);

  res = await fetch(`${base}/api/image?filepath=FromApp%2Fshot.jpg`);
  expect(res.status).toBe(200);
  expect((await res.text()).toString()).toBe("fakejpeg");

  // auto-deploy: upload created a deployment
  expect(store.latestSeq).toBeGreaterThanOrEqual(1);

  res = await fetch(`${base}/api/delete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ filepath: "FromApp/shot.png" }),
  });
  expect((await res.json()).status).toBe("success");
  res = await fetch(`${base}/api/images?album=FromApp`);
  expect(await res.json()).toEqual([]);
});

test("album enabled toggle and album delete", async () => {
  await fetch(`${base}/api/albums`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Toggle" }),
  });
  let res = await fetch(`${base}/api/albums/enabled?name=Toggle`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: false }),
  });
  expect((await res.json()).status).toBe("success");
  res = await fetch(`${base}/api/albums`);
  expect(await res.json()).toEqual([{ name: "Toggle", enabled: false }]);

  res = await fetch(`${base}/api/albums?name=Toggle`, { method: "DELETE" });
  expect((await res.json()).status).toBe("success");
  res = await fetch(`${base}/api/albums`);
  expect(await res.json()).toEqual([]);
});

test("config, battery, system-info are device shaped", async () => {
  let res = await fetch(`${base}/api/config`);
  const cfg = await res.json();
  expect(cfg.device_name).toBe("Test Staging");

  res = await fetch(`${base}/api/config`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ timezone: "UTC0" }),
  });
  expect(res.status).toBe(200);
  res = await fetch(`${base}/api/config`);
  expect((await res.json()).timezone).toBe("UTC0");

  res = await fetch(`${base}/api/battery`);
  expect((await res.json()).battery_level).toBe(100);

  res = await fetch(`${base}/api/system-info`);
  const info = await res.json();
  expect(info.device_id).toMatch(/^VIRTUAL/);
  expect(info.project_name).toBe("esp32-photoframe-staging");
});

test("stub endpoints respond success", async () => {
  for (const p of ["/api/keep_alive", "/api/rotate", "/api/sleep"]) {
    const res = await fetch(`${base}${p}`, { method: "POST" });
    expect(res.status).toBe(200);
  }
});
