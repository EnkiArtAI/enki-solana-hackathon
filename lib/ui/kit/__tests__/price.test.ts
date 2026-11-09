import { describe, it, expect } from "vitest";
import { chipLabel, overBalance, balanceView } from "../price";
import type { GenerationQuote } from "@/lib/generation-checkout";

const quote = (totalMicro: number, totalUsd: string): GenerationQuote => ({
  totalMicro,
  totalUsd,
  networkFeeUsd: "0.00",
  artistUsd: "0.00",
  expiresAt: "2026-10-09T12:05:00Z",
  appliedRule: null,
});
const q534 = quote(534_000, "0.534");

describe("chipLabel", () => {
  const base = { signedIn: true, free: false, quote: null, pending: false };
  it("shows $0.00 on the free host, never the word free", () => {
    expect(chipLabel({ ...base, free: true })).toBe("$0.00");
  });

  it("shows the server's total", () => {
    expect(chipLabel({ ...base, quote: q534 })).toBe("$0.534");
  });

  it("shows … while the price is being asked", () => {
    expect(chipLabel({ ...base, pending: true })).toBe("…");
  });

  it("shows nothing without a price, or when signed out", () => {
    expect(chipLabel(base)).toBeNull();
    expect(chipLabel({ ...base, signedIn: false, free: true })).toBeNull();
    expect(chipLabel({ ...base, signedIn: false, quote: q534 })).toBeNull();
  });
});

describe("overBalance", () => {
  it("compares in micro units: float dust in the balance never makes it short", () => {
    expect(overBalance(0.1 + 0.2, 300_000)).toBe(false);
    expect(overBalance(0.7 - 0.4, 300_000)).toBe(false);
  });

  it("is short by a single micro-dollar, and not at exactly the price", () => {
    expect(overBalance(0.3, 300_001)).toBe(true);
    expect(overBalance(0.3, 300_000)).toBe(false);
  });
});

describe("balanceView", () => {
  const base = { payer: "So1anaPayer111", ready: true, balance: 4.2, free: false, quote: q534 };
  it("shows the balance, red when the render costs more", () => {
    expect(balanceView(base)).toEqual({ text: "$4.20", short: false });
    expect(balanceView({ ...base, balance: 0.12 })).toEqual({ text: "$0.12", short: true });
    expect(balanceView({ ...base, balance: 0.12, quote: null })).toEqual({ text: "$0.12", short: false });
  });

  it("shows … until the balance is read", () => {
    expect(balanceView({ ...base, ready: false, balance: 0 })).toEqual({ text: "…", short: false });
  });

  it("is hidden without a payer, for an EVM address, and on the free host", () => {
    expect(balanceView({ ...base, payer: null })).toBeNull();
    expect(balanceView({ ...base, payer: "0xabc" })).toBeNull();
    expect(balanceView({ ...base, free: true })).toBeNull();
  });
});

/* The catalogue price stands in until the server answers (Kev, 2026-10-13:
   "the initial price must always be some premade one"): Generate goes, the
   chip says "~", and the intent charges the server's price. */
import { estimatedQuote, ESTIMATE_USD } from "../price";
import { quoteLabel } from "@/hooks/useServerQuotes";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";

describe("estimatedQuote", () => {
  it("is the generator's catalogue price per image, marked as an estimate", () => {
    expect(estimatedQuote({ free: false, price: 0.107 })).toEqual({
      totalMicro: 107_000, totalUsd: "0.107", networkFeeUsd: "0", artistUsd: "0", expiresAt: "", appliedRule: null, estimated: true,
    });
    expect(estimatedQuote({ free: false, price: 0.1 })).toMatchObject({ totalMicro: 100_000, totalUsd: "0.10" });
  });

  it("is $0.10 where the row carries no price, and nothing on the free host or without a generator", () => {
    expect(ESTIMATE_USD).toBe(0.1);
    expect(estimatedQuote({ free: false, price: 0 })).toMatchObject({ totalMicro: 100_000, totalUsd: "0.10", estimated: true });
    expect(estimatedQuote({ free: false, price: -1 })).toMatchObject({ totalMicro: 100_000 });
    expect(estimatedQuote({ free: true, price: 0 })).toBeNull();
    expect(estimatedQuote(undefined)).toBeNull();
  });

  // Kev, 2026-10-29: "i dont want to switch between werten, type dann einfach "..." als son loading section dadrin".
  it("reads … for the estimate on the chip and in the menus, never a second number; the server's price as it is", () => {
    const est = estimatedQuote({ free: false, price: 0.1 });
    expect(chipLabel({ signedIn: true, free: false, quote: est, pending: true })).toBe("…");
    expect(chipLabel({ signedIn: true, free: false, quote: est, pending: false, count: 3 })).toBe("…");
    expect(chipLabel({ signedIn: false, free: false, quote: est, pending: false })).toBeNull();
    expect(chipLabel({ signedIn: true, free: true, quote: est, pending: true })).toBe("$0.00");
    expect(quoteLabel(est)).toBe("…");
    expect(quoteLabel(est, 4)).toBe("…");
    expect(quoteLabel(q534, 2)).toBe("$1.068");
    expect(quoteLabel(q534)).toBe("$0.534");
    expect(chipLabel({ signedIn: true, free: false, quote: q534, pending: false })).toBe("$0.534");
  });

  it("stands in on both surfaces: the editor's prices and the image view's chip, gate and Regenerate", () => {
    const editor = readSource(join(__dirname, "..", "..", "..", "..", "components", "prompt-editor", "PromptEditor.tsx"));
    expect(editor).toContain("quoteIn(batch, quotes, quoteRequest(entry, at, n)) ?? estimatedQuote(entry)");
    const view = readSource(join(__dirname, "..", "..", "..", "..", "components", "image-view", "useImageViewModel.ts"));
    expect(view).toContain("const quoted = quote.quote ?? (guest ? null : estimatedQuote(setup?.model));");
    expect(view).toContain("chip: chipLabel({ signedIn: !guest, free: core.free, quote: quoted, pending: quote.pending, count }),");
    expect(view).toContain("perImage: chipLabel({ signedIn: !guest, free: core.free, quote: quoted, pending: quote.pending }),");
    expect(view).not.toContain("The price is on its way");
    expect(view).toContain("const priced = { ...price, quote: price.quote ?? (m.guest ? null : estimatedQuote(job.setup.model)) };");
  });
});
