import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import sharp from "sharp";
import { PGlite } from "@electric-sql/pglite";
import type { SupabaseClient } from "@supabase/supabase-js";
import { pglitePostgrest } from "@/lib/__tests__/_pglite-postgrest";
import { readSource } from "@/lib/__tests__/_read-source";
import { makeSmallRenditions } from "@/lib/imageDerivatives";
import { ensureShowcaseRenditions } from "@/lib/generation/small-renditions";

/**
 * A prompt's example images get two small renditions (Kev, 2026-11-02: "stärkere kompression ... bei den vorschaubildern
 * unter dem eigentlichen großen bild können wir ruhig noch weniger als 1280 nehmen"), on a real Postgres with SQL 60 and
 * real encodes: the stage's and the tile's, only where they are missing, and never in anyone's way when they fail.
 */
const ROOT = join(__dirname, "..", "..");
const SQL = readFileSync(join(ROOT, "migrations", "2026-11-02-small-renditions.sql"), "utf8");
const A = "https://blob/a.png", B = "https://blob/b.png";

let picture: Buffer;
beforeAll(async () => {
  picture = await sharp({ create: { width: 2048, height: 1024, channels: 3, background: { r: 120, g: 40, b: 200 } } }).png().toBuffer();
});

describe("makeSmallRenditions", () => {
  it("bounds the stage to 1280 px and the tile to 192 px, keeping the ratio", async () => {
    const { view, tiny } = await makeSmallRenditions(picture);
    expect([view.width, view.height, tiny.width, tiny.height]).toEqual([1280, 640, 192, 96]);
    expect([view.contentType, tiny.contentType]).toEqual(["image/webp", "image/webp"]);
    expect(tiny.bytes).toBeLessThan(view.bytes);
  });
});

describe("ensureShowcaseRenditions", () => {
  let db: PGlite;
  let supabase: SupabaseClient;
  const rows = async () => (await db.query<{ storage_url: string; view_url: string | null; tiny_url: string | null }>(`select storage_url, view_url, tiny_url from public.generated_images order by storage_url`)).rows;
  const fetchFn = vi.fn(async () => ({ ok: true, arrayBuffer: async () => picture.buffer.slice(picture.byteOffset, picture.byteOffset + picture.length) }));
  const put = vi.fn(async (name: string) => `https://blob/${name}`);

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`create table public.generated_images (id uuid primary key default gen_random_uuid(), storage_url text, preview_url text);`);
    await db.exec(SQL);
    supabase = pglitePostgrest(db).client as unknown as SupabaseClient;
  }, 60_000);
  afterAll(async () => { await db.close(); });
  beforeEach(async () => {
    fetchFn.mockClear();
    put.mockClear();
    await db.exec(`truncate public.generated_images`);
    await db.query(`insert into public.generated_images (storage_url, preview_url) values ($1, $2), ($3, null)`, [A, "https://blob/a.preview.webp", B]);
  });

  it("makes both for an example without them, from its preview, under a name that is the same on a next run", async () => {
    expect(await ensureShowcaseRenditions(supabase, [A, A, ""], { fetchFn: fetchFn as never, put: put as never })).toBe(1);
    expect(fetchFn.mock.calls.map((c) => (c as unknown[])[0])).toEqual(["https://blob/a.preview.webp"]);
    const [view, tiny] = put.mock.calls.map((c) => c[0]);
    expect(view).toMatch(/^renditions\/[0-9a-f]{32}\.view\.webp$/);
    expect(tiny).toBe(view.replace(".view.", ".tiny."));
    expect((await rows())[0]).toEqual({ storage_url: A, view_url: `https://blob/${view}`, tiny_url: `https://blob/${tiny}` });
    // Only the image asked for.
    expect((await rows())[1]).toMatchObject({ storage_url: B, view_url: null });
  });

  it("takes the original when there is no preview, and leaves one that has both alone", async () => {
    await db.query(`update public.generated_images set view_url = 'v', tiny_url = 't' where storage_url = $1`, [A]);
    expect(await ensureShowcaseRenditions(supabase, [A, B], { fetchFn: fetchFn as never, put: put as never })).toBe(1);
    expect(fetchFn.mock.calls.map((c) => (c as unknown[])[0])).toEqual([B]);
  });

  it("stores neither half of a pair: a failed store or read leaves the row for a next run, and the others go on", async () => {
    const half = vi.fn(async (name: string) => (name.includes(".tiny.") ? null : `https://blob/${name}`));
    expect(await ensureShowcaseRenditions(supabase, [A], { fetchFn: fetchFn as never, put: half as never })).toBe(0);
    expect((await rows())[0]).toMatchObject({ view_url: null, tiny_url: null });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const flaky = vi.fn(async (u: string) => {
      if (u === B) throw new Error("gone");
      return { ok: true, arrayBuffer: async () => picture.buffer.slice(picture.byteOffset, picture.byteOffset + picture.length) };
    });
    expect(await ensureShowcaseRenditions(supabase, [A, B], { fetchFn: flaky as never, put: put as never })).toBe(1);
    warn.mockRestore();
  });

  it("does nothing before SQL 60, or past its deadline", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const before = { from: () => ({ select: () => ({ in: async () => ({ data: null, error: { message: "column generated_images.view_url does not exist" } }) }) }) };
    expect(await ensureShowcaseRenditions(before as never, [A], { fetchFn: fetchFn as never, put: put as never })).toBe(0);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
    expect(await ensureShowcaseRenditions(supabase, [A], { fetchFn: fetchFn as never, put: put as never, deadline: Date.now() - 1 })).toBe(0);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("where they show", () => {
  it("the stage and the tiles use them, fullscreen keeps the preview, and a release makes them after its answer", () => {
    expect(readSource(join(ROOT, "components", "image-view", "MainImage.tsx"))).toContain("const src = s?.stage ?? s?.src;");
    expect(readSource(join(ROOT, "components", "image-view", "useImageViewModel.ts"))).toContain('kind: "example", src: preview ?? url, stage: view, thumb: tiny ?? thumb ?? preview ?? url');
    expect(readSource(join(ROOT, "components", "image-view", "ImageViewDesktop.tsx"))).toContain("src: x.src, thumb: x.thumb, ratio: x.ratio");
    expect(readSource(join(ROOT, "app", "api", "prompt", "route.ts"))).toContain("after(() => ensureShowcaseRenditions(supabase, importedShowcase ?? showcase ?? []));");
  });
});
