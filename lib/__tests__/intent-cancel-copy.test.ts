import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A cancelled intent image was never charged, so the launcher must not say a
 * payment is being refunded; escrow keeps its refund sentence (review
 * 2026-10-18). Pinned as text: the launcher has no component test.
 */
const read = (...p: string[]) => readFileSync(join(__dirname, "..", "..", ...p), "utf8").split("\r\n").join("\n");
const SRC = read("components", "GenerateLauncher.tsx");
const QUEUE = read("hooks", "useRenderQueue.ts");

describe("the cancel toast", () => {
  it("says the rest were not charged on the intent rail, and keeps the refund sentence for escrow", () => {
    expect(SRC).toContain('description: pendingOrder.payments[0].paymentScheme === "intent"\n        ? "Running images may still finish. The rest were not charged." : "Running images may still finish. The unused payment is being refunded."');
  });
});

describe("the other intent sentences (verification 2026-10-18)", () => {
  it("the restored-order check and an expired order say nothing was charged on the intent rail", () => {
    expect(SRC).toContain('const intent = receipt.paymentScheme === "intent";');
    expect(SRC).toContain('description: intent ? "This order was not paid. Nothing was charged."');
    expect(SRC).toContain('(intent ? "All image requests have finished. Images that did not arrive were not charged, or are refunded." : "All image requests have finished. Any unused payment is being refunded.")');
  });

  it("an expired order, or a finished unit, leaves no pending banner (round 4, 2026-10-19)", () => {
    expect(SRC).toContain("outcomes.flatMap((outcome, index) => awaitsPayment(outcome) && outcome.payment ?");
  });

  it("the queue hands its connect step through the one-at-a-time turn, and a cancelled job opens no window (verification 2026-10-18)", () => {
    expect(QUEUE).toContain('const taken = () => ids.every(id => cancelled.current.has(id));');
    expect(QUEUE).toContain('{ prepare: () => serial.current!(() => taken() ? Promise.reject(new Error("Cancelled before signing")) : latestSign.current.prepare?.() ?? Promise.resolve()) }));');
  });

  it("a queued intent job's cancel charged nothing", () => {
    expect(QUEUE).toContain('notify(job?.payment && job.payment.paymentScheme !== "intent" ? "Cancelled · its payment is being refunded" : "Cancelled · nothing was charged");');
  });
});
