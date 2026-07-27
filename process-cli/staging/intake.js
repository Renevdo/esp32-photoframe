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

// Client sent an invalid name: an HTTP 400, not a server error.
function unsafeNameError(what) {
  const err = new Error(`unsafe ${what}`);
  err.statusCode = 400;
  return err;
}

export async function addPhoto(store, album, filename, buffer, ctx) {
  if (!isSafeName(album) || !isSafeName(filename)) {
    throw unsafeNameError("album or file name");
  }
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);

  // The pipeline loads from a path (HEIC/EXIF handling), so stage to a temp file.
  const tmp = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "intake-")),
    filename,
  );
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
    throw unsafeNameError("album or file name");
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
    throw unsafeNameError("album name");
  }
  fs.rmSync(path.join(store.albumsDir, album), {
    recursive: true,
    force: true,
  });
  fs.rmSync(path.join(store.originalsDir, album), {
    recursive: true,
    force: true,
  });
}
