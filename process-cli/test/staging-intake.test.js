import { jest } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";
import { createCanvas } from "canvas";
import { StagingStore } from "../staging/store.js";
import { addPhoto, removePhoto, removeAlbum } from "../staging/intake.js";
import { getDefaultParams } from "@aitjcize/epaper-image-convert";

jest.setTimeout(30000);

let dir, store;
const ctx = {
  params: getDefaultParams(),
  palette: null,
  width: 200,
  height: 120,
  orientation: "landscape",
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "intake-"));
  store = new StagingStore(dir);
  store.init();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function testPng() {
  const c = createCanvas(64, 64);
  const g = c.getContext("2d");
  g.fillStyle = "#3366aa";
  g.fillRect(0, 0, 64, 64);
  return c.toBuffer("image/png");
}

test("addPhoto produces epdgz + jpg mirrored to SD layout", async () => {
  const { base } = await addPhoto(store, "fam", "pic.png", testPng(), ctx);
  expect(base).toBe("pic");
  expect(fs.existsSync(path.join(store.albumsDir, "fam", "pic.epdgz"))).toBe(
    true,
  );
  expect(fs.existsSync(path.join(store.albumsDir, "fam", "pic.jpg"))).toBe(
    true,
  );
  expect(fs.existsSync(path.join(store.originalsDir, "fam", "pic.png"))).toBe(
    true,
  );
  expect(store.pendingOps().map((o) => o.op)).toEqual(["put", "put"]);
});

test("removePhoto deletes the pair and the original", async () => {
  await addPhoto(store, "fam", "pic.png", testPng(), ctx);
  removePhoto(store, "fam", "pic");
  expect(fs.readdirSync(path.join(store.albumsDir, "fam"))).toEqual([]);
  expect(fs.readdirSync(path.join(store.originalsDir, "fam"))).toEqual([]);
});

test("removeAlbum removes both trees", async () => {
  await addPhoto(store, "fam", "pic.png", testPng(), ctx);
  removeAlbum(store, "fam");
  expect(fs.existsSync(path.join(store.albumsDir, "fam"))).toBe(false);
  expect(fs.existsSync(path.join(store.originalsDir, "fam"))).toBe(false);
});

test("rejects unsafe names", async () => {
  await expect(
    addPhoto(store, "../evil", "pic.png", testPng(), ctx),
  ).rejects.toThrow(/name/i);
});
