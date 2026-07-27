import { computeOps, coalesceOps, isSafeName } from "../staging/ops.js";

const f = (size, mtimeMs = 1) => ({ size, mtimeMs });

describe("computeOps", () => {
  test("new file becomes put", () => {
    expect(computeOps({}, { "a/x.epdgz": f(10) })).toEqual([
      { op: "put", album: "a", file: "x.epdgz", size: 10 },
    ]);
  });
  test("unchanged file emits nothing", () => {
    expect(computeOps({ "a/x.epdgz": f(10) }, { "a/x.epdgz": f(10) })).toEqual(
      [],
    );
  });
  test("size or mtime change becomes put", () => {
    expect(
      computeOps({ "a/x.epdgz": f(10) }, { "a/x.epdgz": f(11) }),
    ).toHaveLength(1);
    expect(
      computeOps({ "a/x.epdgz": f(10, 1) }, { "a/x.epdgz": f(10, 2) }),
    ).toHaveLength(1);
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
    const ops = computeOps(
      { "a/x.epdgz": f(10), "a/y.epdgz": f(5) },
      { "a/y.epdgz": f(5) },
    );
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
  test.each([
    "",
    "..",
    "a/b",
    "a\\b",
    ".",
    "x".repeat(64),
    "__proto__",
    "constructor",
    "prototype",
  ])("rejects %j", (n) => expect(isSafeName(n)).toBe(false));
});
