import { parseMultipart } from "../staging/multipart.js";

function buildBody(boundary, parts) {
  const chunks = [];
  for (const p of parts) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"`;
    if (p.filename) head += `; filename="${p.filename}"`;
    head += "\r\n";
    if (p.contentType) head += `Content-Type: ${p.contentType}\r\n`;
    head += "\r\n";
    chunks.push(Buffer.from(head), p.data, Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

test("parses image + thumbnail parts with binary bytes intact", () => {
  const binary = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  const body = buildBody("XBOUND", [
    {
      name: "image",
      filename: "pic.epdgz",
      contentType: "application/octet-stream",
      data: binary,
    },
    {
      name: "thumbnail",
      filename: "pic.jpg",
      contentType: "image/jpeg",
      data: Buffer.from("jpegdata"),
    },
  ]);
  const parts = parseMultipart(body, "multipart/form-data; boundary=XBOUND");
  expect(parts).toHaveLength(2);
  expect(parts[0].name).toBe("image");
  expect(parts[0].filename).toBe("pic.epdgz");
  expect(Buffer.compare(parts[0].data, binary)).toBe(0);
  expect(parts[1].name).toBe("thumbnail");
  expect(parts[1].data.toString()).toBe("jpegdata");
});

test("supports quoted boundary", () => {
  const body = buildBody("q b", [
    { name: "image", filename: "a.png", data: Buffer.from("x") },
  ]);
  const parts = parseMultipart(body, 'multipart/form-data; boundary="q b"');
  expect(parts).toHaveLength(1);
  expect(parts[0].filename).toBe("a.png");
});

test("throws without boundary", () => {
  expect(() => parseMultipart(Buffer.from("x"), "text/plain")).toThrow(
    /boundary/i,
  );
});
