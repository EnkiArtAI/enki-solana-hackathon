import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { NextRequest } from "next/server";
import { pglitePostgrest } from "@/lib/__tests__/_pglite-postgrest";

/**
 * Kev, 2026-11-03: the NFT click-check. The real list and check routes and SQL 65 on a real Postgres; only the session, the
 * network (the index and the CDN) and the judges are stubbed, so no test can reach a metered host: an unknown address throws.
 *
 * Blind spot: PGlite is one session, so the two presses at once below interleave between statements and never inside one;
 * the claim's WHERE is what they meet. The judges themselves are stubbed: lib/moderation holds their own tests.
 */
const s = vi.hoisted(() => ({
  user: null as string | null,
  client: null as unknown,
  verdicts: [] as unknown[],
  judged: [] as Buffer[],
  cases: [] as Record<string, unknown>[],
  after: [] as unknown[],
  cdn: [] as string[],
  index: 0,
  picture: 200,
  pictureType: "image/webp",
  during: null as null | (() => Promise<unknown>),
}));
vi.mock("@/lib/session-user", () => ({ resolveSessionUserId: async () => s.user }));
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => s.client }));
vi.mock("@/lib/moderation/image-check-bytes", async (original) => ({
  ...(await original<typeof import("@/lib/moderation/image-check-bytes")>()),
  checkImageBytes: async (bytes: Buffer, opts: { signal?: AbortSignal } = {}) => {
    s.judged.push(bytes);
    // As the real one answers a press its client has left.
    if (opts.signal?.aborted) return { verdict: "unavailable", reason: "aborted" };
    const verdict = s.verdicts.shift() ?? { verdict: "clear" };
    await s.during?.();
    return verdict;
  },
}));
vi.mock("@/lib/moderation/image-case", () => ({ recordImageCase: async (_: unknown, ctx: Record<string, unknown>) => { s.cases.push(ctx); } }));
vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  after: (task: unknown) => { s.after.push(task); },
}));

import { GET as list } from "../../app/api/wallet/nfts/route";
import { GET as read, POST as press } from "../../app/api/wallet/nfts/check/route";
import { NFT_CHECK_NOT_READY, NFT_REFUSED, RENEWALS_FIRST_DAY, RENEWALS_PER_DAY, nftCheckOf, signNftProof } from "@/lib/nft-check";

const ROOT = join(__dirname, "..", "..");
const MIGRATION = readFileSync(join(ROOT, "migrations", "2026-11-03-nft-checks.sql"), "utf8");
const COPY = join(ROOT, "..", "sql-to-run", "65-nft-checks.sql");

const RPC = "https://rpc.test/?api-key=k";
const CDN = "https://cdn.helius-rpc.com/cdn-cgi/image";
const WALLET = "Wa11etAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OTHER = "SecondBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const ASSET = "AssetCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const IMAGE = "https://host.test/a.png";
const BYTES = Buffer.from("the-picture");

type Listed = { id: string; image: string; proof: string };
type Answer = { error?: string; check?: { verdict: string; why: string | null; left: number; opensAt: string | null; picture: boolean } };
const DAY = (d: string) => new Date(`${d}T12:00:00.000Z`);
const EXPLICIT = { verdict: "blocked", reason: "explicit" };

describe("the click-check", () => {
  let db: PGlite;
  let n = 0;
  let me = "";

  const newUser = async (wallet = WALLET) => {
    const id = `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
    await db.query("insert into public.users (id) values ($1)", [id]);
    if (wallet) await db.query("insert into public.user_wallets (user_id, address, chain_family, is_primary) values ($1, $2, 'solana', true)", [id, wallet]);
    return id;
  };
  const signed = (user: string) => { s.user = user; };
  const askList = async (user = me) => {
    signed(user);
    const res = await list(new NextRequest("http://enki.test/api/wallet/nfts", { headers: { "X-Session-Token": "tok" } }));
    return ((await res.json()) as { nfts: Listed[] }).nfts;
  };
  const post = async (body: unknown, user = me) => {
    signed(user);
    const res = await press(new NextRequest("http://enki.test/api/wallet/nfts/check", {
      method: "POST", headers: { "X-Session-Token": "tok", "Content-Type": "application/json" }, body: JSON.stringify(body),
    }));
    return { status: res.status, ...((await res.json()) as Answer) };
  };
  /** A press its client has already left. */
  const left = async (body: unknown, user = me) => {
    signed(user);
    const gone = new AbortController();
    gone.abort();
    const res = await press(new NextRequest("http://enki.test/api/wallet/nfts/check", {
      method: "POST", headers: { "X-Session-Token": "tok", "Content-Type": "application/json" }, body: JSON.stringify(body), signal: gone.signal,
    }));
    return res.status;
  };
  const saved = async (user = me) => {
    signed(user);
    const res = await read(new NextRequest("http://enki.test/api/wallet/nfts/check", { headers: { "X-Session-Token": "tok" } }));
    return { status: res.status, cache: res.headers.get("cache-control"), ...((await res.json()) as { error?: string; checks?: Record<string, Answer["check"]> }) };
  };
  const rows = async () => (await db.query<Record<string, unknown>>("select * from public.nft_checks where user_id = $1", [me])).rows;
  /** The tile's first press, as the browser sends it: what the list named. */
  const tile = async () => (await askList())[0];
  const check = async (renew?: boolean) => {
    const { id, image, proof } = await tile();
    return post({ id, image, proof, ...(renew && { renew }) });
  };

  beforeAll(async () => {
    db = await PGlite.create();
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE public.users (id uuid PRIMARY KEY);
      CREATE TABLE public.user_wallets (user_id uuid, address text, chain_family text, is_primary boolean, removed_at timestamptz);
      CREATE TABLE public.linked_wallets (user_id uuid, address text);
    `);
    await db.exec(MIGRATION);
    s.client = pglitePostgrest(db).client;
  }, 60_000);
  afterAll(async () => { await db.close(); });

  beforeEach(async () => {
    vi.stubEnv("SOLANA_RPC_URL", RPC);
    vi.stubEnv("AUTH_PEPPER", "a-test-pepper");
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === RPC) {
        s.index += 1;
        return Response.json({ result: { items: [{ id: ASSET, content: { metadata: { name: "Madlad" }, links: { image: IMAGE } } }] } });
      }
      if (!url.startsWith(`${CDN}/`)) throw new Error(`unexpected fetch ${url}`);
      s.cdn.push(url);
      return new Response(BYTES, { status: s.picture, headers: { "Content-Type": s.pictureType } });
    }));
    Object.assign(s, { verdicts: [], judged: [], cases: [], after: [], cdn: [], index: 0, picture: 200, pictureType: "image/webp", during: null });
    me = await newUser();
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  describe("SQL 65", () => {
    it("runs twice", async () => {
      await db.exec(MIGRATION);
      expect((await db.query("select 1 from public.nft_checks limit 1")).rows).toEqual([]);
    });
    it("is the file Kev runs, and says how to check and how to go back", () => {
      if (existsSync(COPY)) expect(readFileSync(COPY, "utf8")).toBe(MIGRATION);
      expect(MIGRATION).toContain("-- Check:");
      expect(MIGRATION).toContain("-- Rollback");
    });
    it("is the service role's alone: RLS on, the grants by name", async () => {
      const { rows: on } = await db.query<{ relrowsecurity: boolean }>("select relrowsecurity from pg_class where relname = 'nft_checks'");
      expect(on[0].relrowsecurity).toBe(true);
      const { rows: grants } = await db.query<{ grantee: string; privilege_type: string }>(
        "select grantee, privilege_type from information_schema.role_table_grants where table_name = 'nft_checks' and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC') order by 1, 2",
      );
      expect(grants.map((g) => `${g.grantee}:${g.privilege_type}`)).toEqual(["service_role:INSERT", "service_role:SELECT", "service_role:UPDATE"]);
    });
    it("holds allowed or refused and no other word, a child-safety one least of all", async () => {
      await expect(db.query("insert into public.nft_checks (user_id, nft_id, verdict) values ($1, 'x', 'child_safety')", [me])).rejects.toThrow(/check/i);
    });
    it("goes with the account", async () => {
      const user = await newUser();
      await db.query("insert into public.nft_checks (user_id, nft_id, verdict) values ($1, 'x', 'allowed')", [user]);
      await db.query("delete from public.users where id = $1", [user]);
      expect((await db.query("select 1 from public.nft_checks where user_id = $1", [user])).rows).toEqual([]);
    });
  });

  describe("a press on a grey tile", () => {
    it("judges the picture the CDN gives for the listed address, saves allowed for this account and NFT, and it survives a reload", async () => {
      expect(await saved()).toMatchObject({ status: 200, checks: {} });
      const answer = await check();
      expect(answer).toMatchObject({ status: 200, check: { verdict: "allowed", why: null, left: 0, opensAt: null } });
      expect(s.cdn).toEqual([`${CDN}/width=1024,height=1024,fit=scale-down,format=webp,quality=85,anim=false/${IMAGE}`]);
      expect(s.judged.map(String)).toEqual([String(BYTES)]);
      expect(await rows()).toMatchObject([{ nft_id: ASSET, verdict: "allowed", renewals: 0 }]);
      const after = await saved();
      expect(after.checks).toEqual({ [ASSET]: answer.check });
      expect(after.cache).toBe("no-store");
    });
    it("makes no index call: the list's one is all a wallet read costs", async () => {
      await check();
      expect(s.index).toBe(1);
    });
    it("a second press answers what is saved and judges nothing", async () => {
      await check();
      const again = await check();
      expect(again).toMatchObject({ status: 200, check: { verdict: "allowed" } });
      expect(s.judged).toHaveLength(1);
      expect(s.cdn).toHaveLength(1);
    });
    it("is one account's: another account's tile stays grey", async () => {
      await check();
      const other = await newUser();
      expect((await saved(other)).checks).toEqual({});
    });
    it("a signed-out press asks nothing", async () => {
      s.user = null;
      const res = await press(new NextRequest("http://enki.test/api/wallet/nfts/check", { method: "POST", body: "{}" }));
      expect(res.status).toBe(401);
      expect(s.judged).toHaveLength(0);
    });
  });

  describe("what the judges say", () => {
    it("an 18+ picture passes, as a reference at generate-image does, and the tile says what comes with it", async () => {
      s.verdicts = [{ verdict: "adult", reason: "suggestive" }];
      expect((await check()).check).toMatchObject({ verdict: "allowed", why: expect.stringContaining("18+") });
    });
    it("explicit is refused, in the same words as child safety, and its picture draws", async () => {
      s.verdicts = [{ verdict: "blocked", reason: "explicit" }];
      expect(await check()).toMatchObject({ status: 200, check: { verdict: "refused", why: NFT_REFUSED, picture: true } });
      expect(s.cases).toEqual([]);
      expect(s.after).toEqual([]);
    });
    it("child safety takes the case path once, and the tile, the answer and the row know only refused", async () => {
      s.verdicts = [{ verdict: "child_safety", scores: { minor: 0.9 } }];
      const answer = await check();
      expect(answer).toMatchObject({ status: 200, check: { verdict: "refused", why: NFT_REFUSED, picture: false } });
      expect(s.after).toHaveLength(1);
      await Promise.all(s.after);
      expect(s.cases).toHaveLength(1);
      expect(s.cases[0]).toMatchObject({ surface: "nft-check", scores: { minor: 0.9 }, about: JSON.stringify({ nft: ASSET }) });
      expect(String(s.cases[0].bytes)).toBe(String(BYTES));
      expect(JSON.stringify([answer, await rows(), await saved()])).not.toMatch(/child|csam|minor|safety/i);
      expect((await saved()).checks?.[ASSET]).toMatchObject({ picture: false });
    });
    it("only a green verdict lifts no_picture: every other red answer keeps it (Kev, 2026-11-04: \"ja, grünes urteil hebt sperre ab passt\")", async () => {
      s.verdicts = [{ verdict: "child_safety", scores: { minor: 0.9 } }, EXPLICIT, { verdict: "blocked", reason: "not a still" }, { verdict: "blocked", reason: "not an image" }, { verdict: "clear" }];
      expect((await check()).check?.picture).toBe(false);
      expect(await rows()).toMatchObject([{ no_picture: true }]);
      expect((await check(true)).check).toMatchObject({ verdict: "refused", why: NFT_REFUSED, picture: false });
      expect((await check(true)).check).toMatchObject({ verdict: "refused", why: expect.stringMatching(/moves/), picture: false });
      expect((await check(true)).check).toMatchObject({ verdict: "refused", why: NFT_REFUSED, picture: false });
      expect(await rows()).toMatchObject([{ no_picture: true }]);
      expect((await check(true)).check).toMatchObject({ verdict: "allowed", picture: true });
      expect(await rows()).toMatchObject([{ no_picture: false }]);
    });
    it("a renewal can set it, and an 18+ green lifts it as a plain green does", async () => {
      s.verdicts = [EXPLICIT, { verdict: "child_safety", scores: { minor: 0.9 } }, { verdict: "adult", reason: "suggestive" }];
      expect((await check()).check?.picture).toBe(true);
      expect(await rows()).toMatchObject([{ no_picture: false }]);
      expect((await check(true)).check?.picture).toBe(false);
      expect((await check(true)).check).toMatchObject({ verdict: "allowed", picture: true });
      expect(await rows()).toMatchObject([{ no_picture: false }]);
    });
    it("a red press still waiting for its judge does not undo a flag saved meanwhile", async () => {
      s.verdicts = [EXPLICIT];
      await check();
      const { id, image, proof } = await tile();
      s.verdicts = [EXPLICIT, { verdict: "child_safety", scores: { minor: 0.9 } }];
      let second = 0;
      s.during = async () => { s.during = null; second = (await post({ id, image, proof, renew: true })).status; };
      expect((await post({ id, image, proof, renew: true })).check).toMatchObject({ why: NFT_REFUSED, picture: false });
      expect(second).toBe(200);
      expect(await rows()).toMatchObject([{ no_picture: true }]);
    });
    it("an unreadable file and a child-safety verdict read the same, to the client and on the row: the pair singles out neither", async () => {
      const said: unknown[] = [];
      for (const verdict of [{ verdict: "child_safety", scores: { minor: 0.9 } }, { verdict: "blocked", reason: "not an image" }, { verdict: "blocked", reason: "unreadable" }]) {
        me = await newUser();
        s.verdicts = [verdict];
        const { status, check: answer } = await check();
        const [{ verdict: kept, why, no_picture }] = await rows();
        said.push({ status, answer, kept, why, no_picture, read: (await saved()).checks?.[ASSET] });
      }
      expect(said[0]).toMatchObject({ status: 200, why: NFT_REFUSED, no_picture: true, answer: { picture: false } });
      expect(said[1]).toEqual(said[0]);
      expect(said[2]).toEqual(said[0]);
    });
    it("the client never gets the private column", async () => {
      s.verdicts = [{ verdict: "child_safety", scores: { minor: 0.9 } }];
      expect(JSON.stringify([await check(), await saved()])).not.toContain("no_picture");
    });
    it("a clear and an 18+ picture draw", async () => {
      expect((await check()).check?.picture).toBe(true);
      const other = await newUser();
      s.verdicts = [{ verdict: "adult", reason: "suggestive" }];
      const [{ id, image, proof }] = await askList(other);
      expect((await post({ id, image, proof }, other)).check?.picture).toBe(true);
    });
    it.each([
      [{ verdict: "blocked", reason: "not a still" }, /moves/, true],
      [{ verdict: "blocked", reason: "not an image" }, /can't be used on Enki/, false],
      [{ verdict: "blocked", reason: "unreadable" }, /can't be used on Enki/, false],
    ])("%j is refused, in the words it may be told in", async (verdict, why, picture) => {
      s.verdicts = [verdict];
      expect((await check()).check).toMatchObject({ verdict: "refused", why: expect.stringMatching(why), picture });
    });
  });

  describe("a check that failed", () => {
    it("a judge down saves nothing and says so", async () => {
      s.verdicts = [{ verdict: "unavailable", reason: "down" }];
      const answer = await check();
      expect(answer.status).toBe(503);
      expect(answer.error).toMatch(/could not be checked/);
      expect(answer.check).toBeUndefined();
      expect(await rows()).toEqual([]);
    });
    it.each([
      ["a CDN error", 502, "image/webp"],
      ["an error page answered 200", 200, "text/html"],
      ["an SVG", 200, "image/svg+xml"],
    ])("%s saves nothing, says so and judges nothing", async (_, status, type) => {
      Object.assign(s, { picture: status, pictureType: type });
      const answer = await check();
      expect(answer.status).toBe(502);
      expect(answer.error).toMatch(/could not be read/);
      expect(s.judged).toHaveLength(0);
      expect(await rows()).toEqual([]);
    });
    it("costs no renewal, and the old verdict stands", async () => {
      s.verdicts = [EXPLICIT];
      await check();
      s.verdicts = [{ verdict: "unavailable", reason: "down" }];
      expect((await check(true)).status).toBe(503);
      s.picture = 500;
      expect((await check(true)).status).toBe(502);
      expect(await rows()).toMatchObject([{ verdict: "refused", renewals: 0 }]);
      expect((await saved()).checks?.[ASSET]).toMatchObject({ verdict: "refused", left: RENEWALS_FIRST_DAY });
    });
  });

  describe("renewing", () => {
    it("a refused one judges again, stays red and keeps counting", async () => {
      s.verdicts = [EXPLICIT, EXPLICIT];
      await check();
      expect((await check(true)).check).toMatchObject({ verdict: "refused", why: NFT_REFUSED, left: RENEWALS_FIRST_DAY - 1 });
      expect(s.judged).toHaveLength(2);
      expect(await rows()).toMatchObject([{ verdict: "refused", renewals: 1 }]);
    });

    it("a green one judges nothing, claims nothing and answers its verdict", async () => {
      await check();
      for (const _ of [1, 2]) expect(await check(true)).toMatchObject({ status: 200, check: { verdict: "allowed", left: 0, opensAt: null } });
      expect(s.judged).toHaveLength(1);
      expect(s.cdn).toHaveLength(1);
      expect(await rows()).toMatchObject([{ verdict: "allowed", renewals: 0 }]);
    });

    it("one that comes back green ends renewing for that NFT", async () => {
      s.verdicts = [EXPLICIT, { verdict: "clear" }, EXPLICIT];
      await check();
      expect((await check(true)).check).toMatchObject({ verdict: "allowed", why: null, left: 0, opensAt: null });
      expect(await check(true)).toMatchObject({ status: 200, check: { verdict: "allowed", left: 0 } });
      expect(s.judged).toHaveLength(2);
      expect(await rows()).toMatchObject([{ verdict: "allowed", renewals: 1 }]);
      expect((await saved()).checks?.[ASSET]).toMatchObject({ verdict: "allowed", left: 0, opensAt: null });
    });

    it("is counted per NFT and per account: another account's refusal of the same NFT has its own 5", async () => {
      s.verdicts = [EXPLICIT, EXPLICIT, EXPLICIT];
      await check();
      await check(true);
      const other = await newUser();
      const [{ id, image, proof }] = await askList(other);
      await post({ id, image, proof }, other);
      expect((await saved(other)).checks?.[ASSET]).toMatchObject({ verdict: "refused", left: RENEWALS_FIRST_DAY });
    });

    it("gives 5 on the day of the first check, then says when it opens, judging nothing", async () => {
      vi.useFakeTimers({ toFake: ["Date"], now: DAY("2026-11-03") });
      s.verdicts = Array(1 + RENEWALS_FIRST_DAY).fill(EXPLICIT);
      await check();
      for (let i = 1; i <= RENEWALS_FIRST_DAY; i++) expect((await check(true)).check?.left).toBe(RENEWALS_FIRST_DAY - i);
      expect(s.judged).toHaveLength(1 + RENEWALS_FIRST_DAY);
      const refused = await check(true);
      expect(refused).toMatchObject({ status: 429, check: { verdict: "refused", left: 0, opensAt: "2026-11-04T00:00:00.000Z" } });
      expect(s.judged).toHaveLength(1 + RENEWALS_FIRST_DAY);
      expect((await saved()).checks?.[ASSET]).toMatchObject({ left: 0, opensAt: "2026-11-04T00:00:00.000Z" });
    });

    it("gives 2 on each UTC day after, whatever the first day used, from midnight UTC to midnight UTC", async () => {
      vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-03T23:59:00.000Z") });
      s.verdicts = Array(9).fill(EXPLICIT);
      await check();
      vi.setSystemTime(new Date("2026-11-04T00:00:30.000Z"));
      expect((await saved()).checks?.[ASSET]).toMatchObject({ left: RENEWALS_PER_DAY, opensAt: null });
      for (let i = 1; i <= RENEWALS_PER_DAY; i++) expect((await check(true)).check?.left).toBe(RENEWALS_PER_DAY - i);
      expect(await check(true)).toMatchObject({ status: 429, check: { left: 0, opensAt: "2026-11-05T00:00:00.000Z" } });
      vi.setSystemTime(new Date("2026-11-05T00:00:30.000Z"));
      expect((await check(true)).check?.left).toBe(RENEWALS_PER_DAY - 1);
    });

    it("the numbers are the two constants, and only they", () => {
      expect([RENEWALS_FIRST_DAY, RENEWALS_PER_DAY]).toEqual([5, 2]);
      const row = { nft_id: "x", verdict: "refused" as const, why: NFT_REFUSED, no_picture: false, first_checked_at: "2026-11-03T10:00:00Z", renew_day: "2026-11-03", renewals: 1 };
      expect(nftCheckOf(row, DAY("2026-11-03")).left).toBe(RENEWALS_FIRST_DAY - 1);
      expect(nftCheckOf(row, DAY("2026-11-04")).left).toBe(RENEWALS_PER_DAY);
      expect(nftCheckOf({ ...row, renew_day: "2026-11-04", renewals: 9 }, DAY("2026-11-04"))).toMatchObject({ left: 0, opensAt: "2026-11-05T00:00:00.000Z" });
      expect(nftCheckOf({ ...row, verdict: "allowed", why: null }, DAY("2026-11-03"))).toEqual({ verdict: "allowed", why: null, left: 0, opensAt: null, picture: true });
    });

    it("a client that leaves after the judges were asked keeps nothing back: the renewal is spent, the verdict saved", async () => {
      s.verdicts = Array(4).fill(EXPLICIT);
      await check();
      const { id, image, proof } = await tile();
      for (let i = 1; i <= 3; i++) expect(await left({ id, image, proof, renew: true })).toBe(200);
      expect(s.judged).toHaveLength(4);
      expect(await rows()).toMatchObject([{ renewals: 3 }]);
    });

    it("so does a first press: its verdict stands, and the next press judges nothing", async () => {
      const { id, image, proof } = await tile();
      expect(await left({ id, image, proof })).toBe(200);
      expect(await rows()).toMatchObject([{ verdict: "allowed", renewals: 0 }]);
      expect((await post({ id, image, proof })).status).toBe(200);
      expect(s.judged).toHaveLength(1);
    });

    it("two presses at once on a new UTC day: the count alone is not enough, the day is part of the claim", async () => {
      vi.useFakeTimers({ toFake: ["Date"], now: DAY("2026-11-03") });
      s.verdicts = [EXPLICIT];
      await check();
      await db.query("update public.nft_checks set renewals = 1 where user_id = $1", [me]);
      vi.setSystemTime(DAY("2026-11-04"));
      const { id, image, proof } = await tile();
      // Yesterday's count happens to equal what today's first claim writes, so only renew_day tells the two presses apart.
      const answers = await Promise.all([post({ id, image, proof, renew: true }), post({ id, image, proof, renew: true })]);
      expect(answers.map((a) => a.status).sort()).toEqual([200, 409]);
      expect(await rows()).toMatchObject([{ renewals: 1 }]);
    });

    it("a check that failed gives back only its own claim: a later press's count stands", async () => {
      s.verdicts = [EXPLICIT];
      await check();
      const { id, image, proof } = await tile();
      s.verdicts = [{ verdict: "unavailable", reason: "down" }];
      let later = 0;
      // While the first press waits for its judge, a second one claims and saves.
      s.during = async () => { s.during = null; later = (await post({ id, image, proof, renew: true })).status; };
      expect((await post({ id, image, proof, renew: true })).status).toBe(503);
      expect(later).toBe(200);
      expect(await rows()).toMatchObject([{ renewals: 2 }]);
    });

    it("two presses at once on the last renewal judge once", async () => {
      s.verdicts = [EXPLICIT];
      await check();
      await db.query("update public.nft_checks set renewals = $2 where user_id = $1", [me, RENEWALS_FIRST_DAY - 1]);
      const { id, image, proof } = await tile();
      const answers = await Promise.all([post({ id, image, proof, renew: true }), post({ id, image, proof, renew: true })]);
      expect(answers.map((a) => a.status).sort()).toEqual([200, 409]);
      expect(s.judged).toHaveLength(2);
      expect(await rows()).toMatchObject([{ renewals: RENEWALS_FIRST_DAY }]);
    });

    it("a first press in another tab that saved first stands, and costs no renewal", async () => {
      const { id, image, proof } = await tile();
      s.verdicts = [{ verdict: "clear" }, { verdict: "blocked", reason: "explicit" }];
      const answers = await Promise.all([post({ id, image, proof }), post({ id, image, proof })]);
      expect(answers.map((a) => a.status)).toEqual([200, 200]);
      expect(answers.map((a) => a.check?.verdict)).toEqual(["allowed", "allowed"]);
      expect(await rows()).toMatchObject([{ verdict: "allowed", renewals: 0 }]);
    });
  });

  describe("what a press may name", () => {
    const refused = async (body: unknown, user = me) => {
      const answer = await post(body, user);
      expect(s.judged).toHaveLength(0);
      expect(s.cdn).toHaveLength(0);
      expect(await rows()).toEqual([]);
      return answer;
    };
    it("a picture the list did not name", async () => {
      const { id, proof } = await tile();
      expect((await refused({ id, image: "https://evil.test/other.png", proof })).status).toBe(403);
    });
    it("an NFT the list did not name", async () => {
      const { image, proof } = await tile();
      expect((await refused({ id: `${ASSET}x`, image, proof })).status).toBe(403);
    });
    it("no proof, a made-up one, or another account's", async () => {
      const { id, image, proof } = await tile();
      expect((await refused({ id, image })).status).toBe(403);
      expect((await refused({ id, image, proof: `${Date.now() + 9999}.${WALLET}.${"A".repeat(43)}` })).status).toBe(403);
      const other = await newUser();
      expect((await refused({ id, image, proof }, other)).status).toBe(403);
    });
    it("a proof a day old", async () => {
      const { id, image } = await tile();
      const proof = signNftProof(me, WALLET, id, image, Date.now() - 24 * 60 * 60_000 - 1);
      const answer = await refused({ id, image, proof });
      expect(answer.status).toBe(403);
      expect(answer.error).toMatch(/out of date/);
    });
    it("a wallet this account has let go of, even with a good proof", async () => {
      const { id, image, proof } = await tile();
      await db.query("update public.user_wallets set removed_at = now() where user_id = $1", [me]);
      const answer = await refused({ id, image, proof });
      expect(answer.status).toBe(403);
      expect(answer.error).toMatch(/not in a wallet/);
    });
    it("a linked wallet counts", async () => {
      const user = await newUser(OTHER);
      await db.query("delete from public.user_wallets where user_id = $1", [user]);
      await db.query("insert into public.linked_wallets (user_id, address) values ($1, $2)", [user, OTHER]);
      const [{ id, image, proof }] = await askList(user);
      expect(proof).toContain(OTHER);
      expect((await post({ id, image, proof }, user)).status).toBe(200);
    });
    it("each proof names the wallet the index read that NFT in", async () => {
      await db.query("insert into public.linked_wallets (user_id, address) values ($1, $2)", [me, OTHER]);
      const listed = await askList();
      expect(listed.map((x) => x.proof.split(".")[1])).toEqual([WALLET, OTHER]);
    });
    it("what the picture route refuses, or no id", async () => {
      const { id, proof } = await tile();
      expect((await refused({ id, image: "file:///etc/passwd", proof })).status).toBe(400);
      expect((await refused({ image: IMAGE, proof })).status).toBe(400);
      expect((await refused(null)).status).toBe(400);
    });
    it("without AUTH_PEPPER the list signs nothing, and a press asks nothing", async () => {
      vi.stubEnv("AUTH_PEPPER", "");
      const { id, image, proof } = await tile();
      expect(proof).toBeNull();
      expect((await refused({ id, image, proof })).status).toBe(403);
    });
  });

  describe("before SQL 65 has run", () => {
    beforeAll(async () => { await db.exec("ALTER TABLE public.nft_checks RENAME TO nft_checks_away"); });
    afterAll(async () => { await db.exec("ALTER TABLE public.nft_checks_away RENAME TO nft_checks"); });
    // The rows helper reads the table too: this block counts on the stubs alone.
    it("the read says which file to run, and nothing crashes", async () => {
      expect(await saved()).toMatchObject({ status: 503, error: NFT_CHECK_NOT_READY, run: "65-nft-checks.sql" });
      expect(NFT_CHECK_NOT_READY).toContain("sql-to-run/65-nft-checks.sql");
    });
    it("a press says the same and judges nothing", async () => {
      expect(await check()).toMatchObject({ status: 503, error: NFT_CHECK_NOT_READY });
      expect(s.judged).toHaveLength(0);
      expect(s.cdn).toHaveLength(0);
    });
  });
});
