/**
 * Gzip the built webapp in place, so the firmware embeds compressed bytes and
 * serves them with `Content-Encoding: gzip`.
 *
 * Everything the firmware build emits is text (html, svg, css, js) and lands in
 * the app partition, which is only 3.5 MB on the internal-flash boards
 * (xiao_ee02/ee04, reterminal). Compressing takes ~1067 KB down to ~267 KB and
 * shrinks every page load over the device's WiFi by the same factor. The device
 * never decompresses: it hands the stored bytes to the browser as-is.
 *
 * Originals are replaced, not kept alongside, so main/CMakeLists.txt embeds one
 * copy. Only the firmware build uses this; the GitHub Pages demo build serves
 * plain files.
 */
import { gzipSync } from "zlib";
import { readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";

function gzipTree(dir) {
  let saved = 0;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      saved += gzipTree(full);
      continue;
    }
    if (entry.endsWith(".gz")) {
      continue;
    }
    const raw = readFileSync(full);
    // level 9: build-time cost is irrelevant, flash bytes are not
    const gz = gzipSync(raw, { level: 9 });
    writeFileSync(`${full}.gz`, gz);
    unlinkSync(full);
    saved += raw.length - gz.length;
  }
  return saved;
}

export function gzipAssets() {
  let outDir;
  return {
    name: "gzip-assets",
    apply: "build",
    configResolved(config) {
      outDir = config.build.outDir;
    },
    closeBundle() {
      const saved = gzipTree(outDir);
      this.info(`gzipped embedded assets, saved ${(saved / 1024).toFixed(0)} KB`);
    },
  };
}
