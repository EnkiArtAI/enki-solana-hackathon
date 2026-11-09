import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A reference is stored under its content hash, so the same photo sent twice
 * names the same blob. @vercel/blob refuses to write an existing pathname
 * unless asked to (allowOverwrite defaults to false, node_modules/@vercel/blob
 * dist/client.d.ts:392), which cost every render after the first its record.
 */
const stored = new Set<string>();
vi.mock("@vercel/blob", () => ({
  put: vi.fn(async (path: string, _body: Buffer, opts: { allowOverwrite?: boolean }) => {
    if (stored.has(path) && !opts.allowOverwrite) throw new Error("Vercel Blob: This blob already exists");
    stored.add(path);
    return { url: `https://blob.example/${path}` };
  }),
}));

import { storeReferenceImages } from "@/lib/generation/reference-images";

const PHOTO = `data:image/png;base64,${Buffer.from("one photo").toString("base64")}`;

describe("storing a render's reference images", () => {
  beforeEach(() => { vi.stubEnv("BLOB_READ_WRITE_TOKEN", "test"); stored.clear(); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it("keeps the record of a photo it already stored for an earlier render", async () => {
    const [first] = await storeReferenceImages([PHOTO], "user-1");
    const [again] = await storeReferenceImages([PHOTO], "user-1");
    expect(first?.url).toMatch(/^https:\/\/blob\.example\/references\/user-1\/[0-9a-f]{64}\.png$/);
    expect(again).toEqual(first);
  });
});
