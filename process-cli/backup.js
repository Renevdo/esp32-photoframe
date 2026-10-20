import fs from "fs";
import path from "path";

// Byte-for-byte backup and restore of a frame's albums over its HTTP API, for reflashes that wipe storage.

const MANIFEST = "backup.json";
const SETTINGS = "settings.json";
const RESTORABLE = new Set([".epdgz", ".png"]);

async function getJson(base, apiPath) {
  const res = await fetch(`${base}${apiPath}`);
  if (!res.ok) {
    throw new Error(`GET ${apiPath}: HTTP ${res.status}`);
  }
  return res.json();
}

async function getFile(base, filepath) {
  const res = await fetch(
    `${base}/api/image?filepath=${encodeURIComponent(filepath)}`,
  );
  if (!res.ok) {
    throw new Error(`GET ${filepath}: HTTP ${res.status}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

// Album and file names become paths on disk, so refuse any that could escape the backup directory.
function safeName(name) {
  if (!name || name === "." || name === ".." || /[/\\]/.test(name)) {
    throw new Error(`Refusing unsafe name: ${JSON.stringify(name)}`);
  }
  return name;
}

// Saves the settings in the web UI's Export Config format, so Import Config can restore them.
async function backupSettings(base, dir) {
  const settings = {};
  const config = await getJson(base, "/api/config");
  delete config.wifi_password;
  settings.config = config;
  settings.processing = await getJson(base, "/api/settings/processing");
  settings.palette = await getJson(base, "/api/settings/palette");
  fs.writeFileSync(path.join(dir, SETTINGS), JSON.stringify(settings, null, 2));
}

export async function backupDevice(host, dir, log = console.log) {
  const base = `http://${host}`;
  fs.mkdirSync(dir, { recursive: true });

  await backupSettings(base, dir);
  log(`Settings saved to ${path.join(dir, SETTINGS)}`);

  const albums = await getJson(base, "/api/albums");
  const manifest = { host, created: new Date().toISOString(), albums: [] };
  let fileCount = 0;
  let byteCount = 0;

  for (const album of albums) {
    const albumName = safeName(album.name);
    const albumDir = path.join(dir, "albums", albumName);
    fs.mkdirSync(albumDir, { recursive: true });
    const images = await getJson(
      base,
      `/api/images?album=${encodeURIComponent(albumName)}`,
    );
    const entry = { name: albumName, enabled: !!album.enabled, images: [] };

    for (const image of images) {
      const filename = safeName(image.filename);
      if (!RESTORABLE.has(path.extname(filename).toLowerCase())) {
        log(`  Skipping ${albumName}/${filename}: upload cannot restore it`);
        continue;
      }
      const data = await getFile(base, `${albumName}/${filename}`);
      fs.writeFileSync(path.join(albumDir, filename), data);
      byteCount += data.length;
      fileCount++;

      let thumbnail = null;
      if (image.thumbnail) {
        thumbnail = safeName(image.thumbnail);
        try {
          const thumb = await getFile(base, `${albumName}/${thumbnail}`);
          fs.writeFileSync(path.join(albumDir, thumbnail), thumb);
          byteCount += thumb.length;
        } catch (error) {
          log(`  No thumbnail for ${albumName}/${filename}: ${error.message}`);
          thumbnail = null;
        }
      }
      entry.images.push({ filename, thumbnail });
      log(`  ${albumName}/${filename} (${data.length} bytes)`);
    }
    manifest.albums.push(entry);
  }

  fs.writeFileSync(path.join(dir, MANIFEST), JSON.stringify(manifest, null, 2));
  log(
    `Backed up ${fileCount} images in ${manifest.albums.length} albums (${byteCount} bytes) to ${dir}`,
  );
  return manifest;
}

async function uploadImage(base, album, albumDir, image) {
  const form = new FormData();
  const data = fs.readFileSync(path.join(albumDir, image.filename));
  form.append(
    "image",
    new Blob([data], { type: "application/octet-stream" }),
    image.filename,
  );
  const thumb = fs.readFileSync(path.join(albumDir, image.thumbnail));
  form.append(
    "thumbnail",
    new Blob([thumb], { type: "image/jpeg" }),
    image.thumbnail,
  );
  const res = await fetch(
    `${base}/api/upload?album=${encodeURIComponent(album)}`,
    { method: "POST", body: form },
  );
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }
}

export async function restoreDevice(host, dir, log = console.log) {
  const base = `http://${host}`;
  const manifest = JSON.parse(
    fs.readFileSync(path.join(dir, MANIFEST), "utf8"),
  );
  let restored = 0;
  const failed = [];

  for (const album of manifest.albums) {
    const albumName = safeName(album.name);
    const albumDir = path.join(dir, "albums", albumName);
    const res = await fetch(`${base}/api/albums`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: albumName }),
    });
    // The device answers an existing album with an error; uploads still land.
    if (!res.ok) {
      log(`  Album ${albumName}: HTTP ${res.status}, continuing`);
    }

    for (const image of album.images) {
      if (!image.thumbnail) {
        log(
          `  Skipping ${albumName}/${image.filename}: upload needs a thumbnail`,
        );
        failed.push(`${albumName}/${image.filename}`);
        continue;
      }
      // One retry, since the frame drops the odd request while writing flash.
      try {
        await uploadImage(base, albumName, albumDir, image).catch(() =>
          uploadImage(base, albumName, albumDir, image),
        );
        restored++;
        log(`  ${albumName}/${image.filename}`);
      } catch (error) {
        log(`  Failed ${albumName}/${image.filename}: ${error.message}`);
        failed.push(`${albumName}/${image.filename}`);
      }
    }

    const enabledRes = await fetch(
      `${base}/api/albums/enabled?name=${encodeURIComponent(albumName)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: album.enabled }),
      },
    );
    if (!enabledRes.ok) {
      log(`  Could not set ${albumName} enabled=${album.enabled}`);
    }
  }

  log(`Restored ${restored} images, ${failed.length} failed`);
  log(
    `Settings: import ${path.join(dir, SETTINGS)} under Maintenance > Config Backup > Import Config in the web UI`,
  );
  return { restored, failed };
}
