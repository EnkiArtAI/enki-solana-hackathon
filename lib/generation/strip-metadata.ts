/**
 * Text a provider wrote into a picture's metadata goes before we store it
 * (ENC review, Kev 2026-10-17): Pollinations puts the whole composed prompt
 * into the JPEG's EXIF, and the stored original is what showcases and public
 * images serve. Lossless: the segments that carry free text go (JPEG EXIF,
 * IPTC and comments; PNG tEXt, zTXt, eXIf and non-XMP iTXt; WebP EXIF), and
 * so does anything after the picture's end.
 *
 * Kept: pixels, colour profiles, and XMP, which carries the "made by AI"
 * label (IPTC DigitalSourceType). A picture with content credentials (C2PA)
 * is left byte for byte: its signature covers the whole file, and the signing
 * providers seen so far (Gemini, OpenAI) write no prompt into it. Bytes it
 * cannot parse come back as they went in: a picture is never broken for its
 * metadata.
 */
export function stripTextMetadata(buf: Buffer): Buffer {
  try {
    return jpeg(buf) ?? png(buf) ?? webp(buf) ?? buf;
  } catch {
    return buf;
  }
}

const XMP_HEADERS = ["http://ns.adobe.com/xap/1.0/\0", "http://ns.adobe.com/xmp/extension/\0"];
const isXmp = (body: Buffer) => XMP_HEADERS.some((h) => body.toString("latin1", 0, h.length) === h);
const RESTART = (m: number) => m >= 0xd0 && m <= 0xd7;

function jpeg(buf: Buffer): Buffer | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  const out: Buffer[] = [buf.subarray(0, 2)];
  let i = 2;
  while (i + 1 < buf.length) {
    if (buf[i] !== 0xff) { i += 1; continue; } // a stray byte between segments: decoders skip it, so do we
    const m = buf[i + 1];
    if (m === 0xff) { i += 1; continue; } // fill byte
    if (m === 0xd9) return Buffer.concat([...out, buf.subarray(i, i + 2)]); // EOI: whatever follows goes
    if (m === 0x01 || m === 0xd8 || RESTART(m)) { out.push(buf.subarray(i, i + 2)); i += 2; continue; }
    if (i + 4 > buf.length) return null;
    const end = i + 2 + buf.readUInt16BE(i + 2);
    if (end > buf.length || end < i + 4) return null;
    const body = buf.subarray(i + 4, end);
    if (m === 0xeb && body.includes("c2pa")) return buf; // content credentials: the signature covers every byte
    const text = m === 0xfe || m === 0xed || (m === 0xe1 && !isXmp(body)); // comment, IPTC, EXIF
    if (!text) out.push(buf.subarray(i, end));
    i = end;
    if (m === 0xda) {
      // Entropy-coded data, kept whole, up to the next marker (between the scans of a progressive JPEG too).
      let j = i;
      while (j + 1 < buf.length && !(buf[j] === 0xff && buf[j + 1] !== 0x00 && !RESTART(buf[j + 1]))) j += 1;
      if (j + 1 >= buf.length) return Buffer.concat([...out, buf.subarray(i)]);
      out.push(buf.subarray(i, j));
      i = j;
    }
  }
  return null;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_TEXT = new Set(["tEXt", "zTXt", "eXIf"]);

function png(buf: Buffer): Buffer | null {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  const out: Buffer[] = [buf.subarray(0, 8)];
  let i = 8;
  while (i + 12 <= buf.length) {
    const type = buf.toString("latin1", i + 4, i + 8);
    const end = i + 12 + buf.readUInt32BE(i);
    if (end > buf.length) return null;
    if (type === "caBX") return buf; // content credentials: the signature covers every byte
    const text = PNG_TEXT.has(type) || (type === "iTXt" && buf.toString("latin1", i + 8, i + 8 + 18) !== "XML:com.adobe.xmp\0");
    if (!text) out.push(buf.subarray(i, end));
    i = end;
    if (type === "IEND") return Buffer.concat(out); // whatever follows goes
  }
  return null;
}

function webp(buf: Buffer): Buffer | null {
  if (buf.length < 12 || buf.toString("latin1", 0, 4) !== "RIFF" || buf.toString("latin1", 8, 12) !== "WEBP") return null;
  const riffEnd = Math.min(buf.length, 8 + buf.readUInt32LE(4));
  const chunks: Buffer[] = [];
  let i = 12;
  while (i + 8 <= riffEnd) {
    const type = buf.toString("latin1", i, i + 4);
    const size = buf.readUInt32LE(i + 4);
    const end = i + 8 + size + (size & 1);
    if (end > riffEnd + (size & 1)) return null;
    if (type === "C2PA") return buf; // content credentials: the signature covers every byte
    if (type !== "EXIF") chunks.push(Buffer.from(buf.subarray(i, Math.min(end, buf.length))));
    i = end;
  }
  // The extended header announces EXIF (0x08); it is gone now. Bytes past the RIFF end go too.
  for (const c of chunks) if (c.toString("latin1", 0, 4) === "VP8X") c[8] &= ~0x08;
  const body = Buffer.concat(chunks);
  if (12 + body.length === buf.length) return buf;
  const head = Buffer.alloc(12);
  head.write("RIFF", 0, "latin1");
  head.writeUInt32LE(4 + body.length, 4);
  head.write("WEBP", 8, "latin1");
  return Buffer.concat([head, body]);
}
