# Offline Album Staging + Deploy-on-Wake Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prepare photos locally in a staging server at any time; the deep-sleeping device pulls deployed changes to its SD card on its next scheduled wake.

**Architecture:** A staging mode inside `process-cli` (shares canvas/heic/epaper-image-convert deps) keeps albums mirrored to the SD layout plus a deployment journal with monotonically increasing sequence numbers. New firmware module `sync_client` runs on every timer wake when `sync_server_url` is configured: GET pending ops, apply idempotently to SD (download to temp then rename, size-match skip for resume), POST ack, advance seq stored in NVS.

**Tech Stack:** Node.js >= 18 (ESM, jest), ESP-IDF C (esp_http_client, cJSON, NVS), Vue 3 webapp, GoogleTest host tests.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-27-offline-album-sync-design.md` (Phase 1)
- No em-dash characters in any created content (issues, PRs, commits, code comments)
- Node engines: `>=18.0.0` (process-cli/package.json); plain `node:http`, no new npm deps
- NVS keys max 15 chars
- Do NOT commit `webapp/package.json` / `webapp/package-lock.json` (unrelated local user modifications); never `git add -A`
- Branch: `feature/offline-album-sync` off `main`, PR to `Renevdo/esp32-photoframe` main, closes #1
- SD layout mirrored by staging store: `albums/<album>/<name>.epdgz` + `<name>.jpg` (device: `/sdcard/images/<album>/`)
- Album and file names from the network are validated: no `/`, no `..`, non-empty, < 64 chars
- Commit messages end with the Co-Authored-By + Claude-Session footer

---

### Task 1: Staging manifest + diff + coalesce (pure logic)

**Files:**
- Create: `process-cli/staging/ops.js`
- Test: `process-cli/test/staging-ops.test.js`

**Interfaces:**
- Produces:
  - `computeOps(prevManifest, currManifest) -> op[]` where manifest is `{ "album/file": {size, mtimeMs} }` and op is `{op:'put'|'delete', album, file, size?}` plus `{op:'rmdir', album}` for albums with no remaining files
  - `coalesceOps(opsArrays) -> op[]` last-wins per `album/file` key (rmdir keyed per album, dropped if a later put recreates the album)
  - `isSafeName(name) -> boolean`

- [ ] **Step 1: Write failing tests** in `process-cli/test/staging-ops.test.js`:

```javascript
import { computeOps, coalesceOps, isSafeName } from "../staging/ops.js";

const f = (size, mtimeMs = 1) => ({ size, mtimeMs });

describe("computeOps", () => {
  test("new file becomes put", () => {
    expect(computeOps({}, { "a/x.epdgz": f(10) })).toEqual([
      { op: "put", album: "a", file: "x.epdgz", size: 10 },
    ]);
  });
  test("unchanged file emits nothing", () => {
    expect(computeOps({ "a/x.epdgz": f(10) }, { "a/x.epdgz": f(10) })).toEqual([]);
  });
  test("size or mtime change becomes put", () => {
    expect(computeOps({ "a/x.epdgz": f(10) }, { "a/x.epdgz": f(11) })).toHaveLength(1);
    expect(computeOps({ "a/x.epdgz": f(10, 1) }, { "a/x.epdgz": f(10, 2) })).toHaveLength(1);
  });
  test("removed file becomes delete; album emptied adds rmdir", () => {
    expect(computeOps({ "a/x.epdgz": f(10), "a/x.jpg": f(2) }, {})).toEqual(
      expect.arrayContaining([
        { op: "delete", album: "a", file: "x.epdgz" },
        { op: "delete", album: "a", file: "x.jpg" },
        { op: "rmdir", album: "a" },
      ]),
    );
  });
  test("album with remaining files gets no rmdir", () => {
    const ops = computeOps({ "a/x.epdgz": f(10), "a/y.epdgz": f(5) }, { "a/y.epdgz": f(5) });
    expect(ops).toEqual([{ op: "delete", album: "a", file: "x.epdgz" }]);
  });
});

describe("coalesceOps", () => {
  test("later op wins per file", () => {
    const out = coalesceOps([
      [{ op: "put", album: "a", file: "x.epdgz", size: 10 }],
      [{ op: "delete", album: "a", file: "x.epdgz" }],
    ]);
    expect(out).toEqual([{ op: "delete", album: "a", file: "x.epdgz" }]);
  });
  test("rmdir dropped when later deployment recreates the album", () => {
    const out = coalesceOps([
      [{ op: "rmdir", album: "a" }],
      [{ op: "put", album: "a", file: "x.epdgz", size: 10 }],
    ]);
    expect(out).toEqual([{ op: "put", album: "a", file: "x.epdgz", size: 10 }]);
  });
  test("deletes come before puts, rmdir last", () => {
    const out = coalesceOps([
      [
        { op: "put", album: "b", file: "y.epdgz", size: 3 },
        { op: "delete", album: "a", file: "x.epdgz" },
        { op: "rmdir", album: "a" },
      ],
    ]);
    expect(out.map((o) => o.op)).toEqual(["delete", "put", "rmdir"]);
  });
});

describe("isSafeName", () => {
  test.each(["ok.epdgz", "My Album", "a-b_c.jpg"])("accepts %s", (n) =>
    expect(isSafeName(n)).toBe(true),
  );
  test.each(["", "..", "a/b", "a\\b", ".", "x".repeat(64)])("rejects %j", (n) =>
    expect(isSafeName(n)).toBe(false),
  );
});
```

- [ ] **Step 2: Run to verify failure**: `cd process-cli && npm test -- staging-ops` expecting "Cannot find module".

- [ ] **Step 3: Implement `process-cli/staging/ops.js`:**

```javascript
/**
 * Pure deployment-diff logic for the staging store.
 * A manifest maps "album/file" to {size, mtimeMs}.
 */

export function isSafeName(name) {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length < 64 &&
    name !== "." &&
    name !== ".." &&
    !name.includes("/") &&
    !name.includes("\\")
  );
}

function splitKey(key) {
  const idx = key.indexOf("/");
  return { album: key.slice(0, idx), file: key.slice(idx + 1) };
}

export function computeOps(prevManifest, currManifest) {
  const ops = [];
  for (const [key, meta] of Object.entries(currManifest)) {
    const prev = prevManifest[key];
    if (!prev || prev.size !== meta.size || prev.mtimeMs !== meta.mtimeMs) {
      const { album, file } = splitKey(key);
      ops.push({ op: "put", album, file, size: meta.size });
    }
  }
  const removedAlbums = new Set();
  for (const key of Object.keys(prevManifest)) {
    if (!currManifest[key]) {
      const { album, file } = splitKey(key);
      ops.push({ op: "delete", album, file });
      removedAlbums.add(album);
    }
  }
  for (const album of removedAlbums) {
    const stillHasFiles = Object.keys(currManifest).some((k) =>
      k.startsWith(album + "/"),
    );
    if (!stillHasFiles) {
      ops.push({ op: "rmdir", album });
    }
  }
  return sortOps(ops);
}

export function coalesceOps(opsArrays) {
  const byFile = new Map(); // "album/file" -> op
  const rmdirs = new Map(); // album -> true
  for (const ops of opsArrays) {
    for (const op of ops) {
      if (op.op === "rmdir") {
        rmdirs.set(op.album, true);
      } else {
        byFile.set(`${op.album}/${op.file}`, op);
        if (op.op === "put") {
          rmdirs.delete(op.album); // album lives again
        }
      }
    }
  }
  const ops = [...byFile.values()];
  for (const album of rmdirs.keys()) {
    ops.push({ op: "rmdir", album });
  }
  return sortOps(ops);
}

// deletes first (free space before downloads), puts next, rmdirs last
function sortOps(ops) {
  const rank = { delete: 0, put: 1, rmdir: 2 };
  return [...ops].sort((a, b) => rank[a.op] - rank[b.op]);
}
```

- [ ] **Step 4: Run tests**: `cd process-cli && npm test -- staging-ops` expecting PASS.
- [ ] **Step 5: Commit** `feat(staging): deployment diff and coalesce logic`.

---

### Task 2: StagingStore (state.json, deploy journal, changesSince, ack)

**Files:**
- Create: `process-cli/staging/store.js`
- Test: `process-cli/test/staging-store.test.js`

**Interfaces:**
- Consumes: `computeOps`, `coalesceOps` from Task 1
- Produces: `class StagingStore`:
  - `constructor(storeDir)`, `init()`
  - `albumsDir` (string), `originalsDir` (string)
  - `currentManifest() -> manifest` (scans `albumsDir`)
  - `pendingOps() -> op[]` (diff last deployed manifest vs current)
  - `deploy() -> {seq, ops}` (no-op returns `{seq: latestSeq, ops: []}` when nothing pending)
  - `changesSince(sinceSeq) -> {latestSeq, ops} | {reset: true}` (reset when sinceSeq > latestSeq)
  - `ack(deviceId, seq)`, `deviceStatus() -> {deviceId: ackedSeq}`
  - `latestSeq` (number, 0 when never deployed)

- [ ] **Step 1: Write failing tests** in `process-cli/test/staging-store.test.js`:

```javascript
import fs from "fs";
import os from "os";
import path from "path";
import { StagingStore } from "../staging/store.js";

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "staging-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function put(store, album, file, content) {
  fs.mkdirSync(path.join(store.albumsDir, album), { recursive: true });
  fs.writeFileSync(path.join(store.albumsDir, album, file), content);
}

test("fresh store has seq 0 and no pending ops", () => {
  const s = new StagingStore(dir);
  s.init();
  expect(s.latestSeq).toBe(0);
  expect(s.pendingOps()).toEqual([]);
});

test("deploy snapshots pending changes and bumps seq", () => {
  const s = new StagingStore(dir);
  s.init();
  put(s, "fam", "a.epdgz", "data");
  expect(s.pendingOps()).toHaveLength(1);
  const { seq, ops } = s.deploy();
  expect(seq).toBe(1);
  expect(ops).toEqual([{ op: "put", album: "fam", file: "a.epdgz", size: 4 }]);
  expect(s.pendingOps()).toEqual([]);
});

test("deploy with nothing pending does not bump seq", () => {
  const s = new StagingStore(dir);
  s.init();
  put(s, "fam", "a.epdgz", "data");
  s.deploy();
  expect(s.deploy()).toEqual({ seq: 1, ops: [] });
});

test("changesSince coalesces across deployments and persists across reload", () => {
  const s = new StagingStore(dir);
  s.init();
  put(s, "fam", "a.epdgz", "data");
  s.deploy(); // seq 1
  fs.unlinkSync(path.join(s.albumsDir, "fam", "a.epdgz"));
  put(s, "fam", "b.epdgz", "other!");
  s.deploy(); // seq 2

  const s2 = new StagingStore(dir);
  s2.init();
  const { latestSeq, ops } = s2.changesSince(0);
  expect(latestSeq).toBe(2);
  expect(ops).toEqual(
    expect.arrayContaining([
      { op: "delete", album: "fam", file: "a.epdgz" },
      { op: "put", album: "fam", file: "b.epdgz", size: 6 },
    ]),
  );
  expect(s2.changesSince(2)).toEqual({ latestSeq: 2, ops: [] });
});

test("changesSince past the head signals reset", () => {
  const s = new StagingStore(dir);
  s.init();
  expect(s.changesSince(7)).toEqual({ reset: true });
});

test("ack records per-device seq", () => {
  const s = new StagingStore(dir);
  s.init();
  put(s, "fam", "a.epdgz", "data");
  s.deploy();
  s.ack("AABBCC", 1);
  expect(s.deviceStatus()).toEqual({ AABBCC: 1 });
});
```

- [ ] **Step 2: Run to verify failure**: `cd process-cli && npm test -- staging-store` expecting "Cannot find module".

- [ ] **Step 3: Implement `process-cli/staging/store.js`:**

```javascript
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
      this.state = JSON.parse(fs.readFileSync(this.statePath, "utf8"));
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
    this.state.deployments.push({ seq, ops, manifest, at: new Date().toISOString() });
    this.saveState();
    return { seq, ops };
  }

  changesSince(sinceSeq) {
    if (sinceSeq > this.latestSeq) {
      return { reset: true };
    }
    const newer = this.state.deployments.filter((d) => d.seq > sinceSeq);
    return { latestSeq: this.latestSeq, ops: coalesceOps(newer.map((d) => d.ops)) };
  }

  ack(deviceId, seq) {
    this.state.devices[deviceId] = seq;
    this.saveState();
  }

  deviceStatus() {
    return { ...this.state.devices };
  }
}
```

- [ ] **Step 4: Run tests**: `cd process-cli && npm test -- staging-store` expecting PASS.
- [ ] **Step 5: Commit** `feat(staging): staging store with deployment journal`.

---

### Task 3: Photo intake (process upload to epdgz + thumbnail)

**Files:**
- Create: `process-cli/staging/intake.js`
- Test: `process-cli/test/staging-intake.test.js`

**Interfaces:**
- Consumes: `processImagePipeline` from `process-cli/utils.js`, `createEPDGZ`, `generateThumbnail` from `@aitjcize/epaper-image-convert`, `StagingStore` from Task 2
- Produces:
  - `addPhoto(store, album, filename, buffer, ctx) -> {base}` writes `originals/<album>/<filename>`, `albums/<album>/<base>.epdgz`, `albums/<album>/<base>.jpg`; `base` is filename without extension; `ctx = {params, palette, width, height, orientation}`
  - `removePhoto(store, album, base)` removes the epdgz + jpg pair and any original with that base
  - `removeAlbum(store, album)` removes album from `albums/` and `originals/`

- [ ] **Step 1: Write failing tests** in `process-cli/test/staging-intake.test.js` (generate a small PNG with node-canvas, no fixture files needed):

```javascript
import fs from "fs";
import os from "os";
import path from "path";
import { createCanvas } from "canvas";
import { StagingStore } from "../staging/store.js";
import { addPhoto, removePhoto, removeAlbum } from "../staging/intake.js";
import { getDefaultParams } from "@aitjcize/epaper-image-convert";

jest.setTimeout(30000);

let dir, store;
const ctx = { params: getDefaultParams(), palette: null, width: 200, height: 120, orientation: "landscape" };

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
  expect(fs.existsSync(path.join(store.albumsDir, "fam", "pic.epdgz"))).toBe(true);
  expect(fs.existsSync(path.join(store.albumsDir, "fam", "pic.jpg"))).toBe(true);
  expect(fs.existsSync(path.join(store.originalsDir, "fam", "pic.png"))).toBe(true);
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
  await expect(addPhoto(store, "../evil", "pic.png", testPng(), ctx)).rejects.toThrow(/name/i);
});
```

- [ ] **Step 2: Run to verify failure**: `cd process-cli && npm test -- staging-intake`.

- [ ] **Step 3: Implement `process-cli/staging/intake.js`:**

```javascript
/**
 * Photo intake: original upload buffer -> device-ready epdgz + jpg thumbnail
 * in the staging store, using the same pipeline as the CLI.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { createCanvas } from "canvas";
import { createEPDGZ, generateThumbnail } from "@aitjcize/epaper-image-convert";
import { processImagePipeline } from "../utils.js";
import { isSafeName } from "./ops.js";

export async function addPhoto(store, album, filename, buffer, ctx) {
  if (!isSafeName(album) || !isSafeName(filename)) {
    throw new Error("unsafe album or file name");
  }
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);

  // The pipeline loads from a path (HEIC/EXIF handling), so stage to a temp file.
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "intake-")), filename);
  fs.writeFileSync(tmp, buffer);
  try {
    const { canvas, originalCanvas } = await processImagePipeline(
      tmp,
      ctx.params,
      ctx.width,
      ctx.height,
      ctx.palette,
      { autoOrient: true, orientation: ctx.orientation || "landscape" },
    );
    const epdgz = await createEPDGZ(canvas);
    const thumbCanvas = generateThumbnail(originalCanvas, 400, createCanvas);
    const thumb = thumbCanvas.toBuffer("image/jpeg", { quality: 0.8 });

    const albumPath = path.join(store.albumsDir, album);
    const origPath = path.join(store.originalsDir, album);
    fs.mkdirSync(albumPath, { recursive: true });
    fs.mkdirSync(origPath, { recursive: true });
    fs.writeFileSync(path.join(albumPath, `${base}.epdgz`), epdgz);
    fs.writeFileSync(path.join(albumPath, `${base}.jpg`), thumb);
    fs.writeFileSync(path.join(origPath, filename), buffer);
    return { base };
  } finally {
    fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
  }
}

export function removePhoto(store, album, base) {
  if (!isSafeName(album) || !isSafeName(base)) {
    throw new Error("unsafe album or file name");
  }
  for (const f of [`${base}.epdgz`, `${base}.jpg`]) {
    fs.rmSync(path.join(store.albumsDir, album, f), { force: true });
  }
  const origAlbum = path.join(store.originalsDir, album);
  if (fs.existsSync(origAlbum)) {
    for (const f of fs.readdirSync(origAlbum)) {
      if (path.basename(f, path.extname(f)) === base) {
        fs.rmSync(path.join(origAlbum, f), { force: true });
      }
    }
  }
}

export function removeAlbum(store, album) {
  if (!isSafeName(album)) {
    throw new Error("unsafe album name");
  }
  fs.rmSync(path.join(store.albumsDir, album), { recursive: true, force: true });
  fs.rmSync(path.join(store.originalsDir, album), { recursive: true, force: true });
}
```

- [ ] **Step 4: Run tests**: `cd process-cli && npm test -- staging-intake` expecting PASS.
- [ ] **Step 5: Commit** `feat(staging): photo intake pipeline to epdgz + thumbnail`.

---

### Task 4: Staging HTTP server (sync API + staging API + minimal UI)

**Files:**
- Create: `process-cli/staging/staging-server.js`
- Create: `process-cli/staging/ui.js` (exports the HTML page string)
- Test: `process-cli/test/staging-server.test.js`

**Interfaces:**
- Consumes: `StagingStore`, `addPhoto`, `removePhoto`, `removeAlbum`, `isSafeName`
- Produces: `createStagingServer(store, ctx, options) -> Promise<http.Server>`; `options = {port, silent}`. Routes:
  - `GET  /api/sync/changes?since=N&device=ID` -> `{latest_seq, ops:[...]}` or 409 `{reset:true}`
  - `GET  /api/sync/file/<album>/<file>` -> file bytes from `albumsDir`
  - `POST /api/sync/ack` JSON `{device, seq}` -> `{ok:true}`
  - `GET  /api/staging/albums` -> `{albums:[{name, photos:[{base, size}]}]}` (photos keyed by `.epdgz` entries)
  - `PUT  /api/staging/photos/<album>/<filename>` raw body -> `{base}`
  - `DELETE /api/staging/photos/<album>/<base>` -> `{ok:true}`
  - `DELETE /api/staging/albums/<album>` -> `{ok:true}`
  - `POST /api/staging/deploy` -> `{seq, ops_count}`
  - `GET  /api/staging/status` -> `{latest_seq, pending_ops, devices}`
  - `GET  /api/staging/thumbnail/<album>/<base>` -> jpg
  - `GET  /` -> HTML UI

- [ ] **Step 1: Write failing tests** in `process-cli/test/staging-server.test.js` using global `fetch` (Node 18+) and an ephemeral port:

```javascript
import fs from "fs";
import os from "os";
import path from "path";
import { createCanvas } from "canvas";
import { getDefaultParams } from "@aitjcize/epaper-image-convert";
import { StagingStore } from "../staging/store.js";
import { createStagingServer } from "../staging/staging-server.js";

jest.setTimeout(30000);

let dir, store, server, base;
const ctx = { params: getDefaultParams(), palette: null, width: 200, height: 120, orientation: "landscape" };

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

test("albums list and photo delete", async () => {
  await fetch(`${base}/api/staging/photos/fam/pic.png`, { method: "PUT", body: testPng() });
  let res = await fetch(`${base}/api/staging/albums`);
  const { albums } = await res.json();
  expect(albums).toEqual([{ name: "fam", photos: [{ base: "pic", size: expect.any(Number) }] }]);

  res = await fetch(`${base}/api/staging/photos/fam/pic`, { method: "DELETE" });
  expect(res.status).toBe(200);
  res = await fetch(`${base}/api/staging/albums`);
  expect((await res.json()).albums).toEqual([{ name: "fam", photos: [] }]);
});
```

- [ ] **Step 2: Run to verify failure**: `cd process-cli && npm test -- staging-server`.

- [ ] **Step 3: Implement `process-cli/staging/staging-server.js`** (plain `node:http`, route on method + decoded path segments; every segment validated with `isSafeName`; raw body collected with a 50 MB cap; JSON errors as `{error}` with 400/404/409/500). Key routing skeleton:

```javascript
import http from "http";
import fs from "fs";
import path from "path";
import { addPhoto, removePhoto, removeAlbum } from "./intake.js";
import { isSafeName } from "./ops.js";
import { UI_HTML } from "./ui.js";

const MAX_UPLOAD = 50 * 1024 * 1024;

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json" });
  res.end(body);
}

function collectBody(req, cap) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (c) => {
      total += c.length;
      if (total > cap) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function createStagingServer(store, ctx, options = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, "http://localhost");
      const seg = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      await route(req, res, u, seg);
    } catch (err) {
      json(res, err.statusCode || 500, { error: err.message });
    }
  });

  async function route(req, res, u, seg) {
    // GET /
    if (req.method === "GET" && seg.length === 0) {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(UI_HTML);
      return;
    }
    // GET /api/sync/changes?since=N&device=ID
    if (req.method === "GET" && seg.join("/") === "api/sync/changes") {
      const since = parseInt(u.searchParams.get("since") || "0", 10);
      const result = store.changesSince(Number.isFinite(since) ? since : 0);
      if (result.reset) return json(res, 409, { reset: true });
      return json(res, 200, { latest_seq: result.latestSeq, ops: result.ops });
    }
    // GET /api/sync/file/<album>/<file>
    if (req.method === "GET" && seg[0] === "api" && seg[1] === "sync" && seg[2] === "file" && seg.length === 5) {
      const [album, file] = [seg[3], seg[4]];
      if (!isSafeName(album) || !isSafeName(file)) return json(res, 400, { error: "bad name" });
      const p = path.join(store.albumsDir, album, file);
      if (!fs.existsSync(p)) return json(res, 404, { error: "not found" });
      const data = fs.readFileSync(p);
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": data.length,
      });
      res.end(data);
      return;
    }
    // POST /api/sync/ack
    if (req.method === "POST" && seg.join("/") === "api/sync/ack") {
      const body = JSON.parse((await collectBody(req, 4096)).toString());
      if (typeof body.device !== "string" || typeof body.seq !== "number") {
        return json(res, 400, { error: "device and seq required" });
      }
      store.ack(body.device, body.seq);
      return json(res, 200, { ok: true });
    }
    // ... staging routes (albums list, photo PUT/DELETE, album DELETE,
    //     deploy, status, thumbnail) follow the same pattern, calling
    //     addPhoto/removePhoto/removeAlbum/store.deploy()/store.pendingOps()
    json(res, 404, { error: "not found" });
  }

  return new Promise((resolve, reject) => {
    server.listen(options.port ?? 8090, () => {
      if (!options.silent) {
        console.log(`Staging server on http://localhost:${server.address().port}`);
      }
      resolve(server);
    });
    server.on("error", reject);
  });
}
```

The staging routes (elided comment above) must be fully implemented in this task:
`GET api/staging/albums` scans `store.albumsDir` listing `.epdgz` entries as `{base, size}`;
`PUT api/staging/photos/<album>/<filename>` collects raw body (MAX_UPLOAD cap) and calls `addPhoto(store, album, filename, body, ctx)`;
`DELETE api/staging/photos/<album>/<base>` calls `removePhoto`;
`DELETE api/staging/albums/<album>` calls `removeAlbum`;
`POST api/staging/deploy` returns `{seq, ops_count: ops.length}` from `store.deploy()`;
`GET api/staging/status` returns `{latest_seq: store.latestSeq, pending_ops: store.pendingOps().length, devices: store.deviceStatus()}`;
`GET api/staging/thumbnail/<album>/<base>` serves `<base>.jpg` as `image/jpeg`.

- [ ] **Step 4: Implement `process-cli/staging/ui.js`**: single exported `UI_HTML` template string; vanilla JS page with album list, file input for uploads (PUT per file), per-photo thumbnail + delete button, Deploy button showing `pending_ops`, device ack status footer. No framework, fetch() against the staging API.

- [ ] **Step 5: Run tests**: `cd process-cli && npm test -- staging-server` expecting PASS.
- [ ] **Step 6: Commit** `feat(staging): staging HTTP server with sync API and web UI`.

---

### Task 5: CLI wiring (--staging mode with cached device parameters)

**Files:**
- Modify: `process-cli/cli.js` (add `--staging <dir>` and `--staging-port <port>` options; add staging branch in the action before single-file processing)
- Modify: `process-cli/package.json` (`files` array: add `staging/`)
- Modify: `process-cli/README.md` (Staging Mode section)
- Test: manual smoke test (documented below); route/store logic is covered by Tasks 1-4

**Interfaces:**
- Consumes: `createStagingServer`, `StagingStore`, existing `fetchDeviceSettings`, `fetchDevicePalette`, `fetchDeviceOrientation`, `fetchDeviceSystemInfo` from cli.js
- Produces: `photoframe-process --staging ~/PhotoframeStaging --staging-port 8090 [--device-parameters --host photoframe.local]`

- [ ] **Step 1: Add options to commander** next to the existing `--serve` options:

```javascript
.option("--staging <dir>", "Start staging server for offline album preparation")
.option("--staging-port <port>", "Port for staging server", "8090")
```

- [ ] **Step 2: Add the staging branch** in the action handler before the `--serve` branch, reusing the existing device-parameter fetching, with a cache file so the device does not need to be awake:

```javascript
if (options.staging) {
  const { StagingStore } = await import("./staging/store.js");
  const { createStagingServer } = await import("./staging/staging-server.js");

  const store = new StagingStore(options.staging);
  store.init();

  const cachePath = path.join(options.staging, "device-params.json");
  let ctx = {
    params: { ...DEFAULT_PARAMS },
    palette: null,
    width: 800,
    height: 480,
    orientation: "landscape",
  };
  if (fs.existsSync(cachePath)) {
    ctx = { ...ctx, ...JSON.parse(fs.readFileSync(cachePath, "utf8")) };
    console.log("Loaded cached device parameters");
  }
  if (options.deviceParameters) {
    try {
      const settings = await fetchDeviceSettings(options.host);
      const palette = await fetchDevicePalette(options.host);
      const orientation = await fetchDeviceOrientation(options.host);
      const sysInfo = await fetchDeviceSystemInfo(options.host);
      ctx = {
        params: { ...ctx.params, ...settings },
        palette,
        orientation,
        width: sysInfo?.display_width || ctx.width,
        height: sysInfo?.display_height || ctx.height,
      };
      fs.writeFileSync(cachePath, JSON.stringify(ctx, null, 2));
      console.log("Fetched and cached device parameters");
    } catch (e) {
      console.log(`Device not reachable (${e.message}), using cached/default parameters`);
    }
  }

  await createStagingServer(store, ctx, { port: parseInt(options.stagingPort, 10) });
  console.log(`Staging store: ${options.staging}`);
  return; // keep process alive serving
}
```

Note: verify the exact field names `display_width` / `display_height` against `fetchDeviceSystemInfo` in cli.js while implementing; use whatever that function already returns (the serve mode nearby does the same).

- [ ] **Step 3: Make `input` argument optional** for staging mode (commander: change `.argument("<input>", ...)` handling; `--staging` and `--serve` both run without input, follow whatever pattern `--serve` uses; if `--serve` requires input, allow `--staging` to be used with the argument omitted by declaring the argument `[input]` and erroring when neither input nor `--staging` is given).

- [ ] **Step 4: Smoke test:**

```bash
cd process-cli
node cli.js --staging /tmp/staging-smoke --staging-port 18090 &
sleep 2
curl -s -X PUT --data-binary @test/fixtures/$(ls test/fixtures | head -1) \
  http://localhost:18090/api/staging/photos/smoke/test.jpg | grep base
curl -s -X POST http://localhost:18090/api/staging/deploy
curl -s "http://localhost:18090/api/sync/changes?since=0&device=SMOKE"
kill %1
```

Expected: upload returns `{"base":"test"}`, deploy returns `{"seq":1,...}`, changes lists 2 put ops. (If `test/fixtures` has no image, generate one with node-canvas as in the tests.)

- [ ] **Step 5: Update `process-cli/README.md`** with a "Staging Mode (offline album preparation)" section documenting the commands above and the deploy-on-wake flow.
- [ ] **Step 6: Run the full jest suite**: `cd process-cli && npm test` expecting PASS.
- [ ] **Step 7: Commit** `feat(staging): CLI staging mode with cached device parameters`.

---

### Task 6: Firmware config setting sync_server_url

**Files:**
- Modify: `main/config.h` (add `#define SYNC_SERVER_URL_MAX_LEN 256` near `IMAGE_URL_MAX_LEN`)
- Modify: `main/config_manager.h` (new section + getter/setter declarations)
- Modify: `main/config_manager.c` (static buffer, NVS key, load in init, setter/getter)
- Modify: `main/http_server.c` (config GET handler: add field)
- Modify: `main/utils.c` (`apply_config_from_json`: add field)
- Modify: `webapp/src/stores/settings.js` (syncServerUrl load/save mapping)
- Modify: `webapp/src/components/SettingsPanel.vue` (input field)

**Interfaces:**
- Produces: `config_manager_set_sync_server_url(const char*)`, `const char *config_manager_get_sync_server_url(void)`; JSON config field `sync_server_url`

- [ ] **Step 1: config.h**: after the `IMAGE_URL_MAX_LEN` define add:

```c
#define SYNC_SERVER_URL_MAX_LEN 256
```

- [ ] **Step 2: config_manager.h**: add before the Config Sync section:

```c
// ============================================================================
// Offline Album Sync
// ============================================================================

// Base URL of the local staging server (see docs/OFFLINE_ALBUM_SYNC.md).
// Empty string disables deploy-on-wake sync.
void config_manager_set_sync_server_url(const char *url);
const char *config_manager_get_sync_server_url(void);
```

- [ ] **Step 3: config_manager.c**: mirror the `image_url` pattern exactly (static buffer, load in `config_manager_init`, NVS-backed setter, plain getter). NVS key `"sync_srv_url"` (12 chars). No side effects on change. Follow the existing `NVS_..._KEY` define style used by `NVS_IMAGE_URL_KEY`:

```c
#define NVS_SYNC_SERVER_URL_KEY "sync_srv_url"
static char sync_server_url[SYNC_SERVER_URL_MAX_LEN] = {0};
```

In init (next to the image_url load):

```c
size_t sync_url_len = sizeof(sync_server_url);
if (nvs_get_str(nvs_handle, NVS_SYNC_SERVER_URL_KEY, sync_server_url, &sync_url_len) ==
    ESP_OK) {
    ESP_LOGI(TAG, "Loaded sync server URL from NVS: %s", sync_server_url);
}
```

Setter/getter (in the new Offline Album Sync section):

```c
void config_manager_set_sync_server_url(const char *url)
{
    const char *new_url = url ? url : "";
    strncpy(sync_server_url, new_url, SYNC_SERVER_URL_MAX_LEN - 1);
    sync_server_url[SYNC_SERVER_URL_MAX_LEN - 1] = '\0';

    nvs_handle_t nvs_handle;
    if (nvs_open(NVS_NAMESPACE, NVS_READWRITE, &nvs_handle) == ESP_OK) {
        if (sync_server_url[0] != '\0') {
            nvs_set_str(nvs_handle, NVS_SYNC_SERVER_URL_KEY, sync_server_url);
        } else {
            nvs_erase_key(nvs_handle, NVS_SYNC_SERVER_URL_KEY);
        }
        nvs_commit(nvs_handle);
        nvs_close(nvs_handle);
    }
    ESP_LOGI(TAG, "Sync server URL set to: %s",
             sync_server_url[0] ? sync_server_url : "(empty)");
}

const char *config_manager_get_sync_server_url(void)
{
    return sync_server_url;
}
```

- [ ] **Step 4: http_server.c** config GET handler, next to the `image_url` field:

```c
cJSON_AddStringToObject(root, "sync_server_url", config_manager_get_sync_server_url());
```

- [ ] **Step 5: utils.c** `apply_config_from_json`, next to the `image_url` handling (no cert-pin logic, plain set):

```c
item = cJSON_GetObjectItem(root, "sync_server_url");
if (item && cJSON_IsString(item)) {
    config_manager_set_sync_server_url(item->valuestring);
}
```

- [ ] **Step 6: webapp**: `stores/settings.js`: add `syncServerUrl: ""` to `deviceSettings`, load `data.sync_server_url || ""` where `image_url` is loaded, and include `sync_server_url: deviceSettings.value.syncServerUrl` in the save payload. `SettingsPanel.vue`: add a text input labeled "Sync Server URL" with help text "Base URL of the local staging server (e.g. http://192.168.1.50:8090). Leave empty to disable. Note: when set, the frame connects to WiFi on every scheduled wake, which slightly increases battery use." Place it in the same section as the auto-rotate settings, following the exact markup of the Image URL field.

- [ ] **Step 7: Build webapp to check it compiles**: `cd webapp && npm run build` expecting success (do not commit package.json/package-lock.json changes if npm modifies them).
- [ ] **Step 8: Commit** `feat: sync_server_url config setting` (firmware + webapp files only).

---

### Task 7: Firmware sync op parsing (pure C) + host test

**Files:**
- Create: `main/sync_ops.c`, `main/sync_ops.h`
- Modify: `main/CMakeLists.txt` (add `sync_ops.c` to SRCS; follow how other .c files are listed)
- Modify: `host_tests/CMakeLists.txt` (new `sync_ops_test` target; fetch cJSON via FetchContent)
- Test: `host_tests/test_sync_ops.cpp`

**Interfaces:**
- Produces (`main/sync_ops.h`):

```c
#ifndef SYNC_OPS_H
#define SYNC_OPS_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define SYNC_NAME_MAX_LEN 64
#define SYNC_MAX_OPS 256

typedef enum {
    SYNC_OP_PUT,
    SYNC_OP_DELETE,
    SYNC_OP_RMDIR,
} sync_op_type_t;

typedef struct {
    sync_op_type_t type;
    char album[SYNC_NAME_MAX_LEN];
    char file[SYNC_NAME_MAX_LEN];  // empty for rmdir
    int32_t size;                  // put only, -1 otherwise
} sync_op_t;

typedef struct {
    int64_t latest_seq;
    bool reset;
    int op_count;
    sync_op_t ops[SYNC_MAX_OPS];
} sync_changes_t;

// Parse the /api/sync/changes JSON response. Returns false on malformed
// JSON, unknown op types, unsafe names (slash, dots, empty, too long), or
// more than SYNC_MAX_OPS ops.
bool sync_ops_parse(const char *json, sync_changes_t *out);

// Validate a single path segment received from the network.
bool sync_name_is_safe(const char *name);

#endif
```

- [ ] **Step 1: Write failing tests** in `host_tests/test_sync_ops.cpp`:

```cpp
#include <gtest/gtest.h>

extern "C" {
#include "sync_ops.h"
}

TEST(SyncName, RejectsTraversalAndEmpty) {
    EXPECT_FALSE(sync_name_is_safe(""));
    EXPECT_FALSE(sync_name_is_safe(".."));
    EXPECT_FALSE(sync_name_is_safe("."));
    EXPECT_FALSE(sync_name_is_safe("a/b"));
    EXPECT_FALSE(sync_name_is_safe("a\\b"));
    std::string longname(64, 'x');
    EXPECT_FALSE(sync_name_is_safe(longname.c_str()));
    EXPECT_TRUE(sync_name_is_safe("Family Photos"));
    EXPECT_TRUE(sync_name_is_safe("pic.epdgz"));
}

TEST(SyncOpsParse, ParsesChangesResponse) {
    const char *json =
        "{\"latest_seq\": 3, \"ops\": ["
        "{\"op\":\"put\",\"album\":\"fam\",\"file\":\"a.epdgz\",\"size\":123},"
        "{\"op\":\"delete\",\"album\":\"fam\",\"file\":\"b.epdgz\"},"
        "{\"op\":\"rmdir\",\"album\":\"old\"}]}";
    sync_changes_t out;
    ASSERT_TRUE(sync_ops_parse(json, &out));
    EXPECT_EQ(out.latest_seq, 3);
    EXPECT_FALSE(out.reset);
    ASSERT_EQ(out.op_count, 3);
    EXPECT_EQ(out.ops[0].type, SYNC_OP_PUT);
    EXPECT_STREQ(out.ops[0].album, "fam");
    EXPECT_STREQ(out.ops[0].file, "a.epdgz");
    EXPECT_EQ(out.ops[0].size, 123);
    EXPECT_EQ(out.ops[1].type, SYNC_OP_DELETE);
    EXPECT_EQ(out.ops[2].type, SYNC_OP_RMDIR);
    EXPECT_STREQ(out.ops[2].album, "old");
}

TEST(SyncOpsParse, ParsesResetFlag) {
    sync_changes_t out;
    ASSERT_TRUE(sync_ops_parse("{\"reset\": true}", &out));
    EXPECT_TRUE(out.reset);
}

TEST(SyncOpsParse, RejectsBadInput) {
    sync_changes_t out;
    EXPECT_FALSE(sync_ops_parse("not json", &out));
    EXPECT_FALSE(sync_ops_parse("{\"latest_seq\":1,\"ops\":[{\"op\":\"chmod\"}]}", &out));
    EXPECT_FALSE(sync_ops_parse(
        "{\"latest_seq\":1,\"ops\":[{\"op\":\"put\",\"album\":\"../x\",\"file\":\"f\",\"size\":1}]}",
        &out));
    EXPECT_FALSE(sync_ops_parse("{\"ops\": []}", &out));  // missing latest_seq
}
```

- [ ] **Step 2: Extend `host_tests/CMakeLists.txt`** following the existing `cron_test` target pattern; add cJSON:

```cmake
FetchContent_Declare(
  cjson
  GIT_REPOSITORY https://github.com/DaveGamble/cJSON.git
  GIT_TAG v1.7.18
)
set(ENABLE_CJSON_TEST OFF CACHE BOOL "" FORCE)
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
FetchContent_MakeAvailable(cjson)

add_executable(
  sync_ops_test
  test_sync_ops.cpp
  ../main/sync_ops.c
)
target_link_libraries(sync_ops_test GTest::gtest_main cjson)
target_include_directories(
  sync_ops_test
  PRIVATE
  ${CMAKE_CURRENT_SOURCE_DIR}
  ${CMAKE_CURRENT_SOURCE_DIR}/../main
  ${cjson_SOURCE_DIR}
)
gtest_discover_tests(sync_ops_test)
```

- [ ] **Step 3: Run to verify failure**: `cmake -S host_tests -B host_tests/build && cmake --build host_tests/build && ctest --test-dir host_tests/build` expecting compile failure (missing sync_ops).

- [ ] **Step 4: Implement `main/sync_ops.c`:**

```c
#include "sync_ops.h"

#include <string.h>

#include "cJSON.h"

bool sync_name_is_safe(const char *name)
{
    if (!name) {
        return false;
    }
    size_t len = strlen(name);
    if (len == 0 || len >= SYNC_NAME_MAX_LEN) {
        return false;
    }
    if (strcmp(name, ".") == 0 || strcmp(name, "..") == 0) {
        return false;
    }
    if (strchr(name, '/') || strchr(name, '\\')) {
        return false;
    }
    return true;
}

static bool copy_name(char *dst, const cJSON *item)
{
    if (!cJSON_IsString(item) || !sync_name_is_safe(item->valuestring)) {
        return false;
    }
    strncpy(dst, item->valuestring, SYNC_NAME_MAX_LEN - 1);
    dst[SYNC_NAME_MAX_LEN - 1] = '\0';
    return true;
}

bool sync_ops_parse(const char *json, sync_changes_t *out)
{
    memset(out, 0, sizeof(*out));

    cJSON *root = cJSON_Parse(json);
    if (!root) {
        return false;
    }

    bool ok = false;
    cJSON *reset = cJSON_GetObjectItem(root, "reset");
    if (cJSON_IsTrue(reset)) {
        out->reset = true;
        ok = true;
        goto done;
    }

    cJSON *seq = cJSON_GetObjectItem(root, "latest_seq");
    if (!cJSON_IsNumber(seq)) {
        goto done;
    }
    out->latest_seq = (int64_t) seq->valuedouble;

    cJSON *ops = cJSON_GetObjectItem(root, "ops");
    if (!cJSON_IsArray(ops)) {
        goto done;
    }
    if (cJSON_GetArraySize(ops) > SYNC_MAX_OPS) {
        goto done;
    }

    cJSON *op_json = NULL;
    cJSON_ArrayForEach(op_json, ops)
    {
        sync_op_t *op = &out->ops[out->op_count];
        op->size = -1;

        cJSON *type = cJSON_GetObjectItem(op_json, "op");
        if (!cJSON_IsString(type)) {
            goto done;
        }
        if (strcmp(type->valuestring, "put") == 0) {
            op->type = SYNC_OP_PUT;
        } else if (strcmp(type->valuestring, "delete") == 0) {
            op->type = SYNC_OP_DELETE;
        } else if (strcmp(type->valuestring, "rmdir") == 0) {
            op->type = SYNC_OP_RMDIR;
        } else {
            goto done;
        }

        if (!copy_name(op->album, cJSON_GetObjectItem(op_json, "album"))) {
            goto done;
        }
        if (op->type != SYNC_OP_RMDIR) {
            if (!copy_name(op->file, cJSON_GetObjectItem(op_json, "file"))) {
                goto done;
            }
        }
        if (op->type == SYNC_OP_PUT) {
            cJSON *size = cJSON_GetObjectItem(op_json, "size");
            if (!cJSON_IsNumber(size) || size->valuedouble < 0) {
                goto done;
            }
            op->size = (int32_t) size->valuedouble;
        }
        out->op_count++;
    }
    ok = true;

done:
    cJSON_Delete(root);
    if (!ok) {
        memset(out, 0, sizeof(*out));
    }
    return ok;
}
```

- [ ] **Step 5: Run host tests**: rebuild and `ctest --test-dir host_tests/build` expecting all PASS (including existing cron tests).
- [ ] **Step 6: Add `sync_ops.c` to `main/CMakeLists.txt` SRCS** (check how the list is defined; some ESP-IDF projects glob, in which case no change is needed).
- [ ] **Step 7: Commit** `feat: sync ops JSON parser with host tests`.

---

### Task 8: Firmware sync client (download/apply/ack) + wake wiring

**Files:**
- Create: `main/sync_client.c`, `main/sync_client.h`
- Modify: `main/main.c` (`deep_sleep_wake_main`: WiFi condition + sync call)
- Modify: `main/CMakeLists.txt` if sources are listed explicitly

**Interfaces:**
- Consumes: `config_manager_get_sync_server_url`, `sync_ops_parse`, `sync_name_is_safe`, `get_device_id()` (utils.h), `album_manager_get_album_path`, `album_manager_set_album_enabled`, `album_manager_delete_album`, `IMAGE_DIRECTORY` (config.h), esp_http_client, NVS
- Produces (`main/sync_client.h`):

```c
#ifndef SYNC_CLIENT_H
#define SYNC_CLIENT_H

#include <stdbool.h>

#include "esp_err.h"

// True when a sync server URL is configured (deploy-on-wake sync active).
bool sync_client_is_configured(void);

// Pull pending deployment ops from the staging server and apply them to the
// SD card, then acknowledge. Designed for the timer-wake path: bounded by
// SYNC_WAKE_BUDGET_SEC, silently returns ESP_OK when unconfigured, and
// returns an error (already logged) on any failure so the caller just
// continues the wake flow. WiFi must be connected.
esp_err_t sync_client_run(void);

#endif
```

- [ ] **Step 1: Add budget constant to `main/config.h`** near the other sync-related defines:

```c
#define SYNC_WAKE_BUDGET_SEC 120  // max time per wake spent applying sync ops
```

- [ ] **Step 2: Implement `main/sync_client.c`:**

```c
#include "sync_client.h"

#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include "album_manager.h"
#include "cJSON.h"
#include "config.h"
#include "config_manager.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "nvs.h"
#include "sync_ops.h"
#include "utils.h"

static const char *TAG = "sync_client";

#define SYNC_NVS_NAMESPACE "sync"
#define SYNC_NVS_SEQ_KEY "last_seq"
#define SYNC_CHANGES_MAX_LEN (32 * 1024)
#define SYNC_HTTP_TIMEOUT_MS 15000

bool sync_client_is_configured(void)
{
    return config_manager_get_sync_server_url()[0] != '\0';
}

static int64_t load_last_seq(void)
{
    nvs_handle_t handle;
    int64_t seq = 0;
    if (nvs_open(SYNC_NVS_NAMESPACE, NVS_READONLY, &handle) == ESP_OK) {
        nvs_get_i64(handle, SYNC_NVS_SEQ_KEY, &seq);
        nvs_close(handle);
    }
    return seq;
}

static void store_last_seq(int64_t seq)
{
    nvs_handle_t handle;
    if (nvs_open(SYNC_NVS_NAMESPACE, NVS_READWRITE, &handle) == ESP_OK) {
        nvs_set_i64(handle, SYNC_NVS_SEQ_KEY, seq);
        nvs_commit(handle);
        nvs_close(handle);
    }
}

// GET url into buf (NUL-terminated). Returns HTTP status or -1 on error.
static int http_get_to_buffer(const char *url, char *buf, size_t buf_len)
{
    esp_http_client_config_t config = {
        .url = url,
        .timeout_ms = SYNC_HTTP_TIMEOUT_MS,
    };
    esp_http_client_handle_t client = esp_http_client_init(&config);
    if (!client) {
        return -1;
    }
    int status = -1;
    if (esp_http_client_open(client, 0) == ESP_OK) {
        esp_http_client_fetch_headers(client);
        int total = 0;
        while (total < (int) buf_len - 1) {
            int r = esp_http_client_read(client, buf + total, buf_len - 1 - total);
            if (r <= 0) {
                break;
            }
            total += r;
        }
        buf[total] = '\0';
        status = esp_http_client_get_status_code(client);
    }
    esp_http_client_cleanup(client);
    return status;
}

// Download url to path via a temp file + rename. Returns ESP_OK on success.
static esp_err_t download_to_file(const char *url, const char *path)
{
    char tmp_path[300];
    snprintf(tmp_path, sizeof(tmp_path), "%s.sync_tmp", path);

    FILE *f = fopen(tmp_path, "wb");
    if (!f) {
        ESP_LOGE(TAG, "Cannot open %s for writing", tmp_path);
        return ESP_FAIL;
    }

    esp_http_client_config_t config = {
        .url = url,
        .timeout_ms = SYNC_HTTP_TIMEOUT_MS,
    };
    esp_http_client_handle_t client = esp_http_client_init(&config);
    esp_err_t err = ESP_FAIL;
    if (client && esp_http_client_open(client, 0) == ESP_OK) {
        esp_http_client_fetch_headers(client);
        int status = esp_http_client_get_status_code(client);
        if (status == 200) {
            char chunk[2048];
            int r;
            err = ESP_OK;
            while ((r = esp_http_client_read(client, chunk, sizeof(chunk))) > 0) {
                if (fwrite(chunk, 1, r, f) != (size_t) r) {
                    err = ESP_FAIL;  // SD write failed (full?)
                    break;
                }
            }
            if (r < 0) {
                err = ESP_FAIL;
            }
        } else {
            ESP_LOGE(TAG, "Download %s -> HTTP %d", url, status);
        }
    }
    if (client) {
        esp_http_client_cleanup(client);
    }
    fclose(f);

    if (err == ESP_OK && rename(tmp_path, path) != 0) {
        err = ESP_FAIL;
    }
    if (err != ESP_OK) {
        unlink(tmp_path);
    }
    return err;
}

// URL-encode a path segment (space and reserved chars) into dst.
static void url_encode_segment(const char *src, char *dst, size_t dst_len)
{
    static const char hex[] = "0123456789ABCDEF";
    size_t j = 0;
    for (size_t i = 0; src[i] && j + 4 < dst_len; i++) {
        unsigned char c = (unsigned char) src[i];
        if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
            c == '-' || c == '_' || c == '.' || c == '~') {
            dst[j++] = c;
        } else {
            dst[j++] = '%';
            dst[j++] = hex[c >> 4];
            dst[j++] = hex[c & 0x0F];
        }
    }
    dst[j] = '\0';
}

static esp_err_t apply_put(const char *base_url, const sync_op_t *op)
{
    char album_path[256];
    if (album_manager_get_album_path(op->album, album_path, sizeof(album_path)) != ESP_OK) {
        return ESP_FAIL;
    }

    struct stat st;
    bool album_created = false;
    if (stat(album_path, &st) != 0) {
        if (mkdir(album_path, 0755) != 0) {
            ESP_LOGE(TAG, "mkdir %s failed", album_path);
            return ESP_FAIL;
        }
        album_created = true;
    }

    char file_path[320];
    snprintf(file_path, sizeof(file_path), "%s/%s", album_path, op->file);

    // Resume optimization: skip files already present with the expected size.
    if (stat(file_path, &st) == 0 && st.st_size == op->size) {
        ESP_LOGI(TAG, "Skip %s/%s (already present, %ld bytes)", op->album, op->file,
                 (long) st.st_size);
        return ESP_OK;
    }

    char enc_album[SYNC_NAME_MAX_LEN * 3];
    char enc_file[SYNC_NAME_MAX_LEN * 3];
    url_encode_segment(op->album, enc_album, sizeof(enc_album));
    url_encode_segment(op->file, enc_file, sizeof(enc_file));

    char url[512];
    snprintf(url, sizeof(url), "%s/api/sync/file/%s/%s", base_url, enc_album, enc_file);

    esp_err_t err = download_to_file(url, file_path);
    if (err == ESP_OK) {
        ESP_LOGI(TAG, "Synced %s/%s (%ld bytes)", op->album, op->file, (long) op->size);
        if (album_created) {
            album_manager_set_album_enabled(op->album, true);
        }
    }
    return err;
}

static esp_err_t apply_op(const char *base_url, const sync_op_t *op)
{
    switch (op->type) {
    case SYNC_OP_PUT:
        return apply_put(base_url, op);
    case SYNC_OP_DELETE: {
        char album_path[256];
        if (album_manager_get_album_path(op->album, album_path, sizeof(album_path)) != ESP_OK) {
            return ESP_FAIL;
        }
        char file_path[320];
        snprintf(file_path, sizeof(file_path), "%s/%s", album_path, op->file);
        if (unlink(file_path) != 0) {
            ESP_LOGW(TAG, "Delete %s: already gone", file_path);
        }
        return ESP_OK;
    }
    case SYNC_OP_RMDIR:
        // Removes the directory and disables the album; ignore failure if
        // the album still has files the server does not know about.
        album_manager_delete_album(op->album);
        return ESP_OK;
    }
    return ESP_FAIL;
}

static esp_err_t post_ack(const char *base_url, int64_t seq)
{
    char url[320];
    snprintf(url, sizeof(url), "%s/api/sync/ack", base_url);

    char body[128];
    snprintf(body, sizeof(body), "{\"device\":\"%s\",\"seq\":%lld}", get_device_id(),
             (long long) seq);

    esp_http_client_config_t config = {
        .url = url,
        .method = HTTP_METHOD_POST,
        .timeout_ms = SYNC_HTTP_TIMEOUT_MS,
    };
    esp_http_client_handle_t client = esp_http_client_init(&config);
    if (!client) {
        return ESP_FAIL;
    }
    esp_http_client_set_header(client, "Content-Type", "application/json");
    esp_http_client_set_post_field(client, body, strlen(body));
    esp_err_t err = esp_http_client_perform(client);
    int status = esp_http_client_get_status_code(client);
    esp_http_client_cleanup(client);
    return (err == ESP_OK && status == 200) ? ESP_OK : ESP_FAIL;
}

esp_err_t sync_client_run(void)
{
    if (!sync_client_is_configured()) {
        return ESP_OK;
    }

    // Normalize: strip one trailing slash so URL building is uniform.
    char base_url[SYNC_SERVER_URL_MAX_LEN];
    strncpy(base_url, config_manager_get_sync_server_url(), sizeof(base_url) - 1);
    base_url[sizeof(base_url) - 1] = '\0';
    size_t blen = strlen(base_url);
    if (blen > 0 && base_url[blen - 1] == '/') {
        base_url[blen - 1] = '\0';
    }

    int64_t start_us = esp_timer_get_time();
    int64_t last_seq = load_last_seq();

    char url[512];
    snprintf(url, sizeof(url), "%s/api/sync/changes?since=%lld&device=%s", base_url,
             (long long) last_seq, get_device_id());

    char *buf = malloc(SYNC_CHANGES_MAX_LEN);
    if (!buf) {
        return ESP_ERR_NO_MEM;
    }
    int status = http_get_to_buffer(url, buf, SYNC_CHANGES_MAX_LEN);
    if (status < 0) {
        ESP_LOGI(TAG, "Sync server unreachable, skipping");
        free(buf);
        return ESP_FAIL;
    }

    sync_changes_t *changes = malloc(sizeof(sync_changes_t));
    if (!changes) {
        free(buf);
        return ESP_ERR_NO_MEM;
    }

    esp_err_t result = ESP_FAIL;
    if (!sync_ops_parse(buf, changes)) {
        ESP_LOGE(TAG, "Malformed sync response (HTTP %d)", status);
        goto done;
    }

    if (status == 409 && changes->reset) {
        ESP_LOGW(TAG, "Server signalled reset, restarting from seq 0");
        store_last_seq(0);
        result = ESP_OK;  // next wake does the full resync
        goto done;
    }
    if (status != 200) {
        ESP_LOGE(TAG, "Sync changes -> HTTP %d", status);
        goto done;
    }

    if (changes->op_count == 0) {
        ESP_LOGI(TAG, "Sync up to date (seq %lld)", (long long) changes->latest_seq);
        if (changes->latest_seq != last_seq) {
            store_last_seq(changes->latest_seq);
        }
        result = ESP_OK;
        goto done;
    }

    ESP_LOGI(TAG, "Applying %d sync ops (seq %lld -> %lld)", changes->op_count,
             (long long) last_seq, (long long) changes->latest_seq);

    for (int i = 0; i < changes->op_count; i++) {
        if ((esp_timer_get_time() - start_us) / 1000000 > SYNC_WAKE_BUDGET_SEC) {
            ESP_LOGW(TAG, "Sync budget exhausted after %d/%d ops, resuming next wake", i,
                     changes->op_count);
            utils_set_last_fetch_error("Album sync paused (budget), resumes next wake");
            goto done;  // no ack: same ops return next wake, size-skip resumes
        }
        if (apply_op(base_url, &changes->ops[i]) != ESP_OK) {
            ESP_LOGE(TAG, "Sync op %d failed, aborting this wake", i);
            utils_set_last_fetch_error("Album sync failed, retries next wake");
            goto done;
        }
    }

    if (post_ack(base_url, changes->latest_seq) == ESP_OK) {
        store_last_seq(changes->latest_seq);
        ESP_LOGI(TAG, "Sync complete at seq %lld", (long long) changes->latest_seq);
        result = ESP_OK;
    } else {
        ESP_LOGW(TAG, "Ack failed; ops applied, will re-verify next wake");
    }

done:
    free(changes);
    free(buf);
    return result;
}
```

- [ ] **Step 3: Wire into `main/main.c` `deep_sleep_wake_main`**. Include `sync_client.h`. Change the WiFi condition (currently `rotation_mode == ROTATION_MODE_URL || ha_configured`):

```c
    bool sync_configured = sync_client_is_configured();

    // Initialize WiFi if needed (URL mode and sync always need it, SD card
    // mode only if HA configured)
    if (rotation_mode == ROTATION_MODE_URL || ha_configured || sync_configured) {
        ESP_LOGI(TAG, "Initializing WiFi for %s",
                 rotation_mode == ROTATION_MODE_URL ? "URL rotation"
                 : sync_configured                  ? "album sync"
                                                    : "HA battery post");
```

And immediately before the `// Trigger rotation` block:

```c
    // Pull deployed album changes from the staging server before rotating so
    // a freshly deployed album can be shown on this wake already.
    if (wifi_connected && sync_configured) {
        power_manager_reset_sleep_timer();
        sync_client_run();
    }
```

- [ ] **Step 4: Build for the EE02 board**: `python3 build.py --board seeedstudio_xiao_ee02` expecting a successful firmware build (webapp + splash + firmware steps).
- [ ] **Step 5: Commit** `feat: deploy-on-wake sync client pulling staged albums to SD`.

---

### Task 9: Documentation + PR

**Files:**
- Create: `docs/OFFLINE_ALBUM_SYNC.md`
- Modify: `README.md` (one bullet in Key Features + link)

- [ ] **Step 1: Write `docs/OFFLINE_ALBUM_SYNC.md`**: what it is, quick start (`photoframe-process --staging ~/PhotoframeStaging --device-parameters --host photoframe.local`, set Sync Server URL in device settings, add photos, Deploy), how the wake sync works (seq/ack, budget, resume), battery note, troubleshooting (last_fetch_error surfacing, reset flow).
- [ ] **Step 2: Update `README.md`** Key Features with: `**Offline Album Staging**: prepare albums locally while the frame sleeps; the device pulls deployed changes on its next scheduled wake ([docs](docs/OFFLINE_ALBUM_SYNC.md))`.
- [ ] **Step 3: Run everything**: `cd process-cli && npm test`; host tests via ctest; `python3 build.py --board seeedstudio_xiao_ee02`. All must pass.
- [ ] **Step 4: Push branch and open PR** to `Renevdo/esp32-photoframe` base `main`, title `Offline album staging with deploy-on-wake sync`, body: summary, how it works (3 bullets), test plan, `Closes #1`, then the standard PR footer. Do not include webapp/package.json or webapp/package-lock.json in any commit.

---

## Self-review notes

- Spec coverage: staging store/deploy/ops (Tasks 1-2), processing intake (Task 3), sync API + UI (Task 4), CLI + cached device params (Task 5), firmware setting + webapp (Task 6), parser + host tests (Task 7), sync client + wake wiring + build (Task 8), docs + PR (Task 9). Spec items intentionally simplified: `GET /api/sync/file` has no `<seq>` segment (files served from the live albums tree; a post-deploy edit downloads newer content, corrected at the next deploy); the spec's rmdir op is emitted by diff, not album delete directly.
- The device never touches albums absent from ops: sync only applies ops the server sends, so device-only albums (e.g. Downloads) are safe. The spec's "full resync deletes unknown files" is NOT implemented in v1: after a store reset the server has no per-device manifest to diff against; stale files that a reset orphaned remain until manually deleted. Documented in docs/OFFLINE_ALBUM_SYNC.md.
- Type consistency checked: op JSON shape `{op, album, file, size}` matches between ops.js, staging-server routes, sync_ops.c, and sync_client.c; ack body `{device, seq}` matches store.ack and post_ack.
