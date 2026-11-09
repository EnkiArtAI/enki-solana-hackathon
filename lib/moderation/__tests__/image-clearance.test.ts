import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";
import { join } from "node:path";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import sharp from "sharp";
import type { SupabaseClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { pglitePostgrest } from "@/lib/__tests__/_pglite-postgrest";
import type { ImportPlan } from "@/lib/editor/post-import";
import { resetKeyringCache } from "@/lib/crypto";

/**
 * A human's false alarm on a child-safety image case (Kev, 2026-11-02). The real route, judgeImport, checkImageBytes,
 * checkImage, recordImageCase and the audit run on a real Postgres with the real migrations. What the two judges answer is
 * a stubbed fetch, the pictures are generated solid colours, the kept copy's read is a stub answering a made-up string
 * (no evidence is sealed, read or opened here), mail and next/server's after() are stubbed. No paid call.
 */
const holder = vi.hoisted(() => ({ client: null as unknown, reads: [] as string[] }));
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => holder.client }));
vi.mock("@/lib/session-user", async (orig) => ({
  ...(await orig<object>()),
  resolveSessionUserId: async (_s: unknown, t: string | null) => t,
}));
vi.mock("@/lib/admin-notify", async (orig) => ({ ...(await orig<object>()), notifyAdmins: vi.fn(async () => {}) }));
vi.mock("@/lib/moderation/image-case", async (orig) => ({
  ...(await orig<object>()),
  readImageEvidence: vi.fn(async (_s: unknown, id: string) => { holder.reads.push(id); return "data:image/jpeg;base64,c3ludGhldGlj"; }),
}));
vi.mock("@/lib/moderation/prompt-check", async (orig) => ({
  ...(await orig<object>()),
  checkPrompt: vi.fn(async () => ({ verdict: "clear", confidence: 0.1 })),
}));
vi.mock("@/lib/referral/describe-prompt", async (orig) => ({
  ...(await orig<object>()),
  describePrompt: vi.fn(async () => ({ title: "A title", category: "More", tags: [] })),
}));
const later = vi.hoisted(() => [] as Promise<unknown>[]);
vi.mock("next/server", async (orig) => ({
  ...(await orig<object>()),
  after: vi.fn((p: Promise<unknown>) => { later.push(Promise.resolve(p)); }),
}));

import { POST } from "../../../app/api/admin/route";
import { personDetail } from "@/lib/admin/people";
import { defaultCreatorDeps } from "@/lib/hunter/creator-run";
import { judgeImport, PHOTOS_REFUSED, PHOTOS_UNCHECKED } from "@/lib/referral/judge-post";
import { CLEARANCE_NOT_READY, NOT_LOOKED_AT, NOT_THE_OWNER, NO_CHECKSUM } from "@/lib/moderation/image-clearance";

const ROOT = join(__dirname, "..", "..", "..");
const migration = (f: string) => readFileSync(join(ROOT, "migrations", f), "utf8").split("\r\n").join("\n");
const SQL = migration("2026-11-02-image-clearances.sql");

const OWNER = "00000000-0000-4000-8000-0000000000e1";
const ADMIN = "00000000-0000-4000-8000-0000000000e2";
const MOD = "00000000-0000-4000-8000-0000000000e3";
const CREATOR = "00000000-0000-4000-8000-0000000000e4";
const EVENT = "00000000-0000-4000-8000-00000000aaa1";
const TWIN = "00000000-0000-4000-8000-00000000aaa2";
const WHY = "To decide whether this is a false alarm.";

const png = (r: number, g: number, b: number) => sharp({ create: { width: 8, height: 8, channels: 3, background: { r, g, b } } }).png().toBuffer();
const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");

describe("clearing a child-safety image case", () => {
  let db: PGlite;
  let client: SupabaseClient;
  let flagged: Buffer;
  let other: Buffer;
  /** What gpt-6-luna answers, and whether omni answers at all. */
  let luna: Record<string, unknown>;
  let omniDown: boolean;

  const rows = async <T = Record<string, unknown>>(sql: string) => (await db.query<T>(sql)).rows;
  const clearances = () => rows<{ sha256: string; event_id: string; cleared_by: string; cleared_at: string | null; revoked_at: string | null; revoked_by: string | null }>(
    `select sha256, event_id::text, cleared_by::text, cleared_at::text, revoked_at::text, revoked_by::text from public.image_clearances order by cleared_at, id`);
  const standing = async () => (await clearances()).filter((c) => !c.revoked_at);
  const state = async (id = EVENT) => (await rows<{ review_state: string; reviewed_by: string | null }>(
    `select review_state, reviewed_by::text from public.automod_events where id = '${id}'`))[0];
  const actions = () => rows<{ actor_id: string; action: string; target: string; detail: { outcome: Record<string, unknown> } }>(
    `select actor_id::text, action, target, detail from public.admin_actions order by id`);
  const cases = async () => (await rows<{ n: number }>(`select count(*)::int as n from public.automod_events where category = 'csam'`))[0].n;

  const post = async (who: string, body: Record<string, unknown>) => {
    const res = await POST(new NextRequest("http://localhost/api/admin", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Session-Token": who, "x-forwarded-for": "203.0.113.7" }, body: JSON.stringify(body),
    }));
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };
  const overturn = (who: string, id = EVENT) => post(who, { resource: "automod", action: "overturn", id });
  const uphold = (who: string, id = EVENT) => post(who, { resource: "automod", action: "uphold", id });
  const reveal = (who: string, id = EVENT) => post(who, { resource: "automod", action: "reveal", id, reason: WHY, what: "image" });
  const seedCase = (id: string, bytes: Buffer | string) => db.exec(`
    insert into public.automod_events (id, user_id, surface, decision, severity, tier, category, matched_rules, scores, prompt_hash, review_state)
    values ('${id}', '${CREATOR}', 'prompt-hunter', 'block', 'review', 2, 'csam', array['image-check'], '{"minor_sexualised":0.85}',
      '${typeof bytes === "string" ? bytes : hash(bytes)}', 'pending');`);

  const plan = (): ImportPlan => ({
    prompt: "A lighthouse at dawn, soft fog, 35mm film grain", generators: [], photos: [{ url: "https://pbs.twimg.com/media/picture.png", alt: null }],
    source: { url: "https://x.com/a/status/1", handle: "a", authorId: "1" }, said: "",
  } as unknown as ImportPlan);
  const link = { url: "https://x.com/a/status/1", normalized: "x.com/status/1" };
  const nobody = () => new NextRequest("https://enki.invalid/prompt-hunter");
  /** The picture the post serves now. */
  let served: Buffer;
  /** The hunter's import, by the route's own wiring. */
  const hunterImport = async () => {
    const got = await defaultCreatorDeps(client, nobody()).judge(plan(), link, CREATOR, "post");
    await Promise.all(later);
    return got;
  };
  /** "Refer a prompt", as app/api/referrals/preview calls it. */
  const referral = async () => {
    const got = await judgeImport(client, { plan: plan(), link, userId: CREATOR, request: nobody() });
    await Promise.all(later);
    return got;
  };

  beforeAll(async () => {
    db = await PGlite.create();
    await db.exec(`
      create role anon; create role authenticated; create role service_role bypassrls;
      create table public.users (id uuid primary key, handle text, role text);
      create table public.bans (id uuid primary key default gen_random_uuid());
      create table public.strikes (id uuid primary key default gen_random_uuid());
      create table public.moderation_policy (id int primary key, owner_user_id uuid);
      create table public.prompts (id uuid primary key, is_listed boolean default true, delisted_at timestamptz);
    `);
    for (const f of ["2026-08-04-automod-events.sql", "2026-08-05-automod-events-append-only.sql", "2026-10-03-artist-text-reveals.sql", "2026-10-17-admin-actions.sql"]) await db.exec(migration(f));
    await db.exec(`alter table public.automod_events add column if not exists evidence_kid text;`);
    await db.exec(SQL);
    client = pglitePostgrest(db).client as unknown as SupabaseClient;
    holder.client = client;
    flagged = await png(200, 0, 0);
    other = await png(0, 0, 200);
  }, 60_000);
  afterAll(async () => { await db.close(); });

  beforeEach(async () => {
    process.env.FIELD_ENCRYPTION_KEY_B64 = randomBytes(32).toString("base64");
    process.env.AUTH_PEPPER = "test-pepper";
    resetKeyringCache();
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    vi.stubEnv("OPENAI_API_KEYS", "");
    vi.spyOn(console, "error").mockImplementation(() => {});
    holder.reads.length = 0;
    later.length = 0;
    served = flagged;
    omniDown = false;
    luna = { minor: 0.2, minor_sexualised: 0.85, sexual: "none", gore: "none", visible_text: "" };
    // The logs are append-only (their triggers stop TRUNCATE too), so each test's rows go with the triggers off.
    await db.exec(`
      set session_replication_role = replica;
      drop table if exists public.image_clearance_prompts;
      drop table if exists public.image_clearances;
      delete from public.artist_text_reveals; delete from public.admin_actions; delete from public.automod_events;
      delete from public.users; delete from public.moderation_policy; delete from public.prompts;
      set session_replication_role = default;
      insert into public.users (id, handle, role) values ('${OWNER}', 'owner', 'admin'), ('${ADMIN}', 'admin', 'admin'), ('${MOD}', 'mod', 'mod'), ('${CREATOR}', 'creator', null);
      insert into public.moderation_policy (id, owner_user_id) values (1, '${OWNER}');
    `);
    await db.exec(SQL);
    await seedCase(EVENT, flagged);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).endsWith("/moderations")) {
        if (omniDown) throw new Error("moderation down");
        return new Response(JSON.stringify({ results: [{ category_scores: { sexual: 0, "violence/graphic": 0, "self-harm": 0 } }] }), { status: 200 });
      }
      if (String(url).endsWith("/chat/completions")) {
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(luna) } }] }), { status: 200 });
      }
      if (String(url).startsWith("https://pbs.twimg.com/")) {
        return new Response(new Uint8Array(served), { status: 200, headers: { "content-type": "image/png" } });
      }
      throw new Error(`no network in this test: ${url}`);
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  describe("who may clear", () => {
    it("clears for the owner who looked: exactly the case's checksum, who, when and which case, in the admin log", async () => {
      expect((await reveal(OWNER)).status).toBe(200);
      const res = await overturn(OWNER);
      expect(res).toEqual({ status: 200, body: { ok: true, cleared: hash(flagged) } });
      const [row] = await clearances();
      expect(row).toMatchObject({ sha256: hash(flagged), event_id: EVENT, cleared_by: OWNER, revoked_at: null, revoked_by: null });
      expect(row.cleared_at).toBeTruthy();
      expect(await state()).toEqual({ review_state: "overturned", reviewed_by: OWNER });
      const logged = (await actions()).filter((a) => a.action === "automod.overturn");
      expect(logged).toHaveLength(1);
      expect(logged[0]).toMatchObject({ actor_id: OWNER, target: EVENT });
      expect(logged[0].detail.outcome).toEqual({ httpStatus: 200, cleared: hash(flagged) });
    });

    it("refuses another admin, even one with a reveal row of their own, and changes nothing", async () => {
      await db.exec(`insert into public.artist_text_reveals (event_id, revealed_by, reason) values ('${EVENT}', '${ADMIN}', '${WHY}')`);
      expect(await overturn(ADMIN)).toEqual({ status: 403, body: { error: NOT_THE_OWNER } });
      expect(await clearances()).toEqual([]);
      expect((await state()).review_state).toBe("pending");
    });

    it("refuses a mod and nobody's policy", async () => {
      expect((await overturn(MOD)).status).toBe(403);
      await db.exec(`update public.moderation_policy set owner_user_id = null`);
      expect(await overturn(OWNER)).toEqual({ status: 403, body: { error: NOT_THE_OWNER } });
      expect(await clearances()).toEqual([]);
    });

    it("refuses the owner who has not looked", async () => {
      expect(await overturn(OWNER)).toEqual({ status: 403, body: { error: NOT_LOOKED_AT } });
      expect(NOT_LOOKED_AT).toBe("You cannot clear what you have not looked at. Reveal the image first.");
      expect(await clearances()).toEqual([]);
      expect((await state()).review_state).toBe("pending");
      expect((await actions()).filter((a) => a.action === "automod.overturn")).toEqual([]);
    });

    it("counts only the owner's own reveal, of this case's image", async () => {
      await seedCase(TWIN, other);
      await db.exec(`
        insert into public.artist_text_reveals (event_id, revealed_by, reason) values ('${EVENT}', '${ADMIN}', '${WHY}');
        insert into public.artist_text_reveals (event_id, revealed_by, reason) values ('${TWIN}', '${OWNER}', '${WHY}');
        insert into public.artist_text_reveals (event_id, prompt_id, revealed_by, reason) values ('${EVENT}', '00000000-0000-4000-8000-00000000bbbb', '${OWNER}', '${WHY}');
      `);
      expect(await overturn(OWNER)).toEqual({ status: 403, body: { error: NOT_LOOKED_AT } });
      expect(await clearances()).toEqual([]);
    });

    it("refuses when the reveal log cannot be read", async () => {
      await reveal(OWNER);
      await db.exec(`alter table public.artist_text_reveals rename to artist_text_reveals_away`);
      try {
        expect((await overturn(OWNER)).status).toBe(503);
      } finally {
        await db.exec(`alter table public.artist_text_reveals_away rename to artist_text_reveals`);
      }
      expect(await clearances()).toEqual([]);
      expect((await state()).review_state).toBe("pending");
    });

    it("refuses a case whose stored hash is no sha256 (the column is NOT NULL, so that is the only way to hold none)", async () => {
      await seedCase(TWIN, "abc123");
      await db.exec(`insert into public.artist_text_reveals (event_id, revealed_by, reason) values ('${TWIN}', '${OWNER}', '${WHY}')`);
      expect(await overturn(OWNER, TWIN)).toEqual({ status: 409, body: { error: NO_CHECKSUM } });
      expect(await clearances()).toEqual([]);
      expect((await state(TWIN)).review_state).toBe("pending");
    });

    it("lets an image case overturned before this rule be cleared by the owner who looks now", async () => {
      await db.exec(`update public.automod_events set review_state = 'overturned', reviewed_by = '${OWNER}', reviewed_at = now() where id = '${EVENT}'`);
      // Overturned but not cleared: what the row said before this rule lets nothing through.
      expect(await hunterImport()).toMatchObject({ ok: false, status: 422 });
      expect((await overturn(OWNER)).status).toBe(403);
      await reveal(OWNER);
      expect((await overturn(OWNER)).status).toBe(200);
      expect(await standing()).toHaveLength(1);
    });

    it("is one decision when pressed twice, and a failed second press leaves the first standing", async () => {
      await reveal(OWNER);
      expect((await overturn(OWNER)).status).toBe(200);
      expect((await overturn(OWNER)).status).toBe(200);
      expect(await clearances()).toHaveLength(1);
      await db.exec(`alter table public.automod_events add constraint boom check (review_notes is distinct from 'boom') not valid`);
      try {
        expect((await post(OWNER, { resource: "automod", action: "overturn", id: EVENT, reason: "boom" })).status).toBe(500);
      } finally {
        await db.exec(`alter table public.automod_events drop constraint boom`);
      }
      expect(await standing()).toHaveLength(1);
    });

    it("answers a clearance that could not be written as a failure, and the case stays as it was", async () => {
      await reveal(OWNER);
      await db.exec(`alter table public.image_clearances add constraint boom check (cleared_by is null) not valid`);
      const res = await overturn(OWNER);
      await db.exec(`alter table public.image_clearances drop constraint boom`);
      expect(res.status).toBe(500);
      expect(res.body.error).toMatch(/^Could not clear the image/);
      expect((await state()).review_state).toBe("pending");
    });

    it("writes no clearance when the case's own write fails, in one transaction, so nothing can stand behind the 500", async () => {
      await reveal(OWNER);
      const logged = (await actions()).length;
      await db.exec(`alter table public.automod_events add constraint boom check (review_notes is distinct from 'boom') not valid`);
      try {
        const res = await post(OWNER, { resource: "automod", action: "overturn", id: EVENT, reason: "boom" });
        expect(res.status).toBe(500);
        expect(res.body.error).toMatch(/^Could not clear the image/);
      } finally {
        await db.exec(`alter table public.automod_events drop constraint boom`);
      }
      expect(await clearances()).toEqual([]);
      expect((await state()).review_state).toBe("pending");
      expect(await actions()).toHaveLength(logged);
      expect(await hunterImport()).toMatchObject({ ok: false, status: 422 });
    });

    it("writes the case's whole review with the clearance", async () => {
      await reveal(OWNER);
      expect((await post(OWNER, { resource: "automod", action: "overturn", id: EVENT, reason: "A sunset, not a person." })).status).toBe(200);
      const [row] = await rows<{ review_notes: string; has_time: boolean }>(`select review_notes, reviewed_at is not null as has_time from public.automod_events where id = '${EVENT}'`);
      expect(row).toEqual({ review_notes: "A sunset, not a person.", has_time: true });
    });
  });

  describe("what a clearance lets through", () => {
    const clear = async () => { await reveal(OWNER); expect((await overturn(OWNER)).status).toBe(200); };

    it("lifts the verdict on the hunter's import for exactly those bytes, with no new case", async () => {
      await clear();
      const before = await cases();
      const got = await hunterImport();
      expect(got).toMatchObject({ ok: true });
      if (got.ok) {
        expect(got.preview.photos).toEqual([{ url: plan().photos[0].url, sha256: hash(flagged) }]);
        expect(got.preview.adult).toBe(false);
      }
      expect(await cases()).toBe(before);
    });

    it("refuses other bytes on the hunter's import, and they become their own case", async () => {
      await clear();
      served = other;
      const before = await cases();
      expect(await hunterImport()).toEqual({ ok: false, status: 422, error: PHOTOS_REFUSED });
      expect(await cases()).toBe(before + 1);
    });

    it("keeps refusing the cleared bytes on Refer a prompt, the other import, as its own case", async () => {
      await clear();
      const before = await cases();
      expect(await referral()).toEqual({ ok: false, status: 422, error: PHOTOS_REFUSED });
      expect(await cases()).toBe(before + 1);
    });

    it("asks the clearance on the hunter's import alone: no other file of app or lib reads it", () => {
      const found: string[] = [];
      const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
          const at = join(dir, name);
          if (name === "__tests__" || name === "node_modules") continue;
          if (statSync(at).isDirectory()) walk(at);
          else if (/\.tsx?$/.test(name) && /\b(imageCleared|image_clearances)\b|\.otherwise\b/.test(readFileSync(at, "utf8"))) found.push(at.slice(ROOT.length + 1).split("\\").join("/"));
        }
      };
      for (const top of ["app", "lib", "components", "hooks"]) walk(join(ROOT, top));
      expect(found.sort()).toEqual(["lib/admin/people.ts", "lib/moderation/image-check-bytes.ts", "lib/moderation/image-clearance.ts", "lib/referral/judge-post.ts"]);
      // people.ts shows it in the panel; the referral route names no surface, so judgeImport reads it as its own.
      expect(readFileSync(join(ROOT, "app/api/referrals/preview/route.ts"), "utf8")).toContain("judgeImport(supabase, { plan: read.plan, link, userId, request: req })");
    });

    describe("in a creator's recipe or manual mode, where no judge is asked", () => {
      const plainFind = () => defaultCreatorDeps(client, nobody()).plain(plan(), link, CREATOR, "A title");
      const judgeCalls = () => vi.mocked(fetch).mock.calls.filter(([url]) => /\/(moderations|chat\/completions)$/.test(String(url))).length;

      it("leaves a find out whose bytes a case holds, in any state, with no judge asked and no look or clearance", async () => {
        for (const reviewState of ["pending", "overturned", "upheld"]) {
          await db.exec(`update public.automod_events set review_state = '${reviewState}' where id = '${EVENT}'`);
          expect(await plainFind()).toEqual({ ok: false, status: 422, error: PHOTOS_REFUSED });
        }
        expect(judgeCalls()).toBe(0);
      });

      it("takes the bytes the owner cleared, and takes them no more once that is taken back", async () => {
        await clear();
        const got = await plainFind();
        expect(got).toMatchObject({ ok: true });
        if (got.ok) expect(got.preview.photos).toEqual([{ url: plan().photos[0].url, sha256: hash(flagged) }]);
        await uphold(ADMIN);
        expect(await plainFind()).toEqual({ ok: false, status: 422, error: PHOTOS_REFUSED });
      });

      it("takes bytes no case names, unjudged, as Kev chose for these modes", async () => {
        served = other;
        expect(await plainFind()).toMatchObject({ ok: true, preview: { adult: false, photos: [{ sha256: hash(other) }] } });
        expect(judgeCalls()).toBe(0);
      });

      it("answers not now when the cases cannot be read", async () => {
        await db.exec(`alter table public.automod_events rename to automod_events_away`);
        try {
          expect(await plainFind()).toEqual({ ok: false, status: 503, error: PHOTOS_UNCHECKED });
        } finally {
          await db.exec(`alter table public.automod_events_away rename to automod_events`);
        }
      });
    });

    it("still marks a cleared image 18+ for what it otherwise shows", async () => {
      await clear();
      luna = { ...luna, sexual: "suggestive" };
      const got = await hunterImport();
      expect(got).toMatchObject({ ok: true });
      if (got.ok) expect(got.preview.adult).toBe(true);
    });

    it("still refuses a cleared image that is explicit, with no new case", async () => {
      await clear();
      luna = { ...luna, sexual: "explicit" };
      const before = await cases();
      expect(await hunterImport()).toEqual({ ok: false, status: 422, error: PHOTOS_REFUSED });
      expect(await cases()).toBe(before);
    });

    it("answers not now when one judge could not be asked, so a cleared image is never half-judged", async () => {
      await clear();
      omniDown = true;
      expect(await hunterImport()).toEqual({ ok: false, status: 503, error: PHOTOS_UNCHECKED });
    });

    it("keeps the verdict, the case and the evidence: nothing but the reveal read the copy", async () => {
      await clear();
      await hunterImport();
      expect(holder.reads).toEqual([EVENT]);
      const [row] = await rows<{ category: string; scores: unknown; prompt_hash: string; matched_rules: string[]; decision: string }>(
        `select category, scores, prompt_hash, matched_rules, decision from public.automod_events where id = '${EVENT}'`);
      expect(row).toEqual({ category: "csam", scores: { minor_sexualised: 0.85 }, prompt_hash: hash(flagged), matched_rules: ["image-check"], decision: "block" });
    });
  });

  describe("taking it back", () => {
    const clear = async () => { await reveal(OWNER); expect((await overturn(OWNER)).status).toBe(200); };

    it("an uphold makes the image unreviewed again, says who and when, and is in the admin log", async () => {
      await clear();
      expect(await uphold(ADMIN)).toEqual({ status: 200, body: { ok: true, revoked: 1 } });
      const [row] = await clearances();
      expect(row.revoked_by).toBe(ADMIN);
      expect(row.revoked_at).toBeTruthy();
      expect(await state()).toEqual({ review_state: "upheld", reviewed_by: ADMIN });
      const before = await cases();
      expect(await hunterImport()).toEqual({ ok: false, status: 422, error: PHOTOS_REFUSED });
      expect(await cases()).toBe(before + 1);
      const logged = (await actions()).filter((a) => a.action === "automod.uphold");
      expect(logged[0].detail.outcome).toEqual({ httpStatus: 200, revoked: 1 });
      expect(logged[0].actor_id).toBe(ADMIN);
    });

    it("takes down a prompt the bytes were published to, and says which in the answer and the admin log", async () => {
      const published = "00000000-0000-4000-8000-00000000bbb1";
      await clear();
      await db.exec(`insert into public.prompts (id) values ('${published}'); insert into public.image_clearance_prompts (sha256, prompt_id) values ('${hash(flagged)}', '${published}')`);
      expect(await uphold(ADMIN)).toEqual({ status: 200, body: { ok: true, revoked: 1, unlisted: 1, prompts: published } });
      expect((await rows(`select is_listed from public.prompts`))).toEqual([{ is_listed: false }]);
      const logged = (await actions()).filter((a) => a.action === "automod.uphold");
      expect(logged[0].detail.outcome).toEqual({ httpStatus: 200, revoked: 1, unlisted: 1, prompts: published });
    });

    it("a takedown that failed fails the uphold, and pressing again finishes it", async () => {
      const published = "00000000-0000-4000-8000-00000000bbb1";
      await clear();
      await db.exec(`insert into public.prompts (id) values ('${published}'); insert into public.image_clearance_prompts (sha256, prompt_id) values ('${hash(flagged)}', '${published}');
        alter table public.prompts add constraint boom check (delisted_at is null) not valid;`);
      const failed = await uphold(ADMIN);
      await db.exec(`alter table public.prompts drop constraint boom`);
      expect(failed.status).toBe(500);
      expect((await state()).review_state).toBe("overturned");
      expect(await standing()).toEqual([]);
      expect(await uphold(ADMIN)).toEqual({ status: 200, body: { ok: true, revoked: 0, unlisted: 1, prompts: published } });
      expect((await state()).review_state).toBe("upheld");
    });

    it("a second uphold rewrites nobody's decision: who took it back and when stay", async () => {
      await clear();
      await uphold(ADMIN);
      const [first] = await clearances();
      expect(await uphold(OWNER)).toEqual({ status: 200, body: { ok: true, revoked: 0 } });
      expect(await clearances()).toEqual([first]);
    });

    it("an uphold of another case of the same bytes takes it back too", async () => {
      await seedCase(TWIN, flagged);
      await clear();
      expect(await uphold(OWNER, TWIN)).toEqual({ status: 200, body: { ok: true, revoked: 1 } });
      expect(await standing()).toEqual([]);
    });

    it("an uphold leaves another image's clearance alone", async () => {
      await seedCase(TWIN, other);
      await clear();
      expect(await uphold(OWNER, TWIN)).toEqual({ status: 200, body: { ok: true, revoked: 0 } });
      expect(await standing()).toHaveLength(1);
    });

    it("can be cleared again after being taken back only on a new look, as a new decision", async () => {
      await clear();
      await uphold(ADMIN);
      expect(await overturn(OWNER)).toEqual({ status: 403, body: { error: NOT_LOOKED_AT } });
      expect(await standing()).toEqual([]);
      await reveal(OWNER);
      expect((await overturn(OWNER)).status).toBe(200);
      expect(await clearances()).toHaveLength(2);
      expect(await standing()).toHaveLength(1);
      // The first clearance's look stays spent the second time round too: only the latest take-back's time counts.
      await uphold(ADMIN);
      expect((await overturn(OWNER)).status).toBe(403);
    });

    it("a take-back through another case of the same bytes spends the look too", async () => {
      await seedCase(TWIN, flagged);
      await clear();
      await uphold(ADMIN, TWIN);
      expect(await overturn(OWNER)).toEqual({ status: 403, body: { error: NOT_LOOKED_AT } });
    });

    it("another image's take-back spends no look", async () => {
      await seedCase(TWIN, other);
      await reveal(OWNER);
      await db.exec(`insert into public.artist_text_reveals (event_id, revealed_by, reason) values ('${TWIN}', '${OWNER}', '${WHY}')`);
      expect((await overturn(OWNER, TWIN)).status).toBe(200);
      await uphold(ADMIN, TWIN);
      expect((await overturn(OWNER)).status).toBe(200);
    });

    it("refuses when the clearances cannot be read for their last take-back", async () => {
      await reveal(OWNER);
      await db.exec(`alter table public.image_clearances rename column revoked_at to revoked_away`);
      try {
        expect((await overturn(OWNER)).status).toBe(503);
      } finally {
        await db.exec(`alter table public.image_clearances rename column revoked_away to revoked_at`);
      }
      expect((await state()).review_state).toBe("pending");
    });

    it("a mod cannot take it back", async () => {
      await clear();
      expect((await uphold(MOD)).status).toBe(403);
      expect(await standing()).toHaveLength(1);
    });

    it("refuses the uphold when the clearance could not be taken back: the case does not read upheld while its image passes", async () => {
      await clear();
      await db.exec(`alter table public.image_clearances add constraint boom check (revoked_at is null) not valid`);
      expect((await uphold(ADMIN)).status).toBe(500);
      await db.exec(`alter table public.image_clearances drop constraint boom`);
      expect((await state()).review_state).toBe("overturned");
    });
  });

  describe("before SQL 61 runs", () => {
    beforeEach(async () => { await db.exec(`drop function public.clear_image_case(uuid, text, uuid, text); drop table public.image_clearance_prompts; drop table public.image_clearances;`); });

    it("answers plainly and changes nothing", async () => {
      await reveal(OWNER);
      const logged = (await actions()).length;
      expect(await overturn(OWNER)).toEqual({ status: 503, body: { error: CLEARANCE_NOT_READY } });
      expect(CLEARANCE_NOT_READY).toContain("SQL 61");
      expect((await state()).review_state).toBe("pending");
      expect(await actions()).toHaveLength(logged);
    });

    it("still looks first: the owner rule and the reveal rule come before the table", async () => {
      expect((await overturn(ADMIN)).body.error).toBe(NOT_THE_OWNER);
      expect((await overturn(OWNER)).body.error).toBe(NOT_LOOKED_AT);
    });

    it("an uphold works, and the hunter's import refuses as today", async () => {
      expect(await uphold(ADMIN)).toEqual({ status: 200, body: { ok: true, revoked: 0 } });
      expect((await state()).review_state).toBe("upheld");
      expect(await hunterImport()).toEqual({ ok: false, status: 422, error: PHOTOS_REFUSED });
    });

    it("the person list still opens, with nothing cleared", async () => {
      const { events } = await personDetail(client, { userId: CREATOR }, () => null);
      expect(events[0]).toMatchObject({ id: EVENT, imageCase: true, cleared: false });
    });
  });

  describe("every other review stays as it was", () => {
    it("overturns a warning for a mod, and a child-safety request for any admin, with no clearance asked", async () => {
      await db.exec(`
        insert into public.automod_events (id, user_id, surface, decision, severity, tier, category, scores, prompt_hash, review_state) values
          ('00000000-0000-4000-8000-00000000ccc1', '${CREATOR}', 'x', 'block', 'strike', 2, 'explicit_sexual', '{"weight":1}', '${hash(flagged)}', 'none'),
          ('00000000-0000-4000-8000-00000000ccc2', '${CREATOR}', 'x', 'block', 'strike', 2, 'minor_sexual', '{"weight":10}', '${hash(flagged)}', 'pending'),
          ('00000000-0000-4000-8000-00000000ccc3', '${CREATOR}', 'x', 'block', 'review', 2, 'csam', '{}', '${hash(flagged)}', 'pending');
      `);
      expect(await overturn(MOD, "00000000-0000-4000-8000-00000000ccc1")).toEqual({ status: 200, body: { ok: true } });
      expect(await overturn(ADMIN, "00000000-0000-4000-8000-00000000ccc2")).toEqual({ status: 200, body: { ok: true } });
      expect(await overturn(ADMIN, "00000000-0000-4000-8000-00000000ccc3")).toEqual({ status: 200, body: { ok: true } });
      expect(await clearances()).toEqual([]);
      for (const id of ["ccc1", "ccc2", "ccc3"]) expect(await state(`00000000-0000-4000-8000-00000000${id}`)).toEqual({ review_state: "overturned", reviewed_by: id === "ccc1" ? MOD : ADMIN });
    });

    it("asks for a clearance only on a child-safety record of the image check", async () => {
      await db.exec(`insert into public.automod_events (id, user_id, surface, decision, severity, tier, category, matched_rules, scores, prompt_hash, review_state) values
        ('00000000-0000-4000-8000-00000000ccc4', '${CREATOR}', 'x', 'block', 'strike', 2, 'explicit_sexual', array['image-check'], '{"weight":1}', '${hash(flagged)}', 'none')`);
      expect(await overturn(MOD, "00000000-0000-4000-8000-00000000ccc4")).toEqual({ status: 200, body: { ok: true } });
      expect(await clearances()).toEqual([]);
    });
  });

  describe("the person list", () => {
    it("says which case is an image case and stands cleared, and stops saying so once taken back", async () => {
      await db.exec(`insert into public.automod_events (id, user_id, surface, decision, severity, tier, category, scores, prompt_hash, review_state) values
        ('00000000-0000-4000-8000-00000000ccc1', '${CREATOR}', 'x', 'block', 'strike', 2, 'explicit_sexual', '{"weight":1}', 'x', 'none')`);
      const detail = async () => Object.fromEntries((await personDetail(client, { userId: CREATOR }, () => null)).events.map((e) => [e.id, { imageCase: e.imageCase, cleared: e.cleared }]));
      expect(await detail()).toEqual({ [EVENT]: { imageCase: true, cleared: false }, "00000000-0000-4000-8000-00000000ccc1": { imageCase: false, cleared: false } });
      await reveal(OWNER);
      await overturn(OWNER);
      expect((await detail())[EVENT]).toEqual({ imageCase: true, cleared: true });
      await uphold(OWNER);
      expect((await detail())[EVENT]).toEqual({ imageCase: true, cleared: false });
    });
  });

  describe("the migration", () => {
    const row = (sha: string, extra = "") => `insert into public.image_clearances (sha256, event_id, cleared_by${extra ? ", revoked_at" : ""}) values ('${sha}', '${EVENT}', '${OWNER}'${extra ? `, ${extra}` : ""})`;
    const code = async (sql: string) => db.exec(sql).then(() => "ok", (e: { code?: string }) => e.code);

    it("runs twice and keeps its rows", async () => {
      await db.exec(row(hash(flagged)));
      await db.exec(SQL);
      expect(await clearances()).toHaveLength(1);
    });

    it("holds a sha256 and nothing else", async () => {
      expect(await code(row("abc"))).toBe("23514");
      expect(await code(row(hash(flagged).toUpperCase()))).toBe("23514");
      expect(await code(row(`${hash(flagged)}0`))).toBe("23514");
    });

    it("names a real case, one standing clearance per case, and a revoke says who and when together", async () => {
      expect(await code(`insert into public.image_clearances (sha256, event_id, cleared_by) values ('${hash(flagged)}', '00000000-0000-4000-8000-00000000dddd', '${OWNER}')`)).toBe("23503");
      await db.exec(row(hash(flagged)));
      expect(await code(row(hash(other)))).toBe("23505");
      expect(await code(`update public.image_clearances set revoked_at = now()`)).toBe("23514");
      expect(await code(`update public.image_clearances set revoked_by = '${OWNER}'`)).toBe("23514");
      expect(await code(`update public.image_clearances set revoked_at = now(), revoked_by = '${OWNER}'`)).toBe("ok");
      expect(await code(row(hash(flagged)))).toBe("ok");
    });

    it("is the service role's alone", async () => {
      const [t] = await rows<{ rowsecurity: boolean }>(`select rowsecurity from pg_tables where tablename = 'image_clearances'`);
      expect(t.rowsecurity).toBe(true);
      for (const role of ["anon", "authenticated"]) {
        const [g] = await rows<{ can: boolean }>(`select has_table_privilege('${role}', 'public.image_clearances', 'select') as can`);
        expect(g.can).toBe(false);
      }
      const can = async (role: string) => (await rows<{ can: boolean }>(`select has_function_privilege('${role}', 'public.clear_image_case(uuid, text, uuid, text)', 'execute') as can`))[0].can;
      expect([await can("anon"), await can("authenticated"), await can("service_role")]).toEqual([false, false, true]);
    });

    // Said out loud in the file (changelog 45329): this schema gives the role nothing by default, so what it can do here is
    // what the file grants. Each statement is what lib/moderation/image-clearance and lib/admin/people send.
    it("grants the service role what the code does on both tables, and no more", async () => {
      const sha = hash(flagged);
      await db.exec(`set role service_role`);
      try {
        await db.query(`select public.clear_image_case($1, $2, $3, 'looked')`, [EVENT, sha, OWNER]);
        expect(await rows(`select id from public.image_clearances where sha256 = '${sha}' and revoked_at is null limit 1`)).toHaveLength(1);
        expect(await rows(`select event_id from public.image_clearances where event_id = '${EVENT}' and revoked_at is null`)).toHaveLength(1);
        expect((await db.query(`update public.image_clearances set revoked_at = now(), revoked_by = '${OWNER}' where sha256 = '${sha}' and revoked_at is null returning id`)).rows).toHaveLength(1);
        await db.exec(`insert into public.image_clearance_prompts (sha256, prompt_id) values ('${sha}', '${EVENT}')`);
        expect(await rows(`select prompt_id from public.image_clearance_prompts where sha256 = '${sha}'`)).toHaveLength(1);
        for (const sql of [
          row(sha),
          `delete from public.image_clearances`,
          `update public.image_clearance_prompts set prompt_id = '${EVENT}'`,
          `delete from public.image_clearance_prompts`,
        ]) expect(await code(sql)).toBe("42501");
      } finally {
        await db.exec(`reset role`);
      }
    });

    it("rolls back as its last lines say", async () => {
      const rollback = /-- Rollback[^\n]*\n--\s+(.+)\n/.exec(SQL)![1];
      await db.exec(rollback);
      expect(await rows(`select 1 from pg_tables where tablename = 'image_clearances'`)).toEqual([]);
      expect(await rows(`select 1 from pg_proc where proname = 'clear_image_case'`)).toEqual([]);
      expect((await state()).review_state).toBe("pending");
    });
  });
});
