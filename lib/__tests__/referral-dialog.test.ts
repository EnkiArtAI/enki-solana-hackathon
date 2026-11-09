import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";
import { extractTags, storedTags } from "@/lib/search/tags";

/**
 * "Refer a prompt" under Earn money, above Feedback (Kev, 2026-10-13): paste
 * a post, see what it holds, press the check mark, it is live (2026-10-14).
 * A post on X is read by the server and handed back sealed; the prompt is
 * shown as it is and never edited; the name, shelf and primary generator
 * are the referrer's to pick; POST /api/prompt with the sealed preview
 * publishes it. A post on another site goes to the moderators' queue.
 */
const ROOT = join(__dirname, "..", "..");
const DIALOG = readSource(join(ROOT, "components", "enki-shell", "ReferModal.tsx"));
const HOME = readSource(join(ROOT, "components", "enki-shell", "EnkiHome.tsx"));
const SIDEBAR = readSource(join(ROOT, "components", "enki-shell", "EnkiSidebar.tsx"));
const PREVIEW = readSource(join(ROOT, "app", "api", "referrals", "preview", "route.ts"));
const JUDGE = readSource(join(ROOT, "lib", "referral", "judge-post.ts"));
const PROMPT = readSource(join(ROOT, "app", "api", "prompt", "route.ts"));
const send = DIALOG.slice(DIALOG.indexOf("const send = async () => {"), DIALOG.indexOf("const publish = async () => {"));
const publish = DIALOG.slice(DIALOG.indexOf("const publish = async () => {"), DIALOG.indexOf('const verifying = '));

describe("the Refer a prompt dialog", () => {
  it("reads a link the way the server does, so its button is live only for a link the server takes", () => {
    expect(DIALOG).toContain('import { parseReferralLink, REFERRAL_PLATFORM_NAME } from "@/lib/referral-link";');
    expect(DIALOG).toContain("const link = parseReferralLink(url);");
    expect(DIALOG).toContain('const ready = Boolean(link) && !guest && step.at === "link";');
    expect(DIALOG).toContain("disabled={!ready}");
    expect(DIALOG).toContain("<form onSubmit={(e) => { e.preventDefault(); void send(); }}>");
  });

  it("sends a post on another site to the queue, signed in as the user, and says in one line that it arrived", () => {
    expect(send).toContain('if (link.platform !== "x") {');
    expect(send).toContain('await fetch("/api/referrals", {');
    expect(send).toContain("body: JSON.stringify({ url: link.url }),");
    expect(send).toContain('if (res.ok) return setStep({ at: "sent" });');
    expect(DIALOG).toContain("Prompt sent in for checks.");
    expect(send).not.toContain("onClose()");
  });

  it("has the server read a post on X, shows the prompt as text that cannot be edited, and the name, shelf and primary generator to pick", () => {
    expect(send).toContain('await fetch("/api/referrals/preview", {');
    expect(send).toContain('setStep({ at: "verify", token, shown });');
    expect(DIALOG).toContain("<pre style=");
    expect(DIALOG).toContain("{shown.prompt}");
    expect(DIALOG).not.toContain("<textarea");
    expect(DIALOG).toContain('<input className="st-input" value={title} onChange={(e) => setTitle(e.target.value)}');
    expect(DIALOG).toContain("{ENKI_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}");
    expect(DIALOG).toContain("{generators.map((g) => <option key={g} value={g}>{g}</option>)}");
    expect(DIALOG).toContain('setGenerator(shown.generators.find((g) => names.includes(g)) ?? (names.includes("Nano Banana Pro") ? "Nano Banana Pro" : names[0] ?? ""));');
    expect(DIALOG).toContain("Reading the post…");
  });

  it("publishes with the sealed preview, never with text of its own, and the shell opens the prompt", () => {
    expect(publish).toContain('await guarded("add-prompt", (h) => fetch("/api/prompt", {');
    expect(publish).toContain("imported: token, title: title.trim(), category, aiModel: generator,");
    expect(publish).toContain("aiModels: shown.generators.length ? shown.generators : generators,");
    expect(publish).toContain('promptType: "free-prompt", price: 0, release: true, content: "", photoCount: shown.photos.length,');
    expect(publish).toContain("onPublished(id);");
    expect(HOME).toContain("onPublished={(id) => { setReferOpen(false); router.push(promptPage(id)); }} />");
  });

  it("opens the post's pictures full screen, paged by the keys and a swipe, and Esc closes the viewer alone", () => {
    expect(DIALOG).toContain('import FullscreenViewer from "@/components/kit/FullscreenViewer";');
    expect(DIALOG).toContain("<button key={src} type=\"button\" onClick={() => setOpened(i)}");
    expect(DIALOG).toContain("{shown && opened !== null && (\n        <FullscreenViewer items={shown.photos.map((src) => ({ key: src, src }))} index={opened} onIndex={setOpened}");
    expect(DIALOG).toContain('onClose={() => setOpened(null)} layout="stacked" nav="dots"');
    // ...and while publishing, the step-up dialog on top keeps its own Esc (MFA-4).
    expect(DIALOG).toContain('if (opened !== null || step.at === "publishing") return;');
    expect(DIALOG).toContain('const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };');
    expect(DIALOG).toContain("}, [onClose, opened, step.at]);");
    expect(DIALOG).not.toContain("viewing.current");
  });

  it("is the link and one button at each step: no steps list, no promise of a share", () => {
    expect(DIALOG).not.toContain("REFERRAL_SHARE_PCT");
    expect(DIALOG).not.toContain("Earn a passive income");
  });
});

describe("where the dialog opens", () => {
  it("sits under Earn money above Feedback, in the sidebar, the rail and the burger menu", () => {
    const earn = SIDEBAR.slice(SIDEBAR.indexOf('className="ek-earn-lab"'));
    expect(earn.indexOf('className="ek-earn-row" onClick={onRefer}')).toBeLessThan(earn.indexOf('className="ek-earn-row" onClick={onFeedback}'));
    expect(earn).toContain('{onRefer && (\n        <button className="ek-earn-row" onClick={onRefer}');
    expect(earn).toContain('{!rail && <span className="ek-earn-label">Refer a prompt</span>}');
    expect(earn).toContain('{rail && <span className="ek-nav-tip">Refer a prompt</span>}');
    const burger = SIDEBAR.slice(SIDEBAR.indexOf('<div className="ek-burger-sep" />'), SIDEBAR.indexOf('<nav className="ek-nav"'));
    expect(burger.indexOf("onRefer();")).toBeLessThan(burger.indexOf("onFeedback();"));
    expect(HOME).toContain("const [referOpen, setReferOpen] = useState(false);");
    expect(HOME).toContain("onRefer={() => setReferOpen(true)}");
    expect(HOME).toContain("<ReferModal guest={!authed} onClose={() => setReferOpen(false)}");
  });
});

describe("the preview route", () => {
  it("takes only a signed-in account's link to a post on X that nobody referred before", () => {
    expect(PREVIEW).toContain('if (!userId || ban) return NextResponse.json({ error: "Sign in to refer a prompt." }, { status: 401 });');
    expect(PREVIEW).toContain('rateLimitKey(req, "referrals:preview", userId), 10, 10 * 60_000');
    expect(PREVIEW).toContain('if (link.platform !== "x") return NextResponse.json({ error: NOT_X }, { status: 400 });');
    expect(PREVIEW).toContain('.eq("normalized_source_url", link.normalized).limit(1);');
    expect(PREVIEW).toContain("if (known?.length) return NextResponse.json({ error: ALREADY }, { status: 409 });");
    expect(PREVIEW).toContain("const read = await importPost(link.url, KNOWN_GENERATORS, asEnki);");
    expect(PREVIEW).toContain("if (!read.ok) return NextResponse.json({ error: read.said }, { status: 422 });");
    expect(PREVIEW).toContain("const judged = await judgeImport(supabase, { plan: read.plan, link, userId, request: req });");
    expect(PREVIEW).toContain("if (!judged.ok) return NextResponse.json({ error: judged.error }, { status: judged.status });");
    expect(PREVIEW).toContain("return NextResponse.json({ token: sealPreview(judged.preview), preview: judged.shown });");
  });

  it("judges the text and every picture as a release is judged, before anything is named (lib/referral/judge-post, the Prompt Hunter's judge too)", () => {
    expect(JUDGE).toContain("const check = screenFirst(inputs) ? NOT_CHECKED : await checkPrompt(inputs, { hidden: false, signal: p.request.signal });");
    expect(JUDGE).toContain('if (check.verdict === "minor_sexual" || check.verdict === "explicit_sexual") {');
    expect(JUDGE).toContain("surface, request: p.request, account: p.account, category: check.verdict, confidence: check.confidence,");
    expect(JUDGE).toContain('const surface = p.surface ?? "referral-import";');
    expect(JUDGE).toContain('if (check.verdict !== "clear") return { ok: false, status: 503, error: PROMPT_UNCHECKED };');
    expect(JUDGE).toContain("let seen = await checkImageBytes(got.buf, { signal: p.request.signal });");
    expect(JUDGE).toContain('if (seen.verdict === "child_safety") {');
    expect(JUDGE).toContain("if (heldBack(seen)) {");
    expect(JUDGE).toContain('if (seen.verdict === "adult") photosAdult = true;');
    expect(JUDGE).toContain("photos.push({ url: photo.url, sha256: sha256(got.buf) });");
    expect(JUDGE.indexOf("await checkPrompt(")).toBeLessThan(JUDGE.indexOf("await describePrompt("));
    expect(JUDGE).toContain("const said = (await describePrompt(plan.prompt, undefined, p.post)) ?? fallbackDescription(plan.prompt);");
    // 18+ is the checks' call alone; the model that names the prompt has no say (Kev, 2026-10-14: drawn figures are not 18+).
    expect(JUDGE).toContain("adult: check.adult === true || photosAdult,");
    expect(JUDGE).not.toContain("said.adult");
    expect(JUDGE).toContain("return { ok: true, preview, shown: shownOf(preview) };");
  });
});

describe("publishing an import through POST /api/prompt", () => {
  it("takes the text, pictures and 18+ call from the sealed preview, never from the body, for a new free prompt of that account", () => {
    expect(PROMPT).toContain("const imported: ImportPreview | null = body.imported === undefined ? null : openPreview(body.imported);");
    expect(PROMPT).toContain('return NextResponse.json({ error: "This import has expired. Paste the link again." }, { status: 400 });');
    expect(PROMPT).toContain('if (body.id) return NextResponse.json({ error: "An import is always a new prompt." }, { status: 400 });');
    expect(PROMPT).toContain("body.content = imported.prompt;");
    expect(PROMPT).toContain('body.promptType = "free-prompt";');
    expect(PROMPT).toContain("body.release = true;");
    expect(PROMPT.indexOf("body.content = imported.prompt;")).toBeLessThan(PROMPT.indexOf("const enc = encryptString(body.content);"));
    expect(PROMPT).toContain("if (imported && imported.userId !== creatorId) {");
    expect(PROMPT).toContain('|| imported?.adult === true;');
    expect(PROMPT).toContain("const importedSet = imported ? await storeImportedPhotoSet(imported.photos, creatorId ?? ownerIds[0]) : null;");
    expect(PROMPT).toContain("const importedShowcase = importedSet?.map((p) => p.url) ?? null;");
    expect(PROMPT).toContain("showcase_images: importedShowcase ?? showcase,");
    expect(PROMPT).toContain('...(imported ? { description: storedDescription } : {}),');
  });

  it("records the referral once the prompt is live", () => {
    const record = PROMPT.slice(PROMPT.indexOf('from("hunt_submissions").insert({'));
    expect(record).toContain('source_platform: "x", status: "approved", minted_prompt_id: promptId,');
    // The author by X id, the seed of the vault the x402 rail pays into (docs/ESCROW-V2-SHARES.md).
    expect(record).toContain("source_author_id: imported.source.authorId || null, source_author_handle: imported.source.handle || null,");
    expect(JUDGE).toContain("handle: plan.source.handle, authorId: plan.source.authorId },");
    expect(PROMPT.indexOf('from("hunt_submissions").insert({')).toBeGreaterThan(PROMPT.indexOf("if (live) {\n      const { error: listError, count: nowListed }"));
  });
});

// Kev, 2026-10-31, on a logo prompt whose Pending imports row said "latex, vinyl, embossed, glossy": the row shows the
// tags the publish will store, the whole vocabulary of the prompt, its title and the model's words, never the model's raw
// words (a find is published free, so the full vocabulary applies).
describe("a find's tags", () => {
  it("are the vocabulary tags of its prompt, title and the model's words", () => {
    expect(JUDGE).toContain('tags: storedTags(extractTags(plan.prompt, { body: true }), extractTags(said.tags.join("\\n"), { body: true }), extractTags(said.title)),');
    const tags = storedTags(extractTags("an embossed 3d logo for a coffee brand, latex and vinyl texture"), extractTags("Embossed logo\nlatex\nvinyl\nbrand"));
    expect(tags).toEqual(expect.arrayContaining(["logo", "branding", "coffee"]));
    expect(tags).not.toContain("vinyl");
  });
});

// Kev, 2026-11-01: "1x beim import reicht doch vollkommen ... aktuell mache ich das und kein mod".
describe("an imported post's publish", () => {
  it("asks the prompt check no second time for a hunted find; a person's referral, title and variables theirs, is checked", () => {
    expect(PROMPT).toContain("const check = first ? NOT_CHECKED : hunted ? NOT_CHECKED : await checkPrompt(judged, { hidden: false, signal: req.signal });");
    expect(PROMPT).toContain('const hunted = !!imported && !!creatorId && (await supabase.from("users").select("origin").eq("id", creatorId).maybeSingle()).data?.origin === "imported";');
  });
});
