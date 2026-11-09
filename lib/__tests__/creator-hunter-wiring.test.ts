import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";

/**
 * The Creator Hunter's wiring in the two routes (Kev, 2026-10-30: "ja go ... und ja 1 und 2"): the admin API hands the
 * panel its creators, the catalogue and how each queued find was found, saves a creator and plays one round, admins
 * only; and a published import keeps its pictures as the creator's own Enki images with their WebP renditions ("ALLE
 * bilder ... bei uns als image einfügen"). The behaviour behind both lives in lib/hunter (creator-run.test.ts).
 */
const ROOT = join(__dirname, "..", "..");
const API = readSource(join(ROOT, "app", "api", "admin", "route.ts"));
const PROMPT = readSource(join(ROOT, "app", "api", "prompt", "route.ts"));
const between = (src: string, from: string, to: string) => src.slice(src.indexOf(from), src.indexOf(to, src.indexOf(from)));

describe("the admin API", () => {
  it("hands the panel the creators, whether SQL 56 ran, and the generators a creator may prefer", () => {
    expect(API).toContain("const [creatorList, catalogue] = hunter ? await Promise.all([loadCreators(supabase), imageGenerators(supabase)]) : [{ ready: false, creators: [] }, []];");
    const payload = between(API, "hunter: hunter ? {", "} : { ready: false, canEdit");
    expect(payload).toContain("creatorsReady: creatorList.ready, creators: creatorList.creators, catalogue,");
  });

  it("passes how a creator's Play found a queued prompt to the queue row, and nothing that is not shaped like it", () => {
    const fn = between(API, "function importPreview(", "\n}\n");
    expect(fn).toContain('hunt: p.hunt && typeof p.hunt === "object" && typeof (p.hunt as HuntFacts).from === "string" ? (p.hunt as HuntFacts) : null,');
  });

  it("saves a creator and plays one round of it, admins only, with the Play's runId sent back", () => {
    const block = between(API, 'if (body.resource === "hunter") {', "// ── a paused prompt's own words");
    expect(block.indexOf('if (role !== "admin") return NextResponse.json({ error: "Admins only" }, { status: 403 });')).toBe(block.indexOf("if (role"));
    expect(block).toContain('if (body.action === "saveCreator") {');
    expect(block).toContain("const saved = await saveCreator(supabase, { handle: body.handle, config: body.config, catalogue: await imageGenerators(supabase) });");
    expect(block).toContain("return saved.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: saved.error }, { status: saved.status });");
    expect(block).toContain('if (body.action === "play") {');
    expect(block).toContain("const played = await playCreator(supabase, body.handle, body.runId, defaultCreatorDeps(supabase, req));");
    expect(block).toContain("if (played.status === 200) return NextResponse.json({ ok: true, summary: played.summary });");
    expect(block).toContain('return NextResponse.json({ error: played.error, ...("summary" in played ? { summary: played.summary } : {}) }, { status: played.status });');
    expect(API).toContain("  runId?: string;\n};");
    // The legacy list run stays in the API until Kev has played creators (design §4); deleting it is its own commit.
    expect(block).toContain('if (body.action === "run") {');
  });
});

describe("publishing an import", () => {
  it("stores each judged picture with its renditions, the showcase keeping the originals", () => {
    expect(PROMPT).toContain('import { storeImportedPhotoSet } from "@/lib/referral/post-photos";');
    expect(PROMPT).toContain("const importedSet = imported ? await storeImportedPhotoSet(imported.photos, creatorId ?? ownerIds[0]) : null;");
    expect(PROMPT).toContain("const importedShowcase = importedSet?.map((p) => p.url) ?? null;");
    expect(PROMPT).toContain("showcase_images: importedShowcase ?? showcase,");
  });

  it("records them as the creator's own private images of the prompt, after the prompt and its referral are written", () => {
    const block = between(PROMPT, "const { count: hunted, error: huntedError }", "\n    return NextResponse.json({");
    const insert = between(block, "if (importedSet?.length) {", 'console.warn("[prompt] imported images not recorded:"');
    expect(block.indexOf("if (importedSet?.length) {")).toBeGreaterThan(block.indexOf('console.warn("[prompt] referral not recorded:"'));
    expect(insert).toContain('const { error: imagesError } = await supabase.from("generated_images").insert(importedSet.map((p, i) => ({');
    expect(insert).toContain('user_id: creatorId, prompt_id: promptId, sequence_index: i, storage_provider: "vercel_blob", storage_url: p.url,');
    expect(insert).toContain("preview_url: p.previewUrl, thumbnail_url: p.thumbnailUrl, width: p.width, height: p.height, mime_type: p.mimeType,");
    expect(insert).toContain('file_size_bytes: p.bytes, is_uploaded: true, is_adult: imported.adult, is_watermarked: false, visibility: "private",');
    expect(insert).toContain("accepted: true, title: body.title, description: storedDescription,");
    // A failed insert costs the renditions, not the prompt.
    expect(block).toContain('if (imagesError) console.warn("[prompt] imported images not recorded:", imagesError.message);');
  });
});
