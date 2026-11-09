import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * hooks/useVideoRun over the real checkout (lib/generation-checkout), its fetch a recorder: one press is the video intent, /authorize
 * for one unit, one signature, /submit, then the job, in that order, and a refusal says its sentence. Blind spot: the routes answer
 * from this file; the real ones meet PGlite in video-routes.test.ts, and no real wallet signs.
 */
const h = vi.hoisted(() => ({
  busy: false, setBusy: vi.fn(), query: null as null | { enabled: boolean; queryKey: unknown[]; refetchInterval: (q: { state: { data?: Array<{ status: string }> } }) => unknown; queryFn: () => Promise<unknown> },
  data: undefined as unknown, invalidate: vi.fn(), notify: vi.fn(), sign: vi.fn(async (txs: string[]) => txs.map((t) => `${t}-signed`)),
}));
vi.mock("react", async (original) => ({ ...(await original<typeof import("react")>()), useState: () => [h.busy, h.setBusy] }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (config: typeof h.query) => { h.query = config; return { data: h.data }; },
  useQueryClient: () => ({ invalidateQueries: h.invalidate }),
}));
vi.mock("@/components/kit/notify", () => ({ notify: h.notify }));
vi.mock("@/hooks/usePaymentSigner", () => ({ usePaymentSigner: () => h.sign }));
vi.mock("@/lib/session-headers", () => ({ sessionAuthHeaders: () => ({ "X-Session-Token": "t" }) }));
vi.mock("@/lib/ui/kit/render-stepup", () => ({ withRenderStepUp: (send: (h: object) => unknown) => send({}), cancelledStepUp: async () => false }));

import { useVideoRun, VIDEO_INTENT_PATH } from "@/hooks/useVideoRun";
import { JOB_WHY } from "@/lib/video/job-view";
import { startSettings, VIDEO_MODELS } from "@/lib/video/models";

const SD = VIDEO_MODELS[0];
const ASK = { modelId: SD.id, settings: startSettings(SD), words: "rain" };
const INTENT = "00000000-0000-4000-8000-000000000001";
const FUNDED = { intentId: INTENT, paymentScheme: "intent", state: "funded", funded: true, units: [{ unit_index: 0, state: "pending", generation_id: null }] };
type Sent = { path: string; body: Record<string, unknown> };
let sent: Sent[];
let answers: Record<string, () => Response>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  sent = [];
  h.busy = false;
  for (const f of [h.setBusy, h.invalidate, h.notify, h.sign]) f.mockClear();
  answers = {
    [VIDEO_INTENT_PATH]: () => json({ intent: { id: INTENT } }),
    "/api/payments/generation/authorize": () => json({ intentId: INTENT, units: 1, paymentScheme: "intent", transactions: ["tx"] }),
    "/api/payments/generation/submit": () => json(FUNDED),
    "/api/video/jobs": () => json({ job: { id: "job-1", status: "running" } }),
  };
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const path = String(input).split("?")[0];
    sent.push({ path, body: init?.body ? JSON.parse(String(init.body)) : {} });
    return (answers[path] ?? (() => json({ error: "no route" }, 404)))();
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe("one press", () => {
  it("goes intent, one unit, one signature, submit, job, and answers the job's id", async () => {
    const id = await useVideoRun({ enabled: true }).press({ ...ASK, promptId: "p1", frames: { start: "f1" }, refs: ["r1"], consent: true, variableValues: { city: "Rome" } });
    expect(id).toBe("job-1");
    expect(sent.map((s) => s.path)).toEqual([VIDEO_INTENT_PATH, "/api/payments/generation/authorize", "/api/payments/generation/submit", "/api/video/jobs"]);
    expect(sent[0].body).toEqual({ promptId: "p1", modelId: SD.id, settings: startSettings(SD) });
    expect(sent[1].body).toEqual({ intentId: INTENT, units: 1 });
    expect(h.sign).toHaveBeenCalledTimes(1);
    expect(sent[2].body).toEqual({ intentId: INTENT, signedTransactions: ["tx-signed"] });
    expect(sent[3].body).toEqual({ intentId: INTENT, words: "rain", variableValues: { city: "Rome" }, frames: { start: "f1" }, refs: ["r1"], consent: true });
    expect(sent.some((s) => "count" in s.body)).toBe(false);
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.invalidate).toHaveBeenCalledWith({ queryKey: ["video-jobs"] });
    expect(h.setBusy.mock.calls.map((c) => c[0])).toEqual([true, false]);
  });

  it("while one is on its way, a second asks nothing", async () => {
    h.busy = true;
    expect(await useVideoRun({ enabled: true }).press(ASK)).toBeNull();
    expect(sent).toEqual([]);
  });

  it("the route's refusal of the intent is said, and nothing is signed", async () => {
    answers[VIDEO_INTENT_PATH] = () => json({ error: "Not available yet." }, 503);
    expect(await useVideoRun({ enabled: true }).press(ASK)).toBeNull();
    expect(h.notify).toHaveBeenCalledWith("Not available yet.", { tone: "error" });
    expect(h.sign).not.toHaveBeenCalled();
    expect(sent.map((s) => s.path)).toEqual([VIDEO_INTENT_PATH]);
  });

  it("the job's refusal is said in its own words", async () => {
    answers["/api/video/jobs"] = () => json({ error: JOB_WHY.real_person }, 422);
    expect(await useVideoRun({ enabled: true }).press(ASK)).toBeNull();
    expect(h.notify).toHaveBeenCalledWith(JOB_WHY.real_person, { tone: "error" });
  });

  it("a refusal with no words reads as a failed video, and busy ends", async () => {
    answers["/api/video/jobs"] = () => new Response("", { status: 500 });
    expect(await useVideoRun({ enabled: true }).press(ASK)).toBeNull();
    expect(h.notify).toHaveBeenCalledWith(JOB_WHY.failed, { tone: "error" });
    expect(h.setBusy).toHaveBeenLastCalledWith(false);
  });

  it("an image's checkout still goes to its own intent", async () => {
    const { authorizePaidGeneration } = await import("@/lib/generation-checkout");
    answers["/api/payments/generation/intent"] = answers[VIDEO_INTENT_PATH];
    await authorizePaidGeneration({ modelId: "m", resolution: "2K" }, h.sign as never, 1);
    expect(sent[0].path).toBe("/api/payments/generation/intent");
  });
});

describe("the list", () => {
  it("is off until asked, and keyed by the prompt", () => {
    useVideoRun({ enabled: false });
    expect(h.query?.enabled).toBe(false);
    useVideoRun({ enabled: true, promptId: "p1" });
    expect(h.query?.queryKey).toEqual(["video-jobs", "p1"]);
    expect(h.query?.enabled).toBe(true);
  });

  it("asks one prompt's, or the account's", async () => {
    answers["/api/video/jobs"] = () => json({ jobs: [{ id: "a" }] });
    useVideoRun({ enabled: true, promptId: "p 1" });
    expect(await h.query!.queryFn()).toEqual([{ id: "a" }]);
    expect((fetch as unknown as { mock: { calls: string[][] } }).mock.calls[0][0]).toBe("/api/video/jobs?promptId=p%201");
    useVideoRun({ enabled: true });
    await h.query!.queryFn();
    expect((fetch as unknown as { mock: { calls: string[][] } }).mock.calls[1][0]).toBe("/api/video/jobs");
  });

  it("a refused read is an empty list", async () => {
    answers["/api/video/jobs"] = () => json({ error: "no" }, 500);
    useVideoRun({ enabled: true });
    expect(await h.query!.queryFn()).toEqual([]);
  });

  it("asks again only while one is under way", () => {
    useVideoRun({ enabled: true });
    const every = (data?: Array<{ status: string }>) => h.query!.refetchInterval({ state: { data } });
    expect(every([{ status: "delivered" }, { status: "running" }])).toBe(15_000);
    expect(every([{ status: "transcoding" }])).toBe(15_000);
    expect(every([{ status: "submitting" }])).toBe(15_000);
    expect(every([{ status: "delivered" }, { status: "failed" }, { status: "refused" }])).toBe(false);
    expect(every(undefined)).toBe(false);
  });

  it("no data yet is no jobs", () => {
    h.data = undefined;
    expect(useVideoRun({ enabled: true }).jobs).toEqual([]);
  });
});
