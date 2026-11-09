"use client";

/**
 * Every NFT in the signed-in account's wallets (Kev, 2026-08-22): grey until a
 * press checks it (NftTile); a press on a green one marks/unmarks, "Use N" hands
 * the marked images back as reference images. The body of NftPickerModal and of
 * the Image View's reference picker.
 */
import { useEffect, useState } from "react";
import { Check, Loader2, ImageOff } from "lucide-react";
import { sessionAuthHeaders } from "@/lib/session-headers";
import type { NftPick } from "@/hooks/useReferenceReads";
import { useEmailAuth } from "@/hooks/useEmailAuth";
import { useNftChecks } from "@/hooks/useNftChecks";
import NftTile, { NftCheckNote } from "@/components/enki/NftTile";
import LinkWalletButtons from "@/components/settings/LinkWalletButtons";
import { walletsChangedRecently } from "@/components/settings/link-wallet";
// Shared popup chrome (spinner, CTA button) + its own styles live here.
import "@/components/enki/bookmarks.css";

export type Nft = { id: string; name: string; image: string; thumb: string; collection: string | null; proof: string | null };

export default function NftGrid({ max, onPick, onDone }: {
  /** How many the caller can still take (free reference slots). */
  max: number;
  /** The marked NFTs, each read through our own route (useReferenceReads). */
  onPick: (picks: NftPick[]) => void;
  /** After "Use N". */
  onDone: () => void;
}) {
  const [nfts, setNfts] = useState<Nft[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // No wallet is not no NFTs: the empty list says which.
  const [wallets, setWallets] = useState(0);
  const [marked, setMarked] = useState<Set<string>>(new Set());
  // An email account can link a wallet right here (Settings → Profile has the list).
  const { isAuthed: emailAuthed } = useEmailAuth();
  // Bumped after a link here: read again, past the browser's one-minute copy of the list
  // (a link or unlink in Settings asks for the same through walletsChangedRecently).
  const [round, setRound] = useState(0);

  useEffect(() => {
    fetch("/api/wallet/nfts", { headers: { ...sessionAuthHeaders() }, cache: round || walletsChangedRecently() ? "reload" : "default" })
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || "NFTs unavailable");
        setWallets(d.wallets ?? 0);
        setNfts(d.nfts);
      })
      .catch((e: Error) => { setNfts([]); setProblem(e.message); });
  }, [round]);

  const toggle = (id: string) => setMarked((m) => {
    const next = new Set(m);
    if (next.has(id)) next.delete(id);
    else if (next.size < max) next.add(id);
    return next;
  });

  const checks = useNftChecks(!!nfts?.length);

  const use = () => {
    const picks = (nfts ?? []).filter((n) => marked.has(n.id)).map(({ image, thumb }) => ({ image, thumb }));
    if (picks.length) onPick(picks);
    onDone();
  };

  return (
    <>
      {nfts === null && <div className="enki-nftp-note"><Loader2 size={14} className="enki-bmp-spin" /> Loading your wallets…</div>}
      {problem && <div className="enki-nftp-note"><ImageOff size={14} /> {problem}</div>}
      {nfts?.length === 0 && !problem && (
        <div className="enki-nftp-note" style={{ flexDirection: "column", alignItems: "flex-start" }}>
          {wallets ? `No NFTs in your ${wallets === 1 ? "wallet" : "wallets"}.` : "No Solana wallet is linked to this account yet."}
          {emailAuthed && <LinkWalletButtons buttonClass="enki-bmp-go" onLinked={() => { setNfts(null); setRound((r) => r + 1); }} />}
        </div>
      )}
      {max <= 0 && <div className="enki-nftp-note">All image slots are full — remove one first.</div>}
      {!!nfts?.length && (
        <div className="enki-nftp-grid">
          {nfts.map((n) => (
            <NftTile key={n.id} nft={n} checks={checks} on={marked.has(n.id)} onUse={() => toggle(n.id)}
              className={"enki-nftp-item" + (marked.has(n.id) ? " on" : "")}
              picture={<img src={n.thumb} alt={n.name} draggable={false} loading="lazy" />}>
              {marked.has(n.id) && <span className="enki-nftp-check"><Check size={11} /></span>}
            </NftTile>
          ))}
        </div>
      )}
      <div className="enki-nftp-foot">
        <NftCheckNote checks={checks} />
        <span className="enki-nftp-count mono">{marked.size} / {max} selected</span>
        <button type="button" className="enki-bmp-go" disabled={!marked.size} onClick={use}>Use {marked.size || ""}</button>
      </div>
    </>
  );
}
