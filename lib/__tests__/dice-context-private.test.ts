import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * The dice asks xAI for variable values and sends the prompt's stored excerpt
 * as context. For a paid prompt that excerpt was the artist's secret text,
 * sent to a third party on every roll.
 */

let promptRow: Record<string, unknown>;
// Who the session owns prompts as (lib/session-user resolveOwnerIds).
let owners: string[] = [];

vi.mock("@/lib/supabaseServer", () => ({
  getSupabaseServerClient: () => ({
    from: (table: string) => {
      const q: Record<string, unknown> = {
        maybeSingle: async () => ({ data: promptRow, error: null }),
        then: (ok: (v: unknown) => unknown) =>
          Promise.resolve({
            data: table === "prompt_variables" ? [{ name: "subject", label: "Subject", data_type: "text" }] : [],
            error: null,
          }).then(ok),
      };
      for (const m of ["select", "eq", "is", "order"]) q[m] = () => q;
      return q;
    },
  }),
}));
vi.mock("@/lib/auth", () => ({ requireAuth: async () => ({ userId: "u1" }), checkRateLimit: () => true }));
vi.mock("@/lib/session-user", () => ({ resolveOwnerIds: async () => owners }));
vi.mock("@/lib/rate-limit", () => ({
  checkRequestRateLimit: () => ({ allowed: true }),
  rateLimitKey: () => "k",
  rateLimitResponse: () => new Response(null, { status: 429 }),
}));

import { POST as dice } from "../../app/api/workflow/variables/route";

const SECRET = "the artist's secret words around [subject]";
const LIVE = { is_listed: true, listing_status: "active", deleted_at: null };

async function roll(): Promise<{ status: number; sent: string | null }> {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  const res = await dice(new NextRequest("http://localhost/api/workflow/variables", {
    method: "POST",
    headers: { "X-Session-Token": "tok" },
    body: JSON.stringify({ promptId: "11111111-1111-4111-8111-111111111111" }),
  }));
  const call = fetchMock.mock.calls[0] as unknown[] | undefined;
  return { status: res.status, sent: call ? String((call[1] as RequestInit).body) : null };
}
const sentToXai = async () => (await roll()).sent ?? "";

beforeEach(() => { vi.stubEnv("XAI_API_KEY", "test-key"); owners = []; });
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("a dice roll's context", () => {
  it("never carries a paid prompt's words", async () => {
    promptRow = { prompt_type: "paid", public_prompt_text: SECRET, title: "Moody", description: "A portrait", ...LIVE };
    expect(await sentToXai()).not.toContain("secret words");
  });

  it("gives a paid prompt its title and description instead", async () => {
    promptRow = { prompt_type: "paid", public_prompt_text: SECRET, title: "Moody", description: "A portrait", ...LIVE };
    expect(await sentToXai()).toContain("Moody - A portrait");
  });

  it("keeps a live free prompt's excerpt", async () => {
    promptRow = { prompt_type: "free", public_prompt_text: "a free [subject]", title: "Free", ...LIVE };
    expect(await sentToXai()).toContain("a free [subject]");
  });

  it("never carries the excerpt of a free prompt that is not released, even for its creator", async () => {
    owners = ["creator"];
    for (const unreleased of [{ is_listed: false }, { listing_status: "delisted" }, { deleted_at: "2026-10-01T00:00:00Z" }]) {
      promptRow = { prompt_type: "free", public_prompt_text: "a draft [subject]", title: "Draft", creator_id: "creator", ...LIVE, ...unreleased };
      const body = await sentToXai();
      expect(body).not.toContain("a draft [subject]");
      expect(body).toContain("Draft");
    }
  });
});

// ENC review (2026-10-27): a prompt not on sale is its creator's alone, its variable names and options included.
describe("a roll on a prompt not on sale", () => {
  it("is refused to anyone but its creator, before anything is asked of the model", async () => {
    for (const unreleased of [{ is_listed: false }, { listing_status: "delisted" }, { deleted_at: "2026-10-01T00:00:00Z" }]) {
      promptRow = { prompt_type: "paid", title: "Draft", creator_id: "creator", ...LIVE, ...unreleased };
      for (const who of [[], ["someone-else"]]) {
        owners = who;
        expect(await roll()).toEqual({ status: 404, sent: null });
      }
    }
  });

  it("rolls for its creator, and for anyone once it is on sale", async () => {
    promptRow = { prompt_type: "paid", title: "Draft", creator_id: "creator", ...LIVE, is_listed: false };
    owners = ["creator"];
    expect((await roll()).status).toBe(200);
    promptRow = { prompt_type: "paid", title: "Live", creator_id: "creator", ...LIVE };
    owners = [];
    expect((await roll()).status).toBe(200);
  });
});
