import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import { encryptString, resetKeyringCache } from "@/lib/crypto";
import { GIVE_UP_MS, MAX_ATTEMPTS, TRANSCODE_MIN_LEFT_MS, VIDEO_JOB_AAD, runVideoJobs } from "@/lib/video/jobs";
import { JOB_WHY, jobView } from "@/lib/video/job-view";
import { PREMIUM, USER, paidUnit, sealArtistText, videoDb, type VideoDb } from "./_video-db";

/**
 * Every state of a job, on PGlite with the real SQL, recordGeneration and bookingState; the operator, ffmpeg, the store's files,
 * the image check and the chain are stubbed, and each writes to `order`, so what came before what can be read. Blind spot: every
 * operator answer is invented from its docs; no real capture, no real Supabase upload; the transcode has its own test.
 */
const t = vi.hoisted(() => ({
  order: [] as string[],
  poll: null as null | ((id: string) => unknown),
  submit: 0,
  frames: [] as Array<Record<string, unknown>>,
  transcode: null as null | (() => unknown),
  capture: null as null | ((unit: string) => Promise<unknown>),
  voids: [] as Array<[string, string]>,
  cases: [] as Array<Record<string, unknown>>,
  refused: [] as Array<Record<string, unknown>>,
  void: null as null | ((unit: string, reason: string) => Promise<boolean>),
  alerts: [] as Array<{ subject: string; text: string }>,
}));
vi.mock("next/server", async (original) => ({ ...(await original<typeof import("next/server")>()), after: () => {} }));
vi.mock("@/lib/video/adapters", () => ({ VIDEO_ADAPTERS: { stub: {
  configured: () => true,
  submit: async () => { t.submit++; return { taskId: "never" }; },
  poll: async (id: string) => { t.order.push("poll"); return t.poll!(id); },
} } }));
vi.mock("@/lib/video/transcode", () => ({
  transcode: async () => { t.order.push("transcode"); return t.transcode!(); },
  removeTranscoded: async () => { t.order.push("cleanup"); },
}));
vi.mock("@/lib/moderation/image-check-bytes", async (original) => ({
  ...(await original<typeof import("@/lib/moderation/image-check-bytes")>()),
  checkImageBytes: async () => { t.order.push("check"); return t.frames.shift() ?? { verdict: "clear" }; },
}));
vi.mock("@/lib/moderation/image-case", () => ({ recordImageCase: async (_db: unknown, c: Record<string, unknown>) => { t.cases.push(c); } }));
vi.mock("@/lib/moderation/prompt-pause", () => ({
  letteringReleased: async () => false,
  refusePrompt: async (_db: unknown, r: Record<string, unknown>) => { t.refused.push(r); return true; },
  PROMPT_UNAVAILABLE: "x",
}));
vi.mock("@/lib/payments/settle", () => ({
  captureHeld: async (_db: unknown, unit: string) => { t.order.push("capture"); return t.capture!(unit); },
  voidAndFlush: async (_db: unknown, unit: string, reason: string) => { t.voids.push([unit, reason]); return t.void!(unit, reason); },
}));
vi.mock("@/lib/video/store", () => ({
  storeVideo: async () => {
    t.order.push("store");
    return { preview: "https://store.test/p.mp4", v720: "https://store.test/720.mp4", v1080: null, poster: "https://store.test/p.webp", width: 854, height: 480, durationMs: 4000, paths: ["u/p.mp4", "u/720.mp4"], v720Bytes: 123 };
  },
  removeStored: async (_db: unknown, paths: string[]) => { t.order.push(`remove:${paths.length}`); },
}));
vi.mock("@/lib/admin-notify", () => ({ notifyAdmins: async (_db: unknown, m: { subject: string; text: string }) => { t.alerts.push(m); } }));

const made = { dir: "d", frames: [Buffer.from("a"), Buffer.from("b")], info: { durationMs: 4000, width: 854, height: 480, audio: true } };
const REQ = new Request("http://enki.test/api/cron/video-jobs");
const LOTS = TRANSCODE_MIN_LEFT_MS + 200_000;

describe("video jobs", () => {
  let v: VideoDb;
  const run = (deadline = LOTS) => runVideoJobs(v.client, { request: REQ, deadlineAt: Date.now() + deadline });
  const job = async (id: string) => (await v.db.query<Record<string, never>>("select * from public.video_jobs where id = $1", [id])).rows[0] as unknown as Record<string, unknown>;
  const intent = async (id: string) => (await v.db.query<Record<string, never>>("select * from public.generation_payment_intents where id = $1", [id])).rows[0] as unknown as Record<string, unknown>;

  /** A job as POST /api/video/jobs leaves it. */
  async function add(over: { status?: string; age?: number; promptId?: string | null; settings?: object; locked?: string | null; attempts?: number; video?: object | null; task?: string | null; artist?: number } = {}) {
    const unit = await paidUnit(v.db, { promptId: over.promptId, artist: over.artist });
    const model = (await v.db.query<{ id: string }>(`select id from public.models where name = 'Seedance 2.5'`)).rows[0].id;
    const id = crypto.randomUUID();
    const sealed = encryptString(JSON.stringify({ words: "rain starts", values: { city: "Rome" } }), VIDEO_JOB_AAD(id));
    await v.db.query(
      `insert into public.video_jobs (id, user_id, intent_id, prompt_id, model_id, operator, provider_model, provider_task_id, settings, words_ct, words_iv, words_tag, words_kid, end_user_hash, status, attempt_count, locked_until, video, created_at)
       values ($1, $2, $3, $4, $5, 'stub', 'stub-model', $6, $7, $8, $9, $10, $11, 'hash', $12, $13, $14, $15, $16)`,
      [id, USER, unit, over.promptId ?? null, model, over.task === undefined ? "task-1" : over.task, JSON.stringify({ modelId: "seedance-2.5", seconds: 4, aspect: "16:9", resolution: "480p", audio: true, bitrate: "high", ...over.settings }),
        sealed.encrypted, sealed.iv, sealed.authTag, sealed.kid ?? "field-v1", over.status ?? "running", over.attempts ?? 0, over.locked ?? null, over.video ? JSON.stringify(over.video) : null, new Date(Date.now() - (over.age ?? 60_000)).toISOString()],
    );
    return { id, unit };
  }

  beforeAll(async () => {
    process.env.FIELD_ENCRYPTION_KEY_B64 = crypto.randomBytes(32).toString("base64");
    resetKeyringCache();
    v = await videoDb();
  }, 60_000);
  afterAll(async () => { await v.close(); });
  beforeEach(async () => {
    Object.assign(t, { order: [], submit: 0, frames: [], voids: [], cases: [], refused: [], alerts: [] });
    t.poll = () => ({ state: "done", url: "https://o/v.mp4", usage: { completion_tokens: 5 } });
    t.transcode = () => made;
    t.capture = async (unit) => {
      await v.db.query(`update public.generation_payment_intents set capture_started_at = now(), captured_at = now(), fulfilled_at = now(), status = 'captured', tx_signature = 'sig-1' where id = $1`, [unit]);
      return { kind: "captured", signature: "sig-1" };
    };
    t.void = async (unit, reason) => {
      await v.db.query(`update public.generation_payment_intents set voided_at = now(), void_reason = $2, status = 'voided' where id = $1`, [unit, reason]);
      return true;
    };
    // Each case starts on a table with nothing due.
    await v.db.exec(`update public.video_jobs set status = 'failed' where status in ('submitting', 'running', 'transcoding')`);
  });

  it("nothing due: one read, no operator, no chain", async () => {
    expect(await run()).toEqual({ due: 0, delivered: 0 });
    expect(t.order).toEqual([]);
  });

  it("a job the POST route moved on while this run was busy is judged as it is now, not as the run first read it", async () => {
    const first = await add({ age: 7 * 60_000 });
    const second = await add({ status: "submitting", task: null, age: 6 * 60_000 });
    let polled: string[] = [];
    t.poll = (task) => { polled.push(String(task)); return task === "live-task" ? { state: "running" } : { state: "done", url: "https://o/v.mp4" }; };
    // The first job's encode takes minutes; meanwhile the route stores the second's task.
    t.transcode = async () => {
      await v.db.query("update public.video_jobs set status = 'running', provider_task_id = 'live-task' where id = $1", [second.id]);
      return made;
    };
    expect(await run()).toEqual({ due: 2, delivered: 1 });
    expect(polled).toEqual(["task-1", "live-task"]);
    expect(t.voids).toEqual([]);
    expect(await job(first.id)).toMatchObject({ status: "delivered" });
    expect(await job(second.id)).toMatchObject({ status: "running", provider_task_id: "live-task", locked_until: null });
    polled = [];
  });

  it("words that cannot be opened after the capture: the buyer still gets the video, an admin is told, the job ends", async () => {
    const { id, unit } = await add();
    await v.db.query("update public.video_jobs set words_tag = $2 where id = $1", [id, Buffer.alloc(16).toString("base64")]);
    expect(await run()).toEqual({ due: 1, delivered: 1 });
    expect(t.order.filter((o) => o === "capture")).toHaveLength(1);
    expect(t.voids).toEqual([]);
    const row = await job(id);
    expect(row).toMatchObject({ status: "delivered", locked_until: null, generated_image_id: null });
    expect(jobView(row as never)).toMatchObject({ status: "delivered", why: null, video: { v720: "https://store.test/720.mp4" } });
    expect(t.alerts).toHaveLength(1);
    expect(t.alerts[0].subject).toBe("Paid video not recorded");
    expect(t.alerts[0].text).toContain(unit);
    expect(t.alerts[0].text).not.toMatch(/rain|Rome/);
    // And it holds no running slot, and no run asks about it again.
    expect(await run()).toEqual({ due: 0, delivered: 0 });
  });

  it.each([
    ["1 s of the 30 bought", { seconds: 30, resolution: "480p" }, { durationMs: 1000, width: 854, height: 480 }],
    ["2.9 s of 4", { seconds: 4, resolution: "480p" }, { durationMs: 2900, width: 854, height: 480 }],
    ["26.9 s of 30", { seconds: 30, resolution: "480p" }, { durationMs: 26_900, width: 854, height: 480 }],
    ["720p for 1080p", { seconds: 4, resolution: "1080p" }, { durationMs: 4000, width: 1280, height: 720 }],
    ["480p for 720p", { seconds: 4, resolution: "720p" }, { durationMs: 4000, width: 854, height: 480 }],
  ])("%s: no check, no store, no capture, voided as Enki's, its reason kept", async (_, settings, info) => {
    const { id, unit } = await add({ settings });
    t.transcode = () => ({ ...made, info });
    await run();
    expect(t.order).toEqual(["poll", "transcode", "cleanup"]);
    expect(t.voids).toEqual([[unit, "provider_failed"]]);
    expect(await job(id)).toMatchObject({ status: "failed", error_class: "failed", provider_code: "short_output", video: null });
  });

  it.each([
    ["3.1 s of 4: a provider's rounding", { seconds: 4, resolution: "480p" }, { durationMs: 3100, width: 854, height: 480 }],
    ["27.1 s of 30", { seconds: 30, resolution: "480p" }, { durationMs: 27_100, width: 854, height: 480 }],
    ["longer than bought", { seconds: 4, resolution: "480p" }, { durationMs: 9000, width: 854, height: 480 }],
    ["a wide shape at 480p: its short side is 432, its pixels are 480p's", { seconds: 4, resolution: "480p" }, { durationMs: 4000, width: 992, height: 432 }],
    ["upright 1080p", { seconds: 4, resolution: "1080p" }, { durationMs: 4000, width: 1080, height: 1920 }],
    ["Omni: the words set its length", { modelId: "omni-1.1-flash", seconds: 10, resolution: "720p" }, { durationMs: 3000, width: 1280, height: 720 }],
  ])("%s goes through", async (_, settings, info) => {
    const { id } = await add({ settings });
    t.transcode = () => ({ ...made, info });
    expect(await run()).toEqual({ due: 1, delivered: 1 });
    expect(await job(id)).toMatchObject({ status: "delivered" });
  });

  it("still running: asked once, stays, its lease given back", async () => {
    const { id } = await add();
    t.poll = () => ({ state: "running" });
    expect(await run()).toEqual({ due: 1, delivered: 0 });
    expect(t.order).toEqual(["poll"]);
    expect(await job(id)).toMatchObject({ status: "running", locked_until: null, attempt_count: 0 });
    expect(t.voids).toEqual([]);
  });

  it("the order: transcode, the frames' check, store, capture, cleanup; delivered, recorded, nothing voided", async () => {
    const { id, unit } = await add();
    expect(await run()).toEqual({ due: 1, delivered: 1 });
    expect(t.order).toEqual(["poll", "transcode", "check", "check", "store", "capture", "cleanup"]);
    expect(t.voids).toEqual([]);
    const row = await job(id);
    expect(row).toMatchObject({ status: "delivered", attempt_count: 1, locked_until: null, provider_usage: { completion_tokens: 5 } });
    expect(row.finished_at).toBeTruthy();

    const image = (await v.db.query<Record<string, unknown>>("select * from public.generated_images where id = $1", [row.generated_image_id])).rows[0];
    expect(image).toMatchObject({
      user_id: USER, storage_provider: "supabase", storage_url: "https://store.test/720.mp4", mime_type: "video/mp4", preview_url: "https://store.test/p.webp", thumbnail_url: "https://store.test/p.webp",
      view_url: "https://store.test/p.webp", tiny_url: "https://store.test/p.webp", width: 854, height: 480, file_size_bytes: 123, duration_ms: 4000, accepted: true, visibility: "private",
    });
    expect(image.video).toEqual({ preview: "https://store.test/p.mp4", v720: "https://store.test/720.mp4", v1080: null, poster: "https://store.test/p.webp", width: 854, height: 480, durationMs: 4000 });
    const gen = (await v.db.query<Record<string, unknown>>("select * from public.generations where id = $1", [image.generation_id])).rows[0];
    expect(gen).toMatchObject({ provider: "video", provider_model: "stub-model", payment_intent_id: unit, transaction_hash: "sig-1", amount_paid_micro: 450000, amount_paid_cents: 45, rail: "web", output_format: "mp4", aspect_ratio: "16:9", resolution: "480p" });
    // No prompt named: a private draft of its own, marked a video, under the generator's name.
    expect((await v.db.query<Record<string, unknown>>("select media_type, is_listed, ai_model, listing_status from public.prompts where id = $1", [gen.prompt_id])).rows[0])
      .toEqual({ media_type: "video", is_listed: false, ai_model: "Seedance 2.5", listing_status: "draft" });
    expect(jobView(row as never)).toMatchObject({ status: "delivered", why: null, imageId: row.generated_image_id, video: { v720: "https://store.test/720.mp4" } });
  });

  it("a prompt's job is recorded under that prompt", async () => {
    const { id } = await add({ promptId: PREMIUM });
    await run();
    const image = (await v.db.query<{ prompt_id: string }>("select prompt_id from public.generated_images where id = $1", [(await job(id)).generated_image_id])).rows[0];
    expect(image.prompt_id).toBe(PREMIUM);
  });

  it("an operator's failure: voided as Enki's, no capture, the sentence, its code kept", async () => {
    const { id, unit } = await add();
    t.poll = () => ({ state: "failed", kind: "other", code: "InternalError" });
    await run();
    expect(t.order).toEqual(["poll"]);
    expect(t.voids).toEqual([[unit, "provider_failed"]]);
    const row = await job(id);
    expect(row).toMatchObject({ status: "failed", error_class: "failed", provider_code: "InternalError", locked_until: null });
    expect(jobView(row as never)).toMatchObject({ why: JOB_WHY.failed, video: null, imageId: null });
  });

  it("a real face refused: one clear sentence, voided as the buyer's input, not billed", async () => {
    const { id, unit } = await add();
    t.poll = () => ({ state: "failed", kind: "real_person", code: "x.PrivacyInformation" });
    await run();
    expect(t.voids).toEqual([[unit, "rejected"]]);
    const row = await job(id);
    expect(row).toMatchObject({ status: "refused", error_class: "real_person", provider_code: "x.PrivacyInformation" });
    expect(jobView(row as never).why).toBe("This video can't use a photo of a real person's face. Nothing was charged.");
  });

  it("a frame refused: nothing stored, nothing captured, voided as the buyer's", async () => {
    const { id, unit } = await add();
    t.frames = [{ verdict: "clear" }, { verdict: "blocked", reason: "policy" }];
    await run();
    expect(t.order).toEqual(["poll", "transcode", "check", "check", "cleanup"]);
    expect(t.voids).toEqual([[unit, "rejected"]]);
    expect(await job(id)).toMatchObject({ status: "refused", error_class: "image_check", video: null });
    expect(t.cases).toEqual([]);
  });

  it("a child-safety frame is a case in this same minute, about that account and those bytes", async () => {
    const { id, unit } = await add({ promptId: PREMIUM });
    t.frames = [{ verdict: "clear" }, { verdict: "child_safety", scores: { minors: 0.9 } }];
    await run();
    expect(t.cases).toHaveLength(1);
    expect(t.cases[0]).toMatchObject({ surface: "generate-video", account: USER, bytes: made.frames[1], scores: { minors: 0.9 }, promptId: PREMIUM, about: "" });
    expect(t.voids).toEqual([[unit, "rejected"]]);
    expect(await job(id)).toMatchObject({ status: "refused", error_class: "image_check" });
    expect(t.order).not.toContain("store");
    expect(t.order).not.toContain("capture");
  });

  it("a check that cannot judge: not delivered, nothing charged; down is Enki's, otherwise the buyer's", async () => {
    const down = await add();
    t.frames = [{ verdict: "unavailable", reason: "not configured" }, { verdict: "clear" }];
    await run();
    expect(await job(down.id)).toMatchObject({ status: "failed", error_class: "unchecked" });
    expect(t.voids).toEqual([[down.unit, "provider_failed"]]);
    expect(t.order).not.toContain("capture");
    t.voids = [];
    const theirs = await add();
    t.frames = [{ verdict: "unavailable", reason: "refused to judge" }, { verdict: "clear" }];
    await run();
    expect(t.voids).toEqual([[theirs.unit, "rejected"]]);
  });

  it("frames that are no picture are the generator's failure, never the buyer's", async () => {
    const { id, unit } = await add();
    t.frames = [{ verdict: "blocked", reason: "not an image" }, { verdict: "clear" }];
    await run();
    expect(t.voids).toEqual([[unit, "provider_failed"]]);
    expect(await job(id)).toMatchObject({ status: "failed", error_class: "failed" });
  });

  it("the artist's words read off a frame: withheld, the prompt reported, the unit Enki's; a frame without them goes through", async () => {
    await sealArtistText(v.db, "a very long secret text the artist wrote about the harbour at night");
    const { id, unit } = await add({ promptId: PREMIUM, artist: 400000, settings: { fromArtist: true } });
    t.frames = [{ verdict: "clear", text: "a very long secret text the artist wrote about the harbour at night" }, { verdict: "clear" }];
    await run();
    expect(t.refused).toEqual([{ promptId: PREMIUM, cause: "render", detail: "hidden text", buyerUserId: USER }]);
    expect(t.voids).toEqual([[unit, "provider_failed"]]);
    expect(await job(id)).toMatchObject({ status: "failed", error_class: "failed" });
    expect(t.order).not.toContain("capture");

    t.voids = [];
    const other = await add({ promptId: PREMIUM, artist: 400000, settings: { fromArtist: true } });
    t.frames = [{ verdict: "clear", text: "SALE" }, { verdict: "clear" }];
    await run();
    expect(await job(other.id)).toMatchObject({ status: "delivered" });
  });

  it("an adult frame marks the render 18+", async () => {
    const { id } = await add();
    t.frames = [{ verdict: "adult" }, { verdict: "clear" }];
    await run();
    const image = (await v.db.query<{ is_adult: boolean }>("select is_adult from public.generated_images where id = $1", [(await job(id)).generated_image_id])).rows[0];
    expect(image.is_adult).toBe(true);
  });

  it("a capture refused: the stored files come down, the buyer told, no record", async () => {
    const { id, unit } = await add();
    t.capture = async (u) => {
      await v.db.query(`update public.generation_payment_intents set capture_started_at = now(), voided_at = now(), void_reason = 'capture_failed' where id = $1`, [u]);
      return { kind: "rejected", error: "no USDC" };
    };
    await run();
    expect(t.order.at(-2)).toBe("remove:2");
    const row = await job(id);
    expect(row).toMatchObject({ status: "failed", error_class: "payment", generated_image_id: null });
    expect(jobView(row as never).why).toBe(JOB_WHY.payment);
    expect((await v.db.query("select 1 from public.generations where payment_intent_id = $1", [unit])).rows).toEqual([]);
  });

  it("a capture whose outcome is unknown: the job waits, the sweep settles, the next minute reads it", async () => {
    const { id, unit } = await add();
    t.capture = async (u) => {
      await v.db.query(`update public.generation_payment_intents set capture_started_at = now() where id = $1`, [u]);
      return { kind: "unknown", signature: "sig-2" };
    };
    await run();
    expect(await job(id)).toMatchObject({ status: "transcoding", locked_until: null });
    expect(t.voids).toEqual([]);

    // A lease stands: no second capture, no void.
    t.order = [];
    await run();
    expect(t.order).toEqual([]);
    expect(await job(id)).toMatchObject({ status: "transcoding", locked_until: null });

    // The sweep found it landed, withheld: owed. Refunded, told so, the files down.
    await v.db.query(`update public.generation_payment_intents set captured_at = now() where id = $1`, [unit]);
    t.order = [];
    await run();
    expect(t.order).toEqual(["remove:2"]);
    expect(await job(id)).toMatchObject({ status: "failed", error_class: "owed" });
  });

  it("a crash after the capture: delivered from what was kept, never captured twice, never transcoded again", async () => {
    const files = { preview: "https://store.test/p.mp4", v720: "https://store.test/720.mp4", v1080: null, poster: "https://store.test/p.webp", width: 854, height: 480, durationMs: 4000, paths: ["u/p.mp4"], v720Bytes: 9 };
    const { id, unit } = await add({ status: "transcoding", video: files });
    await v.db.query(`update public.generation_payment_intents set capture_started_at = now(), captured_at = now(), fulfilled_at = now(), tx_signature = 'sig-9' where id = $1`, [unit]);
    expect(await run()).toEqual({ due: 1, delivered: 1 });
    expect(t.order).toEqual([]);
    const row = await job(id);
    expect(row.status).toBe("delivered");
    expect((await v.db.query<{ transaction_hash: string }>("select transaction_hash from public.generations where payment_intent_id = $1", [unit])).rows).toEqual([{ transaction_hash: "sig-9" }]);
  });

  it("files kept and the money untouched: captured on the next minute", async () => {
    const files = { preview: "https://store.test/p.mp4", v720: "https://store.test/720.mp4", v1080: null, poster: "https://store.test/p.webp", width: 854, height: 480, durationMs: 4000, paths: ["u/p.mp4"], v720Bytes: 9 };
    const { id } = await add({ status: "transcoding", video: files });
    await run();
    expect(t.order).toEqual(["capture"]);
    expect((await job(id)).status).toBe("delivered");
  });

  it("files kept and the unit voided since: down, and failed", async () => {
    const files = { preview: "https://store.test/p.mp4", v720: "https://store.test/720.mp4", v1080: null, poster: "https://store.test/p.webp", width: 854, height: 480, durationMs: 4000, paths: ["u/p.mp4"], v720Bytes: 9 };
    const { id, unit } = await add({ status: "transcoding", video: files });
    await v.db.query(`update public.generation_payment_intents set voided_at = now() where id = $1`, [unit]);
    await run();
    expect(t.order).toEqual(["remove:1"]);
    expect(await job(id)).toMatchObject({ status: "failed", error_class: "failed" });
  });

  it("submit is at most once: a job dead in submitting is failed and voided, never resubmitted; a young one is left alone", async () => {
    const dead = await add({ status: "submitting", task: null, age: 6 * 60_000 });
    const young = await add({ status: "submitting", task: null, age: 30_000 });
    await run();
    expect(t.submit).toBe(0);
    expect(t.order).toEqual([]);
    expect(t.voids).toEqual([[dead.unit, "provider_failed"]]);
    expect(await job(dead.id)).toMatchObject({ status: "failed", error_class: "failed" });
    expect(await job(young.id)).toMatchObject({ status: "submitting", locked_until: null });
  });

  it("three attempts, then failed and voided; each failure leaves it for the next minute", async () => {
    const { id, unit } = await add();
    t.transcode = () => { throw new Error("[video] ffmpeg exited 1"); };
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await run();
      expect(await job(id)).toMatchObject({ status: "transcoding", attempt_count: attempt, locked_until: null });
      expect(t.voids).toEqual([]);
    }
    t.order = [];
    await run();
    expect(t.order).toEqual(["poll"]);
    expect(t.voids).toEqual([[unit, "provider_failed"]]);
    expect(await job(id)).toMatchObject({ status: "failed", error_class: "failed", attempt_count: MAX_ATTEMPTS });
  });

  it("a poll that cannot be answered is no finding: it stays, until its deadline", async () => {
    const { id } = await add();
    t.poll = () => { throw new Error("[video] poll answered 503"); };
    await run();
    expect(await job(id)).toMatchObject({ status: "running", locked_until: null });
    expect(t.voids).toEqual([]);
  });

  it("past its deadline: failed and voided, the operator not asked", async () => {
    const { id, unit } = await add({ age: GIVE_UP_MS + 1000 });
    await run();
    expect(t.order).toEqual([]);
    expect(t.voids).toEqual([[unit, "provider_failed"]]);
    expect((await job(id)).status).toBe("failed");
  });

  it("a transcode starts only with enough of the function left", async () => {
    const { id } = await add();
    await run(TRANSCODE_MIN_LEFT_MS - 1000);
    expect(t.order).toEqual(["poll"]);
    expect(await job(id)).toMatchObject({ status: "running", attempt_count: 0, locked_until: null });
  });

  it("a job another run holds is not touched; an expired lease is taken", async () => {
    const held = await add({ locked: new Date(Date.now() + 60_000).toISOString() });
    t.poll = () => ({ state: "running" });
    expect((await run()).due).toBe(0);
    expect(t.order).toEqual([]);
    await v.db.query(`update public.video_jobs set locked_until = now() - interval '1 second' where id = $1`, [held.id]);
    expect((await run()).due).toBe(1);
    expect(t.order).toEqual(["poll"]);
  });

  it("two runs at once ask a job once: the lease is a conditional write", async () => {
    await add();
    t.poll = () => ({ state: "running" });
    await Promise.all([run(), run()]);
    expect(t.order).toEqual(["poll"]);
  });

  it("no adapter under its name: failed and voided", async () => {
    const { id, unit } = await add();
    await v.db.query(`update public.video_jobs set operator = 'gone' where id = $1`, [id]);
    await run();
    expect(t.voids).toEqual([[unit, "provider_failed"]]);
    expect((await job(id)).status).toBe("failed");
  });

  it("a buyer's own landed broadcast, found by the void, is told as owed", async () => {
    const { id, unit } = await add();
    t.poll = () => ({ state: "failed", kind: "other", code: null });
    t.void = async (u) => { await v.db.query(`update public.generation_payment_intents set captured_at = now() where id = $1`, [u]); return false; };
    await run();
    expect(t.voids).toEqual([[unit, "provider_failed"]]);
    const row = await job(id);
    expect(row.error_class).toBe("owed");
    expect(jobView(row as never).why).toBe(JOB_WHY.owed);
  });

  it("a stored file is not the buyer's until delivered, and a view names no operator", async () => {
    const files = { preview: "https://store.test/p.mp4", v720: "https://store.test/720.mp4", poster: "https://store.test/p.webp" };
    const view = jobView({ id: "j", status: "transcoding", settings: { modelId: "seedance-2.5", seconds: 4, operator: "x" }, prompt_id: null, created_at: "t", error_class: null, video: files, generated_image_id: null });
    expect(view.video).toBeNull();
    expect(view.label).toBe("Seedance 2.5");
    expect(JSON.stringify(view)).not.toMatch(/operator|"x"/);
  });
});

describe("before SQL 69", () => {
  it("the run names the file and asks nothing", async () => {
    const v = await videoDb(["2026-11-03-video-prompts.sql"]);
    expect(await runVideoJobs(v.client, { request: REQ, deadlineAt: Date.now() + LOTS })).toEqual({ due: 0, delivered: 0, run: "69-video-jobs.sql" });
    await v.close();
  }, 60_000);
});
