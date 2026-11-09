/**
 * The price chip on Generate and the balance in the cost line. Every number
 * charged is the server's; until it answers, the catalogue's own number
 * stands in, marked as an estimate.
 */
import { microToUsd, type GenerationQuote } from "@/lib/generation-checkout";

/** What a paid generator is shown to cost before the server has said, where its row carries no price. */
export const ESTIMATE_USD = 0.1;

/**
 * The price before the server has answered: the generator's catalogue price
 * per image, $0.10 where it carries none (Kev, 2026-10-13: "the initial price
 * must always be some premade one"). It lets Generate go, but is never shown
 * as a number: the chip and the menus read "…" until the server's price is
 * there (Kev, 2026-10-29: "i dont want to switch between werten, type dann
 * einfach "..." als son loading section dadrin"). The intent charges the
 * server's price, never this one. Null for the free host and for no
 * generator: nothing is priced there.
 */
export function estimatedQuote(entry: { free: boolean; price: number } | undefined): GenerationQuote | null {
  if (!entry || entry.free) return null;
  const totalMicro = Math.round((entry.price > 0 ? entry.price : ESTIMATE_USD) * 1_000_000);
  return { totalMicro, totalUsd: microToUsd(totalMicro), networkFeeUsd: "0", artistUsd: "0", expiresAt: "", appliedRule: null, estimated: true };
}

/**
 * The chip: "$0.00" on the free host (never the word "free", plan R30), the
 * server's total, "…" while it is being asked (the estimate standing in, or
 * nothing yet), and nothing when there is no price to show (signed out,
 * prompt unavailable). `count` images cost `count` times the total.
 */
export function chipLabel({ signedIn, free, quote, pending, count = 1 }: {
  signedIn: boolean;
  free: boolean;
  quote: GenerationQuote | null;
  pending: boolean;
  count?: number;
}): string | null {
  if (!signedIn) return null;
  if (free) return "$0.00";
  if (quote?.estimated) return "…";
  if (quote) return `$${count === 1 ? quote.totalUsd : microToUsd(quote.totalMicro * count)}`;
  return pending ? "…" : null;
}

/** Whether a render costs more than the balance, in integer micro-USDC: a float sum like $0.10 + $0.20 is not $0.30. */
export const overBalance = (balanceUsd: number, totalMicro: number) => Math.round(balanceUsd * 1_000_000) < totalMicro;

/**
 * The balance next to the price, or null where it would mislead: no payer, an
 * EVM address (it always reads $0.00, plan R27), or the free host (nothing to
 * pay). `short` turns it red; Generate stays clickable (handoff §0 "Balance").
 */
export function balanceView({ payer, ready, balance, free, quote, count = 1 }: {
  payer: string | null;
  ready: boolean;
  balance: number;
  free: boolean;
  quote: GenerationQuote | null;
  /** Images in the run: short when the balance cannot pay for all of them. */
  count?: number;
}): { text: string; short: boolean } | null {
  if (!payer || payer.startsWith("0x") || free) return null;
  if (!ready) return { text: "…", short: false };
  return { text: `$${balance.toFixed(2)}`, short: quote !== null && overBalance(balance, quote.totalMicro * count) };
}
