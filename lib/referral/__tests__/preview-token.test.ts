import { describe, it, expect, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import { resetKeyringCache } from "@/lib/crypto";
import { openPreview, sealPreview, PREVIEW_TTL_MS, type ImportPreview } from "../preview-token";

/**
 * A referred post travels sealed between the preview and the publish: what
 * the client shows is what the server read, and a changed byte, another
 * account or an hour's wait opens nothing.
 */
const preview: ImportPreview = {
  v: 1, userId: "u-1", exp: 2_000_000_000_000,
  source: { url: "https://x.com/ann/status/1", normalized: "x.com/status/1", handle: "ann", authorId: "42" },
  prompt: "A cinematic portrait of a lighthouse keeper at dawn", generators: ["GPT-Image-2"],
  photos: [{ url: "https://pbs.twimg.com/media/a.jpg", sha256: "ab".repeat(32) }],
  title: "Lighthouse keeper at dawn", category: "Characters", tags: ["lighthouse", "portrait"], adult: false,
};

beforeEach(() => {
  process.env.FIELD_ENCRYPTION_KEY_B64 = randomBytes(32).toString("base64");
  resetKeyringCache();
});

describe("the sealed preview", () => {
  it("opens to exactly what was sealed", () => {
    expect(openPreview(sealPreview(preview), 1_000)).toEqual(preview);
    expect(PREVIEW_TTL_MS).toBe(3_600_000);
  });

  it("opens nothing after a changed byte, with another key, or from garbage", () => {
    const token = sealPreview(preview);
    const i = Math.floor(token.length / 2);
    const flipped = token.slice(0, i) + (token[i] === "A" ? "B" : "A") + token.slice(i + 1);
    expect(openPreview(flipped, 1_000)).toBeNull();
    process.env.FIELD_ENCRYPTION_KEY_B64 = randomBytes(32).toString("base64");
    resetKeyringCache();
    expect(openPreview(token, 1_000)).toBeNull();
    expect(openPreview("not a token", 1_000)).toBeNull();
    expect(openPreview("", 1_000)).toBeNull();
    expect(openPreview(undefined, 1_000)).toBeNull();
    expect(openPreview(42, 1_000)).toBeNull();
  });

  it("expires", () => {
    const token = sealPreview({ ...preview, exp: 5_000 });
    expect(openPreview(token, 4_999)).not.toBeNull();
    expect(openPreview(token, 5_001)).toBeNull();
  });

  it.each([
    { prompt: "  " },
    { userId: "" },
    { v: 2 },
    { generators: "all" },
    { tags: [1] },
    { adult: "yes" },
    { photos: [{ url: "https://x/a.jpg" }] },
    { source: { url: "u", handle: "h" } },
    { source: { url: "u", normalized: "n", handle: "h" } },
    { title: 3 },
  ])("opens nothing that is not shaped like a preview: %j", (over) => {
    const token = sealPreview({ ...preview, ...(over as Partial<ImportPreview>) });
    expect(openPreview(token, 1_000)).toBeNull();
  });
});
