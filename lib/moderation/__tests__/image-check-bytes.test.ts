import { describe, it, expect, beforeEach, vi } from "vitest";
import { crc32 } from "node:zlib";
import sharp from "sharp";

/**
 * The judges see what the calibration of 2026-10-08 measured: a JPEG of at
 * most 1024 px made from the bytes in hand, never a 4K original. They see one
 * frame, so an animation is refused, and a transparent image is seen on black
 * and on white.
 */

const seen = vi.hoisted(() => ({ urls: [] as string[], answers: [] as Record<string, unknown>[] }));
vi.mock("@/lib/moderation/image-check", () => ({
  checkImage: async (url: string) => { seen.urls.push(url); return seen.answers.shift() ?? { verdict: "clear" }; },
}));

import { checkImageBytes, dataUrlBytes, isLink } from "@/lib/moderation/image-check-bytes";

beforeEach(() => { seen.urls = []; seen.answers = []; });

const image = (w: number, h: number) =>
  sharp({ create: { width: w, height: h, channels: 3, background: { r: 10, g: 120, b: 200 } } }).png().toBuffer();
const rgba = (alpha: number) =>
  sharp({ create: { width: 8, height: 8, channels: 4, background: { r: 128, g: 128, b: 128, alpha } } }).png().toBuffer();
const pixel = async (url: string) => [...(await sharp(dataUrlBytes(url)!).raw().toBuffer()).subarray(0, 3)];

/** A PNG with one more chunk right after its header. */
const withChunk = (png: Buffer, type: string, data: Buffer) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  const end = 8 + 12 + png.readUInt32BE(8);
  return Buffer.concat([png.subarray(0, end), len, body, crc, png.subarray(end)]);
};

// ENC review (2026-10-27): what an image spells out is compared with a paid prompt's hidden words.
describe("the text an image shows", () => {
  it("comes from every view the judges saw, and stays away when none shows any", async () => {
    seen.answers = [{ verdict: "clear", text: "ON BLACK" }, { verdict: "clear", text: "ON WHITE" }];
    expect(await checkImageBytes(await rgba(0.5))).toEqual({ verdict: "clear", text: ["ON BLACK", "ON WHITE"].join("\n") });
    seen.answers = [{ verdict: "clear" }];
    expect(await checkImageBytes(await image(16, 16))).toEqual({ verdict: "clear" });
  });
});

describe("checkImageBytes", () => {
  it("shows the judges a JPEG of at most 1024 px on the long edge", async () => {
    expect(await checkImageBytes(await image(3840, 2160))).toEqual({ verdict: "clear" });
    expect(seen.urls).toHaveLength(1);
    const bytes = dataUrlBytes(seen.urls[0])!;
    expect(seen.urls[0].startsWith("data:image/jpeg;base64,")).toBe(true);
    const meta = await sharp(bytes).metadata();
    expect(meta.format).toBe("jpeg");
    expect([meta.width, meta.height]).toEqual([1024, 576]);
  });

  it("never enlarges a small image", async () => {
    await checkImageBytes(await image(300, 200));
    expect((await sharp(dataUrlBytes(seen.urls[0])!).metadata()).width).toBe(300);
  });

  it("refuses bytes that are no image for good, and asks nobody", async () => {
    expect(await checkImageBytes(Buffer.from("not an image"))).toEqual({ verdict: "blocked", reason: "not an image" });
    expect(seen.urls).toEqual([]);
  });

  it("refuses an image that does not decode whole (a cut file), apart from bytes that are no image", async () => {
    // Noise, so the scan data is long enough to lose its tail and keep its header.
    const raw = Buffer.from(Array.from({ length: 256 * 256 * 3 }, (_, i) => (i * 7919) % 251));
    const jpeg = await sharp(raw, { raw: { width: 256, height: 256, channels: 3 } }).jpeg().toBuffer();
    expect(await checkImageBytes(jpeg.subarray(0, jpeg.length - 2000))).toEqual({ verdict: "blocked", reason: "unreadable" });
    expect(seen.urls).toEqual([]);
  });

  it("judges a still GIF, WebP and JPEG", async () => {
    for (const still of [await sharp(await image(8, 8)).gif().toBuffer(), await sharp(await image(8, 8)).webp().toBuffer(), await sharp(await image(8, 8)).jpeg().toBuffer()]) {
      expect(await checkImageBytes(still)).toEqual({ verdict: "clear" });
    }
    expect(seen.urls).toHaveLength(3);
  });

  const animations = async () => {
    const frames = [await image(8, 8), await sharp({ create: { width: 8, height: 8, channels: 3, background: "#000" } }).png().toBuffer()];
    return [
      await sharp(frames, { join: { animated: true } }).gif().toBuffer(),
      await sharp(frames, { join: { animated: true } }).webp().toBuffer(),
      withChunk(await image(8, 8), "acTL", Buffer.from([0, 0, 0, 2, 0, 0, 0, 0])),
    ];
  };

  it("refuses an animation, which the judges see by its first frame only, whatever that frame shows", async () => {
    for (const animated of await animations()) {
      expect(await checkImageBytes(animated)).toEqual({ verdict: "blocked", reason: "not a still" });
    }
    // Judged all the same: one first frame each.
    expect(seen.urls).toHaveLength(3);
  });

  it("an animation whose first frame is child safety is a child-safety case, not a mere refusal", async () => {
    for (const animated of await animations()) {
      seen.answers = [{ verdict: "child_safety", scores: { minor: 0.9 } }];
      // A clearance lifts child_safety alone: an animation stays refused for what it is.
      expect(await checkImageBytes(animated)).toEqual({ verdict: "child_safety", scores: { minor: 0.9 }, otherwise: { verdict: "blocked", reason: "not a still" } });
    }
  });

  it("says what else the judges found, the worse of every view; a clear image carries nothing of it", async () => {
    seen.answers = [{ verdict: "child_safety", otherwise: { verdict: "adult", reason: "suggestive" } }];
    expect(await checkImageBytes(await image(8, 8))).toEqual({ verdict: "child_safety", otherwise: { verdict: "adult", reason: "suggestive" } });
    // One view found nothing, the other child safety with explicit under it; and the other way round.
    seen.answers = [{ verdict: "clear" }, { verdict: "child_safety", otherwise: { verdict: "blocked", reason: "explicit" } }];
    expect((await checkImageBytes(await rgba(0.5))).otherwise).toEqual({ verdict: "blocked", reason: "explicit" });
    seen.answers = [{ verdict: "blocked", reason: "explicit" }, { verdict: "child_safety", otherwise: { verdict: "clear" } }];
    expect((await checkImageBytes(await rgba(0.5))).otherwise).toEqual({ verdict: "blocked", reason: "explicit" });
    seen.answers = [{ verdict: "adult", reason: "graphic" }];
    expect(await checkImageBytes(await image(8, 8))).not.toHaveProperty("otherwise");
  });

  it("gives no way through when a view has child_safety and no other findings", async () => {
    seen.answers = [{ verdict: "child_safety", otherwise: { verdict: "clear" } }, { verdict: "child_safety" }];
    expect((await checkImageBytes(await rgba(0.5))).otherwise).toBeUndefined();
  });

  it("reads an APNG's chunks, so a still PNG whose text says acTL is still judged", async () => {
    expect(await checkImageBytes(withChunk(await image(8, 8), "tEXt", Buffer.from("Comment\0acTL", "latin1")))).toEqual({ verdict: "clear" });
    expect(seen.urls).toHaveLength(1);
  });

  it("refuses a format a browser may play or that is no picture (SVG, TIFF), judged first all the same", async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>');
    for (const other of [svg, await sharp(await image(8, 8)).tiff().toBuffer()]) {
      expect(await checkImageBytes(other)).toEqual({ verdict: "blocked", reason: "not a still" });
      seen.answers = [{ verdict: "child_safety" }];
      expect((await checkImageBytes(other)).verdict).toBe("child_safety");
    }
  });

  it("judges a transparent image on black and on white", async () => {
    await checkImageBytes(await rgba(0));
    expect(seen.urls).toHaveLength(2);
    expect(await pixel(seen.urls[0])).toEqual([0, 0, 0]);
    expect((await pixel(seen.urls[1])).every((c) => c >= 250)).toBe(true);
  });

  it("judges an image with an alpha channel but no transparency once", async () => {
    await checkImageBytes(await rgba(1));
    expect(seen.urls).toHaveLength(1);
  });

  it("keeps the worse of the two views, a child-safety one above all", async () => {
    const cases: [Record<string, unknown>, Record<string, unknown>, string][] = [
      [{ verdict: "clear" }, { verdict: "child_safety", scores: { minor: 0.9 } }, "child_safety"],
      [{ verdict: "child_safety" }, { verdict: "blocked", reason: "explicit" }, "child_safety"],
      [{ verdict: "unavailable", reason: "x" }, { verdict: "blocked", reason: "explicit" }, "blocked"],
      [{ verdict: "adult", reason: "suggestive" }, { verdict: "unavailable", reason: "x" }, "unavailable"],
      [{ verdict: "clear" }, { verdict: "adult", reason: "graphic" }, "adult"],
    ];
    for (const [onBlack, onWhite, worst] of cases) {
      seen.answers = [onBlack, onWhite];
      expect((await checkImageBytes(await rgba(0.5))).verdict).toBe(worst);
    }
    seen.answers = [{ verdict: "clear" }, { verdict: "child_safety", scores: { minor: 0.9 } }];
    expect(await checkImageBytes(await rgba(0.5))).toEqual({ verdict: "child_safety", scores: { minor: 0.9 } });
  });
});

describe("isLink", () => {
  it("tells an address from an image carried whole", () => {
    for (const link of ["https://arweave.net/x.png", "http://x.test/a", " HTTPS://X.TEST/a", "\u0001https://x.test/a", "ht\ttps://x.test/a", "blob:https://enki.art/1", "ipfs://bafy/1.png"]) expect(isLink(link), link).toBe(true);
    for (const image of ["data:image/png;base64,iVBORw0KGgo=", "\u0001data:image/png;base64,iVBORw0KGgo=", "iVBORw0KGgo=", "/9j/4AAQSkZJRg==", "R0lGODlhAQABAAAAACw="]) expect(isLink(image), image).toBe(false);
  });
});

describe("dataUrlBytes", () => {
  it("reads a data: URL as a browser does, and nothing else", () => {
    expect(dataUrlBytes("data:image/png;base64,aGVsbG8=")?.toString()).toBe("hello");
    // Any spelling a browser reads: case, no media type, parameters, spaces and
    // controls around it, tabs and line breaks anywhere.
    for (const url of [
      "DATA:Image/PNG;BASE64,aGVsbG8=", "data:;base64,aGVsbG8=", "data:image/png;name=a.png;base64,aGVsbG8=", "data:image/png; base64 ,aGVsbG8=",
      " data:image/png;base64,aGVsbG8= ", "\u0001data:image/png;base64,aGVsbG8=\u001f", "d\ta\nt\ra:image/png;base64,aGVs\nbG8=",
    ]) {
      expect(dataUrlBytes(url)?.toString(), JSON.stringify(url)).toBe("hello");
    }
    // Without base64, percent-encoded bytes, the rest as UTF-8.
    expect(dataUrlBytes("data:text/plain,hello")?.toString()).toBe("hello");
    expect(dataUrlBytes("data:image/svg+xml,%3Csvg%2F%3E")?.toString()).toBe("<svg/>");
    expect([...dataUrlBytes("data:,%89P%c3é")!]).toEqual([0x89, 0x50, 0xc3, 0xc3, 0xa9]);
    expect(dataUrlBytes("data:,100% sure")?.toString()).toBe("100% sure");
    expect(dataUrlBytes("https://x.test/a.png")).toBeNull();
    expect(dataUrlBytes("data:no comma")).toBeNull();
  });
});

describe("the type a still image's bytes are (round 5, 2026-10-20)", () => {
  it("reads PNG, JPEG, WebP and GIF from their magic numbers, and nothing else", async () => {
    const { stillImageType } = await import("@/lib/moderation/image-check-bytes");
    const b = (...bytes: (number | string)[]) => Buffer.concat(bytes.map((x) => (typeof x === "string" ? Buffer.from(x, "latin1") : Buffer.from([x]))));
    expect(stillImageType(b(0x89, "PNG\r\n\x1a\n", 0))).toBe("image/png");
    expect(stillImageType(b(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
    expect(stillImageType(b("RIFF", "\0\0\0\0", "WEBP"))).toBe("image/webp");
    expect(stillImageType(b("GIF89a"))).toBe("image/gif");
    expect(stillImageType(b("RIFF", "\0\0\0\0", "WAVE"))).toBeNull();
    expect(stillImageType(b("not an image"))).toBeNull();
    expect(stillImageType(Buffer.alloc(0))).toBeNull();
  });
});

describe("a reference as a provider takes it (round 6, 2026-10-20)", () => {
  it("re-encodes a still GIF as PNG, and passes PNG, JPEG and WebP as they are", async () => {
    const { providerReference, stillImageType } = await import("@/lib/moderation/image-check-bytes");
    const pixel = sharp({ create: { width: 2, height: 2, channels: 3, background: "#ff0000" } });
    const gif = await pixel.clone().gif().toBuffer();
    const sent = await providerReference(gif);
    expect(sent.startsWith("data:image/png;base64,")).toBe(true);
    expect(stillImageType(Buffer.from(sent.split(",")[1], "base64"))).toBe("image/png");
    for (const [format, type] of [["png", "image/png"], ["jpeg", "image/jpeg"], ["webp", "image/webp"]] as const) {
      const bytes = await pixel.clone().toFormat(format).toBuffer();
      expect(await providerReference(bytes)).toBe(`data:${type};base64,${bytes.toString("base64")}`);
    }
  });
});
