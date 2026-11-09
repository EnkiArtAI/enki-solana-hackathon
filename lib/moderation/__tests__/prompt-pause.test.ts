import { describe, expect, it, vi, afterEach } from "vitest";
import { fakeDb } from "@/lib/__tests__/_fake-supabase";
import { decidePause, isPaused, pausedPrompts, PROVIDER_PAUSE_WINDOW_MS, refusePrompt } from "@/lib/moderation/prompt-pause";

/**
 * An artist's text refused at render (Kev, 2026-10-27: the sketch of DEC-145/266): recorded, and the prompt off sale
 * until an admin decides; for a provider only once two different buyers were refused within a day.
 */
const P = "11111111-1111-4111-8111-111111111111";
const LIVE = { id: P, title: "Neon koi", creator_id: "artist", is_listed: true, delisted_at: null, deleted_at: null };
const db = (prompt: Record<string, unknown> = LIVE, refusals: Record<string, unknown>[] = [], errors = {}) =>
  fakeDb({ prompts: [{ ...prompt }], prompt_refusals: refusals }, errors);
const listed = (d: ReturnType<typeof fakeDb>) => d.tables.prompts[0].is_listed;

afterEach(() => vi.useRealTimers());

describe("a refusal by our moderation", () => {
  it("is recorded without the text and takes a listed prompt off sale at once", async () => {
    const d = db();
    expect(await refusePrompt(d.client, { promptId: P, cause: "moderation", detail: "violence", buyerUserId: "b1" })).toBe(true);
    expect(listed(d)).toBe(false);
    expect(d.tables.prompt_refusals).toEqual([expect.objectContaining({ prompt_id: P, cause: "moderation", detail: "violence", buyer_user_id: "b1", paused: true })]);
    expect(await isPaused(d.client, P)).toBe(true);
  });

  it("leaves a prompt not on sale, or taken down, as it is, and records it unpaused", async () => {
    for (const prompt of [{ ...LIVE, is_listed: false }, { ...LIVE, delisted_at: "2026-10-01T00:00:00Z" }]) {
      const d = db(prompt);
      expect(await refusePrompt(d.client, { promptId: P, cause: "moderation", detail: "violence", buyerUserId: "b1" })).toBe(false);
      expect(d.tables.prompt_refusals[0].paused).toBeUndefined();
      expect(await isPaused(d.client, P)).toBe(false);
    }
  });

  it("keeps the detail short", async () => {
    const d = db();
    await refusePrompt(d.client, { promptId: P, cause: "moderation", detail: "x".repeat(500), buyerUserId: "b1" });
    expect(d.tables.prompt_refusals[0].detail).toHaveLength(120);
  });
});

describe("a refusal by an image provider", () => {
  const provider = (d: ReturnType<typeof fakeDb>, buyer: string) => refusePrompt(d.client, { promptId: P, cause: "provider", detail: "OpenAI", buyerUserId: buyer });

  it("pauses only once two different buyers were refused, never one buyer twice", async () => {
    const d = db();
    expect(await provider(d, "b1")).toBe(false);
    expect(await provider(d, "b1")).toBe(false);
    expect(listed(d)).toBe(true);
    expect(await provider(d, "b2")).toBe(true);
    expect(listed(d)).toBe(false);
  });

  it("counts only the last day's open refusals", async () => {
    const old = new Date(Date.now() - PROVIDER_PAUSE_WINDOW_MS - 60_000).toISOString();
    const stale = db(LIVE, [{ id: "r0", prompt_id: P, cause: "provider", buyer_user_id: "b0", created_at: old, reviewed_at: null }]);
    expect(await provider(stale, "b1")).toBe(false);
    const decided = db(LIVE, [{ id: "r0", prompt_id: P, cause: "provider", buyer_user_id: "b0", created_at: new Date().toISOString(), reviewed_at: "2026-10-27T00:00:00Z" }]);
    expect(await provider(decided, "b1")).toBe(false);
    const recent = db(LIVE, [{ id: "r0", prompt_id: P, cause: "provider", buyer_user_id: "b0", created_at: new Date().toISOString(), reviewed_at: null }]);
    expect(await provider(recent, "b1")).toBe(true);
  });

  it("never counts a moderation refusal toward the two buyers", async () => {
    const d = db(LIVE, [{ id: "r0", prompt_id: P, cause: "moderation", buyer_user_id: "b0", created_at: new Date().toISOString(), reviewed_at: null }]);
    expect(await provider(d, "b1")).toBe(false);
  });
});

describe("without the table (SQL 39 not run) or a write that fails", () => {
  it("records nothing and pauses nothing, and never throws", async () => {
    for (const errors of [{ prompt_refusals: { message: 'relation "prompt_refusals" does not exist', code: "42P01" } }, { "prompts.update": { message: "boom" } }]) {
      const d = db(LIVE, [], errors);
      expect(await refusePrompt(d.client, { promptId: P, cause: "moderation", detail: "violence", buyerUserId: "b1" })).toBe(false);
      expect(listed(d)).toBe(true);
    }
    expect(await isPaused(db(LIVE, [], { prompt_refusals: { message: "missing" } }).client, P)).toBe(false);
  });

  it("never puts back on sale a prompt a moderator took down meanwhile", async () => {
    const d = db(LIVE, [], { "prompt_refusals.update": { message: "boom" } });
    // The takedown lands between the pause and its undo.
    const update = d.client.from;
    d.client.from = ((t: string) => {
      if (t === "prompts" && d.tables.prompts[0].is_listed === false) d.tables.prompts[0].delisted_at = "2026-10-27T12:00:00Z";
      return update(t);
    }) as typeof d.client.from;
    expect(await refusePrompt(d.client, { promptId: P, cause: "moderation", detail: "violence", buyerUserId: "b1" })).toBe(false);
    expect(listed(d)).toBe(false);
  });

  it("puts the prompt back on sale when the refusal cannot be marked as its pause", async () => {
    const d = db(LIVE, [], { "prompt_refusals.update": { message: "boom" } });
    expect(await refusePrompt(d.client, { promptId: P, cause: "moderation", detail: "violence", buyerUserId: "b1" })).toBe(false);
    expect(listed(d)).toBe(true);
  });
});

describe("an admin's decision", () => {
  const paused = () => {
    const d = db({ ...LIVE, is_listed: false }, [
      { id: "r1", prompt_id: P, cause: "provider", detail: "OpenAI", paused: false, created_at: "2026-10-27T10:00:00Z", reviewed_at: null },
      { id: "r2", prompt_id: P, cause: "provider", detail: "OpenAI", paused: true, created_at: "2026-10-27T11:00:00Z", reviewed_at: null },
    ]);
    return d;
  };

  it("lists a paused prompt with its open refusals", async () => {
    expect(await pausedPrompts(paused().client)).toEqual([{
      promptId: P, title: "Neon koi", creatorId: "artist",
      // Newest first, the row's time.
      refusals: [{ cause: "provider", detail: "OpenAI", at: "2026-10-27T11:00:00Z" }, { cause: "provider", detail: "OpenAI", at: "2026-10-27T10:00:00Z" }],
    }]);
    expect(await pausedPrompts(db().client)).toEqual([]);
    // An open refusal that paused nothing (one buyer's provider refusal) waits for no one.
    const one = db(LIVE, [{ id: "r1", prompt_id: P, cause: "provider", detail: "OpenAI", paused: false, created_at: "2026-10-27T10:00:00Z", reviewed_at: null }]);
    expect(await pausedPrompts(one.client)).toEqual([]);
  });

  it("releases it back on sale and decides every open refusal", async () => {
    const d = paused();
    expect(await decidePause(d.client, P, "released", "admin-1")).toEqual({ ok: true });
    expect(listed(d)).toBe(true);
    expect(d.tables.prompt_refusals.map((r) => [r.decision, r.reviewed_by])).toEqual([["released", "admin-1"], ["released", "admin-1"]]);
    expect(await isPaused(d.client, P)).toBe(false);
  });

  it("delists it for good, as a report's delist does", async () => {
    const d = paused();
    expect(await decidePause(d.client, P, "delisted", "admin-1")).toEqual({ ok: true });
    expect(d.tables.prompts[0]).toMatchObject({ is_listed: false, delisted_at: expect.any(String) });
    expect(d.tables.prompt_refusals.every((r) => r.decision === "delisted")).toBe(true);
    // Off sale even if it came back on meanwhile.
    const back = paused();
    back.tables.prompts[0].is_listed = true;
    await decidePause(back.client, P, "delisted", "admin-1");
    expect(listed(back)).toBe(false);
  });

  it("refuses a prompt that is not waiting, and never relists one taken down meanwhile", async () => {
    expect(await decidePause(db().client, P, "released", "admin-1")).toMatchObject({ ok: false, status: 400 });
    const d = paused();
    d.tables.prompts[0].delisted_at = "2026-10-27T12:00:00Z";
    expect(await decidePause(d.client, P, "released", "admin-1")).toMatchObject({ ok: false, status: 409 });
    expect(listed(d)).toBe(false);
    expect(d.tables.prompt_refusals.every((r) => r.reviewed_at === null)).toBe(true);
  });
});

describe("why a prompt was paused, in one line", () => {
  it("names each cause once, with how often and what", async () => {
    const { pauseSummary } = await import("@/lib/moderation/prompt-pause");
    expect(pauseSummary([
      { cause: "provider", detail: "OpenAI", at: "a" }, { cause: "provider", detail: "OpenAI", at: "b" },
      { cause: "moderation", detail: "violence", at: "c" }, { cause: "provider", detail: "", at: "d" },
    ])).toBe("2× provider (OpenAI) · 1× moderation (violence) · 1× provider");
  });
});

// Review wf_866ba07b-01a: a render that spelled out the hidden text may be the artist's lettering or one buyer's
// extraction, so it pauses like a provider's refusal, and an admin's release says the lettering is meant.
describe("a render that spelled out the hidden text", () => {
  const render = (d: ReturnType<typeof fakeDb>, buyer: string) => refusePrompt(d.client, { promptId: P, cause: "render", detail: "hidden text", buyerUserId: buyer });

  it("pauses only once two different buyers met it, counting renders only", async () => {
    const d = db(LIVE, [{ id: "r0", prompt_id: P, cause: "provider", buyer_user_id: "b0", created_at: new Date().toISOString(), reviewed_at: null }]);
    expect(await render(d, "b1")).toBe(false);
    expect(await render(d, "b1")).toBe(false);
    expect(listed(d)).toBe(true);
    expect(await render(d, "b2")).toBe(true);
    expect(listed(d)).toBe(false);
  });

  it("is meant lettering once an admin released a render refusal, never for another cause or decision", async () => {
    const { letteringReleased } = await import("@/lib/moderation/prompt-pause");
    const with_ = (row: Record<string, unknown>) => letteringReleased(db(LIVE, [{ id: "r1", prompt_id: P, ...row }]).client, P);
    expect(await with_({ cause: "render", decision: "released" })).toBe(true);
    expect(await with_({ cause: "render", decision: "delisted" })).toBe(false);
    expect(await with_({ cause: "render", decision: null })).toBe(false);
    expect(await with_({ cause: "provider", decision: "released" })).toBe(false);
    expect(await letteringReleased(db(LIVE, [], { prompt_refusals: { message: "missing" } }).client, P)).toBe(false);
  });
});

describe("the admin's list, however many refusals are open", () => {
  it("never loses a paused prompt behind hundreds of other open refusals", async () => {
    const many = Array.from({ length: 600 }, (_, i) => ({ id: `u${i}`, prompt_id: `other-${i}`, cause: "provider", paused: false, reviewed_at: null, created_at: "2026-10-27T12:00:00Z" }));
    const d = db({ ...LIVE, is_listed: false }, [...many, { id: "p", prompt_id: P, cause: "moderation", detail: "violence", paused: true, reviewed_at: null, created_at: "2026-10-01T00:00:00Z" }]);
    expect((await pausedPrompts(d.client)).map((p) => p.promptId)).toEqual([P]);
  });
});
