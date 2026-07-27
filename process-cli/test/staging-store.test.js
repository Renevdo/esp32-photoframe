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
  put(s, "fam", "b.epdgz", "re-edited"); // same file again, new size
  put(s, "fam", "c.epdgz", "third");
  s.deploy(); // seq 3

  // since=1 spans seq 2 and seq 3, and b.epdgz was put in both. Coalescing has
  // to collapse those into one put at the latest size; plain concatenation
  // would yield four ops with b.epdgz twice.
  const s2 = new StagingStore(dir);
  s2.init();
  const { latestSeq, ops } = s2.changesSince(1);
  expect(latestSeq).toBe(3);
  expect(ops).toHaveLength(3);
  expect(ops).toEqual(
    expect.arrayContaining([
      { op: "delete", album: "fam", file: "a.epdgz" },
      { op: "put", album: "fam", file: "b.epdgz", size: 9 },
      { op: "put", album: "fam", file: "c.epdgz", size: 5 },
    ]),
  );
  expect(s2.changesSince(3)).toEqual({ latestSeq: 3, ops: [] });
});

test("state.json keeps one manifest, not one per deployment", () => {
  const s = new StagingStore(dir);
  s.init();
  for (let i = 1; i <= 30; i++) {
    put(s, "fam", `p${i}.epdgz`, "data");
    put(s, "fam", `p${i}.jpg`, "thumb");
    s.deploy();
  }
  const raw = fs.readFileSync(s.statePath, "utf8");
  const state = JSON.parse(raw);

  expect(state.deployments.every((d) => d.manifest === undefined)).toBe(true);
  expect(Object.keys(state.manifest)).toHaveLength(60);
  // A per-deployment manifest makes this ~50 KB by 30 deployments.
  expect(raw.length).toBeLessThan(20000);
});

test("a device at seq 0 gets a snapshot of what is currently staged", () => {
  const s = new StagingStore(dir);
  s.init();
  put(s, "fam", "a.epdgz", "data");
  s.deploy(); // seq 1
  fs.unlinkSync(path.join(s.albumsDir, "fam", "a.epdgz"));
  put(s, "fam", "b.epdgz", "other!");
  s.deploy(); // seq 2

  // A fresh device holds no files, so replaying the delete of a.epdgz is
  // pointless; it needs exactly the current contents.
  expect(s.changesSince(0)).toEqual({
    latestSeq: 2,
    ops: [{ op: "put", album: "fam", file: "b.epdgz", size: 6 }],
  });
});

test("deployments acked by every known device are pruned", () => {
  const s = new StagingStore(dir);
  s.init();
  put(s, "fam", "a.epdgz", "data");
  s.deploy(); // seq 1
  put(s, "fam", "b.epdgz", "data");
  s.deploy(); // seq 2
  expect(
    JSON.parse(fs.readFileSync(s.statePath, "utf8")).deployments,
  ).toHaveLength(2);

  s.ack("AABBCC", 2);
  expect(
    JSON.parse(fs.readFileSync(s.statePath, "utf8")).deployments,
  ).toHaveLength(0);
  // Still serves the device that is fully caught up.
  expect(s.changesSince(2)).toEqual({ latestSeq: 2, ops: [] });
});

test("a device whose history was pruned is told to reset", () => {
  const s = new StagingStore(dir);
  s.init();
  put(s, "fam", "a.epdgz", "data");
  s.deploy(); // seq 1
  put(s, "fam", "b.epdgz", "data");
  s.deploy(); // seq 2
  s.ack("AABBCC", 2); // prunes seq 1 and 2

  // A second device still sitting at seq 1 can no longer be served
  // incrementally, so it must restart from a snapshot.
  expect(s.changesSince(1)).toEqual({ reset: true });
});

test("an old-format state.json is migrated to a single manifest", () => {
  const s = new StagingStore(dir);
  s.init();
  put(s, "fam", "a.epdgz", "data");
  const manifest = s.currentManifest();
  fs.writeFileSync(
    s.statePath,
    JSON.stringify({
      deployments: [
        {
          seq: 1,
          ops: [{ op: "put", album: "fam", file: "a.epdgz", size: 4 }],
          manifest,
          at: "2026-01-01T00:00:00.000Z",
        },
      ],
      devices: { AABBCC: 1 },
    }),
  );

  const s2 = new StagingStore(dir);
  s2.init();
  expect(s2.latestSeq).toBe(1);
  expect(s2.pendingOps()).toEqual([]);
  expect(JSON.parse(fs.readFileSync(s2.statePath, "utf8")).manifest).toEqual(
    manifest,
  );
});

test("changesSince past the head signals reset", () => {
  const s = new StagingStore(dir);
  s.init();
  expect(s.changesSince(7)).toEqual({ reset: true });
});

test("corrupt state.json is backed up and reset instead of crashing", () => {
  const s = new StagingStore(dir);
  s.init();
  fs.writeFileSync(s.statePath, "{ truncated");
  const s2 = new StagingStore(dir);
  s2.init();
  expect(s2.latestSeq).toBe(0);
  expect(fs.existsSync(`${s.statePath}.corrupt`)).toBe(true);
});

test("ack records per-device seq", () => {
  const s = new StagingStore(dir);
  s.init();
  put(s, "fam", "a.epdgz", "data");
  s.deploy();
  s.ack("AABBCC", 1);
  expect(s.deviceStatus()).toEqual({ AABBCC: 1 });
});
