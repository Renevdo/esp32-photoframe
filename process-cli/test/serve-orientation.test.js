/**
 * Jest test suite for image serving in --serve mode
 *
 * Tests that for all 3 formats (JPG, PNG, BMP):
 * - Both portrait and landscape source images produce landscape served images (800x480)
 * - Correct content-type headers are set
 */

import { loadImage } from "canvas";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";
import { createImageServer } from "../server.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Each suite listens on an ephemeral port (0) and reads back the assigned one,
// so a real `--serve` running on a fixed port cannot collide with the tests.
const EPHEMERAL_PORT = 0;

async function getImageDimensions(buffer) {
  const img = await loadImage(buffer);
  return { width: img.width, height: img.height };
}

async function fetchImage(port) {
  const response = await fetch(`http://localhost:${port}/image`);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch image: ${response.status} ${response.statusText}`,
    );
  }

  const contentType = response.headers.get("content-type");
  const buffer = await response.arrayBuffer();

  return {
    buffer: Buffer.from(buffer),
    contentType,
  };
}

describe.each(["jpg", "png", "bmp"])(
  "Image serving tests - %s format",
  (format) => {
    let server;
    let port;

    beforeAll(async () => {
      const albumDir = path.join(__dirname, "test-albums");
      server = await createImageServer(
        albumDir,
        EPHEMERAL_PORT,
        format,
        null, // devicePalette
        null, // deviceSettings
        { silent: true },
      );
      port = server.address().port;
    }, 30000);

    afterAll(async () => {
      if (server) {
        await new Promise((resolve) => {
          server.close(resolve);
        });
      }
    });

    test("served image should be landscape (800x480) with correct content-type", async () => {
      const { buffer, contentType } = await fetchImage(port);

      const expectedType = format === "jpg" ? "image/jpeg" : `image/${format}`;
      expect(contentType).toBe(expectedType);

      const dims = await getImageDimensions(buffer);
      expect(dims.width).toBe(800);
      expect(dims.height).toBe(480);
    });

    test("served image from second fetch should also be landscape (800x480)", async () => {
      const { buffer } = await fetchImage(port);
      const dims = await getImageDimensions(buffer);
      expect(dims.width).toBe(800);
      expect(dims.height).toBe(480);
    });
  },
);
