"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Holdings — the user's spendable USD balance, persisted server-side.
 *
 * Source of truth is the wallet's OWN on-chain USDC balance, read via
 * /api/billing/balance (see lib/usdc-balance) — USDC is 1:1 to the dollar, so
 * this is already USD and every display formats it as $. Pass the signed-in
 * user's Solana address; without one we show 0.
 *
 * Every instance (navbar, settings, checkout) re-fetches when any of them calls
 * `refresh()` — it broadcasts a window event so the balance stays in sync after
 * a top-up.
 */
const HOLDINGS_EVENT = "enki-holdings-changed";

export function refreshHoldings() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(HOLDINGS_EVENT));
}

/** Said by a Generate that waits for the balance (Kev, 2026-10-14: grey until it is known, never a red $0.00). */
export const BALANCE_LOADING = "Your balance is still loading";

/** What the last answer said, and for whom. */
export type Holdings = { address: string | null; balance: number };

/** Ready only with an answer for this very address: another address's answer, or "no address", says nothing about it. */
export function holdingsOf(got: Holdings | null, address: string | null): { balance: number; ready: boolean } {
  const ready = got !== null && got.address === address;
  return { balance: ready ? got.balance : 0, ready };
}

export function useHoldings(address?: string | null) {
  // Keyed by the address it answers for: when the address arrives after the
  // first render, the $0.00 of "no address" must not stand in for it, or
  // Generate reads the balance as short and turns red for a moment (Kev, 2026-10-14).
  const key = address ?? null;
  const [got, setGot] = useState<Holdings | null>(null);

  const fetchBalance = useCallback(async () => {
    if (!key) { setGot({ address: null, balance: 0 }); return; }
    try {
      const res = await fetch(`/api/billing/balance?address=${encodeURIComponent(key)}`);
      // A failed read is no answer: it never stands in as $0.00, the previous answer for this address stays.
      if (res.ok) {
        const balance = Number((await res.json())?.balance) || 0;
        setGot({ address: key, balance });
      }
    } catch {
      /* transient: as above */
    }
  }, [key]);

  useEffect(() => {
    fetchBalance();
    const onChange = () => fetchBalance();
    window.addEventListener(HOLDINGS_EVENT, onChange);
    return () => window.removeEventListener(HOLDINGS_EVENT, onChange);
  }, [fetchBalance]);

  return { ...holdingsOf(got, key), refresh: fetchBalance };
}
