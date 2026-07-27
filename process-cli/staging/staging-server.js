/**
 * Staging server: staging management API + device-facing sync API + web UI.
 * Plain node:http, no framework. See docs/OFFLINE_ALBUM_SYNC.md.
 */

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

function sendFile(res, filePath, contentType) {
  if (!fs.existsSync(filePath)) {
    return json(res, 404, { error: "not found" });
  }
  const data = fs.readFileSync(filePath);
  res.writeHead(200, {
    "content-type": contentType,
    "content-length": data.length,
  });
  res.end(data);
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

function listAlbums(store) {
  const albums = [];
  for (const name of fs.readdirSync(store.albumsDir).sort()) {
    const albumPath = path.join(store.albumsDir, name);
    if (!fs.statSync(albumPath).isDirectory()) continue;
    const photos = [];
    for (const file of fs.readdirSync(albumPath).sort()) {
      if (file.endsWith(".epdgz")) {
        const st = fs.statSync(path.join(albumPath, file));
        photos.push({ base: path.basename(file, ".epdgz"), size: st.size });
      }
    }
    albums.push({ name, photos });
  }
  return albums;
}

export function createStagingServer(store, ctx, options = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, "http://localhost");
      const seg = u.pathname
        .split("/")
        .filter(Boolean)
        .map(decodeURIComponent);
      await route(req, res, u, seg);
    } catch (err) {
      json(res, err.statusCode || 500, { error: err.message });
    }
  });

  async function route(req, res, u, seg) {
    if (req.method === "GET" && seg.length === 0) {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(UI_HTML);
      return;
    }

    // ---- Device-facing sync API ----

    if (req.method === "GET" && seg.join("/") === "api/sync/changes") {
      const since = parseInt(u.searchParams.get("since") || "0", 10);
      const result = store.changesSince(Number.isFinite(since) ? since : 0);
      if (result.reset) return json(res, 409, { reset: true });
      return json(res, 200, { latest_seq: result.latestSeq, ops: result.ops });
    }

    if (
      req.method === "GET" &&
      seg[0] === "api" &&
      seg[1] === "sync" &&
      seg[2] === "file"
    ) {
      if (seg.length !== 5 || !isSafeName(seg[3]) || !isSafeName(seg[4])) {
        return json(res, 400, { error: "bad name" });
      }
      return sendFile(
        res,
        path.join(store.albumsDir, seg[3], seg[4]),
        "application/octet-stream",
      );
    }

    if (req.method === "POST" && seg.join("/") === "api/sync/ack") {
      const body = JSON.parse((await collectBody(req, 4096)).toString());
      if (typeof body.device !== "string" || typeof body.seq !== "number") {
        return json(res, 400, { error: "device and seq required" });
      }
      store.ack(body.device, body.seq);
      return json(res, 200, { ok: true });
    }

    // ---- Staging management API ----

    if (req.method === "GET" && seg.join("/") === "api/staging/albums") {
      return json(res, 200, { albums: listAlbums(store) });
    }

    if (seg[0] === "api" && seg[1] === "staging" && seg[2] === "photos") {
      if (req.method === "PUT" && seg.length === 5) {
        const [album, filename] = [seg[3], seg[4]];
        const body = await collectBody(req, MAX_UPLOAD);
        if (body.length === 0) return json(res, 400, { error: "empty body" });
        const { base } = await addPhoto(store, album, filename, body, ctx);
        return json(res, 200, { base });
      }
      if (req.method === "DELETE" && seg.length === 5) {
        removePhoto(store, seg[3], seg[4]);
        return json(res, 200, { ok: true });
      }
    }

    if (
      req.method === "DELETE" &&
      seg[0] === "api" &&
      seg[1] === "staging" &&
      seg[2] === "albums" &&
      seg.length === 4
    ) {
      removeAlbum(store, seg[3]);
      return json(res, 200, { ok: true });
    }

    if (req.method === "POST" && seg.join("/") === "api/staging/deploy") {
      const { seq, ops } = store.deploy();
      return json(res, 200, { seq, ops_count: ops.length });
    }

    if (req.method === "GET" && seg.join("/") === "api/staging/status") {
      return json(res, 200, {
        latest_seq: store.latestSeq,
        pending_ops: store.pendingOps().length,
        devices: store.deviceStatus(),
      });
    }

    if (
      req.method === "GET" &&
      seg[0] === "api" &&
      seg[1] === "staging" &&
      seg[2] === "thumbnail" &&
      seg.length === 5
    ) {
      if (!isSafeName(seg[3]) || !isSafeName(seg[4])) {
        return json(res, 400, { error: "bad name" });
      }
      return sendFile(
        res,
        path.join(store.albumsDir, seg[3], `${seg[4]}.jpg`),
        "image/jpeg",
      );
    }

    json(res, 404, { error: "not found" });
  }

  return new Promise((resolve, reject) => {
    server.listen(options.port ?? 8090, () => {
      if (!options.silent) {
        console.log(
          `Staging server on http://localhost:${server.address().port}`,
        );
      }
      resolve(server);
    });
    server.on("error", reject);
  });
}
