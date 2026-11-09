import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";
import type { SupabaseClient } from "@supabase/supabase-js";
import { pglitePostgrest } from "@/lib/__tests__/_pglite-postgrest";
import { readSource } from "@/lib/__tests__/_read-source";
import { CREATOR_DEFAULTS, outcomeWords, parkedSaid } from "@/lib/hunter/creator-types";
import { loadCreators, saveCreator } from "@/lib/hunter/creators";

/**
 * Add creator in the admin panel (Kev, 2026-10-30: "einen creator reinpacken, such kriterien einstellen, und go"), run
 * the way the page runs it: the page's own payload, read from app/admin/page.tsx, through the real POST /api/admin, on a
 * real Postgres with the hunter's migration and SQL 56. Review 2026-10-30, finding 1: Add sent saveCreator with
 * CREATOR_DEFAULTS, an upsert, so a creator another tab had added lost its spend cap, generator, search and cursors (and
 * X billed the re-read). Add inserts only now. No call to X or any model: vitest.setup.ts makes any fetch throw.
 */
const ROOT = join(__dirname, "..", "..");
const migration = (f: string) => readFileSync(join(ROOT, "migrations", f), "utf8").split("\r\n").join("\n");
const PAGE = readSource(join(ROOT, "app", "admin", "page.tsx"));
const CATALOGUE = ["Flux (free)", "Nano Banana Pro", "GPT-Image-2"];

const h = vi.hoisted(() => ({ client: null as unknown, admin: "00000000-0000-4000-8000-000000000001" }));
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => h.client }));
vi.mock("@/lib/session-user", () => ({ resolveSessionUserId: async () => h.admin }));
// gpt-6-luna's batch answer, as a test sets it (lib/referral/describe-prompt has its own tests).
const named = vi.hoisted(() => ({ asked: [] as string[][], during: null as null | (() => Promise<void>), answer: (ps: string[]) => new Map(ps.map((_, i) => [i, { title: `Named ${i}`, category: "Branding", tags: ["logo", "zzz-not-ours"] }])) }));
vi.mock("@/lib/referral/describe-prompt", async (original) => ({
  ...(await original<typeof import("@/lib/referral/describe-prompt")>()),
  describeMany: async (ps: string[]) => { named.asked.push(ps); await named.during?.(); return named.answer(ps); },
}));
vi.hoisted(() => { process.env.AUTH_PEPPER = Buffer.alloc(32, 7).toString("base64"); });

import { GET, POST } from "../../app/api/admin/route";

/** What the page's addCreator posts, as written in the page (CREATOR_DEFAULTS in scope, as it is there). */
const addPayload = (handle: string): Record<string, unknown> => {
  const from = PAGE.indexOf("if (!(await post(", PAGE.indexOf("const addCreator = async"));
  const src = PAGE.slice(from + "if (!(await post(".length, PAGE.indexOf(', "", (cur) => cur)', from));
  return new Function("handle", "CREATOR_DEFAULTS", `return (${src});`)(handle, CREATOR_DEFAULTS);
};
const press = (body: Record<string, unknown>) =>
  POST(new NextRequest("http://enki.test/api/admin", { method: "POST", body: JSON.stringify(body) }));

describe("Add creator", () => {
  let db: PGlite;
  let supabase: SupabaseClient;
  const OTHER = "00000000-0000-4000-8000-000000000002";
  const account = async (handle: string) =>
    (await db.query<Record<string, unknown>>(`select *, spend_cap_usd::text as cap, spent_usd::text as spent from public.hunter_accounts where handle = $1`, [handle])).rows[0];

  beforeAll(async () => {
    db = await PGlite.create({ extensions: { citext } });
    await db.exec(`
      create extension citext;
      create role anon; create role authenticated; create role service_role bypassrls;
      create table public.users (id uuid primary key default gen_random_uuid(), handle public.citext, origin text, role text,
        display_name text, avatar_url text, deleted_at timestamptz);
      alter table public.users add constraint users_origin_check check (origin in ('email', 'wallet', 'agent', 'google', 'x'));
      create table public.auth_identities (provider text not null, subject text not null, user_id uuid not null, primary key (provider, subject));
      create table public.hunt_submissions (id uuid primary key default gen_random_uuid(), hunter_user_id uuid, status text not null default 'pending');
      create table public.admin_actions (id bigserial primary key, actor_id uuid, actor_role text, action text, target text, detail jsonb, ip_hash text,
        created_at timestamptz not null default now());
      create table public.hunter_config (id smallint primary key default 1 check (id = 1), enabled boolean not null default false,
        mode text not null default 'queue', daily_posts integer not null default 400, min_likes integer not null default 20,
        per_author_daily integer not null default 3, accounts text[] not null default '{}', account_ids jsonb not null default '{}',
        last_post_ids jsonb not null default '{}', publisher_user_id uuid, updated_at timestamptz not null default now(), updated_by uuid);
      insert into public.hunter_config (id) values (1);
    `);
    for (const f of ["2026-10-14-prompt-hunter.sql", "2026-10-30-creator-hunter.sql", "2026-11-03-hunter-parked.sql"]) await db.exec(migration(f));
    supabase = pglitePostgrest(db).client as unknown as SupabaseClient;
    h.client = supabase;
  }, 60_000);
  afterAll(async () => { await db.close(); });
  beforeEach(async () => {
    await db.exec(`truncate public.users, public.hunter_accounts, public.hunter_posts, public.hunter_runs, public.admin_actions cascade;`);
    await db.query(`insert into public.users (id, handle, role) values ($1, 'kev', 'admin'), ($2, 'other', 'admin')`, [h.admin, OTHER]);
  });

  it("answers the retired list run with 410 and reads nothing (Kev, 2026-10-30: \"a schalte ab den listen-run\")", async () => {
    await db.query(`insert into public.hunter_accounts (handle, added_by) values ('hexmethod', $1)`, [h.admin]);
    const res = await press({ resource: "hunter", action: "run" });
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: "The list run is retired: Play a creator in the Prompt Hunter tab." });
    expect((await db.query(`select 1 from public.hunter_runs`)).rows).toHaveLength(0);
  });

  it("rejects a find whose X author joined Enki, instead of publishing it on the imported account (Kev, 2026-10-30)", async () => {
    await db.exec(`alter table public.hunt_submissions add column if not exists decided_at timestamptz, add column if not exists decided_by uuid,
      add column if not exists minted_prompt_id uuid, add column if not exists rejection_reason text; truncate public.auth_identities, public.hunt_submissions;`);
    const XID = "1500000000000000001";
    const THEM = "00000000-0000-4000-8000-000000000003";
    const preview = (xUserId: string) => JSON.stringify({
      prompt: "A cinematic portrait of a lighthouse keeper at dawn", title: "Lighthouse keeper", category: "Characters", tags: [], adult: false,
      generators: [], photos: [], source: { url: "https://x.com/hexmethod/status/1", handle: "hexmethod" },
      hunt: { from: "text", how: "label", replyUrl: null, generatorFrom: "all", foreignGenerator: null, videosSkipped: 0, creator: { handle: "hexmethod", xUserId } },
    });
    await db.query(`insert into public.users (id, handle, origin) values ($1, 'realhex', 'x')`, [THEM]);
    await db.query(`insert into public.auth_identities (provider, subject, user_id) values ('x', $1, $2)`, [XID, THEM]);
    const { rows: [find] } = await db.query<{ id: string }>(
      `insert into public.hunt_submissions (hunter_user_id, preview_token, preview) values ($1, 'sealed', $2) returning id::text`, [OTHER, preview(XID)]);
    const res = await press({ resource: "imports", action: "approve", ids: [find.id] });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "0 published, 1 rejected: @hexmethod is on Enki as @realhex now: theirs to publish." });
    expect((await db.query(`select 1 from public.hunt_submissions`)).rows).toEqual([]);
  });

  describe("the Videos and No media tabs' read (Kev, 2026-11-03)", () => {
    const read = (q: string) => GET(new NextRequest(`http://enki.test/api/admin?${q}`));
    const parkedRow = (id: string, kind: string, at: string, o: { videos?: unknown[]; replies?: unknown[] } = {}) => db.query(
      `insert into public.hunter_parked (post_id, kind, handle, url, post_text, replies, videos, why, read_at) values ($1, $2, 'hexmethod', 'javascript:alert(1)', 'words of ' || $1, $3, $4, 'no picture', $5)`,
      [id, kind, JSON.stringify(o.replies ?? []), JSON.stringify(o.videos ?? []), at]);

    it("pages one kind newest first, says what is saved in the address's place, and whether its find waits or is out", async () => {
      await db.exec(`alter table public.hunt_submissions add column if not exists normalized_source_url text; truncate public.hunt_submissions, public.hunter_parked;`);
      for (let i = 0; i < 53; i++) await parkedRow(String(1000 + i), "video", `2026-11-0${1 + (i % 3)}T00:00:00Z`);
      await parkedRow("2100000000000000000", "video", "2026-11-05T00:00:00Z", {
        replies: [{ id: "7", url: "https://x.com/h/status/7", text: "the steps" }],
        videos: [
          { thumbnail_url: "https://pbs.twimg.com/t.jpg", duration: 12.5, type: "video" },
          { thumbnail_url: "https://evil.example/t.jpg", duration: 0, type: "gif", reply_id: "7" },
          { thumbnail_url: "javascript:alert(1)" },
        ],
      });
      await parkedRow("9", "no_media", "2026-11-06T00:00:00Z");
      await db.query(`insert into public.hunt_submissions (hunter_user_id, status, normalized_source_url) values ($1, 'pending', 'x.com/status/2100000000000000000'), ($1, 'approved', 'x.com/status/1000')`, [OTHER]);
      const first = await (await read("parked=video")).json();
      expect(first).toMatchObject({ ready: true, total: 54 });
      expect(first.rows).toHaveLength(50);
      expect(first.rows[0]).toEqual({
        postId: "2100000000000000000", handle: "hexmethod", link: "https://x.com/hexmethod/status/2100000000000000000", at: expect.stringContaining("2026-11-05"),
        posted: "2026-09-15T23:13:10.770Z", text: "words of 2100000000000000000", why: "no picture", replies: [{ id: "7", text: "the steps" }], find: "pending",
        videos: [{ poster: "https://pbs.twimg.com/t.jpg", duration: 12.5, gif: false, inReply: false }, { poster: null, duration: 0, gif: true, inReply: true }, { poster: null, duration: null, gif: false, inReply: false }],
      });
      const rest = await (await read("parked=video&from=50")).json();
      expect(rest.rows).toHaveLength(4);
      const all = [...first.rows, ...rest.rows].map((r: { postId: string }) => r.postId);
      expect(new Set(all).size).toBe(54);
      expect([...first.rows, ...rest.rows].find((r: { postId: string }) => r.postId === "1000").find).toBe("published");
      expect((await (await read("parked=no_media")).json())).toMatchObject({ total: 1, rows: [{ postId: "9", find: null }] });
      for (const q of ["parked=other", "parked=video&from=-1", "parked=video&from=x"]) expect((await read(q)).status, q).toBe(400);
    });

    it("says the table is missing with no error, and any other failure as one", async () => {
      await db.exec(`alter table public.hunter_parked rename to hunter_parked_gone`);
      try {
        const res = await read("parked=video");
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ready: false, rows: [], total: 0 });
      } finally {
        await db.exec(`alter table public.hunter_parked_gone rename to hunter_parked`);
      }
      await db.exec(`alter table public.hunter_parked rename column post_text to post_text_away`);
      try {
        expect((await read("parked=video")).status).toBe(500);
      } finally {
        await db.exec(`alter table public.hunter_parked rename column post_text_away to post_text`);
      }
    });

    it("leaves the main read of the page alone, and asks admins through the same gate", () => {
      const API = readFileSync(join(__dirname, "..", "..", "app", "api", "admin", "route.ts"), "utf8");
      const main = API.slice(API.indexOf('const missed = await supabase.from("hunt_submissions")'), API.indexOf("function importPreview"));
      expect(main).not.toContain("hunter_parked");
      expect(API.indexOf('req.nextUrl.searchParams.get("parked")')).toBeGreaterThan(API.indexOf("const gate = await requireAdmin(supabase, req);"));
      expect(PAGE).toContain('{tab === "videos" && <ParkedPosts key="video" kind="video" query={query} />}');
      expect(PAGE).toContain('{tab === "nomedia" && <ParkedPosts key="no_media" kind="no_media" query={query} />}');
      expect(PAGE.indexOf('{ id: "imports", label: "Pending imports"')).toBeGreaterThan(-1);
      expect(PAGE.indexOf('{ id: "videos", label: "Videos"')).toBeGreaterThan(PAGE.indexOf('{ id: "imports", label: "Pending imports"'));
      expect(PAGE.indexOf('{ id: "nomedia", label: "No media"')).toBeGreaterThan(PAGE.indexOf('{ id: "videos", label: "Videos"'));
    });
  });

  // Kev, 2026-11-03: "ein prompt soll immer mit bild/video inkludiert sein". One such row waits live: it may not go out by a click.
  it("refuses to publish a find with no picture, with a sentence, and leaves it waiting", async () => {
    await db.exec(`alter table public.hunt_submissions add column if not exists decided_at timestamptz, add column if not exists decided_by uuid,
      add column if not exists minted_prompt_id uuid, add column if not exists rejection_reason text; truncate public.hunt_submissions;`);
    const { rows: [find] } = await db.query<{ id: string }>(
      `insert into public.hunt_submissions (hunter_user_id, preview_token, preview) values ($1, 'sealed', $2) returning id::text`,
      [OTHER, JSON.stringify({ prompt: "A lighthouse keeper at dawn", title: "Lighthouse keeper", photos: [], source: { url: "https://x.com/h/status/1", handle: "h" } })]);
    const res = await press({ resource: "imports", action: "approve", ids: [find.id] });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "0 published, 1 could not be and stay in the queue: This find has no picture: a prompt on Enki always has media. Reject it, or open its post and add a link that has one." });
    expect((await db.query(`select status, decided_at, minted_prompt_id from public.hunt_submissions`)).rows).toEqual([{ status: "pending", decided_at: null, minted_prompt_id: null }]);
  });

  it("answers an added link's whereabouts in words: a saved post, a video, neither", () => {
    expect(parkedSaid({ no_media: 1 })).toBe("It has no picture or video: saved in the No media tab.");
    expect(parkedSaid({ video_only: 1 })).toBe("It has a video and no picture: saved in the Videos tab.");
    expect(parkedSaid({ pictures_failed: 1 })).toBe("Its pictures could not be read just now: saved, and Start over tries it again.");
    expect(outcomeWords("pictures_failed")).toBe("pictures could not be read: Start over tries again");
    expect(parkedSaid({ no_prompt: 1 })).toBeNull();
    expect(readFileSync(join(__dirname, "..", "..", "app", "api", "admin", "route.ts"), "utf8")).toContain("handle: added.handle, said: parkedSaid(added.summary.skipped) });");
  });

  it("deletes a rejected find, so it leaves the queue and its link can be added again (Kev, 2026-10-31)", async () => {
    await db.exec(`truncate public.hunt_submissions; insert into public.hunt_submissions (hunter_user_id, status) values ('${OTHER}', 'pending'), ('${OTHER}', 'approved');`);
    const ids = (await db.query<{ id: string }>(`select id::text from public.hunt_submissions order by status desc`)).rows.map((r) => r.id);
    expect((await press({ resource: "imports", action: "reject", ids, reason: "Other" })).status).toBe(200);
    expect((await db.query(`select status from public.hunt_submissions`)).rows).toEqual([{ status: "approved" }]);
  });

  // Review 2026-11-02: the next post forwarding a rejected core brought it back into the queue, its checks paid again.
  it("keeps a rejected mark for a find that came through a chain, and forgets a find read directly; Start over takes the mark back", async () => {
    await db.query(`insert into public.hunter_accounts (handle, added_by) values ('hexmethod', $1)`, [h.admin]);
    const CHAIN = "00000000-0000-4000-8000-0000000000b1", ALONE = "00000000-0000-4000-8000-0000000000b2", BARE = "00000000-0000-4000-8000-0000000000b3";
    const reach = (posts: number) => JSON.stringify({ hunt: { reach: { core: {}, chain: { posts } } } });
    await db.exec(`truncate public.hunt_submissions;`);
    await db.query(`insert into public.hunt_submissions (id, hunter_user_id, status, preview) values ($1, $4, 'pending', $5), ($2, $4, 'pending', $6), ($3, $4, 'pending', '{}')`, [CHAIN, ALONE, BARE, OTHER, reach(2), reach(1)]);
    await db.query(`insert into public.hunter_posts (post_id, handle, outcome, submission_id) values ('1', 'hexmethod', 'queued', $1), ('2', 'hexmethod', 'queued', $2), ('3', 'hexmethod', 'queued', $3), ('4', 'hexmethod', 'no_prompt', null)`, [CHAIN, ALONE, BARE]);
    expect((await press({ resource: "imports", action: "reject", ids: [CHAIN, ALONE, BARE] })).status).toBe(200);
    expect((await db.query(`select post_id, outcome, submission_id from public.hunter_posts order by post_id`)).rows).toEqual([
      { post_id: "1", outcome: "rejected", submission_id: null }, { post_id: "4", outcome: "no_prompt", submission_id: null },
    ]);
    expect((await press({ resource: "hunter", action: "restart", handle: "hexmethod" })).status).toBe(200);
    expect((await db.query(`select post_id, outcome from public.hunter_posts order by post_id`)).rows).toEqual([{ post_id: "1", outcome: "retry" }, { post_id: "4", outcome: "no_prompt" }]);
  });

  it("starts a creator over, and a rejected find's post is read again by it (Kev, 2026-10-31)", async () => {
    await db.query(`insert into public.hunter_accounts (handle, added_by, newest_id, oldest_id, exhausted, dry, dry_streak) values ('hexmethod', $1, '9', '5', true, true, 30)`, [h.admin]);
    await db.exec(`truncate public.hunt_submissions; insert into public.hunt_submissions (id, hunter_user_id, status) values ('00000000-0000-4000-8000-0000000000b1', '${OTHER}', 'pending');
      insert into public.hunter_posts (post_id, handle, outcome, submission_id) values ('7', 'hexmethod', 'queued', '00000000-0000-4000-8000-0000000000b1'), ('8', 'hexmethod', 'no_prompt', null);`);
    expect((await press({ resource: "imports", action: "reject", id: "00000000-0000-4000-8000-0000000000b1" })).status).toBe(200);
    expect((await db.query(`select post_id from public.hunter_posts`)).rows).toEqual([{ post_id: "8" }]);
    expect((await press({ resource: "hunter", action: "restart", handle: "@HexMethod" })).status).toBe(200);
    expect(await account("hexmethod")).toMatchObject({ newest_id: null, oldest_id: null, exhausted: false, dry: false, dry_streak: 0 });
    await db.query(`update public.hunter_accounts set playing_since = $1 where handle = 'hexmethod'`, [new Date().toISOString()]);
    expect((await press({ resource: "hunter", action: "restart", handle: "hexmethod" })).status).toBe(409);
    expect((await press({ resource: "hunter", action: "restart", handle: "nobody" })).status).toBe(404);
  });

  it("Start over takes back this creator's failure marks, and no other: each stays a line until a Play writes over it (Kev, 2026-11-02)", async () => {
    await db.query(`insert into public.hunter_accounts (handle, added_by) values ('hexmethod', $1), ('other', $1)`, [h.admin]);
    const settled = ["queued", "published", "publish_failed", "waiting", "duplicate", "no_prompt", "too_long", "video_only", "refused", "reply", "below_likes", "author_cap", "unchecked", "not_saved"];
    const posts = [...settled, "distill_failed", "reply_missing", "follow_failed", "leads_to:voxxivicious"];
    const takenBack = [...settled, "retry", "retry", "retry", "retry"];
    for (const [i, outcome] of posts.entries()) await db.query(`insert into public.hunter_posts (post_id, handle, outcome) values ($1, 'hexmethod', $2)`, [String(i), outcome]);
    await db.exec(`insert into public.hunter_posts (post_id, handle, outcome) values ('o1', 'other', 'distill_failed'), ('o2', 'other', 'reply_missing')`);
    const left = async () => (await db.query<{ outcome: string }>(`select outcome from public.hunter_posts where handle = 'hexmethod' order by post_id::int`)).rows.map((r) => r.outcome);
    // A Play holds it: nothing is taken back.
    await db.query(`update public.hunter_accounts set playing_since = $1 where handle = 'hexmethod'`, [new Date().toISOString()]);
    expect((await press({ resource: "hunter", action: "restart", handle: "hexmethod" })).status).toBe(409);
    expect(await left()).toEqual(posts);
    await db.exec(`update public.hunter_accounts set playing_since = null`);
    expect((await press({ resource: "hunter", action: "restart", handle: "hexmethod" })).status).toBe(200);
    expect(await left()).toEqual(takenBack);
    expect((await db.query(`select post_id, outcome from public.hunter_posts where handle = 'other' order by post_id`)).rows).toEqual([{ post_id: "o1", outcome: "distill_failed" }, { post_id: "o2", outcome: "reply_missing" }]);
    // Marks that could not be taken back are said, not passed over, and the hold is let go; pressed again it does it.
    await db.exec(`insert into public.hunter_posts (post_id, handle, outcome) values ('99', 'hexmethod', 'distill_failed');
      create function public.refuse_write() returns trigger language plpgsql as $$ begin raise exception 'refused'; end $$;
      create trigger refuse_write before update on public.hunter_posts for each row execute function public.refuse_write();`);
    expect((await press({ resource: "hunter", action: "restart", handle: "hexmethod" })).status).toBe(500);
    expect(await account("hexmethod")).toMatchObject({ playing_since: null });
    await db.exec(`drop trigger refuse_write on public.hunter_posts;`);
    expect((await press({ resource: "hunter", action: "restart", handle: "hexmethod" })).status).toBe(200);
    expect(await left()).toEqual([...takenBack, "retry"]);
    // The cursors refused: nothing is said to be done, no mark changes, as a mark changed with the cursors past it is never read.
    await db.exec(`update public.hunter_accounts set oldest_id = '5' where handle = 'hexmethod'; insert into public.hunter_posts (post_id, handle, outcome) values ('100', 'hexmethod', 'distill_failed');
      create trigger refuse_write before update of oldest_id on public.hunter_accounts for each row execute function public.refuse_write();`);
    expect((await press({ resource: "hunter", action: "restart", handle: "hexmethod" })).status).toBe(500);
    await db.exec(`drop trigger refuse_write on public.hunter_accounts; drop function public.refuse_write();`);
    expect((await db.query(`select outcome from public.hunter_posts where post_id = '100'`)).rows).toEqual([{ outcome: "distill_failed" }]);
    expect(await account("hexmethod")).toMatchObject({ oldest_id: "5", playing_since: null });
  });

  it("Start over holds the creator while it changes the marks, and gives way to a Play that took it over (review 2026-11-02)", async () => {
    await db.query(`insert into public.hunter_accounts (handle, added_by, oldest_id) values ('hexmethod', $1, '5')`, [h.admin]);
    await db.exec(`insert into public.hunter_posts (post_id, handle, outcome) values ('1', 'hexmethod', 'distill_failed');
      create table public.hold_seen (held boolean);
      create function public.see_hold() returns trigger language plpgsql as $$ begin
        insert into public.hold_seen select playing_since is not null from public.hunter_accounts where handle = new.handle;
        return new; end $$;
      create trigger see_hold before update on public.hunter_posts for each row execute function public.see_hold();`);
    expect((await press({ resource: "hunter", action: "restart", handle: "hexmethod" })).status).toBe(200);
    expect((await db.query(`select held from public.hold_seen`)).rows).toEqual([{ held: true }]);
    expect(await account("hexmethod")).toMatchObject({ playing_since: null, oldest_id: null });
    // A hold that ran out is no Play: it is taken over and let go.
    await db.exec(`drop trigger see_hold on public.hunter_posts; update public.hunter_accounts set playing_since = now() - interval '6 minutes'; update public.hunter_posts set outcome = 'distill_failed'`);
    expect((await press({ resource: "hunter", action: "restart", handle: "hexmethod" })).status).toBe(200);
    expect(await account("hexmethod")).toMatchObject({ playing_since: null });
    // Taken from it meanwhile: the other's hold stays.
    await db.exec(`update public.hunter_posts set outcome = 'distill_failed';
      create or replace function public.see_hold() returns trigger language plpgsql as $$ begin
        update public.hunter_accounts set playing_since = '2030-01-01T00:00:00.000Z' where handle = new.handle; return new; end $$;
      create trigger see_hold before update on public.hunter_posts for each row execute function public.see_hold();`);
    expect((await press({ resource: "hunter", action: "restart", handle: "hexmethod" })).status).toBe(200);
    await db.exec(`drop trigger see_hold on public.hunter_posts; drop function public.see_hold(); drop table public.hold_seen;`);
    expect((await db.query(`select to_char(playing_since at time zone 'UTC', 'YYYY') as at from public.hunter_accounts where handle = 'hexmethod'`)).rows).toEqual([{ at: "2030" }]);
  });

  it("saves a find's prompt, category, tags and generator by hand, sealed again for the publish (Kev, 2026-10-31)", async () => {
    process.env.FIELD_ENCRYPTION_KEY_B64 = Buffer.alloc(32, 9).toString("base64");
    const { sealPreview, openPreview } = await import("@/lib/referral/preview-token");
    await db.exec(`alter table public.hunt_submissions add column if not exists suggested_tags text[], add column if not exists suggested_title text, add column if not exists prompt_hash text; truncate public.hunt_submissions;`);
    const sealed = { v: 1 as const, userId: OTHER, exp: Date.now() + 3_600_000, source: { url: "https://x.com/h/status/1", normalized: "x.com/status/1", handle: "h", authorId: "1" },
      prompt: "A lighthouse keeper at dawn, soft fog, 35mm film grain, quiet sea", generators: [], photos: [], title: "Kingdom Hearts Dive", category: "More", tags: ["kingdomhearts"], adult: false };
    const { rows: [find] } = await db.query<{ id: string }>(`insert into public.hunt_submissions (hunter_user_id, preview_token, preview) values ($1, $2, $3) returning id::text`,
      [OTHER, sealPreview(sealed), JSON.stringify({ prompt: sealed.prompt, title: sealed.title, photos: [], hunt: { from: "text" } })]);
    const prompt = "A lighthouse keeper at dawn, soft fog, 35mm film grain, quiet sea, a broken ring of light above";
    const res = await press({ resource: "imports", action: "edit", id: find.id, edit: { prompt, category: "Characters", tags: [" Underwater ", "blue", ""], generators: ["Nano Banana Pro", "Midjourney"] } });
    expect(res.status).toBe(200);
    const [row] = (await db.query<{ preview_token: string; preview: Record<string, unknown>; suggested_tags: string[] }>(`select preview_token, preview, suggested_tags from public.hunt_submissions`)).rows;
    expect(openPreview(row.preview_token)).toMatchObject({ prompt, category: "Characters", tags: ["underwater", "blue"], title: "Kingdom Hearts Dive" });
    expect(row.preview).toMatchObject({ prompt, category: "Characters", tags: ["underwater", "blue"], hunt: { from: "text" } });
    expect(row.suggested_tags).toEqual(["underwater", "blue"]);
    expect((await press({ resource: "imports", action: "edit", id: find.id, edit: { title: "  Deep blue dive  " } })).status).toBe(200);
    const [titled] = (await db.query<{ preview_token: string; preview: Record<string, unknown> }>(`select preview_token, preview from public.hunt_submissions`)).rows;
    expect(openPreview(titled.preview_token)).toMatchObject({ title: "Deep blue dive", prompt });
    expect(titled.preview).toMatchObject({ title: "Deep blue dive" });
    expect((await press({ resource: "imports", action: "edit", id: find.id, edit: { title: "  " } })).status).toBe(400);
    expect((await press({ resource: "imports", action: "edit", id: find.id, edit: { category: "Memes" } })).status).toBe(400);
    expect((await press({ resource: "imports", action: "edit", id: find.id, edit: { prompt: "too short" } })).status).toBe(400);
    // 18+ by the admin's tick, sealed for the publish, and off again (Kev, 2026-11-01).
    expect((await press({ resource: "imports", action: "edit", id: find.id, edit: { adult: true } })).status).toBe(200);
    const [ticked] = (await db.query<{ preview_token: string; preview: Record<string, unknown> }>(`select preview_token, preview from public.hunt_submissions`)).rows;
    expect([openPreview(ticked.preview_token)?.adult, ticked.preview.adult]).toEqual([true, true]);
    await press({ resource: "imports", action: "edit", id: find.id, edit: { adult: false } });
    expect(openPreview((await db.query<{ preview_token: string }>(`select preview_token from public.hunt_submissions`)).rows[0].preview_token)?.adult).toBe(false);
    // A save that names no 18+ keeps it as it was.
    await press({ resource: "imports", action: "edit", id: find.id, edit: { adult: true } });
    await press({ resource: "imports", action: "edit", id: find.id, edit: { title: "Deep blue" } });
    expect(openPreview((await db.query<{ preview_token: string }>(`select preview_token from public.hunt_submissions`)).rows[0].preview_token)?.adult).toBe(true);
  });

  // DEC-2026-11-02-19: Kev could not get a wrapper off. The route is not where it stuck: it takes the prompt as typed.
  it("takes a prompt whose wrapping brackets were deleted by hand: no rewrap, its variables read from the text at the publish", async () => {
    process.env.FIELD_ENCRYPTION_KEY_B64 = Buffer.alloc(32, 9).toString("base64");
    const { sealPreview, openPreview } = await import("@/lib/referral/preview-token");
    const { slotVariables } = await import("@/lib/hunter/variables");
    const { promptHash } = await import("@/lib/hunter/run");
    await db.exec(`alter table public.hunt_submissions add column if not exists suggested_tags text[], add column if not exists suggested_title text, add column if not exists prompt_hash text; truncate public.hunt_submissions;`);
    const wrapped = "[Generate a hand-drawn sketch of [ANYTHING] with pencil lines and a warm feel.]";
    const stripped = wrapped.slice(1, -1);
    const wrapper = { name: "Generate a hand-drawn sketch of [ANYTHING", label: "x", description: "", type: "text", defaultValue: "x", required: true, position: 0 };
    const sealed = { v: 1 as const, userId: OTHER, exp: Date.now() + 3_600_000, source: { url: "https://x.com/h/status/1", normalized: "x.com/status/1", handle: "h", authorId: "1" },
      prompt: wrapped, generators: [], photos: [], title: "Sketch", category: "More", tags: [], adult: false };
    const { rows: [find] } = await db.query<{ id: string }>(`insert into public.hunt_submissions (hunter_user_id, preview_token, preview) values ($1, $2, $3) returning id::text`,
      [OTHER, sealPreview(sealed), JSON.stringify({ prompt: wrapped, title: sealed.title, photos: [], hunt: { from: "text", variables: [wrapper] } })]);
    const row = async () => (await db.query<{ preview_token: string; preview: { prompt: string; adult?: boolean; hunt: { variables: typeof wrapper[] } }; prompt_hash: string }>(`select preview_token, preview, prompt_hash from public.hunt_submissions`)).rows[0];

    expect((await press({ resource: "imports", action: "edit", id: find.id, edit: { prompt: stripped } })).status).toBe(200);
    const saved = await row();
    expect(openPreview(saved.preview_token)?.prompt).toBe(stripped);
    expect(saved.preview.prompt).toBe(stripped);
    expect(saved.prompt_hash).toBe(promptHash(stripped));
    // The edit derives nothing: the publish reads the slots of the text as it stands, the wrapper's variable gone with it.
    expect(saved.preview.hunt.variables).toEqual([wrapper]);
    expect(slotVariables(stripped, saved.preview.hunt.variables).map((v) => [v.name, v.defaultValue])).toEqual([["ANYTHING", "ANYTHING"]]);
    // The next field's save names only itself, and the prompt stays.
    expect((await press({ resource: "imports", action: "edit", id: find.id, edit: { adult: true } })).status).toBe(200);
    const ticked = await row();
    expect(openPreview(ticked.preview_token)).toMatchObject({ prompt: stripped, adult: true });
    expect(ticked.preview).toMatchObject({ prompt: stripped, adult: true });
    // One bracket left is the admin's to leave: nothing closes or removes it for them.
    expect((await press({ resource: "imports", action: "edit", id: find.id, edit: { prompt: wrapped.slice(0, -1) } })).status).toBe(200);
    expect(openPreview((await row()).preview_token)?.prompt).toBe(wrapped.slice(0, -1));
  });

  it("tells the foot bar what the creator's latest Play has done so far (Kev, 2026-10-31)", async () => {
    await db.query(`insert into public.hunter_accounts (handle, added_by) values ('hexmethod', $1)`, [h.admin]);
    await db.query(`insert into public.hunter_runs (handle, usage, est_usd, started_at) values ('hexmethod', '{"posts":3}', 0.001, now() - interval '1 hour'), ('hexmethod', '{"posts":17,"replies":2}', 0.0064, now())`);
    const live = await (await GET(new NextRequest("http://enki.test/api/admin?hunterLive=@HexMethod"))).json();
    expect(live.live).toMatchObject({ usage: { posts: 17, replies: 2 } });
    expect(Number(live.live.est_usd)).toBe(0.0064);
    expect((await GET(new NextRequest("http://enki.test/api/admin?hunterLive=bad handle!"))).status).toBe(400);
  });

  it("hands out the hunter's log, newest first, every post with what became of it (Kev, 2026-10-31)", async () => {
    await db.query(`insert into public.hunter_accounts (handle, added_by) values ('hexmethod', $1)`, [h.admin]);
    await db.exec(`insert into public.hunter_posts (post_id, handle, outcome, read_at) values ('1', 'hexmethod', 'queued', now() - interval '1 hour'), ('2', 'hexmethod', 'distill_failed', now())`);
    const body = await (await GET(new NextRequest("http://enki.test/api/admin?hunterLog=1"))).json();
    expect(body.log.map((r: { post_id: string; outcome: string }) => [r.post_id, r.outcome])).toEqual([["2", "distill_failed"], ["1", "queued"]]);
  });

  it("cuts the merged log to its newest 1000 lines", async () => {
    await db.query(`insert into public.hunter_accounts (handle, added_by) values ('hexmethod', $1)`, [h.admin]);
    await db.exec(`insert into public.hunter_posts (post_id, handle, outcome, read_at) select g::text, 'hexmethod', 'queued', now() - (g * interval '1 minute') from generate_series(1, 700) g;
      insert into public.admin_actions (action, target, detail, created_at) select 'hunter.knownLink', g::text, '{"outcome":{"status":"in_enki"}}', now() - ((g - 1000) * interval '1 minute') from generate_series(1001, 1700) g;`);
    const { log } = await (await GET(new NextRequest("http://enki.test/api/admin?hunterLog=1"))).json();
    expect(log).toHaveLength(1000);
    expect(log.map((r: { post_id: string }) => r.post_id)).not.toContain("700");
    expect(log.map((r: { post_id: string }) => r.post_id)).not.toContain("1700");
    expect(log.map((r: { post_id: string }) => r.post_id)).toContain("1");
  });

  // Kev, 2026-11-02: per line of a .txt list, what became of it; a post's own row is never overwritten by the attempt.
  it("shows a link Enki knows already as already in Enki or already waiting, its post's own row untouched", async () => {
    await db.exec(`alter table public.hunt_submissions add column if not exists normalized_source_url text, add column if not exists source_author_handle text; truncate public.hunt_submissions;`);
    await db.query(`insert into public.hunter_accounts (handle, added_by) values ('hexmethod', $1)`, [h.admin]);
    const SUB = "00000000-0000-4000-8000-0000000000c1";
    await db.query(`insert into public.hunt_submissions (id, hunter_user_id, status, normalized_source_url, source_author_handle) values
      ($1, $2, 'pending', 'x.com/status/101', 'HexMethod'), (gen_random_uuid(), $2, 'approved', 'x.com/status/102', 'notlisted'), (gen_random_uuid(), $2, 'approved', 'x.com/status/103', 'hexmethod'), (gen_random_uuid(), $2, 'approved', 'x.com/status/104', null)`, [SUB, OTHER]);
    await db.query(`insert into public.hunter_posts (post_id, handle, outcome, submission_id, read_at) values ('101', 'hexmethod', 'queued', $1, now() - interval '1 hour'), ('103', 'hexmethod', 'waiting', null, now() - interval '2 hours')`, [SUB]);
    const before = (await db.query(`select * from public.hunter_posts where post_id = '101'`)).rows;

    const link = (action: string, id: string) => press({ resource: "hunter", action, url: `https://x.com/i/status/${id}` });
    const waiting = await link("queueLink", "101");
    expect(waiting.status).toBe(409);
    expect((await waiting.json()).error).toBe("This post is waiting in Pending imports already.");
    const inEnki = await link("queueLink", "102");
    expect(inEnki.status).toBe(409);
    expect((await inEnki.json()).error).toBe("This post is on Enki already.");
    // "Play links" meets one that was found meanwhile: it leaves the line, and its line stays in the log.
    expect((await link("addLink", "103")).status).toBe(409);
    expect((await link("queueLink", "104")).status).toBe(409);

    expect((await db.query(`select * from public.hunter_posts where post_id = '101'`)).rows).toEqual(before);
    expect((await db.query(`select post_id from public.hunter_posts order by post_id`)).rows).toEqual([{ post_id: "101" }]);
    const logged = (await db.query<{ action: string }>(`select action from public.admin_actions`)).rows.map((r) => r.action);
    expect(logged).toEqual(["hunter.knownLink", "hunter.knownLink", "hunter.knownLink", "hunter.knownLink"]);
    // Any other row of the admin log is no line of this one.
    await db.exec(`insert into public.admin_actions (action, target) values ('hunter.restart', 'hexmethod')`);

    const log = async () => ((await (await GET(new NextRequest("http://enki.test/api/admin?hunterLog=1"))).json()).log as { post_id: string; handle: string; outcome: string; read_at: string }[]);
    const seen = await log();
    expect(seen.map((r) => [r.post_id, r.handle, r.outcome])).toEqual([
      ["104", "i", "already_in_enki"], ["103", "hexmethod", "already_in_enki"], ["102", "notlisted", "already_in_enki"], ["101", "HexMethod", "already_waiting"], ["101", "hexmethod", "queued"],
    ]);
    expect(Date.parse(seen[0].read_at)).toBeGreaterThan(Date.now() - 60_000);
    // Read again, as after a reload: it is the server's, not the browser's.
    expect(await log()).toEqual(seen);

    // Refused for another reason (not a post): no line.
    expect((await press({ resource: "hunter", action: "queueLink", url: "https://example.com/a" })).status).toBe(400);
    expect(await log()).toHaveLength(5);
  });

  // Review 2026-11-03: the route hands Play links' creator on, so a link that leads elsewhere now lists no one.
  it("Play links on a link that leads to someone not on the list: refused, no list row, marked in the log, out of the line", async () => {
    await db.exec(`alter table public.hunt_submissions add column if not exists normalized_source_url text, add column if not exists source_author_handle text; truncate public.hunt_submissions;`);
    await db.query(`insert into public.hunter_accounts (handle, added_by) values ('hexmethod', $1)`, [h.admin]);
    await db.exec(`insert into public.hunter_posts (post_id, handle, outcome) values ('201', 'hexmethod', 'waiting')`);
    const status = { id: "201", url: "https://x.com/stranger/status/201", text: "A lighthouse keeper at dawn, soft fog, 35mm film grain, with a long description of it", author: { id: "77", name: "S", screen_name: "stranger" }, media: {}, replying_to: null, quote: null };
    vi.stubGlobal("fetch", async () => Response.json({ tweet: status, status }));
    try {
      const res = await press({ resource: "hunter", action: "addLink", url: "https://x.com/i/status/201", handle: "hexmethod" });
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe("This link leads to @stranger now, who is not on your list. Add the link again to list them.");
    } finally { vi.unstubAllGlobals(); }
    expect((await db.query(`select handle from public.hunter_accounts`)).rows).toEqual([{ handle: "hexmethod" }]);
    expect((await db.query(`select post_id, handle, outcome from public.hunter_posts`)).rows).toEqual([{ post_id: "201", handle: "hexmethod", outcome: "leads_to:stranger" }]);
  });

  // Kev, 2026-11-02: the CSV showed raw values such as too_long.
  it("words the Posts CSV as the admin reads it, for every outcome, an unknown one as its name, quoted when it must be", async () => {
    await db.query(`insert into public.hunter_accounts (handle, added_by) values ('hexmethod', $1)`, [h.admin]);
    const said = {
      too_long: "prompt too long to cut", no_prompt: "no prompt", distill_failed: "distill failed", reply_missing: "reply missing", video_only: "video: saved in the Videos tab", no_media: "no picture or video: saved in the No media tab", below_likes: "below likes",
      author_cap: "author cap", not_saved: "not saved", publish_failed: "publish failed", queued: "queued", published: "published", waiting: "waiting", duplicate: "duplicate", refused: "refused",
      reply: "reply", unchecked: "unchecked", retry: "to be tried again", rejected: "rejected", some_new_value: "some new value",
    };
    const quoted = { 'odd,_"x"_y': '"odd, ""x"" y"', "a,_b": '"a, b"', 'say_"x"_now': '"say ""x"" now"', "two\nlines": '"two\nlines"' };
    const all = [...Object.keys(said), ...Object.keys(quoted)];
    for (const [i, outcome] of all.entries()) await db.query(`insert into public.hunter_posts (post_id, handle, likes, outcome, read_at) values ($1, 'hexmethod', 3, $2, now() - ($3::int * interval '1 minute'))`, [String(100 + i), outcome, i]);
    const res = await GET(new NextRequest("http://enki.test/api/admin?hunterPosts=@HexMethod"));
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    const text = await res.text();
    expect(text.startsWith("post_id,url,likes,outcome,read_at\n")).toBe(true);
    for (const [i, outcome] of all.entries()) {
      const words = (quoted as Record<string, string>)[outcome] ?? (said as Record<string, string>)[outcome];
      expect(text).toContain(`\n${100 + i},https://x.com/hexmethod/status/${100 + i},3,${words},`);
    }
    for (const [outcome, words] of Object.entries(said)) expect(outcomeWords(outcome)).toBe(words);
    expect(text).not.toContain("too_long");
    expect(text).not.toContain("no_prompt");
  });

  it("answers 500 for the log when the attempts cannot be read, rather than leaving their lines out", async () => {
    await db.exec(`alter table public.admin_actions rename to admin_actions_moved`);
    try {
      expect((await GET(new NextRequest("http://enki.test/api/admin?hunterLog=1"))).status).toBe(500);
    } finally {
      await db.exec(`alter table public.admin_actions_moved rename to admin_actions`);
    }
  });

  it("names the marked finds, else every waiting one, by gpt-6-luna's batch, sealed again (Kev, 2026-11-01)", async () => {
    process.env.FIELD_ENCRYPTION_KEY_B64 = Buffer.alloc(32, 9).toString("base64");
    const { sealPreview, openPreview } = await import("@/lib/referral/preview-token");
    await db.exec(`alter table public.hunt_submissions add column if not exists suggested_tags text[], add column if not exists suggested_title text, add column if not exists preview_token text,
      add column if not exists preview jsonb, add column if not exists submitted_at timestamptz not null default now(); truncate public.hunt_submissions;`);
    const sealed = (prompt: string) => ({ v: 1 as const, userId: OTHER, exp: Date.now() + 3_600_000, source: { url: "https://x.com/h/status/1", normalized: "x.com/status/1", handle: "h", authorId: "1" },
      prompt, generators: [], photos: [], title: "Untitled", category: "More", tags: [], adult: false });
    const ids: string[] = [];
    for (const p of ["An embossed logo for a coffee brand on soft paper", "A lighthouse keeper at dawn, soft fog over the bay"]) {
      const { rows: [r] } = await db.query<{ id: string }>(`insert into public.hunt_submissions (hunter_user_id, preview_token, preview) values ($1, $2, $3) returning id::text`, [OTHER, sealPreview(sealed(p)), JSON.stringify({ prompt: p, hunt: { from: "text" } })]);
      ids.push(r.id);
    }
    named.asked.length = 0;
    expect(await (await press({ resource: "imports", action: "describe", ids: [ids[0]] })).json()).toEqual({ ok: true, described: 1, asked: 1 });
    expect(named.asked).toEqual([["An embossed logo for a coffee brand on soft paper"]]);
    const read = async (id: string) => (await db.query<{ preview_token: string; preview: Record<string, unknown>; suggested_title: string | null; suggested_tags: string[] | null }>(`select preview_token, preview, suggested_title, suggested_tags from public.hunt_submissions where id = $1`, [id])).rows[0];
    const one = await read(ids[0]);
    // The vocabulary's tags of the prompt and the model's words, never a word it does not know.
    expect(openPreview(one.preview_token)).toMatchObject({ title: "Named 0", category: "Branding", tags: expect.arrayContaining(["logo", "branding", "coffee"]) });
    expect(openPreview(one.preview_token)?.tags).not.toContain("zzz-not-ours");
    expect([one.suggested_title, one.preview.title, one.preview.hunt]).toEqual(["Named 0", "Named 0", { from: "text" }]);
    expect((await read(ids[1])).suggested_title).toBeNull();
    // None marked: every waiting find.
    expect(await (await press({ resource: "imports", action: "describe" })).json()).toEqual({ ok: true, described: 2, asked: 2 });
    // An 18+ tick made while the model answers is kept (review 2026-11-01).
    named.during = async () => { await press({ resource: "imports", action: "edit", id: ids[1], edit: { adult: true } }); };
    await press({ resource: "imports", action: "describe", ids: [ids[1]] });
    named.during = null;
    expect(openPreview((await read(ids[1])).preview_token)).toMatchObject({ adult: true, title: "Named 0" });
    // A moderator may reject a find, not edit, approve or name it: its publish is not checked again.
    const { rows: [mod] } = await db.query<{ id: string }>(`insert into public.users (role) values ('mod') returning id::text`);
    const admin = h.admin;
    h.admin = mod.id;
    try {
      for (const action of ["edit", "approve", "describe"]) expect((await press({ resource: "imports", action, id: ids[0], edit: { adult: false } })).status, action).toBe(403);
      expect((await press({ resource: "imports", action: "reject", id: ids[0], reason: "Other" })).status).not.toBe(403);
    } finally {
      h.admin = admin;
    }
  });

  it("lists the links in line for one creator, oldest first, for \"Play links\" (Kev, 2026-11-01)", async () => {
    await db.query(`insert into public.hunter_accounts (handle, added_by) values ('hexmethod', $1), ('other', $1)`, [h.admin]);
    await db.exec(`insert into public.hunter_posts (post_id, handle, outcome, read_at) values
      ('2', 'hexmethod', 'waiting', now()), ('1', 'hexmethod', 'waiting', now() - interval '1 hour'), ('3', 'hexmethod', 'queued', now()), ('4', 'other', 'waiting', now())`);
    expect(await (await GET(new NextRequest("http://enki.test/api/admin?hunterWaiting=@HexMethod"))).json()).toEqual({ links: ["1", "2"] });
  });

  it("hands out Pending imports 50 at a time, newest first, each once across the pages, with how many wait (Kev, 2026-10-31)", async () => {
    // Three finds share each minute, so only the id keeps the pages from overlapping or skipping.
    await db.exec(`alter table public.hunt_submissions add column if not exists source_url text, add column if not exists suggested_title text,
      add column if not exists suggested_tags text[], add column if not exists submitted_at timestamptz not null default now(),
      add column if not exists preview jsonb; truncate public.hunt_submissions;
      insert into public.hunt_submissions (hunter_user_id, suggested_title, submitted_at, status)
        select '${OTHER}', 'find ' || i, now() - (i % 40) * interval '1 minute', 'pending' from generate_series(1, 120) i;
      insert into public.hunt_submissions (hunter_user_id, suggested_title, status) values ('${OTHER}', 'published one', 'approved');`);
    const pages: { imports: { id: string; at: string }[]; importsTotal: number }[] = [];
    for (const from of [0, 50, 100]) pages.push(await (await GET(new NextRequest(`http://enki.test/api/admin?importsFrom=${from}`))).json());
    expect(pages.map((p) => [p.imports.length, p.importsTotal])).toEqual([[50, 120], [50, 120], [20, 120]]);
    const all = pages.flatMap((p) => p.imports);
    expect(new Set(all.map((r) => r.id)).size).toBe(120);
    const at = all.map((r) => Date.parse(r.at));
    expect(at).toEqual([...at].sort((a, b) => b - a));
    expect(all.filter((r, i) => i > 0 && at[i] === at[i - 1] && r.id < all[i - 1].id)).toEqual([]); // ties: by id, the same on every page
    expect((await GET(new NextRequest("http://enki.test/api/admin?importsFrom=-1"))).status).toBe(400);
  });

  it("publishes a find once: a second Approve while the first still publishes leaves it alone (live 2026-10-31: three prompts from one find)", async () => {
    await db.exec(`alter table public.hunt_submissions add column if not exists decided_at timestamptz, add column if not exists decided_by uuid,
      add column if not exists minted_prompt_id uuid, add column if not exists rejection_reason text; truncate public.hunt_submissions;`);
    // The first click moved it to approved and is publishing it now (no prompt minted yet).
    const { rows: [find] } = await db.query<{ id: string }>(
      `insert into public.hunt_submissions (hunter_user_id, preview_token, preview, status) values ($1, 'sealed', $2, 'approved') returning id::text`,
      [OTHER, JSON.stringify({ prompt: "A lighthouse keeper at dawn", title: "Lighthouse keeper", photos: [], source: { url: "https://x.com/h/status/1", handle: "h" } })]);
    const res = await press({ resource: "imports", action: "approve", ids: [find.id] });
    expect(await res.json()).toEqual({ ok: true, published: 0 });
    expect((await db.query(`select status from public.hunt_submissions`)).rows).toEqual([{ status: "approved" }]);
  });

  it("deletes a prompt softly, as an exception: admins only, kept in the database, every list leaves it out (Kev, 2026-10-31)", async () => {
    await db.exec(`create table if not exists public.prompts (id uuid primary key, is_listed boolean not null default true, deleted_at timestamptz);
      truncate public.prompts; insert into public.prompts (id) values ('00000000-0000-4000-8000-0000000000aa');`);
    const del = () => press({ resource: "prompts", action: "delete", id: "00000000-0000-4000-8000-0000000000aa" });
    expect((await del()).status).toBe(200);
    const [row] = (await db.query<{ is_listed: boolean; deleted: boolean }>(`select is_listed, deleted_at is not null as deleted from public.prompts`)).rows;
    expect(row).toEqual({ is_listed: false, deleted: true });
    expect(await (await del()).json()).toEqual({ error: "No such prompt, or it is deleted already." });
    expect((await db.query(`select target from public.admin_actions where action = 'prompts.delete'`)).rows).toContainEqual({ target: "00000000-0000-4000-8000-0000000000aa" });
  });

  it("leaves a creator it did not show alone: its search, generator, caps, cursors and spend stay", async () => {
    // Added and played in another tab: its own settings, read back to a date, $0.90 spent.
    const own = { ...CREATOR_DEFAULTS, words: ["free prompt"], postsPerPlay: 50, spendCapUsd: 1, preferredGenerator: "GPT-Image-2" };
    await db.query(`insert into public.hunter_accounts (handle, added_by) values ('hexmethod', $1)`, [OTHER]);
    expect(await saveCreator(supabase, { handle: "HexMethod", config: own, catalogue: CATALOGUE })).toEqual({ ok: true });
    await db.exec(`update public.hunter_accounts set newest_id = '1850000000000000000', oldest_id = '1800000000000000000', exhausted = true,
      spent_usd = 0.9, posts_read = 140, found = 9 where handle = 'hexmethod'`);
    const before = await account("hexmethod");

    const res = await press(addPayload("hexmethod"));
    expect(res.status).toBe(200);

    expect(await account("hexmethod")).toEqual(before);
    expect(before).toMatchObject({ added_by: OTHER, cap: "1.00", spent: "0.9000", words: ["free prompt"], preferred_generator: "GPT-Image-2", exhausted: true });
    // What the page then opens: the server's settings, not the defaults.
    const row = (await loadCreators(supabase)).creators.find((c) => c.handle === "hexmethod");
    expect(row?.config).toEqual(own);
  });

  it("makes a new creator with the contract's defaults, nothing read, nothing spent, no call to X", async () => {
    const res = await press(addPayload("newone"));
    expect(res.status).toBe(200);
    const row = (await loadCreators(supabase)).creators.find((c) => c.handle === "newone");
    expect(row?.config).toEqual(CREATOR_DEFAULTS);
    expect(row).toMatchObject({ xUserId: null, profile: null, runs: [] });
    expect(row?.state).toMatchObject({ newestId: null, oldestId: null, backDone: false, postsRead: 0, spentUsd: 0, playing: false });
    expect((await account("newone")).added_by).toBe(h.admin);
  });

  it("keeps what a creator's earlier Plays cost when it is removed and added again: its cap covers every Play of the handle", async () => {
    expect((await press(addPayload("hexmethod"))).status).toBe(200);
    // Two Plays, $0.30 and $0.15, counted on the creator and on their rows.
    await db.exec(`update public.hunter_accounts set spent_usd = 0.45 where handle = 'hexmethod';
      insert into public.hunter_runs (handle, est_usd, finished_at) values ('hexmethod', 0.30, now()), ('hexmethod', 0.15, now()), ('someone', 2, now());`);
    expect((await press({ resource: "hunter", action: "removeAccount", handle: "hexmethod" })).status).toBe(200);
    expect(await account("hexmethod")).toBeUndefined();
    expect((await press(addPayload("hexmethod"))).status).toBe(200);
    expect((await account("hexmethod")).spent).toBe("0.4500");
    const row = (await loadCreators(supabase)).creators.find((c) => c.handle === "hexmethod");
    expect(row?.state.spentUsd).toBe(0.45);
  });

  it("does not remove a creator a Play holds: that round would bill reads to no row (review 2026-10-30, F13)", async () => {
    expect((await press(addPayload("hexmethod"))).status).toBe(200);
    await db.query(`update public.hunter_accounts set playing_since = $1 where handle = 'hexmethod'`, [new Date(Date.now() - 60_000).toISOString()]);
    const res = await press({ resource: "hunter", action: "removeAccount", handle: "@HexMethod" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "@hexmethod is playing: stop its Play first." });
    expect(await account("hexmethod")).toBeDefined();
    // A hold older than five minutes is a crashed round's: removed.
    await db.query(`update public.hunter_accounts set playing_since = $1 where handle = 'hexmethod'`, [new Date(Date.now() - 6 * 60_000).toISOString()]);
    expect((await press({ resource: "hunter", action: "removeAccount", handle: "hexmethod" })).status).toBe(200);
    expect(await account("hexmethod")).toBeUndefined();
  });

  it("saves the settings of a creator on the list only (review 2026-10-30, F14)", async () => {
    const res = await press({ resource: "hunter", action: "saveCreator", handle: "gone", config: CREATOR_DEFAULTS });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "@gone is not on the list any more." });
    expect(await account("gone")).toBeUndefined();
  });
});
