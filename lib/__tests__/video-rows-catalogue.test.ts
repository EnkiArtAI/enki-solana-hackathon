import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { readSource } from "./_read-source";
import { withCapabilities } from "@/lib/generation/models";
import { defaultModel, forViewer, modelOptions } from "@/lib/ui/image-view/models";
import { quoteBatch } from "@/lib/editor/quote-batch";
import { generatorGroups } from "@/lib/ui/feed/generators";
import { VIDEO_MODELS } from "@/lib/video/models";
import type { CatalogueEntry } from "@/hooks/useModelLimits";

/**
 * What SQL 67 does to the surfaces that read /api/models: a catalogue holding video rows, cheapest and first as `order by
 * price` may put them, leaves Quick Create, the Image View, the editor and the Refer modal's lists as they were, and only
 * Explore's and a profile's generator filter gains a Video branch. SQL 66 and 67 themselves run on PGlite, over the live
 * models columns. Blind spot: Quick Create, the editor and the Refer modal are read from their source here; their pure
 * parts run, their components are not mounted with video rows.
 */
const ROOT = join(__dirname, "..", "..");
const entry = (name: string, over: Partial<CatalogueEntry> = {}) => ({
  id: `id-${name}`, name, price: 0.1, mediaType: "image", supportsQuality: false, maxResolution: "4K", ratios: ["1:1"], free: false, boostAvailable: false, boostTiers: [], ...over,
}) as CatalogueEntry;
const IMAGES = [entry("Flux (free)", { price: 0, free: true }), entry("Nano Banana Pro"), entry("GPT-Image-2")];
const VIDEOS = VIDEO_MODELS.map((m) => entry(m.label, { price: 0, mediaType: "video" }));
const MIXED = [...VIDEOS, ...IMAGES];
const names = (list: readonly CatalogueEntry[]) => list.map((m) => m.name);

describe("the surfaces that generate pictures", () => {
  it("the Image View offers and picks as before", () => {
    for (const premium of [false, true]) {
      expect(names(modelOptions(MIXED, premium))).toEqual(names(modelOptions(IMAGES, premium)));
      expect(names(modelOptions(MIXED, premium, ["Seedance 2.5"]))).toEqual(names(modelOptions(IMAGES, premium)));
      for (const aiModel of [undefined, "GPT-Image-2", "Seedance 2.5"]) {
        expect(defaultModel({ catalogue: MIXED, pick: "", aiModel, premium })).toBe(defaultModel({ catalogue: IMAGES, pick: "", aiModel, premium }));
      }
    }
    // With no default on offer the first on offer stands, and that is never a video.
    expect(defaultModel({ catalogue: [...VIDEOS, entry("GPT-Image-2")], pick: "", premium: false })).toBe("GPT-Image-2");
  });

  it("the editor's price batch asks nothing for a video row", () => {
    const picks = { ratio: "1:1", resolution: "1K", quality: null, boost: false } as never;
    expect(quoteBatch(MIXED, IMAGES[1], picks, 0)).toEqual(quoteBatch(IMAGES, IMAGES[1], picks, 0));
  });

  it("Quick Create, the editor, the Refer modal and the hunter filter by medium", () => {
    const src = (...p: string[]) => readSource(join(ROOT, ...p));
    const launcher = src("components", "GenerateLauncher.tsx");
    expect(launcher).toContain('const offerable = forViewer(core.catalogue, role).filter((m) => m.mediaType === "image");');
    expect(launcher).toContain("models={{ available: offerable.map(");
    expect(launcher).toContain("if (seed.modelId && offerable.some((m) => m.id === seed.modelId)) setModel(seed.modelId);");
    expect(launcher).toContain('core.catalogue.filter(entry => entry.mediaType === "image"');
    expect(launcher.split("core.catalogue")).toHaveLength(3);
    // The editor filters by the medium at hand; an image prompt, and a draft from before the switch, read "image" (mediaOf).
    expect(src("components", "prompt-editor", "PromptEditor.tsx")).toContain("forViewer(catalogue, role).filter((m) => m.mediaType === media)");
    expect(src("lib", "editor", "release.ts")).toContain('l.media ?? "image"');
    expect(src("components", "enki-shell", "ReferModal.tsx")).toContain('r.media_type !== "video"');
    expect(src("lib", "hunter", "run.ts")).toContain('m.media_type !== "video"');
    expect(src("hooks", "useModelLimits.ts")).toContain('media_type === "video" ? "video" : "image"');
  });

  it("forViewer keeps video rows out of nothing by itself: the filters above are what stand", () => {
    expect(names(forViewer(MIXED, "user"))).toEqual(names(MIXED.filter((m) => !m.free)));
  });
});

describe("/api/models on a video row", () => {
  it("says it is not free, has no boost and no quality, so nothing routes it to the free route or offers those", () => {
    const [row] = withCapabilities([{ id: "v", name: "Seedance 2.5", allowed_ratios: ["16:9"], max_reference_images: 30, model_providers: [] }]);
    expect(row).toMatchObject({ free: false, boostAvailable: false, supportsQuality: false });
  });
});

describe("the generator filter", () => {
  it("gains its Video branch by itself, with every model Create > Video has", () => {
    const groups = generatorGroups(MIXED);
    expect(groups.map((g) => g.label)).toEqual(["Image", "Video"]);
    expect(groups[1].entries.map((e) => e.name)).toEqual(VIDEO_MODELS.map((m) => m.label));
  });
});

describe("SQL 66 and 67", () => {
  const read = (name: string) => readFileSync(join(ROOT, "migrations", name), "utf8").split("\r\n").join("\n");
  const rollback = (sql: string) => sql.slice(sql.indexOf("-- Rollback")).split("\n").filter((l) => l.startsWith("--   ")).map((l) => l.slice(5)).join("\n");
  const [STORAGE, MODELS] = [read("2026-11-03-video-storage.sql"), read("2026-11-03-video-models.sql")];

  it("SQL 67 adds exactly Create > Video's models, twice without harm, and leaves a row Kev edited as he left it", async () => {
    const db = await PGlite.create();
    await db.exec(`
      create table public.models (id uuid primary key, name text not null, price numeric, allowed_ratios text[], active boolean default true, created_at timestamptz default now(),
        max_reference_images integer not null default 3, allowed_filetypes text[] not null, media_type text not null default 'image' check (media_type in ('image', 'video')));
      insert into public.models (id, name, price, allowed_filetypes) values (gen_random_uuid(), 'Nano Banana Pro', 0.1, '{image/png}'), (gen_random_uuid(), 'Kling 3.0', 7, '{image/png}');
      update public.models set media_type = 'video' where name = 'Kling 3.0';`);
    await db.exec(MODELS);
    await db.exec(MODELS);
    const rows = (await db.query<{ name: string; price: string; active: boolean; media_type: string; allowed_ratios: string[]; max_reference_images: number }>(`select name, price::text, active, media_type, allowed_ratios, max_reference_images from public.models where media_type = 'video'`)).rows;
    expect(rows.map((r) => r.name).sort()).toEqual(VIDEO_MODELS.map((m) => m.label).sort());
    expect(rows.find((r) => r.name === "Kling 3.0")!.price).toBe("7");
    for (const m of VIDEO_MODELS.filter((x) => x.label !== "Kling 3.0")) {
      const row = rows.find((r) => r.name === m.label)!;
      expect(row).toMatchObject({ price: "0", active: true, media_type: "video", max_reference_images: m.refs?.images ?? 0 });
      expect(row.allowed_ratios).toEqual([...m.aspects]);
    }
    await db.exec(rollback(MODELS));
    expect((await db.query(`select 1 from public.models where media_type = 'video'`)).rows).toHaveLength(0);
    expect((await db.query(`select 1 from public.models where name = 'Nano Banana Pro'`)).rows).toHaveLength(1);
    await db.close();
  }, 30_000);

  it("SQL 66 makes the public bucket and the private one, and puts them right if changed", async () => {
    const db = await PGlite.create();
    await db.exec(`create schema storage; create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);`);
    await db.exec(STORAGE);
    await db.exec(`update storage.buckets set public = true where id = 'video-originals'`);
    await db.exec(STORAGE);
    expect((await db.query(`select id, public, file_size_limit::int as size, allowed_mime_types as mime from storage.buckets order by id`)).rows).toEqual([
      { id: "video-originals", public: false, size: 524288000, mime: ["video/mp4", "video/quicktime"] },
      { id: "videos", public: true, size: 52428800, mime: ["video/mp4", "image/webp"] },
    ]);
    await db.exec(rollback(STORAGE));
    expect((await db.query(`select 1 from storage.buckets`)).rows).toHaveLength(0);
    await db.close();
  }, 30_000);

  it("each ends with a Check and says when it may run", () => {
    for (const sql of [STORAGE, MODELS]) expect(sql).toContain("-- Check");
    expect(MODELS).toContain("RUN ONLY AFTER the deploy of DEC-2026-11-03-63");
  });
});
