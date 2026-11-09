import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { crc32 } from "node:zlib";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";
import { stripTextMetadata } from "../strip-metadata";

/**
 * A provider's text in a picture's metadata is never stored (ENC review, Kev
 * 2026-10-17): Pollinations writes the whole composed prompt into the JPEG's
 * EXIF, and the stored original is what showcases and public images serve.
 * Pixels, colour profiles and the XMP "made by AI" label stay; a picture with
 * content credentials (C2PA) is left byte for byte, its signature covers it all.
 */
const SECRET = "SECRET-PROMPT a lighthouse keeper at dusk";
const AI_LABEL = "Iptc4xmpExt:DigitalSourceType=trainedAlgorithmicMedia";
const XMP = `http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>${AI_LABEL}</x:xmpmeta>`;
const has = (buf: Buffer, text: string) => buf.includes(Buffer.from(text, "latin1"));
const pixels = async (buf: Buffer) => (await sharp(buf).raw().toBuffer());
const base = () => sharp({ create: { width: 16, height: 12, channels: 3, background: { r: 200, g: 40, b: 90 } } });

function segment(marker: number, payload: string): Buffer {
  const data = Buffer.from(payload, "latin1");
  const head = Buffer.from([0xff, marker, 0, 0]);
  head.writeUInt16BE(data.length + 2, 2);
  return Buffer.concat([head, data]);
}
function pngChunk(type: string, payload: string): Buffer {
  const data = Buffer.from(payload, "latin1");
  const typed = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(typed) >>> 0);
  return Buffer.concat([len, typed, crc]);
}
function riffChunk(type: string, payload: Buffer): Buffer {
  const head = Buffer.alloc(8); head.write(type, 0, "latin1"); head.writeUInt32LE(payload.length, 4);
  return Buffer.concat([head, payload, payload.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}
const withRiff = (body: Buffer) => {
  const head = Buffer.alloc(12); head.write("RIFF", 0, "latin1"); head.writeUInt32LE(4 + body.length, 4); head.write("WEBP", 8, "latin1");
  return Buffer.concat([head, body]);
};

describe("a JPEG", () => {
  it("loses its EXIF, IPTC and comments, keeps the pixels and the XMP AI label", async () => {
    const encoded = await base().jpeg().withExif({ IFD0: { ImageDescription: SECRET } }).toBuffer();
    const jpeg = Buffer.concat([encoded.subarray(0, 2), segment(0xfe, SECRET), segment(0xed, SECRET), segment(0xe1, XMP), encoded.subarray(2)]);
    const clean = stripTextMetadata(jpeg);
    expect(has(clean, SECRET)).toBe(false);
    expect(has(clean, AI_LABEL)).toBe(true);
    expect((await pixels(clean)).equals(await pixels(jpeg))).toBe(true);
  });

  it("with content credentials is left byte for byte", async () => {
    const encoded = await base().jpeg().withExif({ IFD0: { ImageDescription: SECRET } }).toBuffer();
    const signed = Buffer.concat([encoded.subarray(0, 2), segment(0xeb, "JP\0\x01\0\0\0\x01jumbc2pa manifest"), encoded.subarray(2)]);
    expect(stripTextMetadata(signed)).toBe(signed);
    // an APP11 that is not C2PA is no reason to keep the text
    const other = Buffer.concat([encoded.subarray(0, 2), segment(0xeb, "JP\0\x01 something else"), encoded.subarray(2)]);
    expect(has(stripTextMetadata(other), SECRET)).toBe(false);
  });

  it("loses a comment between the scans of a progressive JPEG and anything after its end", async () => {
    const progressive = await base().jpeg({ progressive: true }).toBuffer();
    const second = progressive.indexOf(Buffer.from([0xff, 0xda]), progressive.indexOf(Buffer.from([0xff, 0xda])) + 2);
    expect(second).toBeGreaterThan(0);
    const jpeg = Buffer.concat([progressive.subarray(0, second), segment(0xfe, SECRET), progressive.subarray(second), Buffer.from(SECRET, "latin1")]);
    const clean = stripTextMetadata(jpeg);
    expect(has(clean, SECRET)).toBe(false);
    expect(clean.subarray(-2).equals(Buffer.from([0xff, 0xd9]))).toBe(true);
    expect((await pixels(clean)).equals(await pixels(progressive))).toBe(true);
  });

  it("skips a stray byte between segments, as decoders do, and still loses the EXIF", async () => {
    const encoded = await base().jpeg().withExif({ IFD0: { ImageDescription: SECRET } }).toBuffer();
    const dqt = encoded.indexOf(Buffer.from([0xff, 0xdb]));
    const jpeg = Buffer.concat([encoded.subarray(0, dqt), Buffer.from([0x00]), encoded.subarray(dqt)]);
    const clean = stripTextMetadata(jpeg);
    expect(has(clean, SECRET)).toBe(false);
    expect((await pixels(clean)).equals(await pixels(encoded))).toBe(true);
  });
});

describe("a PNG", () => {
  it("loses its text chunks and a non-XMP iTXt, keeps the pixels and the XMP AI label", async () => {
    const encoded = await base().png().toBuffer();
    const iend = encoded.length - 12;
    const png = Buffer.concat([
      encoded.subarray(0, iend),
      pngChunk("tEXt", `prompt\0${SECRET}`), pngChunk("zTXt", `Raw profile type iptc\0\0${SECRET}`),
      pngChunk("iTXt", `parameters\0\0\0\0\0${SECRET}`), pngChunk("iTXt", `XML:com.adobe.xmp\0\0\0\0\0<x>${AI_LABEL}</x>`),
      encoded.subarray(iend), Buffer.from(SECRET, "latin1"),
    ]);
    const clean = stripTextMetadata(png);
    expect(has(clean, SECRET)).toBe(false);
    expect(has(clean, AI_LABEL)).toBe(true);
    expect((await pixels(clean)).equals(await pixels(png))).toBe(true);
  });

  it("with content credentials is left byte for byte", async () => {
    const encoded = await base().png().toBuffer();
    const iend = encoded.length - 12;
    const signed = Buffer.concat([encoded.subarray(0, iend), pngChunk("caBX", "c2pa manifest"), pngChunk("tEXt", `prompt\0${SECRET}`), encoded.subarray(iend)]);
    expect(stripTextMetadata(signed)).toBe(signed);
  });
});

describe("a WebP", () => {
  it("loses its EXIF chunk and bytes past its end, announces no EXIF, keeps XMP and the pixels", async () => {
    const encoded = await base().webp({ lossless: true }).withExif({ IFD0: { ImageDescription: SECRET } }).toBuffer();
    const body = Buffer.concat([encoded.subarray(12), riffChunk("XMP ", Buffer.from(XMP, "latin1"))]);
    const webp = Buffer.concat([withRiff(body), Buffer.from(SECRET, "latin1")]);
    expect(has(webp, SECRET)).toBe(true);
    const clean = stripTextMetadata(webp);
    expect(has(clean, SECRET)).toBe(false);
    expect(has(clean, AI_LABEL)).toBe(true);
    expect(clean.readUInt32LE(4)).toBe(clean.length - 8);
    const vp8x = clean.indexOf(Buffer.from("VP8X", "latin1"));
    expect(vp8x).toBeGreaterThan(0);
    expect(clean[vp8x + 8] & 0x08).toBe(0);
    expect((await sharp(clean).metadata()).exif).toBeUndefined();
    expect((await pixels(clean)).equals(await pixels(encoded))).toBe(true);
  });

  it("with content credentials is left byte for byte", async () => {
    const encoded = await base().webp({ lossless: true }).withExif({ IFD0: { ImageDescription: SECRET } }).toBuffer();
    const signed = withRiff(Buffer.concat([encoded.subarray(12), riffChunk("C2PA", Buffer.from("manifest", "latin1"))]));
    expect(stripTextMetadata(signed)).toBe(signed);
  });
});

describe("anything else", () => {
  it("comes back as it went in: unknown bytes, a broken JPEG, a picture with nothing to strip", async () => {
    const junk = Buffer.from("not an image at all");
    expect(stripTextMetadata(junk)).toBe(junk);
    const broken = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff]);
    expect(stripTextMetadata(broken)).toBe(broken);
    const plain = await base().webp().toBuffer();
    expect(stripTextMetadata(plain)).toBe(plain);
  });
});

describe("the store", () => {
  it("strips before every put of a generated or showcase image", () => {
    const store = readSource(join(__dirname, "..", "derivative-store.ts"));
    expect(store).toContain("const { url } = await put(name, stripTextMetadata(buf), { access: \"public\", contentType, addRandomSuffix: false });");
    expect(store).toContain("const buf = stripTextMetadata(raw);");
  });
});
