import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Kev, 2026-11-04: "videos sind nicht umsonst. die kosten alle." What a link's card, a link's head and /showcase call an Open
 * video prompt; an image keeps its words. The real routes and the real page's metadata, the database a double, next/og's
 * element read before it is drawn. The feed card, the Image View and Create prompt are driven in a browser (DEC-2026-11-04-04).
 * Blind spot: no real unfurl, and /showcase's grid is rendered to a string, not driven.
 */
const s = vi.hoisted(() => ({ row: {} as Record<string, unknown>, sql52: true, selects: [] as string[], drawn: null as unknown }));
vi.mock("@/lib/hidden-owners", () => ({ hiddenOwners: async () => new Set() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }) }));
vi.mock("next/og", () => ({ ImageResponse: class { constructor(element: unknown) { s.drawn = element; } } }));
vi.mock("../../app/generator/[id]/GeneratorClient", () => ({ default: () => null }));
vi.mock("@/lib/supabaseServer", () => ({
  getSupabaseServerClient: () => ({
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      let cols = "";
      let elsewhere = false;
      let askedMedia = false;
      const answer = () => {
        if (table === "users") return { data: { handle: "mira" }, error: null };
        if (table !== "prompts") return { data: [], error: null };
        if ((cols.includes("media_type") || askedMedia) && !s.sql52) return { data: null, error: { code: "42703", message: "column prompts.media_type does not exist" } };
        return { data: elsewhere ? null : s.row, error: null };
      };
      q.select = (c: string) => { cols = c; s.selects.push(`${table}:${c}`); return q; };
      for (const name of ["in", "is", "not", "order", "limit", "range"]) q[name] = () => q;
      q.eq = (c: string, v: unknown) => {
        if (c === "media_type") { askedMedia = true; elsewhere = s.row.media_type !== v; }
        return q;
      };
      q.maybeSingle = async () => answer();
      q.then = (done: (v: unknown) => unknown) => {
        const a = answer();
        return Promise.resolve(done(table === "prompts" && a.data ? { ...a, data: [a.data] } : a));
      };
      return q;
    },
  }),
}));

const ROW = { id: "p1", title: "T", description: "Rain", showcase_images: [], price_usd_cents: 0, is_free_showcase: false, creator_id: "u", aspect_ratio: "16:9", prompt_type: "free", is_listed: true, listing_status: "active", deleted_at: null };

const fresh = async () => {
  vi.resetModules();
  return {
    og: (await import("../../app/api/og/[id]/route")).GET,
    head: (await import("../../app/generator/[id]/page")).generateMetadata,
    list: (await import("../../app/api/prompts/route")).GET,
  };
};
const card = async (row: object) => {
  s.row = { ...ROW, ...row };
  const { og } = await fresh();
  await og(new Request("http://enki.test/api/og/p1"), { params: Promise.resolve({ id: "p1" }) });
  return JSON.stringify(s.drawn);
};
const said = async (row: object) => {
  s.row = { ...ROW, ...row };
  const { head } = await fresh();
  return String((await head({ params: Promise.resolve({ id: "p1" }) } as never)).description);
};

beforeEach(() => {
  Object.assign(s, { sql52: true, selects: [], drawn: null });
  vi.stubEnv("SUPABASE_URL", "http://db.test");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-key");
});

describe("a link's card", () => {
  it("calls an Open video prompt Open, an open image Free, and a priced one by its price", async () => {
    expect(await card({ media_type: "video" })).toContain("Open prompt");
    expect(await card({ media_type: "video" })).not.toMatch(/free/i);
    expect(await card({ media_type: "image" })).toContain("Free prompt");
    expect(await card({ media_type: "video", price_usd_cents: 40, prompt_type: "paid" })).toContain("$0.40 per generation");
  });
  it("before SQL 52 every prompt is an image's, and the card still draws", async () => {
    s.sql52 = false;
    expect(await card({})).toContain("Free prompt");
  });
});

describe("a link's head", () => {
  it("says the same", async () => {
    expect(await said({ media_type: "video" })).toBe("Open prompt — Rain");
    expect(await said({ media_type: "image" })).toBe("Free prompt — Rain");
    expect(await said({ media_type: "video", price_usd_cents: 40, prompt_type: "paid" })).toBe("$0.40 per generation — Rain");
  });
  it("before SQL 52 too", async () => {
    s.sql52 = false;
    expect(await said({})).toBe("Free prompt — Rain");
  });
});

describe("/showcase", () => {
  const items = async (row: object) => {
    s.row = { ...ROW, ...row };
    const { list } = await fresh();
    return (await (await list(new NextRequest("http://enki.test/api/prompts?limit=2"))).json()).items as { isVideo: boolean; isFree: boolean }[];
  };
  it("the list says which is a video", async () => {
    expect((await items({ media_type: "video" }))[0]).toMatchObject({ isVideo: true, isFree: true });
    expect((await items({ media_type: "image" }))[0]).toMatchObject({ isVideo: false, isFree: true });
  });
  it("before SQL 52 it does not ask for the column, and lists", async () => {
    s.sql52 = false;
    expect((await items({}))[0]).toMatchObject({ isVideo: false });
    expect(s.selects.filter((c) => c.startsWith("prompts:id,"))).toHaveLength(1);
    expect(s.selects.find((c) => c.startsWith("prompts:id,"))).not.toContain("media_type");
    expect(s.selects).not.toContain("prompts:id");
  });
  it("the grid's badge says OPEN on a video and FREE on an image", async () => {
    const { default: ArtworkGrid } = await import("@/components/ArtworkGrid");
    const grid = (item: object) => renderToStaticMarkup(createElement(ArtworkGrid, { variant: "prompt", items: [{ id: "a", title: "A", artistName: "M", isFree: true, ...item }] } as never));
    expect(grid({ isVideo: true })).toMatch(/>OPEN</);
    expect(grid({ isVideo: true })).not.toMatch(/>FREE</);
    expect(grid({})).toMatch(/>FREE</);
    // The page hands the field on; the page itself is not mounted here.
    expect(readFileSync(join(__dirname, "..", "..", "app", "showcase", "page.tsx"), "utf8")).toContain("isVideo: p.isVideo === true,");
  });
});
