/**
 * Virtual photoframe proxy: the subset of the device REST API the companion
 * app uses, backed by the staging store. Response shapes mirror
 * main/http_server.c so the app cannot tell the difference.
 */

import fs from "fs";
import path from "path";
import { collectBody, json, parseJsonBody, sendFile } from "./http-util.js";
import { parseMultipart } from "./multipart.js";
import { isSafeName } from "./ops.js";

const MAX_UPLOAD = 50 * 1024 * 1024;

// Display-image formats the device understands (thumbnails are always .jpg)
const IMAGE_EXTENSIONS = [".png", ".bmp", ".epdgz"];

function success(res, extra = {}) {
  json(res, 200, { status: "success", ...extra });
}

// Album enabled flags live beside the store; albums default to enabled,
// mirroring how sync-created albums behave on the device.
function readEnabled(store) {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(store.storeDir, "proxy-albums.json"), "utf8"),
    );
    // A manually edited file could hold valid JSON that is not an object
    // (array, null, number); only a plain object works as a flag map.
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
    return {};
  } catch {
    return {};
  }
}

// tmp + rename, like StagingStore.saveState. A torn write here is not
// harmless: readEnabled falls back to {} on parse failure, which silently
// re-enables every album the user had switched off.
function writeEnabled(store, flags) {
  const target = path.join(store.storeDir, "proxy-albums.json");
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(flags, null, 2));
  fs.renameSync(tmp, target);
}

function safePathPair(value) {
  if (typeof value !== "string") return null;
  const segs = value.split("/");
  if (segs.length !== 2 || !isSafeName(segs[0]) || !isSafeName(segs[1])) {
    return null;
  }
  return { album: segs[0], file: segs[1] };
}

/**
 * Handle a device-API request. Returns true when the request was handled.
 * opts: {store, ctx, virtual, autoDeploy}
 */
export async function proxyRoute(req, res, u, seg, opts) {
  const { store, ctx, virtual, autoDeploy } = opts;
  if (seg[0] !== "api") return false;
  const route = seg.join("/");

  // Every route that changes the store ends here: the cached device view must
  // not outlive the change, and auto-deploy publishes it to the frame.
  const afterMutation = () => {
    virtual.invalidate();
    if (autoDeploy) store.deploy();
  };

  // GET /api/albums -> [{name, enabled}]
  if (route === "api/albums" && req.method === "GET") {
    const enabled = readEnabled(store);
    const albums = fs
      .readdirSync(store.albumsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
      .map((name) => ({ name, enabled: enabled[name] !== false }));
    json(res, 200, albums);
    return true;
  }

  // POST /api/albums {name}
  if (route === "api/albums" && req.method === "POST") {
    const body = parseJsonBody(await collectBody(req, 4096));
    if (!isSafeName(body.name)) {
      json(res, 400, { error: "Missing album name" });
      return true;
    }
    fs.mkdirSync(path.join(store.albumsDir, body.name), { recursive: true });
    // No deploy here: the sync manifest is file-based, so an empty album has
    // no ops to ship. The album reaches the real frame with its first photo.
    success(res);
    return true;
  }

  // DELETE /api/albums?name=
  if (route === "api/albums" && req.method === "DELETE") {
    const name = u.searchParams.get("name");
    if (!isSafeName(name)) {
      json(res, 400, { error: "Missing album name parameter" });
      return true;
    }
    fs.rmSync(path.join(store.albumsDir, name), {
      recursive: true,
      force: true,
    });
    fs.rmSync(path.join(store.originalsDir, name), {
      recursive: true,
      force: true,
    });
    const flags = readEnabled(store);
    delete flags[name];
    writeEnabled(store, flags);
    afterMutation();
    success(res);
    return true;
  }

  // PUT /api/albums/enabled?name= {enabled}
  // Note: enabled state applies to the virtual frame only; the deploy-on-wake
  // sync intentionally carries album content, not metadata (see
  // docs/OFFLINE_ALBUM_SYNC.md).
  if (route === "api/albums/enabled" && req.method === "PUT") {
    const name = u.searchParams.get("name");
    const body = parseJsonBody(await collectBody(req, 4096));
    if (!isSafeName(name) || typeof body.enabled !== "boolean") {
      json(res, 400, { error: "Missing enabled field" });
      return true;
    }
    const flags = readEnabled(store);
    flags[name] = body.enabled;
    writeEnabled(store, flags);
    success(res);
    return true;
  }

  // GET /api/images?album= -> [{filename, album, thumbnail?}]
  if (route === "api/images" && req.method === "GET") {
    const album = u.searchParams.get("album");
    if (!isSafeName(album)) {
      json(res, 400, { error: "Missing album parameter" });
      return true;
    }
    const albumPath = path.join(store.albumsDir, album);
    const images = [];
    if (fs.existsSync(albumPath)) {
      const files = fs.readdirSync(albumPath).sort();
      const fileSet = new Set(files);
      for (const f of files) {
        const ext = path.extname(f).toLowerCase();
        if (!IMAGE_EXTENSIONS.includes(ext)) continue;
        const entry = { filename: f, album };
        const thumb = `${path.basename(f, path.extname(f))}.jpg`;
        if (fileSet.has(thumb)) entry.thumbnail = thumb;
        images.push(entry);
      }
    }
    json(res, 200, images);
    return true;
  }

  // POST /api/upload?album= (multipart: image + thumbnail)
  if (route === "api/upload" && req.method === "POST") {
    const album = u.searchParams.get("album") || "Default";
    if (!isSafeName(album)) {
      json(res, 400, { error: "Invalid album" });
      return true;
    }
    const body = await collectBody(req, MAX_UPLOAD);
    const parts = parseMultipart(body, req.headers["content-type"]);
    const image = parts.find((p) => p.name === "image");
    const thumbnail = parts.find((p) => p.name === "thumbnail");
    if (!image || !thumbnail || !isSafeName(image.filename || "")) {
      json(res, 400, {
        error: "Upload incomplete - expected image and thumbnail",
      });
      return true;
    }
    if (
      !IMAGE_EXTENSIONS.includes(path.extname(image.filename).toLowerCase())
    ) {
      json(res, 400, {
        error: "Image must be .png, .bmp, or .epdgz",
      });
      return true;
    }
    const albumPath = path.join(store.albumsDir, album);
    fs.mkdirSync(albumPath, { recursive: true });
    const ext = path.extname(image.filename);
    const base = path.basename(image.filename, ext);
    fs.writeFileSync(path.join(albumPath, image.filename), image.data);
    fs.writeFileSync(path.join(albumPath, `${base}.jpg`), thumbnail.data);
    afterMutation();
    success(res, { filepath: `${album}/${image.filename}` });
    return true;
  }

  // POST /api/delete {filepath: "album/file.ext"}
  if (route === "api/delete" && req.method === "POST") {
    const body = parseJsonBody(await collectBody(req, 4096));
    const pair = safePathPair(body.filepath);
    if (!pair) {
      json(res, 400, { error: "Invalid filepath" });
      return true;
    }
    const ext = path.extname(pair.file);
    const base = path.basename(pair.file, ext);
    fs.rmSync(path.join(store.albumsDir, pair.album, pair.file), {
      force: true,
    });
    fs.rmSync(path.join(store.albumsDir, pair.album, `${base}.jpg`), {
      force: true,
    });
    afterMutation();
    success(res);
    return true;
  }

  // GET /api/image?filepath=album/file
  if (route === "api/image" && req.method === "GET") {
    const pair = safePathPair(u.searchParams.get("filepath"));
    if (!pair) {
      json(res, 400, { error: "Invalid filepath" });
      return true;
    }
    const p = path.join(store.albumsDir, pair.album, pair.file);
    const types = {
      ".jpg": "image/jpeg",
      ".png": "image/png",
      ".bmp": "image/bmp",
    };
    sendFile(
      res,
      p,
      types[path.extname(pair.file).toLowerCase()] ||
        "application/octet-stream",
    );
    return true;
  }

  // GET /api/current_image -> newest thumbnail in the store, else 404
  if (route === "api/current_image" && req.method === "GET") {
    const newest = virtual.newestThumbnail();
    if (!newest) {
      json(res, 404, { error: "No image currently displayed" });
      return true;
    }
    const data = fs.readFileSync(newest.path);
    res.writeHead(200, {
      "content-type": "image/jpeg",
      "content-length": data.length,
    });
    res.end(data);
    return true;
  }

  // Config
  if (route === "api/config" && req.method === "GET") {
    json(res, 200, virtual.config());
    return true;
  }
  if (
    route === "api/config" &&
    (req.method === "POST" || req.method === "PATCH")
  ) {
    const body = parseJsonBody(await collectBody(req, 64 * 1024));
    virtual.applyConfig(body);
    success(res);
    return true;
  }

  if (route === "api/battery" && req.method === "GET") {
    json(res, 200, virtual.battery());
    return true;
  }
  if (route === "api/system-info" && req.method === "GET") {
    json(res, 200, virtual.systemInfo());
    return true;
  }

  // Processing settings: stored blob when POSTed, otherwise defaults (the
  // device-parameter cache or library defaults), mirroring the firmware where
  // GET falls back to defaults and DELETE resets and returns them.
  if (route === "api/settings/processing") {
    const file = path.join(store.storeDir, "proxy-processing.json");
    const defaults = () => ({ ...(ctx?.params || {}) });
    if (req.method === "GET") {
      try {
        json(res, 200, JSON.parse(fs.readFileSync(file, "utf8")));
      } catch {
        json(res, 200, defaults());
      }
      return true;
    }
    if (req.method === "POST") {
      const body = await collectBody(req, 256 * 1024);
      parseJsonBody(body); // validate
      fs.writeFileSync(file, body);
      json(res, 200, { success: true });
      return true;
    }
    if (req.method === "DELETE") {
      fs.rmSync(file, { force: true });
      json(res, 200, defaults());
      return true;
    }
  }

  // Palette: stored blob, defaulting to the cached device palette when known
  if (route === "api/settings/palette") {
    const file = path.join(store.storeDir, "proxy-palette.json");
    if (req.method === "GET") {
      try {
        json(res, 200, JSON.parse(fs.readFileSync(file, "utf8")));
      } catch {
        json(res, 200, ctx?.palette || {});
      }
      return true;
    }
    if (req.method === "POST") {
      const body = await collectBody(req, 256 * 1024);
      parseJsonBody(body); // validate
      fs.writeFileSync(file, body);
      json(res, 200, { success: true });
      return true;
    }
    if (req.method === "DELETE") {
      fs.rmSync(file, { force: true });
      json(res, 200, ctx?.palette || {});
      return true;
    }
  }

  // Harmless stubs: the virtual frame is always awake and never rotates
  if (
    req.method === "POST" &&
    ["api/keep_alive", "api/rotate", "api/sleep", "api/time/sync"].includes(
      route,
    )
  ) {
    success(res);
    return true;
  }
  if (route === "api/time" && req.method === "GET") {
    json(res, 200, { epoch: 0, synced: false });
    return true;
  }
  if (route === "api/ota/status" && req.method === "GET") {
    json(res, 200, {
      state: "idle",
      current_version: virtual.systemInfo().version,
      latest_version: "",
      progress_percent: 0,
    });
    return true;
  }

  return false;
}
