import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";
import type { SupabaseClient } from "@supabase/supabase-js";
import { pglitePostgrest } from "@/lib/__tests__/_pglite-postgrest";
import type { XUser } from "../x-api";
import { ensureCreatorProfile, importedBio, onEnki, xAvatar } from "../creator-profile";

/**
 * An X author's Enki account (Kev, 2026-10-30: "account fürn creator angelegt werden"), on a real Postgres with SQL
 * 46's naming trigger and SQL 56: found and made by X id alone, named as on X when the name is free, and X's picture
 * taken once as it is made (Kev, 2026-10-31: "profilbilder ziehen ... nur 1x beim ersten import").
 */
const ROOT = join(__dirname, "..", "..", "..");
const migration = (f: string) => readFileSync(join(ROOT, "migrations", f), "utf8").split("\r\n").join("\n");
const HEX: XUser = { id: "1500000000000000001", handle: "HexMethod", name: "Hex Method" };
const AUTO = /^[a-z]+_[a-z]+_[0-9]{4}$/;

describe("the creator's account", () => {
  let db: PGlite;
  let supabase: SupabaseClient;
  const users = async () => (await db.query<Record<string, unknown>>(`select id, handle::text as handle, handle_auto, imported_x_id, avatar_url from public.users order by handle`)).rows;

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
      create table public.auth_identities (provider text not null, subject text not null, user_id uuid not null, primary key (provider, subject));
      create table public.hunt_submissions (id uuid primary key default gen_random_uuid());
      create table public.hunter_config (id smallint primary key default 1);
    `);
    for (const f of ["2026-10-29-auto-handles.sql", "2026-10-14-prompt-hunter.sql", "2026-10-30-creator-hunter.sql"]) await db.exec(migration(f));
    supabase = pglitePostgrest(db).client as unknown as SupabaseClient;
  }, 60_000);
  afterAll(async () => { await db.close(); });
  beforeEach(async () => { await db.exec(`truncate public.users, public.auth_identities cascade`); });

  it("is made once per X id, with X's handle when it is free and no picture, and found again by the id, not the handle", async () => {
    const made = await ensureCreatorProfile(supabase, HEX);
    expect(made).toEqual({ userId: expect.any(String), handle: "hexmethod" });
    expect(await users()).toEqual([{ id: made.userId, handle: "hexmethod", handle_auto: true, imported_x_id: HEX.id, avatar_url: null }]);
    // Renamed on X: the same account.
    expect(await ensureCreatorProfile(supabase, { ...HEX, handle: "NewName" })).toEqual(made);
    expect(await users()).toHaveLength(1);
  });

  it("takes X's picture once, as the account is made, and never asks again for an account made before (Kev, 2026-10-31)", async () => {
    const asked: string[] = [];
    const avatar = async (x: XUser) => { asked.push(x.id); return "https://pbs.twimg.com/profile_images/1/hex_400x400.jpg"; };
    const made = await ensureCreatorProfile(supabase, HEX, avatar);
    expect((await users())[0]).toMatchObject({ id: made.userId, avatar_url: "https://pbs.twimg.com/profile_images/1/hex_400x400.jpg" });
    await db.exec(`update public.users set avatar_url = 'https://enki.test/own.webp'`);
    expect(await ensureCreatorProfile(supabase, { ...HEX, handle: "NewName" }, avatar)).toEqual(made);
    expect(asked).toEqual([HEX.id]);
    expect((await users())[0].avatar_url).toBe("https://enki.test/own.webp");
    // None found: the seal, as for everyone without a picture.
    const other = await ensureCreatorProfile(supabase, { id: "1500000000000000009", handle: "Other", name: "" }, async () => null);
    expect((await users()).find((u) => u.id === other.userId)?.avatar_url).toBeNull();
  });

  it("finds X's picture for free, still this X id, never the default, at 400 px, one that loads, and bills nothing (Kev, 2026-10-31)", async () => {
    const PIC = "https://pbs.twimg.com/profile_images/17/hex_normal.jpg";
    const fetchOf = (user: unknown, image = true) => {
      const urls: string[] = [];
      const f = (async (u: string | URL | Request) => {
        urls.push(String(u));
        if (String(u).startsWith("https://api.fxtwitter.com/2/profile/")) return { ok: true, json: async () => ({ user }) };
        return { ok: image };
      }) as unknown as typeof fetch;
      return { f, urls };
    };
    const got = fetchOf({ id: HEX.id, avatar_url: PIC });
    expect(await xAvatar(HEX, got.f)).toBe("https://pbs.twimg.com/profile_images/17/hex_400x400.jpg");
    expect(got.urls).toEqual(["https://api.fxtwitter.com/2/profile/HexMethod", "https://pbs.twimg.com/profile_images/17/hex_400x400.jpg"]);
    // FxTwitter's passing 404 is asked again, as a timeline page is (live 2026-10-31: 2 in 5).
    let calls = 0;
    const flaky = (async (u: string | URL | Request) => {
      if (String(u).startsWith("https://api.fxtwitter.com/")) return ++calls < 3 ? { ok: false, status: 404 } : { ok: true, status: 200, json: async () => ({ user: { id: HEX.id, avatar_url: PIC } }) };
      return { ok: true };
    }) as unknown as typeof fetch;
    expect(await xAvatar(HEX, flaky, 0)).toBe("https://pbs.twimg.com/profile_images/17/hex_400x400.jpg");
    // The handle holds another account now; X's default picture; no image; no answer.
    expect(await xAvatar(HEX, fetchOf({ id: "999", avatar_url: PIC }).f)).toBeNull();
    expect(await xAvatar(HEX, fetchOf({ id: HEX.id, avatar_url: "https://abs.twimg.com/sticky/default_profile_images/default_profile_normal.png" }).f)).toBeNull();
    expect(await xAvatar(HEX, fetchOf({ id: HEX.id, avatar_url: PIC }, false).f)).toBeNull();
    expect(await xAvatar(HEX, (async () => { throw new Error("down"); }) as unknown as typeof fetch)).toBeNull();
  });

  it("links the author on X by their id, which follows a rename, and names the handle as it was then (review 2026-10-30, F19)", async () => {
    const made = await ensureCreatorProfile(supabase, HEX);
    const [{ bio }] = (await db.query<{ bio: string }>(`select bio from public.users where id = $1`, [made.userId])).rows;
    expect(bio).toBe(importedBio("HexMethod", HEX.id));
    expect(bio).toContain(`https://x.com/i/user/${HEX.id}`);
    expect(bio).not.toContain("https://x.com/HexMethod");
    expect(bio).toContain("@HexMethod when Enki imported them");
  });

  it("takes a name of SQL 46's when the X handle is taken on Enki or is no Enki name", async () => {
    // Whether users.handle is unique live was not determined: the check before the insert holds without the index.
    await db.exec(`drop index public.users_handle_key; insert into public.users (handle, origin) values ('hexmethod', 'wallet')`);
    const taken = await ensureCreatorProfile(supabase, HEX);
    await db.exec(`create unique index users_handle_key on public.users (handle)`);
    expect(taken.handle).toMatch(AUTO);
    const short = await ensureCreatorProfile(supabase, { ...HEX, id: "7", handle: "ab" });
    expect(short.handle).toMatch(AUTO);
    expect((await users()).filter((u) => u.imported_x_id).every((u) => u.handle_auto === true)).toBe(true);
  });

  it("meets a second Play making the same account at once on the X id: one account, both get it", async () => {
    const [a, b] = await Promise.all([ensureCreatorProfile(supabase, HEX), ensureCreatorProfile(supabase, HEX)]);
    expect(a).toEqual(b);
    expect(await users()).toHaveLength(1);
  });

  it("gives the second of two authors racing for one free handle a name of SQL 46's", async () => {
    const [a, b] = await Promise.all([ensureCreatorProfile(supabase, HEX), ensureCreatorProfile(supabase, { ...HEX, id: "8" })]);
    expect(a.userId).not.toBe(b.userId);
    expect(await users()).toHaveLength(2);
    expect([a.handle, b.handle].filter((h) => h === "hexmethod")).toHaveLength(1);
    expect([a.handle, b.handle].find((h) => h !== "hexmethod")).toMatch(AUTO);
  });

  it("knows an X account that logs in to Enki by its X id, with that account's handle", async () => {
    expect(await onEnki(supabase, HEX.id)).toBeNull();
    // Another provider's subject that happens to be the same digits is not this X account.
    await db.exec(`insert into public.users (id, handle, origin) values ('00000000-0000-4000-8000-000000000008', 'googler', 'google');
      insert into public.auth_identities values ('google', '${HEX.id}', '00000000-0000-4000-8000-000000000008');`);
    expect(await onEnki(supabase, HEX.id)).toBeNull();
    await db.exec(`insert into public.users (id, handle, origin) values ('00000000-0000-4000-8000-000000000009', 'thereal', 'x');
      insert into public.auth_identities values ('x', '${HEX.id}', '00000000-0000-4000-8000-000000000009');`);
    expect(await onEnki(supabase, HEX.id)).toBe("thereal");
    expect(await onEnki(supabase, "8")).toBeNull();
  });
});
