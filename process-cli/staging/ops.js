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
    // names are used as plain-object keys; keep prototype setters out
    !["__proto__", "constructor", "prototype"].includes(name) &&
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
