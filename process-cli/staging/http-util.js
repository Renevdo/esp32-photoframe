/**
 * Shared HTTP helpers for the staging server and the virtual device proxy.
 * Client input problems carry a statusCode so the top-level handler maps
 * them to 4xx instead of 500.
 */

import fs from "fs";

export function json(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

// Stream the file so large epdgz downloads neither block the event loop nor
// buffer whole files in memory.
export function sendFile(res, filePath, contentType) {
  let size;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    return json(res, 404, { error: "not found" });
  }
  res.writeHead(200, {
    "content-type": contentType,
    "content-length": size,
  });
  fs.createReadStream(filePath)
    .on("error", () => res.destroy())
    .pipe(res);
}

export function collectBody(req, cap) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (c) => {
      total += c.length;
      if (total > cap) {
        const err = new Error("body too large");
        err.statusCode = 413;
        // Stop consuming but keep the socket alive so the 413 response can
        // still be delivered; the connection closes after the response.
        req.removeAllListeners("data");
        req.removeAllListeners("end");
        req.pause();
        reject(err);
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function parseJsonBody(buffer) {
  try {
    return JSON.parse(buffer.toString());
  } catch {
    const err = new Error("invalid JSON body");
    err.statusCode = 400;
    throw err;
  }
}
