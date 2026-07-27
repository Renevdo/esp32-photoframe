/**
 * Minimal multipart/form-data parser for device-API uploads (image +
 * thumbnail parts). No streaming: bodies are already buffered by the server.
 */

function indexOfBuffer(haystack, needle, from) {
  return haystack.indexOf(needle, from);
}

export function parseMultipart(body, contentTypeHeader) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentTypeHeader || "");
  if (!m) {
    throw new Error("missing multipart boundary");
  }
  const boundary = Buffer.from(`--${(m[1] || m[2]).trim()}`);
  const parts = [];

  let pos = indexOfBuffer(body, boundary, 0);
  while (pos !== -1) {
    pos += boundary.length;
    // terminal boundary ends with --
    if (body[pos] === 0x2d && body[pos + 1] === 0x2d) {
      break;
    }
    // skip CRLF after boundary
    if (body[pos] === 0x0d && body[pos + 1] === 0x0a) {
      pos += 2;
    }
    const headerEnd = indexOfBuffer(body, Buffer.from("\r\n\r\n"), pos);
    if (headerEnd === -1) {
      break;
    }
    const headerText = body.slice(pos, headerEnd).toString("utf8");
    const nameMatch = /name="([^"]*)"/i.exec(headerText);
    const fileMatch = /filename="([^"]*)"/i.exec(headerText);

    const dataStart = headerEnd + 4;
    let dataEnd = indexOfBuffer(body, boundary, dataStart);
    if (dataEnd === -1) {
      break;
    }
    let realEnd = dataEnd;
    // strip the CRLF that precedes the next boundary
    if (body[realEnd - 2] === 0x0d && body[realEnd - 1] === 0x0a) {
      realEnd -= 2;
    }
    parts.push({
      name: nameMatch ? nameMatch[1] : "",
      filename: fileMatch ? fileMatch[1] : undefined,
      data: body.slice(dataStart, realEnd),
    });
    pos = dataEnd;
  }
  return parts;
}
