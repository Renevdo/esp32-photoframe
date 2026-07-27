import { jest } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";
import { createCanvas } from "canvas";
import { getDefaultParams } from "@aitjcize/epaper-image-convert";
import { StagingStore } from "../staging/store.js";
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "srv-"));
  store = new StagingStore(dir);
  store.init();
  server = await createStagingServer(store, ctx, { port: 0, silent: true });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterEach(() => {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function testPng() {
  const c = createCanvas(64, 64);
  c.getContext("2d").fillRect(0, 0, 64, 64);
  return c.toBuffer("image/png");
}

test("upload, deploy, changes, file download, ack round trip", async () => {
  let res = await fetch(`${base}/api/staging/photos/fam/pic.png`, {
    method: "PUT",
    body: testPng(),
  });
  expect(res.status).toBe(200);

  res = await fetch(`${base}/api/staging/deploy`, { method: "POST" });
  expect((await res.json()).seq).toBe(1);

  res = await fetch(`${base}/api/sync/changes?since=0&device=TEST01`);
  const changes = await res.json();
  expect(changes.latest_seq).toBe(1);
  expect(changes.ops).toHaveLength(2); // epdgz + jpg

  const put = changes.ops.find((o) => o.file.endsWith(".epdgz"));
  res = await fetch(`${base}/api/sync/file/${put.album}/${put.file}`);
  expect(res.status).toBe(200);
  expect((await res.arrayBuffer()).byteLength).toBe(put.size);

  res = await fetch(`${base}/api/sync/ack`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ device: "TEST01", seq: 1 }),
  });
  expect(res.status).toBe(200);

  res = await fetch(`${base}/api/staging/status`);
  const status = await res.json();
  expect(status.devices).toEqual({ TEST01: 1 });
  expect(status.pending_ops).toBe(0);
});

test("changes past head returns 409 reset", async () => {
  const res = await fetch(`${base}/api/sync/changes?since=9&device=TEST01`);
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({ reset: true });
});

test("path traversal is rejected", async () => {
  const res = await fetch(`${base}/api/sync/file/..%2F..%2Fetc/passwd`);
  expect(res.status).toBe(400);
});

test("client errors map to 4xx, not 500", async () => {
  // malformed ack JSON
  let res = await fetch(`${base}/api/sync/ack`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not json",
  });
  expect(res.status).toBe(400);

  // invalid device id / non-integer seq
  for (const body of [
    { device: "../evil", seq: 1 },
    { device: "OK", seq: 1.5 },
    { device: "OK", seq: -1 },
  ]) {
    res = await fetch(`${base}/api/sync/ack`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(400);
  }

  // oversized body hits the cap as 413
  res = await fetch(`${base}/api/sync/ack`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: `{"device":"OK","seq":1,"pad":"${"x".repeat(8192)}"}`,
  });
  expect(res.status).toBe(413);

  // unsafe upload album name is a 400 from intake
  res = await fetch(`${base}/api/staging/photos/..%2Fevil/pic.png`, {
    method: "PUT",
    body: "data",
  });
  expect(res.status).toBe(400);
});

test("albums list and photo delete", async () => {
  await fetch(`${base}/api/staging/photos/fam/pic.png`, {
    method: "PUT",
    body: testPng(),
  });
  let res = await fetch(`${base}/api/staging/albums`);
  const { albums } = await res.json();
  expect(albums).toEqual([
    { name: "fam", photos: [{ base: "pic", size: expect.any(Number) }] },
  ]);

  res = await fetch(`${base}/api/staging/photos/fam/pic`, {
    method: "DELETE",
  });
  expect(res.status).toBe(200);
  res = await fetch(`${base}/api/staging/albums`);
  expect((await res.json()).albums).toEqual([{ name: "fam", photos: [] }]);
});
