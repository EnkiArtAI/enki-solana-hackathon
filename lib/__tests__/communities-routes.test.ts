import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { pglitePostgrest } from "./_pglite-postgrest";
import { coreWord } from "@/lib/communities/handle";
import * as T from "@/lib/communities/types";
import { DB_UNAVAILABLE_MESSAGE } from "@/lib/db-error";

/**
 * app/api/communities/** (Kev, 2026-10-30: "propose me something, that cant be duplicated and will work as a harbour AND
 * gallery ..."; "es sollte permissionless erstellt werden"; "max 18 communities pro werk"; "wo kann ich nach denen suchen
 * sodass sie mir vorgeschlagen werden?"; the shape agreed with "ja lass mal probieren und iterieren") against SQL 54 itself
 * in PGlite (lib/__tests__/_pglite-postgrest.ts stands in for the service-role client): the directory and its search, a
 * create asked about close ones first, a handle's redirects, editing, joining, the lists, an item's communities with its
 * prompt's read in, the soft suggestion, the Showroom, a moderator's hide and an admin's merge queue. Guests are refused
 * every write, someone else's item reads as none, every cap and field rule answers its sentence, and before SQL 54 runs
 * every route says so in one sentence.
 */
type Row = Record<string, unknown>;
const pgs = vi.hoisted(() => ({ client: null as unknown }));
const screens = vi.hoisted(() => [] as Record<string, string>[]);
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => pgs.client }));
// Tier 1 stands in: text with BLOCKME is refused; what each write sends is kept.
vi.mock("@/lib/moderation", async (original) => ({
  ...(await original<typeof import("@/lib/moderation")>()),
  screenFirst: (inputs: Record<string, string>) => {
    screens.push(inputs);
    return Object.values(inputs).some((v) => v.includes("BLOCKME")) ? { allowed: false } : null;
  },
}));
// The accounts, by session token (hoisted with the mocks that read them).
const who = vi.hoisted(() => {
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  return { id, ME: id(1), HER: id(2), ADMIN: id(3), MOD: id(4), BUSY: id(5), BANNED: id(6) };
});
const { id, ME, HER, ADMIN, MOD, BUSY, BANNED } = who;
vi.mock("@/lib/session-user", async () => {
  const { DbUnreachableError } = await import("@/lib/db-error");
  const people: Record<string, string> = { me: who.ME, her: who.HER, admin: who.ADMIN, mod: who.MOD, busy: who.BUSY };
  return { resolveSessionUserId: async (_s: unknown, t: string | null) => {
    if (t === "down") throw new DbUnreachableError();
    return people[t ?? ""] ?? null;
  } };
});

import { GET as directory, POST as create } from "../../app/api/communities/route";
import { GET as readOne, PATCH as patchOne, DELETE as deleteOne } from "../../app/api/communities/[handle]/route";
import { PUT as joinOne, DELETE as leaveOne } from "../../app/api/communities/[handle]/membership/route";
import { GET as listOf } from "../../app/api/communities/[handle]/[list]/route";
import { POST as hideIn } from "../../app/api/communities/[handle]/hide/route";
import { GET as linksOf, PUT as setLinks } from "../../app/api/communities/links/route";
import { POST as suggest } from "../../app/api/communities/suggest/route";
import { POST as postOne } from "../../app/api/communities/posts/route";
import { GET as readPost, DELETE as deletePost } from "../../app/api/communities/posts/[id]/route";
import { GET as mergeQueue, POST as merge } from "../../app/api/communities/merges/route";

const SQL54 = readFileSync(join(__dirname, "..", "..", "migrations", "2026-10-30-communities.sql"), "utf8");
// The live columns SQL 54 and the routes read (VERIFIED live 2026-10-30, the migration's header), on Supabase's roles.
const STUBS = `
  create role anon; create role authenticated; create role service_role bypassrls;
  create table public.users (id uuid primary key, handle text, role text not null default 'user', deleted_at timestamptz,
    account_status text default 'active', adult_confirmed_at timestamptz);
  insert into public.users (id, handle, role) values ('${ME}', 'me', 'user'), ('${HER}', 'her', 'user'), ('${ADMIN}', 'boss', 'admin'),
    ('${MOD}', 'mod', 'mod'), ('${BUSY}', 'busy', 'user'), ('${BANNED}', 'banned', 'user');
  create table public.bans (id uuid primary key default gen_random_uuid(), user_id uuid, lifted_at timestamptz, expires_at timestamptz);
  create table public.prompts (id uuid primary key default gen_random_uuid(), creator_id uuid references public.users(id), title text,
    is_listed boolean default true, listing_status text default 'active', deleted_at timestamptz, is_adult boolean default false,
    like_count int default 0, published_at timestamptz default now(), showcase_images jsonb default '[]', created_at timestamptz default now());
  create table public.generations (id uuid primary key default gen_random_uuid(), prompt_id uuid references public.prompts(id), deleted_at timestamptz);
  create table public.generated_images (id uuid primary key default gen_random_uuid(), user_id uuid references public.users(id),
    prompt_id uuid references public.prompts(id), mime_type text default 'image/png', storage_url text, preview_url text, thumbnail_url text,
    width int, height int, is_adult boolean default false, like_count int default 0, visibility text default 'public',
    is_uploaded boolean default false, deleted_at timestamptz, published_at timestamptz default now(), created_at timestamptz not null default now());
  create table public.user_ignores (user_id uuid, ignored_id uuid, primary key (user_id, ignored_id));
  create table public.admin_actions (id uuid primary key default gen_random_uuid(), seq bigserial, actor_id uuid, actor_role text, action text,
    target text, detail jsonb, ip_hash text, created_at timestamptz default now());
`;

let pg: PGlite;
let bare: PGlite;
let live: ReturnType<typeof pglitePostgrest>;
const sql = <R = Row>(text: string, params: unknown[] = []) => pg.query<R>(text, params).then((r) => r.rows);

/* ── Calling the routes. ── */
type Handler = (req: NextRequest, ctx: { params: Promise<never> }) => Promise<Response>;
let address = 0;
const call = async (handler: unknown, method: string, path: string, params: Row, body?: unknown, token: string | null = "me", ip?: string) => {
  const res = await (handler as Handler)(new NextRequest(`http://enki.test/api/communities${path}`, {
    method,
    headers: { "Content-Type": "application/json", "x-real-ip": ip ?? `10.1.${++address >> 8}.${address & 255}`, ...(token ? { "X-Session-Token": token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), { params: Promise.resolve(params as never) });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return [res.status, await res.json()] as [number, any];
};
const api = {
  directory: (query = "", t: string | null = "me") => call(directory, "GET", `?${query}`, {}, undefined, t),
  create: (body: unknown, t: string | null = "me") => call(create, "POST", "", {}, body, t),
  read: (handle: string, t: string | null = "me") => call(readOne, "GET", `/${handle}`, { handle }, undefined, t),
  patch: (handle: string, body: unknown, t: string | null = "me") => call(patchOne, "PATCH", `/${handle}`, { handle }, body, t),
  remove: (handle: string, t: string | null = "me") => call(deleteOne, "DELETE", `/${handle}`, { handle }, undefined, t),
  join: (handle: string, t: string | null = "me") => call(joinOne, "PUT", `/${handle}/membership`, { handle }, undefined, t),
  leave: (handle: string, t: string | null = "me") => call(leaveOne, "DELETE", `/${handle}/membership`, { handle }, undefined, t),
  list: (handle: string, list: string, query = "", t: string | null = "me") => call(listOf, "GET", `/${handle}/${list}?${query}`, { handle, list }, undefined, t),
  hide: (handle: string, body: unknown, t: string | null = "mod") => call(hideIn, "POST", `/${handle}/hide`, { handle }, body, t),
  links: (kind: string, item: string, t: string | null = "me") => call(linksOf, "GET", `/links?kind=${kind}&id=${item}`, {}, undefined, t),
  setLinks: (body: unknown, t: string | null = "me") => call(setLinks, "PUT", "/links", {}, body, t),
  suggest: (body: unknown, t: string | null = "me") => call(suggest, "POST", "/suggest", {}, body, t),
  post: (body: unknown, t: string | null = "me") => call(postOne, "POST", "/posts", {}, body, t),
  readPost: (post: string, t: string | null = "me") => call(readPost, "GET", `/posts/${post}`, { id: post }, undefined, t),
  deletePost: (post: string, t: string | null = "me") => call(deletePost, "DELETE", `/posts/${post}`, { id: post }, undefined, t),
  merges: (t: string | null = "admin") => call(mergeQueue, "GET", "/merges", {}, undefined, t),
  merge: (body: unknown, t: string | null = "admin") => call(merge, "POST", "/merges", {}, body, t),
};

/* ── Fixtures, written straight into SQL 54's tables. ── */
// Made two days ago (outside the day's cap), a second apart in the order made.
let seeded = 0;
const community = async (handle: string, by: string | null = ME, name = handle.replace(/_/g, " ")) =>
  (await sql<{ id: string }>(`insert into public.communities (handle, core, name, created_by, created_at) values ($1, $2, $3, $4, now() - interval '2 days' + $5 * interval '1 second') returning id`,
    [handle, coreWord(handle), name, by, ++seeded]))[0].id;
const prompt = async (creator = ME, extra: Row = {}) =>
  (await sql<{ id: string }>(`insert into public.prompts (creator_id, is_listed, listing_status, is_adult, showcase_images) values ($1, $2, $3, $4, $5::jsonb) returning id`,
    [creator, extra.is_listed ?? true, extra.listing_status ?? "active", extra.is_adult ?? false, JSON.stringify(extra.showcase_images ?? [])]))[0].id;
const render = async (owner = ME, promptId: string | null = null, extra: Row = {}) => {
  const p = promptId ?? (await prompt(owner, { is_listed: false, listing_status: "draft" }));
  const [r] = await sql<{ id: string }>(`insert into public.generated_images (user_id, prompt_id, visibility, is_uploaded, is_adult, like_count, mime_type) values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [owner, p, extra.visibility ?? "public", extra.is_uploaded ?? false, extra.is_adult ?? false, extra.like_count ?? 0, extra.mime_type ?? "image/png"]);
  await sql(`update public.generated_images set storage_url = 'https://cdn.test/' || id || '.png', preview_url = 'https://cdn.test/' || id || '.webp', thumbnail_url = 'https://cdn.test/' || id || '.t.webp' where id = $1`, [r.id]);
  return r.id;
};
const link = (c: string, column: "prompt_id" | "image_id" | "post_id", item: string, by = ME, state = "shown") =>
  sql(`insert into public.community_links (community_id, ${column}, user_id, state) values ($1, $2, $3, $4)`, [c, item, by, state]);
const members = (c: string, ...users: string[]) => Promise.all(users.map((u) => sql(`insert into public.community_members (community_id, user_id) values ($1, $2)`, [c, u])));
const manyCommunities = async (n: number, prefix: string) =>
  (await sql<{ id: string }>(`insert into public.communities (handle, core, name) select $1 || k, $1 || k, 'Many ' || k from generate_series(1, $2::int) k returning id`, [prefix, n])).map((r) => r.id);
const err = (error: string, extra: Row = {}) => ({ error, ...extra });
const NOT_FOUND = err("Not found");
const card = (c: Row) => ({ id: expect.any(String), handle: c.handle, name: c.name ?? expect.any(String), members: c.members ?? 0, works: c.works ?? 0, works7d: c.works7d ?? c.works ?? 0, listed: c.listed ?? false, cover: c.cover ?? null });
const logged = () => sql<{ actor_id: string; actor_role: string; action: string; target: string }>(`select actor_id, actor_role, action, target from public.admin_actions order by seq`);

// Time moves on by two minutes a test (the limits count a minute), as it does by itself in between.
const realNow = Date.now.bind(Date);
let offset = 0;
beforeAll(async () => {
  [pg, bare] = await Promise.all([PGlite.create(), PGlite.create()]);
  await Promise.all([pg.exec(STUBS), bare.exec(STUBS)]);
  await pg.exec(SQL54);
  live = pglitePostgrest(pg);
}, 60_000);
afterAll(async () => { vi.restoreAllMocks(); await Promise.all([pg.close(), bare.close()]); });
beforeEach(async () => {
  // A fresh minute for each test (the write limit is under test only where it says so), and empty tables.
  offset += 120_000;
  vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
  pgs.client = live.client;
  live.state.unreachable = false;
  screens.length = 0;
  await sql(`truncate public.community_links, public.showroom_posts, public.community_members, public.community_aliases, public.communities,
    public.generated_images, public.generations, public.prompts, public.admin_actions, public.user_ignores, public.bans cascade`);
  await sql(`update public.users set adult_confirmed_at = null, deleted_at = null`);
});

describe("before SQL 54 runs and when the database is away", () => {
  it("answers every route with one sentence (503) and stores nothing", async () => {
    pgs.client = pglitePostgrest(bare).client;
    const [r] = (await bare.query<{ id: string }>(`insert into public.generated_images (user_id, visibility) values ($1, 'public') returning id`, [ME])).rows;
    const notReady = [503, err(T.COMMUNITIES_NOT_READY)];
    const answers = [
      await api.directory(), await api.directory("q=gundam"), await api.create({ name: "Gundam" }), await api.read("gundam"),
      await api.patch("gundam", { name: "G" }), await api.join("gundam"), await api.list("gundam", "works"), await api.links("image", r.id),
      await api.setLinks({ kind: "image", ids: [r.id], communityIds: [] }), await api.suggest({ text: "gundam" }),
      await api.post({ imageId: r.id, title: "t", communityIds: [id(99)] }), await api.readPost(id(98)), await api.hide("gundam", { kind: "image", id: r.id, hidden: true }),
      await api.remove("gundam", "admin"), await api.merges(), await api.merge({ from: id(97), into: id(96) }),
    ];
    for (const [i, a] of answers.entries()) expect(a, String(i)).toEqual(notReady);
  });

  it("refuses guests every write (401) and answers an unreachable database as the outage (503)", async () => {
    const c = await community("gundam");
    for (const [status, body] of [
      await api.create({ name: "x" }, null), await api.patch("gundam", {}, null), await api.remove("gundam", null), await api.join("gundam", null),
      await api.leave("gundam", null), await api.hide("gundam", {}, null), await api.setLinks({}, null), await api.suggest({ text: "x" }, null),
      await api.post({}, null), await api.deletePost(id(9), null), await api.merges(null), await api.merge({}, null),
    ]) expect([status, body]).toEqual([401, err("Not signed in")]);
    expect(await api.read("gundam", "down")).toEqual([503, { success: false, error: DB_UNAVAILABLE_MESSAGE, code: "DB_UNAVAILABLE" }]);
    live.state.unreachable = true;
    expect(await api.read("gundam", null)).toEqual([503, { success: false, error: DB_UNAVAILABLE_MESSAGE, code: "DB_UNAVAILABLE" }]);
    expect(await api.directory("", null)).toEqual([503, { success: false, error: DB_UNAVAILABLE_MESSAGE, code: "DB_UNAVAILABLE" }]);
    live.state.unreachable = false;
    expect(c).toBeTruthy();
  });

  it(`limits writes to ${T.COMMUNITY_WRITES_PER_MIN} an account and reads to ${T.COMMUNITY_READS_PER_MIN} an address, a minute`, async () => {
    await community("gundam");
    for (let i = 0; i < T.COMMUNITY_WRITES_PER_MIN; i++) await call(joinOne, "PUT", "/gundam/membership", { handle: "gundam" }, undefined, "busy");
    expect((await call(joinOne, "PUT", "/gundam/membership", { handle: "gundam" }, undefined, "busy"))[0]).toBe(429);
    expect((await api.join("gundam", "me"))[0]).toBe(200);
    for (let i = 0; i < T.COMMUNITY_READS_PER_MIN; i++) await call(readOne, "GET", "/gundam", { handle: "gundam" }, undefined, null, "10.9.9.9");
    expect((await call(readOne, "GET", "/gundam", { handle: "gundam" }, undefined, null, "10.9.9.9"))[0]).toBe(429);
    expect((await call(readOne, "GET", "/gundam", { handle: "gundam" }, undefined, null, "10.9.9.8"))[0]).toBe(200);
  }, 60_000);
});

describe("creating a community", () => {
  it("makes one of a name (its handle the name's slug), its fields trimmed, its creator joined; anyone signed in may", async () => {
    const [status, body] = await api.create({ name: "  Gundam Wing! ", description: "  Mobile suits. " });
    expect(status).toBe(201);
    expect(body.community).toEqual({
      ...card({ handle: "gundam_wing", name: "Gundam Wing!", members: 1 }), description: "Mobile suits.", aliases: [], createdBy: { handle: "me" },
      createdAt: expect.any(String), joined: true, canEdit: true, staff: null,
    });
    expect(await sql(`select handle, core, created_by from public.communities`)).toEqual([{ handle: "gundam_wing", core: "gundamwing", created_by: ME }]);
    // A handle of its own, lower-cased; no description is none; tier 1 read the name, the description and the handle.
    const [, pepe] = await api.create({ name: "Pepe", handle: "The_Pepe" }, "her");
    expect(pepe.community).toMatchObject({ handle: "the_pepe", description: null, canEdit: true });
    expect(screens).toEqual([{ name: "Gundam Wing!", description: "Mobile suits.", handle: "gundam wing" }, { name: "Pepe", handle: "the pepe" }]);
  });

  it("answers each field rule with its sentence and stores nothing", async () => {
    for (const [body, sentence] of [
      [{}, T.NAME_NEEDED], [{ name: " x " }, T.NAME_NEEDED], [{ name: "x".repeat(T.COMMUNITY_TEXT.name + 1) }, T.TOO_LONG.name],
      [{ name: "Ok", description: "d".repeat(T.COMMUNITY_TEXT.description + 1) }, T.TOO_LONG.description],
      [{ name: "ガンダム" }, T.BAD_HANDLE], [{ name: "Ok", handle: "bad handle" }, T.BAD_HANDLE], [{ name: "Ok", handle: "a" }, T.BAD_HANDLE],
      [{ name: "Enki" }, T.HANDLE_RESERVED_SAID], [{ name: "Ok", handle: "0fficial" }, T.HANDLE_RESERVED_SAID], [{ name: 5 }, "Bad request"],
    ] as const) expect(await api.create(body), JSON.stringify(body)).toEqual([400, err(sentence)]);
    expect(await api.create({ name: "Fine", description: "BLOCKME" })).toEqual([422, err(expect.any(String))]);
    expect(await sql(`select count(*)::int as n from public.communities`)).toEqual([{ n: 0 }]);
  });

  it("answers a handle taken by its key (a look-alike, a merged one's target) with the one that is there", async () => {
    await api.create({ name: "Gundam" });
    const [status, body] = await api.create({ name: "Gund4m" }, "her");
    expect([status, body]).toEqual([409, err(T.HANDLE_TAKEN, { existing: card({ handle: "gundam", name: "Gundam", members: 1 }) })]);
    const old = await community("old_gundam");
    await sql(`select public.merge_community($1, (select id from public.communities where handle = 'gundam'))`, [old]);
    expect((await api.create({ name: "Old Gundam", handle: "old_gundarn", confirmed: true }, "her"))[1].existing).toMatchObject({ handle: "gundam" });
  });

  it("asks about close ones first (the same core word, a near key), and makes it anyway once confirmed", async () => {
    await api.create({ name: "Gundam" });
    await community("pepe");
    await community("the_robot_club");
    const [status, body] = await api.create({ name: "Gundam Fans" }, "her");
    expect([status, body]).toEqual([409, err(T.CLOSE_MATCHES, { closest: [card({ handle: "gundam", name: "Gundam", members: 1 })] })]);
    expect((await api.create({ name: "Gundarn 2" }, "her"))[1].closest.map((c: Row) => c.handle)).toEqual(["gundam"]);
    expect((await api.create({ name: "Pepi" }, "her"))[1].closest.map((c: Row) => c.handle)).toEqual(["pepe"]);
    // Only the core word ties these two (their keys share no start).
    expect((await api.create({ name: "Robot" }, "her"))[1].closest.map((c: Row) => c.handle)).toEqual(["the_robot_club"]);
    const [made, again] = await api.create({ name: "Gundam Fans", confirmed: true }, "her");
    expect([made, again.community.handle]).toEqual([201, "gundam_fans"]);
    // Nothing close: made at once.
    expect((await api.create({ name: "Mecha" }, "her"))[0]).toBe(201);
  });

  it("asks about a name taken under another handle or slug (any case), not only a close handle", async () => {
    await api.create({ name: "Gundam" });
    const [status, body] = await api.create({ name: "Gundam", handle: "mobile_suits" }, "her");
    expect([status, body.closest?.map((c: Row) => c.handle)]).toEqual([409, ["gundam"]]);
    // Not the same name, but its slug is close: asked by the name's slug as by a handle.
    expect((await api.create({ name: "Gundam 2", handle: "mobile_suits" }, "her"))[1].closest?.map((c: Row) => c.handle)).toEqual(["gundam"]);
    // Named exactly like one whose handle and core are nowhere near.
    await community("mecha_world", ME, "Big Robots");
    expect((await api.create({ name: "big robots", handle: "giant_mechs" }, "her"))[1].closest.map((c: Row) => c.handle)).toEqual(["mecha_world"]);
    expect((await api.create({ name: "Big Robots 2", handle: "giant_mechs", confirmed: true }, "her"))[0]).toBe(201);
  });

  it("asks about vamps (Kev: \"there are vamps\"): filler glued on, or a word before or after a name", async () => {
    for (const [h, n] of [["pepe", "Pepe"], ["gundam", "Gundam"], ["apu", "Apu"]]) await community(h, ME, n);
    const asked = async (name: string) => {
      const [s, b] = await api.create({ name }, "her");
      return [s, b.closest?.map((c: Row) => c.handle) ?? b.community?.handle];
    };
    for (const name of ["Pepecoin", "PepeToken", "Thepepe", "Baby Pepe", "Pepewifhat"]) expect(await asked(name), name).toEqual([409, ["pepe"]]);
    expect(await asked("Gundamfans")).toEqual([409, ["gundam"]]);
    expect(await asked("Babyapu")).toEqual([409, ["apu"]]);
    // A vamp there first: the name it holds is asked about it, at its start and at its end.
    await community("babydoge", ME, "Baby Doge");
    await community("dogewifhat", ME, "Doge wif hat");
    expect(await asked("The Doge")).toEqual([409, ["babydoge", "dogewifhat"]]);
    // A name inside another word, or what is left of one once filler is off, is no vamp.
    await community("theory", ME, "Theory");
    expect(await asked("Capuchin")).toEqual([201, "capuchin"]);
    expect(await asked("History")).toEqual([201, "history"]);
  });

  it("counts a name in characters as the database does: one emoji is one", async () => {
    expect(await api.create({ name: "😀", handle: "smile" })).toEqual([400, err(T.NAME_NEEDED)]);
    expect((await api.create({ name: "😀😀", handle: "smiles" }))[0]).toBe(201);
    expect(await api.patch("smiles", { name: "😀" })).toEqual([400, err(T.NAME_NEEDED)]);
    expect((await api.patch("smiles", { name: "😀".repeat(T.COMMUNITY_TEXT.name) }))[1].community.name).toBe("😀".repeat(T.COMMUNITY_TEXT.name));
    expect(await api.patch("smiles", { name: "😀".repeat(T.COMMUNITY_TEXT.name + 1) })).toEqual([400, err(T.TOO_LONG.name)]);
  });

  it(`holds ${T.MAX_NEW_COMMUNITIES_PER_DAY} new communities a day and ${T.MAX_NEW_COMMUNITIES} in all for an account`, async () => {
    for (const name of ["Alpha", "Bravo", "Charlie"]) expect((await api.create({ name, confirmed: true }))[0]).toBe(201);
    expect(await api.create({ name: "Delta", confirmed: true })).toEqual([409, err(T.NEW_COMMUNITIES_TODAY)]);
    await sql(`update public.communities set created_at = now() - interval '2 days'`);
    await sql(`insert into public.communities (handle, core, name, created_by, created_at) select 'old_' || k, 'old' || k, 'Old', $1, now() - interval '3 days' from generate_series(1, $2::int) k`, [ME, T.MAX_NEW_COMMUNITIES - 3]);
    expect(await api.create({ name: "Echo", confirmed: true })).toEqual([409, err(T.NEW_COMMUNITIES_FULL)]);
    expect((await api.create({ name: "Echo", confirmed: true }, "her"))[0]).toBe(201);
  });
});

describe("the directory and its search", () => {
  it("lists listed communities only, by trending, new or A-Z, a page at a time", async () => {
    const quiet = await community("quiet");
    const big = await community("big_crowd");
    const fresh = await community("fresh");
    const people = (await sql<{ id: string }>(`insert into public.users (id) select gen_random_uuid() from generate_series(1, 6) returning id`)).map((r) => r.id);
    await members(big, ...people);
    await members(fresh, ...people.slice(0, 5));
    await sql(`update public.communities set created_at = now() where id = $1`, [fresh]);
    await sql(`update public.communities set created_at = now() - interval '1 day' where id = $1`, [big]);
    await sql(`update public.communities set created_at = now() - interval '2 days' where id = $1`, [quiet]);
    const P = await prompt();
    for (let i = 0; i < T.LISTED_MIN_WORKS; i++) await link(quiet, "image_id", await render(ME, P));
    const handles = async (query: string) => (await api.directory(query))[1].communities.map((c: Row) => c.handle);
    expect(await handles("")).toEqual(["quiet", "big_crowd", "fresh"]);
    expect(await handles("sort=new")).toEqual(["fresh", "big_crowd", "quiet"]);
    expect(await handles("sort=az")).toEqual(["big_crowd", "fresh", "quiet"]);
    expect((await api.directory("sort=az"))[1].communities[2]).toEqual(card({ handle: "quiet", name: "quiet", works: T.LISTED_MIN_WORKS, listed: true, cover: expect.stringMatching(/^https:\/\/cdn\.test\//) }));
    // An unlisted one is not in the directory, only in a search.
    await community("tiny");
    expect(await handles("sort=az")).not.toContain("tiny");
    expect(await handles("q=tin")).toEqual(["tiny"]);
    expect(await api.directory("sort=hot")).toEqual([400, err("Bad request")]);
    // Pages of DIRECTORY_PAGE, the cursor the next offset.
    await sql(`insert into public.communities (handle, core, name) select 'page_' || k, 'page', 'Page' from generate_series(1, $1::int) k`, [T.DIRECTORY_PAGE]);
    await sql(`insert into public.community_members (community_id, user_id) select c.id, u.id from public.communities c cross join (select id from public.users limit 5) u where c.handle like 'page_%'`);
    const [, first] = await api.directory("sort=az");
    expect([first.communities.length, first.next]).toEqual([T.DIRECTORY_PAGE, String(T.DIRECTORY_PAGE)]);
    const [, second] = await api.directory(`sort=az&cursor=${first.next}`);
    const all = ["big_crowd", "fresh", "quiet", ...Array.from({ length: T.DIRECTORY_PAGE }, (_, k) => `page_${k + 1}`)].sort();
    expect([first.communities.map((c: Row) => c.handle), second.communities.map((c: Row) => c.handle), second.next])
      .toEqual([all.slice(0, T.DIRECTORY_PAGE), all.slice(T.DIRECTORY_PAGE), null]);
  });

  it("finds by the exact key, a handle's start, a search word, a handle merged into it, or a name, the biggest first, unlisted too", async () => {
    const gundam = await community("gundam", ME, "Gundam");
    const seed = await community("gundam_seed", ME, "Seed");
    await community("mecha", ME, "Big Gundam fans");
    const robots = await community("robots", ME, "Robots");
    await sql(`insert into public.community_aliases (community_id, alias) values ($1, 'gundams_too')`, [robots]);
    await members(seed, HER);
    const old = await community("gundam_old", HER, "Old");
    // A merged community's search word stays on its row: it finds the one it was merged into.
    await sql(`insert into public.community_aliases (community_id, alias) values ($1, 'mobile_suits')`, [old]);
    await sql(`select public.merge_community($1, $2)`, [old, (await community("zeta", HER, "Zeta"))]);
    const ranked = async (q: string) => (await api.directory(`q=${encodeURIComponent(q)}`))[1].communities.map((c: Row) => c.handle);
    expect(await ranked("Gund4m")).toEqual(["gundam", "gundam_seed", "robots", "zeta"]);
    expect(await ranked("gundam f")).toEqual(["mecha"]);
    expect(await ranked("gundam_o")).toEqual(["zeta"]);
    expect(await ranked("mobile")).toEqual(["zeta"]);
    // The typeahead's limit, up to a directory page; % and _ are themselves in a name.
    expect((await api.directory("q=gundam&limit=1"))[1]).toEqual({ communities: [expect.objectContaining({ handle: "gundam" })], next: null });
    await community("percent", ME, "100% real");
    expect(await ranked("0%")).toEqual(["percent"]);
    // % and _ are themselves: a hundred bigger names with a 0 and any character after it never push out one with "0_".
    await sql(`insert into public.communities (handle, core, name) select 'crowd_' || k, 'crowd', 'a0b' || k from generate_series(1, 100) k`);
    await sql(`insert into public.community_members (community_id, user_id) select id, $1 from public.communities where handle like 'crowd_%'`, [ME]);
    await community("team_zero", ME, "Team 0_1");
    expect(await ranked("0_")).toEqual(["team_zero"]);
    // The exact key is found however many bigger ones start with it (typed as a look-alike, so no name holds the text).
    await sql(`insert into public.communities (handle, core, name) select 'gundam_x' || k, 'gundam', 'Big X' from generate_series(1, 100) k`);
    await sql(`insert into public.community_members (community_id, user_id) select id, $1 from public.communities where handle like 'gundam_x%'`, [ME]);
    expect((await ranked("Gund4m"))[0]).toBe("gundam");
    expect(await api.directory(`q=${"x".repeat(T.COMMUNITY_TEXT.query + 1)}`)).toEqual([400, err("Bad request")]);
    expect(gundam).toBeTruthy();
  });
});

describe("one community", () => {
  it("reads its detail for its viewer, and redirects a merged handle and a look-alike to the live one", async () => {
    const c = await community("gundam", HER, "Gundam");
    await sql(`insert into public.community_aliases (community_id, alias) values ($1, 'mobile_suit')`, [c]);
    await members(c, ME);
    expect(await api.read("gundam")).toEqual([200, { community: {
      ...card({ handle: "gundam", name: "Gundam", members: 1 }), description: null, aliases: ["mobile_suit"], createdBy: { handle: "her" },
      createdAt: expect.any(String), joined: true, canEdit: false, staff: null,
    } }]);
    expect((await api.read("gundam", "her"))[1].community).toMatchObject({ joined: false, canEdit: true, staff: null });
    expect((await api.read("gundam", "admin"))[1].community).toMatchObject({ canEdit: true, staff: "admin" });
    expect((await api.read("gundam", "mod"))[1].community).toMatchObject({ canEdit: false, staff: "mod" });
    expect((await api.read("gundam", null))[1].community).toMatchObject({ joined: false, canEdit: false, staff: null });
    expect(await api.read("GUND4M")).toEqual([200, { redirect: "gundam" }]);
    const old = await community("old_suits");
    await sql(`select public.merge_community($1, $2)`, [old, c]);
    expect(await api.read("old_suits")).toEqual([200, { redirect: "gundam" }]);
    expect(await api.read("nothing")).toEqual([404, NOT_FOUND]);
    expect(await api.read("!!!")).toEqual([404, NOT_FOUND]);
  });

  it("lets its creator or an admin edit the name, description and search words; anyone else 403", async () => {
    await community("gundam", ME, "Gundam");
    const [status, body] = await api.patch("gundam", { name: " Gundam! ", description: " Suits ", aliases: ["Mobile Suit", "mobile_suit", "G", "gund4m", "Zaku"] });
    expect(status).toBe(200);
    expect(body.community).toMatchObject({ name: "Gundam!", description: "Suits", aliases: ["mobile_suit", "zaku"] });
    expect(screens.at(-1)).toEqual({ name: "Gundam!", description: "Suits", aliases: "mobile suit zaku" });
    // The list replaces: a word kept stays, one gone goes, one new comes; null clears the description; an absent field stays.
    expect((await api.patch("gundam", { aliases: ["zaku", "rx 78"], description: null }))[1].community).toMatchObject({ name: "Gundam!", description: null, aliases: ["rx_78", "zaku"] });
    expect((await api.patch("gundam", { name: "By the boss" }, "admin"))[1].community.name).toBe("By the boss");
    expect(await api.patch("gundam", { name: "Mine" }, "her")).toEqual([403, err(T.NOT_YOURS)]);
    expect(await api.patch("gundam", { name: "Mine" }, "mod")).toEqual([403, err(T.NOT_YOURS)]);
    expect(await api.patch("gundam", { aliases: Array.from({ length: T.MAX_ALIASES + 1 }, (_, i) => `word_${i}`) })).toEqual([409, err(T.ALIASES_FULL)]);
    // Refused before anything is written: the words there stay.
    expect((await api.read("gundam"))[1].community.aliases).toEqual(["rx_78", "zaku"]);
    expect(await api.patch("gundam", { aliases: ["x".repeat(T.COMMUNITY_TEXT.alias + 1)] })).toEqual([400, err(T.TOO_LONG.alias)]);
    expect(await api.patch("gundam", { aliases: "zaku" })).toEqual([400, err("Bad request")]);
    expect(await api.patch("gundam", { name: "" })).toEqual([400, err(T.NAME_NEEDED)]);
    expect(await api.patch("gundam", { description: "BLOCKME" })).toEqual([422, err(expect.any(String))]);
    expect(await api.patch("nothing", { name: "x" })).toEqual([404, NOT_FOUND]);
    const old = await community("old_suits");
    await sql(`select public.merge_community($1, (select id from public.communities where handle = 'gundam'))`, [old]);
    expect(await api.patch("old_suits", { name: "x" })).toEqual([409, err(T.MERGED_ALREADY)]);
  });

  it("refuses a search word that is another community's handle, a merged one's too; one merged into it is its own", async () => {
    const pepe = await community("pepe", ME, "Pepe");
    const frogs = await community("frogs", HER, "Frogs");
    await sql(`select public.merge_community($1, $2)`, [await community("kek", ME), pepe]);
    await sql(`select public.merge_community($1, $2)`, [await community("old_frogs", HER), frogs]);
    expect(await api.patch("frogs", { aliases: ["apu", "P3pe"] }, "her")).toEqual([409, err(T.ALIAS_IS_A_HANDLE, { alias: "p3pe" })]);
    expect(await api.patch("frogs", { aliases: ["kek"] }, "her")).toEqual([409, err(T.ALIAS_IS_A_HANDLE, { alias: "kek" })]);
    expect((await api.read("frogs"))[1].community.aliases).toEqual([]);
    expect((await api.patch("frogs", { aliases: ["apu", "old_frogs"] }, "her"))[1].community.aliases).toEqual(["apu", "old_frogs"]);
    // So "pepe" still suggests c/pepe only.
    expect((await api.suggest({ text: "pepe" }))[1].suggestions.map((c: Row) => c.handle)).toEqual(["pepe"]);
  });

  it(`finds none by a handle over ${T.COMMUNITY_TEXT.query} characters`, async () => {
    await community("gundam");
    expect(await api.read(`gundam${"!".repeat(T.COMMUNITY_TEXT.query - 6)}`)).toEqual([200, { redirect: "gundam" }]);
    expect(await api.read(`gundam${"!".repeat(T.COMMUNITY_TEXT.query - 5)}`)).toEqual([404, NOT_FOUND]);
  });

  it("lets an admin delete one (logged), its links, members and merged handles with it; anyone else 403", async () => {
    const c = await community("spam");
    await members(c, HER);
    await link(c, "image_id", await render());
    const old = await community("old_spam");
    await sql(`select public.merge_community($1, $2)`, [old, c]);
    expect(await api.remove("spam", "me")).toEqual([403, err(T.ADMIN_ONLY)]);
    expect(await api.remove("spam", "mod")).toEqual([403, err(T.ADMIN_ONLY)]);
    expect(await api.remove("spam", "admin")).toEqual([200, { deleted: true }]);
    expect(await sql(`select (select count(*)::int from public.communities) as c, (select count(*)::int from public.community_links) as l, (select count(*)::int from public.community_members) as m`))
      .toEqual([{ c: 0, l: 0, m: 0 }]);
    expect(await logged()).toEqual([{ actor_id: ADMIN, actor_role: "admin", action: "community.delete", target: c }]);
    expect(await api.remove("spam", "admin")).toEqual([404, NOT_FOUND]);
  });

  it("joins and leaves, a second join reading as in; a merged handle 409", async () => {
    await community("gundam", HER);
    expect(await api.join("gundam")).toEqual([200, { joined: true, members: 1 }]);
    expect(await api.join("gundam")).toEqual([200, { joined: true, members: 1 }]);
    expect(await api.join("gundam", "her")).toEqual([200, { joined: true, members: 2 }]);
    expect(await api.leave("gundam")).toEqual([200, { joined: false, members: 1 }]);
    expect(await api.join("nothing")).toEqual([404, NOT_FOUND]);
    await sql(`select public.merge_community((select id from public.communities where handle = 'gundam'), $1)`, [await community("zeta")]);
    expect(await api.join("gundam")).toEqual([409, err(T.MERGED_ALREADY)]);
  });
});

describe("a community's lists", () => {
  it("lists its works newest or most liked first, a page at a time: owners' handles, prompts only while listed, videos as videos", async () => {
    const c = await community("gundam");
    const listed = await prompt(HER);
    const draft = await prompt(HER, { is_listed: false, listing_status: "draft" });
    const a = await render(ME, draft, { like_count: 5 });
    const b = await render(HER, listed, { mime_type: "video/mp4" });
    await sql(`insert into public.community_links (community_id, image_id, user_id, created_at) values ($1, $2, $3, now() - interval '1 hour')`, [c, a, ME]);
    await sql(`update public.generated_images set published_at = now() - interval '1 hour' where id = $1`, [a]);
    await link(c, "prompt_id", listed, HER);
    const [status, body] = await api.list("gundam", "works");
    expect(status).toBe(200);
    expect(body).toEqual({ works: [
      { imageId: b, kind: "video", url: `https://cdn.test/${b}.webp`, thumb: `https://cdn.test/${b}.t.webp`, width: null, height: null, owner: { handle: "her" }, promptId: listed, likes: 0, addedAt: expect.any(String) },
      { imageId: a, kind: "image", url: `https://cdn.test/${a}.webp`, thumb: `https://cdn.test/${a}.t.webp`, width: null, height: null, owner: { handle: "me" }, promptId: null, likes: 5, addedAt: expect.any(String) },
    ], next: null });
    expect((await api.list("gundam", "works", "sort=top"))[1].works.map((w: Row) => w.imageId)).toEqual([a, b]);
    expect(await api.list("gundam", "works", "sort=old")).toEqual([400, err("Bad request")]);
    expect(await api.list("gundam", "prompts")).toEqual([404, NOT_FOUND]);
    expect(await api.list("nothing", "works")).toEqual([404, NOT_FOUND]);
    const more = await Promise.all(Array.from({ length: T.WORKS_PAGE }, () => render(ME, listed)));
    expect(more).toHaveLength(T.WORKS_PAGE);
    const [, page] = await api.list("gundam", "works");
    expect([page.works.length, page.next]).toEqual([T.WORKS_PAGE, String(T.WORKS_PAGE)]);
    expect((await api.list("gundam", "works", `cursor=${page.next}`))[1]).toEqual({ works: [expect.any(Object), expect.any(Object)], next: null });
  });

  it("leaves 18+ works out unless the viewer may see them, and whom the viewer ignores", async () => {
    const c = await community("gundam");
    const P = await prompt(HER);
    await link(c, "prompt_id", P, HER);
    const adult = await render(HER, P, { is_adult: true });
    const hers = await render(HER, P);
    const mine = await render(ME, P);
    const seen = async (t: string | null) => (await api.list("gundam", "works", "", t))[1].works.map((w: Row) => w.imageId).sort();
    expect(await seen("me")).toEqual([hers, mine].sort());
    await sql(`insert into public.user_ignores (user_id, ignored_id) values ($1, $2)`, [ME, HER]);
    expect(await seen("me")).toEqual([mine]);
    expect(await seen(null)).toEqual([hers, mine].sort());
    // A confirmed adult with the pill on sees it.
    await sql(`update public.users set adult_confirmed_at = now() where id = $1`, [ME]);
    await sql(`delete from public.user_ignores`);
    const res = await (listOf as Handler)(new NextRequest("http://enki.test/api/communities/gundam/works", { headers: { "X-Session-Token": "me", "X-Show-Adult": "1", "x-real-ip": "10.8.0.1" } }), { params: Promise.resolve({ handle: "gundam", list: "works" } as never) });
    expect(((await res.json()).works as Row[]).map((w) => w.imageId).sort()).toEqual([adult, hers, mine].sort());
  });

  it("lists its members newest first, its creator marked", async () => {
    const c = await community("gundam", HER);
    await members(c, HER);
    await sql(`insert into public.community_members (community_id, user_id, created_at) values ($1, $2, now() + interval '1 minute')`, [c, ME]);
    expect(await api.list("gundam", "members")).toEqual([200, { members: [
      { handle: "me", creator: false, joinedAt: expect.any(String) }, { handle: "her", creator: true, joinedAt: expect.any(String) },
    ], next: null }]);
  });
});

describe("a community's members, hidden accounts aside", () => {
  it("leaves banned and deleted accounts out of its members and their count; a ban that ran out is none", async () => {
    const c = await community("gundam", ME, "Gundam");
    await members(c, ME, HER, BANNED, BUSY, ADMIN);
    await sql(`insert into public.bans (user_id) values ($1)`, [BANNED]);
    await sql(`insert into public.bans (user_id, expires_at) values ($1, now() - interval '1 day')`, [ADMIN]);
    await sql(`update public.users set deleted_at = now() where id = $1`, [BUSY]);
    expect((await api.list("gundam", "members", "", null))[1].members.map((m: Row) => m.handle).sort()).toEqual(["boss", "her", "me"]);
    expect((await api.read("gundam", null))[1].community.members).toBe(3);
    expect(await api.join("gundam", "mod")).toEqual([200, { joined: true, members: 4 }]);
  });
});

describe("an item's communities", () => {
  it("reads a render's own links and its listed prompt's, less those it was opted out of or hidden from; its owner learns which", async () => {
    const [a, b, c, d] = await Promise.all(["alpha", "bravo", "charlie", "delta"].map((h) => community(h)));
    const P = await prompt(HER);
    for (const x of [a, b, c]) await link(x, "prompt_id", P, HER);
    const r = await render(ME, P);
    await link(d, "image_id", r);
    await link(b, "image_id", r, ME, "opted_out");
    await link(c, "image_id", r, MOD, "hidden");
    expect(await api.links("image", r)).toEqual([200, {
      communities: [{ id: a, handle: "alpha", name: "alpha" }, { id: d, handle: "delta", name: "delta" }], inherited: [a],
      optedOut: [{ id: b, handle: "bravo", name: "bravo" }], hidden: [{ id: c, handle: "charlie", name: "charlie" }],
    }]);
    expect((await api.links("image", r, "her"))[1]).toMatchObject({ optedOut: [], hidden: [] });
    // Its prompt delisted brings nothing more.
    await sql(`update public.prompts set is_listed = false where id = $1`, [P]);
    expect((await api.links("image", r))[1]).toMatchObject({ communities: [{ id: d, handle: "delta", name: "delta" }], inherited: [], optedOut: [] });
  });

  it("shows an item only to whom may see it: a listed prompt, a public render, a post whose render is public, else its owner", async () => {
    const draft = await prompt(ME, { is_listed: false, listing_status: "draft" });
    const privately = await render(ME, null, { visibility: "private" });
    const upload = await render(ME, null, { is_uploaded: true });
    expect((await api.links("prompt", draft))[0]).toBe(200);
    expect(await api.links("prompt", draft, "her")).toEqual([404, NOT_FOUND]);
    expect((await api.links("image", privately))[0]).toBe(200);
    expect(await api.links("image", privately, null)).toEqual([404, NOT_FOUND]);
    expect(await api.links("image", upload)).toEqual([404, NOT_FOUND]);
    const pub = await render(HER);
    const [post] = await sql<{ id: string }>(`insert into public.showroom_posts (user_id, image_id, title) values ($1, $2, 't') returning id`, [HER, pub]);
    expect((await api.links("post", post.id, null))[0]).toBe(200);
    await sql(`update public.generated_images set visibility = 'private' where id = $1`, [pub]);
    expect(await api.links("post", post.id, null)).toEqual([404, NOT_FOUND]);
    expect(await api.links("thing", post.id)).toEqual([400, err("Bad request")]);
    expect(await api.links("post", "nope")).toEqual([400, err("Bad request")]);
  });

  it("sets an owner's item to the whole list: new links in, gone ones out, its prompt's left out opted out of and in again when put back", async () => {
    const [a, b, c, d] = await Promise.all(["alpha", "bravo", "charlie", "delta"].map((h) => community(h)));
    const P = await prompt(HER);
    for (const x of [a, b]) await link(x, "prompt_id", P, HER);
    const r = await render(ME, P);
    const state = () => sql(`select c.handle, l.state from public.community_links l join public.communities c on c.id = l.community_id where l.image_id = $1 order by c.handle`, [r]);
    // b left out (opted out of), c and d in.
    const [status, body] = await api.setLinks({ kind: "image", ids: [r], communityIds: [a, c, d] });
    expect(status).toBe(200);
    expect(body.items).toEqual([{ id: r, communities: [a, c, d].map((x, i) => ({ id: x, handle: ["alpha", "charlie", "delta"][i], name: ["alpha", "charlie", "delta"][i] })), inherited: [a], optedOut: [{ id: b, handle: "bravo", name: "bravo" }], hidden: [] }]);
    expect(await state()).toEqual([{ handle: "bravo", state: "opted_out" }, { handle: "charlie", state: "shown" }, { handle: "delta", state: "shown" }]);
    // b put back, d gone: the opt-out goes, d's link goes.
    expect((await api.setLinks({ kind: "image", ids: [r], communityIds: [a, b, c] }))[1].items[0].communities.map((x: Row) => x.handle)).toEqual(["alpha", "bravo", "charlie"]);
    expect(await state()).toEqual([{ handle: "charlie", state: "shown" }]);
    // a left out though it is linked directly too: taken out (opted out).
    await link(a, "image_id", r);
    await api.setLinks({ kind: "image", ids: [r], communityIds: [b, c] });
    expect(await state()).toEqual([{ handle: "alpha", state: "opted_out" }, { handle: "charlie", state: "shown" }]);
    // A prompt's and a post's own list.
    const mine = await prompt(ME);
    expect((await api.setLinks({ kind: "prompt", ids: [mine], communityIds: [d, d] }))[1].items[0]).toEqual({ id: mine, communities: [{ id: d, handle: "delta", name: "delta" }], inherited: [], optedOut: [], hidden: [] });
    expect((await api.setLinks({ kind: "prompt", ids: [mine], communityIds: [] }))[1].items[0].communities).toEqual([]);
  });

  it(`holds a work to ${T.MAX_COMMUNITIES_PER_WORK} communities, its prompt's included; a hidden one stays out; merged ones are left out`, async () => {
    const ids = await manyCommunities(T.MAX_COMMUNITIES_PER_WORK + 1, "many_");
    const P = await prompt(HER);
    for (const x of ids.slice(0, 15)) await link(x, "prompt_id", P, HER);
    const r = await render(ME, P);
    expect(await api.setLinks({ kind: "image", ids: [r], communityIds: ids })).toEqual([409, err(T.TOO_MANY_COMMUNITIES)]);
    expect(await sql(`select count(*)::int as n from public.community_links where image_id = $1`, [r])).toEqual([{ n: 0 }]);
    // Exactly 18: 15 of its prompt's and 3 of its own.
    const [ok, body] = await api.setLinks({ kind: "image", ids: [r], communityIds: ids.slice(0, T.MAX_COMMUNITIES_PER_WORK) });
    expect([ok, body.items[0].communities.length, body.items[0].inherited.length]).toEqual([200, T.MAX_COMMUNITIES_PER_WORK, 15]);
    // 3 of the prompt's left out free 3 places for 1 more of its own.
    expect((await api.setLinks({ kind: "image", ids: [r], communityIds: [...ids.slice(3, 15), ...ids.slice(15)] }))[1].items[0].communities).toHaveLength(16);
    // A moderator's hide stays: asked for again, it is still out.
    await sql(`update public.community_links set state = 'hidden', user_id = $3 where community_id = $1 and image_id = $2`, [ids[16], r, MOD]);
    const [, again] = await api.setLinks({ kind: "image", ids: [r], communityIds: ids.slice(14) });
    expect(again.items[0].communities.map((c: Row) => c.id)).toEqual([ids[14], ids[15], ids[17], ids[18]]);
    expect(again.items[0].hidden.map((c: Row) => c.id)).toEqual([ids[16]]);
    expect((await sql<{ state: string }>(`select state from public.community_links where community_id = $1 and image_id = $2`, [ids[16], r]))[0].state).toBe("hidden");
    // A merged community asked for is left out, not refused.
    await sql(`select public.merge_community($1, $2)`, [ids[18], ids[17]]);
    expect((await api.setLinks({ kind: "image", ids: [r], communityIds: [ids[18]] }))[1].items[0].communities).toEqual([]);
    expect(await sql(`select community_id, state from public.community_links where image_id = $1 and state <> 'opted_out'`, [r])).toEqual([{ community_id: ids[16], state: "hidden" }]);
  });

  it(`keeps a render in ${T.MAX_COMMUNITIES_PER_WORK} however it came: its prompt linked to more later adds none, and its list saved as shown changes nothing`, async () => {
    const cs = await manyCommunities(T.MAX_COMMUNITIES_PER_WORK + 3, "late_");
    const P = await prompt(ME);
    const r = await render(HER, P);
    expect((await api.setLinks({ kind: "image", ids: [r], communityIds: cs.slice(0, T.MAX_COMMUNITIES_PER_WORK) }, "her"))[0]).toBe(200);
    expect((await api.setLinks({ kind: "prompt", ids: [P], communityIds: cs.slice(T.MAX_COMMUNITIES_PER_WORK) }))[0]).toBe(200);
    const inWorks = async () => (await sql<{ n: number }>(`select count(*)::int as n from public.community_works where image_id = $1`, [r]))[0].n;
    const [, seen] = await api.links("image", r, null);
    expect([seen.communities.length, seen.inherited, await inWorks()]).toEqual([T.MAX_COMMUNITIES_PER_WORK, [], T.MAX_COMMUNITIES_PER_WORK]);
    const rows = () => sql(`select community_id, state from public.community_links where image_id = $1 order by community_id`, [r]);
    const was = await rows();
    const [again, saved] = await api.setLinks({ kind: "image", ids: [r], communityIds: seen.communities.map((c: Row) => c.id) }, "her");
    expect([again, saved.items[0].communities.length]).toEqual([200, T.MAX_COMMUNITIES_PER_WORK]);
    expect(await rows()).toEqual(was);
    // One of hers dropped: the prompt's first in line comes in, as its prompt's.
    const [, less] = await api.setLinks({ kind: "image", ids: [r], communityIds: seen.communities.slice(1).map((c: Row) => c.id) }, "her");
    expect([less.items[0].communities.length, less.items[0].inherited.length, await inWorks()]).toEqual([T.MAX_COMMUNITIES_PER_WORK, 1, T.MAX_COMMUNITIES_PER_WORK]);
    expect(cs.slice(T.MAX_COMMUNITIES_PER_WORK)).toContain(less.items[0].inherited[0]);
  });

  it("brings nothing from a prompt whose creator is hidden, as its works show; picked by the render's owner, it is her own link", async () => {
    const c = await community("gundam");
    const P = await prompt(BANNED);
    await link(c, "prompt_id", P, BANNED);
    const r = await render(HER, P);
    await sql(`insert into public.bans (user_id) values ($1)`, [BANNED]);
    expect((await api.links("image", r, "her"))[1]).toMatchObject({ communities: [], inherited: [], optedOut: [] });
    expect(await sql(`select count(*)::int as n from public.community_works where image_id = $1`, [r])).toEqual([{ n: 0 }]);
    const [, set] = await api.setLinks({ kind: "image", ids: [r], communityIds: [c] }, "her");
    expect(set.items[0]).toMatchObject({ communities: [{ id: c, handle: "gundam", name: "gundam" }], inherited: [] });
    expect(await sql(`select state from public.community_links where image_id = $1`, [r])).toEqual([{ state: "shown" }]);
  });

  it("keeps an answer in the communities of the post it answers: its own list is refused (409)", async () => {
    const [a, b] = await Promise.all([community("alpha"), community("bravo")]);
    const root = (await api.post({ imageId: await render(ME), title: "Root", communityIds: [a] }))[1].post;
    const answer = (await api.post({ imageId: await render(HER), title: "Mine", parentId: root.id }, "her"))[1].post;
    // A post's places are the post's: its render's own list does not show them (they still count to its 18).
    expect((await api.links("image", root.work.imageId))[1].communities).toEqual([]);
    expect(await api.setLinks({ kind: "post", ids: [answer.id], communityIds: [b] }, "her")).toEqual([409, err(T.ANSWER_FOLLOWS_ITS_POST)]);
    expect(await sql(`select community_id from public.community_links where post_id = $1`, [answer.id])).toEqual([{ community_id: a }]);
    expect((await api.setLinks({ kind: "post", ids: [root.id], communityIds: [a, b] }))[0]).toBe(200);
  });

  it("refuses someone else's item (404), more than 8 at once and a body not of its shape (400)", async () => {
    const c = await community("gundam");
    const hers = await render(HER);
    const mine = await render(ME);
    expect(await api.setLinks({ kind: "image", ids: [mine, hers], communityIds: [c] })).toEqual([404, NOT_FOUND]);
    expect(await sql(`select count(*)::int as n from public.community_links`)).toEqual([{ n: 0 }]);
    expect(await api.setLinks({ kind: "image", ids: Array.from({ length: T.MAX_LINK_AT_ONCE + 1 }, () => mine), communityIds: [c] })).toEqual([400, err("Bad request")]);
    for (const body of [{ kind: "image", ids: [], communityIds: [c] }, { kind: "x", ids: [mine], communityIds: [c] }, { kind: "image", ids: [mine], communityIds: ["c"] }, { kind: "image", ids: [mine] }]) {
      expect(await api.setLinks(body), JSON.stringify(body)).toEqual([400, err("Bad request")]);
    }
    // The same render twice is one item, answered twice in the order sent.
    const [, two] = await api.setLinks({ kind: "image", ids: [mine, mine], communityIds: [c] });
    expect(two.items.map((i: Row) => i.id)).toEqual([mine, mine]);
  });
});

describe("the soft suggestion", () => {
  it("names communities a text names, by handle, search word or a merged handle, the biggest first, none picked, never echoing the text", async () => {
    const apu = await community("apu", ME, "Apu");
    const pepe = await community("pepe", ME, "Pepe");
    const brett = await community("brett", ME, "Brett");
    await community("doge", ME, "Doge");
    await sql(`insert into public.community_aliases (community_id, alias) values ($1, 'apustaja')`, [apu]);
    await members(pepe, HER);
    await members(brett, HER, ME);
    const text = "Apustaja and Pepe and Brett and doge animated, secret words";
    const logs = vi.spyOn(console, "log");
    const errors = vi.spyOn(console, "error");
    const [status, body] = await api.suggest({ text });
    expect([status, body]).toEqual([200, { suggestions: [{ id: brett, handle: "brett", name: "Brett" }, { id: pepe, handle: "pepe", name: "Pepe" }, { id: apu, handle: "apu", name: "Apu" }] }]);
    expect(JSON.stringify(body)).not.toMatch(/secret|animated/i);
    expect([...logs.mock.calls, ...errors.mock.calls].flat().join(" ")).not.toMatch(/secret/);
    // Doge, the fourth, comes up once Brett is picked.
    expect((await api.suggest({ text, exclude: [brett] }))[1].suggestions.map((c: Row) => c.handle)).toEqual(["pepe", "apu", "doge"]);
    expect((await api.suggest({ text: "nothing here at all" }))[1]).toEqual({ suggestions: [] });
    expect((await api.suggest({ text: "!!" }))[1]).toEqual({ suggestions: [] });
    expect(await api.suggest({ text: 5 })).toEqual([400, err("Bad request")]);
    expect(await api.suggest({ text: "x", exclude: ["a"] })).toEqual([400, err("Bad request")]);
    logs.mockRestore();
    errors.mockRestore();
  });

  it(`reads at most ${T.COMMUNITY_TEXT.suggestText} characters of the text`, async () => {
    await community("pepe", ME, "Pepe");
    const pad = "x ".repeat(T.COMMUNITY_TEXT.suggestText / 2);
    expect((await api.suggest({ text: `pepe ${pad}` }))[1].suggestions).toHaveLength(1);
    expect((await api.suggest({ text: `${pad}pepe` }))[1].suggestions).toHaveLength(0);
  });
});

describe("the Showroom", () => {
  it("posts one of the poster's own public renders, once, to 1-18 live communities; answers it with an own version", async () => {
    const [a, b] = await Promise.all([community("alpha"), community("bravo")]);
    const r = await render(ME);
    const [status, body] = await api.post({ imageId: r, title: "  First ", caption: " Hi ", communityIds: [a, b, a] });
    expect(status).toBe(201);
    expect(body.post).toEqual({
      id: expect.any(String), title: "First", caption: "Hi", author: { handle: "me" },
      work: { imageId: r, kind: "image", url: `https://cdn.test/${r}.webp`, thumb: `https://cdn.test/${r}.t.webp`, width: null, height: null, owner: { handle: "me" }, promptId: null, likes: 0, addedAt: expect.any(String) },
      communities: [{ id: a, handle: "alpha", name: "alpha" }, { id: b, handle: "bravo", name: "bravo" }], parentId: null, answers: 0, latestAnswers: [], mine: true, createdAt: expect.any(String),
    });
    expect(screens.at(-1)).toEqual({ title: "First", caption: "Hi" });
    expect(await api.post({ imageId: r, title: "Again", communityIds: [a] })).toEqual([409, err(T.ALREADY_POSTED, { postId: body.post.id })]);
    // An answer is in its post's communities, whatever it names; an answer to an answer answers the root.
    const hers = await render(HER);
    const [, answer] = await api.post({ imageId: hers, title: "Mine", parentId: body.post.id, communityIds: [] }, "her");
    expect(answer.post).toMatchObject({ parentId: body.post.id, communities: [{ id: a }, { id: b }].map((x) => expect.objectContaining(x)), mine: true });
    const third = await render(HER);
    expect((await api.post({ imageId: third, title: "Deeper", parentId: answer.post.id }, "her"))[1].post.parentId).toBe(body.post.id);
    expect(await api.post({ imageId: await render(HER), title: "x", parentId: id(77) }, "her")).toEqual([404, NOT_FOUND]);
  });

  it("refuses a render not its poster's or an upload (403), a private one (409), no community or too many, and its field rules", async () => {
    const c = await community("alpha");
    const ids = await manyCommunities(T.MAX_COMMUNITIES_PER_WORK + 1, "room_");
    const mine = await render(ME);
    expect(await api.post({ imageId: await render(HER), title: "t", communityIds: [c] })).toEqual([403, err(T.NOT_YOUR_RENDER)]);
    expect(await api.post({ imageId: await render(ME, null, { is_uploaded: true }), title: "t", communityIds: [c] })).toEqual([403, err(T.NOT_YOUR_RENDER)]);
    expect(await api.post({ imageId: id(55), title: "t", communityIds: [c] })).toEqual([403, err(T.NOT_YOUR_RENDER)]);
    expect(await api.post({ imageId: await render(ME, null, { visibility: "private" }), title: "t", communityIds: [c] })).toEqual([409, err(T.MAKE_PUBLIC_FIRST)]);
    expect(await api.post({ imageId: mine, title: "t", communityIds: [] })).toEqual([400, err(T.PICK_A_COMMUNITY)]);
    expect(await api.post({ imageId: mine, title: "t" })).toEqual([400, err(T.PICK_A_COMMUNITY)]);
    live.state.statements.length = 0;
    expect(await api.post({ imageId: mine, title: "t", communityIds: ids })).toEqual([409, err(T.TOO_MANY_COMMUNITIES)]);
    // Refused before anything is read or written.
    expect(live.state.statements.filter((s) => /^INSERT|"communities"/.test(s))).toEqual([]);
    expect(await api.post({ imageId: mine, title: " ", communityIds: [c] })).toEqual([400, err(T.TITLE_NEEDED)]);
    expect(await api.post({ imageId: mine, title: "t".repeat(T.COMMUNITY_TEXT.title + 1), communityIds: [c] })).toEqual([400, err(T.TOO_LONG.title)]);
    expect(await api.post({ imageId: mine, title: "t", caption: "c".repeat(T.COMMUNITY_TEXT.caption + 1), communityIds: [c] })).toEqual([400, err(T.TOO_LONG.caption)]);
    expect(await api.post({ imageId: mine, title: "BLOCKME", communityIds: [c] })).toEqual([422, err(expect.any(String))]);
    expect(await api.post({ imageId: "x", title: "t", communityIds: [c] })).toEqual([400, err("Bad request")]);
    expect(await sql(`select count(*)::int as n from public.showroom_posts`)).toEqual([{ n: 0 }]);
  });

  it(`holds ${T.MAX_POSTS_PER_DAY} posts a day, and takes a post back when its communities could not be written`, async () => {
    const c = await community("alpha");
    const renders = await Promise.all(Array.from({ length: T.MAX_POSTS_PER_DAY + 2 }, () => render(ME)));
    await sql(`insert into public.showroom_posts (user_id, image_id, title) select $1, unnest($2::uuid[]), 't'`, [ME, renders.slice(0, T.MAX_POSTS_PER_DAY)]);
    expect(await api.post({ imageId: renders[T.MAX_POSTS_PER_DAY], title: "t", communityIds: [c] })).toEqual([409, err(T.POSTS_TODAY)]);
    await sql(`update public.showroom_posts set created_at = now() - interval '2 days'`);
    // The links refused (here: the community deleted between the check and the write) take the post back.
    await pg.exec(`create function public.__drop_alpha() returns trigger language plpgsql as $$ begin delete from public.communities where handle = 'alpha'; return new; end $$;
      create trigger __drop_alpha after insert on public.showroom_posts for each row execute function public.__drop_alpha();`);
    try {
      expect((await api.post({ imageId: renders[T.MAX_POSTS_PER_DAY], title: "t", communityIds: [c] }))[0]).toBe(500);
    } finally {
      await pg.exec(`drop trigger __drop_alpha on public.showroom_posts; drop function public.__drop_alpha();`);
    }
    expect(await sql(`select count(*)::int as n from public.showroom_posts where image_id = $1`, [renders[T.MAX_POSTS_PER_DAY]])).toEqual([{ n: 0 }]);
  });

  it("lists a community's posts newest first with their newest answers and counts; reads one with its answers; 18+ only to whom may see it", async () => {
    const c = await community("alpha");
    const d = await community("bravo");
    const first = (await api.post({ imageId: await render(ME), title: "First", communityIds: [c] }))[1].post;
    const second = (await api.post({ imageId: await render(HER), title: "Second", communityIds: [c, d] }, "her"))[1].post;
    for (let i = 0; i < T.INLINE_ANSWERS + 1; i++) await api.post({ imageId: await render(HER), title: `A${i}`, parentId: first.id }, "her");
    await sql(`update public.showroom_posts set created_at = now() - interval '3 hours' + (substr(title, 2)::int * interval '1 minute') where title like 'A%'`);
    await sql(`update public.showroom_posts set created_at = now() - interval '2 hours' where id = $1`, [first.id]);
    await sql(`update public.showroom_posts set created_at = now() - interval '1 hour' where id = $1`, [second.id]);
    const [status, body] = await api.list("alpha", "showroom");
    expect(status).toBe(200);
    expect(body.posts.map((p: Row) => [p.title, p.answers, (p.latestAnswers as Row[]).length, p.mine])).toEqual([["Second", 0, 0, false], ["First", T.INLINE_ANSWERS + 1, T.INLINE_ANSWERS, true]]);
    expect(body.posts[1].latestAnswers[0]).toMatchObject({ title: `A${T.INLINE_ANSWERS}`, parentId: first.id, author: { handle: "her" }, answers: 0, latestAnswers: [], mine: false });
    expect(body.next).toBeNull();
    expect((await api.list("bravo", "showroom"))[1].posts.map((p: Row) => p.title)).toEqual(["Second"]);
    const [, one] = await api.readPost(first.id, null);
    expect([one.post.answers, one.post.latestAnswers.length, one.post.mine]).toEqual([T.INLINE_ANSWERS + 1, T.INLINE_ANSWERS + 1, false]);
    // A hidden one and an 18+ one.
    await sql(`update public.community_links set state = 'hidden' where post_id = $1 and community_id = $2`, [second.id, c]);
    expect((await api.list("alpha", "showroom"))[1].posts.map((p: Row) => p.title)).toEqual(["First"]);
    await sql(`update public.generated_images set is_adult = true where id = $1`, [first.work.imageId]);
    expect(await api.readPost(first.id, "her")).toEqual([404, NOT_FOUND]);
    expect((await api.readPost(first.id, "me"))[0]).toBe(200);
    expect((await api.list("alpha", "showroom", "", "her"))[1].posts).toEqual([]);
    await sql(`update public.generated_images set visibility = 'private' where id = $1`, [first.work.imageId]);
    expect(await api.readPost(first.id, "me")).toEqual([404, NOT_FOUND]);
    expect(await api.readPost("nope")).toEqual([404, NOT_FOUND]);
  });

  it("reads a post's answers as its viewer may: 18+ only to a confirmed adult who asks, none of whom they ignore", async () => {
    const c = await community("alpha");
    const root = (await api.post({ imageId: await render(ME), title: "Root", communityIds: [c] }))[1].post;
    const adult = (await api.post({ imageId: await render(HER), title: "Adult", parentId: root.id }, "her"))[1].post;
    await sql(`update public.generated_images set is_adult = true where id = $1`, [adult.work.imageId]);
    await api.post({ imageId: await render(BUSY), title: "Plain", parentId: root.id }, "busy");
    const seen = async (t: string | null, extra: Record<string, string> = {}) => {
      const res = await (readPost as Handler)(new NextRequest(`http://enki.test/api/communities/posts/${root.id}`, { headers: { "x-real-ip": "10.7.0.1", ...(t ? { "X-Session-Token": t } : {}), ...extra } }), { params: Promise.resolve({ id: root.id } as never) });
      const { post } = await res.json();
      return [post.answers, (post.latestAnswers as Row[]).map((a) => a.title)];
    };
    expect(await seen(null)).toEqual([1, ["Plain"]]);
    await sql(`insert into public.user_ignores (user_id, ignored_id) values ($1, $2)`, [ME, BUSY]);
    expect(await seen("me")).toEqual([0, []]);
    await sql(`delete from public.user_ignores`);
    await sql(`update public.users set adult_confirmed_at = now() where id = $1`, [ME]);
    expect(await seen("me", { "X-Show-Adult": "1" })).toEqual([2, ["Plain", "Adult"]]);
  });

  it("gives an answer only the communities its post is shown in, never one a moderator hid the post from", async () => {
    const [a, b] = await Promise.all([community("alpha"), community("bravo")]);
    const root = (await api.post({ imageId: await render(ME), title: "Root", communityIds: [a, b] }))[1].post;
    expect((await api.hide("bravo", { kind: "post", id: root.id, hidden: true }))[0]).toBe(200);
    const [status, answer] = await api.post({ imageId: await render(HER), title: "Mine", parentId: root.id }, "her");
    expect([status, answer.post.communities.map((c: Row) => c.handle)]).toEqual([201, ["alpha"]]);
    expect(await sql(`select community_id, state from public.community_links where post_id = $1`, [answer.post.id])).toEqual([{ community_id: a, state: "shown" }]);
    expect((await api.list("bravo", "showroom"))[1].posts).toEqual([]);
  });

  it("deletes a post for its poster or Enki staff (logged); its answers stand alone; anyone else 403", async () => {
    const c = await community("alpha");
    const first = (await api.post({ imageId: await render(ME), title: "First", communityIds: [c] }))[1].post;
    const answer = (await api.post({ imageId: await render(HER), title: "Answer", parentId: first.id }, "her"))[1].post;
    expect(await api.deletePost(first.id, "her")).toEqual([403, err(T.NOT_YOURS)]);
    expect(await api.deletePost(first.id)).toEqual([200, { deleted: true }]);
    expect((await api.readPost(answer.id))[1].post.parentId).toBeNull();
    expect(await logged()).toEqual([]);
    expect(await api.deletePost(answer.id, "mod")).toEqual([200, { deleted: true }]);
    expect(await logged()).toEqual([{ actor_id: MOD, actor_role: "mod", action: "community.delete-post", target: answer.id }]);
    expect(await api.deletePost(answer.id)).toEqual([404, NOT_FOUND]);
  });
});

describe("a moderator's hide", () => {
  it("takes a prompt (with every render it brought in) or a render out of one community and puts it back; logged", async () => {
    const c = await community("alpha");
    const P = await prompt(HER);
    await link(c, "prompt_id", P, HER);
    const [r1, r2] = [await render(ME, P), await render(HER, P)];
    const works = async () => (await api.list("alpha", "works"))[1].works.map((w: Row) => w.imageId).sort();
    expect(await works()).toEqual([r1, r2].sort());
    expect(await api.hide("alpha", { kind: "image", id: r1, hidden: true })).toEqual([200, { hidden: true }]);
    expect(await works()).toEqual([r2]);
    expect(await sql(`select user_id, state from public.community_links where image_id = $1`, [r1])).toEqual([{ user_id: MOD, state: "hidden" }]);
    // Its owner cannot put it back.
    expect((await api.setLinks({ kind: "image", ids: [r1], communityIds: [c] }))[1].items[0]).toMatchObject({ communities: [], hidden: [{ id: c, handle: "alpha", name: "alpha" }] });
    expect(await api.hide("alpha", { kind: "image", id: r1, hidden: false }, "admin")).toEqual([200, { hidden: false }]);
    expect(await sql(`select count(*)::int as n from public.community_links where image_id = $1`, [r1])).toEqual([{ n: 0 }]);
    expect(await works()).toEqual([r1, r2].sort());
    expect(await api.hide("alpha", { kind: "prompt", id: P, hidden: true })).toEqual([200, { hidden: true }]);
    expect(await works()).toEqual([]);
    await api.hide("alpha", { kind: "prompt", id: P, hidden: false });
    expect(await works()).toEqual([r1, r2].sort());
    // A render linked by its owner turns shown again.
    const own = await render(ME);
    await link(c, "image_id", own);
    await api.hide("alpha", { kind: "image", id: own, hidden: true });
    await api.hide("alpha", { kind: "image", id: own, hidden: false });
    expect(await sql(`select user_id, state from public.community_links where image_id = $1`, [own])).toEqual([{ user_id: ME, state: "shown" }]);
    expect((await logged()).map((l) => [l.actor_role, l.action, l.target])).toEqual([
      ["mod", "community.hide", r1], ["admin", "community.unhide", r1], ["mod", "community.hide", P], ["mod", "community.unhide", P],
      ["mod", "community.hide", own], ["mod", "community.unhide", own],
    ]);
  });

  it("leaves a render its owner opted out of out: a hide changes nothing, and putting it back never makes her opt-out a link", async () => {
    const c = await community("gundam");
    const P = await prompt(ME);
    await link(c, "prompt_id", P, ME);
    const r = await render(HER, P);
    await api.setLinks({ kind: "image", ids: [r], communityIds: [] }, "her");
    const state = () => sql(`select state from public.community_links where image_id = $1`, [r]);
    expect(await state()).toEqual([{ state: "opted_out" }]);
    expect(await api.hide("gundam", { kind: "image", id: r, hidden: true })).toEqual([200, { hidden: true }]);
    expect(await state()).toEqual([{ state: "opted_out" }]);
    expect(await api.hide("gundam", { kind: "image", id: r, hidden: false })).toEqual([200, { hidden: false }]);
    expect(await state()).toEqual([{ state: "opted_out" }]);
    expect((await api.list("gundam", "works"))[1].works).toEqual([]);
    expect((await api.links("image", r, "her"))[1]).toMatchObject({ communities: [], optedOut: [{ id: c, handle: "gundam", name: "gundam" }] });
  });

  it("is Enki staff's only (403), for a render in its works or an item linked there (404 else)", async () => {
    const c = await community("alpha");
    const r = await render(ME);
    expect(await api.hide("alpha", { kind: "image", id: r, hidden: true }, "me")).toEqual([403, err(T.STAFF_ONLY)]);
    expect(await api.hide("alpha", { kind: "image", id: r, hidden: true })).toEqual([404, NOT_FOUND]);
    expect(await api.hide("alpha", { kind: "post", id: r, hidden: true })).toEqual([404, NOT_FOUND]);
    expect(await api.hide("alpha", { kind: "image", id: r })).toEqual([400, err("Bad request")]);
    expect(await api.hide("nothing", { kind: "image", id: r, hidden: true })).toEqual([404, NOT_FOUND]);
    expect(c).toBeTruthy();
  });
});

describe("the merge queue", () => {
  it("groups live communities by core word while one is not kept apart, the biggest first; admins only", async () => {
    const g = await community("gundam", ME, "Gundam");
    await community("gundam_2", HER, "Gundam 2");
    await community("the_gundam_club", HER, "Club");
    const p1 = await community("pepe");
    await community("pepe_coin");
    await community("lonely");
    await members(g, HER);
    const [status, body] = await api.merges();
    expect(status).toBe(200);
    expect(body.groups.map((x: Row) => [x.core, (x.communities as Row[]).map((c) => c.handle)])).toEqual([
      ["gundam", ["gundam", "gundam_2", "the_gundam_club"]], ["pepe", ["pepe", "pepe_coin"]],
    ]);
    expect(body.groups[0].communities[0]).toEqual({ ...card({ handle: "gundam", name: "Gundam", members: 1 }), createdAt: expect.any(String), createdBy: "me", reviewed: false });
    expect(await api.merges("mod")).toEqual([403, err(T.ADMIN_ONLY)]);
    expect(await api.merges("me")).toEqual([403, err(T.ADMIN_ONLY)]);
    // Kept apart: the group goes, until a new one of its core comes.
    const pepes = body.groups[1].communities.map((c: Row) => c.id);
    expect(await api.merge({ keep: pepes })).toEqual([200, { kept: 2 }]);
    expect((await api.merges())[1].groups.map((x: Row) => x.core)).toEqual(["gundam"]);
    await community("pepe_official");
    const [, back] = await api.merges();
    expect(back.groups[1].communities.map((c: Row) => [c.handle, c.reviewed])).toEqual([["pepe", true], ["pepe_coin", true], ["pepe_official", false]]);
    expect(p1).toBeTruthy();
  });

  it("groups communities made through the API by the core stored then (numbers, glued filler); keeps only live ones apart", async () => {
    for (const name of ["Pepe", "Gundam"]) expect((await api.create({ name }))[0]).toBe(201);
    for (const name of ["Pepecoin", "Gundam 2"]) expect((await api.create({ name, confirmed: true }, "her"))[0]).toBe(201);
    const [, body] = await api.merges();
    expect(body.groups.map((g: Row) => [g.core, (g.communities as Row[]).map((c) => c.handle).sort()])).toEqual([["gundam", ["gundam", "gundam_2"]], ["pepe", ["pepe", "pepecoin"]]]);
    const [pepe, pepecoin] = ["pepe", "pepecoin"].map((h) => (body.groups[1].communities as Row[]).find((c) => c.handle === h)!.id);
    expect((await api.merge({ from: pepecoin, into: pepe }))[0]).toBe(200);
    expect(await api.merge({ keep: [pepe, pepecoin] })).toEqual([200, { kept: 1 }]);
    expect(await sql(`select handle, core_reviewed_at is not null as kept from public.communities where handle in ('pepe', 'pepecoin') order by handle`))
      .toEqual([{ handle: "pepe", kept: true }, { handle: "pepecoin", kept: false }]);
  });

  it("merges one into another (logged): its links and members move and its handle redirects; the same one or a merged one refused", async () => {
    const into = await community("gundam", ME, "Gundam");
    const from = await community("gundam_fans", HER, "Fans");
    const r = await render(HER);
    await link(from, "image_id", r, HER);
    await members(from, HER, ME);
    await members(into, ME);
    expect(await api.merge({ from, into })).toEqual([200, { merged: { from: "gundam_fans", into: "gundam", links: 1, members: 1 } }]);
    expect(await api.read("gundam_fans")).toEqual([200, { redirect: "gundam" }]);
    expect((await api.read("gundam"))[1].community).toMatchObject({ members: 2, works: 1 });
    expect(await api.merge({ from, into })).toEqual([409, err(T.MERGED_ALREADY)]);
    expect(await api.merge({ from: into, into })).toEqual([400, err(T.MERGE_SAME)]);
    expect(await api.merge({ from: id(91), into })).toEqual([404, NOT_FOUND]);
    expect(await api.merge({ from, into }, "mod")).toEqual([403, err(T.ADMIN_ONLY)]);
    expect(await api.merge({ from: "x", into })).toEqual([400, err("Bad request")]);
    expect(await logged()).toEqual([{ actor_id: ADMIN, actor_role: "admin", action: "community.merge", target: from }]);
  });
});
