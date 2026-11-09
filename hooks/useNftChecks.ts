"use client";

/**
 * The verdicts behind the NFT tiles (Kev, 2026-11-03: "keep all NFTs first ausgegraut und erst beim anclicken darauf
 * prüfen wir"), shared by the reference picker and Filter by NFT. The server holds them and every limit
 * (app/api/wallet/nfts/check); this reads them while `active` and asks for a press. A click's state is drawn before the
 * next click, so the tile's busy is what keeps a second press from asking.
 */
import { useEffect, useState } from "react";
import { sessionAuthHeaders } from "@/lib/session-headers";
import type { Nft } from "@/components/enki/NftGrid";
import type { NftCheck } from "@/lib/nft-check";

const ROUTE = "/api/wallet/nfts/check";

export type NftChecks = ReturnType<typeof useNftChecks>;

export function useNftChecks(active: boolean) {
  const [checks, setChecks] = useState<Record<string, NftCheck>>({});
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  // What the last press came to, in words: a failure, a refusal's reason, what an 18+ one means, when a renewal opens.
  const [note, setNote] = useState<string | null>(null);
  const [failed, setFailed] = useState<Record<string, string>>({});
  // The saved verdicts could not be read, so any tile may be one that never draws. Before SQL 65 there are none to read.
  const [unread, setUnread] = useState(false);

  // Each open reads anew: a verdict may have come from the other surface, or another device.
  useEffect(() => {
    if (!active) return;
    let live = true;
    const blind = () => {
      setUnread(true);
      setNote("Your NFT checks could not be read, so their pictures stay hidden. Press one to check it.");
    };
    fetch(ROUTE, { headers: sessionAuthHeaders(), cache: "no-store" })
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (!live) return;
        if (res.ok) {
          setUnread(false);
          setChecks((now) => ({ ...now, ...body?.checks }));
        // SQL 65 not run yet says so here, before any press. Signed out is the list's to say.
        } else if (body?.run) setNote(body.error);
        else if (res.status !== 401) blind();
      })
      .catch(() => { if (live) blind(); });
    return () => { live = false; };
  }, [active]);

  const ask = async (nft: Nft, renew: boolean) => {
    setBusy((now) => new Set(now).add(nft.id));
    setNote(null);
    const res = await fetch(ROUTE, {
      method: "POST",
      headers: { ...sessionAuthHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ id: nft.id, image: nft.image, proof: nft.proof, ...(renew && { renew }) }),
    }).catch(() => null);
    const body = (await res?.json().catch(() => null)) as { check?: NftCheck; error?: string } | null;
    const check = body?.check;
    if (check) setChecks((now) => ({ ...now, [nft.id]: check }));
    const trouble = res?.ok ? null : body?.error ?? "The NFT check is unavailable right now. Try again in a moment.";
    // Read on a grey tile only, so a verdict makes an old failure moot.
    if (trouble) setFailed((now) => ({ ...now, [nft.id]: trouble }));
    if (trouble) setNote(`${nft.name}: ${trouble}`);
    else if (check?.why) setNote(`${nft.name}: ${check.why}`);
    setBusy((now) => { const next = new Set(now); next.delete(nft.id); return next; });
    return check;
  };

  return { checks, busy, note, setNote, failed, unread, ask };
}
