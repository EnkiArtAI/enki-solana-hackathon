import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { readSource } from "@/lib/__tests__/_read-source";
import { stubRequiredEnv } from "@/lib/__tests__/_required-env";

/**
 * SHR (Kev's go 2026-10-17): a public image has a share page, /i/<id>, whose
 * link unfurls as the image with "Made with Enki". Only an image its owner
 * made public: never private, uploaded, 18+, deleted or from a hidden
 * account; a prompt is named only when listed, its creator not hidden; a
 * prompt's text is never read. Everything else is one answer: null.
 */

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({ tables: {} as Record<string, Record<string, unknown>[]>, hidden: new Set<string>() as Set<string> | null, selects: [] as string[] }));
vi.mock("@/lib/hidden-owners", () => ({ hiddenOwners: async () => db.hidden }));
const from = (table: string) => {
  const filters: ((r: Row) => boolean)[] = [];
  const q = {
    select: (cols: string) => { db.selects.push(`${table}:${cols}`); return q; },
    eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return q; },
    is: (c: string, v: null) => { filters.push((r) => (r[c] ?? null) === v); return q; },
    maybeSingle: async () => ({ data: (db.tables[table] ?? []).find((r) => filters.every((f) => f(r))) ?? null, error: null }),
  };
  return q;
};
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => ({ from }) }));
vi.mock("next/og", () => ({ ImageResponse: class { constructor(public element: unknown, public init: { headers?: Record<string, string> }) {} } }));

import { fitInto, publicImage } from "@/lib/share/public-image";
import { generateMetadata } from "../../app/i/[id]/page";
import { GET as card } from "../../app/api/og/image/[id]/route";

const IMG = "1a2b3c4d-1111-4222-8333-444455556666";
const OWNER = "0b5f2c1e-1111-4222-8333-444455556666";
const PROMPT = "9c1d2e3f-1111-4222-8333-444455556666";
const ORIGINAL = "https://x.public.blob.vercel-storage.com/generations/1.png";
const PREVIEW = "https://x.public.blob.vercel-storage.com/generations/1.preview.webp";
const client = () => ({ from }) as never;
const image = (extra: Row = {}) => ({
  id: IMG, user_id: OWNER, storage_url: ORIGINAL, preview_url: PREVIEW, width: 1024, height: 1280, prompt_id: PROMPT,
  visibility: "public", is_uploaded: false, is_adult: false, deleted_at: null, ...extra,
});

beforeEach(() => {
  db.hidden = new Set();
  db.selects = [];
  db.tables = {
    generated_images: [image()],
    users: [{ id: OWNER, handle: "kev" }],
    prompts: [{ id: PROMPT, title: "Neon Koi", is_listed: true, listing_status: "active", deleted_at: null, creator_id: OWNER, is_adult: false }],
  };
});
afterEach(() => vi.unstubAllEnvs());

describe("which image is shared", () => {
  it("a public image: the original for the card, the preview for the page, the owner and the listed prompt", async () => {
    expect(await publicImage(client(), IMG)).toEqual({
      id: IMG, url: ORIGINAL, shown: PREVIEW, width: 1024, height: 1280, owner: "kev", prompt: { id: PROMPT, title: "Neon Koi" },
    });
  });

  it.each([
    ["private", { visibility: "private" }],
    ["an upload", { is_uploaded: true }],
    ["18+", { is_adult: true }],
    ["deleted", { deleted_at: "2026-10-01T00:00:00Z" }],
    ["stored nowhere we serve", { storage_url: "data:image/png;base64,AAAA" }],
  ])("none for an image that is %s", async (_name, extra) => {
    db.tables.generated_images = [image(extra)];
    expect(await publicImage(client(), IMG)).toBeNull();
  });

  it("none for a hidden owner, a lookup that failed, or an id that is no id", async () => {
    db.hidden = new Set([OWNER]);
    expect(await publicImage(client(), IMG)).toBeNull();
    db.hidden = null;
    expect(await publicImage(client(), IMG)).toBeNull();
    db.hidden = new Set();
    expect(await publicImage(client(), "../etc")).toBeNull();
  });

  it("names no prompt that is a draft, 18+ or a hidden creator's, and shows the original without a preview", async () => {
    const CREATOR = "5e6f7a8b-1111-4222-8333-444455556666";
    const listed = { ...db.tables.prompts[0], creator_id: CREATOR };
    db.tables.generated_images = [image({ preview_url: null })];
    for (const [p, hidden] of [
      [{ ...listed, is_listed: false, listing_status: "draft" }, new Set<string>()],
      [{ ...listed, is_adult: true }, new Set<string>()],
      [listed, new Set([CREATOR])],
    ] as const) {
      db.tables.prompts = [p];
      db.hidden = hidden;
      const img = await publicImage(client(), IMG);
      expect(img?.id).toBe(IMG);
      expect(img?.prompt).toBeNull();
      expect(img?.shown).toBe(ORIGINAL);
    }
    db.tables.prompts = [listed];
    db.hidden = new Set();
    expect((await publicImage(client(), IMG))?.prompt).toEqual({ id: PROMPT, title: "Neon Koi" });
  });

  it("never reads a prompt's text", async () => {
    await publicImage(client(), IMG);
    expect(db.selects.join("\n")).not.toMatch(/content|prompt_text|final_prompt|encrypted/);
  });
});

describe("the page and its card", () => {
  const meta = () => generateMetadata({ params: Promise.resolve({ id: IMG }) });
  const drawn = async () => {
    const res = (await card(new Request(`http://enki.test/api/og/image/${IMG}`), { params: Promise.resolve({ id: IMG }) })) as unknown as { element: unknown; init: { headers?: Record<string, string> } };
    return { element: JSON.stringify(res.element), headers: res.init.headers ?? {} };
  };

  it("the head names the prompt and the owner and points og:image at the card", async () => {
    const m = await meta();
    expect(m.title).toBe("Neon Koi by @kev · Enki Art");
    expect(JSON.stringify(m.openGraph)).toContain(`/api/og/image/${IMG}`);
  });

  it("an image that is not public gets the brand card and no name", async () => {
    db.tables.generated_images = [image({ visibility: "private" })];
    const m = await meta();
    expect(m.title).toBe("Enki Art");
    expect(JSON.stringify(m)).not.toContain("Neon Koi");
    const { element } = await drawn();
    expect(element).not.toContain(ORIGINAL);
    expect(element).not.toContain("Neon Koi");
  });

  it("the card draws the original with Made with Enki, and leaves the shared cache within the hour", async () => {
    const { element, headers } = await drawn();
    expect(element).toContain(ORIGINAL);
    expect(element).toContain("MADE WITH ENKI");
    expect(element).toContain("Neon Koi · by @kev");
    expect(headers["Cache-Control"]).toBe("public, max-age=300, s-maxage=3600");
  });

  it("the image is sized explicitly, so a dead link leaves its slot empty instead of breaking the card", async () => {
    // 1024x1280 into the 1120x494 slot: the height decides.
    expect(fitInto(1024, 1280, 1120, 494)).toEqual({ w: 395, h: 494 });
    expect(fitInto(2048, 512, 1120, 494)).toEqual({ w: 1120, h: 280 });
    expect(fitInto(null, 1280, 1120, 494)).toEqual({ w: 494, h: 494 });
    // As attributes, not only as style: the renderer reads the attributes when the image fails.
    expect((await drawn()).element).toContain('"alt":"","width":395,"height":494');
  });
});

describe("who reaches it", () => {
  const visit = async (path: string, ua: string) => {
    const { proxy } = await import("../../proxy");
    return proxy(new NextRequest(`http://enki.test${path}`, { headers: { "user-agent": ua } }));
  };

  it("link-preview bots read /i/ behind the beta gate; people still go to the gate", async () => {
    stubRequiredEnv();
    vi.stubEnv("TEAM_ACCESS_CODE", "team-code");
    expect((await visit(`/i/${IMG}`, "Twitterbot/1.0")).headers.get("x-middleware-next")).toBe("1");
    expect((await visit(`/i/${IMG}`, "Mozilla/5.0")).status).toBe(307);
  });

  it("the gallery shares a public image's page with a text that names no prompt; 18+ and uploads share the file", () => {
    const wall = readSource(join(__dirname, "..", "..", "components", "gallery", "GalleryWall.tsx"));
    expect(wall).toContain("{selected.visibility === \"public\" && !selected.isUploaded && !selected.isAdult ? (");
    // The text names no prompt: a visitor's gallery carries drafts' and 18+ prompts' titles (review 2026-10-17).
    expect(wall).toContain("onClick={() => void shareWithLink(selected.originalUrl ?? selected.imageUrl, `${window.location.origin}/i/${selected.id}`, \"An image\")}>");
    expect(wall).not.toMatch(/\/i\/\$\{selected\.id\}`, selected\.promptTitle/);
    expect(wall).toContain("isAdult: g.isAdult === true,");
    expect(readSource(join(__dirname, "..", "..", "app", "api", "generations", "route.ts"))).toContain("isAdult: row.is_adult === true,");
    expect(wall).toContain("`${window.location.origin}/generator/${selected.promptId}`");
    expect(wall).not.toContain("/prompt/${");
  });
});
