import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";

/**
 * The Prompt Hunter's wiring (Kev, 2026-10-14): no schedule, a run is
 * pressed in the admin panel and goes on round by round; accounts are
 * dropped into a box; every account shows how far it was read and hands
 * out the list of its read posts; the judged finds show in Pending imports,
 * and an approval publishes them from the sealed preview, or keeps them.
 */
const ROOT = join(__dirname, "..", "..");
const API = readSource(join(ROOT, "app", "api", "admin", "route.ts"));
const PAGE = readSource(join(ROOT, "app", "admin", "page.tsx"));
const PROMPT = readSource(join(ROOT, "app", "api", "prompt", "route.ts"));

describe("no schedule", () => {
  it("has no cron route and no cron entry: a run is pressed", () => {
    expect(existsSync(join(ROOT, "app", "api", "cron", "hunter"))).toBe(false);
    const crons = JSON.parse(readFileSync(join(ROOT, "vercel.json"), "utf8")).crons as { path: string }[];
    expect(crons.map((c) => c.path)).not.toContain("/api/cron/hunter");
    expect(API).toContain("export const maxDuration = 300;");
  });
});

describe("the admin API", () => {
  it("shows the hunter's switches, accounts and runs to the panel, editable by admins only", () => {
    expect(API).toContain('supabase.from("hunter_config").select("*").eq("id", 1).maybeSingle(),');
    expect(API).toContain('supabase.from("hunter_accounts").select("*").order("added_at", { ascending: true }),');
    expect(API).toContain('supabase.from("hunter_runs").select("id, started_at, finished_at, posts_read, found, queued, published, skipped, error").order("started_at", { ascending: false }).limit(10),');
    expect(API).toContain("hunter: hunter ? {\n      ready: true,\n      canEdit: role === \"admin\",");
    expect(API).toContain("accounts: ((hunterAccounts.data ?? []) as HunterAccount[]).map((a) => ({");
    expect(API).toContain('} : { ready: false, canEdit: role === "admin", config: null, accounts: [], runs: [] },');
    expect(API).toContain('if (body.resource === "hunter") {\n    if (role !== "admin") return NextResponse.json({ error: "Admins only" }, { status: 403 });');
    expect(API).toContain('const { data: who } = await supabase.from("users").select("id").eq("handle", publisher).is("deleted_at", null).maybeSingle();');
    expect(API).toContain("mode, posts_per_run: postsPerRun, min_likes: minLikes, per_author_daily: perAuthorDaily, dry_after: dryAfter, publisher_user_id: publisherId, updated_at: now, updated_by: userId,");
    expect(API).toContain("const dryAfter = int(c.dryAfter, 0, 1_000);");
  });

  it("takes accounts dropped in, drops one, and runs a round", () => {
    expect(API).toContain('if (body.action === "addAccounts") {');
    expect(API).toContain('const handles = [...new Set((Array.isArray(body.handles) ? body.handles : []).map((h) => String(h).replace(/^@/, "").trim().toLowerCase()).filter(Boolean))];');
    expect(API).toContain('handles.map((handle) => ({ handle, added_by: userId, ...(playsError ? {} : { spent_usd: Math.round((spent.get(handle) ?? 0) * 10_000) / 10_000 }) })),');
    expect(API).toContain('{ onConflict: "handle", ignoreDuplicates: true },');
    expect(API).toContain('if (body.action === "removeAccount" && body.handle) {');
    expect(API).toContain('const { data: gone, error } = await supabase.from("hunter_accounts").delete().eq("handle", handle)');
    // Retired (Kev, 2026-10-30: "a schalte ab den listen-run"): creators are played; the route runs no list round.
    expect(API).toContain('if (body.action === "run") {');
    expect(API).toContain('return NextResponse.json({ error: "The list run is retired: Play a creator in the Prompt Hunter tab." }, { status: 410 });');
    expect(API).not.toContain("runHunter(");
  });

  it("hands out an account's read posts as a file, so the admin knows what was read", () => {
    expect(API).toContain('const hunterPosts = req.nextUrl.searchParams.get("hunterPosts");');
    expect(API).toContain('.from("hunter_posts").select("post_id, likes, outcome, read_at").eq("handle", handle).order("read_at", { ascending: false }).limit(10000);');
    expect(API).toContain('"content-type": "text/csv; charset=utf-8"');
    expect(API).toContain("post_id,url,likes,outcome,read_at");
  });

  it("shows what the hunter judged in the queue, and publishes it on approval or keeps it in the queue with the reason", () => {
    expect(API).toContain('.select("id, hunter_user_id, source_url, suggested_title, suggested_tags, submitted_at, preview", { count: "exact" })');
    expect(API).toContain("preview: importPreview(r.preview),");
    // A link in line leaves it once played or refused for good; FxTwitter down keeps it waiting (Kev, 2026-11-01).
    expect(API).toContain('if (waited && linkSettled(added)) await supabase.from("hunter_posts").delete().eq("post_id", waited).eq("outcome", "waiting");');
    expect(API).toContain('.not("preview->hunt->>recipeMiss", "is", null);');
    expect(API).toContain("const queued = await queueLink(supabase, body.url, userId);");
    // A find that kept a blank slot from before slots took their own name publishes with the name (Kev, 2026-10-31: PERSONE).
    expect(API).toContain("variables: slotVariables(shown.prompt, shown.hunt?.variables ?? []),");
    expect(API).toContain("const { published, failed, refused } = await publishApproved(supabase, (moved ?? []).map((r) => String(r.id)));");
    expect(API).toContain('.in("id", ids).eq("status", "approved").not("preview_token", "is", null).is("minted_prompt_id", null);');
    expect(API).toContain("publisherId: String(r.hunter_user_id), token: String(r.preview_token), title: shown.title, category: shown.category,");
    expect(API).toContain('await supabase.from("hunt_submissions").update({ status: "pending", decided_at: null, decided_by: null }).eq("id", r.id);');
    expect(API).toContain("could not be and stay in the queue");
    expect(API.indexOf("const { published, failed, refused } = await publishApproved(supabase, (moved ?? []).map((r) => String(r.id)));")).toBeGreaterThan(API.indexOf('if (error) return fail(error, "approve");'));
  });
});

describe("the admin page", () => {
  it("has the Prompt Hunter tab with its switches, saved by admins only, and no mirroring effect", () => {
    expect(PAGE).toContain('{ id: "hunter", label: "Prompt Hunter", icon: "search",');
    expect(PAGE).toContain('{tab === "hunter" && (!d.hunter.ready ? (');
    expect(PAGE).toContain("migrations/2026-10-14-prompt-hunter.sql");
    expect(PAGE).toContain("const hu: HunterConfig = huForm ?? d.hunter.config ?? HUNTER_DEFAULTS;");
    expect(PAGE).toContain("const setHu = (patch: Partial<HunterConfig>) => setHuForm({ ...hu, ...patch });");
    expect(PAGE).not.toContain("const h = data?.hunter?.config;");
    expect(PAGE).toContain('void post({ resource: "hunter", action: "save", config }');
  });

  // The box of accounts and the global Run left the panel for the creator list (Kev, 2026-10-30, "ja go ... und ja 1 und
  // 2"); lib/__tests__/admin-creator-hunter-page.test.ts reads the creator list. The API keeps the legacy actions.
  it("lists creators instead of a box of accounts, without the legacy Run; how far each was read, its posts and Remove stay", () => {
    expect(PAGE).not.toContain("<textarea value={huHandles}");
    // addAccounts stays for one typed handle: Add creator inserts through it (review 2026-10-30, finding 1); the box is gone.
    expect(PAGE).not.toContain("huHandles");
    expect(PAGE).toContain('action: "addAccounts", handles: [handle] }');
    expect(PAGE).not.toContain('JSON.stringify({ resource: "hunter", action: "run" })');
    expect(PAGE).toContain("const readBackTo = (id: string | null) => {");
    expect(PAGE).toContain("const downloadPosts = async (handle: string) => {");
    expect(PAGE).toContain("fetch(`/api/admin?hunterPosts=${encodeURIComponent(handle)}`, { headers: sessionAuthHeaders() })");
    expect(PAGE).toContain('void post({ resource: "hunter", action: "removeAccount", handle: c.handle }');
  });

  it("shows a hunted find's prompt, pictures and 18+ call in the queue, and reloads the queue when an approval could not publish", () => {
    expect(PAGE).toContain("{r.preview && (");
    expect(PAGE).toContain('<Badge pal={PILL.green} label="Hunted" />');
    expect(PAGE).toContain('{r.preview.adult && <Badge pal={PILL.red} label="18+" />}');
    expect(PAGE).toContain("{r.preview.prompt}</span>");
    expect(PAGE).toContain('<img key={src} data-edit src={src} alt="" title="Click to see it full screen" onClick={() => setImpZoom(src)}');
    // One find alone, and all that were selected, which also get their selection back.
    expect(PAGE.split(".then((ok) => { if (!ok) void reload(); })").length - 1).toBe(1);
    expect(PAGE.split(".then((ok) => { if (!ok) { setImpSel(new Set(ids)); void reload(); } })").length - 1).toBe(1);
  });
});

describe("publishing a hunted find", () => {
  it("completes the queue's own row instead of adding a second one", () => {
    expect(PROMPT).toContain('.update({ status: "approved", minted_prompt_id: promptId }, { count: "exact" })');
    expect(PROMPT).toContain('.eq("normalized_source_url", imported.source.normalized).eq("hunter_user_id", creatorId).is("minted_prompt_id", null);');
    expect(PROMPT).toContain('const { error: referralError } = hunted ? { error: huntedError } : await supabase.from("hunt_submissions").insert({');
  });
});
