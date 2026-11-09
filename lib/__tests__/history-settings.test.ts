import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A click on a history image loads what it was made with (Kev, 2026-10-13:
 * "die exakten Settings davon links eingespielt"): GET /api/generations
 * carries each render's settings from its generation row, and the Image
 * View puts them into the composer.
 */
const ROOT = join(__dirname, "..", "..");
const src = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");

describe("a history image's settings", () => {
  it("come from the generation row, read once per page, and null for an upload", () => {
    const route = src("app", "api", "generations", "route.ts");
    expect(route).toContain('.select("id, prompt_id, generation_id, storage_url, preview_url, thumbnail_url, description, is_uploaded, is_adult, visibility, created_at", { count: \'exact\' })');
    // The owner's page adds the prompt envelopes to this list (owner-view.ts); the settings columns lead.
    expect(route).toContain('const genColumns: string = "id, model_id, aspect_ratio, resolution, boost"');
    // The owner's references by render; a visitor's only those shown with that image (DEC-514, shown-references.test.ts).
    expect(route).toContain("? { modelId: s.model_id ?? null, aspectRatio: s.aspect_ratio ?? null, resolution: s.resolution ?? null, boost: s.boost === true, references: (shownRefs ? shownRefs.get(String(row.id)) : referencesById.get(id)) ?? [] }");
    expect(route).toContain("settings: settingsOf(row),");
  });

  it("carry the reference images the render was sent, in the order the text names them (Kev, 2026-10-14)", () => {
    const route = src("app", "api", "generations", "route.ts");
    expect(route).toContain('.from("generation_reference_images")');
    expect(route).toContain('.select("generation_id, sequence_index, storage_url")');
    expect(route).toContain('.in("generation_id", generationIds)');
    expect(route).toContain('.order("sequence_index", { ascending: true })');
    expect(route).toContain("referencesById.set(r.generation_id, [...(referencesById.get(r.generation_id) ?? []), r.storage_url]);");
    // A row without a stored copy names nothing the slots could show.
    expect(route).toContain('if (typeof r.storage_url !== "string") continue;');
    const row = src("lib", "ui", "image-view", "history.ts");
    expect(row).toContain("boost: boolean; references?: string[] }");
  });

  // Not its Boost (plan C1, Kev 2026-10-26): no control would show the dearer price.
  it("load into the composer when the image is picked: its generator by catalogue id, ratio and size", () => {
    const model = src("components", "image-view", "useImageViewModel.ts");
    expect(model).toMatch(/else if \(recorded\) \{\n\s*const own = recorded\.modelId \? catalogue\.find\(\(m\) => m\.id === recorded\.modelId\) : undefined;\n\s*if \(own\) setPick\(own\.name\);\n\s*setRatio\(recorded\.aspectRatio \?\? ""\);\n\s*setResolution\(recorded\.resolution \?\? ""\);\n\s*loadRecordedRefs\(recorded\.references \?\? \[\]\);/);
  });

  it("put the render's reference images into the slots, read into data, and clear them for a render made without any", () => {
    const model = src("components", "image-view", "useImageViewModel.ts");
    const load = model.slice(model.indexOf("const loadRecordedRefs = (urls: string[]) => {"), model.indexOf("const select = (x: Shot) => {"));
    expect(load).toContain("if (!urls.length) return setRefs([]);");
    expect(load).toContain("fetch(url).then((res) => (res.ok ? res.blob() : null)).catch(() => null).then((blob) => (blob ? readRef(blob) : null)),");
    // By address, so the reference picker's tiles read as in the prompt (review 2026-10-29, DEC-506).
    expect(load).toContain("if (refLoad.current === n) setRefs(data.flatMap((src, i) => (src ? [{ id: urls[i], src }] : [])));");
  });
});
