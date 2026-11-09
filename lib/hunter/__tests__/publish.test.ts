import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { publishImported } from "../publish";

/**
 * A hunted post is published the way a referred one is: through POST
 * /api/prompt with the sealed preview, as the publisher account, which holds
 * a session for the call and loses it right after, whatever the outcome.
 */
const mocks = vi.hoisted(() => ({ mint: vi.fn(async () => ({ token: "tok-1", expiresAt: "2026-10-15T00:00:00.000Z" })) }));
vi.mock("@/lib/user-session", () => ({ mintUserSession: mocks.mint }));
// The publisher account has a second factor: the real step-up gate must still let its own call through (MFA-4).
vi.hoisted(() => { process.env.AUTH_PEPPER = Buffer.alloc(32, 7).toString("base64"); });
vi.mock("@/lib/mfa", () => ({ enrolledFactors: async () => ["passkey"] }));
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => ({}) }));
import { requireStepUp } from "@/lib/webauthn";

function fakeDb() {
  const deleted: unknown[][] = [];
  const from = (table: string) => ({
    delete: () => ({ eq: (...a: unknown[]) => { deleted.push([table, ...a]); return Promise.resolve({ error: null }); } }),
  });
  return { deleted, client: { from } as unknown as SupabaseClient };
}

const INPUT = { publisherId: "u-pub", token: "sealed", title: "Lighthouse keeper", category: "Characters", aiModel: "Nano Banana Pro", aiModels: ["Nano Banana Pro", "GPT-Image-2"], photoCount: 2 };
const answer = (status: number, body: unknown) => async (_req: Request) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => mocks.mint.mockClear());

describe("publishImported", () => {
  it("calls the prompt route in process, as the publisher, with the sealed preview and a free release", async () => {
    const POST = vi.fn(answer(200, { id: "p-1" }));
    const { client, deleted } = fakeDb();
    const out = await publishImported(client, INPUT, async () => ({ POST }));
    expect(out).toEqual({ ok: true, promptId: "p-1" });
    expect(mocks.mint).toHaveBeenCalledWith("u-pub");
    const req = POST.mock.calls[0][0] as Request;
    expect(req.method).toBe("POST");
    expect(req.url).toBe("http://enki.internal/api/prompt");
    expect(req.headers.get("X-Session-Token")).toBe("tok-1");
    expect(await req.json()).toEqual({
      imported: "sealed", title: "Lighthouse keeper", category: "Characters", aiModel: "Nano Banana Pro", aiModels: ["Nano Banana Pro", "GPT-Image-2"],
      promptType: "free-prompt", price: 0, release: true, content: "", photoCount: 2, variables: [], uploadedPhotos: [], referenceImages: [],
    });
    expect(deleted).toEqual([["auth_sessions", "token", "tok-1"]]);
  });

  it("carries its own add-prompt step-up, so a publisher with a second factor still publishes (MFA-4)", async () => {
    const POST = vi.fn(answer(200, { id: "p-1" }));
    await publishImported(fakeDb().client, INPUT, async () => ({ POST }));
    const req = POST.mock.calls[0][0] as Request;
    expect(await requireStepUp(req, "u-pub", "add-prompt")).toBeNull();
    // Bound to the publisher and the scope: it opens nothing else.
    expect((await requireStepUp(req, "u-other", "add-prompt"))?.status).toBe(401);
    expect((await requireStepUp(req, "u-pub", "add-image"))?.status).toBe(401);
  });

  it("hands back the route's refusal, and a failure, and drops the session either way", async () => {
    const { client, deleted } = fakeDb();
    expect(await publishImported(client, INPUT, async () => ({ POST: answer(400, { error: "This import has expired. Paste the link again." }) })))
      .toEqual({ ok: false, error: "This import has expired. Paste the link again." });
    expect(await publishImported(client, INPUT, async () => ({ POST: answer(500, "not json") })))
      .toEqual({ ok: false, error: "publish failed (500)" });
    expect(await publishImported(client, INPUT, async () => ({ POST: answer(200, { ok: true }) })))
      .toEqual({ ok: false, error: "publish failed (200)" });
    expect(await publishImported(client, INPUT, async () => { throw new Error("route gone"); }))
      .toEqual({ ok: false, error: "route gone" });
    expect(deleted).toHaveLength(4);
  });
});
