import { afterEach, describe, expect, it, vi } from "vitest";
import { VIDEO_ADAPTERS } from "@/lib/video/adapters";
import { byteplus } from "@/lib/video/adapters/byteplus";
import { VideoRefused, type VideoSubmit } from "@/lib/video/adapters/types";
import { availableAt, type VideoRoute } from "@/lib/video/routes";

/**
 * The one operator's file against what its docs say. Every answer here is written from the docs, NOT from a real response:
 * this file has met no real API. Blind spot: a green run says the file does what was read, not that the API does.
 */
const JOB: VideoSubmit = {
  providerModel: "seedance-model", words: "rain starts", frames: {}, refs: [],
  settings: { seconds: 4, aspect: "16:9", resolution: "480p", audio: true }, endUserHash: "a".repeat(64),
};
const answer = (status: number, body: unknown) => vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));
const TASKS = "https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("the request", () => {
  const sent = async (job: Partial<VideoSubmit> = {}) => {
    vi.stubEnv("ARK_API_KEY", "stub-key");
    const host = answer(200, { id: "task-1" });
    vi.stubGlobal("fetch", host);
    expect(await byteplus.submit({ ...JOB, ...job })).toEqual({ taskId: "task-1" });
    expect(host).toHaveBeenCalledTimes(1);
    const [url, init] = host.mock.calls[0];
    return { url, method: init?.method, auth: (init?.headers as Record<string, string>).Authorization, body: JSON.parse(String(init?.body)) as Record<string, unknown> };
  };

  it("goes to the tasks path with the bearer key and every duty set", async () => {
    const { url, method, auth, body } = await sent();
    expect([url, method, auth]).toEqual([TASKS, "POST", "Bearer stub-key"]);
    expect(body).toEqual({
      model: "seedance-model", content: [{ type: "text", text: "rain starts" }], resolution: "480p", ratio: "16:9", duration: 4,
      generate_audio: true, watermark: false, safety_identifier: "a".repeat(64),
    });
  });

  it("names each picture by its role, the words first", async () => {
    const { body } = await sent({ frames: { start: "https://s/a", end: "https://s/b" }, refs: ["https://s/c"] });
    expect(body.content).toEqual([
      { type: "text", text: "rain starts" },
      { type: "image_url", image_url: { url: "https://s/a" }, role: "first_frame" },
      { type: "image_url", image_url: { url: "https://s/b" }, role: "last_frame" },
      { type: "image_url", image_url: { url: "https://s/c" }, role: "reference_image" },
    ]);
  });

  it("auto is its adaptive, silence is silence", async () => {
    const { body } = await sent({ settings: { ...JOB.settings, aspect: "auto", audio: false } });
    expect([body.ratio, body.generate_audio]).toEqual(["adaptive", false]);
  });
});

describe("a refusal at the door", () => {
  it.each([
    ["InputImageSensitiveContentDetected.PrivacyInformation", "real_person"],
    ["InputTextSensitiveContentDetected", "moderation"],
  ])("%s is %s, no task", async (code, kind) => {
    vi.stubGlobal("fetch", answer(400, { error: { code, message: "words" } }));
    const refused = await byteplus.submit(JOB).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(VideoRefused);
    expect(refused).toMatchObject({ kind, code });
  });

  it("any other failure is no finding about the buyer, and carries no words of the answer's", async () => {
    vi.stubGlobal("fetch", answer(500, { error: { code: "InternalError", message: "secret words" } }));
    const failed = await byteplus.submit(JOB).catch((e: unknown) => e) as Error;
    expect(failed).not.toBeInstanceOf(VideoRefused);
    expect(failed.message).toBe("[video] submit answered 500, code InternalError");
  });

  it("a 200 without a task id is a failure, never a job", async () => {
    vi.stubGlobal("fetch", answer(200, {}));
    await expect(byteplus.submit(JOB)).rejects.toThrow("submit answered 200");
  });
});

describe("a poll", () => {
  const polled = async (status: number, body: unknown) => {
    const host = answer(status, body);
    vi.stubGlobal("fetch", host);
    const out = await byteplus.poll("t/1");
    expect(host.mock.calls[0][0]).toBe(`${TASKS}/t%2F1`);
    return out;
  };

  it.each(["queued", "running"])("%s is running", async (status) => {
    expect(await polled(200, { status })).toEqual({ state: "running" });
  });

  it("succeeded hands over the file and the usage", async () => {
    expect(await polled(200, { status: "succeeded", content: { video_url: "https://o/v.mp4" }, usage: { completion_tokens: 5 } }))
      .toEqual({ state: "done", url: "https://o/v.mp4", usage: { completion_tokens: 5 } });
  });

  it.each([["processing"], ["pending"], [undefined], ["succeeded"]])("a word it has not heard (%s), or succeeded with no file yet, stays running: its deadline ends it, never a first poll", async (status) => {
    expect(await polled(200, { status, content: {} })).toEqual({ state: "running" });
  });

  it("a body that is no JSON stays running too", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>", { status: 200 })));
    expect(await byteplus.poll("t")).toEqual({ state: "running" });
  });

  it("only failed, expired and cancelled end it, by their code", async () => {
    expect(await polled(200, { status: "expired" })).toEqual({ state: "failed", kind: "other", code: "expired" });
    expect(await polled(200, { status: "cancelled" })).toEqual({ state: "failed", kind: "other", code: "cancelled" });
    expect(await polled(200, { status: "failed", error: { code: "OutputVideoSensitiveContentDetected" } }))
      .toEqual({ state: "failed", kind: "moderation", code: "OutputVideoSensitiveContentDetected" });
    expect(await polled(200, { status: "failed", error: { code: "x.PrivacyInformation" } })).toEqual({ state: "failed", kind: "real_person", code: "x.PrivacyInformation" });
  });

  it("no answer is no finding: it throws, and the job stays", async () => {
    vi.stubGlobal("fetch", answer(503, {}));
    await expect(byteplus.poll("t")).rejects.toThrow("poll answered 503");
  });
});

describe("registered, and still reaching nothing without its row", () => {
  const route = (over: Partial<VideoRoute>): VideoRoute => ({ id: "seedance-2.5", modelId: "m", operator: null, providerModel: null, rateOperator: null, rate: { cost: { "480p": 1 }, clipsAdded: false }, ...over });
  const named = { operator: "byteplus", providerModel: "m", rateOperator: "byteplus" };

  it("is under the name a row holds", () => {
    expect(VIDEO_ADAPTERS.byteplus).toBe(byteplus);
  });

  it("no operator, or no key, is nowhere; both is the rate's resolutions", () => {
    vi.stubEnv("ARK_API_KEY", "stub-key");
    expect(availableAt(route({}))).toEqual([]);
    expect(availableAt(route(named))).toEqual(["480p"]);
    vi.stubEnv("ARK_API_KEY", "");
    expect(byteplus.configured()).toBe(false);
    expect(availableAt(route(named))).toEqual([]);
  });
});
