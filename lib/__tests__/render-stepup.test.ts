import { describe, it, expect, beforeEach, vi } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";

/**
 * The render switch of the Settings table (Kev, 2026-10-17: "printen" =
 * rendering). The server asks at a render's first request; the client asks
 * the user once, shares that one confirmation with every render (parallel
 * jobs included) while it lasts, and asks anew when it was refused.
 */

const asks = vi.hoisted(() => ({ answer: "tok-1" as string | null, calls: 0 }));
vi.mock("@/components/StepUpProvider", async (orig) => ({
  ...(await orig<typeof import("@/components/StepUpProvider")>()),
  askStepUp: async () => { asks.calls++; await new Promise((r) => setTimeout(r, 5)); return asks.answer; },
}));

type Mod = typeof import("../ui/kit/render-stepup");
let mod: Mod;
// A fresh module each test (its held token is module state); the dialog's
// import tree is heavy, so a loaded machine gets more than the default 10 s.
beforeEach(async () => {
  vi.resetModules();
  mod = await import("../ui/kit/render-stepup");
  asks.answer = "tok-1";
  asks.calls = 0;
}, 30_000);

const ASK = () => new Response(JSON.stringify({ stepUp: true, scope: "render", factors: ["passkey"] }), { status: 401 });
const OK = () => new Response(JSON.stringify({ ok: true }), { status: 200 });
/** A server that wants `valid` as the render token. */
const server = (valid: string | null) => vi.fn(async (h: Record<string, string>) => (valid && h["X-StepUp-Token"] === valid ? OK() : ASK()));

describe("withRenderStepUp", () => {
  it("asks nothing when the server does not want a confirmation", async () => {
    const run = vi.fn(async () => OK());
    expect((await mod.withRenderStepUp(run)).status).toBe(200);
    expect(asks.calls).toBe(0);
    expect(run).toHaveBeenCalledOnce();
  });

  it("asks once and runs the request again with the token", async () => {
    const run = server("tok-1");
    expect((await mod.withRenderStepUp(run)).status).toBe(200);
    expect(asks.calls).toBe(1);
    expect(run.mock.calls.map(([h]) => h["X-StepUp-Token"])).toEqual([undefined, "tok-1"]);
  });

  it("sends the held confirmation with the next render and asks nothing", async () => {
    const run = server("tok-1");
    await mod.withRenderStepUp(run);
    run.mockClear();
    expect((await mod.withRenderStepUp(run)).status).toBe(200);
    expect(asks.calls).toBe(1);
    expect(run.mock.calls.map(([h]) => h["X-StepUp-Token"])).toEqual(["tok-1"]);
  });

  it("shares one dialog between parallel renders", async () => {
    const run = server("tok-1");
    const [a, b, c] = await Promise.all([mod.withRenderStepUp(run), mod.withRenderStepUp(run), mod.withRenderStepUp(run)]);
    expect([a.status, b.status, c.status]).toEqual([200, 200, 200]);
    expect(asks.calls).toBe(1);
  });

  it("asks anew when the held confirmation was refused", async () => {
    await mod.withRenderStepUp(server("tok-1"));
    asks.answer = "tok-2";
    const run = server("tok-2");
    expect((await mod.withRenderStepUp(run)).status).toBe(200);
    expect(asks.calls).toBe(2);
    expect(run.mock.calls.map(([h]) => h["X-StepUp-Token"])).toEqual(["tok-1", "tok-2"]);
  });

  it("hands back the refusal when the user cancels, and says so", async () => {
    asks.answer = null;
    const res = await mod.withRenderStepUp(server("tok-1"));
    expect(res.status).toBe(401);
    expect(await mod.cancelledStepUp(res)).toBe(true);
    expect(await mod.cancelledStepUp(new Response("{}", { status: 401 }))).toBe(false);
    expect(await mod.cancelledStepUp(OK())).toBe(false);
  });
});

describe("the renders go through it", () => {
  const src = (...p: string[]) => readSource(join(__dirname, "..", "..", ...p));

  it("a paid render at its intent, before anything is built or signed, and a cancel charges nothing", () => {
    const checkout = src("lib", "generation-checkout.ts");
    // The image's intent by default; a video's names its own, and asks the step-up at the same place.
    expect(checkout).toContain('abandoned?: () => boolean, intentPath = "/api/payments/generation/intent"): Promise<FundedEscrowCheckout> {');
    expect(checkout).toContain("try { intentRes = await withRenderStepUp((h) => post(intentPath, req, h)); }");
    expect(checkout).toContain('if (await cancelledStepUp(intentRes)) throw new CheckoutError("intent", NOT_CONFIRMED);');
    expect(checkout).toContain('const NOT_CONFIRMED = "Not confirmed. Nothing was charged.";');
    expect(checkout.indexOf("withRenderStepUp((h) =>")).toBeLessThan(checkout.indexOf('post("/api/payments/generation/authorize"'));
  });

  it("a free render at its only request; a paid unit's image request is not asked again", () => {
    const run = src("lib", "generation", "run-generation.ts");
    // A paid unit asks no step-up; it is sent once more only after the shared address limit (round 17, 2026-10-20).
    expect(run).toContain("const res = req.model!.free ? await withRenderStepUp(send) : await onceMoreAfterLimit(await send({}), () => send({}));");
    expect(run).toContain('if (await cancelledStepUp(res)) return { ok: false, phase: "generation", error: "Not confirmed. Nothing was generated.", status: 401 };');
  });

  it("the dialog is reachable from outside React while the provider is mounted", () => {
    const provider = src("components", "StepUpProvider.tsx");
    expect(provider).toContain("export const askStepUp: Ask = (scope, factors) => (mounted ? mounted(scope, factors) : Promise.resolve(null));");
    expect(provider).toContain("mounted = ask;\n    return () => { if (mounted === ask) mounted = null; };");
  });
});
