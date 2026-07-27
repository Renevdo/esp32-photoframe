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
