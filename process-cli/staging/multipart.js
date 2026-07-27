/**
 * Minimal multipart/form-data parser for device-API uploads (image +
 * thumbnail parts). No streaming: bodies are already buffered by the server.
 *
 * Boundary matching is anchored to the preceding CRLF (RFC 2046), so a part
 * whose binary payload happens to contain the boundary byte sequence is not
 * truncated.
 */

export function parseMultipart(body, contentTypeHeader) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentTypeHeader || "");
  if (!m) {
    throw new Error("missing multipart boundary");
  }
  const token = (m[1] || m[2]).trim();
  const first = Buffer.from(`--${token}`);
  const delim = Buffer.from(`\r\n--${token}`);
  const headerSep = Buffer.from("\r\n\r\n");
  const parts = [];

  let pos = body.indexOf(first);
  if (pos === -1) {
    return parts;
  }
  pos += first.length;

  for (;;) {
    // terminal boundary ends with --
    if (body[pos] === 0x2d && body[pos + 1] === 0x2d) {
      break;
    }
    // skip CRLF after the boundary line
    if (body[pos] === 0x0d && body[pos + 1] === 0x0a) {
      pos += 2;
    }

    const headerEnd = body.indexOf(headerSep, pos);
    if (headerEnd === -1) {
      break;
    }
    const headerText = body.slice(pos, headerEnd).toString("utf8");
    const nameMatch = /name="([^"]*)"/i.exec(headerText);
    const fileMatch = /filename="([^"]*)"/i.exec(headerText);

    const dataStart = headerEnd + 4;
    const dataEnd = body.indexOf(delim, dataStart);
    if (dataEnd === -1) {
      break;
    }
    parts.push({
      name: nameMatch ? nameMatch[1] : "",
      filename: fileMatch ? fileMatch[1] : undefined,
      data: body.slice(dataStart, dataEnd),
    });
    pos = dataEnd + delim.length;
  }
  return parts;
}
