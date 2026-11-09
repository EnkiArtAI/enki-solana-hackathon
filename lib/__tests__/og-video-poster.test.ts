import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";

/**
 * A video prompt's link preview shows its poster. The real next/og and the real route, the poster's bytes real WebP behind
 * a stubbed fetch, and the card's pixels read back: next/og alone leaves the cell empty ("Unsupported image type: image/webp").
 * Blind spot: a real unfurl on X or Discord; a poster on a real store.
 */
const state = vi.hoisted(() => ({ row: {} as Record<string, unknown> }));
vi.mock("@/lib/supabaseServer", () => ({
  getSupabaseServerClient: () => ({
    from: (table: string) => {
      const c: Record<string, unknown> = { maybeSingle: async () => ({ data: table === "prompts" ? state.row : { handle: "mira" }, error: null }) };
      c.select = () => c;
      c.eq = () => c;
      return c;
    },
  }),
}));
vi.mock("@/lib/hidden-owners", () => ({ hiddenOwners: async () => new Set() }));

import { GET } from "../../app/api/og/[id]/route";

const GROUND = [10, 24, 37];
const png = (body: Buffer | null) => new Response(body as BodyInit | null, { status: body ? 200 : 404 });
const near = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]) < 24);
let served: Buffer | null;
// What the route itself fetched: its read has a timeout, next/og's own has none.
const asked: string[] = [];

/** A point in the picture area of the card for these showcase images. */
const middle = async (showcase: unknown[]) => {
  state.row = { title: "T", showcase_images: showcase, price_usd_cents: 0, is_free_showcase: true, creator_id: "u", aspect_ratio: "16:9", is_listed: true, listing_status: "active", deleted_at: null };
  const res = await GET(new Request("http://enki.test/api/og/p1"), { params: Promise.resolve({ id: "p1" }) });
  expect(res.status).toBe(200);
  const { data, info } = await sharp(Buffer.from(await res.arrayBuffer())).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const at = (Math.floor((630 - 96) / 2) * info.width + Math.floor(info.width / 4)) * 3; // Beside the brand card's words.
  return [...data.subarray(at, at + 3)];
};

beforeEach(() => {
  asked.length = 0;
  vi.stubGlobal("fetch", async (u: RequestInfo | URL, init?: RequestInit) => {
    if (init?.signal) asked.push(String(u));
    // A second image beside a poster that cannot be read.
    if (String(u).endsWith("/other.png")) return png(await sharp({ create: { width: 480, height: 270, channels: 3, background: "#10c010" } }).png().toBuffer());
    return png(served);
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("the card of a prompt with a WebP poster", () => {
  it("draws the poster", async () => {
    served = await sharp({ create: { width: 480, height: 270, channels: 3, background: "#d01010" } }).webp({ quality: 75 }).toBuffer();
    const colour = await middle(["https://v.test/p/poster.webp"]);
    expect(near(colour, [208, 16, 16])).toBe(true);
    expect(asked).toEqual(["https://v.test/p/poster.webp"]);
  }, 60_000);

  it("takes an address with a query too", async () => {
    served = await sharp({ create: { width: 480, height: 270, channels: 3, background: "#d01010" } }).webp().toBuffer();
    expect(near(await middle(["https://v.test/p/poster.webp?v=2"]), [208, 16, 16])).toBe(true);
  }, 60_000);

  it("still renders the card when the poster cannot be read", async () => {
    served = null;
    expect(near(await middle(["https://v.test/p/poster.webp"]), GROUND)).toBe(true);
    served = Buffer.from("not a picture");
    expect(near(await middle(["https://v.test/p/poster.webp"]), GROUND)).toBe(true);
  }, 60_000);

  it("leaves a poster that cannot be read out of the grid: the other image takes the whole card", async () => {
    served = null;
    expect(near(await middle(["https://v.test/p/poster.webp", "https://v.test/p/other.png"]), [16, 192, 16])).toBe(true);
  }, 60_000);

  it("leaves a PNG as it was: next/og reads it itself, untouched", async () => {
    served = await sharp({ create: { width: 480, height: 270, channels: 3, background: "#10c010" } }).png().toBuffer();
    expect(near(await middle(["https://v.test/p/image.png"]), [16, 192, 16])).toBe(true);
    expect(asked).toEqual([]);
  }, 60_000);
});
