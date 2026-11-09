import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";
import type { SupabaseClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { pglitePostgrest } from "@/lib/__tests__/_pglite-postgrest";
import { resetKeyringCache } from "@/lib/crypto";
import { resolveSessionUserId } from "@/lib/session-user";
import { CREATOR_DEFAULTS } from "@/lib/hunter/creator-types";
import type { XPost, XSearchApi } from "../x-api";
import { defaultCreatorDeps, playCreator } from "../creator-run";
import { downloadPhoto } from "@/lib/referral/post-photos";

/**
 * Whose account a creator's Play judges with (review 2026-10-30, F1): the admin route hands the round the request of
 * the admin who pressed Play, with their session (X-Session-Token) and their address (x-forwarded-for). A creator's
 * explicit or child-safety prompt, or a child-safety picture of their post, must never strike, suspend or file a case
 * under that admin: recordWarning and recordImageCase read the account and the address from the request. The real
 * judgeImport, recordWarning, banUntil and recordImageCase run on a real Postgres; the classifiers, the picture's
 * download, admin mail and next/server's after() are stubbed, X is a fake object (xApi() is never built), and
 * vitest.setup.ts makes any fetch throw. No paid call.
 */
const verdicts = vi.hoisted(() => ({ prompt: "clear", image: "clear" }));
vi.mock("@/lib/moderation/prompt-check", async (orig) => ({
  ...(await orig<object>()),
  checkPrompt: vi.fn(async () => ({ verdict: verdicts.prompt, confidence: 0.93 })),
}));
vi.mock("@/lib/moderation/image-check-bytes", async (orig) => ({
  ...(await orig<object>()),
  checkImageBytes: vi.fn(async () => ({ verdict: verdicts.image, scores: { "sexual/minors": 0.8 } })),
}));
vi.mock("@/lib/referral/post-photos", async (orig) => ({
  ...(await orig<object>()),
  downloadPhoto: vi.fn(async () => ({ buf: Buffer.from("picture"), contentType: "image/jpeg" })),
}));
const mails = vi.hoisted(() => [] as string[]);
vi.mock("@/lib/admin-notify", async (orig) => ({
  ...(await orig<object>()),
  notifyAdmins: vi.fn(async (_s: unknown, m: { subject: string }) => { mails.push(m.subject); }),
}));
const later = vi.hoisted(() => [] as Promise<unknown>[]);
vi.mock("next/server", async (orig) => ({
  ...(await orig<object>()),
  after: vi.fn((p: Promise<unknown>) => { later.push(Promise.resolve(p)); }),
}));
// What the model is asked to name a find by: the post's own words (Kev, 2026-10-30: "a very short title ... depending on
// the content of the tweet"). Answered here, so no model is called.
const named = vi.hoisted(() => [] as (string | undefined)[]);
vi.mock("@/lib/referral/describe-prompt", async (orig) => ({
  ...(await orig<object>()),
  describePrompt: vi.fn(async (_prompt: string, _fetch: unknown, post?: string) => {
    named.push(post);
    return { title: "Lighthouse keeper dawn", category: "Characters", tags: ["fog"] };
  }),
}));
vi.mock("@/lib/hunter/x-api", async (orig) => ({
  ...(await orig<object>()),
  // Never the real client: an inert one, which every test replaces.
  xApi: vi.fn(() => new Proxy({}, { get: () => async () => { throw new Error("no X in this test"); } })),
}));

const ROOT = join(__dirname, "..", "..", "..");
const migration = (f: string) => readFileSync(join(ROOT, "migrations", f), "utf8").split("\r\n").join("\n");
const KEV = "00000000-0000-4000-8000-00000000c0de";
const OWNER = "00000000-0000-4000-8000-0000000000ee";
const TOKEN = "kev-admin-session";
const XID = "1500000000000000001";
const NOW = Date.now();
const sf = (ms: number, n = 0) => ((BigInt(ms - 1288834974657) << BigInt(22)) + BigInt(n)).toString();
const P1 = "A cinematic portrait of a [subject] lighthouse keeper at dawn, soft fog, 35mm film grain";
const P2 = "Isometric coffee shop diorama, [season] decorations, tiny people, warm light, octane render";

describe("a creator's post is judged as nobody's request", () => {
  let db: PGlite;
  let supabase: SupabaseClient;
  /** The panel's POST (app/admin/page.tsx, sessionAuthHeaders): the admin's session and address. */
  const pressed = () => new NextRequest("http://localhost:3008/api/admin", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Session-Token": TOKEN, "x-forwarded-for": "203.0.113.7" },
  });
  const events = async () => (await db.query<{ user_id: string | null; ip_hash: string | null; category: string }>(
    `select user_id::text, ip_hash, category from public.automod_events order by category`)).rows;

  beforeAll(async () => {
    db = await PGlite.create({ extensions: { citext } });
    await db.exec(`
      create extension citext;
      create role anon; create role authenticated; create role service_role bypassrls;
      create table public.users (id uuid primary key default gen_random_uuid(), handle public.citext, origin text, display_name text,
        bio text, avatar_url text, is_creator boolean not null default false, account_status text not null default 'active',
        deleted_at timestamptz, created_at timestamptz not null default now(), role text);
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
      create table public.auth_sessions (token text primary key, wallet_address text not null, expires_at timestamptz not null);
      create table public.automod_events (id uuid primary key default gen_random_uuid(), user_id uuid, ip_hash text, surface text, decision text,
        severity text, tier int, category text, matched_rules text[], scores jsonb, prompt_hash text, evidence_ct text, evidence_iv text,
        evidence_tag text, evidence_kid text, review_state text, created_at timestamptz not null default now());
      create table public.bans (id uuid primary key default gen_random_uuid(), user_id uuid not null, issued_by uuid not null, scope text,
        reason text, expires_at timestamptz, lifted_at timestamptz, created_at timestamptz not null default now());
      create table public.moderation_policy (id int primary key, owner_user_id uuid);
    `);
    for (const f of ["2026-10-29-auto-handles.sql", "2026-10-14-prompt-hunter.sql", "2026-10-30-creator-hunter.sql", "2026-11-01-hunter-modes.sql", "2026-11-03-hunter-parked.sql"]) await db.exec(migration(f));
    supabase = pglitePostgrest(db).client as unknown as SupabaseClient;
  }, 60_000);
  afterAll(async () => { await db.close(); });
  beforeEach(async () => {
    await db.exec(`truncate public.users, public.auth_sessions, public.automod_events, public.bans, public.moderation_policy, public.hunt_submissions,
      public.hunter_accounts, public.hunter_posts, public.hunter_runs, public.hunter_parked cascade;
      insert into public.users (id, handle, origin, display_name, role) values ('${KEV}', 'kev', 'email', 'Kev', 'admin');
      insert into public.auth_sessions (token, wallet_address, expires_at) values ('${TOKEN}', '${KEV}', now() + interval '1 day');
      insert into public.moderation_policy (id, owner_user_id) values (1, '${OWNER}');
      insert into public.hunter_accounts (handle) values ('hexmethod');`);
    mails.length = 0;
    later.length = 0;
    named.length = 0;
    verdicts.prompt = "clear";
    verdicts.image = "clear";
    process.env.FIELD_ENCRYPTION_KEY_B64 = randomBytes(32).toString("base64");
    process.env.AUTH_PEPPER = "test-pepper";
    resetKeyringCache();
  });

  const post = (id: string, text: string): XPost => ({
    id, url: `https://x.com/hexmethod/status/${id}`, text, author: { id: XID, handle: "hexmethod", name: "" },
    photos: [{ url: `https://pbs.twimg.com/media/${id}.jpg`, alt: null }], replyingTo: null, quote: null, likes: 50, videos: 0, conversationId: id,
  });
  /** One round with the route's own deps (defaultCreatorDeps over the admin's request), X and the account stubbed. */
  const play = async (posts: XPost[]) => {
    const real = defaultCreatorDeps(supabase, pressed());
    const pages = [{ posts, nextToken: null }];
    const x: XSearchApi = {
      user: async () => ({ id: XID, handle: "HexMethod", name: "Hex Method" }),
      search: async () => pages.shift() ?? { posts: [], nextToken: null },
      replies: async () => [],
    };
    const { data: me } = await supabase.from("users").insert({ origin: "imported", imported_x_id: XID, handle: "hexmethod" }).select("id").single();
    let t = NOW;
    const got = await playCreator(supabase, "hexmethod", undefined, {
      ...real, x, profile: async () => ({ userId: String(me!.id), handle: "hexmethod" }) as never,
      distill: async () => ({ ok: false, why: "distill_failed" }), catalogue: async () => ["GPT-Image-2"],
      now: () => t, sleep: async (ms) => { t += ms; },
    });
    await Promise.all(later);
    return got;
  };

  /** The imported creator's account, which a case is about (Kev, 2026-10-31: "ich will ihn erst sehen, ohne strafe"). */
  const creator = async () => String((await db.query<{ id: string }>(`select id::text from public.users where origin = 'imported'`)).rows[0].id);

  it("files a creator's explicit and child-safety prompts on the imported creator's account, no address: no ban on anyone", async () => {
    expect(await resolveSessionUserId(supabase, TOKEN)).toBe(KEV);
    verdicts.prompt = "minor_sexual";
    const got = await play([post(sf(NOW - 2 * 86_400_000, 2), `Prompt: ${P1}`), post(sf(NOW - 2 * 86_400_000, 1), `Prompt: ${P2}`)]);
    expect(got.status === 200 && got.summary.skipped).toEqual({ refused: 2 });
    // The cases wait for a human, as every child-safety request does, on the creator's account to be seen there; two
    // child-safety warnings would suspend a real account at once, the imported one gets no sanction.
    const me = await creator();
    expect(await events()).toEqual([
      { user_id: me, ip_hash: null, category: "minor_sexual" },
      { user_id: me, ip_hash: null, category: "minor_sexual" },
    ]);
    expect((await db.query(`select 1 from public.bans`)).rows).toHaveLength(0);
    expect(mails.every((m) => !m.includes(KEV))).toBe(true);
    // The admin can still open /admin: their session resolves (requireAdmin answers 401 on a banned one).
    expect(await resolveSessionUserId(supabase, TOKEN)).toBe(KEV);
  });

  it("files a child-safety picture of a creator's post as a case on the creator's account", async () => {
    verdicts.image = "child_safety";
    const got = await play([post(sf(NOW - 2 * 86_400_000, 3), `Prompt: ${P1}`)]);
    expect(got.status === 200 && got.summary.skipped).toEqual({ refused: 1 });
    expect(await events()).toEqual([{ user_id: await creator(), ip_hash: null, category: "csam" }]);
    expect(mails.every((m) => !m.includes(KEV))).toBe(true);
  });

  // The real judge leaves a picture it cannot download out: all of them out is no find (Kev, 2026-11-03).
  it("parks a post whose every picture failed to download, whatever the judge said of its words", async () => {
    vi.mocked(downloadPhoto).mockResolvedValueOnce(null);
    const id = sf(NOW - 2 * 86_400_000, 5);
    const got = await play([post(id, `Prompt: ${P1}`)]);
    expect(got.status === 200 && got.summary).toMatchObject({ queued: 0, skipped: { pictures_failed: 1 } });
    expect((await db.query(`select 1 from public.hunt_submissions`)).rows).toEqual([]);
    expect((await db.query(`select post_id, kind, why from public.hunter_parked`)).rows).toEqual([{ post_id: id, kind: "no_media", why: "its pictures could not be read" }]);
  });

  it("names a find by its own post: the route's judge hands the post's words to the model that names it", async () => {
    const text = `Lighthouse keeper at dawn, free for you
Prompt: ${P1}`;
    const got = await play([post(sf(NOW - 2 * 86_400_000, 4), text)]);
    expect(got.status === 200 && got.summary.queued).toBe(1);
    expect(named).toEqual([text]);
    const [row] = (await db.query<{ suggested_title: string }>(`select suggested_title from public.hunt_submissions`)).rows;
    expect(row.suggested_title).toBe("Lighthouse keeper dawn");
  });
});
