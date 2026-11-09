import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogueEntry } from "@/hooks/useModelLimits";
import type { GenerationQuote } from "@/lib/generation-checkout";
import type { Job } from "@/lib/ui/kit/render-queue";
import type { ImageViewModel } from "@/components/image-view/useImageViewModel";
import { quoteOf, type ImageSetup } from "../setups";

/* Regenerate and Retry in the viewer and on the stage (spec-imageview-mobile
   D10): useAgain asks the server for the job's own price and the button
   shows it and waits for it. Its only hook is the quote, which is stubbed
   so the hook runs as a plain function; the model's other hooks are stubbed
   as view-states does. */
vi.mock("@/components/BetaGate", () => ({ useBetaAccess: () => ({ access: "ok", role: "beta" }) }));
vi.mock("@/hooks/useViewerWallets", () => ({ useViewerWallets: () => ({ userKey: null, payer: null }) }));
vi.mock("@/hooks/useRenderQueue", () => ({ useRenderQueue: () => ({}) }));
type Price = { quote: GenerationQuote | null; pending: boolean; unavailable: boolean; failed: boolean };
const quoted = vi.hoisted(() => ({ asked: [] as unknown[], answer: null as unknown }));
vi.mock("@/hooks/useComposerQuote", () => ({
  useComposerQuote: (req: unknown) => {
    quoted.asked.push(req);
    return quoted.answer;
  },
}));

const { useAgain } = await import("@/components/image-view/useImageViewModel");

const entry = (free: boolean): CatalogueEntry => ({
  id: "m-nbp", name: "Nano Banana Pro", price: 0.1, mediaType: "image", supportsQuality: false,
  maxResolution: "4K", ratios: ["1:1"], boostTiers: ["4K"], boostAvailable: true, free,
});
const setup = (free = false): ImageSetup => ({
  promptId: "p1", model: entry(free), resolution: "4K", aspectRatio: "1:1", boost: true,
  prompt: "a fox", values: {}, edited: null, refs: ["data:a"], rows: [],
});
const job = (over: Partial<Job<ImageSetup>> = {}): Job<ImageSetup> => ({ id: "j1", createdAt: 0, status: "ready", setup: setup(), seen: true, ...over });
const quote: GenerationQuote = { totalMicro: 300_000, totalUsd: "0.30", networkFeeUsd: "0", artistUsd: "0", expiresAt: "", appliedRule: null };
const answer = (over: Partial<Price> = {}): Price => ({ quote: null, pending: false, unavailable: false, failed: false, ...over });
const model = (guest = false) => ({ guest, again: vi.fn() }) as unknown as ImageViewModel & { again: ReturnType<typeof vi.fn> };

beforeEach(() => {
  quoted.asked = [];
  quoted.answer = answer();
});

describe("Regenerate", () => {
  it("prices the finished render's own setup, never the composer's", () => {
    const j = job();
    expect(useAgain(model(), j)?.label).toBe("Regenerate");
    expect(quoted.asked).toEqual([quoteOf(j.setup)]);
  });

  it("shows that price and, on the press, hands the job and that price to the checked path", () => {
    quoted.answer = answer({ quote });
    const m = model();
    const j = job();
    const again = useAgain(m, j)!;
    expect(again.price).toBe("$0.30");
    expect(again.ready).toBe(true);
    again.press();
    expect(m.again).toHaveBeenCalledWith(j, quoted.answer);
  });

  // The estimate still lets it run, but reads …, never a second number (Kev, 2026-10-29).
  it("stands in with the catalogue's estimate until the price comes, reading …, and runs on it", () => {
    quoted.answer = answer({ pending: true });
    expect(useAgain(model(), job())).toMatchObject({ price: "…", ready: true });
    quoted.answer = answer({ failed: true });
    const m = model();
    const again = useAgain(m, job())!;
    expect(again).toMatchObject({ price: "…", ready: true });
    again.press();
    expect(m.again).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      failed: true, quote: expect.objectContaining({ estimated: true, totalMicro: 100_000 }),
    }));
  });

  it("is $0.00 and ready on the free host, which is never quoted", () => {
    expect(useAgain(model(), job({ setup: setup(true) }))).toMatchObject({ price: "$0.00", ready: true });
  });

  it("asks a guest's session-less quote for nothing", () => {
    useAgain(model(true), job());
    expect(quoted.asked).toEqual([null]);
  });
});

describe("Retry", () => {
  it("is offered for a failed render that cannot have been charged, at its own price", () => {
    const j = job({ status: "failed", error: { message: "Render failed · not charged · x", charged: "no" } });
    expect(useAgain(model(), j)?.label).toBe("Retry");
    expect(quoted.asked).toEqual([quoteOf(j.setup)]);
  });

  it("is not offered, nor priced, where the charge is unknown or the render still runs", () => {
    expect(useAgain(model(), job({ status: "failed", error: { message: "Connection lost", charged: "unknown" } }))).toBeNull();
    expect(useAgain(model(), job({ status: "rendering" }))).toBeNull();
    expect(useAgain(model(), undefined)).toBeNull();
    expect(quoted.asked).toEqual([null, null, null]);
  });
});

/* No Boost control in the Image View (plan Q4 and C1, Kev 2026-10-26): the flag stays wired and off (Kev 2026-10-13,
   boost-same-host.test.ts), and Regenerate or Recreate never copy it from a boosted render. */
describe("Boost", () => {
  it("is never loaded from an earlier render, so it stays off", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const MODEL = readFileSync(join(__dirname, "..", "..", "..", "..", "components", "image-view", "useImageViewModel.ts"), "utf8");
    // Nothing in the model sets it: not setBoost(job.boost) nor setBoost(recorded.boost), and no control calls m.setBoost.
    expect(MODEL.match(/setBoost\(/g) ?? []).toHaveLength(0);
  });
});
