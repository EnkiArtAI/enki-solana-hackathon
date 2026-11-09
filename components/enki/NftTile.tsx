"use client";

/**
 * One NFT, on the reference picker and in Filter by NFT alike (Kev, 2026-11-03): "keep all NFTs first ausgegraut und erst
 * beim anclicken darauf prüfen wir ... zeigen es visuell mit entweder einem grünen rand oder einem roten rand", with "einem
 * aktualisieren zeichen direkt am bild". Grey: a press checks it. Green: a press uses it, as the surface does. Red: a press
 * says why, and only a red one has the renewal (Kev, 2026-11-04: "5 am tag aktualisierungen gelten nur pro abgelehntes NFT
 * dann"). The press is one button and the renewal its neighbour on the picture, since a button holds no button.
 *
 * A red tile draws its picture greyed (Kev, 2026-11-04: "rote NFTs, doch zeig sie, aber nur halt ausgegraut mitm roten
 * rahmen."), or a plain placeholder where the server says picture: false (lib/nft-check nftVerdict).
 */
import type { MouseEvent, ReactNode } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import type { Nft } from "@/components/enki/NftGrid";
import type { NftChecks } from "@/hooks/useNftChecks";
import "./nft-tile.css";

export default function NftTile({ nft, checks, on, onUse, className, picture, children }: {
  nft: Nft;
  checks: NftChecks;
  /** Marked or ticked, on the surface that holds that. */
  on: boolean;
  onUse: () => void;
  className: string;
  picture: ReactNode;
  children?: ReactNode;
}) {
  const check = checks.checks[nft.id];
  const busy = checks.busy.has(nft.id);
  const allowed = check?.verdict === "allowed";
  const refused = check?.verdict === "refused";
  const failed = checks.failed[nft.id];
  const words = busy ? `${nft.name}: being checked` : allowed ? (check.why ? `${nft.name}: ${check.why}` : nft.name) : refused ? `${nft.name}: refused. ${check.why}` : `${nft.name}: ${failed ?? "press to check it"}`;
  // aria-disabled, not disabled: the focus stays where it is, and a press on a closed one can say when it opens.
  const closed = !!check && !check.left;
  const opens = check?.opensAt ? new Date(check.opensAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  const renewWords = closed ? `No renewals left today. Opens again at ${opens}.` : `Renew the check of ${nft.name} (${check?.left} left today)`;

  const press = () => {
    if (busy) return;
    if (allowed) onUse();
    else if (refused) checks.setNote(`${nft.name}: ${check.why}`);
    else void checks.ask(nft, false);
  };
  const renew = async ({ currentTarget: button }: MouseEvent<HTMLButtonElement>) => {
    if (busy) return;
    // A tab left open past the hour asks: the server holds the limit, and its answer draws the icon anew.
    if (closed && Date.parse(check.opensAt ?? "") > Date.now()) return checks.setNote(`${nft.name}: ${renewWords}`);
    const main = button.previousElementSibling as HTMLElement;
    // Back green the renewal goes, and the focus with it to the body: it stays on this tile.
    if ((await checks.ask(nft, true))?.verdict === "allowed" && (document.activeElement === button || !button.isConnected)) main.focus({ preventScroll: true });
  };

  return (
    <div className="nft-tile" data-check={check?.verdict ?? "grey"} data-busy={busy || undefined}>
      <button type="button" className={className} title={words} aria-label={allowed ? undefined : words}
        {...(allowed ? { role: "checkbox", "aria-checked": on } : {})} aria-busy={busy || undefined} aria-disabled={busy || refused || undefined} onClick={press}>
        {(refused && check.picture === false) || (!check && checks.unread) ? <span className="nft-tile-blank" aria-hidden /> : picture}
        {children}
      </button>
      {busy && <span className="nft-tile-spin" aria-hidden><Loader2 size={18} /></span>}
      {refused && (
        <button type="button" className="nft-tile-renew kit-hit" title={renewWords} aria-label={renewWords} aria-disabled={busy || closed || undefined} onClick={renew}>
          <RefreshCw size={13} aria-hidden />
        </button>
      )}
    </div>
  );
}

/** The last press's words, where they stay in view however far the tiles are scrolled. */
export function NftCheckNote({ checks }: { checks: NftChecks }) {
  return <p className="nft-check-note" aria-live="polite" hidden={!checks.note}>{checks.note}</p>;
}
