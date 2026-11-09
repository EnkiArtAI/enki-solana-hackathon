import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { PublicKey } from "@solana/web3.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { pglitePostgrest } from "@/lib/__tests__/_pglite-postgrest";
import { resetKeyringCache } from "@/lib/crypto";
import type { ImportPlan } from "@/lib/editor/post-import";
import { plainImport, shownOf, type Judged } from "@/lib/referral/judge-post";
import { openPreview, type ImportPreview } from "@/lib/referral/preview-token";
import { authorVaultOwner, sharesOf } from "@/lib/referral/shares";
import { claimAuthorShares } from "@/lib/referral/claim";
import { CREATOR_DEFAULTS, MODEL_USD_PER_POST_MAX, type CreatorConfig, type HuntFacts } from "@/lib/hunter/creator-types";
import { PER_POST_MAX_USD, spentOf } from "../creator-config";
import { ensureCreatorProfile } from "../creator-profile";
import { SOURCE_MAX, distillPrompt, type Sources } from "../distill";
import { xApi, type XPost, type XSearchApi, type XSearchPage, type XUser } from "../x-api";
import { loadCreators, restartCreator, saveCreator, saveMode } from "../creators";
import { ARCHIVE_GAP_MS, playCreator, type CreatorDeps } from "../creator-run";
import { slotVariables } from "../variables";
import { TIME_CAP_MS } from "../run";

/**
 * A creator's Play (Kev, 2026-10-30: "einen creator reinpacken, such kriterien einstellen, und go"; "ja go ... und ja
 * 1 und 2"), on a real Postgres with the hunter's migrations, SQL 46 and SQL 56, X and the model stubbed (no paid
 * call): the author's own Enki account made once by X id; only the matching posts read; the prompt from the text, an
 * alt text or the author's reply, cut as written, the intro gone, [variables] kept; the generator the post names, else
 * the creator's preferred one; the caps, the hold, the cursors; and what renders earn reaching the X author's share.
 */
const ROOT = join(__dirname, "..", "..", "..");
const migration = (f: string) => readFileSync(join(ROOT, "migrations", f), "utf8").split("\r\n").join("\n");
const NOW = Date.parse("2026-10-30T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
/** A post id from a time: X's ids are snowflakes. */
const sf = (ms: number, n = 0) => ((BigInt(ms - 1288834974657) << BigInt(22)) + BigInt(n)).toString();
const XID = "1500000000000000001";
const ADMIN = "00000000-0000-4000-8000-000000000001";
const CATALOGUE = ["Flux (free)", "Nano Banana Pro", "GPT-Image-2", "Nano Banana 2"];
const HEX: XUser = { id: XID, handle: "HexMethod", name: "Hex Method" };
const PROGRAM = new PublicKey("2sfm76FMcfqUYCv47J4VCNFMrp6PpfD6QYpmWqBCPyJV");

const P_TEXT = "A cinematic portrait of a [subject] lighthouse keeper at dawn, soft fog, 35mm film grain";
const P_REPLY = "Isometric coffee shop diorama, [season] decorations, tiny people, warm light, octane render";
const P_ALT = "Macro photo of a dewdrop on a [color] leaf, bokeh background, 100mm lens, morning light";
const P_MODEL = "A cinematic portrait of an old [profession] in a Lisbon tram, golden hour, film grain --ar 4:5";
/** Every character of `a` occurs in `b` in order: the prompt is the creator's words, with deletions only. */
const isSubsequence = (a: string, b: string) => { let i = 0; for (const c of b) if (c === a[i]) i++; return i === a.length; };

const post = (id: string, text: string, over: Partial<XPost> = {}): XPost => ({
  id, url: `https://x.com/hexmethod/status/${id}`, text, author: { id: XID, handle: "hexmethod", name: "" },
  photos: [{ url: `https://pbs.twimg.com/media/${id}.jpg`, alt: null }], replyingTo: null, quote: null, likes: 50, videos: 0, conversationId: id, ...over,
});
const page = (posts: XPost[], nextToken: string | null = null): XSearchPage => ({ posts, nextToken });
/** The pictures of a post, for the plain modes' real import: bytes, and nothing else is fetched. */
const pics = (async () => new Response(Buffer.from("a picture"), { status: 200, headers: { "content-type": "image/jpeg" } })) as unknown as typeof fetch;
const filler = (from: number, n: number, ms = NOW - 40 * DAY) => Array.from({ length: n }, (_, i) => post(sf(ms, 1000 - from - i), `gm ${from + i}`));

describe("a creator's Play", () => {
  let db: PGlite;
  let supabase: SupabaseClient;
  const clock = { t: NOW };
  const model = { calls: 0 };

  /** The model answers like gpt-6-luna would: where the prompt starts and ends, in the source that holds it. */
  const openai = (async (_url: string, init: RequestInit) => {
    model.calls += 1;
    const sources = JSON.parse(JSON.parse(String(init.body)).messages[1].content) as Record<string, string>;
    const key = Object.keys(sources).find((k) => sources[k].includes("A cinematic portrait of an old"));
    const generator = key && sources[key].includes("Higgsfield Soul") ? "Higgsfield Soul" : "";
    const span = key ? { source: key, start: "A cinematic portrait of", end: "film grain --ar 4:5", generator } : { source: "none", start: "", end: "", generator: "" };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(span) } }] }) } as unknown as Response;
  }) as unknown as typeof fetch;

  const judge = vi.fn(async (plan: ImportPlan, link: { url: string; normalized: string }, userId: string, _text: string): Promise<Judged> => {
    const preview: ImportPreview = {
      v: 1, userId, exp: 0, source: { url: plan.source.url, normalized: link.normalized, handle: plan.source.handle, authorId: plan.source.authorId },
      prompt: plan.prompt, generators: plan.generators, photos: plan.photos.map((p) => ({ url: p.url, sha256: "ab".repeat(32) })),
      title: "A find", category: "Characters", tags: ["fog"], adult: false,
    };
    return { ok: true, preview, shown: shownOf(preview) };
  });
  const fakeX = (o: { user?: XUser | null; pages?: (XSearchPage | Error)[]; replies?: Record<string, XPost[]> } = {}) => {
    const pages = [...(o.pages ?? [])];
    return {
      user: vi.fn(async () => (o.user === undefined ? HEX : o.user)),
      search: vi.fn(async (_q: string, _a: unknown, _o: Parameters<XSearchApi["search"]>[2]) => { const p = pages.shift() ?? page([]); if (p instanceof Error) throw p; return p; }),
      replies: vi.fn(async (p: XPost, _a: unknown, _archive: boolean) => o.replies?.[p.id] ?? []),
    } satisfies XSearchApi;
  };
  const deps = (x: XSearchApi, over: Partial<CreatorDeps> = {}): CreatorDeps & { publish: ReturnType<typeof vi.fn>; sleep: ReturnType<typeof vi.fn> } => ({
    x, judge, distill: (s: Sources) => distillPrompt(s, openai),
    publish: vi.fn(async () => ({ ok: true as const, promptId: "00000000-0000-4000-8000-0000000000aa" })),
    catalogue: async () => CATALOGUE,
    profile: (u: XUser) => ensureCreatorProfile(supabase, u),
    now: () => clock.t,
    sleep: vi.fn(async (ms: number) => { clock.t += ms; }),
    ...over,
  }) as never;
  /** As the panel adds a creator (addAccounts inserts the row) and saves its settings. */
  const add = async (config: Partial<CreatorConfig> = {}, handle = "HexMethod") => {
    await db.query(`insert into public.hunter_accounts (handle, added_by) values ($1, $2) on conflict do nothing`, [handle.toLowerCase(), ADMIN]);
    expect(await saveCreator(supabase, { handle, config: { ...CREATOR_DEFAULTS, ...config }, catalogue: CATALOGUE })).toEqual({ ok: true });
  };
  const rows = async <T = Record<string, unknown>>(sql: string) => (await db.query<T>(sql)).rows;
  const creator = async () => (await rows(`select *, spent_usd::float8 as spent from public.hunter_accounts where handle = 'hexmethod'`))[0];

  beforeAll(async () => {
    db = await PGlite.create({ extensions: { citext } });
    await db.exec(`
      create extension citext;
      create role anon; create role authenticated; create role service_role bypassrls;
      create table public.users (id uuid primary key default gen_random_uuid(), handle public.citext, origin text, display_name text,
        bio text, avatar_url text, is_creator boolean not null default false, account_status text not null default 'active',
        deleted_at timestamptz, created_at timestamptz not null default now());
      alter table public.users add constraint users_origin_check check (origin in ('email', 'wallet', 'agent', 'google', 'x'));
      create unique index users_handle_key on public.users (handle);
      create table public.auth_identities (provider text not null, subject text not null, user_id uuid not null, handle text, primary key (provider, subject));
      create table public.user_wallets (user_id uuid not null, chain_family text not null, address text not null, removed_at timestamptz);
      create table public.automod_events (prompt_hash text, category text, matched_rules text[]);
      create table public.hunt_submissions (id uuid primary key default gen_random_uuid(), hunter_user_id uuid not null, source_url text,
        normalized_source_url text, source_platform text, source_author_id text, source_author_handle text, suggested_title text,
        suggested_tags text[] not null default '{}', status text not null default 'pending', minted_prompt_id uuid,
        claimed_by_user_id uuid, claimed_at timestamptz, submitted_at timestamptz not null default now());
      create table public.hunter_config (id smallint primary key default 1 check (id = 1), enabled boolean not null default false,
        mode text not null default 'queue', daily_posts integer not null default 400, min_likes integer not null default 20,
        per_author_daily integer not null default 3, accounts text[] not null default '{}', account_ids jsonb not null default '{}',
        last_post_ids jsonb not null default '{}', publisher_user_id uuid, updated_at timestamptz not null default now(), updated_by uuid);
      insert into public.hunter_config (id) values (1);
    `);
    for (const f of ["2026-10-29-auto-handles.sql", "2026-10-14-prompt-hunter.sql", "2026-10-30-creator-hunter.sql", "2026-11-01-hunter-modes.sql", "2026-11-03-hunter-parked.sql"]) await db.exec(migration(f));
    supabase = pglitePostgrest(db).client as unknown as SupabaseClient;
  }, 60_000);
  afterAll(async () => { await db.close(); });
  beforeEach(async () => {
    await db.exec(`truncate public.users, public.auth_identities, public.user_wallets, public.hunt_submissions, public.hunter_accounts,
      public.hunter_posts, public.hunter_runs, public.hunter_parked cascade; update public.hunter_config set mode = 'queue';`);
    clock.t = NOW;
    model.calls = 0;
    judge.mockClear();
    process.env.FIELD_ENCRYPTION_KEY_B64 = randomBytes(32).toString("base64");
    resetKeyringCache();
    delete process.env.OPENAI_API_KEYS;
    process.env.OPENAI_API_KEY = "test-key";
  });

  it("makes the author's own Enki account once, reads only the matching posts back a year, and finds the prompt in the text, the reply, the alt text, or by the model", async () => {
    await add();
    const ids = [5, 4, 3, 2, 1].map((n) => sf(NOW - 30 * DAY, n));
    const raw = {
      text: `Free prompt for you all 🎁\nPrompt: ${P_TEXT}\n#AIart`,
      model: `hier ist ein gratis prompt für Portraits:\n\n${P_MODEL}\n\nFollow me for more 🔁`,
    };
    const replyPost = post(sf(NOW - 30 * DAY, 9), `Prompt: ${P_REPLY}`, { photos: [], replyingTo: ids[2] });
    const x = fakeX({
      pages: [page([
        post(ids[0], raw.text),
        post(ids[1], "gm ☀️"),
        post(ids[2], "New set, prompt in the comments 👇"),
        post(ids[3], "Prompt in ALT", { photos: [{ url: "https://pbs.twimg.com/media/a.jpg", alt: P_ALT }] }),
        post(ids[4], raw.model),
      ])],
      replies: { [ids[2]]: [replyPost] },
    });
    const d = deps(x);
    const got = await playCreator(supabase, "@HexMethod", undefined, d);
    expect(got.status).toBe(200);

    // The account: by X id, named as on X, nobody's login.
    expect(x.user).toHaveBeenCalledTimes(1);
    const [me] = await rows<Record<string, unknown>>(`select id, handle::text as handle, handle_auto, origin, imported_x_id, display_name, bio, avatar_url, is_creator from public.users`);
    expect(me).toMatchObject({
      handle: "hexmethod", handle_auto: true, origin: "imported", imported_x_id: XID, display_name: "Hex Method", is_creator: true,
      bio: "Prompts by the X account https://x.com/i/user/1500000000000000001 (@HexMethod when Enki imported them). Is this you? Connect your X account in Settings to claim what they earn.",
    });
    // No picture: Enki shows none (Kev, 2026-10-26), so X's is neither downloaded, judged nor stored (review 2026-10-30, F4).
    expect(me.avatar_url).toBeNull();
    expect(await rows(`select 1 from public.auth_identities`)).toHaveLength(0);
    expect(await rows(`select 1 from public.user_wallets`)).toHaveLength(0);

    // Only the matching posts, through the full archive, as far back as the creator says.
    expect(x.search).toHaveBeenCalledTimes(1);
    expect(x.search).toHaveBeenCalledWith("from:hexmethod (prompt OR prompts) has:images -is:retweet -is:reply", { id: XID, handle: "hexmethod", name: "Hex Method" },
      { archive: true, max: 90, untilId: null, startTime: new Date(NOW - 365 * DAY).toISOString(), nextToken: null });
    expect(x.replies).toHaveBeenCalledTimes(1);
    expect(x.replies.mock.calls[0][2]).toBe(true);

    const subs = await rows<Record<string, unknown>>(`select * from public.hunt_submissions order by source_url desc`);
    expect(subs).toHaveLength(4);
    const byPost = new Map(subs.map((s) => [String(s.normalized_source_url).split("/").pop(), s]));
    const facts = (id: string) => (byPost.get(id)!.preview as { hunt: HuntFacts }).hunt;
    const prompt = (id: string) => openPreview(byPost.get(id)!.preview_token)!.prompt;
    expect(prompt(ids[0])).toBe(P_TEXT);
    expect(facts(ids[0])).toMatchObject({ from: "text", how: "label", replyUrl: null });
    expect(prompt(ids[2])).toBe(P_REPLY);
    expect(facts(ids[2])).toMatchObject({ from: "reply", how: "label", replyUrl: replyPost.url });
    expect(prompt(ids[3])).toBe(P_ALT);
    expect(facts(ids[3])).toMatchObject({ from: "alt", how: "alt" });
    // The intro and the call to follow gone, the prompt as written.
    expect(prompt(ids[4])).toBe(P_MODEL);
    expect(facts(ids[4])).toMatchObject({ from: "text", how: "model" });
    expect(isSubsequence(prompt(ids[0]), raw.text) && isSubsequence(prompt(ids[4]), raw.model)).toBe(true);
    for (const s of subs) {
      // The creator's prompts: sealed for their account, queued under it, the author by X id.
      expect(openPreview(s.preview_token)!.userId).toBe(me.id);
      expect(s).toMatchObject({ hunter_user_id: me.id, source_author_id: XID, source_author_handle: "hexmethod", status: "pending", source_platform: "x" });
      expect((s.preview as { hunt: HuntFacts }).hunt).toMatchObject({ creator: { handle: "hexmethod", xUserId: XID }, generatorFrom: "all", foreignGenerator: null, videosSkipped: 0 });
    }

    // A post without a prompt costs its read and nothing more: no judge, no model.
    expect(judge).toHaveBeenCalledTimes(4);
    // Each find is named by its own post's words, wherever its prompt sat (Kev, 2026-10-30: "depending on the content of the tweet").
    expect(Object.fromEntries(judge.mock.calls.map(([, link, , text]) => [link.url.split("/").pop(), text]))).toEqual({
      [ids[0]]: raw.text, [ids[2]]: "New set, prompt in the comments 👇", [ids[3]]: "Prompt in ALT", [ids[4]]: raw.model,
    });
    expect(model.calls).toBe(1);
    const outcomes = await rows<{ post_id: string; outcome: string }>(`select post_id, outcome from public.hunter_posts order by post_id desc`);
    expect(outcomes.map((o) => o.outcome)).toEqual(["queued", "no_prompt", "queued", "queued", "queued"]);

    if (got.status !== 200) return;
    const usage = { posts: 5, replies: 1, users: 1, distills: 1, checks: 4, photos: 4, publishes: 0, videos: 0 };
    expect(got.summary).toMatchObject({ found: 4, queued: 4, published: 0, skipped: { no_prompt: 1 }, usage, stopped: "done", more: false });
    expect(got.summary.estUsd).toBe(spentOf(usage));
    const c = await creator();
    expect(c).toMatchObject({ x_user_id: XID, newest_id: ids[0], oldest_id: ids[4], exhausted: true, dry: false, posts_read: 5, found: 4, error: null, playing_since: null, spent: spentOf(usage) });
    const [run] = await rows<Record<string, unknown>>(`select handle, usage, est_usd::float8 as est, found, queued, posts_read, finished_at from public.hunter_runs`);
    expect(run).toMatchObject({ handle: "hexmethod", usage: { ...usage, stopped: "done" }, est: spentOf(usage), found: 4, queued: 4, posts_read: 5 });
    expect(run.finished_at).not.toBeNull();

    // The panel's row.
    const { ready, creators } = await loadCreators(supabase, NOW);
    expect(ready).toBe(true);
    expect(creators[0]).toMatchObject({
      handle: "hexmethod", xUserId: XID, onEnki: null, pending: 4,
      profile: { userId: me.id, handle: "hexmethod", name: "Hex Method" },
      state: { backDone: true, postsRead: 5, found: 4, playing: false, spentUsd: spentOf(usage) },
    });
    expect(creators[0].runs[0]).toMatchObject({ found: 4, queued: 4, usage, stopped: "done", estUsd: spentOf(usage) });
  });

  it("takes one post by its link as a Play takes it: queued even in publish mode, no search, no cursor moves, the author's reply as the prompt's place (Kev, 2026-10-31: \"Add link manually\")", async () => {
    await add();
    await db.exec(`update public.hunter_config set mode = 'publish'; update public.hunter_accounts set newest_id = '5', oldest_id = '3', exhausted = true`);
    const main = post(sf(NOW - 3 * DAY, 1), "New set, prompt in the comments 👇");
    const reply = post(sf(NOW - 3 * DAY, 2), `Prompt: ${P_REPLY}`, { photos: [], replyingTo: main.id });
    const x = fakeX({ replies: { [main.id]: [reply] } });
    const d = deps(x, { only: main });
    const got = await playCreator(supabase, "hexmethod", undefined, d);
    expect(got.status === 200 && got.summary).toMatchObject({ found: 1, queued: 1, published: 0, stopped: "done", more: false });
    expect(x.search).not.toHaveBeenCalled();
    expect(d.publish).not.toHaveBeenCalled();
    expect(await creator()).toMatchObject({ newest_id: "5", oldest_id: "3", exhausted: true, gap_top: null, gap_low: null });
    const [sub] = await rows<{ preview: { prompt: string; hunt: HuntFacts }; status: string }>(`select preview, status from public.hunt_submissions`);
    expect(sub.status).toBe("pending");
    expect(sub.preview.prompt).toBe(P_REPLY);
    expect(sub.preview.hunt).toMatchObject({ from: "reply" });
    // A post without a prompt is said, not queued.
    const none = await playCreator(supabase, "hexmethod", undefined, deps(fakeX(), { only: post(sf(NOW - DAY, 3), "gm ☀️") }));
    expect(none.status === 200 && none.summary).toMatchObject({ queued: 0, skipped: { no_prompt: 1 } });
    // Both in the log with what became of them (Kev, 2026-10-31: "im log auch sehen bei welchem link es welche fehler gab").
    expect(await rows<{ post_id: string; outcome: string }>(`select post_id, outcome from public.hunter_posts order by post_id`))
      .toEqual([{ post_id: main.id, outcome: "queued" }, { post_id: sf(NOW - DAY, 3), outcome: "no_prompt" }]);
    // A link added again comes first in the log again, with its newest outcome (a Play's old read time is not kept).
    await db.exec(`update public.hunter_posts set read_at = now() - interval '1 day'`);
    await playCreator(supabase, "hexmethod", undefined, deps(fakeX(), { only: post(sf(NOW - DAY, 3), "gm again ☀️") }));
    expect(await rows<{ post_id: string }>(`select post_id from public.hunter_posts where read_at > now() - interval '1 hour'`))
      .toEqual([{ post_id: sf(NOW - DAY, 3) }]);
  });

  // Kev, 2026-11-01: "a \"manual\" and an \"auto\" mode ... WITHOUT AI part, so that it is fully free", and a recipe set up per
  // creator that cuts "everything around the social-post behavior"; where it does not, the finds show why.
  it("cuts by the creator's recipe or takes the whole text, with no model and no check, and says where the recipe missed", async () => {
    await add();
    const judgeSpy = vi.fn(), distillSpy = vi.fn();
    const plain = (plan: ImportPlan, link: { url: string; normalized: string }, userId: string, title: string) => plainImport(supabase, { plan, link, userId, title, fetchFn: pics });
    const play = (main: XPost, reply: XPost) => playCreator(supabase, "hexmethod", undefined, deps(fakeX({ replies: { [main.id]: [reply] } }), { only: main, judge: judgeSpy, distill: distillSpy, plain }));
    const amir = (n: number) => post(sf(NOW - 3 * DAY, n), "Nano Banana smart prompt \n\nEthereal brand landscape\n\nPrompt 👇\nGrab more designer prompts in my pinned 📌");
    const answer = (main: XPost, n: number) => post(sf(NOW - 3 * DAY, n), `Prompt:\n(access Nano Banana 2 here: https://amirmushich.link/AMIR-LTX)\n\n[BRAND NAME]\n\n${P_REPLY}`, { photos: [], replyingTo: main.id });
    const latest = async () => (await rows<{ preview: { prompt: string; title: string; hunt: HuntFacts }; suggested_title: string }>(`select preview, suggested_title from public.hunt_submissions order by submitted_at desc limit 1`))[0];

    expect(await saveMode(supabase, { handle: "HexMethod", mode: "recipe", recipe: { from: "reply", after: "(access", before: "", titleLine: 2 } })).toEqual({ ok: true });
    const m1 = amir(1), r1 = answer(m1, 2);
    expect((await play(m1, r1)).status).toBe(200);
    expect((await latest()).preview).toMatchObject({ prompt: `[BRAND NAME]\n\n${P_REPLY}`, title: "Ethereal brand landscape", hunt: { from: "reply", how: "recipe", replyUrl: r1.url } });
    expect((await latest()).preview.hunt.recipeMiss).toBeUndefined();

    // A marker the replies do not hold: the whole text, and why.
    expect(await saveMode(supabase, { handle: "hexmethod", mode: "recipe", recipe: { from: "reply", after: "(nothing like it", before: "", titleLine: 0 } })).toEqual({ ok: true });
    const m2 = amir(3), r2 = answer(m2, 4);
    await play(m2, r2);
    expect((await latest()).preview).toMatchObject({ prompt: `${m2.text.trim()}\n\n${r2.text.trim()}`, hunt: { how: "manual", recipeMiss: 'no reply holds "(nothing like it"' } });

    // Manual: the author's longest reply, its heading off; the whole text stays with the find.
    expect(await saveMode(supabase, { handle: "hexmethod", mode: "manual", recipe: {} })).toEqual({ ok: true });
    const m3 = amir(5), r3 = answer(m3, 6);
    await play(m3, r3);
    expect((await latest()).preview).toMatchObject({ prompt: `(access Nano Banana 2 here: https://amirmushich.link/AMIR-LTX)\n\n[BRAND NAME]\n\n${P_REPLY}`, hunt: { from: "reply", how: "manual", replyUrl: r3.url, raw: `${m3.text.trim()}\n\n${r3.text.trim()}` } });
    expect((await latest()).preview.hunt.recipeMiss).toBeUndefined();
    expect(judgeSpy).not.toHaveBeenCalled();
    expect(distillSpy).not.toHaveBeenCalled();
    // Through a free reader (FxTwitter) it spends nothing, so a spend cap of $0 does not hold it (review 2026-11-01).
    await db.exec(`update public.hunter_accounts set spend_cap_usd = 0`);
    const m4 = amir(7), r4 = post(sf(NOW - 3 * DAY, 8), `Prompt:\n\nA paper boat on a puddle after rain, ${P_REPLY}`, { photos: [], replyingTo: m4.id });
    const free = { ...fakeX({ replies: { [m4.id]: [r4] } }), free: true };
    const capped = await playCreator(supabase, "hexmethod", undefined, deps(free, { only: m4, judge: judgeSpy, distill: distillSpy, plain }));
    expect(capped.status === 200 && capped.summary).toMatchObject({ queued: 1 });
    expect((await latest()).preview.prompt).toBe(`A paper boat on a puddle after rain, ${P_REPLY}`);

    // The list says each creator's mode and the links in line; a bad mode or an unknown creator is refused.
    await db.exec(`insert into public.hunter_posts (post_id, handle, outcome) values ('${sf(NOW, 9)}', 'hexmethod', 'waiting')`);
    const list = await loadCreators(supabase);
    expect(list.modesReady).toBe(true);
    expect(list.creators.find((c) => c.handle === "hexmethod")).toMatchObject({ mode: "manual", links: 1 });
    expect(await saveMode(supabase, { handle: "hexmethod", mode: "fast", recipe: {} })).toMatchObject({ ok: false, status: 400 });
    expect(await saveMode(supabase, { handle: "nobody_here", mode: "auto", recipe: {} })).toMatchObject({ ok: false, status: 404 });
  });

  it("in a plain mode, a find held by an image case is refused like an auto find, and a read that failed stops the round before it", async () => {
    await add();
    expect(await saveMode(supabase, { handle: "hexmethod", mode: "manual", recipe: {} })).toEqual({ ok: true });
    const one = post(sf(NOW - 3 * DAY, 1), `Prompt: ${P_TEXT}`);
    const withPlain = (status: 422 | 503) => deps(fakeX({ replies: { [one.id]: [] } }), { only: one, plain: async () => ({ ok: false as const, status, error: "no" }) });
    const queued = async () => (await rows(`select 1 from public.hunt_submissions`)).length;

    const down = await playCreator(supabase, "hexmethod", undefined, withPlain(503));
    expect(down.status).toBe(503);
    expect(await queued()).toBe(0);

    const refused = await playCreator(supabase, "hexmethod", undefined, withPlain(422));
    expect(refused.status === 200 && refused.summary.skipped).toMatchObject({ refused: 1 });
    expect(await queued()).toBe(0);
    expect(await rows(`select outcome from public.hunter_posts where post_id = '${one.id}'`)).toEqual([{ outcome: "refused" }]);
  });

  it("reads only what is new at the next Play, through the recent endpoint, on the account made before, with the generator the post names or the creator's preferred one", async () => {
    await add({ preferredGenerator: "GPT-Image-2", minLikes: 20 });
    const first = fakeX({ pages: [page([post(sf(NOW - 2 * DAY, 1), `Prompt: ${P_TEXT}`)])] });
    expect((await playCreator(supabase, "hexmethod", undefined, deps(first))).status).toBe(200);
    const newest = String((await creator()).newest_id);

    const named = post(sf(NOW - DAY, 2), `Made with Nano Banana Pro\nPrompt: ${P_REPLY}`);
    const plain = post(sf(NOW - DAY, 1), `Prompt: ${P_ALT}`);
    const x = fakeX({ pages: [page([named, plain])] });
    const got = await playCreator(supabase, "hexmethod", undefined, deps(x));
    expect(got.status).toBe(200);
    expect(x.user).not.toHaveBeenCalled();
    expect(x.search).toHaveBeenCalledTimes(1);
    expect(x.search.mock.calls[0][0]).toBe("from:hexmethod (prompt OR prompts) has:images -is:retweet -is:reply min_likes:20");
    expect(x.search.mock.calls[0][2]).toEqual({ archive: false, max: 90, sinceId: newest, untilId: null, nextToken: null });
    expect(await rows(`select 1 from public.users`)).toHaveLength(1);
    const prev = await rows<{ normalized_source_url: string; preview: { generators: string[]; hunt: HuntFacts } }>(`select normalized_source_url, preview from public.hunt_submissions`);
    const of = (p: XPost) => prev.find((r) => r.normalized_source_url === `x.com/status/${p.id}`)!.preview;
    expect(of(named).generators).toEqual(["Nano Banana Pro"]);
    expect(of(named).hunt.generatorFrom).toBe("post");
    expect(of(plain).generators).toEqual(["GPT-Image-2"]);
    expect(of(plain).hunt.generatorFrom).toBe("preferred");
    expect((await creator()).newest_id).toBe(named.id);
  });

  it("publishes at once in publish mode as the creator's account, but queues a find whose post names a generator we do not offer", async () => {
    await db.exec(`update public.hunter_config set mode = 'publish'`);
    await add({ preferredGenerator: "Nano Banana 2" });
    const foreign = post(sf(NOW - 30 * DAY, 3), `Made in Midjourney v7\nPrompt: ${P_TEXT}`);
    const preferred = post(sf(NOW - 30 * DAY, 2), `Prompt: ${P_REPLY}`);
    const both = post(sf(NOW - 30 * DAY, 1), `Midjourney v7 first, then Nano Banana Pro\nPrompt: ${P_ALT}`);
    const d = deps(fakeX({ pages: [page([foreign, preferred, both])] }));
    const got = await playCreator(supabase, "hexmethod", undefined, d);
    expect(got.status === 200 && got.summary).toMatchObject({ found: 3, queued: 1, published: 2, usage: { publishes: 2 } });
    const [me] = await rows<{ id: string }>(`select id from public.users`);
    expect(d.publish).toHaveBeenCalledTimes(2);
    expect(d.publish.mock.calls[0][0]).toMatchObject({ publisherId: me.id, aiModel: "Nano Banana 2", aiModels: ["Nano Banana 2"], title: "A find", photoCount: 1 });
    // Ours named beside a foreign one: published on ours.
    expect(d.publish.mock.calls[1][0]).toMatchObject({ publisherId: me.id, aiModels: ["Nano Banana Pro"] });
    // No generator named and none preferred: every active one.
    await add({}, "plain");
    const d2 = deps(fakeX({ pages: [page([post(sf(NOW - 30 * DAY, 9), `Prompt: ${P_MODEL}`)])] }));
    await playCreator(supabase, "plain", undefined, d2);
    expect(d2.publish.mock.calls[0][0]).toMatchObject({ aiModel: CATALOGUE[0], aiModels: CATALOGUE });
    const sub = (await rows<{ preview: { hunt: HuntFacts } }>(`select preview from public.hunt_submissions where normalized_source_url = 'x.com/status/${foreign.id}'`))[0];
    expect(sub.preview.hunt).toMatchObject({ foreignGenerator: "Midjourney v7", generatorFrom: "preferred" });
  });

  it("refuses an X account that logs in to Enki after the lookup, bills nothing more, and makes no account", async () => {
    await add();
    await db.exec(`insert into public.users (id, handle, origin) values ('${ADMIN}', 'realhex', 'x'); insert into public.auth_identities values ('x', '${XID}', '${ADMIN}', 'realhex');`);
    const x = fakeX({ pages: [page([post(sf(NOW - DAY), `Prompt: ${P_TEXT}`)])] });
    const got = await playCreator(supabase, "hexmethod", undefined, deps(x));
    expect(got).toMatchObject({ status: 409, error: "@hexmethod is on Enki as @realhex: their posts are theirs to publish.", summary: { stopped: "on_enki", usage: { users: 1, posts: 0 } } });
    expect(x.search).not.toHaveBeenCalled();
    expect(await rows(`select 1 from public.users where origin = 'imported'`)).toHaveLength(0);
    expect(await creator()).toMatchObject({ x_user_id: XID, error: null, playing_since: null });
    expect((await loadCreators(supabase, NOW)).creators[0].onEnki).toBe("realhex");
  });

  it("holds the creator while a round runs: a second Play is refused, a hold older than five minutes is taken over", async () => {
    await add();
    await db.exec(`update public.hunter_accounts set playing_since = '${new Date(NOW - 60_000).toISOString()}'`);
    const x = fakeX();
    expect(await playCreator(supabase, "hexmethod", undefined, deps(x))).toEqual({ status: 409, error: "@hexmethod is already playing." });
    expect(x.user).not.toHaveBeenCalled();
    expect((await loadCreators(supabase, NOW)).creators[0].state.playing).toBe(true);
    await db.exec(`update public.hunter_accounts set playing_since = '${new Date(NOW - 6 * 60_000).toISOString()}'`);
    expect((await loadCreators(supabase, NOW)).creators[0].state.playing).toBe(false);
    expect((await playCreator(supabase, "hexmethod", undefined, deps(x))).status).toBe(200);
    expect((await creator()).playing_since).toBeNull();
    expect(await playCreator(supabase, "nobody", undefined, deps(x))).toEqual({ status: 404, error: "@nobody is not on the list." });
  });

  it("stops at the Play's posts cap, which holds across its rounds, and starts afresh with a new Play", async () => {
    await add({ postsPerPlay: 25, dryAfter: 0 });
    const x = fakeX({ pages: [page(filler(0, 15), "more")] });
    const got = await playCreator(supabase, "hexmethod", undefined, deps(x));
    // 25 less the room for one replies read.
    expect(x.search.mock.calls[0][2]).toMatchObject({ max: 15 });
    expect(got.status === 200 && got.summary).toMatchObject({ stopped: "posts_cap", more: false, usage: { posts: 15 } });
    const runId = got.status === 200 ? got.summary.runId : "";
    // The same Play again: nothing is left of its cap, X is not asked.
    await db.exec(`update public.hunter_runs set finished_at = null`);
    const again = await playCreator(supabase, "hexmethod", runId, deps(x));
    expect(again.status === 200 && again.summary).toMatchObject({ runId, stopped: "posts_cap", usage: { posts: 15 } });
    expect(x.search).toHaveBeenCalledTimes(1);
    const fresh = await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page(filler(25, 10))] })));
    // Its own 25: ten new posts, and the 15 left hold no page beside one replies read.
    expect(fresh.status === 200 && fresh.summary).toMatchObject({ stopped: "posts_cap", usage: { posts: 10 } });
  });

  it("counts the author's replies against the Play's posts", async () => {
    await add({ postsPerPlay: 20, dryAfter: 0 });
    const posts = [post(sf(NOW - 30 * DAY, 99), "New set, prompt in the comments 👇"), ...filler(0, 9)];
    const x = fakeX({ pages: [page(posts, "more"), page(filler(9, 10))], replies: { [posts[0].id]: filler(20, 5) } });
    const got = await playCreator(supabase, "hexmethod", undefined, deps(x));
    expect(got.status === 200 && got.summary).toMatchObject({ stopped: "posts_cap", usage: { posts: 10, replies: 5 } });
    expect(x.search).toHaveBeenCalledTimes(1);
  });

  it("holds the page's model work back from the cap and leaves room for one replies read: the reply is paid, the cap never passed", async () => {
    await add({ spendCapUsd: 0.4, dryAfter: 0 });
    const posts = [post(sf(NOW - 30 * DAY, 99), "New set, prompt in the comments 👇"), ...Array.from({ length: 47 }, (_, i) => post(sf(NOW - 30 * DAY, 50 - i), `Prompt: ${P_TEXT}, take ${i}`))];
    const x = fakeX({ pages: [page(posts, "more")], replies: { [posts[0].id]: [post(sf(NOW - 30 * DAY, 98), `Prompt: ${P_REPLY}`)] } });
    const got = await playCreator(supabase, "hexmethod", undefined, deps(x));
    // (0.40 - the lookup) / $0.00663 = 58 posts, less one replies read.
    expect(x.search.mock.calls[0][2]).toMatchObject({ max: 48 });
    expect(x.replies).toHaveBeenCalledTimes(1);
    expect(got.status === 200 && got.summary).toMatchObject({ stopped: "spend_cap", found: 48 });
    expect((await creator()).spent as number).toBeLessThanOrEqual(0.4);
  });

  it("manual mode keeps a value defined outside the cut: for the cut, for the whole text taken instead, and as written for the eye", async () => {
    await add();
    expect(await saveMode(supabase, { handle: "hexmethod", mode: "manual", recipe: {} })).toEqual({ ok: true });
    const first = "Try this one, set [ MATERIAL COLOR = vivid acid chartreuse ] first and [ FINISH = matte ] too";
    const body = "A ceramic vase in [MATERIAL COLOR] on a plain table, soft north light, 85mm lens, [ANGLE]";
    const text = `${first}\n\n${body}`;
    const plain = (plan: ImportPlan, link: { url: string; normalized: string }, userId: string, title: string) => plainImport(supabase, { plan, link, userId, title, fetchFn: pics });
    const x = { ...fakeX({ pages: [page([post(sf(NOW - 30 * DAY, 1), text)])] }), free: true };
    await playCreator(supabase, "hexmethod", undefined, deps(x, { plain }));
    const [{ preview }] = await rows<{ preview: { prompt: string; hunt: HuntFacts } }>(`select preview from public.hunt_submissions`);
    expect(preview.prompt).toBe(body);
    expect(preview.hunt.rawWords).toBe(text);
    expect(preview.hunt.raw).toBe("Try this one, set MATERIAL COLOR = [MATERIAL COLOR] first and FINISH = [FINISH] too\n\n" + body);
    const values = (prompt: string) => slotVariables(prompt, preview.hunt.variables ?? []).map((v) => [v.name, v.defaultValue]);
    expect(values(preview.prompt)).toEqual([["MATERIAL COLOR", "vivid acid chartreuse"], ["ANGLE", "ANGLE"]]);
    expect(values(preview.hunt.raw!)).toEqual([["MATERIAL COLOR", "vivid acid chartreuse"], ["FINISH", "matte"], ["ANGLE", "ANGLE"]]);
  });

  it("a recipe's variables are its own cut's, as before", async () => {
    await add();
    expect(await saveMode(supabase, { handle: "hexmethod", mode: "recipe", recipe: { from: "text", after: "PROMPT", before: "", titleLine: 0 } })).toEqual({ ok: true });
    const text = "Set [ MATERIAL COLOR = chartreuse ]\nPROMPT\nA ceramic vase in [MATERIAL COLOR] on a plain table, soft north light, 85mm lens";
    const plain = (plan: ImportPlan, link: { url: string; normalized: string }, userId: string, title: string) => plainImport(supabase, { plan, link, userId, title, fetchFn: pics });
    await playCreator(supabase, "hexmethod", undefined, deps({ ...fakeX({ pages: [page([post(sf(NOW - 30 * DAY, 1), text)])] }), free: true }, { plain }));
    const [{ preview }] = await rows<{ preview: { hunt: HuntFacts } }>(`select preview from public.hunt_submissions`);
    expect(preview.hunt.variables?.map((v) => [v.name, v.defaultValue])).toEqual([["MATERIAL COLOR", "MATERIAL COLOR"]]);
    expect(preview.hunt.rawWords).toBeUndefined();
  });

  it("on a free reader a page that fills the Play's posts is read to its end, and the next Play goes on below it", async () => {
    await add({ postsPerPlay: 20, dryAfter: 0 });
    const one = filler(0, 20), two = filler(20, 20);
    const free = (posts: XPost[]) => ({ ...fakeX({ pages: [page(posts, "more")] }), free: true });
    const got = await playCreator(supabase, "hexmethod", undefined, deps(free(one)));
    expect(got.status === 200 && got.summary).toMatchObject({ stopped: "posts_cap", skipped: { no_prompt: 20 } });
    expect((await creator()).oldest_id).toBe(one[19].id);
    const again = await playCreator(supabase, "hexmethod", undefined, deps(free(two)));
    expect(again.status === 200 && again.summary).toMatchObject({ stopped: "posts_cap", skipped: { no_prompt: 20 } });
    expect(await rows(`select post_id from public.hunter_posts`)).toHaveLength(40);
  });

  it("on a free reader a page past the room left costs nothing to read, and the spend cap still holds the model work", async () => {
    await add({ dryAfter: 0 });
    // The column keeps cents: just over what a Play needs to start, and far under what the page's model work would need.
    const cap = Math.ceil(21 * MODEL_USD_PER_POST_MAX * 100) / 100;
    await db.query(`update public.hunter_accounts set spend_cap_usd = $1`, [cap]);
    const free = (posts: XPost[]) => ({ ...fakeX({ pages: [page(posts)] }), free: true });
    const cheap = await playCreator(supabase, "hexmethod", undefined, deps(free(filler(0, 60))));
    expect(cheap.status === 200 && cheap.summary).toMatchObject({ skipped: { no_prompt: 60 } });
    await db.exec(`truncate public.hunter_posts; update public.hunter_accounts set newest_id = null, oldest_id = null, exhausted = false`);
    const paid = Array.from({ length: 200 }, (_, i) => post(sf(NOW - 30 * DAY, 300 - i), `Prompt: ${P_TEXT}, take ${i}`));
    const got = await playCreator(supabase, "hexmethod", undefined, deps(free(paid)));
    expect(got.status === 200 && got.summary).toMatchObject({ stopped: "spend_cap" });
    expect(got.status === 200 && got.summary.found).toBeGreaterThan(20);
    expect(got.status === 200 && got.summary.found).toBeLessThan(200);
    expect((await creator()).spent as number).toBeLessThanOrEqual(cap);
  });

  it("moves on past a post whose prompt is in a reply at the top of a full page: the page leaves room for its replies (review 2026-10-30, F3)", async () => {
    await add();
    // 150 matching posts, newest first; the 41st points at its reply. X as it pages: below until_id, at most max.
    const pool = Array.from({ length: 150 }, (_, i) => post(sf(NOW - 30 * DAY, 1000 - i), i === 40 ? "New set, prompt in the comments 👇" : `Prompt: ${P_TEXT}, take ${i}`));
    const answer = post(sf(NOW - 30 * DAY, 2000), `Prompt: ${P_REPLY}`, { photos: [], replyingTo: pool[40].id });
    const x = fakeX({ replies: { [pool[40].id]: [answer] } });
    x.search.mockImplementation(async (_q, _a, o) => {
      const fits = pool.filter((p) => (!o.untilId || BigInt(p.id) < BigInt(o.untilId)) && (!o.sinceId || BigInt(p.id) > BigInt(o.sinceId)));
      return page(fits.slice(0, o.max), fits.length > o.max ? "more" : null);
    });
    for (let i = 0; i < 3; i++) expect((await playCreator(supabase, "hexmethod", undefined, deps(x))).status).toBe(200);
    expect(x.replies).toHaveBeenCalledTimes(1);
    expect(await rows(`select 1 from public.hunt_submissions where normalized_source_url = 'x.com/status/${pool[40].id}'`)).toHaveLength(1);
    expect(await rows(`select 1 from public.hunter_posts`)).toHaveLength(150);
  });

  it("does not look a new creator up when the cap leaves no room for the lookup, a page and one replies read", async () => {
    // $0.14 less the $0.01 lookup is room for 19 posts at $0.00663: one short of a page and a replies read.
    await add({ spendCapUsd: 0.14 });
    const x = fakeX();
    const got = await playCreator(supabase, "hexmethod", undefined, deps(x));
    expect(got.status === 200 && got.summary).toMatchObject({ stopped: "spend_cap", usage: { users: 0 } });
    expect(x.user).not.toHaveBeenCalled();
  });

  it("bills only the model work when its reader is free (FxTwitter): posts and the lookup count, cost nothing (Kev, 2026-10-31)", async () => {
    await add({ dryAfter: 0 });
    const x = { ...fakeX({ pages: [page(filler(0, 18))] }), free: true };
    const got = await playCreator(supabase, "hexmethod", undefined, deps(x));
    expect(got.status === 200 && got.summary).toMatchObject({ usage: { posts: 18, users: 1 }, estUsd: 0 });
    expect((await creator()).spent).toBe(0);
  });

  it("stops before the spend cap: pages shrink to what is left, a creator at its cap reads nothing", async () => {
    await add({ spendCapUsd: 0.2, dryAfter: 0 });
    const x = fakeX({ pages: [page(filler(0, 18), "more")] });
    const got = await playCreator(supabase, "hexmethod", undefined, deps(x));
    // 0.20 - the lookup = 0.19, at most $0.00663 a post: 28 posts, less one replies read.
    expect(x.search.mock.calls[0][2]).toMatchObject({ max: Math.floor((0.2 - 0.01) / PER_POST_MAX_USD) - 10 });
    expect(x.search.mock.calls[0][2]).toMatchObject({ max: 18 });
    expect(got.status === 200 && got.summary).toMatchObject({ stopped: "spend_cap" });
    const spent = (await creator()).spent as number;
    expect(spent).toBeLessThanOrEqual(0.2);
    expect(spent).toBe(spentOf({ posts: 18, replies: 0, users: 1, distills: 0, checks: 0, photos: 0, publishes: 0, videos: 0 }));
    const broke = fakeX();
    const none = await playCreator(supabase, "hexmethod", undefined, deps(broke));
    expect(none.status === 200 && none.summary).toMatchObject({ stopped: "spend_cap", usage: { posts: 0, users: 0 } });
    expect(broke.search).not.toHaveBeenCalled();
    expect((await creator()).spent).toBe(spent);
  });

  it("ends a round after four minutes with more to read; the posts not taken are read again by the next round", async () => {
    await add();
    const ids = [4, 3, 2, 1].map((n) => sf(NOW - 30 * DAY, n));
    const slowJudge = vi.fn(async (plan: ImportPlan, link: { url: string; normalized: string }, userId: string, text: string) => { clock.t += 100_000; return judge(plan, link, userId, text); });
    const x = fakeX({ pages: [page(ids.map((id, i) => post(id, `Prompt: ${[P_TEXT, P_REPLY, P_ALT, P_MODEL][i]}`)), "more")] });
    const got = await playCreator(supabase, "hexmethod", undefined, deps(x, { judge: slowJudge }));
    expect(got.status === 200 && got.summary).toMatchObject({ stopped: "time", more: true, found: 3 });
    expect(await creator()).toMatchObject({ oldest_id: ids[2], exhausted: false, playing_since: null });
    expect((await rows(`select finished_at from public.hunter_runs`))[0]).toEqual({ finished_at: null });
    expect(await rows(`select 1 from public.hunter_posts`)).toHaveLength(3);
  });

  it("keeps what is new to read when a round stops in the middle of it", async () => {
    await add({ postsPerPlay: 20, dryAfter: 0 });
    const newest = sf(NOW - 2 * DAY);
    await db.exec(`update public.hunter_accounts set newest_id = '${newest}', exhausted = true, x_user_id = '${XID}'`);
    const read = filler(0, 10, NOW - DAY);
    const x = fakeX({ pages: [page(read, "n2")] });
    const got = await playCreator(supabase, "hexmethod", undefined, deps(x));
    expect(got.status === 200 && got.summary).toMatchObject({ stopped: "posts_cap" });
    expect(await creator()).toMatchObject({ newest_id: newest, oldest_id: null, gap_top: read[0].id, gap_low: read[9].id });
  });

  it("catches up over several Plays when more is new than a Play reads: each reads on below the last", async () => {
    await add({ postsPerPlay: 30, dryAfter: 0 });
    const newest = sf(NOW - 3 * DAY);
    await db.exec(`update public.hunter_accounts set newest_id = '${newest}', exhausted = true, x_user_id = '${XID}'`);
    const all = Array.from({ length: 30 }, (_, i) => post(sf(NOW - DAY, 100 - i), `gm ${i}`));
    const x = fakeX();
    // X as it pages: newest first, below until_id, by next_token.
    x.search.mockImplementation(async (_q, _a, o) => {
      const below = all.filter((p) => !o.untilId || BigInt(p.id) < BigInt(o.untilId));
      const from = Number(o.nextToken ?? 0);
      return page(below.slice(from, from + o.max), from + o.max < below.length ? String(from + o.max) : null);
    });
    const one = await playCreator(supabase, "hexmethod", undefined, deps(x));
    expect(one.status === 200 && one.summary).toMatchObject({ stopped: "posts_cap", usage: { posts: 20 } });
    expect(await creator()).toMatchObject({ newest_id: newest, gap_top: all[0].id, gap_low: all[19].id });
    expect((await loadCreators(supabase, NOW)).creators[0].state.catchingUp).toBe(true);
    const two = await playCreator(supabase, "hexmethod", undefined, deps(x));
    expect(x.search.mock.calls[1][2]).toMatchObject({ sinceId: newest, untilId: all[19].id, nextToken: null });
    expect(two.status === 200 && two.summary).toMatchObject({ stopped: "done", usage: { posts: 10 }, skipped: { no_prompt: 10 } });
    expect(await creator()).toMatchObject({ newest_id: all[0].id, gap_top: null, gap_low: null });
    expect((await loadCreators(supabase, NOW)).creators[0].state.catchingUp).toBe(false);
    expect(await rows(`select 1 from public.hunter_posts`)).toHaveLength(30);
  });

  it("reads on from the first Play's start when its look back found nothing", async () => {
    await add({ sinceDays: 30 });
    const first = await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page([])] })));
    expect(first.status === 200 && first.summary).toMatchObject({ stopped: "done", found: 0 });
    expect(await creator()).toMatchObject({ exhausted: true, newest_id: sf(NOW) });
    clock.t = NOW + DAY;
    const fresh = post(sf(NOW + DAY / 2), `Prompt: ${P_TEXT}`);
    const x = fakeX({ pages: [page([fresh])] });
    const got = await playCreator(supabase, "hexmethod", undefined, deps(x));
    expect(x.search.mock.calls[0][2]).toEqual({ archive: false, max: 90, sinceId: sf(NOW), untilId: null, nextToken: null });
    expect(got.status === 200 && got.summary).toMatchObject({ found: 1 });
    expect(await creator()).toMatchObject({ newest_id: fresh.id });
  });

  it("reads what is new to its end after the look back went dry: the brake is the look back's alone", async () => {
    await add({ dryAfter: 3 });
    await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page(filler(0, 3), "more")] })));
    expect(await creator()).toMatchObject({ dry: true, exhausted: true, dry_streak: 3 });
    const gm = post(sf(NOW - DAY, 3), "gm again");
    const find = post(sf(NOW - DAY, 2), `Prompt: ${P_TEXT}`);
    const got = await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page([gm, find])] })));
    expect(got.status === 200 && got.summary).toMatchObject({ stopped: "done", found: 1, skipped: { no_prompt: 1 } });
    expect(await creator()).toMatchObject({ newest_id: gm.id, dry: true, dry_streak: 3 });
  });

  it("files nothing under the creator when X says another account wrote the posts its handle now finds", async () => {
    await add();
    await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page([])] })));
    const before = await creator();
    const OTHER = "1500000000000000999";
    const id = sf(NOW + DAY / 2);
    const urls: string[] = [];
    // X's own answer to from:hexmethod once the handle changed hands.
    const stub = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify({
        data: [{ id, text: `Prompt: ${P_TEXT}`, author_id: OTHER, conversation_id: id, attachments: { media_keys: ["3_1"] } }],
        includes: { media: [{ media_key: "3_1", type: "photo", url: "https://pbs.twimg.com/media/b.jpg" }] }, meta: {},
      }), { status: 200 });
    }) as typeof fetch;
    clock.t = NOW + DAY;
    const got = await playCreator(supabase, "hexmethod", undefined, deps(xApi(stub, "test-token")));
    const said = `@hexmethod is another X account now (${OTHER}, not ${XID}): nothing of it was taken. Look up the creator's new handle on X.`;
    expect(got).toMatchObject({ status: 500, error: said, summary: { stopped: "error", usage: { posts: 1, users: 0 } } });
    expect(urls).toHaveLength(1);
    expect(judge).not.toHaveBeenCalled();
    expect(await rows(`select 1 from public.hunt_submissions`)).toHaveLength(0);
    expect(await rows(`select 1 from public.hunter_posts`)).toHaveLength(0);
    // The read is paid and counted; the cursors stay.
    const after = await creator();
    expect(after).toMatchObject({ newest_id: before.newest_id, error: said, playing_since: null });
    expect(after.spent).toBeCloseTo((before.spent as number) + 0.005, 6);
  });

  it("files no reply X says another account wrote", async () => {
    await add();
    const OTHER = "1500000000000000999";
    const pointer = post(sf(NOW - 30 * DAY, 2), "New set, prompt in the comments 👇");
    const stranger = post(sf(NOW - 30 * DAY, 5), `Prompt: ${P_REPLY}`, { photos: [], replyingTo: pointer.id, author: { id: OTHER, handle: "hexmethod", name: "" } });
    const got = await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page([pointer])], replies: { [pointer.id]: [stranger] } })));
    expect(got).toMatchObject({ status: 500, summary: { stopped: "error", usage: { posts: 1, replies: 1 } } });
    expect(got.status !== 200 && got.error).toContain("is another X account now");
    expect(await rows(`select 1 from public.hunt_submissions`)).toHaveLength(0);
  });

  it("counts what X billed as it is billed: a round the platform ends mid-post still counts its reads", async () => {
    await add({ dryAfter: 0 });
    let reached!: () => void;
    const judging = new Promise<void>((r) => { reached = r; });
    // The judge never answers: the route's maxDuration ends the function there.
    const hung = vi.fn(async () => { reached(); return new Promise<Judged>(() => {}); });
    const pointer = post(sf(NOW - 30 * DAY, 99), "New set, prompt in the comments 👇");
    const answer = post(sf(NOW - 30 * DAY, 98), `Prompt: ${P_REPLY}`, { photos: [], replyingTo: pointer.id });
    void playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page([pointer, ...filler(0, 9)])], replies: { [pointer.id]: [answer] } }), { judge: hung }));
    await judging;
    const read = { posts: 10, replies: 1, users: 1, distills: 0, checks: 0, photos: 0, publishes: 0, videos: 0 };
    expect(await creator()).toMatchObject({ spent: spentOf(read), posts_read: 10, playing_since: expect.any(Date) });
    const [run] = await rows<Record<string, unknown>>(`select usage, est_usd::float8 as est, posts_read, finished_at from public.hunter_runs`);
    expect(run).toEqual({ usage: read, est: spentOf(read), posts_read: 10, finished_at: null });
    // The page's reads alone, when the first post hangs before any reply is read.
    await add({ dryAfter: 0 }, "other");
    let reached2!: () => void;
    const judging2 = new Promise<void>((r) => { reached2 = r; });
    const hung2 = vi.fn(async () => { reached2(); return new Promise<Judged>(() => {}); });
    const OTHER: XUser = { id: "1500000000000000002", handle: "Other", name: "Other" };
    const theirs = [post(sf(NOW - 30 * DAY, 99), `Prompt: ${P_TEXT}`), ...filler(0, 9)].map((p) => ({ ...p, author: { id: OTHER.id, handle: "other", name: "" } }));
    void playCreator(supabase, "other", undefined, deps(fakeX({ user: OTHER, pages: [page(theirs)] }), { judge: hung2 }));
    await judging2;
    const read2 = { posts: 10, replies: 0, users: 1, distills: 0, checks: 0, photos: 0, publishes: 0, videos: 0 };
    expect((await rows(`select spent_usd::float8 as spent, posts_read from public.hunter_accounts where handle = 'other'`))[0]).toEqual({ spent: spentOf(read2), posts_read: 10 });
  });

  it("finds the generator named in an alt text or in the author's reply over the creator's preferred one", async () => {
    await add({ preferredGenerator: "GPT-Image-2" });
    const alt = post(sf(NOW - 30 * DAY, 3), `Prompt: ${P_TEXT}`, { photos: [{ url: "https://pbs.twimg.com/media/n.jpg", alt: "Made with Nano Banana Pro" }] });
    const pointer = post(sf(NOW - 30 * DAY, 2), "New set, prompt in the comments 👇");
    const answer = post(sf(NOW - 30 * DAY, 9), `Nano Banana 2 · Prompt: ${P_REPLY}`, { photos: [], replyingTo: pointer.id });
    // A generator's name as a prompt's own word names nothing: the creator's preferred one.
    const flux = post(sf(NOW - 30 * DAY, 1), "Prompt: a time traveler beside a glowing flux capacitor, 80s neon, chrome DeLorean, rain");
    await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page([alt, pointer, flux])], replies: { [pointer.id]: [answer] } })));
    const subs = await rows<{ normalized_source_url: string; preview: { generators: string[]; hunt: HuntFacts } }>(`select normalized_source_url, preview from public.hunt_submissions`);
    const of = (p: XPost) => subs.find((r) => r.normalized_source_url === `x.com/status/${p.id}`)!.preview;
    expect(of(alt)).toMatchObject({ generators: ["Nano Banana Pro"], hunt: { generatorFrom: "post", from: "text" } });
    expect(of(pointer)).toMatchObject({ generators: ["Nano Banana 2"], hunt: { generatorFrom: "post", from: "reply" } });
    expect(of(flux)).toMatchObject({ generators: ["GPT-Image-2"], hunt: { generatorFrom: "preferred" } });
  });

  it("takes the generator the model found named in the post: one we do not offer queues the find even in publish mode", async () => {
    await db.exec(`update public.hunter_config set mode = 'publish'`);
    await add();
    const p = post(sf(NOW - 30 * DAY, 3), `My new look, made with Higgsfield Soul:\n\n${P_MODEL}\n\nFollow me for more 🔁`);
    const d = deps(fakeX({ pages: [page([p])] }));
    const got = await playCreator(supabase, "hexmethod", undefined, d);
    expect(got.status === 200 && got.summary).toMatchObject({ found: 1, queued: 1, published: 0 });
    expect(d.publish).not.toHaveBeenCalled();
    const [sub] = await rows<{ preview: { hunt: HuntFacts } }>(`select preview from public.hunt_submissions`);
    expect(sub.preview.hunt).toMatchObject({ how: "model", foreignGenerator: "Higgsfield Soul", generatorFrom: "all" });
  });

  it("resumes only the creator's own unfinished Play: a finished one or another creator's starts a new one", async () => {
    await add();
    await add({}, "other");
    const first = await playCreator(supabase, "hexmethod", undefined, deps(fakeX()));
    const done = first.status === 200 ? first.summary.runId : "";
    const again = await playCreator(supabase, "hexmethod", done, deps(fakeX()));
    const next = again.status === 200 ? again.summary.runId : "";
    expect(next).not.toBe(done);
    await db.exec(`update public.hunter_runs set finished_at = null where id = '${next}'`);
    const theirs = await playCreator(supabase, "other", next, deps(fakeX()));
    expect(theirs.status === 200 && theirs.summary.runId).not.toBe(next);
    expect(await rows(`select 1 from public.hunter_runs`)).toHaveLength(3);
  });

  it("waits only between full-archive requests, not between recent ones", async () => {
    await add({ dryAfter: 0 });
    await db.exec(`update public.hunter_accounts set newest_id = '${sf(NOW - DAY)}', exhausted = true, x_user_id = '${XID}'`);
    const x = fakeX({ pages: [page(filler(0, 10, NOW - DAY / 2), "n2"), page(filler(10, 10, NOW - DAY / 2))] });
    const d = deps(x);
    await playCreator(supabase, "hexmethod", undefined, d);
    expect(x.search.mock.calls.map((c) => c[2].archive)).toEqual([false, false]);
    expect(d.sleep).not.toHaveBeenCalled();
  });

  it("leaves the look back after N posts in a row without a prompt (a find resets the count, a video-only post leaves it), and skips posts it took before", async () => {
    await add({ dryAfter: 3 });
    const f = filler(0, 7);
    const posts = [f[0], post(f[1].id, `Prompt: ${P_TEXT}`), f[2], post(f[3].id, "clip", { videos: 1, photos: [] }), f[4], f[5], f[6]];
    await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page(posts, "more")] })));
    expect(await creator()).toMatchObject({ dry: true, exhausted: true, dry_streak: 3, oldest_id: posts[5].id });
    expect(await rows(`select 1 from public.hunter_posts`)).toHaveLength(6);
    // Generator and caps change nothing else.
    const cfg = { ...CREATOR_DEFAULTS, dryAfter: 3 };
    expect(await saveCreator(supabase, { handle: "hexmethod", config: { ...cfg, preferredGenerator: "GPT-Image-2", spendCapUsd: 9 }, catalogue: CATALOGUE })).toEqual({ ok: true });
    expect(await creator()).toMatchObject({ dry: true, exhausted: true, oldest_id: posts[5].id, preferred_generator: "GPT-Image-2" });
    // A search change starts the reading over, unfinished new posts included, but not while a Play holds the creator.
    await db.exec(`update public.hunter_accounts set gap_top = '9', gap_low = '8', playing_since = '${new Date(NOW - 60_000).toISOString()}'`);
    expect(await saveCreator(supabase, { handle: "hexmethod", config: { ...cfg, words: ["prompt"] }, catalogue: CATALOGUE, now: NOW }))
      .toEqual({ ok: false, status: 409, error: "@hexmethod is playing: stop it before changing its search." });
    await db.exec(`update public.hunter_accounts set playing_since = null`);
    expect(await saveCreator(supabase, { handle: "hexmethod", config: { ...cfg, words: ["prompt"] }, catalogue: CATALOGUE, now: NOW })).toEqual({ ok: true });
    expect(await creator()).toMatchObject({ dry: false, exhausted: false, dry_streak: 0, oldest_id: null, newest_id: null, gap_top: null, gap_low: null, words: ["prompt"] });
    // The posts taken are not taken twice.
    const again = await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page(posts)] })));
    expect(again.status === 200 && again.summary.skipped).toEqual({ seen: 6, no_prompt: 1 });
    expect(judge).toHaveBeenCalledTimes(1);
  });

  it("takes neither a post a person referred already nor a prompt it has, and no reply that slipped into the search", async () => {
    await add();
    const referred = post(sf(NOW - 30 * DAY, 3), `Prompt: ${P_TEXT}`);
    await db.exec(`insert into public.hunt_submissions (hunter_user_id, normalized_source_url) values ('${ADMIN}', 'x.com/status/${referred.id}')`);
    const twice = [post(sf(NOW - 30 * DAY, 2), `Prompt: ${P_REPLY}`), post(sf(NOW - 30 * DAY, 1), `Prompt: ${P_REPLY}`)];
    const answer = post(sf(NOW - 30 * DAY, 0), `Prompt: ${P_ALT}`, { replyingTo: "1" });
    const got = await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page([referred, ...twice, answer])] })));
    expect(got.status === 200 && got.summary).toMatchObject({ found: 1, skipped: { duplicate: 2, reply: 1 } });
    expect(judge).toHaveBeenCalledTimes(1);
  });

  it("asks the model about alt texts the post does not point at, and takes the reply's pictures for a post without any", async () => {
    await add({ media: "any" });
    const alt = post(sf(NOW - 30 * DAY, 2), "New drop", { photos: [{ url: "https://pbs.twimg.com/media/q.jpg", alt: `${P_MODEL} #ai` }] });
    const bare = post(sf(NOW - 30 * DAY, 1), "Prompt below 👇", { photos: [] });
    const reply = post(sf(NOW - 30 * DAY, 5), `Prompt: ${P_REPLY}`, { photos: [{ url: "https://pbs.twimg.com/media/r.jpg", alt: null }] });
    const got = await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page([alt, bare])], replies: { [bare.id]: [reply] } })));
    expect(got.status === 200 && got.summary).toMatchObject({ found: 2 });
    const subs = await rows<{ normalized_source_url: string; preview: { photos: string[]; hunt: HuntFacts } }>(`select normalized_source_url, preview from public.hunt_submissions`);
    const of = (p: XPost) => subs.find((r) => r.normalized_source_url === `x.com/status/${p.id}`)!.preview;
    expect(of(alt).hunt).toMatchObject({ from: "alt", how: "model" });
    expect(of(bare).hunt).toMatchObject({ from: "reply", how: "label", replyUrl: reply.url });
    expect(of(bare).photos).toEqual(["https://pbs.twimg.com/media/r.jpg"]);
  });

  it("counts a post the model found no prompt in toward the dry streak", async () => {
    await add({ dryAfter: 2 });
    const unsure = filler(0, 3).map((p, i) => post(p.id, `A long caption about my week number ${i} in the studio, nothing to paste here`));
    const got = await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page(unsure, "more")] })));
    expect(got.status === 200 && got.summary).toMatchObject({ stopped: "dry", skipped: { distill_failed: 2 }, usage: { distills: 2 } });
    expect(await creator()).toMatchObject({ dry: true, dry_streak: 2 });
  });

  // Kev, 2026-11-02: failed posts stayed marked as read, and Start over skipped them for good.
  it("tries a failed post again after a Start over, only those, and counts each find once", async () => {
    await add();
    const ids = [5, 4, 3, 2].map((n) => sf(NOW - 30 * DAY, n));
    const posts = [
      post(ids[0], `hier ist ein gratis prompt für Portraits:\n\n${P_MODEL}\n\nFollow me for more 🔁`),
      post(ids[1], "New set, prompt in the comments 👇"),
      post(ids[2], "gm ☀️"),
      post(ids[3], `Prompt: ${P_TEXT}`),
    ];
    const first = await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page(posts)] }), { distill: async () => ({ ok: false, why: "distill_failed" }) }));
    expect(first.status === 200 && first.summary).toMatchObject({ found: 1, skipped: { distill_failed: 1, reply_missing: 1, no_prompt: 1 } });
    expect(await creator()).toMatchObject({ found: 1, exhausted: true });

    expect(await restartCreator(supabase, "hexmethod", NOW)).toEqual({ ok: true });
    expect(await rows(`select post_id, outcome from public.hunter_posts order by post_id desc`)).toEqual([
      { post_id: ids[0], outcome: "retry" }, { post_id: ids[1], outcome: "retry" }, { post_id: ids[2], outcome: "no_prompt" }, { post_id: ids[3], outcome: "queued" },
    ]);
    expect(await creator()).toMatchObject({ found: 1, exhausted: false, newest_id: null });

    judge.mockClear();
    const replies = { [ids[1]]: [post(sf(NOW - 30 * DAY, 9), `Prompt: ${P_REPLY}`, { replyingTo: ids[1] })] };
    const second = await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page(posts)], replies })));
    expect(second.status === 200 && second.summary).toMatchObject({ found: 2, queued: 2, skipped: { seen: 2 }, usage: { distills: 1 } });
    expect(judge).toHaveBeenCalledTimes(2);
    expect(await creator()).toMatchObject({ found: 3 });
    expect(await rows(`select post_id, outcome, submission_id is not null as filed from public.hunter_posts order by post_id desc`)).toEqual([
      { post_id: ids[0], outcome: "queued", filed: true }, { post_id: ids[1], outcome: "queued", filed: true },
      { post_id: ids[2], outcome: "no_prompt", filed: false }, { post_id: ids[3], outcome: "queued", filed: true },
    ]);
    expect(await rows(`select 1 from public.hunt_submissions`)).toHaveLength(3);
  });

  it("does not stop a Start over's retries as dry across a find read again; a post with no prompt or a link in line leaves the streak", async () => {
    await add({ dryAfter: 2 });
    const unsure = filler(0, 5).map((p, i) => post(p.id, `A long caption about my week number ${i} in the studio, nothing to paste here`));
    const mark = (id: string, outcome: string) => db.exec(`insert into public.hunter_posts (post_id, handle, outcome) values ('${id}', 'hexmethod', '${outcome}')`);
    await mark(unsure[1].id, "queued");
    await mark(unsure[3].id, "published");
    const through = await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page(unsure)] })));
    expect(through.status === 200 && through.summary).toMatchObject({ stopped: "done", skipped: { seen: 2, distill_failed: 3 } });
    expect(await creator()).toMatchObject({ dry: false, dry_streak: 1 });

    await db.exec(`truncate public.hunter_posts`);
    expect(await restartCreator(supabase, "hexmethod", NOW)).toEqual({ ok: true });
    await mark(unsure[1].id, "no_prompt");
    await mark(unsure[2].id, "waiting");
    const dry = await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page(unsure, "more")] })));
    expect(dry.status === 200 && dry.summary).toMatchObject({ stopped: "dry", skipped: { seen: 2, distill_failed: 2 } });
    expect(await creator()).toMatchObject({ dry: true, dry_streak: 2 });
  });

  // Review 2026-11-02: every Start over paid again, stopped dry at the same post, and what lay below was never read.
  it("passes retries that fail again without the dry brake, reads on below them, and keeps each post's log line", async () => {
    await add({ dryAfter: 2 });
    const failing = [3, 2, 1].map((n, i) => post(sf(NOW - 30 * DAY, 100 + n), `A long caption about my week number ${i} in the studio, nothing to paste here`));
    const sure = post(sf(NOW - 30 * DAY, 50), `Prompt: ${P_TEXT}`);
    const distill = vi.fn(async (): Promise<Awaited<ReturnType<CreatorDeps["distill"]>>> => ({ ok: false, why: "distill_failed" }));
    for (const p of failing) await db.query(`insert into public.hunter_posts (post_id, handle, outcome, read_at) values ($1, 'hexmethod', 'distill_failed', '2026-01-01T00:00:00Z')`, [p.id]);
    await db.exec(`update public.hunter_accounts set oldest_id = '${failing[2].id}', newest_id = '${failing[0].id}', exhausted = true, dry = true, dry_streak = 2 where handle = 'hexmethod'`);

    for (const round of [1, 2, 3]) {
      judge.mockClear();
      distill.mockClear();
      expect(await restartCreator(supabase, "hexmethod", NOW)).toEqual({ ok: true });
      await db.exec(`truncate public.hunt_submissions; delete from public.hunter_posts where post_id = '${sure.id}'`);
      const got = await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page([...failing, sure])] }), { distill }));
      expect([round, got.status === 200 && got.summary]).toMatchObject([round, { stopped: "done", found: 1, skipped: { distill_failed: 3 } }]);
      expect(distill).toHaveBeenCalledTimes(3);
      expect(judge).toHaveBeenCalledTimes(1);
      expect(await creator()).toMatchObject({ dry: false, dry_streak: 0, exhausted: true });
      const marks = await rows<{ post_id: string; outcome: string; fresh: boolean }>(`select post_id, outcome, read_at > '2026-06-01' as fresh from public.hunter_posts order by post_id desc`);
      expect(marks).toEqual([...failing.map((p) => ({ post_id: p.id, outcome: "distill_failed", fresh: true })), { post_id: sure.id, outcome: "queued", fresh: true }]);
    }

    // Only what was never read counts: a retry leaves the streak, and the brake still stops at unread posts.
    await db.exec(`truncate public.hunter_posts; truncate public.hunt_submissions`);
    expect(await restartCreator(supabase, "hexmethod", NOW)).toEqual({ ok: true });
    const unread = [40, 39].map((n, i) => post(sf(NOW - 30 * DAY, n), `A long caption about my day number ${i} in the studio, nothing to paste here`));
    await db.query(`insert into public.hunter_posts (post_id, handle, outcome) values ($1, 'hexmethod', 'retry')`, [failing[1].id]);
    const braked = await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page([failing[1], ...unread, sure], "more")] }), { distill }));
    expect(braked.status === 200 && braked.summary).toMatchObject({ stopped: "dry", found: 0, skipped: { distill_failed: 3 } });
    expect(await creator()).toMatchObject({ dry: true, dry_streak: 2, oldest_id: unread[1].id });

    // A retry that finds ends a streak, as any find does.
    await db.exec(`truncate public.hunter_posts; update public.hunter_accounts set dry = false, exhausted = false, oldest_id = null, newest_id = null, dry_streak = 1 where handle = 'hexmethod'`);
    await db.query(`insert into public.hunter_posts (post_id, handle, outcome) values ($1, 'hexmethod', 'retry')`, [sure.id]);
    await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page([sure])] }), { distill }));
    expect(await creator()).toMatchObject({ dry_streak: 0 });

    // A new outcome that could not be written is said, and the mark stays for the next Play.
    await db.exec(`truncate public.hunter_posts, public.hunt_submissions; update public.hunter_accounts set dry = false, exhausted = false, oldest_id = null, newest_id = null;
      create function public.refuse_write() returns trigger language plpgsql as $$ begin raise exception 'refused'; end $$;
      create trigger refuse_write before update on public.hunter_posts for each row execute function public.refuse_write();`);
    await db.query(`insert into public.hunter_posts (post_id, handle, outcome) values ($1, 'hexmethod', 'retry')`, [failing[0].id]);
    const refused = await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page([failing[0]])] }), { distill }));
    await db.exec(`drop trigger refuse_write on public.hunter_posts; drop function public.refuse_write();`);
    expect(refused.status).toBe(500);
    expect(await rows(`select outcome from public.hunter_posts`)).toEqual([{ outcome: "retry" }]);
  });

  it("leaves the dry streak alone in what is new, a find read again included: the brake is the look back's", async () => {
    await add({ dryAfter: 2 });
    const known = post(sf(NOW - 2 * DAY, 2), "gm");
    await db.query(`insert into public.hunter_posts (post_id, handle, outcome) values ($1, 'hexmethod', 'queued')`, [known.id]);
    await db.exec(`update public.hunter_accounts set newest_id = '${sf(NOW - 3 * DAY)}', oldest_id = '${sf(NOW - 90 * DAY)}', exhausted = true, dry_streak = 1 where handle = 'hexmethod'`);
    await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page([known])] })));
    expect(await creator()).toMatchObject({ dry_streak: 1 });
  });

  it("stops before a post the model could not be asked about, records nothing of it, and the next Play takes it (review 2026-10-30, F5)", async () => {
    const said = "The model could not be asked: nothing was skipped. Press Play again in a minute.";
    // The distill down (OpenAI 5xx), then the judge down (its prompt check unavailable).
    const down = (async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch;
    const judgeDown = vi.fn(async (): Promise<Judged> => ({ ok: false, status: 503, error: "The prompt could not be checked right now. Try again in a minute." }));
    for (const [handle, over, text] of [
      ["hexmethod", { distill: (src: Sources) => distillPrompt(src, down) }, (i: number) => `hier ist ein gratis prompt für euch number ${i}:\n\n${P_MODEL}`],
      ["other", { judge: judgeDown }, (i: number) => `Prompt: ${P_TEXT}, take ${i}`],
    ] as const) {
      await db.exec(`truncate public.hunt_submissions, public.hunter_posts`);
      await add({}, handle);
      const xid = handle === "other" ? "1500000000000000002" : XID;
      const me: XUser = { id: xid, handle, name: handle };
      const posts = filler(0, 3).map((p, i) => post(p.id, text(i), { author: { id: xid, handle, name: "" } }));
      const got = await playCreator(supabase, handle, undefined, deps(fakeX({ user: me, pages: [page(posts)] }), over as Partial<CreatorDeps>));
      expect(got).toMatchObject({ status: 503, error: said, summary: { stopped: "error", found: 0, skipped: {} } });
      expect(await rows(`select 1 from public.hunter_posts`)).toHaveLength(0);
      const row = (await rows(`select oldest_id, exhausted, error, playing_since from public.hunter_accounts where handle = '${handle}'`))[0];
      expect(row).toEqual({ oldest_id: null, exhausted: false, error: said, playing_since: null });
      // The model is back: the same posts are judged.
      const again = await playCreator(supabase, handle, undefined, deps(fakeX({ user: me, pages: [page(posts.slice(0, 1))] })));
      expect(again.status === 200 && again.summary).toMatchObject({ stopped: "done", found: 1 });
    }
  });

  it("stops before a find it could not save, and the next Play takes it (review 2026-10-30, F5)", async () => {
    await add();
    await db.exec(`create function public.refuse_find() returns trigger language plpgsql as $$ begin raise exception 'finds refused by the test'; end $$;
      create trigger refuse_find before insert on public.hunt_submissions for each row execute function public.refuse_find();`);
    const posts = filler(0, 2).map((p, i) => post(p.id, `Prompt: ${P_TEXT}, take ${i}`));
    try {
      const got = await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page(posts)] })));
      expect(got).toMatchObject({ status: 500, summary: { stopped: "error", found: 0 } });
      expect(got.status !== 200 && got.error).toContain("could not be saved");
      expect(await rows(`select 1 from public.hunter_posts`)).toHaveLength(0);
    } finally {
      await db.exec(`drop trigger refuse_find on public.hunt_submissions; drop function public.refuse_find();`);
    }
    const again = await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page(posts)] })));
    expect(again.status === 200 && again.summary).toMatchObject({ stopped: "done", found: 2 });
  });

  it("says what the database refused on the creator's row (review 2026-10-30, F11)", async () => {
    await add();
    await db.exec(`create function public.refuse_post() returns trigger language plpgsql as $$ begin raise exception 'posts refused by the test'; end $$;
      create trigger refuse_post before insert on public.hunter_posts for each row execute function public.refuse_post();`);
    try {
      const got = await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page(filler(0, 2))] })));
      expect(got).toMatchObject({ status: 500, summary: { stopped: "error" } });
      expect(got.status !== 200 && got.error).toContain("posts refused by the test");
      expect(String((await creator()).error)).toContain("posts refused by the test");
    } finally {
      await db.exec(`drop trigger refuse_post on public.hunter_posts; drop function public.refuse_post();`);
    }
  });

  it("asks X's archive from its start when the creator says its whole archive: X's own default is the last 30 days (review 2026-10-30, F7)", async () => {
    await add({ sinceDays: 0 });
    const x = fakeX({ pages: [page([])] });
    await playCreator(supabase, "hexmethod", undefined, deps(x));
    expect(x.search.mock.calls[0][2]).toMatchObject({ archive: true, untilId: null, startTime: "2006-03-21T00:00:00.000Z" });
  });

  it("reads on past an empty page X gives a next token with, as X says to page (review 2026-10-30, F16)", async () => {
    await add();
    const find = post(sf(NOW - 300 * DAY, 1), `Prompt: ${P_TEXT}`);
    const x = fakeX();
    x.search.mockImplementation(async (_q, _a, o) => (o.nextToken === "t1" ? page([find]) : page([], "t1")));
    const got = await playCreator(supabase, "hexmethod", undefined, deps(x));
    expect(got.status === 200 && got.summary).toMatchObject({ stopped: "done", found: 1 });
    expect(x.search.mock.calls.map((c) => [c[2].untilId, c[2].nextToken ?? null])).toEqual([[null, null], [null, "t1"]]);
    expect(await creator()).toMatchObject({ exhausted: true, oldest_id: find.id });
  });

  it("renews its hold while it runs: a second tab's Play is refused while a slow round outlives five minutes (review 2026-10-30, F10)", async () => {
    await add({ dryAfter: 0 });
    const posts = [0, 1, 2].map((i) => post(sf(NOW - 30 * DAY, 9 - i), `Prompt: ${P_TEXT}, take ${i}`));
    let second: Awaited<ReturnType<typeof playCreator>> | null = null;
    const slow = vi.fn(async (plan: ImportPlan, link: { url: string; normalized: string }, userId: string, text: string) => {
      clock.t += 110_000;
      // Pressed in another tab while the round's third post is judged, 330 s after it started.
      if (slow.mock.calls.length === 3) second = await playCreator(supabase, "hexmethod", undefined, deps(fakeX()));
      return judge(plan, link, userId, text);
    });
    const got = await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page(posts)] }), { judge: slow }));
    expect(second).toEqual({ status: 409, error: "@hexmethod is already playing." });
    expect(got.status === 200 && got.summary).toMatchObject({ found: 3 });
    expect(await rows(`select 1 from public.hunt_submissions`)).toHaveLength(3);
  });

  it("stops and writes nothing over a Play that took its hold over, its spend included (review 2026-10-30, F10)", async () => {
    await add({ dryAfter: 0 });
    const posts = [0, 1].map((i) => post(sf(NOW - 30 * DAY, 9 - i), `Prompt: ${P_TEXT}, take ${i}`));
    const TAKEN = new Date(NOW + 1000).toISOString();
    const lost = vi.fn(async (plan: ImportPlan, link: { url: string; normalized: string }, userId: string, text: string) => {
      clock.t += 70_000;
      // Another tab's Play holds the creator now, with the spend it counted.
      if (lost.mock.calls.length === 1) await db.exec(`update public.hunter_accounts set playing_since = '${TAKEN}', spent_usd = 0.42`);
      return judge(plan, link, userId, text);
    });
    const got = await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page(posts)] }), { judge: lost }));
    expect(got).toMatchObject({ status: 409, summary: { stopped: "error" } });
    expect(got.status !== 200 && got.error).toContain("taken over by another Play");
    expect(lost).toHaveBeenCalledTimes(1);
    expect(await creator()).toMatchObject({ spent: 0.42, playing_since: new Date(TAKEN), newest_id: null, oldest_id: null });
    // Taken over while a replies read is billed: that read's checkpoint writes no spend over the other Play's either.
    await db.exec(`truncate public.hunter_accounts, public.hunter_posts, public.hunter_runs, public.hunt_submissions cascade`);
    await add({ dryAfter: 0 });
    const pointer = post(sf(NOW - 30 * DAY, 99), "New set, prompt in the comments 👇");
    const x = fakeX({ pages: [page([pointer])] });
    x.replies.mockImplementation(async () => {
      await db.exec(`update public.hunter_accounts set playing_since = '${TAKEN}', spent_usd = 0.42`);
      return [post(sf(NOW - 30 * DAY, 98), `Prompt: ${P_REPLY}`, { photos: [], replyingTo: pointer.id })];
    });
    judge.mockClear();
    const read = await playCreator(supabase, "hexmethod", undefined, deps(x));
    expect(read).toMatchObject({ status: 409, summary: { stopped: "error", found: 0 } });
    expect(judge).not.toHaveBeenCalled();
    expect(await creator()).toMatchObject({ spent: 0.42, playing_since: new Date(TAKEN) });
  });

  it("finds the generator on the line after a labelled prompt: the model cuts the prompt, the line names the generator (review 2026-10-30, F2)", async () => {
    await db.exec(`update public.hunter_config set mode = 'publish'`);
    for (const [line, want] of [
      ["Model: Midjourney v7", { queued: 1, published: 0, generators: ["GPT-Image-2"], hunt: { generatorFrom: "preferred", foreignGenerator: "Midjourney v7", how: "model" } }],
      ["Made with Nano Banana Pro", { queued: 0, published: 1, generators: ["Nano Banana Pro"], hunt: { generatorFrom: "post", foreignGenerator: null, how: "model" } }],
    ] as const) {
      await db.exec(`truncate public.users, public.hunt_submissions, public.hunter_accounts, public.hunter_posts, public.hunter_runs cascade`);
      await add({ preferredGenerator: "GPT-Image-2" });
      const p = post(sf(NOW - 30 * DAY, 3), `Prompt: ${P_MODEL}\n${line}`);
      const got = await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page([p])] })));
      expect(got.status === 200 && got.summary).toMatchObject({ found: 1, queued: want.queued, published: want.published });
      const [sub] = await rows<{ preview: { generators: string[]; hunt: HuntFacts }; preview_token: string }>(`select preview, preview_token from public.hunt_submissions`);
      expect(openPreview(sub.preview_token)!.prompt).toBe(P_MODEL);
      expect(sub.preview).toMatchObject({ generators: want.generators, hunt: want.hunt });
    }
  });

  it("saves the settings of a creator on the list only: one removed meanwhile is not brought back (review 2026-10-30, F14)", async () => {
    await add({ spendCapUsd: 3 });
    await db.exec(`delete from public.hunter_accounts where handle = 'hexmethod'`);
    expect(await saveCreator(supabase, { handle: "hexmethod", config: CREATOR_DEFAULTS, catalogue: CATALOGUE }))
      .toEqual({ ok: false, status: 404, error: "@hexmethod is not on the list any more." });
    expect(await rows(`select 1 from public.hunter_accounts`)).toHaveLength(0);
  });

  it("turns a find's [ NAME = value ] lines into Enki variables before it is judged, and keeps them for the publish (Kev, 2026-10-31)", async () => {
    await add();
    const text = `Prompt: [ BRAND NAME = _____ ] A botanical concrete logo for BRAND NAME, ${P_TEXT}`;
    const got = await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page([post(sf(NOW - 30 * DAY, 3), text)])] })));
    expect(got.status === 200 && got.summary).toMatchObject({ queued: 1 });
    expect(judge.mock.calls[0][0].prompt.startsWith("BRAND NAME = [BRAND NAME] A botanical concrete logo for BRAND NAME")).toBe(true);
    const [sub] = await rows<{ preview: { hunt: HuntFacts } }>(`select preview from public.hunt_submissions`);
    expect(sub.preview.hunt.variables?.[0]).toEqual({ name: "BRAND NAME", label: "BRAND NAME", description: "", type: "text", defaultValue: "BRAND NAME", required: true, position: 0 });
    // The prompt's own [slot] (P_TEXT's) gets its variable as well.
    expect(sub.preview.hunt.variables?.slice(1).every((v) => P_TEXT.includes(`[${v.name}]`))).toBe(true);
  });

  it("reads the author's replies of every post without a sure prompt when its reader is free (Kev, 2026-10-31)", async () => {
    await add();
    const main = post(sf(NOW - 30 * DAY, 4), "Nano Banana prompt:\n\nSocial media ad template\n\nSwap one variable and get a brand-new ad every single time");
    const reply = post(sf(NOW - 30 * DAY, 5), `Prompt: ${P_REPLY}`, { photos: [], replyingTo: main.id });
    const x = { ...fakeX({ pages: [page([main])], replies: { [main.id]: [reply] } }), free: true };
    const got = await playCreator(supabase, "hexmethod", undefined, deps(x));
    expect(got.status === 200 && got.summary).toMatchObject({ queued: 1, usage: { replies: 1 } });
    expect(x.replies).toHaveBeenCalledTimes(1);
    const [sub] = await rows<{ preview: { prompt: string; hunt: HuntFacts } }>(`select preview from public.hunt_submissions`);
    expect(sub.preview.hunt.from).toBe("reply");
  });

  it("takes the prompt out of a post longer than the model reads: it sees the beginning and the end, the cut is made on the whole (Kev, 2026-10-31)", async () => {
    await add({ dryAfter: 2 });
    const [a, b, c] = filler(0, 3);
    const long = post(b.id, `hier ist ein gratis prompt für euch:

${P_MODEL} ${"and one more fine detail, ".repeat(1200)}`);
    expect(long.text.length).toBeGreaterThan(SOURCE_MAX);
    const got = await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page([a, long, c], "more")] })));
    expect(got.status === 200 && got.summary).toMatchObject({ found: 1, skipped: { no_prompt: 2 }, usage: { distills: 1 } });
    // The whole prompt goes to the checks (judgeImport's prompt check reads it all), the filler after it does not.
    expect(judge).toHaveBeenCalledTimes(1);
    expect(judge.mock.calls[0][0].prompt).toBe(P_MODEL);
  });

  it("in manual, cuts the find, titles it by its heading, keeps the whole text beside it and out of the seal, and marks a cut that missed", async () => {
    await add();
    expect(await saveMode(supabase, { handle: "hexmethod", mode: "manual", recipe: {} })).toEqual({ ok: true });
    const plain = (plan: ImportPlan, link: { url: string; normalized: string }, userId: string, title: string) => plainImport(supabase, { plan, link, userId, title, fetchFn: pics });
    const text = `Free prompt for you all\n\nGolden hour\n${P_TEXT}\n\n${P_REPLY}\n\nhttps://t.co/abc\n\nFollow me for more`;
    const one = post(sf(NOW - 30 * DAY, 4), text);
    const generator = post(sf(NOW - 30 * DAY, 3), `Intro words\n\nGpt image 2\n${P_ALT}`);
    const short = post(sf(NOW - 30 * DAY, 2), "gm, a nice picture");
    const exact = post(sf(NOW - 30 * DAY, 1), P_MODEL);
    const got = await playCreator(supabase, "hexmethod", undefined, deps({ ...fakeX({ pages: [page([one, generator, short, exact])] }), free: true }, { plain }));
    expect(got.status === 200 && got.summary).toMatchObject({ found: 4 });
    const finds = await rows<{ normalized_source_url: string; suggested_title: string; preview_token: string; preview: { prompt: string; title: string; hunt: HuntFacts } }>(`select normalized_source_url, suggested_title, preview_token, preview from public.hunt_submissions`);
    const of = (p: XPost) => finds.find((f) => f.normalized_source_url === `x.com/status/${p.id}`)!;
    expect(of(one).preview).toMatchObject({ prompt: `${P_TEXT}\n\n${P_REPLY}`, title: "Golden hour", hunt: { from: "text", how: "manual", raw: text } });
    // Nothing in it was formed: one copy of the text is enough.
    expect(of(one).preview.hunt.rawWords).toBeUndefined();
    expect(of(one).preview.hunt.recipeMiss).toBeUndefined();
    const sealed = openPreview(of(one).preview_token)!;
    expect(sealed.prompt).toBe(`${P_TEXT}\n\n${P_REPLY}`);
    expect(JSON.stringify(sealed)).not.toContain("Free prompt for you all");
    // A heading that names only a generator gives way to the prompt's first words (plainImport's guard), and still leaves the prompt.
    expect(of(generator).preview.prompt).toBe(P_ALT);
    expect(of(generator).preview.title).not.toContain("Gpt");
    expect(of(short).preview).toMatchObject({ prompt: "gm, a nice picture", hunt: { recipeMiss: "the cut is too short for a prompt: the whole text" } });
    expect(of(short).preview.hunt.raw).toBeUndefined();
    expect(of(short).preview.hunt.rawWords).toBeUndefined();
    // Nothing cut away: no second copy.
    expect(of(exact).preview.hunt.raw).toBeUndefined();
  });

  it.skipIf(!existsSync(join(ROOT, "..", "sql-to-run", "64-hunter-parked.sql")))("SQL 64 is in sql-to-run byte for byte", () => {
    expect(readFileSync(join(ROOT, "..", "sql-to-run", "64-hunter-parked.sql"), "utf8").split("\r\n").join("\n")).toBe(migration("2026-11-03-hunter-parked.sql"));
  });

  describe("a video is saved, never discarded (Kev, 2026-11-03: \"nicht verwerfen, we will implement them, save them\")", () => {
    const VIDEO = { id: "v1", url: "https://video.twimg.com/amplify_video/1/vid/720.mp4", thumbnail_url: "https://pbs.twimg.com/amplify_video_thumb/1/a.jpg", duration: 12.5, width: 720, height: 1280, type: "video",
      formats: [{ url: "https://video.twimg.com/amplify_video/1/pl/a.m3u8", container: "m3u8" }, { url: "https://video.twimg.com/amplify_video/1/vid/720.mp4", bitrate: 832000, container: "mp4", codec: "h264" }] };
    const free = (o: Parameters<typeof fakeX>[0]) => ({ ...fakeX(o), free: true });
    const parked = () => rows<Record<string, unknown>>(`select * from public.hunter_parked order by post_id`);

    it("saves a post with only a video whole, with no find, its outcome video_only; a post with both gets its find as well", async () => {
      await add();
      const bothId = sf(NOW - 30 * DAY, 2), videoId = sf(NOW - 30 * DAY, 1);
      const both = post(bothId, `Prompt: ${P_TEXT}`, { videos: 1, videoData: [VIDEO] });
      const video = post(videoId, `Prompt: ${P_REPLY}`, { videos: 1, videoData: [VIDEO], photos: [] });
      const words = post(sf(NOW - 30 * DAY, 9), "the steps, in my words", { photos: [], replyingTo: videoId });
      const got = await playCreator(supabase, "hexmethod", undefined, deps(free({ pages: [page([both, video])], replies: { [videoId]: [words] } })));
      expect(got.status === 200 && got.summary).toMatchObject({ found: 1, skipped: { video_only: 1 }, usage: { videos: 2 } });
      const [sub] = await rows<{ normalized_source_url: string; preview: { hunt: HuntFacts } }>(`select normalized_source_url, preview from public.hunt_submissions`);
      expect(sub.normalized_source_url).toBe(`x.com/status/${bothId}`);
      expect(sub.preview.hunt.videosSkipped).toBe(1);
      const saved = await parked();
      expect(saved.map((r) => [r.post_id, r.kind, r.why])).toEqual([[videoId, "video", "no picture"], [bothId, "video", "beside pictures"]]);
      expect(saved[0]).toMatchObject({
        handle: "hexmethod", author_id: XID, url: `https://x.com/hexmethod/status/${videoId}`, post_text: `Prompt: ${P_REPLY}`, videos: [VIDEO], photos: [],
        replies: [{ id: words.id, url: words.url, text: "the steps, in my words" }],
      });
      expect(saved[1]).toMatchObject({ photos: [`https://pbs.twimg.com/media/${bothId}.jpg`], reach: { core: { likes: 50 } } });
      expect((await rows(`select post_id, outcome from public.hunter_posts order by post_id`))).toEqual([{ post_id: videoId, outcome: "video_only" }, { post_id: bothId, outcome: "queued" }]);
    });

    it("stops before a post whose replies could not be read: not marked, the cursor before it, and the next Play reads it", async () => {
      await add();
      const first = sf(NOW - 30 * DAY, 2), second = sf(NOW - 30 * DAY, 1);
      const clip = post(sf(NOW - 30 * DAY, 7), "the steps, in my words", { photos: [], replyingTo: second, videos: 1, videoData: [VIDEO] });
      const posts = [post(first, `Prompt: ${P_TEXT}`), post(second, "Just a look, no words of a prompt here at all, only a caption", { photos: [] })];
      const failing = { ...free({ pages: [page(posts)] }), replies: vi.fn(async (p: XPost) => (p.id === second ? null : [])) };
      const got = await playCreator(supabase, "hexmethod", undefined, deps(failing));
      expect(got).toMatchObject({ status: 503, error: "The author's replies under a post of @hexmethod could not be read: nothing was skipped. Press Play again in a minute.", summary: { stopped: "error", found: 1 } });
      expect(await rows(`select post_id, outcome from public.hunter_posts`)).toEqual([{ post_id: first, outcome: "queued" }]);
      expect(await parked()).toEqual([]);
      expect((await creator()).oldest_id).toBe(first);
      const again = await playCreator(supabase, "hexmethod", undefined, deps(free({ pages: [page([posts[1]])], replies: { [second]: [clip] } })));
      expect(again.status).toBe(200);
      expect(await parked()).toMatchObject([{ post_id: second, kind: "video", videos: [{ ...VIDEO, reply_id: clip.id }] }]);
    });

    it("a post read again keeps the row's pictures, and a row that could not be read is not written over", async () => {
      await add();
      const id = sf(NOW - 30 * DAY, 2);
      const seed = () => db.query(`insert into public.hunter_parked (post_id, kind, handle, url, why, videos, photos) values ($1, 'video', 'hexmethod', 'u', 'no picture', $2, $3)`, [id, JSON.stringify([VIDEO]), JSON.stringify(["https://pbs.twimg.com/media/old.jpg"])]);
      await seed();
      const bareOne = post(id, `Prompt: ${P_TEXT}`, { photos: [] });
      const got = await playCreator(supabase, "hexmethod", undefined, deps(free({ pages: [page([bareOne])] })));
      expect(got.status === 200 && got.summary.skipped).toEqual({ video_only: 1 });
      expect(await parked()).toMatchObject([{ kind: "video", photos: ["https://pbs.twimg.com/media/old.jpg"], videos: [VIDEO] }]);
      await db.exec(`truncate public.hunter_parked, public.hunter_posts cascade; update public.hunter_accounts set newest_id = null, oldest_id = null, exhausted = false`);
      await seed();
      const refused = { from: (t: string) => {
        const q = supabase.from(t);
        return t !== "hunter_parked" ? q : { upsert: q.upsert.bind(q), select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: "the read failed" } }) }) }) };
      } } as unknown as SupabaseClient;
      const stopped = await playCreator(refused, "hexmethod", undefined, deps(free({ pages: [page([bareOne])] })));
      expect(stopped).toMatchObject({ status: 500, error: "A post of @hexmethod could not be saved (the read failed): nothing was skipped. Press Play again." });
      expect(await parked()).toMatchObject([{ kind: "video", videos: [VIDEO] }]);
      expect(await rows(`select 1 from public.hunter_posts`)).toEqual([]);
    });

    it("counts a video in the author's reply, says which reply holds it, and takes a reply's picture as the post's", async () => {
      await add();
      const inReply = sf(NOW - 30 * DAY, 3), pictured = sf(NOW - 30 * DAY, 2);
      const reply = (to: string, n: number, over: Partial<XPost>) => post(sf(NOW - 30 * DAY, n), "the steps, in my words", { replyingTo: to, ...over });
      const clip = reply(inReply, 7, { photos: [], videos: 1, videoData: [VIDEO] });
      const shot = reply(pictured, 8, { photos: [{ url: "https://pbs.twimg.com/media/shot.jpg", alt: null }] });
      const got = await playCreator(supabase, "hexmethod", undefined, deps(free({
        pages: [page([post(inReply, `Prompt: ${P_TEXT}`, { photos: [] }), post(pictured, `Prompt: ${P_REPLY}`, { photos: [], videos: 1, videoData: [VIDEO] })])],
        replies: { [inReply]: [clip], [pictured]: [shot] },
      })));
      expect(got.status === 200 && got.summary).toMatchObject({ found: 1, skipped: { video_only: 1 }, usage: { videos: 2 } });
      expect((await parked()).map((r) => [r.post_id, r.why, r.videos])).toEqual([
        [pictured, "beside pictures", [VIDEO]],
        [inReply, "no picture", [{ ...VIDEO, reply_id: clip.id }]],
      ]);
      const [sub] = await rows<{ preview: { photos: string[] } }>(`select preview from public.hunt_submissions`);
      expect(sub.preview.photos).toEqual(["https://pbs.twimg.com/media/shot.jpg"]);
    });

    it("keeps the video of a post already in Enki, and saves a post read again once", async () => {
      await add();
      const id = sf(NOW - 30 * DAY, 1);
      await db.query(`insert into public.hunt_submissions (hunter_user_id, normalized_source_url) values ($1, $2)`, [ADMIN, `x.com/status/${id}`]);
      const one = post(id, `Prompt: ${P_TEXT}`, { videos: 1, videoData: [VIDEO] });
      const got = await playCreator(supabase, "hexmethod", undefined, deps(free({ pages: [page([one])] })));
      expect(got.status === 200 && got.summary).toMatchObject({ skipped: { duplicate: 1 } });
      clock.t += 1000;
      await db.exec(`update public.hunter_posts set outcome = 'retry'; update public.hunter_accounts set newest_id = null, oldest_id = null, exhausted = false`);
      await playCreator(supabase, "hexmethod", undefined, deps(free({ pages: [page([{ ...one, text: "edited" }])] })));
      const again = await parked();
      expect(again).toMatchObject([{ post_id: id, post_text: "edited" }]);
      expect(new Date(again[0].read_at as string).getTime()).toBe(clock.t);
    });

    it("on a billed reader asks no reply read for a video, as ever", async () => {
      await add();
      const x = fakeX({ pages: [page([post(sf(NOW - 30 * DAY, 1), `Prompt: ${P_TEXT}`, { videos: 1, photos: [] })])] });
      await playCreator(supabase, "hexmethod", undefined, deps(x));
      expect(x.replies).not.toHaveBeenCalled();
      expect(await parked()).toMatchObject([{ kind: "video", replies: [] }]);
    });

    it("stops the round before a post whose save failed: neither recorded nor passed, read again by the next Play, the sentence naming the SQL", async () => {
      await add();
      const first = sf(NOW - 30 * DAY, 3), video = sf(NOW - 30 * DAY, 2), last = sf(NOW - 30 * DAY, 1);
      const posts = [post(first, `Prompt: ${P_TEXT}`), post(video, "a clip", { videos: 1, videoData: [VIDEO], photos: [] }), post(last, `Prompt: ${P_REPLY}`)];
      await db.exec(`alter table public.hunter_parked rename to hunter_parked_gone`);
      try {
        const got = await playCreator(supabase, "hexmethod", undefined, deps(free({ pages: [page(posts)] })));
        expect(got).toMatchObject({ status: 500, error: "A post of @hexmethod could not be saved: its table needs SQL 64 (sql-to-run/64-hunter-parked.sql). Nothing was skipped: run it, then press Play again." });
        expect(await rows(`select post_id from public.hunter_posts`)).toEqual([{ post_id: first }]);
        expect((await creator()).oldest_id).toBe(first);
        // Nothing was saved: the log says no video saved beside its error.
        expect(got.status === 500 && got.summary?.usage.videos).toBe(0);
        expect(await rows(`select usage->'videos' as videos from public.hunter_runs`)).toEqual([{ videos: 0 }]);
      } finally {
        await db.exec(`alter table public.hunter_parked_gone rename to hunter_parked`);
      }
      // Another refusal says what it was, and stops the same way.
      await db.exec(`alter table public.hunter_parked add constraint refuse check (post_id = 'none') not valid`);
      try {
        const again = await playCreator(supabase, "hexmethod", undefined, deps(free({ pages: [page(posts.slice(1))] })));
        expect(again).toMatchObject({ status: 500, error: expect.stringMatching(/^A post of @hexmethod could not be saved \(.*refuse.*\): nothing was skipped\. Press Play again\.$/) });
      } finally {
        await db.exec(`alter table public.hunter_parked drop constraint refuse`);
      }
      const read = await playCreator(supabase, "hexmethod", undefined, deps(free({ pages: [page(posts.slice(1))] })));
      expect(read.status === 200 && read.summary).toMatchObject({ found: 1, skipped: { video_only: 1 } });
      expect((await parked()).map((r) => r.post_id)).toEqual([video]);
      expect(await rows(`select post_id, outcome from public.hunter_posts order by post_id desc`)).toEqual([{ post_id: first, outcome: "queued" }, { post_id: video, outcome: "video_only" }, { post_id: last, outcome: "queued" }]);
    });

    it("runs twice, and the table holds no one but the service role", async () => {
      // Whatever stood before it: a second run closes the table again.
      await db.exec(`grant all on public.hunter_parked to anon, authenticated; alter table public.hunter_parked disable row level security`);
      await db.exec(migration("2026-11-03-hunter-parked.sql"));
      expect((await rows<{ grantee: string }>(`select grantee from information_schema.role_table_grants where table_name = 'hunter_parked' and grantee in ('anon', 'authenticated')`))).toEqual([]);
      expect(await rows(`select relrowsecurity from pg_class where relname = 'hunter_parked'`)).toEqual([{ relrowsecurity: true }]);
      // Granted by name, with no default to lean on: the service role reads and writes as the Play does, as itself.
      await db.exec(`set role service_role`);
      try {
        await db.query(`insert into public.hunter_parked (post_id, kind, handle, url) values ('r', 'video', 'hexmethod', 'u') on conflict (post_id) do update set why = 'again'`);
        await db.query(`insert into public.hunter_parked (post_id, kind, handle, url) values ('r', 'video', 'hexmethod', 'u') on conflict (post_id) do update set why = 'again'`);
        expect((await db.query(`select why from public.hunter_parked where post_id = 'r'`)).rows).toEqual([{ why: "again" }]);
        await expect(db.query(`delete from public.hunter_parked where post_id = 'r'`)).rejects.toThrow(/permission denied/);
      } finally {
        await db.exec(`reset role`);
        await db.exec(`delete from public.hunter_parked where post_id = 'r'`);
      }
      await expect(db.query(`insert into public.hunter_parked (post_id, kind, handle, url) values ('1', 'other', 'a', 'u')`)).rejects.toThrow(/check/);
      // Removing a creator leaves what was saved.
      await add();
      await db.query(`insert into public.hunter_parked (post_id, kind, handle, url) values ('1', 'video', 'hexmethod', 'u')`);
      await db.exec(`delete from public.hunter_accounts where handle = 'hexmethod'`);
      expect(await parked()).toMatchObject([{ post_id: "1" }]);
    });

    it("saves a forward's video-only core under that core's author, in the same round or a listed creator's", async () => {
      await add();
      const F = sf(NOW - 5 * DAY, 9), OWN = sf(NOW - 5 * DAY, 2), CORE = sf(NOW - 6 * DAY, 1);
      const status = (id: string, who: { id: string; screen: string }, videos: unknown[]) => ({ status: { id, url: `https://x.com/${who.screen}/status/${id}`, text: `Prompt: ${P_TEXT}`, likes: 1, reposts: 0, quotes: 0,
        author: { id: who.id, name: who.screen, screen_name: who.screen }, media: { photos: [], videos }, replying_to: null, quote: null } });
      const HEX = { id: XID, screen: "HexMethod" }, VOX = { id: "2000000000000000002", screen: "VoxxiVicious" };
      const fwd = (quote: string) => ({ status: { id: F, url: `https://x.com/HexMethod/status/${F}`, text: "Love this one, go try it!", likes: 1, reposts: 0, quotes: 0, author: { id: XID, name: "Hex", screen_name: "HexMethod" },
        media: { photos: [{ url: "https://pbs.twimg.com/media/f.jpg" }] }, replying_to: null, quote: { id: quote } } });
      const reads = (pages: Record<string, unknown>) => (async (url: string) => {
        const path = String(url).replace("https://api.fxtwitter.com/2", "");
        if (path in pages) return { ok: true, status: 200, json: async () => pages[path] };
        return path.startsWith("/conversation/") ? { ok: true, status: 200, json: async () => ({ replies: [] }) } : { ok: false, status: 404, json: async () => ({}) };
      }) as unknown as typeof fetch;
      const quoting = (id: string) => post(F, "Love this one, go try it!", { quoteId: id });
      // The creator's own earlier post.
      await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page([quoting(OWN)])] }), { fxFetch: reads({ [`/status/${F}`]: fwd(OWN), [`/status/${OWN}`]: status(OWN, HEX, [VIDEO]) }) }));
      expect(await parked()).toMatchObject([{ post_id: OWN, handle: "hexmethod", author_id: XID, kind: "video", videos: [VIDEO] }]);
      // A core by a creator on the list. Someone not on it is never given anything (DEC-2026-11-03-14).
      await db.exec(`truncate public.hunter_posts, public.hunter_parked cascade; update public.hunter_accounts set newest_id = null, oldest_id = null, exhausted = false;
        insert into public.hunter_accounts (handle, x_user_id, added_by) values ('voxxivicious', '${VOX.id}', '${ADMIN}')`);
      const onList = await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page([quoting(CORE)])] }), { fxFetch: reads({ [`/status/${F}`]: fwd(CORE), [`/status/${CORE}`]: status(CORE, VOX, [VIDEO]) }) }));
      expect(onList.status).toBe(200);
      expect(await parked()).toMatchObject([{ post_id: CORE, handle: "voxxivicious", author_id: VOX.id, videos: [VIDEO] }]);
      await db.exec(`truncate public.hunter_posts, public.hunter_parked cascade; delete from public.hunter_accounts where handle = 'voxxivicious'; update public.hunter_accounts set newest_id = null, oldest_id = null, exhausted = false`);
      await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page([quoting(CORE)])] }), { fxFetch: reads({ [`/status/${F}`]: fwd(CORE), [`/status/${CORE}`]: status(CORE, VOX, [VIDEO]) }) }));
      expect(await parked()).toEqual([]);
    });
  });

  describe("a prompt always has media (Kev, 2026-11-03: \"ein prompt ohne media soll separat geloggt sein in nem reiter\")", () => {
    const free = (o: Parameters<typeof fakeX>[0]) => ({ ...fakeX(o), free: true });
    const parked = () => rows<Record<string, unknown>>(`select * from public.hunter_parked order by post_id`);
    const bare = (n: number, text: string, over: Partial<XPost> = {}) => post(sf(NOW - 30 * DAY, n), text, { photos: [], ...over });
    const NO_MEDIA = "no picture or video on the post or in the author's replies";
    const distill = vi.fn(async () => ({ ok: false as const, why: "distill_failed" as const }));
    const plain = (plan: ImportPlan, link: { url: string; normalized: string }, userId: string, title: string) => plainImport(supabase, { plan, link, userId, title, fetchFn: pics });
    beforeEach(() => { distill.mockClear(); });

    it("in auto, parks a sure or an unsure prompt before any model call and any check, keeps noise as no_prompt, and leaves the dry streak", async () => {
      await add({ dryAfter: 2 });
      const sure = bare(5, `Prompt: ${P_TEXT}`), unsure = bare(4, P_MODEL), noise = bare(3, "gm"), sure2 = bare(2, `Prompt: ${P_REPLY}`), noise2 = bare(1, "gn");
      const got = await playCreator(supabase, "hexmethod", undefined, deps(free({ pages: [page([noise, sure, unsure, sure2, noise2])] }), { distill }));
      expect(got.status === 200 && got.summary).toMatchObject({ found: 0, stopped: "dry", skipped: { no_media: 3, no_prompt: 2 } });
      expect(distill).not.toHaveBeenCalled();
      expect(judge).not.toHaveBeenCalled();
      expect(await rows(`select 1 from public.hunt_submissions`)).toEqual([]);
      expect((await parked()).map((r) => [r.post_id, r.kind, r.why, r.post_text])).toEqual([[sure2.id, "no_media", NO_MEDIA, sure2.text], [unsure.id, "no_media", NO_MEDIA, P_MODEL], [sure.id, "no_media", NO_MEDIA, sure.text]].sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
      expect(await rows(`select post_id, outcome from public.hunter_posts where outcome = 'no_media' order by post_id`)).toHaveLength(3);
    });

    it("counts a reply's picture as media in every mode, and parks what has none", async () => {
      for (const mode of ["auto", "manual", "recipe"] as const) {
        await db.exec(`truncate public.hunter_accounts, public.hunter_posts, public.hunt_submissions, public.hunter_parked cascade`);
        await add();
        expect(await saveMode(supabase, { handle: "hexmethod", mode, recipe: mode === "recipe" ? { from: "text", after: "", before: "", titleLine: 0 } : {} })).toEqual({ ok: true });
        const main = bare(2, `Prompt: ${P_TEXT}`), lone = bare(1, `Prompt: ${P_REPLY}`);
        const shot = post(sf(NOW - 30 * DAY, 7), "how it looks here, in my own words", { replyingTo: main.id, photos: [{ url: "https://pbs.twimg.com/media/shot.jpg", alt: null }] });
        const got = await playCreator(supabase, "hexmethod", undefined, deps(free({ pages: [page([main, lone])], replies: { [main.id]: [shot] } }), { plain }));
        expect(got.status === 200 && got.summary, mode).toMatchObject({ found: 1, skipped: { no_media: 1 } });
        const [find] = await rows<{ normalized_source_url: string; preview: { photos: string[] } }>(`select normalized_source_url, preview from public.hunt_submissions`);
        expect([find.normalized_source_url, find.preview.photos], mode).toEqual([`x.com/status/${main.id}`, ["https://pbs.twimg.com/media/shot.jpg"]]);
        expect((await parked()).map((r) => r.post_id), mode).toEqual([lone.id]);
      }
    });

    it("in manual, chatter of 40 or more characters with no media lands in the tab, a short one stays noise; with a picture it stays a find", async () => {
      await add();
      expect(await saveMode(supabase, { handle: "hexmethod", mode: "manual", recipe: {} })).toEqual({ ok: true });
      const chatter = "What a beautiful morning it was on my walk through town today";
      const a = bare(3, chatter), b = bare(2, "gm"), c = post(sf(NOW - 30 * DAY, 1), chatter);
      const got = await playCreator(supabase, "hexmethod", undefined, deps(free({ pages: [page([a, b, c])] }), { plain }));
      expect(got.status === 200 && got.summary).toMatchObject({ found: 1, skipped: { no_media: 1, no_prompt: 1 } });
      expect((await parked()).map((r) => r.post_id)).toEqual([a.id]);
      expect(await rows(`select normalized_source_url from public.hunt_submissions`)).toEqual([{ normalized_source_url: `x.com/status/${c.id}` }]);
    });

    it("a reply shared under every post is no duplicate in manual mode: the post's own words are cut, and only the same words are one", async () => {
      await add();
      expect(await saveMode(supabase, { handle: "hexmethod", mode: "manual", recipe: {} })).toEqual({ ok: true });
      const PROMO = "I built a free tool that turns any photo into this exact look, try it here: https://t.co/abc";
      const body = (n: number) => `New drop ${n}\n\nA ceramic vase number ${n} on a plain table, soft north light, 85mm lens`;
      const ids = [3, 2, 1].map((n) => sf(NOW - 30 * DAY, n));
      const posts = [post(ids[0], body(1)), post(ids[1], body(2)), post(ids[2], body(2))];
      const promo = (id: string) => [post(sf(NOW - 30 * DAY, 10 + Number(BigInt(id) % BigInt(9))), PROMO, { photos: [], replyingTo: id })];
      const got = await playCreator(supabase, "hexmethod", undefined, deps(free({ pages: [page(posts)], replies: Object.fromEntries(ids.map((id) => [id, promo(id)])) }), { plain }));
      expect(got.status === 200 && got.summary).toMatchObject({ queued: 2, skipped: { duplicate: 1 } });
      const finds = await rows<{ normalized_source_url: string; prompt_hash: string; preview: { prompt: string; hunt: HuntFacts } }>(`select normalized_source_url, prompt_hash, preview from public.hunt_submissions order by normalized_source_url desc`);
      expect(finds.map((f) => f.preview.prompt)).toEqual([PROMO, "A ceramic vase number 2 on a plain table, soft north light, 85mm lens"]);
      expect(finds[1].preview.hunt).toMatchObject({ from: "text", how: "manual", replyUrl: null });
      expect(finds[0].prompt_hash).not.toBe(finds[1].prompt_hash);
      // The third post, the second's own words under the same reply: that is a duplicate.
      expect(await rows(`select post_id, outcome from public.hunter_posts order by post_id desc`)).toEqual([{ post_id: ids[0], outcome: "queued" }, { post_id: ids[1], outcome: "queued" }, { post_id: ids[2], outcome: "duplicate" }]);
    });

    it("a recipe's cut stays a duplicate by its own words: what the creator's recipe names is the prompt", async () => {
      await add();
      expect(await saveMode(supabase, { handle: "hexmethod", mode: "recipe", recipe: { from: "reply", after: "", before: "", titleLine: 0 } })).toEqual({ ok: true });
      const ids = [2, 1].map((n) => sf(NOW - 30 * DAY, n));
      const reply = (id: string) => [post(sf(NOW - 30 * DAY, 20 + Number(BigInt(id) % BigInt(9))), P_REPLY, { photos: [], replyingTo: id })];
      const got = await playCreator(supabase, "hexmethod", undefined, deps(free({ pages: [page(ids.map((id, i) => post(id, `New drop ${i}\n\n${P_TEXT} ${i}`)))], replies: Object.fromEntries(ids.map((id) => [id, reply(id)])) }), { plain }));
      expect(got.status === 200 && got.summary).toMatchObject({ queued: 1, skipped: { duplicate: 1 } });
    });

    it("parks a find whose pictures could not be read, in the plain modes and in auto, publish-at-once included, keeping a video's row a video's", async () => {
      await add();
      await db.exec(`update public.hunter_config set mode = 'publish'`);
      const empty = async (plan: ImportPlan, link: { url: string; normalized: string }, userId: string): Promise<Judged> => {
        const preview: ImportPreview = { v: 1, userId, exp: 0, source: { url: plan.source.url, normalized: link.normalized, handle: plan.source.handle, authorId: plan.source.authorId }, prompt: plan.prompt, generators: plan.generators, photos: [], title: "A find", category: "Characters", tags: [], adult: false };
        return { ok: true, preview, shown: shownOf(preview) };
      };
      const VIDEO = { id: "v", url: "https://video.twimg.com/v.mp4" };
      const one = post(sf(NOW - 30 * DAY, 2), `Prompt: ${P_TEXT}`), both = post(sf(NOW - 30 * DAY, 1), `Prompt: ${P_REPLY}`, { videos: 1, videoData: [VIDEO] });
      const d = deps(free({ pages: [page([one, both])] }), { judge: empty });
      const got = await playCreator(supabase, "hexmethod", undefined, d);
      expect(got.status === 200 && got.summary).toMatchObject({ found: 0, published: 0, skipped: { pictures_failed: 2 } });
      expect(d.publish).not.toHaveBeenCalled();
      expect(await rows(`select 1 from public.hunt_submissions`)).toEqual([]);
      expect((await parked()).map((r) => [r.post_id, r.kind, r.why, r.photos])).toEqual([
        [both.id, "video", "beside pictures", [both.photos[0].url]],
        [one.id, "no_media", "its pictures could not be read", [one.photos[0].url]],
      ]);
      // The real import in manual mode, every download failing.
      await db.exec(`truncate public.hunter_parked, public.hunter_posts cascade; update public.hunter_accounts set newest_id = null, oldest_id = null, exhausted = false`);
      expect(await saveMode(supabase, { handle: "hexmethod", mode: "manual", recipe: {} })).toEqual({ ok: true });
      const down = (async () => new Response("", { status: 500 })) as unknown as typeof fetch;
      const real = await playCreator(supabase, "hexmethod", undefined, deps(free({ pages: [page([one])] }), { plain: (plan, link, userId, title) => plainImport(supabase, { plan, link, userId, title, fetchFn: down }) }));
      expect(real.status === 200 && real.summary).toMatchObject({ found: 0, skipped: { pictures_failed: 1 } });
      expect(await rows(`select 1 from public.hunt_submissions`)).toEqual([]);
      expect((await parked()).map((r) => r.why)).toEqual(["its pictures could not be read"]);
    });

    it("a post whose pictures failed comes back on Start over and gets its find, the post with a video too, its video still saved", async () => {
      await add();
      expect(await saveMode(supabase, { handle: "hexmethod", mode: "manual", recipe: {} })).toEqual({ ok: true });
      const VIDEO = { id: "v", url: "https://video.twimg.com/v.mp4" };
      const one = post(sf(NOW - 30 * DAY, 2), `Prompt: ${P_TEXT}`), both = post(sf(NOW - 30 * DAY, 1), `Prompt: ${P_REPLY}`, { videos: 1, videoData: [VIDEO] });
      const withPictures = (f: typeof fetch) => ({ plain: (plan: ImportPlan, link: { url: string; normalized: string }, userId: string, title: string) => plainImport(supabase, { plan, link, userId, title, fetchFn: f }) });
      const down = (async () => new Response("", { status: 500 })) as unknown as typeof fetch;
      const failed = await playCreator(supabase, "hexmethod", undefined, deps(free({ pages: [page([one, both])] }), withPictures(down)));
      expect(failed.status === 200 && failed.summary).toMatchObject({ found: 0, skipped: { pictures_failed: 2 } });
      expect((await rows<{ dry_streak: number }>(`select dry_streak from public.hunter_accounts`))[0].dry_streak).toBe(0);
      const seen = await playCreator(supabase, "hexmethod", undefined, deps(free({ pages: [page([one, both])] }), withPictures(pics)));
      expect(seen.status === 200 && seen.summary).toMatchObject({ found: 0, skipped: { seen: 2 } });
      expect(await restartCreator(supabase, "hexmethod", NOW)).toEqual({ ok: true });
      const again = await playCreator(supabase, "hexmethod", undefined, deps(free({ pages: [page([one, both])] }), withPictures(pics)));
      expect(again.status === 200 && again.summary).toMatchObject({ found: 2, queued: 2 });
      expect((await parked()).map((r) => [r.post_id, r.kind])).toEqual([[both.id, "video"], [one.id, "no_media"]]);
    });

    it("publish-at-once does not bypass it", async () => {
      await add();
      await db.exec(`update public.hunter_config set mode = 'publish'`);
      const d = deps(free({ pages: [page([bare(1, `Prompt: ${P_TEXT}`)])] }));
      const got = await playCreator(supabase, "hexmethod", undefined, d);
      expect(got.status === 200 && got.summary).toMatchObject({ published: 0, skipped: { no_media: 1 } });
      expect(d.publish).not.toHaveBeenCalled();
    });

    it("stops the round on a failed save, naming the SQL, and on a billed reader parks by what it can see", async () => {
      await add();
      const one = bare(2, `Prompt: ${P_TEXT}`), next = post(sf(NOW - 30 * DAY, 1), `Prompt: ${P_REPLY}`);
      await db.exec(`alter table public.hunter_parked rename to hunter_parked_gone`);
      try {
        const got = await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page([one, next])] })));
        expect(got).toMatchObject({ status: 500, error: expect.stringContaining("SQL 64 (sql-to-run/64-hunter-parked.sql)") });
        expect(await rows(`select 1 from public.hunter_posts`)).toEqual([]);
        expect(await rows(`select 1 from public.hunt_submissions`)).toEqual([]);
      } finally {
        await db.exec(`alter table public.hunter_parked_gone rename to hunter_parked`);
      }
      const x = fakeX({ pages: [page([one])] });
      const again = await playCreator(supabase, "hexmethod", undefined, deps(x));
      expect(again.status === 200 && again.summary).toMatchObject({ skipped: { no_media: 1 } });
      expect(x.replies).not.toHaveBeenCalled();
    });

    describe("a forward", () => {
      const VOX = { id: "2000000000000000002", screen: "VoxxiVicious" };
      const F = sf(NOW - 5 * DAY, 9), CORE = sf(NOW - 6 * DAY, 1);
      const status = (id: string, text: string, who: { id: string; screen: string }, o: { photos?: string[]; quote?: string }) => ({ status: { id, url: `https://x.com/${who.screen}/status/${id}`, text, likes: 1, reposts: 0, quotes: 0,
        author: { id: who.id, name: who.screen, screen_name: who.screen }, media: { photos: (o.photos ?? []).map((url) => ({ url })) }, replying_to: null, quote: o.quote ? { id: o.quote } : null } });
      const reads = (pages: Record<string, unknown>) => (async (url: string) => {
        const path = String(url).replace("https://api.fxtwitter.com/2", "");
        if (path in pages) return { ok: true, status: 200, json: async () => pages[path] };
        return path.startsWith("/conversation/") ? { ok: true, status: 200, json: async () => ({ replies: [] }) } : { ok: false, status: 404, json: async () => ({}) };
      }) as unknown as typeof fetch;
      const HEX_ = { id: XID, screen: "HexMethod" };
      const listed = async () => {
        await add();
        await db.query(`insert into public.hunter_accounts (handle, x_user_id, added_by) values ('voxxivicious', $1, $2)`, [VOX.id, ADMIN]);
      };

      // Kev, 2026-11-03: the forward's picture counts when the core has none (lib/hunter/fx-api pictured).
      for (const mode of ["auto", "manual"] as const) it(`whose core has no media takes the forward's picture, in ${mode}`, async () => {
        await listed();
        if (mode === "manual") {
          expect(await saveMode(supabase, { handle: "hexmethod", mode: "manual", recipe: {} })).toEqual({ ok: true });
        }
        const pic = "https://pbs.twimg.com/media/fwd.jpg";
        const got = await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page([post(F, "Love this one, go try it!", { quoteId: CORE, photos: [{ url: pic, alt: null }] })])] }), {
          plain, fxFetch: reads({ [`/status/${F}`]: status(F, "Love this one, go try it!", HEX_, { photos: [pic], quote: CORE }), [`/status/${CORE}`]: status(CORE, `Prompt: ${P_TEXT}`, VOX, {}) }),
        }));
        expect(got.status === 200 && got.summary.skipped).toEqual({ forwarded: 1 });
        const [find] = await rows<{ source_author_handle: string; preview: { photos: string[] } }>(`select source_author_handle, preview from public.hunt_submissions`);
        expect(find).toMatchObject({ source_author_handle: "voxxivicious", preview: { photos: [pic] } });
        expect(await parked()).toEqual([]);
      });

      it("with no media anywhere parks the core under its author, and the forward reads as its own", async () => {
        await listed();
        const got = await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page([post(F, "Love this one, go try it!", { quoteId: CORE, photos: [] })])] }), {
          fxFetch: reads({ [`/status/${F}`]: status(F, "Love this one, go try it!", HEX_, { quote: CORE }), [`/status/${CORE}`]: status(CORE, `Prompt: ${P_TEXT}`, VOX, {}) }),
        }));
        expect(got.status === 200 && got.summary.skipped).toEqual({ no_prompt: 1 });
        expect(await parked()).toMatchObject([{ post_id: CORE, handle: "voxxivicious", author_id: VOX.id, kind: "no_media" }]);
        expect(await rows(`select 1 from public.hunt_submissions`)).toEqual([]);
      });

      it("in auto, words of its own and no media follow the forward first, with no model; where it gives none they are parked", async () => {
        await listed();
        const WORDS = "What a beautiful morning it was on my walk through town today";
        const pic = "https://pbs.twimg.com/media/core.jpg";
        const quoting = post(F, WORDS, { quoteId: CORE, photos: [] });
        const asked = deps(fakeX({ pages: [page([quoting])] }), { distill, fxFetch: reads({ [`/status/${F}`]: status(F, WORDS, HEX_, { quote: CORE }), [`/status/${CORE}`]: status(CORE, `Prompt: ${P_TEXT}`, VOX, { photos: [pic] }) }) });
        const got = await playCreator(supabase, "hexmethod", undefined, asked);
        expect(got.status === 200 && got.summary.skipped).toEqual({ forwarded: 1 });
        expect(distill).not.toHaveBeenCalled();
        expect(await parked()).toEqual([]);
        await db.exec(`truncate public.hunt_submissions, public.hunter_posts cascade; update public.hunter_accounts set newest_id = null, oldest_id = null, exhausted = false`);
        const none = await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page([quoting])] }), { distill, fxFetch: reads({ [`/status/${F}`]: status(F, WORDS, HEX_, { quote: CORE }), [`/status/${CORE}`]: status(CORE, "gm", VOX, { photos: [pic] }) }) }));
        expect(none.status === 200 && none.summary.skipped).toEqual({ no_media: 1 });
        expect(distill).not.toHaveBeenCalled();
        expect(await parked()).toMatchObject([{ post_id: F, kind: "no_media" }]);
      });
    });
  });

  it("stops on X's refusal, says it on the creator's row, releases the hold, and asks again with no retry", async () => {
    await add();
    const x = fakeX({ pages: [new Error("X rate limit: press Play again in a minute")] });
    const got = await playCreator(supabase, "hexmethod", undefined, deps(x));
    expect(got).toMatchObject({ status: 500, error: "X rate limit: press Play again in a minute", summary: { stopped: "error", more: false } });
    expect(x.search).toHaveBeenCalledTimes(1);
    expect(await creator()).toMatchObject({ error: "X rate limit: press Play again in a minute", playing_since: null });
    await add({}, "ghost");
    const gone = await playCreator(supabase, "ghost", undefined, deps(fakeX({ user: null })));
    expect(gone).toMatchObject({ status: 404, error: "No such account on X", summary: { stopped: "error", usage: { users: 1 } } });
    expect((await rows(`select error, playing_since from public.hunter_accounts where handle = 'ghost'`))[0]).toEqual({ error: "No such account on X", playing_since: null });
    const listed = (await loadCreators(supabase, NOW)).creators;
    expect(listed.map((c) => [c.handle, c.runs.length, c.runs[0].stopped])).toEqual([["hexmethod", 1, "error"], ["ghost", 1, "error"]]);
  });

  it("waits a second between full-archive requests", async () => {
    await add({ dryAfter: 0 });
    const d = deps(fakeX({ pages: [page(filler(0, 10), "more"), page(filler(10, 10))] }));
    await playCreator(supabase, "hexmethod", undefined, d);
    expect(d.sleep).toHaveBeenCalledTimes(1);
    expect(d.sleep.mock.calls[0][0]).toBe(ARCHIVE_GAP_MS);
  });

  it("sends what the creator's renders earn to the X author's vault, and to the author's wallet once they claim by connecting that X account", async () => {
    await add();
    await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page([post(sf(NOW - 30 * DAY), `Prompt: ${P_TEXT}`)])] })));
    const [me] = await rows<{ id: string }>(`select id from public.users where origin = 'imported'`);
    // Approved and published as the route does it: the queue's own row, under the creator's account.
    const PROMPT_ID = "00000000-0000-4000-8000-0000000000bb";
    await db.exec(`update public.hunt_submissions set status = 'approved', minted_prompt_id = '${PROMPT_ID}' where hunter_user_id = '${me.id}'`);
    expect((await loadCreators(supabase, NOW)).creators[0].pending).toBe(0);
    const vault = authorVaultOwner(PROGRAM, XID).toBase58();
    // No referrer leg (the creator's account has no wallet: Enki holds nothing), the author's share into the vault.
    expect(await sharesOf(supabase, PROMPT_ID, PROGRAM)).toEqual({ referrerWallet: null, author: { kind: "vault", owner: vault }, claimed: false });
    const AUTHOR = "00000000-0000-4000-8000-0000000000cc";
    const WALLET = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
    await db.exec(`insert into public.users (id, handle, origin) values ('${AUTHOR}', 'thereal', 'x');
      insert into public.auth_identities values ('x', '${XID}', '${AUTHOR}', 'TheReal');
      insert into public.user_wallets values ('${AUTHOR}', 'solana', '${WALLET}', null);`);
    expect(await claimAuthorShares(supabase, AUTHOR)).toEqual({ claimed: 1 });
    expect(await sharesOf(supabase, PROMPT_ID, PROGRAM)).toEqual({ referrerWallet: null, author: { kind: "wallet", owner: WALLET }, claimed: true });
  });

  // Kev's point, 2026-11-02: Play read a forward alone, while "Add link manually" followed it to the post where the prompt is.
  describe("a post that only forwards another", () => {
    const VOX = { id: "88", screen: "VoxxiVicious" };
    const HEX_FX = { id: XID, screen: "HexMethod" };
    const F = sf(NOW - 3 * DAY, 1), F2 = sf(NOW - 3 * DAY, 2), HOP = sf(NOW - 4 * DAY, 1), CORE = sf(NOW - 5 * DAY, 1), MINE = sf(NOW - 2 * DAY, 1);
    const FORWARD = "Love this one, go try it!";
    const NO_FIND = "Just a nice picture I saw this morning on my walk through town, no words on how it was made.";
    const fxPost = (id: string, text: string, who: { id: string; screen: string } = VOX, o: { quote?: string; counts?: [number, number, number]; to?: string; noPhoto?: boolean } = {}) => ({ status: {
      id, url: `https://x.com/${who.screen}/status/${id}`, text, likes: o.counts?.[0] ?? 1, reposts: o.counts?.[1] ?? 0, quotes: o.counts?.[2] ?? 0,
      author: { id: who.id, name: who.screen, screen_name: who.screen }, media: { photos: o.noPhoto ? [] : [{ url: `https://pbs.twimg.com/media/${id}.jpg` }] }, replying_to: o.to ? { status: o.to } : null, quote: o.quote ? { id: o.quote } : null,
    } });
    /** FxTwitter, as a fetch: a status not in `pages` fails at once (a failed read, no retry's pause); a conversation not in it has no replies; 404: deleted. */
    const fx = (pages: Record<string, unknown>, onAsk: (path: string) => void | Promise<void> = () => {}) => {
      const asked: string[] = [];
      const fetchFn = (async (url: string) => {
        const path = String(url).replace("https://api.fxtwitter.com/2", "");
        asked.push(path);
        await onAsk(path);
        if (pages[path] === 404) return { ok: false, status: 404, json: async () => ({}) };
        if (path in pages) return { ok: true, status: 200, json: async () => pages[path] };
        if (path.startsWith("/conversation/")) return { ok: true, status: 200, json: async () => ({ replies: [] }) };
        throw new Error("FxTwitter is down");
      }) as unknown as typeof fetch;
      return { fetchFn, asked };
    };
    const forwardPages = (): Record<string, unknown> => ({
      [`/status/${F}`]: fxPost(F, FORWARD, HEX_FX, { quote: CORE, counts: [18, 2, 2] }),
      [`/status/${CORE}`]: fxPost(CORE, `Prompt: ${P_TEXT}`, VOX, { counts: [120, 30, 9] }),
    });
    const forwardPost = (id = F) => post(id, FORWARD, { quoteId: CORE });
    const outcomes = () => rows<{ post_id: string; handle: string; outcome: string }>(`select post_id, handle, outcome from public.hunter_posts order by post_id`);
    const finds = () => rows<{ normalized_source_url: string; source_author_handle: string }>(`select normalized_source_url, source_author_handle from public.hunt_submissions order by normalized_source_url`);
    const knownSubmission = (id: string) => db.query(`insert into public.hunt_submissions (hunter_user_id, source_platform, normalized_source_url, status) values ('00000000-0000-4000-8000-0000000000bb', 'x', $1, 'pending')`, [`x.com/status/${id}`]);

    it("follows it to its core under the paid reader, free: the core's author owns the find, with the chain's reach, queued, and nothing billed or modelled for the forward", async () => {
      await add();
      await add({}, "VoxxiVicious");
      await db.exec(`update public.hunter_config set mode = 'publish'`);
      const { fetchFn, asked } = fx(forwardPages());
      const x = fakeX({ pages: [page([forwardPost()])] });
      const d = deps(x, { fxFetch: fetchFn });
      const got = await playCreator(supabase, "hexmethod", undefined, d);
      expect(got.status === 200 && got.summary).toMatchObject({ found: 0, queued: 0, published: 0, skipped: { forwarded: 1 }, stopped: "done", usage: { posts: 1, replies: 0, distills: 0, checks: 0 } });
      // The core's own replies too: free, and what a video there would need.
      expect(asked).toEqual([`/status/${F}`, `/status/${CORE}`, `/conversation/${CORE}`]);
      expect(x.replies).not.toHaveBeenCalled();
      expect(x.search).toHaveBeenCalledTimes(1);
      expect(model.calls).toBe(0);
      expect(judge).toHaveBeenCalledTimes(1);
      expect(d.publish).not.toHaveBeenCalled();

      const [sub] = await rows<{ normalized_source_url: string; source_author_id: string; source_author_handle: string; status: string; hunter_user_id: string; preview: { prompt: string; hunt: HuntFacts } }>(`select normalized_source_url, source_author_id, source_author_handle, status, hunter_user_id, preview from public.hunt_submissions`);
      expect(sub).toMatchObject({ normalized_source_url: `x.com/status/${CORE}`, source_author_id: "88", source_author_handle: "voxxivicious", status: "pending" });
      expect(sub.preview.prompt).toBe(P_TEXT);
      expect(sub.preview.hunt.reach).toEqual({ core: { likes: 120, reposts: 30, quotes: 9 }, chain: { posts: 2, likes: 138, reposts: 32, quotes: 11 } });
      expect(sub.preview.hunt.creator).toEqual({ handle: "voxxivicious", xUserId: "88" });
      // Their Enki account holds it, not the forwarding creator's.
      expect((await rows<{ id: string }>(`select id from public.users where imported_x_id = '88'`))[0].id).toBe(sub.hunter_user_id);
      expect(await outcomes()).toEqual([{ post_id: CORE, handle: "voxxivicious", outcome: "queued" }, { post_id: F, handle: "hexmethod", outcome: "forwarded" }]);
      // Its find on its count, its own Plays' cursors untouched, its row as a person listed it.
      expect((await rows(`select handle, added_by, found, newest_id, oldest_id, exhausted, playing_since from public.hunter_accounts where handle = 'voxxivicious'`))[0])
        .toEqual({ handle: "voxxivicious", added_by: ADMIN, found: 1, newest_id: null, oldest_id: null, exhausted: false, playing_since: null });
      expect(await creator()).toMatchObject({ found: 0, oldest_id: F, playing_since: null, error: null });
    });

    it("follows a link in the text through a hop, reads the core's own replies, and takes nothing of the hop or its author", async () => {
      await add();
      await add({}, "VoxxiVicious");
      const linkOf = (id: string, who: string) => `Please see @${who} post for this beautiful prompt here - https://x.com/${who}/status/${id}?s=46`;
      const { fetchFn } = fx({
        [`/status/${F}`]: fxPost(F, linkOf(HOP, "someone"), HEX_FX),
        [`/status/${HOP}`]: fxPost(HOP, FORWARD, { id: "77", screen: "Someone" }, { quote: CORE, counts: [5, 1, 0] }),
        [`/status/${CORE}`]: fxPost(CORE, "Halloween witch set, prompt in the comments 👇", VOX, { counts: [10, 0, 0] }),
        [`/conversation/${CORE}`]: { replies: [{ ...fxPost(sf(NOW - 5 * DAY, 9), `Prompt: ${P_REPLY}`).status, replying_to: { status: CORE } }] },
      });
      const x = { ...fakeX({ pages: [page([post(F, linkOf(HOP, "someone"))])] }), free: true };
      await playCreator(supabase, "hexmethod", undefined, deps(x, { fxFetch: fetchFn }));
      const [sub] = await rows<{ normalized_source_url: string; preview: { prompt: string; hunt: HuntFacts } }>(`select normalized_source_url, preview from public.hunt_submissions`);
      expect(sub.normalized_source_url).toBe(`x.com/status/${CORE}`);
      expect(sub.preview.prompt).toBe(P_REPLY);
      expect(sub.preview.hunt.from).toBe("reply");
      expect(sub.preview.hunt.reach?.chain.posts).toBe(3);
      expect((await rows<{ handle: string }>(`select handle from public.hunter_accounts order by handle`)).map((r) => r.handle)).toEqual(["hexmethod", "voxxivicious"]);
    });

    it("never follows a post with its own prompt: a label, long words, a pointer to its reply, its reply, an alt text", async () => {
      await add();
      const LONG = `${P_MODEL}\n\n${"soft morning words about the set ".repeat(10)}`;
      const ids = [5, 4, 3, 2, 1].map((n) => sf(NOW - 3 * DAY, 100 + n));
      const answer = (of: string, n: number, text: string) => post(sf(NOW - 3 * DAY, 200 + n), text, { photos: [], replyingTo: of });
      const posts = [
        post(ids[0], `Prompt: ${P_TEXT}`, { quoteId: CORE }),
        post(ids[1], LONG, { quoteId: CORE }),
        post(ids[2], "New set, prompt in the comments 👇", { quoteId: CORE }),
        post(ids[3], "Look at this one", { quoteId: CORE }),
        post(ids[4], "Look at this too", { quoteId: CORE, photos: [{ url: "https://pbs.twimg.com/media/a.jpg", alt: P_ALT }] }),
      ];
      const { fetchFn, asked } = fx(forwardPages());
      const x = { ...fakeX({ pages: [page(posts)], replies: { [ids[2]]: [answer(ids[2], 1, `Prompt: ${P_REPLY}`)], [ids[3]]: [answer(ids[3], 2, "Prompt: Watercolor map of a harbour town, [season] light, ink lines, soft paper grain")] } }), free: true };
      await playCreator(supabase, "hexmethod", undefined, deps(x, { fxFetch: fetchFn }));
      expect(asked).toEqual([]);
      expect((await finds()).map((f) => f.normalized_source_url).sort()).toEqual([ids[0], ids[1], ids[2], ids[3]].map((id) => `x.com/status/${id}`).sort());
      expect((await outcomes()).filter((r) => r.outcome === "forwarded")).toEqual([]);
    });

    it("does not take a core Enki knows, or a chain with a post in Enki; a core read without a find leaves the post read as its own", async () => {
      await add();
      await knownSubmission(CORE);
      const one = fx(forwardPages());
      const known = await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page([forwardPost()])] }), { fxFetch: one.fetchFn }));
      expect(known.status === 200 && known.summary.skipped).toEqual({ forwarded: 1 });
      expect(judge).not.toHaveBeenCalled();
      expect((await rows(`select handle from public.hunter_accounts where handle = 'voxxivicious'`))).toEqual([]);

      await db.exec(`truncate public.hunt_submissions, public.hunter_posts cascade; update public.hunter_accounts set newest_id = null, oldest_id = null, exhausted = false`);
      await knownSubmission(HOP);
      const hop = fx({ [`/status/${F}`]: fxPost(F, FORWARD, HEX_FX, { quote: HOP }), [`/status/${HOP}`]: fxPost(HOP, FORWARD, { id: "77", screen: "Someone" }, { quote: CORE }), [`/status/${CORE}`]: fxPost(CORE, `Prompt: ${P_TEXT}`) });
      const viaHop = await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page([post(F, FORWARD, { quoteId: HOP })])] }), { fxFetch: hop.fetchFn }));
      expect(viaHop.status === 200 && viaHop.summary.skipped).toEqual({ forwarded: 1 });
      expect(judge).not.toHaveBeenCalled();

      // A core in line is its creator's to play; one read without a find is not read again, and the post is read as its own.
      await db.exec(`truncate public.hunt_submissions, public.hunter_posts cascade; update public.hunter_accounts set newest_id = null, oldest_id = null, exhausted = false`);
      await add({}, "VoxxiVicious");
      await db.query(`insert into public.hunter_posts (post_id, handle, outcome) values ($1, 'voxxivicious', 'waiting')`, [CORE]);
      const line = fx(forwardPages());
      const waiting = await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page([forwardPost()])] }), { fxFetch: line.fetchFn }));
      expect(waiting.status === 200 && waiting.summary.skipped).toEqual({ forwarded: 1 });
      expect(judge).not.toHaveBeenCalled();

      await db.exec(`truncate public.hunt_submissions, public.hunter_posts cascade; update public.hunter_accounts set newest_id = null, oldest_id = null, exhausted = false`);
      await db.query(`insert into public.hunter_posts (post_id, handle, outcome) values ($1, 'voxxivicious', 'no_prompt')`, [CORE]);
      const read = fx({ [`/status/${MINE}`]: fxPost(MINE, P_MODEL, HEX_FX, { quote: CORE }), [`/status/${CORE}`]: fxPost(CORE, `Prompt: ${P_TEXT}`) });
      const own = await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page([post(MINE, P_MODEL, { quoteId: CORE })])] }), { fxFetch: read.fetchFn }));
      expect(own.status === 200 && own.summary).toMatchObject({ found: 1, queued: 1 });
      expect(await finds()).toEqual([{ normalized_source_url: `x.com/status/${MINE}`, source_author_handle: "hexmethod" }]);
    });

    it("imports a core once when two posts and two creators forward it in one run", async () => {
      await add();
      await add({}, "VoxxiVicious");
      await add({}, "OtherOne");
      const OTHER = { id: "55", screen: "OtherOne" };
      const F3 = sf(NOW - 3 * DAY, 3);
      const { fetchFn } = fx({
        ...forwardPages(),
        [`/status/${F2}`]: fxPost(F2, FORWARD, HEX_FX, { quote: CORE }),
        [`/status/${F3}`]: fxPost(F3, FORWARD, OTHER, { quote: HOP }),
        [`/status/${HOP}`]: fxPost(HOP, FORWARD, { id: "77", screen: "Someone" }, { quote: CORE }),
      });
      const first = await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page([forwardPost(F2), forwardPost(F)])] }), { fxFetch: fetchFn }));
      expect(first.status === 200 && first.summary.skipped).toEqual({ forwarded: 2 });
      const x = fakeX({ user: { id: OTHER.id, handle: OTHER.screen, name: "" }, pages: [page([post(F3, FORWARD, { quoteId: HOP, author: { id: OTHER.id, handle: "otherone", name: "" } })])] });
      const second = await playCreator(supabase, "otherone", undefined, deps(x, { fxFetch: fetchFn }));
      expect(second.status === 200 && second.summary.skipped).toEqual({ forwarded: 1 });
      expect(judge).toHaveBeenCalledTimes(1);
      expect(await finds()).toEqual([{ normalized_source_url: `x.com/status/${CORE}`, source_author_handle: "voxxivicious" }]);
      expect((await rows(`select found from public.hunter_accounts where handle = 'voxxivicious'`))[0]).toEqual({ found: 1 });
    });

    it("marks a chain it cannot read follow_failed, reads on without the dry brake, and a Start over follows it after all", async () => {
      await add({ dryAfter: 1 });
      await add({}, "VoxxiVicious");
      const N = sf(NOW - 6 * DAY, 1);
      const pagePosts = () => [forwardPost(), post(F2, FORWARD, { quoteId: CORE }), post(N, `Prompt: ${P_REPLY}`)];
      // The first post's own read fails; the second's core fails.
      const down = fx({ [`/status/${F2}`]: fxPost(F2, FORWARD, HEX_FX, { quote: CORE }) });
      const got = await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page(pagePosts())] }), { fxFetch: down.fetchFn }));
      expect(got.status).toBe(200);
      expect(got.status === 200 && got.summary).toMatchObject({ found: 1, queued: 1, skipped: { follow_failed: 2 }, stopped: "done" });
      expect(await outcomes()).toEqual([{ post_id: N, handle: "hexmethod", outcome: "queued" }, { post_id: F, handle: "hexmethod", outcome: "follow_failed" }, { post_id: F2, handle: "hexmethod", outcome: "follow_failed" }].sort((a, b) => (a.post_id < b.post_id ? -1 : 1)));
      expect(await creator()).toMatchObject({ error: null, dry: false, oldest_id: N });
      expect(await finds()).toEqual([{ normalized_source_url: `x.com/status/${N}`, source_author_handle: "hexmethod" }]);

      expect(await restartCreator(supabase, "hexmethod")).toEqual({ ok: true });
      expect((await outcomes()).filter((r) => r.outcome === "retry").map((r) => r.post_id).sort()).toEqual([F, F2].sort());
      const up = fx({ ...forwardPages(), [`/status/${F2}`]: fxPost(F2, FORWARD, HEX_FX, { quote: CORE }) });
      await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page(pagePosts())] }), { fxFetch: up.fetchFn }));
      expect((await outcomes()).filter((r) => r.post_id !== N)).toEqual([{ post_id: CORE, handle: "voxxivicious", outcome: "queued" }, { post_id: F, handle: "hexmethod", outcome: "forwarded" }, { post_id: F2, handle: "hexmethod", outcome: "forwarded" }]);
    });

    it("leaves the post to retry when the core's creator cannot take it: held by another Play, or at its spend cap", async () => {
      await add();
      await add({}, "VoxxiVicious");
      await db.query(`update public.hunter_accounts set playing_since = $1 where handle = 'voxxivicious'`, [new Date(NOW).toISOString()]);
      const held = fx(forwardPages());
      const a = await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page([forwardPost()])] }), { fxFetch: held.fetchFn }));
      expect(a.status === 200 && a.summary.skipped).toEqual({ follow_failed: 1 });

      await db.exec(`truncate public.hunter_posts cascade; update public.hunter_accounts set newest_id = null, oldest_id = null, exhausted = false, playing_since = null;
        update public.hunter_accounts set spend_cap_usd = 0 where handle = 'voxxivicious'`);
      const capped = fx(forwardPages());
      const b = await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page([forwardPost()])] }), { fxFetch: capped.fetchFn }));
      expect(b.status === 200 && b.summary.skipped).toEqual({ follow_failed: 1 });
      expect(judge).not.toHaveBeenCalled();
    });

    it("reads a post as its own when the core gave no find or its author is on Enki, the core's spend on the core's creator", async () => {
      await add();
      const empty = fx({ [`/status/${F}`]: fxPost(F, FORWARD, HEX_FX, { quote: CORE }), [`/status/${CORE}`]: fxPost(CORE, "gm") });
      await add({}, "VoxxiVicious");
      const a = await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page([forwardPost()])] }), { fxFetch: empty.fetchFn }));
      expect(a.status === 200 && a.summary).toMatchObject({ found: 0, queued: 0, skipped: { no_prompt: 1 } });
      expect(await outcomes()).toEqual([{ post_id: CORE, handle: "voxxivicious", outcome: "no_prompt" }, { post_id: F, handle: "hexmethod", outcome: "no_prompt" }]);

      await db.exec(`truncate public.hunt_submissions, public.hunter_posts cascade; update public.hunter_accounts set newest_id = null, oldest_id = null, exhausted = false;
        insert into public.users (id, handle, origin) values ('00000000-0000-4000-8000-0000000000cc', 'vox_on_enki', 'x');
        insert into public.auth_identities (provider, subject, user_id) values ('x', '88', '00000000-0000-4000-8000-0000000000cc');`);
      const b = await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page([forwardPost()])] }), { fxFetch: fx(forwardPages()).fetchFn }));
      expect(b.status === 200 && b.summary).toMatchObject({ found: 0, skipped: { no_prompt: 1 } });
      expect(await finds()).toEqual([]);
    });

    // Review 2026-11-02: a quote of any stranger put them on the creator list, with an Enki account, even with no find.
    describe("of someone not on the list", () => {
      const listed = async () => (await rows<{ handle: string }>(`select handle from public.hunter_accounts order by handle`)).map((r) => r.handle);
      const nobodyNew = async () => {
        expect(await listed()).toEqual(["hexmethod"]);
        expect(await rows(`select 1 from public.users where imported_x_id = '88'`)).toEqual([]);
        expect(await finds()).toEqual([]);
      };
      const pagesWith = (core: unknown) => ({ [`/status/${F}`]: fxPost(F, FORWARD, HEX_FX, { quote: CORE }), [`/status/${CORE}`]: core });
      const profile = vi.fn((u: XUser) => ensureCreatorProfile(supabase, u));
      const playIt = (fetchFn: typeof fetch, over: Partial<CreatorDeps> = {}) => playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page([forwardPost()])] }), { fxFetch: fetchFn, profile, ...over }));

      it("lists nobody and makes no account when the core holds no prompt: too short, video only, a reply by another", async () => {
        await add();
        const video = { status: { ...fxPost(CORE, `Prompt: ${P_TEXT}`).status, media: { photos: [], videos: [{}] } } };
        const comment = fxPost(CORE, `Prompt: ${P_TEXT}`, VOX, { to: sf(NOW - 6 * DAY, 1) });
        const parent = fxPost(sf(NOW - 6 * DAY, 1), "Nice set", { id: "99", screen: "Other" });
        for (const pages of [pagesWith(fxPost(CORE, "gm")), pagesWith(video), { ...pagesWith(comment), [`/status/${sf(NOW - 6 * DAY, 1)}`]: parent }]) {
          await db.exec(`truncate public.hunter_posts cascade; update public.hunter_accounts set newest_id = null, oldest_id = null, exhausted = false`);
          profile.mockClear();
          const got = await playIt(fx(pages).fetchFn);
          expect(got.status === 200 && got.summary).toMatchObject({ found: 0, skipped: { no_prompt: 1 } });
          expect(await outcomes()).toEqual([{ post_id: F, handle: "hexmethod", outcome: "no_prompt" }]);
          expect(profile.mock.calls.filter(([u]) => u.id === "88")).toEqual([]);
          await nobodyNew();
        }
      });

      const MARK = "leads_to:voxxivicious";
      const again = () => db.exec(`truncate public.hunter_posts cascade; update public.hunter_accounts set newest_id = null, oldest_id = null, exhausted = false`);

      // Kev, 2026-11-03: "warum sollte ein fremder in der liste landen, wenn ich die doch alle prüfe".
      it("marks a post whose core may hold a prompt, unsure or sure, with no model, no account, no row of theirs and nothing spent, even at the cap", async () => {
        await add();
        const distill = vi.fn(async () => ({ ok: false as const, why: "unchecked" as const }));
        for (const text of [NO_FIND, P_MODEL, `Prompt: ${P_TEXT}`]) {
          await again();
          profile.mockClear();
          const got = await playIt(fx(pagesWith(fxPost(CORE, text))).fetchFn, { distill, x: { ...fakeX({ pages: [page([forwardPost()])] }), free: true } });
          expect(got.status === 200 && got.summary).toMatchObject({ found: 0, queued: 0, skipped: { [MARK]: 1 }, usage: { distills: 0, checks: 0 }, estUsd: 0, spentUsd: 0, stopped: "done" });
          expect(got.status === 200 && got.summary.followedUsd).toBeUndefined();
          expect(await outcomes()).toEqual([{ post_id: F, handle: "hexmethod", outcome: MARK }]);
          expect(profile.mock.calls.filter(([u]) => u.id === "88")).toEqual([]);
          await nobodyNew();
        }
        expect(distill).not.toHaveBeenCalled();
        expect(judge).not.toHaveBeenCalled();
        expect(model.calls).toBe(0);
        // A mark costs nothing, so a creator at its cap in a plain mode still marks.
        await again();
        expect(await saveMode(supabase, { handle: "hexmethod", mode: "manual", recipe: {} })).toEqual({ ok: true });
        await db.exec(`update public.hunter_accounts set spend_cap_usd = 0`);
        const capped = await playIt(fx(pagesWith(fxPost(CORE, `Prompt: ${P_TEXT}`))).fetchFn, { x: { ...fakeX({ pages: [page([forwardPost()])] }), free: true } });
        expect(capped.status === 200 && capped.summary).toMatchObject({ skipped: { [MARK]: 1 }, stopped: "done" });
        await nobodyNew();
      });

      it("reads their replies once when their post points nowhere: a prompt there marks the post, none reads it as its own; a chain's own comment needs no read", async () => {
        await add();
        const REPLY = sf(NOW - 5 * DAY, 9);
        const withReply = { ...pagesWith(fxPost(CORE, "Halloween witch set")), [`/conversation/${CORE}`]: { replies: [{ ...fxPost(REPLY, `Prompt: ${P_REPLY}`).status, replying_to: { status: CORE } }] } };
        const read = fx(withReply);
        const got = await playIt(read.fetchFn);
        expect(got.status === 200 && got.summary.skipped).toEqual({ [MARK]: 1 });
        expect(read.asked.filter((p) => p === `/conversation/${CORE}`)).toHaveLength(1);
        await nobodyNew();

        await again();
        const bare = fx(pagesWith(fxPost(CORE, "Halloween witch set")));
        const none = await playIt(bare.fetchFn);
        expect(none.status === 200 && none.summary.skipped).toEqual({ no_prompt: 1 });
        expect(bare.asked.filter((p) => p === `/conversation/${CORE}`)).toHaveLength(1);
        await nobodyNew();

        await again();
        const POST = sf(NOW - 6 * DAY, 1);
        const comment = fx({ ...pagesWith(fxPost(CORE, `Prompt: ${P_REPLY}`, VOX, { to: POST })), [`/status/${POST}`]: fxPost(POST, "Halloween witch set") });
        const given = await playIt(comment.fetchFn);
        expect(given.status === 200 && given.summary.skipped).toEqual({ [MARK]: 1 });
        expect(comment.asked.filter((p) => p.startsWith("/conversation/"))).toEqual([]);
        await nobodyNew();
      });

      // Review 2026-11-03: looked up by handle alone, a listed creator who renamed was "not on your list", and no find was made.
      it("a creator on the list by X id who renamed is no stranger: played under the handle the list knows, no second row", async () => {
        await add();
        await add({}, "VoxxiOld");
        await db.exec(`update public.hunter_accounts set x_user_id = '88' where handle = 'voxxiold'`);
        const got = await playIt(fx(forwardPages()).fetchFn);
        expect(got.status === 200 && got.summary).toMatchObject({ skipped: { forwarded: 1 } });
        expect(await listed()).toEqual(["hexmethod", "voxxiold"]);
        expect(await finds()).toEqual([{ normalized_source_url: `x.com/status/${CORE}`, source_author_handle: "voxxiold" }]);
        expect(await outcomes()).toEqual([{ post_id: CORE, handle: "voxxiold", outcome: "queued" }, { post_id: F, handle: "hexmethod", outcome: "forwarded" }]);
      });

      it("the same handle with another X id stays refused, unless that id is on the list under another handle", async () => {
        await add();
        await add({}, "VoxxiVicious");
        await db.exec(`update public.hunter_accounts set x_user_id = '77' where handle = 'voxxivicious'`);
        const other = await playIt(fx(forwardPages()).fetchFn);
        expect(other.status === 200 && other.summary.skipped).toEqual({ follow_failed: 1 });
        expect(await finds()).toEqual([]);

        await again();
        await add({}, "VoxxiOld");
        await db.exec(`update public.hunter_accounts set x_user_id = '88' where handle = 'voxxiold'`);
        const moved = await playIt(fx(forwardPages()).fetchFn);
        expect(moved.status === 200 && moved.summary.skipped).toEqual({ forwarded: 1 });
        expect(await finds()).toEqual([{ normalized_source_url: `x.com/status/${CORE}`, source_author_handle: "voxxiold" }]);
      });

      // Review 2026-11-03: read as the forwarder's own, it was no_prompt for good, one more on the dry streak, and Start over left it.
      it("marks a post whose core points at comments that cannot be seen, and Start over reaches the prompt once they can and Kev has listed the author", async () => {
        await add();
        const POINTS = "New set, prompt in the comments 👇";
        const got = await playIt(fx(pagesWith(fxPost(CORE, POINTS))).fetchFn);
        expect(got.status === 200 && got.summary).toMatchObject({ found: 0, skipped: { [MARK]: 1 }, usage: { distills: 0, checks: 0 }, stopped: "done" });
        expect(await outcomes()).toEqual([{ post_id: F, handle: "hexmethod", outcome: MARK }]);
        expect(await creator()).toMatchObject({ dry_streak: 0 });
        await nobodyNew();

        await db.query(`insert into public.hunter_accounts (handle, added_by) values ('voxxivicious', $1)`, [ADMIN]);
        expect(await restartCreator(supabase, "hexmethod")).toEqual({ ok: true });
        const REPLY = sf(NOW - 5 * DAY, 9);
        const readable = { ...pagesWith(fxPost(CORE, POINTS)), [`/conversation/${CORE}`]: { replies: [{ ...fxPost(REPLY, `Prompt: ${P_REPLY}`).status, replying_to: { status: CORE } }] } };
        const after = await playIt(fx(readable).fetchFn);
        expect(after.status === 200 && after.summary.skipped).toMatchObject({ forwarded: 1 });
        expect(await finds()).toEqual([{ normalized_source_url: `x.com/status/${CORE}`, source_author_handle: "voxxivicious" }]);
      });

      it("keeps the mark out of the dry streak, first read and read again", async () => {
        await add({ dryAfter: 2 });
        const posts = [post(sf(NOW - 3 * DAY, 30), "gm"), forwardPost(sf(NOW - 3 * DAY, 20)), post(sf(NOW - 3 * DAY, 10), "gn"), post(sf(NOW - 3 * DAY, 5), "gm again")];
        const pages = { [`/status/${sf(NOW - 3 * DAY, 20)}`]: fxPost(sf(NOW - 3 * DAY, 20), FORWARD, HEX_FX, { quote: CORE }), [`/status/${CORE}`]: fxPost(CORE, `Prompt: ${P_TEXT}`) };
        const got = await playIt(fx(pages).fetchFn, { x: fakeX({ pages: [page(posts)] }) });
        expect(got.status === 200 && got.summary).toMatchObject({ stopped: "dry", skipped: { no_prompt: 2, [MARK]: 1 } });
        expect(await creator()).toMatchObject({ dry: true, oldest_id: sf(NOW - 3 * DAY, 10) });

        await db.exec(`update public.hunter_accounts set newest_id = null, oldest_id = null, exhausted = false, dry = false, dry_streak = 1`);
        const seen = await playIt(fx(pages).fetchFn, { x: fakeX({ pages: [page([forwardPost(sf(NOW - 3 * DAY, 20)), post(sf(NOW - 3 * DAY, 4), "gm once more")])] }) });
        expect(seen.status === 200 && seen.summary).toMatchObject({ stopped: "dry", skipped: { seen: 1, no_prompt: 1 } });
        expect(await creator()).toMatchObject({ dry_streak: 2 });
      });

      it("is taken back by Start over: marked again while they are not listed, followed and played once Kev has listed them", async () => {
        await add();
        const N = sf(NOW - 6 * DAY, 1);
        const pagePosts = () => [forwardPost(), post(N, `Prompt: ${P_REPLY}`)];
        const play = () => playIt(fx(forwardPages()).fetchFn, { x: fakeX({ pages: [page(pagePosts())] }) });
        const first = await play();
        expect(first.status === 200 && first.summary).toMatchObject({ found: 1, queued: 1, skipped: { [MARK]: 1 } });
        expect(await creator()).toMatchObject({ found: 1, oldest_id: N, exhausted: true });

        // Read again with the cursors where they are: nothing moves.
        const quiet = await playIt(fx(forwardPages()).fetchFn, { x: fakeX({ pages: [page([])] }) });
        expect(quiet.status === 200 && quiet.summary).toMatchObject({ found: 0, skipped: {} });
        expect((await outcomes()).find((r) => r.post_id === F)?.outcome).toBe(MARK);

        // Start over with them still not listed: "to be tried again", then marked again, and the find not taken twice.
        expect(await restartCreator(supabase, "hexmethod")).toEqual({ ok: true });
        expect((await outcomes()).find((r) => r.post_id === F)?.outcome).toBe("retry");
        const unlisted = await play();
        expect(unlisted.status === 200 && unlisted.summary).toMatchObject({ found: 0, skipped: { [MARK]: 1, seen: 1 } });
        expect(await listed()).toEqual(["hexmethod"]);

        // Kev lists them, presses Start over and Play.
        await add({}, "VoxxiVicious");
        expect(await restartCreator(supabase, "hexmethod")).toEqual({ ok: true });
        const followed = await play();
        expect(followed.status === 200 && followed.summary).toMatchObject({ found: 0, skipped: { forwarded: 1, seen: 1 } });
        expect((await outcomes()).filter((r) => r.post_id !== N)).toEqual([{ post_id: CORE, handle: "voxxivicious", outcome: "queued" }, { post_id: F, handle: "hexmethod", outcome: "forwarded" }]);
        expect(await finds()).toEqual([{ normalized_source_url: `x.com/status/${CORE}`, source_author_handle: "voxxivicious" }, { normalized_source_url: `x.com/status/${N}`, source_author_handle: "hexmethod" }].sort((p, q) => (p.normalized_source_url < q.normalized_source_url ? -1 : 1)));
        expect(await creator()).toMatchObject({ found: 1, oldest_id: N, exhausted: true, error: null });
      });

      it("leaves one who is on the list to their own Play's rules", async () => {
        await add();
        await add({}, "VoxxiVicious");
        const got = await playIt(fx(pagesWith(fxPost(CORE, NO_FIND))).fetchFn);
        expect(got.status === 200 && got.summary).toMatchObject({ skipped: { no_prompt: 1 }, usage: { distills: 0 } });
        expect(await outcomes()).toEqual([{ post_id: CORE, handle: "voxxivicious", outcome: "distill_failed" }, { post_id: F, handle: "hexmethod", outcome: "no_prompt" }]);
      });
    });

    // Review 2026-11-02: the find and its author share went to the account the handle used to be.
    it("files nothing under an old X account when the core's handle changed hands, in a Play or by a link", async () => {
      await add();
      await add({}, "VoxxiVicious");
      await db.exec(`update public.hunter_accounts set x_user_id = '111' where handle = 'voxxivicious';
        insert into public.users (id, handle, origin, imported_x_id) values ('00000000-0000-4000-8000-0000000000dd', 'old_vox', 'imported', '111');`);
      const got = await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page([forwardPost()])] }), { fxFetch: fx(forwardPages()).fetchFn }));
      expect(got.status === 200 && got.summary.skipped).toEqual({ follow_failed: 1 });
      expect(await creator()).toMatchObject({ error: null });
      expect(await finds()).toEqual([]);
      expect(judge).not.toHaveBeenCalled();

      const core = post(CORE, `Prompt: ${P_TEXT}`, { author: { id: "88", handle: "voxxivicious", name: "" } });
      const link = await playCreator(supabase, "voxxivicious", undefined, deps(fakeX(), { only: core }));
      expect(link).toMatchObject({ status: 500, error: "@voxxivicious is another X account now (88, not 111): nothing of it was taken. Look up the creator's new handle on X." });
      expect(await finds()).toEqual([]);
      expect(judge).not.toHaveBeenCalled();
      expect((await rows(`select error from public.hunter_accounts where handle = 'voxxivicious'`))[0]).toEqual({ error: "@voxxivicious is another X account now (88, not 111): nothing of it was taken. Look up the creator's new handle on X." });
    });

    // Review 2026-11-02: what an auto Play's forwards cost on other creators shows beside its own spend. A plain Play spends none (manual-costs-nothing.test.ts).
    it("counts what its forwards cost on others beside its own spend, and stops following at its cap", async () => {
      await add();
      for (const n of [0, 1, 2]) await add({}, `listed${n}`);
      const ids = [3, 2, 1].map((n) => sf(NOW - 3 * DAY, n));
      const cores = [3, 2, 1].map((n) => sf(NOW - 5 * DAY, n));
      const pages = Object.fromEntries(ids.flatMap((id, i) => [
        [`/status/${id}`, fxPost(id, FORWARD, HEX_FX, { quote: cores[i] })],
        [`/status/${cores[i]}`, fxPost(cores[i], `Prompt: ${P_TEXT} ${i}`, { id: String(60 + i), screen: `listed${i}` })],
      ]));
      const reader = () => ({ ...fakeX({ pages: [page(ids.map((id, i) => post(id, FORWARD, { quoteId: cores[i] })))] }), free: true });
      const got = await playCreator(supabase, "hexmethod", undefined, deps(reader(), { fxFetch: fx(pages).fetchFn }));
      expect(got.status === 200 && got.summary).toMatchObject({ estUsd: 0, spentUsd: 0, skipped: { forwarded: 3 }, followedUsd: 0.0018 });
      expect((await creator()).spent).toBe(0);

      // Through a billed reader that returned more than the room asked for: its reads ($0.125) and each core ($0.0006) reach
      // this creator's cap of $1 at the 14th forward, and it follows no further. Through FxTwitter a forward's replies read
      // stops the round earlier (nextPage), so this line is the billed reader's alone.
      await db.exec(`truncate public.hunt_submissions, public.hunter_posts cascade; update public.hunter_accounts set newest_id = null, oldest_id = null, exhausted = false, spent_usd = 0; update public.hunter_accounts set spend_cap_usd = 1, spent_usd = 0.867 where handle = 'hexmethod'`);
      const many = Array.from({ length: 25 }, (_, i) => [sf(NOW - 3 * DAY, 100 + i), sf(NOW - 5 * DAY, 100 + i)]).reverse();
      const costly = Object.fromEntries(many.flatMap(([id, core], i) => [
        [`/status/${id}`, fxPost(id, FORWARD, HEX_FX, { quote: core })],
        [`/status/${core}`, fxPost(core, `Prompt: ${P_TEXT} ${i}`, { id: "60", screen: "listed0" })],
      ]));
      const capped = await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page(many.map(([id, core]) => post(id, FORWARD, { quoteId: core })))] }), { fxFetch: fx(costly).fetchFn }));
      expect(capped.status === 200 && capped.summary).toMatchObject({ stopped: "spend_cap", skipped: { forwarded: 14 }, followedUsd: 0.0084 });
      expect((await outcomes()).filter((r) => r.handle === "hexmethod")).toHaveLength(14);
    });

    it("counts what its forwards cost in the room for its next page", async () => {
      await add();
      await add({}, "VoxxiVicious");
      // Room for one page exactly: 20 posts' model work at most, and a forward's core takes a little of it.
      await db.exec(`update public.hunter_accounts set spend_cap_usd = 1, spent_usd = 0.967 where handle = 'hexmethod'`);
      const x = { ...fakeX({ pages: [page([forwardPost()], "more"), page([])] }), free: true };
      const got = await playCreator(supabase, "hexmethod", undefined, deps(x, { fxFetch: fx(forwardPages()).fetchFn }));
      expect(got.status === 200 && got.summary).toMatchObject({ stopped: "spend_cap", skipped: { forwarded: 1 }, followedUsd: 0.0006 });
      expect(x.search).toHaveBeenCalledTimes(1);
    });

    // Review 2026-11-02: an outage on a core marked the post follow_failed and moved the cursor past it, while the round said done.
    it("stops before the post when the core's creator's Play could not finish, nothing passed, and the next Play takes it", async () => {
      const said = "The model could not be asked: nothing was skipped. Press Play again in a minute.";
      await add();
      await add({}, "VoxxiVicious");
      const judgeDown = vi.fn(async (): Promise<Judged> => ({ ok: false, status: 503, error: "The prompt could not be checked right now." }));
      const down = await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page([forwardPost()])] }), { fxFetch: fx(forwardPages()).fetchFn, judge: judgeDown }));
      expect(down).toMatchObject({ status: 503, error: said, summary: { stopped: "error" } });
      expect(await outcomes()).toEqual([]);
      expect(await creator()).toMatchObject({ oldest_id: null, exhausted: false, error: said, playing_since: null });
      const next = await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page([forwardPost()])] }), { fxFetch: fx(forwardPages()).fetchFn }));
      expect(next.status === 200 && next.summary.skipped).toEqual({ forwarded: 1 });
      expect(await finds()).toEqual([{ normalized_source_url: `x.com/status/${CORE}`, source_author_handle: "voxxivicious" }]);

      // A failed save the same, with its own words.
      await db.exec(`truncate public.hunt_submissions, public.hunter_posts cascade; update public.hunter_accounts set newest_id = null, oldest_id = null, exhausted = false;
        create function public.refuse_find() returns trigger language plpgsql as $$ begin raise exception 'refused'; end $$;
        create trigger refuse_find before insert on public.hunt_submissions for each row execute function public.refuse_find();`);
      const unsaved = await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page([forwardPost()])] }), { fxFetch: fx(forwardPages()).fetchFn }));
      await db.exec(`drop trigger refuse_find on public.hunt_submissions; drop function public.refuse_find();`);
      expect(unsaved).toMatchObject({ status: 500, error: "A find of @voxxivicious could not be saved (refused): nothing was skipped. Press Play again.", summary: { stopped: "error" } });
      expect(await outcomes()).toEqual([]);
    });

    it("marks follow_failed when the list could not be read, taking nothing blind", async () => {
      await add();
      const away = fx(forwardPages(), async (p) => { if (p === `/status/${CORE}`) await db.exec(`alter table public.hunter_accounts rename column x_user_id to x_user_id_away`); });
      const got = await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page([forwardPost()])] }), { fxFetch: away.fetchFn }));
      await db.exec(`alter table public.hunter_accounts rename column x_user_id_away to x_user_id`);
      expect(got.status === 200 && got.summary.skipped).toEqual({ follow_failed: 1 });
      expect(await finds()).toEqual([]);
    });

    // Review 2026-11-02: no test held these.
    it("keeps the chain's reach for a core in a plain mode, marks a core with no author id follow_failed, and says a refused write of its own core's row", async () => {
      await add();
      await add({}, "VoxxiVicious");
      expect(await saveMode(supabase, { handle: "voxxivicious", mode: "manual", recipe: null })).toEqual({ ok: true });
      const plain = (plan: ImportPlan, link: { url: string; normalized: string }, userId: string, title: string) => plainImport(supabase, { plan, link, userId, title, fetchFn: pics });
      const got = await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page([forwardPost()])] }), { fxFetch: fx(forwardPages()).fetchFn, plain }));
      expect(got.status === 200 && got.summary.skipped).toEqual({ forwarded: 1 });
      const [sub] = await rows<{ preview: { hunt: HuntFacts } }>(`select preview from public.hunt_submissions`);
      expect(sub.preview.hunt.how).toBe("manual");
      expect(sub.preview.hunt.reach?.chain).toMatchObject({ posts: 2, likes: 138 });

      await db.exec(`truncate public.hunt_submissions, public.hunter_posts cascade; update public.hunter_accounts set newest_id = null, oldest_id = null, exhausted = false`);
      const nameless = fx({ ...forwardPages(), [`/status/${CORE}`]: fxPost(CORE, `Prompt: ${P_TEXT}`, { id: "", screen: "Someone" }) });
      const b = await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page([forwardPost()])] }), { fxFetch: nameless.fetchFn }));
      expect(b.status === 200 && b.summary.skipped).toEqual({ follow_failed: 1 });
      expect((await rows<{ handle: string }>(`select handle from public.hunter_accounts where handle = 'someone'`))).toEqual([]);

      await db.exec(`truncate public.hunt_submissions, public.hunter_posts cascade; update public.hunter_accounts set newest_id = null, oldest_id = null, exhausted = false;
        create function public.refuse_core() returns trigger language plpgsql as $$ begin if new.post_id = '${sf(NOW - 5 * DAY, 2)}' then raise exception 'refused'; end if; return new; end $$;
        create trigger refuse_core before insert on public.hunter_posts for each row execute function public.refuse_core();`);
      const OWN = sf(NOW - 5 * DAY, 2);
      const own = fx({ [`/status/${F}`]: fxPost(F, FORWARD, HEX_FX, { quote: OWN }), [`/status/${OWN}`]: fxPost(OWN, `Prompt: ${P_TEXT}`, HEX_FX) });
      const c = await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page([post(F, FORWARD, { quoteId: OWN })])] }), { fxFetch: own.fetchFn }));
      await db.exec(`drop trigger refuse_core on public.hunter_posts; drop function public.refuse_core();`);
      expect(c.status).toBe(500);
      expect(await outcomes()).toEqual([]);
    });

    // Review 2026-11-02: a creator's own short prompt was lost to the post it quotes, a hit found before the follow code.
    it("asks the model about words that could be a prompt before following, and follows only if it finds none", async () => {
      await add();
      await add({}, "VoxxiVicious");
      const OWN_WORDS = `my prompt for this remix: ${P_MODEL}`;
      const found = fx(forwardPages());
      const a = await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page([post(F, OWN_WORDS, { quoteId: CORE })])] }), { fxFetch: found.fetchFn }));
      expect(a.status === 200 && a.summary).toMatchObject({ found: 1, queued: 1, usage: { distills: 1 } });
      expect(model.calls).toBe(1);
      expect(found.asked).toEqual([]);
      expect(await finds()).toEqual([{ normalized_source_url: `x.com/status/${F}`, source_author_handle: "hexmethod" }]);

      await db.exec(`truncate public.hunt_submissions, public.hunter_posts cascade; update public.hunter_accounts set newest_id = null, oldest_id = null, exhausted = false`);
      model.calls = 0;
      const chatter = fx({ ...forwardPages(), [`/status/${F}`]: fxPost(F, NO_FIND, HEX_FX, { quote: CORE }) });
      const b = await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page([post(F, NO_FIND, { quoteId: CORE })])] }), { fxFetch: chatter.fetchFn }));
      expect(b.status === 200 && b.summary.skipped).toEqual({ forwarded: 1 });
      expect(model.calls).toBe(1);
      expect(await finds()).toEqual([{ normalized_source_url: `x.com/status/${CORE}`, source_author_handle: "voxxivicious" }]);

      // Not a forward, the model finding none: its own failure, nothing more asked. The model down: nothing passed.
      await db.exec(`truncate public.hunt_submissions, public.hunter_posts cascade; update public.hunter_accounts set newest_id = null, oldest_id = null, exhausted = false`);
      const plainPost = fx({});
      const c = await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page([post(F, NO_FIND)])] }), { fxFetch: plainPost.fetchFn }));
      expect(c.status === 200 && c.summary.skipped).toEqual({ distill_failed: 1 });
      expect(plainPost.asked).toEqual([]);
      await db.exec(`truncate public.hunter_posts cascade; update public.hunter_accounts set newest_id = null, oldest_id = null, exhausted = false`);
      const down = fx(forwardPages());
      const d = await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page([post(F, NO_FIND, { quoteId: CORE })])] }), { fxFetch: down.fetchFn, distill: async () => ({ ok: false, why: "unchecked" }) }));
      expect(d.status).toBe(503);
      expect(down.asked).toEqual([]);

      // Words on how to use a prompt held elsewhere are followed at once, as ever, with no model call.
      await db.exec(`truncate public.hunter_posts cascade; update public.hunter_accounts set newest_id = null, oldest_id = null, exhausted = false`);
      model.calls = 0;
      const USE = "Use this prompt structure and execute PHASE 1-4 of the instructions below, then generate the final image";
      const uses = fx({ ...forwardPages(), [`/status/${F}`]: fxPost(F, USE, HEX_FX, { quote: CORE }) });
      const e = await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page([post(F, USE, { quoteId: CORE })])] }), { fxFetch: uses.fetchFn }));
      expect(e.status === 200 && e.summary.skipped).toEqual({ forwarded: 1 });
      expect(model.calls).toBe(0);

      // Followed first, its core no find, and the model finding none after: not followed twice.
      await db.exec(`truncate public.hunt_submissions, public.hunter_posts cascade; update public.hunter_accounts set newest_id = null, oldest_id = null, exhausted = false`);
      const once = fx({ [`/status/${F}`]: fxPost(F, USE, HEX_FX, { quote: CORE }), [`/status/${CORE}`]: fxPost(CORE, "gm") });
      const g = await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page([post(F, USE, { quoteId: CORE })])] }), { fxFetch: once.fetchFn }));
      expect(g.status === 200 && g.summary.skipped).toEqual({ distill_failed: 1 });
      expect(once.asked.filter((p) => p === `/status/${F}`)).toHaveLength(1);
    });

    it("keeps words that could be a prompt in the plain modes, with no model to tell them from a forward's", async () => {
      await add();
      expect(await saveMode(supabase, { handle: "hexmethod", mode: "manual", recipe: null })).toEqual({ ok: true });
      const plain = (plan: ImportPlan, link: { url: string; normalized: string }, userId: string, title: string) => plainImport(supabase, { plan, link, userId, title, fetchFn: pics });
      const { fetchFn, asked } = fx(forwardPages());
      await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page([post(F, P_MODEL, { quoteId: CORE })])] }), { fxFetch: fetchFn, plain }));
      expect(asked).toEqual([]);
      expect(await finds()).toEqual([{ normalized_source_url: `x.com/status/${F}`, source_author_handle: "hexmethod" }]);
    });

    // Review 2026-11-02: the post took the core's outcome, and its own words never reached the model.
    it("reads a post as its own when its own earlier post gave no find, the core's row kept", async () => {
      await add();
      const OWN = sf(NOW - 5 * DAY, 2);
      for (const [core, outcome] of [[fxPost(OWN, "gm", HEX_FX), "no_prompt"], [{ status: { ...fxPost(OWN, `Prompt: ${P_TEXT}`, HEX_FX).status, media: { photos: [], videos: [{}] } } }, "video_only"]] as const) {
        await db.exec(`truncate public.hunter_posts cascade; update public.hunter_accounts set newest_id = null, oldest_id = null, exhausted = false`);
        model.calls = 0;
        const { fetchFn } = fx({ [`/status/${F}`]: fxPost(F, NO_FIND, HEX_FX, { quote: OWN }), [`/status/${OWN}`]: core });
        const got = await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page([post(F, NO_FIND, { quoteId: OWN })])] }), { fxFetch: fetchFn }));
        expect(got.status === 200 && got.summary.skipped).toEqual({ distill_failed: 1 });
        expect(model.calls).toBe(1);
        expect((await outcomes()).map((r) => [r.post_id, r.outcome]).sort()).toEqual([[OWN, outcome], [F, "distill_failed"]].sort());
      }
    });

    // Review 2026-11-02: a chain's core can lie outside the creator's search, so it is never published at once.
    it("queues the creator's own forwarded post in publish mode, as another's", async () => {
      await add();
      await db.exec(`update public.hunter_config set mode = 'publish'`);
      const OWN = sf(NOW - 5 * DAY, 2);
      const { fetchFn } = fx({ [`/status/${F}`]: fxPost(F, FORWARD, HEX_FX, { quote: OWN }), [`/status/${OWN}`]: fxPost(OWN, `Prompt: ${P_TEXT}`, HEX_FX) });
      const d = deps(fakeX({ pages: [page([post(F, FORWARD, { quoteId: OWN })])] }), { fxFetch: fetchFn });
      const got = await playCreator(supabase, "hexmethod", undefined, d);
      expect(got.status === 200 && got.summary).toMatchObject({ queued: 1, published: 0 });
      expect(d.publish).not.toHaveBeenCalled();
      expect((await outcomes()).map((r) => r.outcome)).toEqual(["queued", "queued"]);
    });

    it("takes the creator's own forwarded post in this round, once, and one model call for the forward", async () => {
      await add();
      const OWN = sf(NOW - 5 * DAY, 2);
      const pages = { [`/status/${F}`]: fxPost(F, FORWARD, HEX_FX, { quote: OWN, counts: [2, 0, 0] }), [`/status/${F2}`]: fxPost(F2, FORWARD, HEX_FX, { quote: OWN }), [`/status/${OWN}`]: fxPost(OWN, `Prompt: ${P_TEXT}`, HEX_FX, { counts: [40, 1, 1] }) };
      const { fetchFn } = fx(pages);
      const got = await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page([post(F2, FORWARD, { quoteId: OWN }), post(F, FORWARD, { quoteId: OWN }), post(OWN, `Prompt: ${P_TEXT}`)])] }), { fxFetch: fetchFn }));
      expect(got.status).toBe(200);
      expect(got.status === 200 && got.summary).toMatchObject({ found: 1, queued: 1, skipped: { forwarded: 1, seen: 1 } });
      expect(judge).toHaveBeenCalledTimes(1);
      const [sub] = await rows<{ normalized_source_url: string; source_author_handle: string; preview: { hunt: HuntFacts } }>(`select normalized_source_url, source_author_handle, preview from public.hunt_submissions`);
      expect(sub).toMatchObject({ normalized_source_url: `x.com/status/${OWN}`, source_author_handle: "hexmethod" });
      expect(sub.preview.hunt.reach?.chain).toMatchObject({ posts: 2, likes: 41 });

      // A core without a find is its own row and not read twice: one model call for each post's words.
      await db.exec(`truncate public.hunt_submissions, public.hunter_posts cascade; update public.hunter_accounts set newest_id = null, oldest_id = null, exhausted = false`);
      model.calls = 0;
      const none = fx({ [`/status/${F}`]: fxPost(F, NO_FIND, HEX_FX, { quote: OWN }), [`/status/${OWN}`]: fxPost(OWN, NO_FIND, HEX_FX) });
      await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page([post(F, NO_FIND, { quoteId: OWN }), post(OWN, NO_FIND)])] }), { fxFetch: none.fetchFn }));
      expect(model.calls).toBe(2);
      expect((await outcomes()).map((r) => r.post_id).sort()).toEqual([OWN, F].sort());
    });

    it("follows in manual mode too, the core taken whole with no model, whatever its creator's mode (Kev, 2026-11-03)", async () => {
      await add();
      await add({}, "VoxxiVicious");
      expect(await saveMode(supabase, { handle: "hexmethod", mode: "manual", recipe: null })).toEqual({ ok: true });
      const { fetchFn } = fx(forwardPages());
      const plain = vi.fn((plan: ImportPlan, link: { url: string; normalized: string }, userId: string, title: string) => plainImport(supabase, { plan, link, userId, title, fetchFn: pics }));
      const got = await playCreator(supabase, "hexmethod", undefined, deps({ ...fakeX({ pages: [page([forwardPost()])] }), free: true }, { fxFetch: fetchFn, plain }));
      expect(got.status === 200 && got.summary.skipped).toEqual({ forwarded: 1 });
      expect(plain).toHaveBeenCalledTimes(1);
      expect(judge).not.toHaveBeenCalled();
      expect(await finds()).toEqual([{ normalized_source_url: `x.com/status/${CORE}`, source_author_handle: "voxxivicious" }]);
    });

    it("stops before the core when the round is out of time, nothing passed; and renews its hold before a core after a slow chain", async () => {
      await add();
      await add({}, "VoxxiVicious");
      const slow = fx(forwardPages(), (p) => { if (p === `/status/${CORE}`) clock.t += TIME_CAP_MS + 1; });
      const got = await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page([forwardPost()])] }), { fxFetch: slow.fetchFn }));
      expect(got.status === 200 && got.summary).toMatchObject({ stopped: "time", more: true, found: 0 });
      expect(await outcomes()).toEqual([]);
      expect(await creator()).toMatchObject({ oldest_id: null });
      expect(judge).not.toHaveBeenCalled();

      await db.exec(`update public.hunter_accounts set newest_id = null, oldest_id = null, exhausted = false, playing_since = null`);
      clock.t = NOW;
      const held: unknown[] = [];
      const chain = fx(forwardPages(), (p) => { if (p === `/status/${CORE}`) clock.t += 70_000; });
      await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page([forwardPost()])] }), {
        fxFetch: chain.fetchFn,
        profile: async (u: XUser) => {
          if (u.id === "88") held.push((await rows<{ at: string }>(`select to_char(playing_since at time zone 'UTC', 'HH24:MI:SS') as at from public.hunter_accounts where handle = 'hexmethod'`))[0].at);
          return ensureCreatorProfile(supabase, u);
        },
      }));
      expect(held).toEqual(["12:01:10"]);
    });

    it("reads what hunter_posts says of the core: a find's outcome settles the post, any other leaves it read as its own", async () => {
      await add();
      await add({}, "VoxxiVicious");
      const cases: [string, Record<string, number>][] = [
        ["queued", { forwarded: 1 }], ["published", { forwarded: 1 }], ["publish_failed", { forwarded: 1 }], ["duplicate", { forwarded: 1 }], ["waiting", { forwarded: 1 }], ["rejected", { forwarded: 1 }],
        ["no_prompt", { no_prompt: 1 }], ["distill_failed", { no_prompt: 1 }], ["follow_failed", { no_prompt: 1 }],
      ];
      for (const [outcome, skipped] of cases) {
        await db.exec(`truncate public.hunter_posts cascade; update public.hunter_accounts set newest_id = null, oldest_id = null, exhausted = false`);
        await db.query(`insert into public.hunter_posts (post_id, handle, outcome) values ($1, 'voxxivicious', $2)`, [CORE, outcome]);
        const got = await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page([forwardPost()])] }), { fxFetch: fx(forwardPages()).fetchFn }));
        expect([outcome, got.status === 200 && got.summary.skipped]).toEqual([outcome, skipped]);
      }
      expect(judge).not.toHaveBeenCalled();
    });

    it("a chain's core reached by its author's comment: on a free reader the other replies are read too, the comment first", async () => {
      await add();
      const POST = sf(NOW - 6 * DAY, 1), OTHER = sf(NOW - 6 * DAY, 5);
      const VIDEO = { id: "v1", url: "https://video.twimg.com/v/1.mp4" };
      const pages = {
        [`/status/${F}`]: fxPost(F, FORWARD, HEX_FX, { quote: CORE }),
        [`/status/${CORE}`]: fxPost(CORE, `Prompt: ${P_REPLY}`, HEX_FX, { to: POST }),
        [`/status/${POST}`]: fxPost(POST, "Halloween witch set", HEX_FX),
      };
      const clip = post(OTHER, "and the clip of it", { photos: [], replyingTo: POST, videos: 1, videoData: [VIDEO] });
      const again = post(CORE, `Prompt: ${P_REPLY}`, { photos: [], replyingTo: POST });
      const x = { ...fakeX({ pages: [page([forwardPost()])], replies: { [POST]: [clip, again] } }), free: true };
      const got = await playCreator(supabase, "hexmethod", undefined, deps(x, { fxFetch: fx(pages).fetchFn }));
      expect(got.status === 200 && got.summary.usage.videos).toBe(1);
      expect(await rows(`select post_id, kind, videos, replies from public.hunter_parked`)).toMatchObject([{
        post_id: POST, kind: "video", videos: [{ ...VIDEO, reply_id: OTHER }], replies: [{ id: CORE }, { id: OTHER }],
      }]);
      const [sub] = await rows<{ preview: { prompt: string; hunt: HuntFacts } }>(`select preview from public.hunt_submissions`);
      expect(sub.preview.prompt).toBe(P_REPLY);
      expect(sub.preview.hunt.replyUrl).toContain(CORE);
    });

    it("takes a chain's core that is a comment as the post it answers, the comment as where the prompt is, another's or its own", async () => {
      await add();
      await add({}, "VoxxiVicious");
      const POST = sf(NOW - 6 * DAY, 1);
      const pages = (who: { id: string; screen: string }) => ({
        [`/status/${F}`]: fxPost(F, FORWARD, HEX_FX, { quote: CORE }),
        [`/status/${CORE}`]: fxPost(CORE, `Prompt: ${P_REPLY}`, who, { to: POST }),
        [`/status/${POST}`]: fxPost(POST, "Halloween witch set", who),
      });
      const stranger = fx(pages(VOX));
      const x = fakeX({ pages: [page([forwardPost()])] });
      await playCreator(supabase, "hexmethod", undefined, deps(x, { fxFetch: stranger.fetchFn }));
      const [sub] = await rows<{ normalized_source_url: string; source_author_handle: string; preview: { prompt: string; hunt: HuntFacts } }>(`select normalized_source_url, source_author_handle, preview from public.hunt_submissions`);
      expect(sub).toMatchObject({ normalized_source_url: `x.com/status/${POST}`, source_author_handle: "voxxivicious" });
      expect(sub.preview.prompt).toBe(P_REPLY);
      expect(sub.preview.hunt).toMatchObject({ from: "reply", replyUrl: `https://x.com/VoxxiVicious/status/${CORE}`, reach: { chain: { posts: 3 } } });
      // The comment holds the prompt, and the author's other replies are read for what they hold (a video).
      expect(stranger.asked).toContain(`/conversation/${POST}`);

      await db.exec(`truncate public.hunt_submissions, public.hunter_posts cascade; update public.hunter_accounts set newest_id = null, oldest_id = null, exhausted = false`);
      const own = fx(pages(HEX_FX));
      const ownX = fakeX({ pages: [page([forwardPost()])] });
      await playCreator(supabase, "hexmethod", undefined, deps(ownX, { fxFetch: own.fetchFn }));
      const [mine] = await rows<{ normalized_source_url: string; source_author_handle: string; preview: { prompt: string; hunt: HuntFacts } }>(`select normalized_source_url, source_author_handle, preview from public.hunt_submissions`);
      expect(mine).toMatchObject({ normalized_source_url: `x.com/status/${POST}`, source_author_handle: "hexmethod" });
      expect(mine.preview.prompt).toBe(P_REPLY);
      expect(mine.preview.hunt.from).toBe("reply");
      expect(ownX.replies).not.toHaveBeenCalled();

      // In a plain mode the comment is the reply too, unasked.
      await db.exec(`truncate public.hunt_submissions, public.hunter_posts cascade; update public.hunter_accounts set newest_id = null, oldest_id = null, exhausted = false`);
      expect(await saveMode(supabase, { handle: "hexmethod", mode: "manual", recipe: null })).toEqual({ ok: true });
      const plainX = fakeX({ pages: [page([forwardPost()])] });
      await playCreator(supabase, "hexmethod", undefined, deps(plainX, { fxFetch: fx(pages(HEX_FX)).fetchFn, plain: (plan: ImportPlan, link: { url: string; normalized: string }, userId: string, title: string) => plainImport(supabase, { plan, link, userId, title, fetchFn: pics }) }));
      const [plain] = await rows<{ preview: { prompt: string } }>(`select preview from public.hunt_submissions`);
      expect(plain.preview.prompt).toContain(P_REPLY);
      expect(plainX.replies.mock.calls.map((c) => c[0].id)).toEqual([F]);
    });

    it("reads a post as its own when what it forwards is deleted, marks nothing to retry, and the chain's cut end is no find", async () => {
      const real = setTimeout;
      const pause = vi.spyOn(globalThis, "setTimeout").mockImplementation(((f: () => void, ms?: number) => real(f, ms === 1500 ? 0 : ms)) as never);
      try {
        await add();
        const a = sf(NOW - 3 * DAY, 5), b = sf(NOW - 3 * DAY, 4), c = sf(NOW - 3 * DAY, 3);
        const { fetchFn } = fx({
          [`/status/${a}`]: fxPost(a, P_MODEL, HEX_FX, { quote: CORE }), [`/status/${b}`]: fxPost(b, FORWARD, HEX_FX, { quote: CORE }), [`/status/${CORE}`]: 404,
          [`/status/${c}`]: fxPost(c, FORWARD, HEX_FX, { quote: HOP }), [`/status/${HOP}`]: fxPost(HOP, FORWARD, VOX, { quote: CORE }),
        });
        const got = await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page([post(a, P_MODEL, { quoteId: CORE }), post(b, FORWARD, { quoteId: CORE }), post(c, FORWARD, { quoteId: HOP })])] }), { fxFetch: fetchFn }));
        expect(got.status === 200 && got.summary).toMatchObject({ found: 1, queued: 1, skipped: { no_prompt: 2 } });
        expect(got.status === 200 && got.summary.skipped.follow_failed).toBeUndefined();
        expect(await finds()).toEqual([{ normalized_source_url: `x.com/status/${a}`, source_author_handle: "hexmethod" }]);

        // A hop that only forwards what is gone is no core, in the plain mode of a creator on the list either.
        await db.exec(`truncate public.hunt_submissions, public.hunter_posts cascade; update public.hunter_accounts set newest_id = null, oldest_id = null, exhausted = false`);
        await add({}, "VoxxiVicious");
        expect(await saveMode(supabase, { handle: "voxxivicious", mode: "manual", recipe: null })).toEqual({ ok: true });
        const plain = vi.fn();
        await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page([post(c, FORWARD, { quoteId: HOP })])] }), { fxFetch: fetchFn, plain }));
        expect(plain).not.toHaveBeenCalled();
        expect(await outcomes()).toEqual([{ post_id: c, handle: "hexmethod", outcome: "no_prompt" }]);
      } finally {
        pause.mockRestore();
      }
    });

    it("gives a text-only core the forward's picture", async () => {
      await add();
      await add({}, "VoxxiVicious");
      const { fetchFn } = fx({ [`/status/${F}`]: fxPost(F, FORWARD, HEX_FX, { quote: CORE }), [`/status/${CORE}`]: fxPost(CORE, `Prompt: ${P_TEXT}`, VOX, { noPhoto: true }) });
      await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page([forwardPost()])] }), { fxFetch: fetchFn }));
      const [sub] = await rows<{ preview: { photos: unknown[] } }>(`select preview from public.hunt_submissions`);
      expect(sub.preview.photos).toEqual([`https://pbs.twimg.com/media/${F}.jpg`]);
    });

    it("takes a core a Start over took back again, its new outcome over the mark, another creator's or its own", async () => {
      await add();
      await add({}, "VoxxiVicious");
      await db.query(`insert into public.hunter_posts (post_id, handle, outcome) values ($1, 'voxxivicious', 'retry')`, [CORE]);
      const other = await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page([forwardPost()])] }), { fxFetch: fx(forwardPages()).fetchFn }));
      expect(other.status === 200 && other.summary.skipped).toEqual({ forwarded: 1 });
      expect(await outcomes()).toEqual([{ post_id: CORE, handle: "voxxivicious", outcome: "queued" }, { post_id: F, handle: "hexmethod", outcome: "forwarded" }]);

      await db.exec(`truncate public.hunt_submissions, public.hunter_posts cascade; update public.hunter_accounts set newest_id = null, oldest_id = null, exhausted = false`);
      const OWN = sf(NOW - 5 * DAY, 2);
      await db.query(`insert into public.hunter_posts (post_id, handle, outcome) values ($1, 'hexmethod', 'retry')`, [OWN]);
      const own = fx({ [`/status/${F}`]: fxPost(F, FORWARD, HEX_FX, { quote: OWN }), [`/status/${OWN}`]: fxPost(OWN, `Prompt: ${P_TEXT}`, HEX_FX) });
      await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page([post(F, FORWARD, { quoteId: OWN })])] }), { fxFetch: own.fetchFn }));
      expect((await outcomes()).find((r) => r.post_id === OWN)).toEqual({ post_id: OWN, handle: "hexmethod", outcome: "queued" });
    });

    it("takes a rejected core again only when a person adds its link", async () => {
      await add();
      await add({}, "VoxxiVicious");
      await db.query(`insert into public.hunter_posts (post_id, handle, outcome) values ($1, 'voxxivicious', 'rejected')`, [CORE]);
      const core = post(CORE, `Prompt: ${P_TEXT}`, { author: { id: "88", handle: "voxxivicious", name: "" } });
      const added = await playCreator(supabase, "voxxivicious", undefined, deps(fakeX({ user: { id: "88", handle: "VoxxiVicious", name: "" } }), { only: core }));
      expect(added.status === 200 && added.summary.queued).toBe(1);
      expect(await outcomes()).toEqual([{ post_id: CORE, handle: "voxxivicious", outcome: "queued" }]);
    });

    it("settles the post when the core's prompt is in Enki under another post", async () => {
      await add();
      await add({}, "VoxxiVicious");
      const N = sf(NOW - 2 * DAY, 7);
      const got = await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page([post(N, `Prompt: ${P_TEXT}`), forwardPost()])] }), { fxFetch: fx(forwardPages()).fetchFn }));
      expect(got.status === 200 && got.summary).toMatchObject({ found: 1, skipped: { forwarded: 1 } });
      expect(await finds()).toEqual([{ normalized_source_url: `x.com/status/${N}`, source_author_handle: "hexmethod" }]);
    });

    it("marks follow_failed what it could not look up: no handle, a failed read", async () => {
      await add();
      const noName = fx({ ...forwardPages(), [`/status/${CORE}`]: fxPost(CORE, `Prompt: ${P_TEXT}`, { id: "88", screen: "" }) });
      const a = await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page([forwardPost()])] }), { fxFetch: noName.fetchFn }));
      expect(a.status === 200 && a.summary.skipped).toEqual({ follow_failed: 1 });
      expect((await rows<{ handle: string }>(`select handle from public.hunter_accounts`)).map((r) => r.handle)).toEqual(["hexmethod"]);

      // The look-up fails: nothing is taken blind. The table back before anything is asserted.
      await db.exec(`truncate public.hunter_posts cascade; update public.hunter_accounts set newest_id = null, oldest_id = null, exhausted = false`);
      const away = fx(forwardPages(), async (p) => { if (p === `/status/${CORE}`) await db.exec(`alter table public.hunt_submissions rename to hunt_submissions_away`); });
      const c = await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page([forwardPost()])] }), { fxFetch: away.fetchFn }));
      await db.exec(`alter table public.hunt_submissions_away rename to hunt_submissions`);
      expect(c.status === 200 && c.summary.skipped).toEqual({ follow_failed: 1 });
      expect((await rows<{ handle: string }>(`select handle from public.hunter_accounts`)).map((r) => r.handle)).toEqual(["hexmethod"]);
    });

    it("lets a failed follow leave the dry streak as it stands, so an outage neither brakes a creator nor clears its streak", async () => {
      await add({ dryAfter: 2 });
      const down = fx({});
      const posts = [post(sf(NOW - 3 * DAY, 30), "gm"), forwardPost(sf(NOW - 3 * DAY, 20)), post(sf(NOW - 3 * DAY, 10), "gn"), post(sf(NOW - 3 * DAY, 5), "gm again")];
      const got = await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page(posts)] }), { fxFetch: down.fetchFn }));
      expect(got.status === 200 && got.summary).toMatchObject({ stopped: "dry", skipped: { no_prompt: 2, follow_failed: 1 } });
      expect(await creator()).toMatchObject({ dry: true, oldest_id: sf(NOW - 3 * DAY, 10) });
    });

    it("does not follow an added link's post again, or past a chain's end in any mode", async () => {
      await add();
      const only = fx(forwardPages());
      await playCreator(supabase, "hexmethod", undefined, deps(fakeX(), { only: forwardPost(), fxFetch: only.fetchFn }));
      expect(only.asked).toEqual([]);

      const ids = [1, 2, 3, 4, 5, 6].map((n) => sf(NOW - (10 - n) * DAY, n));
      const pages = Object.fromEntries(ids.map((id, i) => [`/status/${id}`, fxPost(id, FORWARD, HEX_FX, { quote: ids[i + 1] })]));
      const plain = (plan: ImportPlan, link: { url: string; normalized: string }, userId: string, title: string) => plainImport(supabase, { plan, link, userId, title, fetchFn: pics });
      for (const mode of ["auto", "manual"]) {
        await db.exec(`truncate public.hunt_submissions, public.hunter_posts cascade; update public.hunter_accounts set newest_id = null, oldest_id = null, exhausted = false`);
        expect(await saveMode(supabase, { handle: "hexmethod", mode, recipe: {} })).toEqual({ ok: true });
        const chain = fx(pages);
        await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page([post(ids[0], FORWARD, { quoteId: ids[1] })])] }), { fxFetch: chain.fetchFn, plain }));
        expect(chain.asked).toEqual(ids.slice(0, 5).map((id) => `/status/${id}`));
        // The chain was cut: the fifth post's words are no find.
        expect(await outcomes()).toEqual([{ post_id: ids[0], handle: "hexmethod", outcome: "follow_failed" }]);
        expect(await finds()).toEqual([]);
      }
    });

    it("keeps its own prompt in the plain modes: a recipe's cut, or the author's reply whatever the reader", async () => {
      await add();
      const plain = vi.fn((plan: ImportPlan, link: { url: string; normalized: string }, userId: string, title: string) => plainImport(supabase, { plan, link, userId, title, fetchFn: pics }));
      expect(await saveMode(supabase, { handle: "hexmethod", mode: "recipe", recipe: { from: "text", after: "", before: "", titleLine: 0 } })).toEqual({ ok: true });
      const cut = fx(forwardPages());
      await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page([post(F, P_MODEL, { quoteId: CORE })])] }), { fxFetch: cut.fetchFn, plain }));
      expect(cut.asked).toEqual([]);
      expect(plain).toHaveBeenCalledTimes(1);

      await db.exec(`truncate public.hunt_submissions, public.hunter_posts cascade; update public.hunter_accounts set newest_id = null, oldest_id = null, exhausted = false`);
      expect(await saveMode(supabase, { handle: "hexmethod", mode: "manual", recipe: {} })).toEqual({ ok: true });
      const reply = post(sf(NOW - 3 * DAY, 9), P_REPLY, { photos: [], replyingTo: F });
      const manual = fx(forwardPages());
      await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page([forwardPost()])], replies: { [F]: [reply] } }), { fxFetch: manual.fetchFn, plain }));
      expect(manual.asked).toEqual([]);
      expect(plain).toHaveBeenCalledTimes(2);
    });

    it("reads every post as its own without FxTwitter's fetch, and a post that names a core but is the core is read on", async () => {
      await add();
      const x = fakeX({ pages: [page([post(MINE, P_MODEL, { quoteId: CORE })])] });
      const got = await playCreator(supabase, "hexmethod", undefined, deps(x));
      expect(got.status === 200 && got.summary).toMatchObject({ found: 1, queued: 1 });
      const [sub] = await rows<{ preview: { hunt: HuntFacts } }>(`select preview from public.hunt_submissions`);
      expect(sub.preview.hunt.reach?.core.likes).toBe(50);
      await db.exec(`truncate public.hunt_submissions, public.hunter_posts cascade; update public.hunter_accounts set newest_id = null, oldest_id = null, exhausted = false`);
      // The status read says the post quotes nothing: the chain ends where it began.
      const { fetchFn, asked } = fx({ [`/status/${MINE}`]: fxPost(MINE, FORWARD, HEX_FX) });
      const again = await playCreator(supabase, "hexmethod", undefined, deps(fakeX({ pages: [page([post(MINE, FORWARD, { quoteId: CORE })])] }), { fxFetch: fetchFn }));
      expect(again.status === 200 && again.summary).toMatchObject({ found: 0, skipped: { no_prompt: 1 } });
      expect(asked).toEqual([`/status/${MINE}`]);
    });
  });
});

describe("before SQL 56", () => {
  it("says the creator hunter is not ready and writes nothing", async () => {
    const db = await PGlite.create();
    await db.exec(`create role anon; create role authenticated; create table public.users (id uuid primary key default gen_random_uuid());
      create table public.hunt_submissions (id uuid primary key default gen_random_uuid());`);
    await db.exec(migration("2026-10-14-prompt-hunter.sql"));
    const client = pglitePostgrest(db).client as unknown as SupabaseClient;
    expect(await loadCreators(client)).toEqual({ ready: false, creators: [] });
    expect(await saveCreator(client, { handle: "hex", config: {}, catalogue: CATALOGUE })).toMatchObject({ ok: false, status: 500 });
    expect((await db.query(`select 1 from public.hunter_accounts`)).rows).toHaveLength(0);
    await db.close();
  }, 30_000);
});
