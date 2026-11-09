import { describe, it, expect, beforeAll } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";
import { encryptString } from "@/lib/crypto";
import { openEnvelope, ownerView, promptKindOf, renderedFree, valuesOf } from "@/lib/generation/owner-view";

/**
 * The owner's view of how a render was made (Kev, 2026-10-15): the text and
 * values come out of the record's envelopes for the owner only; a bought
 * prompt's text stays the creator's, its values are the owner's; the route
 * reads the envelopes only for the owner and names the generator.
 */
const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const live = { is_listed: true, listing_status: "active", deleted_at: null };
const own = { id: "p1", creator_id: OWNER, is_listed: false, price_usd_cents: 0, title: "mine", prompt_type: "create-now" };
const listedFree = { id: "p2", creator_id: OTHER, ...live, price_usd_cents: 0, title: "free", prompt_type: "free" };
const listedPaid = { id: "p3", creator_id: OTHER, ...live, price_usd_cents: 300, title: "paid", prompt_type: "paid" };
const ownListed = { id: "p4", creator_id: OWNER, ...live, price_usd_cents: 300, title: "my listed", prompt_type: "paid" };

beforeAll(() => { process.env.FIELD_ENCRYPTION_KEY_B64 ||= Buffer.alloc(32, 7).toString("base64"); });

describe("the prompt's kind", () => {
  it("is own for the owner's unlisted prompt only, market for anything listed, null when the prompt is gone", () => {
    expect(promptKindOf(own, OWNER)).toBe("own");
    expect(promptKindOf(ownListed, OWNER)).toBe("market");
    expect(promptKindOf(listedFree, OWNER)).toBe("market");
    expect(promptKindOf(own, OTHER)).toBe("market");
    expect(promptKindOf(undefined, OWNER)).toBeNull();
  });
});

describe("the envelopes", () => {
  const sealed = (prefix: string, text: string) => {
    const p = encryptString(text);
    return { [`${prefix}_ct`]: p.encrypted, [`${prefix}_iv`]: p.iv, [`${prefix}_tag`]: p.authTag, [`${prefix}_kid`]: p.kid ?? "field-v1" };
  };
  it("open to the text they were sealed from, and to null when absent or tampered", () => {
    const row = sealed("final_prompt", "a cat in a hat");
    expect(openEnvelope(row, "final_prompt")).toBe("a cat in a hat");
    expect(openEnvelope(row, "variable_values")).toBeNull();
    expect(openEnvelope({ ...row, final_prompt_tag: row.final_prompt_iv }, "final_prompt")).toBeNull();
    expect(openEnvelope({ final_prompt_ct: "", final_prompt_iv: "x", final_prompt_tag: "y" }, "final_prompt")).toBeNull();
  });
  it("read the values as name to text, anything else as its JSON, and nothing for junk", () => {
    expect(valuesOf(JSON.stringify({ subject: "cat", n: 2, deep: { a: 1 } }))).toEqual({ subject: "cat", n: "2", deep: '{"a":1}' });
    expect(valuesOf("[1,2]")).toBeNull();
    expect(valuesOf("{}")).toBeNull();
    expect(valuesOf("not json")).toBeNull();
    expect(valuesOf(null)).toBeNull();
  });
});

describe("the owner's view", () => {
  const values = { subject: "cat" };
  const view = (viewerId: string | null, prompt: Parameters<typeof ownerView>[0]["prompt"], text = "t", hadPrompt = true, freeRail = true, creatorHidden = false) =>
    ownerView({ viewerId, ownerId: OWNER, hadPrompt, freeRail, creatorHidden, prompt, text, values });
  it("gives a visitor the kind, and the title of a listed prompt only", () => {
    expect(view(OTHER, listedFree)).toEqual({ prompt_kind: "market", prompt_title: "free", prompt_text: null, variable_values: null });
    expect(view(null, own).prompt_text).toBeNull();
    // an unlisted draft's title can be its own words; a taken-down or deleted prompt's too
    expect(view(OTHER, own).prompt_title).toBeNull();
    expect(view(OTHER, { ...listedPaid, listing_status: "removed" }).prompt_title).toBeNull();
    expect(view(OTHER, { ...listedPaid, deleted_at: "2026-10-01T00:00:00Z" }).prompt_title).toBeNull();
    // nor a listed prompt whose creator is banned or deleted
    expect(view(OTHER, listedFree, "t", true, true, true).prompt_title).toBeNull();
  });
  it("gives the owner the text of their own and of a free prompt, with the values", () => {
    expect(view(OWNER, own)).toEqual({ prompt_kind: "own", prompt_title: "mine", prompt_text: "t", variable_values: values });
    expect(view(OWNER, listedFree).prompt_text).toBe("t");
    expect(view(OWNER, { ...listedPaid, is_free_showcase: true }).prompt_text).toBe("t");
    // a render made without a prompt is the owner's own words
    expect(view(OWNER, undefined, "my words", false).prompt_text).toBe("my words");
  });
  it("keeps a bought prompt's text with its creator whatever its price, and fails closed", () => {
    expect(view(OWNER, listedPaid, "secret")).toEqual({ prompt_kind: "market", prompt_title: "paid", prompt_text: null, variable_values: values });
    // a paid prompt at 0 cents is still secret
    expect(view(OWNER, { ...listedPaid, price_usd_cents: 0 }, "secret").prompt_text).toBeNull();
    // a prompt the render names but whose row cannot be read opens nothing
    expect(view(OWNER, undefined, "secret").prompt_text).toBeNull();
    // a render bought while the prompt was paid stays closed after the creator makes it free
    expect(view(OWNER, listedFree, "paid-era text", true, false).prompt_text).toBeNull();
    // the owner's own prompt is theirs on any route
    expect(view(OWNER, ownListed, "mine", true, false).prompt_text).toBe("mine");
    expect(view(OWNER, undefined).prompt_kind).toBeNull();
    // The owner's OWN listed prompt is theirs to read, priced or not.
    expect(view(OWNER, ownListed, "mine").prompt_text).toBe("mine");
  });
});

describe("the render's route", () => {
  it("counts as free only when recorded so since the rail column exists, never for a backfilled label", () => {
    expect(renderedFree({ rail: "free", created_at: "2026-10-16T10:00:00.000000+00:00" })).toBe(true);
    // the 2026-10-14 backfill called paid web renders before REC-1 "free"
    expect(renderedFree({ rail: "free", created_at: "2026-10-13T03:13:55.762914+00:00" })).toBe(false);
    expect(renderedFree({ rail: "web", created_at: "2026-10-16T10:00:00Z" })).toBe(false);
    expect(renderedFree({ rail: "free" })).toBe(false);
    expect(renderedFree(undefined)).toBe(false);
  });
});

describe("the route", () => {
  const ROUTE = readSource(join(__dirname, "..", "..", "..", "app", "api", "generations", "route.ts"));
  it("reads the envelopes for the owner only, and names the generator", () => {
    expect(ROUTE).toContain("const own = v.userId === ownerId;");
    expect(ROUTE).toContain("+ (own ? \", rail, created_at, final_prompt_ct, final_prompt_iv, final_prompt_tag, final_prompt_kid, variable_values_ct, variable_values_iv, variable_values_tag, variable_values_kid\" : \"\");");
    expect(ROUTE).toContain('freeRail: renderedFree(g), creatorHidden: !own && !!prompt?.creator_id && creatorHidden(prompt.creator_id),');
    // the owner's own read of the reference images (they can be private photos); a visitor gets only those its
    // owner shows with that image (DEC-514, shown-references.test.ts)
    expect(ROUTE).toMatch(/if \(own\) \{\s+const \{ data: refs, error: refsError \} = await supabase\s+\.from\("generation_reference_images"\)/);
    const wall = readSource(join(__dirname, "..", "..", "..", "components", "gallery", "GalleryWall.tsx"));
    expect(wall).toContain(") : selected.promptTitle ? null : (");
    expect(ROUTE).toContain("const hiddenCreators = own ? new Set<string>() : await hiddenOwners(supabase, creatorIds);");
    expect(ROUTE).toContain("const creatorHidden = (id: string) => !hiddenCreators || hiddenCreators.has(id);");
    expect(ROUTE).toContain(".select(genColumns as \"id, model_id, aspect_ratio, resolution, boost\")");
    expect(ROUTE).toContain('text: own && g ? openEnvelope(g, "final_prompt") : null,');
    expect(ROUTE).toContain('values: own && g ? valuesOf(openEnvelope(g, "variable_values")) : null,');
    expect(ROUTE).toContain('supabase.from("models").select("id, name").in("id", modelIds)');
    expect(ROUTE).toContain('.select("id, creator_id, is_listed, listing_status, deleted_at, prompt_type, is_free_showcase, price_usd_cents, title")');
    expect(ROUTE).toContain("if (promptsError) throw promptsError;");
    expect(ROUTE).toContain('hadPrompt: typeof row.prompt_id === "string",');
    expect(ROUTE).toContain("      ...madeOf(row),\n");
    expect(ROUTE).toContain('supabase.from("users").select("id, handle, display_name").in("id", creatorIds)');
    expect(ROUTE).toContain("prompt_artist: prompt?.creator_id && (own || (isListed(prompt) && !creatorHidden(prompt.creator_id))) ? artists.get(prompt.creator_id) ?? null : null,");
  });
});
