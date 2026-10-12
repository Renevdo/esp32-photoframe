import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { icons } from "./icons";

const srcDir = fileURLToPath(new URL("..", import.meta.url));
const tableFile = fileURLToPath(new URL("./icons.js", import.meta.url));
const thisFile = fileURLToPath(import.meta.url);

function* sourceFiles(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      yield* sourceFiles(path);
    } else if (/\.(vue|js)$/.test(name) && path !== tableFile && path !== thisFile) {
      yield path;
    }
  }
}

// Every `mdi-*` name in the templates and scripts, with the files using it.
// Import statements are skipped: the icon set itself comes from
// vuetify/iconsets/mdi-svg.
function usedIcons() {
  const used = new Map();
  for (const path of sourceFiles(srcDir)) {
    const source = readFileSync(path, "utf8").replace(/^import\b.*$/gm, "");
    for (const [name] of source.matchAll(/\bmdi-[a-z0-9-]+/g)) {
      if (!used.has(name)) used.set(name, []);
      used.get(name).push(path.slice(srcDir.length));
    }
  }
  return used;
}

describe("bundled icons", () => {
  const used = usedIcons();

  it("finds icon names in the sources", () => {
    expect(used.size).toBeGreaterThan(0);
  });

  it("bundles every icon the sources use", () => {
    const missing = [...used]
      .filter(([name]) => !(name in icons))
      .map(([name, files]) => `${name} (${files.join(", ")})`);
    expect(missing, "add these to src/plugins/icons.js").toEqual([]);
  });

  it("bundles no icon the sources do not use", () => {
    const unused = Object.keys(icons).filter((name) => !used.has(name));
    expect(unused, "remove these from src/plugins/icons.js").toEqual([]);
  });

  it("maps every name to SVG path data", () => {
    for (const [name, path] of Object.entries(icons)) {
      expect(path, name).toMatch(/^M[\d.]/);
    }
  });
});
