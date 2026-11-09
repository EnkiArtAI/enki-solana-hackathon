import { describe, it, expect, vi } from "vitest";
import { PHOTO_MAX_BYTES, USER_AGENT, downloadPhoto, photoExt, sha256, storeImportedPhotoSet } from "../post-photos";

/**
 * A referred post's pictures: read from X with our name on the request,
 * only images and only so big, and stored at the publish as the very bytes
 * the preview judged.
 */
vi.mock("@/lib/generation/derivative-store", () => ({
  putDurably: vi.fn(async (name: string) => (name.includes("fail") || (name.includes("norend") && name.endsWith(".webp")) ? null : `https://blob.test/${name}`)),
}));
// The renditions as sharp makes them; a picture it cannot read has none (tryMakeDerivatives answers null).
vi.mock("@/lib/imageDerivatives", () => ({
  tryMakeDerivatives: vi.fn(async (buf: Buffer) => (buf.length > 4
    ? { preview: { buffer: Buffer.from("p") }, thumb: { buffer: Buffer.from("t") }, width: 640, height: 480 }
    : null)),
}));

const reply = (status: number, type: string, bytes: Buffer, length?: number): Response =>
  ({
    ok: status === 200, status,
    headers: { get: (h: string) => (h === "content-type" ? type : h === "content-length" ? String(length ?? bytes.length) : null) },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  }) as unknown as Response;
const fetchOf = (res: Response | Error) => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (res instanceof Error) throw res;
    return res;
  }) as unknown as typeof fetch;
  return { f, calls };
};
const JPG = Buffer.from("ffd8ffe000104a464946", "hex");

describe("downloadPhoto", () => {
  it("reads an image with our name on the request", async () => {
    const { f, calls } = fetchOf(reply(200, "image/jpeg; charset=binary", JPG));
    expect(await downloadPhoto("https://pbs.twimg.com/media/a.jpg", f)).toEqual({ buf: JPG, contentType: "image/jpeg" });
    expect((calls[0].init?.headers as Record<string, string>)["User-Agent"]).toBe(USER_AGENT);
  });

  it("answers null for anything that is not an image we can take: another type, too big, gone, or slow", async () => {
    expect(await downloadPhoto("u", fetchOf(reply(200, "text/html", JPG)).f)).toBeNull();
    expect(await downloadPhoto("u", fetchOf(reply(200, "image/jpeg", JPG, PHOTO_MAX_BYTES + 1)).f)).toBeNull();
    // A server that understates its size is held to the bytes it sends.
    expect(await downloadPhoto("u", fetchOf(reply(200, "image/jpeg", Buffer.alloc(PHOTO_MAX_BYTES + 1), 10)).f)).toBeNull();
    expect(await downloadPhoto("u", fetchOf(reply(200, "image/jpeg", Buffer.alloc(0))).f)).toBeNull();
    expect(await downloadPhoto("u", fetchOf(reply(404, "image/jpeg", JPG)).f)).toBeNull();
    expect(await downloadPhoto("u", fetchOf(new Error("timeout")).f)).toBeNull();
  });

  it("names the stored file by its type", () => {
    expect(photoExt("image/png")).toBe("png");
    expect(photoExt("image/webp")).toBe("webp");
    expect(photoExt("image/jpeg")).toBe("jpg");
    expect(sha256(JPG)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("storeImportedPhotoSet", () => {
  const judged = [{ url: "https://pbs.twimg.com/media/a.jpg", sha256: sha256(JPG) }];

  it("stores the bytes the preview judged under the account, in order, each with its preview and thumb WebP and its facts", async () => {
    const stored = await storeImportedPhotoSet([...judged, { url: "https://pbs.twimg.com/media/b.jpg", sha256: sha256(JPG) }], "u-1", fetchOf(reply(200, "image/jpeg", JPG)).f);
    expect(stored).toHaveLength(2);
    expect(stored?.[0].url).toMatch(/^https:\/\/blob\.test\/showcase\/u-1\/imported_\d+_0_[a-z0-9]+\.jpg$/);
    expect(stored?.[1].url).toMatch(/_1_[a-z0-9]+\.jpg$/);
    expect(stored?.[0]).toEqual({
      url: stored?.[0].url, previewUrl: stored?.[0].url.replace(/\.jpg$/, ".preview.webp"), thumbnailUrl: stored?.[0].url.replace(/\.jpg$/, ".thumb.webp"),
      width: 640, height: 480, mimeType: "image/jpeg", bytes: JPG.length,
    });
    expect(await storeImportedPhotoSet([], "u-1", fetchOf(reply(200, "image/jpeg", JPG)).f)).toEqual([]);
  });

  it("keeps the original when the renditions cannot be made or stored", async () => {
    const tiny = Buffer.from("ffd8", "hex");
    const [none] = (await storeImportedPhotoSet([{ url: "u", sha256: sha256(tiny) }], "u-1", fetchOf(reply(200, "image/jpeg", tiny)).f))!;
    expect(none).toMatchObject({ previewUrl: null, thumbnailUrl: null, width: null, height: null });
    expect(none.url).toMatch(/\.jpg$/);
    const [unstored] = (await storeImportedPhotoSet(judged, "norend", fetchOf(reply(200, "image/jpeg", JPG)).f))!;
    expect(unstored).toMatchObject({ previewUrl: null, thumbnailUrl: null, width: 640 });
  });

  it("stores nothing when a picture changed since it was judged, cannot be read, or cannot be stored", async () => {
    expect(await storeImportedPhotoSet([{ ...judged[0], sha256: "0".repeat(64) }], "u-1", fetchOf(reply(200, "image/jpeg", JPG)).f)).toBeNull();
    expect(await storeImportedPhotoSet(judged, "u-1", fetchOf(reply(404, "image/jpeg", JPG)).f)).toBeNull();
    expect(await storeImportedPhotoSet(judged, "fail", fetchOf(reply(200, "image/jpeg", JPG)).f)).toBeNull();
  });
});
