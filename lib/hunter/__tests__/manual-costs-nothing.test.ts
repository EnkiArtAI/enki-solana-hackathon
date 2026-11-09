import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";
import type { SupabaseClient } from "@supabase/supabase-js";
import { pglitePostgrest } from "@/lib/__tests__/_pglite-postgrest";
import { resetKeyringCache } from "@/lib/crypto";
import { defaultCreatorDeps, playCreator, type CreatorDeps, type PlayResult } from "../creator-run";
import { addLinkManually, linkSettled, queueLink } from "../manual-link";
import { outcomeWords } from "../creator-types";
import { saveMode } from "../creators";

/**
 * Kev, 2026-11-03: "ich möchte im manual form $0 haben, wenn ich nen prompt einfach reinladen kann." Every path a manual
 * find goes through, on the real playCreator and addLinkManually with the real default deps (FxTwitter's reader, the real
 * judge, distill and plain import): the only stub is globalThis.fetch, which counts every request by host and answers
 * any host but FxTwitter's and X's picture CDN with a failure. The controls show the counts go up when a Play is auto.
 */
const ROOT = join(__dirname, "..", "..", "..");
const migration = (f: string) => readFileSync(join(ROOT, "migrations", f), "utf8").split("\r\n").join("\n");
const ADMIN = "00000000-0000-4000-8000-000000000001";
const sf = (ms: number, n = 0) => ((BigInt(ms - 1288834974657) << BigInt(22)) + BigInt(n)).toString();
const DAY = 24 * 60 * 60 * 1000;
const A = sf(Date.now() - 3 * DAY, 1), B = sf(Date.now() - 4 * DAY, 1), C = sf(Date.now() - 5 * DAY, 1);
/** Words the heuristics are unsure of: an auto Play asks the model. */
const UNSURE = "hier ist ein gratis prompt für Portraits:\n\nA cinematic portrait of an old [profession] in a Lisbon tram, golden hour, film grain --ar 4:5\n\nFollow me for more 🔁";
const FREE_HOSTS = ["api.fxtwitter.com", "pbs.twimg.com"];
const WHO = { alice: "101", bob: "102", carol: "103" } as const;
type Who = keyof typeof WHO;

const author = (who: Who) => ({ id: WHO[who], name: who, screen_name: who });
const status = (id: string, text: string, who: Who, quote?: string) => ({
  id, url: `https://x.com/${who}/status/${id}`, text, likes: 1, reposts: 0, quotes: 0, author: author(who),
  media: { photos: [{ url: `https://pbs.twimg.com/media/${id}.jpg` }] }, replying_to: null, quote: quote ? { id: quote } : null,
});

describe("a Play or a link in manual mode costs $0", () => {
  let db: PGlite;
  let supabase: SupabaseClient;
  let hosts: Record<string, number>;
  let pages: Record<string, unknown>;
  let calls: { distill: number; judge: number; plain: number };

  const deps = (): CreatorDeps => {
    const real = defaultCreatorDeps(supabase, new NextRequest("http://enki.test/api/admin"));
    return {
      ...real,
      distill: (s) => { calls.distill += 1; return real.distill(s); },
      judge: (...a) => { calls.judge += 1; return real.judge(...a); },
      plain: (...a) => { calls.plain += 1; return real.plain(...a); },
      sleep: async () => {},
    };
  };
  const list = async (who: Who, mode: "auto" | "recipe" | "manual", recipe: unknown = {}) => {
    await db.query(`insert into public.hunter_accounts (handle, added_by, words) values ($1, $2, '{}') on conflict do nothing`, [who, ADMIN]);
    expect(await saveMode(supabase, { handle: who, mode, recipe })).toEqual({ ok: true });
  };
  /** A forwards B forwards C, as FxTwitter answers it, with C's text as given. */
  const chain = (core = UNSURE) => {
    const a = status(A, "Love this one, go try it!", "alice", B);
    const b = status(B, "Wow, look at this one!", "bob", C);
    const c = status(C, core, "carol");
    pages = {
      ...pages,
      "/2/profile/alice": { user: author("alice") }, "/2/profile/bob": { user: author("bob") }, "/2/profile/carol": { user: author("carol") },
      "/2/profile/alice/media": { results: [a], cursor: null },
      [`/2/status/${A}`]: { status: a }, [`/2/status/${B}`]: { status: b }, [`/2/status/${C}`]: { status: c },
      [`/status/${A}`]: { tweet: a }, [`/status/${B}`]: { tweet: b }, [`/status/${C}`]: { tweet: c },
    };
  };
  const rows = async <T = Record<string, unknown>>(sql: string) => (await db.query<T>(sql)).rows;
  const paid = () => Object.keys(hosts).filter((h) => !FREE_HOSTS.includes(h));
  /** Nothing asked and nothing billed, on the summary, the rows and the wire; and the wire was in use. */
  const nothingSpent = async (got: PlayResult) => {
    expect(calls).toMatchObject({ distill: 0, judge: 0 });
    expect(paid()).toEqual([]);
    expect(hosts["api.fxtwitter.com"]).toBeGreaterThan(0);
    expect(hosts["pbs.twimg.com"]).toBeGreaterThan(0);
    expect(got.status === 200 && got.summary.estUsd).toBe(0);
    expect(got.status === 200 && got.summary.spentUsd).toBe(0);
    expect(got.status === 200 && got.summary.followedUsd).toBeUndefined();
    expect(got.status === 200 && got.summary.usage).toMatchObject({ distills: 0, checks: 0, photos: 0, publishes: 0 });
    expect(await rows(`select handle from public.hunter_accounts where spent_usd <> 0`)).toEqual([]);
    expect(await rows(`select id from public.hunter_runs where est_usd <> 0`)).toEqual([]);
  };
  const finds = () => rows<{ id: string; source_author_handle: string; status: string; hunter_user_id: string; preview: { prompt: string; hunt: { how: string; from?: string; raw?: string; reach: { chain: { posts: number } } } } }>(`select id, source_author_handle, status, hunter_user_id, preview from public.hunt_submissions`);

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
      create table public.hunt_submissions (id uuid primary key default gen_random_uuid(), hunter_user_id uuid not null, source_url text,
        normalized_source_url text, source_platform text, source_author_id text, source_author_handle text, suggested_title text,
        suggested_tags text[] not null default '{}', status text not null default 'pending', minted_prompt_id uuid,
        claimed_by_user_id uuid, claimed_at timestamptz, submitted_at timestamptz not null default now());
      create table public.hunter_config (id smallint primary key default 1 check (id = 1), enabled boolean not null default false,
        mode text not null default 'queue', daily_posts integer not null default 400, min_likes integer not null default 20,
        per_author_daily integer not null default 3, accounts text[] not null default '{}', account_ids jsonb not null default '{}',
        last_post_ids jsonb not null default '{}', publisher_user_id uuid, updated_at timestamptz not null default now(), updated_by uuid);
      insert into public.hunter_config (id) values (1);
      create table public.automod_events (prompt_hash text, category text, matched_rules text[]);
      create table public.models (name text, media_type text, active boolean);
      insert into public.models values ('Nano Banana Pro', 'image', true);
    `);
    for (const f of ["2026-10-29-auto-handles.sql", "2026-10-14-prompt-hunter.sql", "2026-10-30-creator-hunter.sql", "2026-11-01-hunter-modes.sql", "2026-11-03-hunter-parked.sql"]) await db.exec(migration(f));
    supabase = pglitePostgrest(db).client as unknown as SupabaseClient;
  }, 60_000);
  afterAll(async () => { await db.close(); });

  beforeEach(async () => {
    await db.exec(`truncate public.users, public.auth_identities, public.user_wallets, public.hunt_submissions, public.hunter_accounts, public.hunter_posts, public.hunter_runs, public.hunter_parked cascade`);
    hosts = {};
    pages = {};
    calls = { distill: 0, judge: 0, plain: 0 };
    process.env.FIELD_ENCRYPTION_KEY_B64 = randomBytes(32).toString("base64");
    resetKeyringCache();
    delete process.env.OPENAI_API_KEYS;
    process.env.OPENAI_API_KEY = "test-key";
    vi.stubGlobal("fetch", (async (input: unknown) => {
      const url = new URL(String(input));
      hosts[url.host] = (hosts[url.host] ?? 0) + 1;
      if (url.host === "pbs.twimg.com") return new Response(Buffer.from("a picture"), { status: 200, headers: { "content-type": "image/jpeg" } });
      if (url.host !== "api.fxtwitter.com") return new Response("{}", { status: 500 });
      if (pages[url.pathname] === 404) return new Response("{}", { status: 404 });
      if (url.pathname in pages) return Response.json(pages[url.pathname]);
      if (url.pathname.startsWith("/2/conversation/")) return Response.json({ replies: [] });
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("a manual Play over A forwards B forwards C, B and C listed and auto: no model, no provider, $0, the find queued under C", async () => {
    await list("alice", "manual");
    await list("bob", "auto");
    await list("carol", "auto");
    chain();
    const got = await playCreator(supabase, "alice", undefined, deps());
    await nothingSpent(got);
    expect(got.status === 200 && got.summary).toMatchObject({ found: 0, queued: 0, skipped: { forwarded: 1 }, stopped: "done" });
    expect(calls.plain).toBe(1);

    const carol = await rows<{ id: string }>(`select id from public.users where imported_x_id = '103'`);
    const [find, ...more] = await finds();
    expect(more).toEqual([]);
    expect(find).toMatchObject({ source_author_handle: "carol", status: "pending", hunter_user_id: carol[0].id, preview: { hunt: { how: "manual", reach: { chain: { posts: 3 } } } } });
    expect(find.preview.prompt).toContain("A cinematic portrait of an old");
    expect((await rows(`select post_id, handle, outcome from public.hunter_posts order by post_id`)).sort((x, y) => String(x.post_id).localeCompare(String(y.post_id)))).toEqual(
      [{ post_id: A, handle: "alice", outcome: "forwarded" }, { post_id: C, handle: "carol", outcome: "queued" }].sort((x, y) => x.post_id.localeCompare(y.post_id)),
    );
    // The hop is read, not played: no account, nothing on its count; C's mode is left as Kev chose it.
    expect(await rows(`select 1 from public.users where imported_x_id = '102'`)).toEqual([]);
    expect(await rows(`select handle, mode, found from public.hunter_accounts order by handle`)).toEqual([
      { handle: "alice", mode: "manual", found: 0 }, { handle: "bob", mode: "auto", found: 0 }, { handle: "carol", mode: "auto", found: 1 },
    ]);
  });

  it("control: the same chain in an auto Play asks the model and reaches the provider", async () => {
    await list("alice", "auto");
    await list("bob", "auto");
    await list("carol", "auto");
    chain();
    await playCreator(supabase, "alice", undefined, deps());
    expect(calls.distill).toBeGreaterThan(0);
    expect(paid()).toEqual(["api.openai.com"]);
  });

  it("a recipe Play spends nothing either: a core on auto taken whole, a core with its own recipe cut by it", async () => {
    await list("alice", "recipe", { from: "text", after: "no such marker", before: "", titleLine: 0 });
    await list("bob", "auto");
    await list("carol", "auto");
    chain();
    const whole = await playCreator(supabase, "alice", undefined, deps());
    await nothingSpent(whole);
    expect((await finds())[0]).toMatchObject({ source_author_handle: "carol", preview: { hunt: { how: "manual" } } });

    await db.exec(`truncate public.hunt_submissions, public.hunter_posts cascade; update public.hunter_accounts set newest_id = null, oldest_id = null, exhausted = false`);
    await list("alice", "manual");
    await list("carol", "recipe", { from: "text", after: "Portraits:", before: "Follow me", titleLine: 0 });
    calls = { distill: 0, judge: 0, plain: 0 };
    const cut = await playCreator(supabase, "alice", undefined, deps());
    await nothingSpent(cut);
    expect((await finds())[0]).toMatchObject({ source_author_handle: "carol", preview: { hunt: { how: "recipe" } } });
    expect((await finds())[0].preview.prompt.startsWith("A cinematic portrait")).toBe(true);
    expect((await finds())[0].preview.prompt).not.toContain("Follow me");
  });

  it("the spend caps hold neither a manual Play, nor the core it plays: $0 stays $0", async () => {
    await list("alice", "manual");
    await list("carol", "auto");
    await list("bob", "auto");
    await db.exec(`update public.hunter_accounts set spend_cap_usd = 0`);
    chain();
    const got = await playCreator(supabase, "alice", undefined, deps());
    await nothingSpent(got);
    expect(got.status === 200 && got.summary).toMatchObject({ skipped: { forwarded: 1 }, stopped: "done" });
    expect((await finds()).map((f) => f.source_author_handle)).toEqual(["carol"]);
  });

  // Every door: an added link goes through the real reader, the real Play and the real table.
  it("Add link parks a post with a video by every address and one with no media, says so, and queues nothing, for $0", async () => {
    await list("carol", "manual");
    const video = { id: "v", url: "https://video.twimg.com/v/720.mp4", thumbnail_url: "https://pbs.twimg.com/t/v.jpg", duration: 9.5, width: 720, height: 1280, type: "video", formats: [{ url: "https://video.twimg.com/v/a.m3u8", container: "m3u8" }] };
    const words = `Prompt: ${UNSURE}`;
    const v2 = (id: string, media: unknown) => ({ status: { ...status(id, words, "carol"), media } });
    const v1 = (id: string, media: unknown) => ({ tweet: { url: `https://x.com/carol/status/${id}`, text: words, author: author("carol"), media, replying_to_status: null } });
    const clip = sf(Date.now() - 5 * DAY, 11), bare = sf(Date.now() - 5 * DAY, 12);
    pages = { [`/status/${clip}`]: v1(clip, {}), [`/2/status/${clip}`]: v2(clip, { videos: [video] }), [`/status/${bare}`]: v1(bare, {}), [`/2/status/${bare}`]: v2(bare, {}) };
    const saved = await addLinkManually(supabase, `https://x.com/carol/status/${clip}`, ADMIN, deps());
    expect(saved.status === 200 && saved.summary.skipped).toEqual({ video_only: 1 });
    expect(saved.status === 200 && saved.summary.estUsd).toBe(0);
    const none = await addLinkManually(supabase, `https://x.com/carol/status/${bare}`, ADMIN, deps());
    expect(none.status === 200 && none.summary.skipped).toEqual({ no_media: 1 });
    expect(none.status === 200 && none.summary.estUsd).toBe(0);
    expect(calls).toEqual({ distill: 0, judge: 0, plain: 0 });
    // Only addresses: no video and no picture is fetched for a saved post.
    expect(Object.keys(hosts)).toEqual(["api.fxtwitter.com"]);
    expect(await finds()).toEqual([]);
    expect(await rows(`select post_id, handle, kind, videos from public.hunter_parked order by kind`)).toEqual([
      { post_id: bare, handle: "carol", kind: "no_media", videos: [] }, { post_id: clip, handle: "carol", kind: "video", videos: [video] },
    ]);
    expect((await rows(`select post_id, outcome from public.hunter_posts order by outcome`))).toEqual([{ post_id: bare, outcome: "no_media" }, { post_id: clip, outcome: "video_only" }]);
  });

  it("Add link on one reply reads the author's other replies too: their video is saved, the linked reply stays the prompt's place", async () => {
    await list("carol", "manual");
    const ROOT = sf(Date.now() - 5 * DAY, 20), CLIP = sf(Date.now() - 5 * DAY, 21), LINKED = sf(Date.now() - 5 * DAY, 22);
    const video = { id: "v", url: "https://video.twimg.com/v/720.mp4" };
    const PROMPT = "A cinematic portrait of an old sailor in a Lisbon tram, golden hour, film grain --ar 4:5";
    const root = status(ROOT, "New set, prompt in the comments", "carol");
    const clip = { ...status(CLIP, `And the clip, with a long word on how it was made: ${"so ".repeat(60)}`, "carol"), media: { videos: [video] }, replying_to: { status: ROOT } };
    const linked = { ...status(LINKED, PROMPT, "carol"), media: {}, replying_to: { status: ROOT } };
    pages = {
      [`/status/${LINKED}`]: { tweet: { ...linked, replying_to_status: ROOT } }, [`/2/status/${LINKED}`]: { status: linked },
      [`/status/${ROOT}`]: { tweet: root }, [`/2/status/${ROOT}`]: { status: root },
      [`/2/conversation/${ROOT}`]: { replies: [clip, linked] },
    };
    const got = await addLinkManually(supabase, `https://x.com/carol/status/${LINKED}`, ADMIN, deps());
    expect(got.status === 200 && got.summary).toMatchObject({ queued: 1, usage: { videos: 1 } });
    expect(await rows(`select post_id, kind, videos, replies from public.hunter_parked`)).toMatchObject([{ post_id: ROOT, kind: "video", videos: [{ ...video, reply_id: CLIP }], replies: [{ id: LINKED }, { id: CLIP }] }]);
    expect((await finds())[0].preview.prompt).toBe(PROMPT);
    // The same link under a recipe with no marker, which takes the longest reply: the reply the link named comes first.
    await db.exec(`truncate public.hunt_submissions, public.hunter_parked, public.hunter_posts cascade`);
    await list("carol", "recipe", { from: "reply", after: "", before: "", titleLine: 0 });
    const recipe = await addLinkManually(supabase, `https://x.com/carol/status/${LINKED}`, ADMIN, deps());
    expect(recipe.status === 200 && recipe.summary.queued).toBe(1);
    expect((await finds())[0].preview).toMatchObject({ prompt: PROMPT, hunt: { how: "recipe" } });
  });

  it("Add link on a reply of a reply takes the thread's first post: every video in the thread saved, never outcome reply", async () => {
    await list("carol", "manual");
    const ROOT = sf(Date.now() - 5 * DAY, 30), R1 = sf(Date.now() - 5 * DAY, 31), R2 = sf(Date.now() - 5 * DAY, 32);
    const clip = (id: string) => ({ id: `v${id}`, url: `https://video.twimg.com/v/${id}.mp4` });
    const PROMPT = "A cinematic portrait of an old sailor in a Lisbon tram, golden hour, film grain --ar 4:5";
    const root = status(ROOT, "New set, prompt in the comments", "carol");
    const r1 = { ...status(R1, "first clip", "carol"), media: { videos: [clip(R1)] }, replying_to: { status: ROOT } };
    const r2 = { ...status(R2, PROMPT, "carol"), media: { videos: [clip(R2)] }, replying_to: { status: R1 } };
    pages = {
      [`/status/${R2}`]: { tweet: { ...r2, replying_to_status: R1 } }, [`/2/status/${R2}`]: { status: r2 },
      [`/status/${R1}`]: { tweet: { ...r1, replying_to_status: ROOT } }, [`/2/status/${R1}`]: { status: r1 },
      [`/status/${ROOT}`]: { tweet: root }, [`/2/status/${ROOT}`]: { status: root },
      [`/2/conversation/${ROOT}`]: { replies: [r2, r1] },
    };
    const got = await addLinkManually(supabase, `https://x.com/carol/status/${R2}`, ADMIN, deps());
    expect(got.status === 200 && got.summary).toMatchObject({ queued: 1, skipped: {}, usage: { videos: 2 } });
    expect(await rows(`select post_id, kind, videos from public.hunter_parked`)).toMatchObject([{ post_id: ROOT, kind: "video", videos: [{ id: clip(R2).id, reply_id: R2 }, { id: clip(R1).id, reply_id: R1 }] }]);
    expect((await finds())[0].preview.prompt).toBe(PROMPT);
    expect(await rows(`select post_id, outcome from public.hunter_posts`)).toEqual([{ post_id: ROOT, outcome: "queued" }]);
  });

  it("Add link again never lowers a saved row: the reply's video stays, whatever the second read sees", async () => {
    await list("carol", "manual");
    const POST = sf(Date.now() - 5 * DAY, 40), R1 = sf(Date.now() - 5 * DAY, 41), R2 = sf(Date.now() - 5 * DAY, 42);
    const video = { id: "v", url: "https://video.twimg.com/v/720.mp4" };
    const words = "Words of the post, without a picture, long enough to be read as something at all";
    const bare = { ...status(POST, words, "carol"), media: {} };
    const clip = { ...status(R1, "the clip", "carol"), media: { videos: [video] }, replying_to: { status: POST } };
    const other = { ...status(R2, "and a thanks", "carol"), media: {}, replying_to: { status: POST } };
    const base = { [`/status/${POST}`]: { tweet: bare }, [`/2/status/${POST}`]: { status: bare } };
    const saved = () => rows<{ kind: string; why: string; videos: unknown; replies: { id: string }[] }>(`select kind, why, videos, replies from public.hunter_parked`);
    pages = { ...base, [`/2/conversation/${POST}`]: { replies: [clip] } };
    const first = await addLinkManually(supabase, `https://x.com/carol/status/${POST}`, ADMIN, deps());
    expect(first.status === 200 && first.summary.skipped).toEqual({ video_only: 1 });
    // The next read sees only the other reply: it is added, and the video and the kind stay.
    pages = { ...base, [`/2/conversation/${POST}`]: { replies: [other] } };
    const second = await addLinkManually(supabase, `https://x.com/carol/status/${POST}`, ADMIN, deps());
    expect(second.status === 200 && second.summary.skipped).toEqual({ video_only: 1 });
    const [row] = await saved();
    expect(row).toMatchObject({ kind: "video", why: "no picture", videos: [{ ...video, reply_id: R1 }] });
    expect(row.replies.map((r) => r.id)).toEqual([R1, R2]);
    expect(await rows(`select outcome from public.hunter_posts`)).toEqual([{ outcome: "video_only" }]);
    // The same video read again is one video, and a no-media row that gains a video becomes a video row.
    pages = { ...base, [`/2/conversation/${POST}`]: { replies: [clip] } };
    await addLinkManually(supabase, `https://x.com/carol/status/${POST}`, ADMIN, deps());
    expect((await saved())[0].videos).toEqual([{ ...video, reply_id: R1 }]);
    await db.exec(`truncate public.hunter_parked, public.hunter_posts cascade`);
    pages = { ...base, [`/2/conversation/${POST}`]: { replies: [] } };
    const none = await addLinkManually(supabase, `https://x.com/carol/status/${POST}`, ADMIN, deps());
    expect(none.status === 200 && none.summary.skipped).toEqual({ no_media: 1 });
    expect((await saved())[0]).toMatchObject({ kind: "no_media", videos: [] });
    pages = { ...base, [`/2/conversation/${POST}`]: { replies: [clip] } };
    await addLinkManually(supabase, `https://x.com/carol/status/${POST}`, ADMIN, deps());
    expect((await saved())[0]).toMatchObject({ kind: "video", why: "no picture", videos: [{ ...video, reply_id: R1 }] });
  });

  it("Add link whose conversation read fails saves nothing and marks nothing, and the link stays in line", async () => {
    await list("carol", "manual");
    const post = { ...status(C, UNSURE, "carol"), media: { photos: [] } };
    pages = { [`/2/status/${C}`]: { status: post }, [`/status/${C}`]: { tweet: post }, [`/2/conversation/${C}`]: 404 };
    const got = await addLinkManually(supabase, `https://x.com/carol/status/${C}`, ADMIN, deps());
    expect(got).toMatchObject({ status: 503, handle: "carol" });
    expect(linkSettled(got)).toBe(false);
    expect(await rows(`select post_id from public.hunter_parked`)).toEqual([]);
    expect(await rows(`select post_id from public.hunter_posts`)).toEqual([]);
  }, 20_000);

  it("a manual Play reads the author's replies through FxTwitter, and takes them with the post, for $0", async () => {
    await list("carol", "manual");
    const post = status(C, "New set, prompt in the comments 👇", "carol");
    const reply = { ...status(sf(Date.now() - 5 * DAY, 2), `Prompt: ${UNSURE}`, "carol"), replying_to: { status: C } };
    pages = { "/2/profile/carol": { user: { ...author("carol"), avatar_url: "https://pbs.twimg.com/profile_images/1/a_normal.jpg" } }, "/2/profile/carol/media": { results: [post], cursor: null }, [`/2/conversation/${C}`]: { replies: [reply] } };
    const got = await playCreator(supabase, "carol", undefined, deps());
    expect(got.status === 200 && got.summary).toMatchObject({ found: 1, queued: 1, usage: { replies: 1, users: 1 } });
    await nothingSpent(got);
    expect((await finds())[0].preview.prompt).not.toContain("New set, prompt in the comments");
    expect((await finds())[0].preview.prompt).toContain("A cinematic portrait of an old");
    expect((await finds())[0].preview.hunt).toMatchObject({ from: "reply", raw: expect.stringContaining("New set, prompt in the comments") });
    // The lookup and the account's picture went through FxTwitter and X's CDN: nothing of X's paid API.
    expect((await rows(`select avatar_url from public.users where imported_x_id = '103'`))[0]).toEqual({ avatar_url: "https://pbs.twimg.com/profile_images/1/a_400x400.jpg" });
  });

  it("Add link on a manual creator, a post of theirs or a forward to one, costs $0 with the find queued", async () => {
    await list("carol", "manual");
    chain();
    const own = await addLinkManually(supabase, `https://x.com/carol/status/${C}`, ADMIN, deps());
    expect(own.status === 200 && own.summary).toMatchObject({ found: 1, queued: 1 });
    await nothingSpent(own);

    await db.exec(`truncate public.hunt_submissions, public.hunter_posts cascade`);
    const through = await addLinkManually(supabase, `https://x.com/alice/status/${A}`, ADMIN, deps());
    expect(through.handle).toBe("carol");
    expect(through.status === 200 && through.summary).toMatchObject({ found: 1, queued: 1 });
    await nothingSpent(through);
    expect((await finds()).map((f) => f.source_author_handle)).toEqual(["carol"]);
  });

  // Review 2026-11-03: the read failing made huntModeOf(undefined) answer auto, and the round asked the model.
  it("a failed read of the creator's mode plays nothing: no hold, no run row, no reader, no model", async () => {
    await list("alice", "manual");
    chain();
    const failing = new Proxy(supabase, {
      get: (t, k) => k !== "from" ? Reflect.get(t, k) : (table: string) => {
        const q = t.from(table);
        return table !== "hunter_accounts" ? q : new Proxy(q, {
          get: (b, m) => m !== "select" ? Reflect.get(b, m) : (cols: string, ...rest: []) => b.select(cols === "mode, recipe" ? "no_such_column" : cols, ...rest),
        });
      },
    });
    const got = await playCreator(failing, "alice", undefined, deps());
    expect(got).toEqual({ status: 500, error: "The mode of @alice could not be read: nothing was played. Press Play again." });
    expect(calls).toEqual({ distill: 0, judge: 0, plain: 0 });
    expect(hosts).toEqual({});
    expect(await rows(`select playing_since from public.hunter_accounts`)).toEqual([{ playing_since: null }]);
    expect(await rows(`select 1 from public.hunter_runs`)).toEqual([]);
  });

  it("putting a link in line reads FxTwitter alone", async () => {
    chain();
    expect(await queueLink(supabase, `https://x.com/carol/status/${C}`, ADMIN)).toEqual({ status: 200, handle: "carol" });
    expect(Object.keys(hosts)).toEqual(["api.fxtwitter.com"]);
    expect(calls).toEqual({ distill: 0, judge: 0, plain: 0 });
  });

  // Review 2026-11-03: the chain may end elsewhere at "Play links" than when the link was put in line.
  describe("Play links, when the chain ends elsewhere now", () => {
    const waiting = (post: string, who: Who) => db.query(`insert into public.hunter_posts (post_id, handle, author_id, outcome) values ($1, $2, $3, 'waiting')`, [post, who, WHO[who]]);
    /** A's post has words of its own, and what it quotes is gone: its author is the core now. */
    const coreGone = () => {
      const a = status(A, UNSURE, "alice", C);
      pages = { [`/2/status/${A}`]: { status: a }, [`/status/${A}`]: { tweet: a }, [`/2/status/${C}`]: 404 as never };
    };
    const stayed = async (under: Who, outcome: string) => {
      expect(await rows(`select post_id, handle, outcome from public.hunter_posts`)).toEqual([{ post_id: A, handle: under, outcome }]);
      expect(await rows(`select 1 from public.users`)).toEqual([]);
      expect(await finds()).toEqual([]);
      expect(calls).toEqual({ distill: 0, judge: 0, plain: 0 });
      expect(paid()).toEqual([]);
      expect(await rows(`select 1 from public.hunter_runs`)).toEqual([]);
    };

    it("its core deleted, the forwarder not on the list: nobody listed, no account, no model; the post marked, the line left", async () => {
      await list("carol", "manual");
      coreGone();
      await waiting(A, "carol");
      const got = await addLinkManually(supabase, `https://x.com/i/status/${A}`, ADMIN, deps(), undefined, "carol");
      expect(got).toEqual({ status: 409, error: "This link leads to @alice now, who is not on your list. Add the link again to list them." });
      expect(linkSettled(got)).toBe(true);
      expect(await rows(`select handle, mode from public.hunter_accounts`)).toEqual([{ handle: "carol", mode: "manual" }]);
      await stayed("carol", "leads_to:alice");
      expect(outcomeWords("leads_to:alice")).toBe("leads to @alice, not on your list");
    });

    it("the chain unread when it went in line, read now: the core's author is not listed for it", async () => {
      await list("alice", "manual");
      chain();
      await waiting(A, "alice");
      const got = await addLinkManually(supabase, `https://x.com/i/status/${A}`, ADMIN, deps(), undefined, "alice");
      expect(got.status).toBe(409);
      expect(await rows(`select handle from public.hunter_accounts`)).toEqual([{ handle: "alice" }]);
      await stayed("alice", "leads_to:carol");
    });

    it("the core's author listed, on auto: no model under a manual creator's press; the link waits under them, for their own press", async () => {
      await list("alice", "manual");
      await list("carol", "auto");
      chain();
      await waiting(A, "alice");
      const got = await addLinkManually(supabase, `https://x.com/i/status/${A}`, ADMIN, deps(), undefined, "alice");
      expect(got).toEqual({ status: 503, error: "This link leads to @carol now: it waits under them, in their mode." });
      expect(linkSettled(got)).toBe(false);
      await stayed("carol", "waiting");
    });

    it("control: the chain ends where it did: played under its creator, in its mode", async () => {
      await list("carol", "manual");
      chain();
      await waiting(C, "carol");
      const got = await addLinkManually(supabase, `https://x.com/i/status/${C}`, ADMIN, deps(), undefined, "CAROL");
      expect(got.status === 200 && got.summary).toMatchObject({ found: 1, queued: 1 });
      await nothingSpent(got);
    });
  });

  // Kev, 2026-11-03: an author nobody set a mode for starts in manual, so a new author's link costs $0.
  describe("an author nobody set a mode for", () => {
    it("Add link's Play: listed in manual, $0, the find queued", async () => {
      chain();
      const got = await addLinkManually(supabase, `https://x.com/carol/status/${C}`, ADMIN, deps());
      expect(got.handle).toBe("carol");
      expect(got.status === 200 && got.summary).toMatchObject({ found: 1, queued: 1 });
      await nothingSpent(got);
      expect(calls).toEqual({ distill: 0, judge: 0, plain: 1 });
      expect(await rows(`select handle, mode from public.hunter_accounts`)).toEqual([{ handle: "carol", mode: "manual" }]);
    });

    it("a link put in line, the core's author new, then Play links: manual at both presses, $0", async () => {
      chain();
      expect(await queueLink(supabase, `https://x.com/alice/status/${A}`, ADMIN)).toEqual({ status: 200, handle: "carol" });
      expect(await rows(`select handle, mode from public.hunter_accounts`)).toEqual([{ handle: "carol", mode: "manual" }]);
      const got = await addLinkManually(supabase, `https://x.com/alice/status/${A}`, ADMIN, deps(), undefined, "carol");
      expect(got.status === 200 && got.summary).toMatchObject({ found: 1, queued: 1 });
      await nothingSpent(got);
      expect(await rows(`select handle, mode from public.hunter_accounts`)).toEqual([{ handle: "carol", mode: "manual" }]);
    });

    it("control: a creator already listed keeps their own mode, on Add link and on Play links (DEC-2026-11-03-19), and auto still asks the model", async () => {
      await list("carol", "auto");
      chain();
      const added = await addLinkManually(supabase, `https://x.com/carol/status/${C}`, ADMIN, deps());
      expect(added.handle).toBe("carol");
      expect(calls.distill).toBe(1);
      expect(paid()).toEqual(["api.openai.com"]);
      expect(await rows(`select handle, mode from public.hunter_accounts`)).toEqual([{ handle: "carol", mode: "auto" }]);
      hosts = {};
      await db.exec(`insert into public.hunter_posts (post_id, handle, outcome) values ('${C}', 'carol', 'waiting') on conflict (post_id) do update set outcome = 'waiting'`);
      await addLinkManually(supabase, `https://x.com/i/status/${C}`, ADMIN, deps(), undefined, "carol");
      expect(calls.distill).toBe(2);
      expect(await rows(`select handle, mode from public.hunter_accounts`)).toEqual([{ handle: "carol", mode: "auto" }]);
      // And one on recipe: the same upsert, the row untouched.
      await list("alice", "recipe", { from: "reply", after: "", before: "", titleLine: 0 });
      await queueLink(supabase, `https://x.com/carol/status/${C}`, ADMIN);
      expect(await rows(`select handle, mode from public.hunter_accounts where handle = 'alice'`)).toEqual([{ handle: "alice", mode: "recipe" }]);
    });

    it("Play links on a link that moved to a new author still lists no one: the first listing is Add link's own (DEC-2026-11-03-19)", async () => {
      await list("alice", "manual");
      chain();
      await db.exec(`insert into public.hunter_posts (post_id, handle, outcome) values ('${A}', 'alice', 'waiting')`);
      const got = await addLinkManually(supabase, `https://x.com/i/status/${A}`, ADMIN, deps(), undefined, "alice");
      expect(got.status).toBe(409);
      expect(await rows(`select handle, mode from public.hunter_accounts`)).toEqual([{ handle: "alice", mode: "manual" }]);
    });
  });
});
