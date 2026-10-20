import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { backupDevice, restoreDevice } from "../backup.js";

// Minimal stand-in for the frame's album API, keyed "album/filename".
function fakeDevice(files = {}, albums = {}) {
  const state = { files: { ...files }, albums: { ...albums }, settings: {} };
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const json = (code, obj) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };

    if (u.pathname === "/api/config") return json(200, { wifi_password: "x" });
    if (u.pathname === "/api/settings/processing") return json(200, { a: 1 });
    if (u.pathname === "/api/settings/palette") return json(200, { b: 2 });
    if (u.pathname === "/api/albums" && req.method === "GET") {
      return json(
        200,
        Object.entries(state.albums).map(([name, enabled]) => ({
          name,
          enabled,
        })),
      );
    }
    if (u.pathname === "/api/albums" && req.method === "POST") {
      const { name } = JSON.parse(body);
      if (name in state.albums) return json(400, {});
      state.albums[name] = false;
      return json(200, {});
    }
    if (u.pathname === "/api/albums/enabled") {
      state.albums[u.searchParams.get("name")] = JSON.parse(body).enabled;
      return json(200, {});
    }
    if (u.pathname === "/api/images") {
      const album = u.searchParams.get("album");
      const list = Object.keys(state.files)
        .filter((k) => k.startsWith(`${album}/`) && !k.endsWith(".jpg"))
        .map((k) => {
          const filename = k.slice(album.length + 1);
          const thumb = filename.replace(/\.[^.]+$/, ".jpg");
          return {
            filename,
            album,
            ...(state.files[`${album}/${thumb}`] ? { thumbnail: thumb } : {}),
          };
        });
      return json(200, list);
    }
    if (u.pathname === "/api/image") {
      const data = state.files[u.searchParams.get("filepath")];
      if (!data) return json(404, {});
      res.writeHead(200);
      return res.end(data);
    }
    if (u.pathname === "/api/upload") {
      const album = u.searchParams.get("album");
      const parts = new Request("http://x", {
        method: "POST",
        headers: { "content-type": req.headers["content-type"] },
        body,
      });
      const form = await parts.formData();
      for (const field of ["image", "thumbnail"]) {
        const file = form.get(field);
        state.files[`${album}/${file.name}`] = Buffer.from(
          await file.arrayBuffer(),
        );
      }
      return json(200, { status: "success" });
    }
    json(404, {});
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, state, host: `127.0.0.1:${server.address().port}` }),
    ),
  );
}

const quiet = () => {};
let dir;
let devices = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "backup-"));
});

afterEach(() => {
  devices.forEach((d) => d.server.close());
  devices = [];
  fs.rmSync(dir, { recursive: true, force: true });
});

test("backup then restore round-trips images, thumbnails and album flags", async () => {
  const source = await fakeDevice(
    {
      "Holiday/beach.epdgz": Buffer.from([1, 2, 3, 0, 255]),
      "Holiday/beach.jpg": Buffer.from("thumb-beach"),
      "Default/cat.png": Buffer.from("png-bytes"),
      "Default/cat.jpg": Buffer.from("thumb-cat"),
    },
    { Holiday: false, Default: true, Empty: true },
  );
  const target = await fakeDevice({}, { Default: true });
  devices.push(source, target);

  await backupDevice(source.host, dir, quiet);
  const settings = JSON.parse(
    fs.readFileSync(path.join(dir, "settings.json"), "utf8"),
  );
  expect(settings.config.wifi_password).toBeUndefined();
  expect(settings.palette).toEqual({ b: 2 });

  const { restored, failed } = await restoreDevice(target.host, dir, quiet);
  expect(restored).toBe(2);
  expect(failed).toEqual([]);
  expect(target.state.files).toEqual(source.state.files);
  expect(target.state.albums).toEqual(source.state.albums);
});

test("images without a thumbnail are backed up but reported on restore", async () => {
  const source = await fakeDevice(
    { "Default/lonely.png": Buffer.from("png") },
    { Default: true },
  );
  const target = await fakeDevice({}, {});
  devices.push(source, target);

  await backupDevice(source.host, dir, quiet);
  expect(fs.existsSync(path.join(dir, "albums", "Default", "lonely.png"))).toBe(
    true,
  );
  const { failed } = await restoreDevice(target.host, dir, quiet);
  expect(failed).toEqual(["Default/lonely.png"]);
});

test("backup refuses album names that would escape the backup directory", async () => {
  const source = await fakeDevice({}, { "..": true });
  devices.push(source);
  await expect(backupDevice(source.host, dir, quiet)).rejects.toThrow(
    /unsafe name/,
  );
});
