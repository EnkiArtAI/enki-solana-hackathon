import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import { NextRequest } from "next/server";
import { resetKeyringCache } from "@/lib/crypto";
import { REFERENCES_OFF } from "@/lib/prompt-references";
import { JOB_WHY, VIDEO_CONSENT_REFUSED } from "@/lib/video/job-view";
import { MAX_RUNNING } from "@/lib/video/ready";
import { ARTIST, OPEN, PREMIUM, USER, WALLET, paidUnit, setOperator, videoDb, type VideoDb } from "./_video-db";

/**
 * The routes on PGlite with the real SQL: POST /api/video/intent, POST and GET /api/video/jobs, GET /api/video/jobs/[id] and the
 * cron. With no operator set, the API ships and reaches nothing: 0 calls off the database, whichever keys are set, and no intent
 * row. The control sets the operator and counts the real BytePlus file's one call to a recorder, so the counter can fail. Session,
 * step-up, the chain and the judges are stubbed. Blind spot: every operator answer is invented from its docs; no wallet was driven.
 */
const r = vi.hoisted(() => ({
  client: null as unknown,
  user: "00000000-0000-4000-8000-0000000000aa" as string | null,
  rail: "intent" as string,
  stepUp: null as unknown,
  stableFails: null as unknown,
  railAsked: 0,
  covers: { ok: true } as unknown,
  voids: [] as Array<[string, string, unknown]>,
  check: { verdict: "clear" } as unknown,
  moderation: { allowed: true } as unknown,
  again: { allowed: true } as unknown,
  picture: { verdict: "clear" } as unknown,
  first: null as unknown,
  warned: [] as unknown[],
  cases: [] as unknown[],
  refused: [] as unknown[],
  judged: [] as unknown[],
  moderated: [] as string[],
  pictures: 0,
  hold: null as null | Promise<void>,
  reserve: vi.fn(),
  release: vi.fn(),
  fits: vi.fn(),
}));
vi.mock("@/lib/generation/spend-cap", async (original) => ({
  ...(await original<typeof import("@/lib/generation/spend-cap")>()),
  reserveSpend: (...a: unknown[]) => r.reserve(...a), releaseSpend: (...a: unknown[]) => r.release(...a), spendFits: (...a: unknown[]) => r.fits(...a),
}));
vi.mock("next/server", async (original) => ({ ...(await original<typeof import("next/server")>()), after: () => {} }));
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => r.client, getSupabaseServerClientSafe: () => r.client }));
vi.mock("@/lib/auth", () => ({
  requireAuth: async () => { if (!r.user) throw new Error("no session"); return { userId: r.user, walletAddress: "BuyerWa11etAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }; },
  authRefusal: () => new Response(JSON.stringify({ error: "Not signed in" }), { status: 401 }),
  checkRateLimit: () => true,
}));
vi.mock("@/lib/session-user", async (original) => ({
  ...(await original<typeof import("@/lib/session-user")>()),
  resolveSessionUserId: async () => r.user,
  resolveOwnerIds: async () => (r.user ? [r.user] : null),
}));
// Its lazy import of session-user races vitest's mock when five presses reach it at once, and reads the real one.
vi.mock("@/lib/generation/record", async (original) => ({ ...(await original<typeof import("@/lib/generation/record")>()), resolveRecordingUserId: async () => r.user }));
vi.mock("@/lib/webauthn", () => ({ requireActionStepUp: async () => r.stepUp, resolveStableUserId: async () => { if (r.stableFails) throw r.stableFails; return r.user; } }));
vi.mock("@/lib/payments/rail", async (original) => ({ ...(await original<typeof import("@/lib/payments/rail")>()), paymentRail: async () => { r.railAsked++; return r.rail; } }));
vi.mock("@/lib/payments/authorize-flow", async (original) => ({ ...(await original<typeof import("@/lib/payments/authorize-flow")>()), buyerCovers: async () => r.covers }));
vi.mock("@/lib/payments/solana", async (original) => ({ ...(await original<typeof import("@/lib/payments/solana")>()), solanaConnection: () => ({}) }));
vi.mock("@/lib/payments/settle", () => ({
  captureHeld: async () => ({ kind: "lost" }),
  voidAndFlush: async (_db: unknown, unit: string, reason: string, o: unknown) => { r.voids.push([unit, reason, o]); return true; },
}));
vi.mock("@/lib/moderation", () => ({
  moderate: async ({ prompt }: { prompt: string }) => { r.moderated.push(prompt); return r.moderated.length > 1 ? r.again : r.moderation; },
  screenFirst: () => r.first,
  CLIENT_BLOCK_MESSAGE: "blocked",
}));
vi.mock("@/lib/moderation-enforcement", () => ({ recordModerationEvent: async () => {}, childSafetyScore: (v: { minors?: number }) => v.minors ?? null }));
vi.mock("@/lib/moderation/warnings", () => ({ recordWarning: async (_d: unknown, c: unknown) => { r.warned.push(c); return {}; }, warningMessage: (c: string) => `warned ${c}` }));
vi.mock("@/lib/moderation/prompt-check", async (original) => ({
  ...(await original<typeof import("@/lib/moderation/prompt-check")>()),
  checkPrompt: async (inputs: unknown) => { r.judged.push(inputs); await r.hold; return r.check; },
}));
vi.mock("@/lib/moderation/extraction-hits", () => ({ recordExtractionHit: async () => {}, silentFailure: async () => new Response("{}", { status: 500 }) }));
vi.mock("@/lib/moderation/image-check-bytes", async (original) => ({ ...(await original<typeof import("@/lib/moderation/image-check-bytes")>()), checkImageBytes: async () => { r.pictures++; return r.picture; } }));
vi.mock("@/lib/moderation/image-case", () => ({ recordImageCase: async (_d: unknown, c: unknown) => { r.cases.push(c); } }));
vi.mock("@/lib/moderation/prompt-pause", () => ({ PROMPT_UNAVAILABLE: "This prompt is not available.", letteringReleased: async () => false, refusePrompt: async (_d: unknown, c: unknown) => { r.refused.push(c); return true; } }));
vi.mock("@/lib/admin-notify", () => ({ notifyAdmins: async () => {} }));

import { POST as intentRoute } from "../../../app/api/video/intent/route";
import { GET as jobsList, POST as jobsRoute } from "../../../app/api/video/jobs/route";
import { GET as oneJob } from "../../../app/api/video/jobs/[id]/route";
import { GET as cron } from "../../../app/api/cron/video-jobs/route";

const TASKS = "https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks";
const SETTINGS = { seconds: 4, aspect: "16:9", resolution: "480p", audio: true, bitrate: "high" };
const ASK = { modelId: "seedance-2.5", settings: SETTINGS };
let address = 0;
const request = (path: string, body?: unknown, headers: Record<string, string> = {}) => new NextRequest(`http://enki.test${path}`, {
  method: body === undefined ? "GET" : "POST",
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  headers: { "x-real-ip": `10.9.${++address >> 8}.${address & 255}`, "X-Session-Token": "t", ...headers },
});
const answer = async (res: Response) => ({ status: res.status, body: await res.json() as Record<string, never> });
const postIntent = (body: unknown = ASK) => intentRoute(request("/api/video/intent", body)).then(answer);
const postJob = (body: unknown) => jobsRoute(request("/api/video/jobs", body)).then(answer);

let host: ReturnType<typeof vi.fn>;
/** Calls that left the database: the recorder is all of fetch. */
const offDb = () => host.mock.calls.length;

beforeAll(() => {
  process.env.FIELD_ENCRYPTION_KEY_B64 = crypto.randomBytes(32).toString("base64");
  resetKeyringCache();
});
beforeEach(() => {
  Object.assign(r, { user: USER, rail: "intent", stepUp: null, stableFails: null, railAsked: 0, covers: { ok: true }, voids: [], check: { verdict: "clear" }, moderation: { allowed: true }, again: { allowed: true }, picture: { verdict: "clear" }, first: null, warned: [], cases: [], refused: [], judged: [], moderated: [], pictures: 0, hold: null });
  r.reserve.mockReset().mockImplementation(async (_db: unknown, micro: number) => ({ ok: true, day: "2026-11-04", micro }));
  r.release.mockReset().mockResolvedValue(undefined);
  r.fits.mockReset().mockImplementation(async (_db: unknown, micro: number) => ({ ok: true, day: "2026-11-04", micro }));
  host = vi.fn(async () => new Response(JSON.stringify({ id: "task-1" }), { status: 200 }));
  vi.stubGlobal("fetch", host);
  // Every key that could reach a host, set: none may be read on this path but the operator's own.
  vi.stubEnv("GEMINI_API_KEY", "set");
  vi.stubEnv("WAVESPEED_API_KEY", "set");
  vi.stubEnv("OPENAI_API_KEY", "set");
  vi.stubEnv("ARK_API_KEY", "stub-ark");
  vi.stubEnv("AUTH_PEPPER", "pepper");
  vi.stubEnv("CRON_SECRET", "cron");
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("with no operator, nothing reaches a host", () => {
  let v: VideoDb;
  const intents = async () => (await v.db.query<{ n: number }>("select count(*)::int as n from public.generation_payment_intents")).rows[0].n;
  beforeAll(async () => { v = await videoDb(); r.client = v.client; }, 60_000);
  afterAll(async () => { await v.close(); });
  beforeEach(() => { r.client = v.client; });

  it("the intent says Not available yet, writes no row, asks no rail, no second factor", async () => {
    r.stepUp = new Response("{}", { status: 401 });
    expect(await postIntent()).toEqual({ status: 503, body: { error: "Not available yet." } });
    expect([await intents(), offDb(), r.railAsked]).toEqual([0, 0, 0]);
  });

  it("a paid unit's job is voided as Enki's and reaches nothing", async () => {
    const unit = await paidUnit(v.db);
    expect(await postJob({ intentId: unit, words: "rain" })).toEqual({ status: 503, body: { error: "Not available yet." } });
    expect(r.voids).toEqual([[unit, "provider_failed", { unclaimed: true }]]);
    expect(offDb()).toBe(0);
    expect((await v.db.query("select 1 from public.video_jobs")).rows).toEqual([]);
    expect(r.judged).toEqual([]);
  });

  it("the cron asks nothing", async () => {
    const res = await cron(request("/api/cron/video-jobs", undefined, { authorization: "Bearer cron" }));
    expect(await res.json()).toEqual({ due: 0, delivered: 0 });
    expect(offDb()).toBe(0);
  });

  it("the cron's door: no secret, no run", async () => {
    expect((await cron(request("/api/cron/video-jobs"))).status).toBe(401);
    vi.stubEnv("CRON_SECRET", "");
    expect((await cron(request("/api/cron/video-jobs", undefined, { authorization: "Bearer cron" }))).status).toBe(503);
  });
});

describe("before the files", () => {
  const each = [
    { files: ["2026-11-03-video-models.sql"], says: "Video prices need sql-to-run/68-video-routes.sql." },
  ];
  it.each(each)("names $says", async ({ says }) => {
    const v = await videoDb(["2026-11-03-video-prompts.sql", "2026-11-03-video-models.sql"]);
    r.client = v.client;
    expect(await postIntent()).toEqual({ status: 503, body: { error: says } });
    await v.close();
  }, 60_000);

  it("with an operator but no SQL 69 or 70, or no buckets, it names the file and writes nothing", async () => {
    const base = ["2026-11-03-video-prompts.sql", "2026-11-03-video-models.sql", "2026-11-03-video-routes.sql"];
    const no69 = await videoDb([...base, "2026-11-03-intent-hold.sql"]);
    await setOperator(no69.db, "Seedance 2.5", "byteplus");
    r.client = no69.client;
    expect(await postIntent()).toMatchObject({ status: 503, body: { run: "69-video-jobs.sql" } });
    await no69.close();

    const no70 = await videoDb([...base, "2026-11-03-video-jobs.sql"]);
    await setOperator(no70.db, "Seedance 2.5", "byteplus");
    r.client = no70.client;
    expect(await postIntent()).toMatchObject({ status: 503, body: { run: "70-intent-hold.sql" } });
    await no70.close();

    const noBucket = await videoDb();
    await setOperator(noBucket.db, "Seedance 2.5", "byteplus");
    (noBucket.client as unknown as { storage: { getBucket: unknown } }).storage.getBucket = async () => ({ data: null, error: { message: "Bucket not found" } });
    r.client = noBucket.client;
    expect(await postIntent()).toMatchObject({ status: 503, body: { run: "66-video-storage.sql" } });
    expect((await noBucket.db.query("select 1 from public.generation_payment_intents")).rows).toEqual([]);
    await noBucket.close();
    expect(offDb()).toBe(0);
  }, 90_000);
});

describe("with the operator set", () => {
  let v: VideoDb;
  const row = async (id: string) => (await v.db.query<Record<string, unknown>>("select * from public.generation_payment_intents where id = $1", [id])).rows[0];
  const jobOf = async (unit: string) => (await v.db.query<Record<string, unknown>>("select * from public.video_jobs where intent_id = $1", [unit])).rows[0];
  const reference = async (user = USER) => {
    const path = `${user}/${crypto.randomUUID()}.png`;
    v.storage.log.files.set(path, Buffer.from("picture"));
    return (await v.db.query<{ id: string }>("insert into public.reference_uploads (user_id, path, content_hash) values ($1, $2, $3) returning id", [user, path, path])).rows[0].id;
  };
  beforeAll(async () => {
    v = await videoDb();
    await setOperator(v.db, "Seedance 2.5", "byteplus");
    await setOperator(v.db, "Wan 3.0", "byteplus");
  }, 60_000);
  afterAll(async () => { await v.close(); });
  beforeEach(async () => {
    r.client = v.client;
    await v.db.exec("update public.video_jobs set status = 'failed'");
  });

  describe("the intent", () => {
    it("writes one row with the quote's split and the settings the job will run, reaching no host", async () => {
      const { status, body } = await postIntent();
      expect(status).toBe(200);
      const intent = body.intent as { id: string; breakdown: { totalAmount: string }; settings: object };
      expect(intent.breakdown.totalAmount).toBe("450000");
      expect(await row(intent.id)).toMatchObject({
        buyer_wallet: WALLET, model_family: "Seedance 2.5", resolution: "480p", boost: false, status: "quoted", total_micro: 450000, model_cost_micro: 411200, enki_fee_micro: 38800, artist_amount_micro: 0,
        video_settings: { modelId: "seedance-2.5", ...SETTINGS }, hold_until: null,
      });
      expect(offDb()).toBe(0);
    });

    it("a premium prompt adds its artist: the row is what the chip shows", async () => {
      const { body } = await postIntent({ ...ASK, promptId: PREMIUM });
      const intent = body.intent as { id: string };
      expect(await row(intent.id)).toMatchObject({ prompt_id: PREMIUM, artist_amount_micro: 400000, total_micro: 450000 + 400000 + 40000, artist_wallet: "ArtistWa11etAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" });
    });

    it("a rate that rounds to no cent opens nothing, with an operator set: no intent at $0", async () => {
      const seedance = "(select id from public.models where name = 'Seedance 2.5')";
      const stored = (await v.db.query<{ cost: object }>(`select cost from public.video_routes where model_id = ${seedance}`)).rows[0].cost;
      await v.db.query(`update public.video_routes set cost = $1 where model_id = ${seedance}`, [JSON.stringify({ "480p": 1 })]);
      const count = async () => (await v.db.query("select 1 from public.generation_payment_intents")).rows.length;
      const before = await count();
      expect((await postIntent()).status).toBe(422);
      expect(await count()).toBe(before);
      await v.db.query(`update public.video_routes set cost = $1 where model_id = ${seedance}`, [JSON.stringify(stored)]);
    });

    it("the escrow rail makes video not available: a deposit moves money before the render", async () => {
      r.rail = "escrow";
      expect(await postIntent()).toEqual({ status: 503, body: { error: "Not available yet." } });
    });

    it("a clip's seconds are not taken yet; a count is no field", async () => {
      expect((await postIntent({ ...ASK, clipTenths: 40 })).status).toBe(400);
      expect((await postIntent({ ...ASK, count: 2 })).status).toBe(400);
    });

    it("the second factor is asked, and its refusal writes nothing", async () => {
      const before = (await v.db.query("select 1 from public.generation_payment_intents")).rows.length;
      r.stepUp = new Response(JSON.stringify({ stepUp: true }), { status: 401 });
      expect((await postIntent()).status).toBe(401);
      expect((await v.db.query("select 1 from public.generation_payment_intents")).rows.length).toBe(before);
    });

    it("an account that cannot be read is a refusal that writes nothing", async () => {
      const before = (await v.db.query("select 1 from public.generation_payment_intents")).rows.length;
      r.stableFails = { message: "TypeError: fetch failed" };
      expect((await postIntent()).status).toBe(503);
      r.stableFails = { code: "XX000", message: "boom" };
      await expect(postIntent()).rejects.toMatchObject({ code: "XX000" });
      expect((await v.db.query("select 1 from public.generation_payment_intents")).rows.length).toBe(before);
    });

    it("three under way: refused before anything is written", async () => {
      for (let i = 0; i < 3; i++) {
        const unit = await paidUnit(v.db);
        await postJob({ intentId: unit, words: "rain" });
      }
      const before = (await v.db.query("select 1 from public.generation_payment_intents")).rows.length;
      const { status, body } = await postIntent();
      expect(status).toBe(429);
      expect(body.error).toContain("3 videos in the making");
      expect((await v.db.query("select 1 from public.generation_payment_intents")).rows.length).toBe(before);
    });
  });

  describe("the job", () => {
    it("exactly one call to the operator, with the hash and the stored settings, never the body's; held, claimed, sealed", async () => {
      const unit = await paidUnit(v.db);
      const { status, body } = await postJob({ intentId: unit, words: "rain starts" });
      expect(status).toBe(200);
      expect(host).toHaveBeenCalledTimes(1);
      const [url, init] = host.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(TASKS);
      const sent = JSON.parse(String(init.body));
      const hash = crypto.createHmac("sha256", "pepper").update(USER).digest("hex");
      expect(sent).toEqual({ model: "stub-model", content: [{ type: "text", text: "rain starts" }], resolution: "480p", ratio: "16:9", duration: 4, generate_audio: true, watermark: false, safety_identifier: hash });

      const job = await jobOf(unit);
      expect(job).toMatchObject({ id: (body.job as { id: string }).id, status: "running", provider_task_id: "task-1", operator: "byteplus", provider_model: "stub-model", end_user_hash: hash, consent: false, user_id: USER, attempt_count: 0 });
      expect(String(job.words_ct)).not.toContain("rain");
      const intent = await row(unit);
      expect(intent.consumed_at).toBeTruthy();
      const hold = new Date(String(intent.hold_until)).getTime() - new Date(String(intent.consumed_at)).getTime();
      expect(hold / 60_000).toBeGreaterThan(50);
      expect(hold / 60_000).toBeLessThan(60);
      expect(intent.captured_at).toBeNull();
      expect(r.voids).toEqual([]);
    });

    it("a second press on one payment reaches nothing", async () => {
      const unit = await paidUnit(v.db);
      await postJob({ intentId: unit, words: "rain" });
      host.mockClear();
      const { status, body } = await postJob({ intentId: unit, words: "rain" });
      expect([status, body.error]).toEqual([409, "Payment intent already used"]);
      expect(offDb()).toBe(0);
    });

    it.each([
      ["voided", "voided_at = now(), status = 'voided'", "Payment intent was cancelled"],
      ["claimed", "consumed_at = now()", "Payment intent already used"],
      ["captured", "captured_at = now()", "Payment intent already used"],
    ])("a %s unit judges nothing: no words, no picture, no tier, no operator, however often it is asked", async (_, spent, says) => {
      const unit = await paidUnit(v.db);
      await v.db.query(`update public.generation_payment_intents set ${spent} where id = $1`, [unit]);
      const refs = [await reference(), await reference()];
      for (let i = 0; i < 3; i++) expect(await postJob({ intentId: unit, words: "rain", refs, consent: true })).toEqual({ status: 409, body: { error: says } });
      expect([r.judged, r.pictures, r.moderated, r.voids, offDb()]).toEqual([[], 0, [], [], 0]);
    });

    describe("a prompt whose creator switched buyers' references off (SQL 62)", () => {
      beforeAll(async () => { await v.db.exec(`alter table public.prompts add column allow_references boolean default true; update public.prompts set allow_references = false where id = '${PREMIUM}'`); });
      afterAll(async () => { await v.db.exec("alter table public.prompts drop column allow_references"); });
      const press = async (body: object, settings?: object) => {
        const unit = await paidUnit(v.db, { promptId: PREMIUM, artist: 400000, settings });
        return { unit, answer: await postJob({ intentId: unit, variableValues: { city: "Rome" }, consent: true, ...body }) };
      };

      it("refuses a buyer's reference and a buyer's frame, void and unclaimed, the artist's words going nowhere", async () => {
        const { unit, answer } = await press({ refs: [await reference()] });
        expect(answer).toEqual({ status: 422, body: { error: `${REFERENCES_OFF} Nothing was charged.` } });
        expect(r.voids).toEqual([[unit, "provider_failed", { unclaimed: true }]]);
        expect((await press({ frames: { start: await reference() } }, { ...SETTINGS, modelId: "wan-3.0" })).answer).toEqual(answer);
        expect([offDb(), r.judged, r.pictures]).toEqual([0, [], 0]);
      });

      it("a job with no picture still runs", async () => {
        expect((await press({})).answer.status).toBe(200);
      });

      it("its creator's own render is as ever", async () => {
        r.user = ARTIST;
        const { answer } = await press({ refs: [await reference(ARTIST)] });
        expect(answer.status).toBe(200);
        await v.db.query("delete from public.video_jobs where user_id = $1", [ARTIST]);
      });

      it("another prompt's switch is not this prompt's", async () => {
        const unit = await paidUnit(v.db, { promptId: OPEN });
        expect((await postJob({ intentId: unit, words: "rain", refs: [await reference()], consent: true })).status).toBe(200);
      });
    });

    it("presses at once on separate payments: the running cap holds, however they interleave, and a refused one is voided", async () => {
      let go = () => {};
      r.hold = new Promise((resolve) => { go = resolve; });
      const units = await Promise.all([1, 2, 3, 4, 5].map(() => paidUnit(v.db)));
      const presses = Promise.all(units.map((intentId) => postJob({ intentId, words: "rain" })));
      // All five past the cap's read, none written yet.
      await vi.waitFor(() => expect(r.judged).toHaveLength(5), { timeout: 20_000 });
      go();
      const answers = await presses;
      expect(offDb()).toBeLessThanOrEqual(MAX_RUNNING);
      expect(answers.filter((a) => a.status === 200)).toHaveLength(offDb());
      const { rows } = await v.db.query<{ status: string; error_class: string | null }>("select status, error_class from public.video_jobs where status in ('running', 'submitting', 'failed') and intent_id = any($1)", [units]);
      expect(rows.filter((j) => j.status === "running")).toHaveLength(offDb());
      expect(rows.filter((j) => j.status === "submitting")).toEqual([]);
      for (const a of answers.filter((x) => x.status !== 200)) expect(a).toEqual({ status: 429, body: { error: "You have 3 videos in the making. Wait for one to finish. Nothing was charged." } });
      expect(r.voids).toHaveLength(5 - offDb());
      expect(r.voids.every(([, reason, o]) => reason === "cancelled" && o === undefined)).toBe(true);
    }, 30_000);

    it("the cap's own last place still goes", async () => {
      for (let i = 0; i < MAX_RUNNING - 1; i++) expect((await postJob({ intentId: await paidUnit(v.db), words: "rain" })).status).toBe(200);
      expect((await postJob({ intentId: await paidUnit(v.db), words: "rain" })).status).toBe(200);
      expect(offDb()).toBe(MAX_RUNNING);
    });

    it.each([
      ["five bounced captures", "capture_failed", 5],
      ["thirteen dropped units", "rejected", 13],
    ])("%s pause a signed unit too, before any judge", async (_, reason, n) => {
      const others = await Promise.all(Array.from({ length: n }, () => paidUnit(v.db)));
      await v.db.query("update public.generation_payment_intents set voided_at = now(), void_reason = $1, status = 'voided', buyer_wallet = $2 where id = any($3)", [reason, "BuyerWa11etAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", others]);
      const unit = await paidUnit(v.db);
      expect(await postJob({ intentId: unit, words: "rain" })).toEqual({ status: 429, body: { error: "Paying is paused for now: earlier payments did not go through. Nothing was charged." } });
      // Enki's reason, which neither pause counts: a press while paused does not lengthen the pause.
      expect(r.voids).toEqual([[unit, "provider_failed", { unclaimed: true }]]);
      expect([offDb(), r.judged]).toEqual([0, []]);
      await v.db.query("update public.generation_payment_intents set void_reason = 'provider_failed' where id = any($1)", [others]);
      expect((await postJob({ intentId: await paidUnit(v.db), words: "rain" })).status).toBe(200);
    });

    it("the key gone with a job under way: the cron asks no metered host, the job waits, and its deadline still ends it", async () => {
      const unit = await paidUnit(v.db);
      await postJob({ intentId: unit, words: "rain" });
      const ask = () => cron(request("/api/cron/video-jobs", undefined, { authorization: "Bearer cron" }));
      for (const key of ["", " "]) {
        host.mockClear();
        vi.stubEnv("ARK_API_KEY", key.trim());
        expect(await (await ask()).json()).toEqual({ due: 1, delivered: 0 });
        expect(offDb()).toBe(0);
        expect(await jobOf(unit)).toMatchObject({ status: "running", locked_until: null });
      }
      expect(r.voids).toEqual([]);
      // The control: with its key the same job is asked about.
      vi.stubEnv("ARK_API_KEY", "stub-ark");
      host.mockImplementation(async () => new Response(JSON.stringify({ status: "running" }), { status: 200 }));
      await ask();
      expect(offDb()).toBe(1);
      host.mockClear();
      vi.stubEnv("ARK_API_KEY", "");
      await v.db.query("update public.video_jobs set created_at = now() - interval '41 minutes' where intent_id = $1", [unit]);
      await ask();
      expect(offDb()).toBe(0);
      expect(await jobOf(unit)).toMatchObject({ status: "failed", error_class: "failed" });
      expect(r.voids).toEqual([[unit, "provider_failed", undefined]]);
    });

    it("someone else's unit reads as none", async () => {
      const unit = await paidUnit(v.db);
      await v.db.query("update public.generation_payment_intents set buyer_wallet = 'other' where id = $1", [unit]);
      expect(await postJob({ intentId: unit, words: "rain" })).toEqual({ status: 404, body: { error: "This video request was not found." } });
      expect(r.judged).toEqual([]);
      expect(offDb()).toBe(0);
    });

    it("a unit of another's batch is not paid for here: a video is one unit, its own batch", async () => {
      const unit = await paidUnit(v.db);
      const other = await paidUnit(v.db);
      await v.db.query("update public.generation_payment_intents set batch_intent_id = $2 where id = $1", [unit, other]);
      expect(await postJob({ intentId: unit, words: "rain" })).toEqual({ status: 402, body: { error: "This video has not been paid for yet." } });
      expect([r.judged, offDb()]).toEqual([[], 0]);
    });

    it("an unsigned unit is not paid for", async () => {
      const unit = await paidUnit(v.db);
      await v.db.query("update public.generation_payment_intents set authorized_at = null where id = $1", [unit]);
      expect(await postJob({ intentId: unit, words: "rain" })).toEqual({ status: 402, body: { error: "This video has not been paid for yet." } });
      expect(r.judged).toEqual([]);
      expect(r.voids).toEqual([]);
    });

    it("no words: refused, voided, nothing sent", async () => {
      const unit = await paidUnit(v.db);
      expect((await postJob({ intentId: unit, words: "  " })).status).toBe(400);
      expect(r.voids).toEqual([[unit, "rejected", { unclaimed: true }]]);
      expect(offDb()).toBe(0);
    });

    it("a premium prompt runs the artist's words filled on the server; the buyer's text is ignored, only their values are judged", async () => {
      const unit = await paidUnit(v.db, { promptId: PREMIUM, artist: 400000 });
      const { status } = await postJob({ intentId: unit, words: "ignored", variableValues: { city: "Rome" } });
      expect(status).toBe(200);
      const sent = JSON.parse(String((host.mock.calls[0] as [string, RequestInit])[1].body));
      expect(sent.content[0].text).toBe("secret words over Rome");
      expect(JSON.stringify(r.judged)).not.toContain("secret");
      expect(JSON.stringify(r.judged)).toContain("Rome");
    });

    it("a free prompt's marked 18+ needs a confirmed adult", async () => {
      await v.db.exec(`update public.prompts set is_adult = true where id = '${OPEN}'`);
      const unit = await paidUnit(v.db, { promptId: OPEN });
      expect((await postJob({ intentId: unit, words: "rain" })).status).toBe(403);
      expect(r.voids).toEqual([[unit, "rejected", { unclaimed: true }]]);
      expect(offDb()).toBe(0);
      await v.db.exec(`update public.users set adult_confirmed_at = now() where id = '${USER}'`);
      const next = await paidUnit(v.db, { promptId: OPEN });
      expect((await postJob({ intentId: next, words: "rain" })).status).toBe(200);
      expect(await jobOf(next)).toMatchObject({ settings: { adult: true } });
      await v.db.exec(`update public.prompts set is_adult = false where id = '${OPEN}'; update public.users set adult_confirmed_at = null where id = '${USER}'`);
    });

    it("the prompt check's sexual verdict warns, and voids", async () => {
      r.check = { verdict: "explicit_sexual", confidence: 0.9 };
      const unit = await paidUnit(v.db);
      const { status, body } = await postJob({ intentId: unit, words: "x" });
      expect([status, body.error]).toEqual([422, "warned explicit_sexual"]);
      expect(r.warned).toHaveLength(1);
      expect(r.voids).toEqual([[unit, "rejected", { unclaimed: true }]]);
      expect(offDb()).toBe(0);
    });

    it("an extraction attempt and a check that is down read as any failed video", async () => {
      r.check = { verdict: "extraction", confidence: 0.9 };
      const a = await paidUnit(v.db);
      expect(await postJob({ intentId: a, words: "x" })).toEqual({ status: 500, body: { error: JOB_WHY.failed } });
      expect(r.voids.at(-1)).toEqual([a, "rejected", { unclaimed: true }]);
      r.check = { verdict: "unavailable", reason: "not configured" };
      const b = await paidUnit(v.db);
      expect(await postJob({ intentId: b, words: "x" })).toEqual({ status: 500, body: { error: JOB_WHY.failed } });
      expect(r.voids.at(-1)).toEqual([b, "provider_failed", { unclaimed: true }]);
      expect(offDb()).toBe(0);
    });

    it("moderation refuses the buyer's words: the plain sentence, voided as theirs", async () => {
      r.moderation = { allowed: false };
      const unit = await paidUnit(v.db);
      expect(await postJob({ intentId: unit, words: "x" })).toEqual({ status: 422, body: { error: "blocked" } });
      expect(r.voids).toEqual([[unit, "rejected", { unclaimed: true }]]);
      expect(offDb()).toBe(0);
    });

    it("moderation refuses an artist's text with the buyer's values neutral: off sale, the unit Enki's", async () => {
      r.moderation = { allowed: false };
      r.again = { allowed: false, category: "violence" };
      const unit = await paidUnit(v.db, { promptId: PREMIUM, artist: 400000 });
      const { status } = await postJob({ intentId: unit, variableValues: { city: "Rome" } });
      expect(status).toBe(422);
      expect(r.refused).toEqual([{ promptId: PREMIUM, cause: "moderation", detail: "violence", buyerUserId: USER }]);
      expect(r.voids).toEqual([[unit, "provider_failed", { unclaimed: true }]]);
      expect(r.moderated).toHaveLength(2);
      expect(offDb()).toBe(0);
    });

    it("a wallet that no longer covers it: voided, even though it is claimed, nothing sent", async () => {
      r.covers = { ok: false, reason: "payer_usdc" };
      const unit = await paidUnit(v.db);
      expect((await postJob({ intentId: unit, words: "rain" })).status).toBe(402);
      expect(r.voids).toEqual([[unit, "unfunded", undefined]]);
      expect(offDb()).toBe(0);
    });

    describe("pictures", () => {
      it("held and no consent: no submit, no charge", async () => {
        const unit = await paidUnit(v.db);
        const pic = await reference();
        expect(await postJob({ intentId: unit, words: "rain", refs: [pic] })).toEqual({ status: 422, body: { error: VIDEO_CONSENT_REFUSED } });
        expect(offDb()).toBe(0);
        expect(r.voids).toEqual([[unit, "rejected", { unclaimed: true }]]);
        expect(await jobOf(unit)).toBeUndefined();
      });

      it("with consent: each by a one-hour link under its role, the consent logged", async () => {
        const unit = await paidUnit(v.db);
        const [a, b] = [await reference(), await reference()];
        expect((await postJob({ intentId: unit, words: "rain", refs: [a, b], consent: true })).status).toBe(200);
        const sent = JSON.parse(String((host.mock.calls[0] as [string, RequestInit])[1].body));
        expect(sent.content.slice(1).map((c: { role: string }) => c.role)).toEqual(["reference_image", "reference_image"]);
        expect(sent.content[1].image_url.url).toMatch(/^https:\/\/store\.test\/signed\/.+\.png$/);
        expect(await jobOf(unit)).toMatchObject({ consent: true, refs: [a, b] });
      });

      it("another account's picture is not read", async () => {
        const unit = await paidUnit(v.db);
        const theirs = await reference(ARTIST);
        const { status } = await postJob({ intentId: unit, words: "rain", refs: [theirs], consent: true });
        expect(status).toBe(422);
        expect(offDb()).toBe(0);
      });

      it("frames where the model takes references only are refused, a clear sentence", async () => {
        const unit = await paidUnit(v.db);
        const pic = await reference();
        const { status, body } = await postJob({ intentId: unit, words: "rain", frames: { start: pic }, consent: true });
        expect(status).toBe(422);
        expect(body.error).toContain("Seedance 2.5 does not take these pictures");
        expect(offDb()).toBe(0);
      });

      it("a picture the check refuses stops it; a child-safety one is a case", async () => {
        const unit = await paidUnit(v.db);
        r.picture = { verdict: "blocked", reason: "x" };
        expect((await postJob({ intentId: unit, words: "rain", refs: [await reference()], consent: true })).status).toBe(422);
        expect(r.voids).toEqual([[unit, "rejected", { unclaimed: true }]]);
        expect(offDb()).toBe(0);
        const again = await paidUnit(v.db);
        r.picture = { verdict: "child_safety", scores: {} };
        expect((await postJob({ intentId: again, words: "rain", refs: [await reference()], consent: true })).status).toBe(422);
        expect(r.cases).toHaveLength(1);
        expect(r.cases[0]).toMatchObject({ surface: "generate-video", account: USER });
        expect(offDb()).toBe(0);
      });

      it("a picture that cannot be judged: nothing sent, the buyer told to try again", async () => {
        const unit = await paidUnit(v.db);
        r.picture = { verdict: "unavailable", reason: "not configured" };
        expect((await postJob({ intentId: unit, words: "rain", refs: [await reference()], consent: true })).status).toBe(503);
        expect(r.voids).toEqual([[unit, "provider_failed", { unclaimed: true }]]);
        expect(offDb()).toBe(0);
      });
    });

    describe("the operator's answer", () => {
      it("a real face refused at the door: one sentence, voided, not billed", async () => {
        host.mockImplementation(async () => new Response(JSON.stringify({ error: { code: "InputImageSensitiveContentDetected.PrivacyInformation" } }), { status: 400 }));
        const unit = await paidUnit(v.db);
        const { status, body } = await postJob({ intentId: unit, words: "rain" });
        expect([status, body.error]).toEqual([422, JOB_WHY.real_person]);
        expect(r.voids).toEqual([[unit, "rejected", undefined]]);
        expect(await jobOf(unit)).toMatchObject({ status: "refused", error_class: "real_person", provider_code: "InputImageSensitiveContentDetected.PrivacyInformation" });
      });

      it("any other failure: voided as Enki's, asked once only", async () => {
        host.mockImplementation(async () => new Response(JSON.stringify({ error: { code: "InternalError" } }), { status: 500 }));
        const unit = await paidUnit(v.db);
        expect(await postJob({ intentId: unit, words: "rain" })).toEqual({ status: 502, body: { error: JOB_WHY.failed } });
        expect(host).toHaveBeenCalledTimes(1);
        expect(r.voids).toEqual([[unit, "provider_failed", undefined]]);
        expect(await jobOf(unit)).toMatchObject({ status: "failed", error_class: "failed" });
      });
    });

    it("the operator's row gone since the quote: voided as Enki's, nothing judged or sent", async () => {
      await v.db.exec(`update public.video_routes set operator = null, provider_model = null, rate_operator = null where model_id = (select id from public.models where name = 'Seedance 2.5')`);
      const unit = await paidUnit(v.db);
      expect(await postJob({ intentId: unit, words: "rain" })).toEqual({ status: 503, body: { error: "Not available yet." } });
      expect(r.judged).toEqual([]);
      expect(offDb()).toBe(0);
      await setOperator(v.db, "Seedance 2.5", "byteplus");
    });

    it("no pepper, no hash: nothing goes out, nothing claimed", async () => {
      vi.stubEnv("AUTH_PEPPER", "");
      const unit = await paidUnit(v.db);
      expect(await postJob({ intentId: unit, words: "rain" })).toEqual({ status: 503, body: { error: "Not available yet." } });
      expect(r.voids).toEqual([[unit, "provider_failed", { unclaimed: true }]]);
      expect((await row(unit)).consumed_at).toBeNull();
      expect(offDb()).toBe(0);
    });

    it("its key gone since the quote: not available, voided as Enki's, nothing judged", async () => {
      vi.stubEnv("ARK_API_KEY", "");
      const unit = await paidUnit(v.db);
      expect(await postJob({ intentId: unit, words: "rain" })).toEqual({ status: 503, body: { error: "Not available yet." } });
      expect(r.voids).toEqual([[unit, "provider_failed", { unclaimed: true }]]);
      expect(r.judged).toEqual([]);
      expect(offDb()).toBe(0);
    });

    it("three under way: a fourth paid unit is let go, not counted against the buyer, nothing sent", async () => {
      for (let i = 0; i < 3; i++) expect((await postJob({ intentId: await paidUnit(v.db), words: "rain" })).status).toBe(200);
      host.mockClear();
      r.voids = [];
      const unit = await paidUnit(v.db);
      const { status, body } = await postJob({ intentId: unit, words: "rain" });
      expect(status).toBe(429);
      expect(body.error).toContain("3 videos in the making");
      expect(r.voids).toEqual([[unit, "cancelled", { unclaimed: true }]]);
      expect(offDb()).toBe(0);
    });
  });

  // The daily spend breaker (key-theft measures, M3). The refusals are the real module's. Blind spot: the reservation itself is a
  // stub here; its arithmetic is in lib/__tests__/spend-cap.test.ts. The operator answers come from its docs.
  describe("the daily spend breaker", () => {
    async function refusals() {
      const real = await vi.importActual<typeof import("@/lib/generation/spend-cap")>("@/lib/generation/spend-cap");
      const reached = await real.reserveSpend({ rpc: async () => ({ data: [{ allowed: false, first_refusal: false, spend_day: "2026-11-04" }], error: null }) } as never, 1);
      const unread = await real.reserveSpend(null, 1);
      if (reached.ok || unread.ok) throw new Error("the fixture was allowed");
      return { reached, unread };
    }
    const HELD = { ok: true, day: "2026-11-04", micro: 300 };
    const amounts = () => r.reserve.mock.calls.map((c) => c[1] as number);

    it.each(["reached", "unread"] as const)("a bill that does not fit (%s) is refused before anything is signed: no row is written", async (which) => {
      const refusal = (await refusals())[which];
      r.fits.mockResolvedValueOnce(refusal);
      const before = (await v.db.query<{ n: number }>("select count(*)::int as n from generation_payment_intents")).rows[0].n;
      expect(await postIntent()).toEqual({ status: 503, body: { error: refusal.error } });
      expect((await v.db.query<{ n: number }>("select count(*)::int as n from generation_payment_intents")).rows[0].n).toBe(before);
    });

    it.each(["reached", "unread"] as const)("the judges' reservation refused (%s): nothing judged, nothing claimed, no operator", async (which) => {
      const refusal = (await refusals())[which];
      r.reserve.mockResolvedValueOnce(refusal);
      const unit = await paidUnit(v.db);
      expect(await postJob({ intentId: unit, words: "rain", refs: [await reference()], consent: true })).toEqual({ status: 503, body: { error: refusal.error } });
      expect([r.judged, r.pictures, r.moderated, offDb()]).toEqual([[], 0, [], 0]);
      // Reached: closed as Enki's. Unread: stays open, so a retry can use it.
      expect(r.voids).toEqual(which === "reached" ? [[unit, "provider_failed", { unclaimed: true }]] : []);
      expect(await row(unit)).toMatchObject({ consumed_at: null, captured_at: null });
      expect(await jobOf(unit)).toBeUndefined();
    });

    it.each(["reached", "unread"] as const)("the render's reservation refused (%s): no operator, nothing captured, the unit voided, the job closed", async (which) => {
      const refusal = (await refusals())[which];
      r.reserve.mockResolvedValueOnce(HELD).mockResolvedValueOnce(refusal);
      const unit = await paidUnit(v.db);
      expect(await postJob({ intentId: unit, words: "rain" })).toEqual({ status: 503, body: { error: refusal.error } });
      expect(r.judged).toHaveLength(1);
      expect(offDb()).toBe(0);
      expect(r.voids).toEqual([[unit, "provider_failed", undefined]]);
      expect(await row(unit)).toMatchObject({ captured_at: null });
      expect(await jobOf(unit)).toMatchObject({ status: "failed", error_class: "failed", provider_task_id: null });
      expect(r.release).not.toHaveBeenCalled();
    });

    it("reserves the judges before they run and the operator's bill before it is asked, each with its own amount", async () => {
      const seen: unknown[] = [];
      r.reserve.mockImplementation(async (_d: unknown, micro: number) => { seen.push([micro, r.judged.length, offDb()]); return { ...HELD, micro }; });
      const unit = await paidUnit(v.db);
      expect((await postJob({ intentId: unit, words: "rain" })).status).toBe(200);
      expect(seen).toEqual([[300, 0, 0], [414200, 1, 0]]);
      expect(host).toHaveBeenCalledTimes(1);
      expect(r.release).not.toHaveBeenCalled();
    });

    it("each picture adds two views to the judges' allowance", async () => {
      const unit = await paidUnit(v.db);
      await postJob({ intentId: unit, words: "rain", refs: [await reference(), await reference()], consent: true });
      expect(amounts()[0]).toBe(300 * (1 + 4));
    });

    it("the regex refused and no picture: nothing was called, nothing is reserved", async () => {
      r.first = { allowed: false, category: "fixture" };
      const unit = await paidUnit(v.db);
      await postJob({ intentId: unit, words: "rain" });
      expect(r.judged).toEqual([]);
      expect(amounts()).toEqual([]);
    });

    it("the regex refused beside a picture: only its two views are reserved, they still run", async () => {
      r.first = { allowed: false, category: "fixture" };
      const unit = await paidUnit(v.db);
      await postJob({ intentId: unit, words: "rain", refs: [await reference()], consent: true });
      expect(amounts()).toEqual([600]);
      expect(r.pictures).toBe(1);
    });

    it("a row at no price reserves 0, so the SQL refuses it: the frames' views cannot pass for a price", async () => {
      const unit = await paidUnit(v.db);
      await v.db.query("update generation_payment_intents set model_cost_micro = 0 where id = $1", [unit]);
      await postJob({ intentId: unit, words: "rain" });
      expect(amounts()[1]).toBe(0);
    });

    it("an operator that refused the content gives the reservation back", async () => {
      host.mockImplementation(async () => new Response(JSON.stringify({ error: { code: "InputImageSensitiveContentDetected.PrivacyInformation" } }), { status: 400 }));
      const unit = await paidUnit(v.db);
      expect((await postJob({ intentId: unit, words: "rain" })).status).toBe(422);
      expect(r.release).toHaveBeenCalledOnce();
      expect(r.release.mock.calls[0][1]).toMatchObject({ micro: 414200 });
    });

    it("an outage may be billed: it keeps the reservation", async () => {
      host.mockImplementation(async () => new Response(JSON.stringify({ error: { code: "InternalError" } }), { status: 500 }));
      const unit = await paidUnit(v.db);
      expect((await postJob({ intentId: unit, words: "rain" })).status).toBe(502);
      expect(r.release).not.toHaveBeenCalled();
    });

    it("a dead key was answered before any work: it gives the reservation back", async () => {
      host.mockImplementation(async () => new Response(JSON.stringify({ error: { code: "AuthenticationError" } }), { status: 401 }));
      const unit = await paidUnit(v.db);
      expect((await postJob({ intentId: unit, words: "rain" })).status).toBe(502);
      expect(r.release).toHaveBeenCalledOnce();
    });

    it("a request refused silently reserves no render", async () => {
      r.check = { verdict: "extraction", confidence: 0.9 };
      const unit = await paidUnit(v.db);
      await postJob({ intentId: unit, words: "rain" });
      expect(amounts()).toEqual([300]);
      expect(offDb()).toBe(0);
    });
  });

  describe("one press, one video", () => {
    it("`count` on a job is 422, on free as on premium, and writes nothing", async () => {
      for (const promptId of [null, PREMIUM]) {
        const unit = await paidUnit(v.db, { promptId, artist: promptId ? 400000 : 0 });
        const { status, body } = await postJob({ intentId: unit, words: "rain", count: 2 });
        expect([status, body.error]).toEqual([422, "One press makes one video. Nothing was charged."]);
        expect(await jobOf(unit)).toBeUndefined();
      }
      expect(offDb()).toBe(0);
    });

    it("any other unknown field is 422 too", async () => {
      expect((await postJob({ intentId: crypto.randomUUID(), words: "rain", settings: {} })).status).toBe(422);
      expect((await postJob({ intentId: crypto.randomUUID(), words: "rain", amount: 1 })).status).toBe(422);
    });
  });

  describe("reading one's own", () => {
    it("a list and one job, the owner's alone, naming no operator, no hash, no words", async () => {
      const unit = await paidUnit(v.db);
      const { body } = await postJob({ intentId: unit, words: "secret words" });
      const id = (body.job as { id: string }).id;
      const listed = await answer(await jobsList(request("/api/video/jobs")));
      const jobs = listed.body.jobs as Array<{ id: string; status: string; label: string; settings: object }>;
      expect(jobs[0]).toMatchObject({ id, status: "running", label: "Seedance 2.5", settings: SETTINGS });
      const text = JSON.stringify(listed.body);
      expect(text).not.toMatch(/byteplus|stub-model|task-1|end_user|words|secret/);

      const one = await oneJob(request(`/api/video/jobs/${id}`), { params: Promise.resolve({ id }) });
      expect(await one.json()).toMatchObject({ job: { id, status: "running" } });

      r.user = ARTIST;
      expect((await oneJob(request(`/api/video/jobs/${id}`), { params: Promise.resolve({ id }) })).status).toBe(404);
      expect(((await answer(await jobsList(request("/api/video/jobs")))).body.jobs as unknown[])).toEqual([]);
      r.user = null;
      expect((await jobsList(request("/api/video/jobs"))).status).toBe(401);
    });

    it("?promptId= narrows the list", async () => {
      const unit = await paidUnit(v.db, { promptId: OPEN });
      await postJob({ intentId: unit, words: "rain" });
      const of = async (p: string) => ((await answer(await jobsList(request(`/api/video/jobs?promptId=${p}`)))).body.jobs as unknown[]).length;
      expect(await of(OPEN)).toBeGreaterThan(0);
      expect(await of(ARTIST)).toBe(0);
      expect(await of("not-a-uuid")).toBe(0);
    });
  });
});
