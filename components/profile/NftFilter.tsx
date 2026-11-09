"use client";

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type Dispatch, type MouseEvent, type ReactNode, type SetStateAction } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, ImageOff, Loader2, Sparkles, X } from "lucide-react";
import BottomSheet from "@/components/kit/BottomSheet";
import { panelStyle, placePanel, usePanelPos } from "@/components/kit/panel-pos";
import { walletsChangedRecently } from "@/components/settings/link-wallet";
import type { Nft } from "@/components/enki/NftGrid";
import NftTile, { NftCheckNote } from "@/components/enki/NftTile";
import { useNftChecks } from "@/hooks/useNftChecks";
import { failureSentence } from "@/lib/search/client";
import { sessionAuthHeaders } from "@/lib/session-headers";
import { menuMode } from "@/lib/ui/kit/controls";
import "./nft-filter.css";

const TITLE = "Filter by NFT";

const trigger: CSSProperties = {
  padding: "20px 6px", background: "none", border: "none", borderBottom: "2px solid transparent",
  // The ring inside: the tab row clips what lies outside the button.
  fontSize: 14, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6, whiteSpace: "nowrap", borderRadius: 8, outlineOffset: -4,
};

/** A press on what goes away with the press (Try again, Clear): the focus stays in the menu, not on the body. */
const stayInMenu = (e: MouseEvent<HTMLElement>) => e.currentTarget.closest<HTMLElement>('[role="dialog"]')?.focus({ preventScroll: true });

/** The Helius tile, never the NFT's own host; one that does not load is a plain tile, not a broken icon. */
function NftPicture({ nft }: { nft: Nft }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <span className="pf-nft-pic pf-nft-none"><ImageOff size={18} aria-hidden /></span>;
  /* eslint-disable-next-line @next/next/no-img-element */
  return <img className="pf-nft-pic" src={nft.thumb} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setFailed(true)} />;
}

/** What the checked NFTs show in place of a tab (Kev, 2026-11-03: "sodass diese dann unten aufgezeigt werden"). */
export function NftWall({ nfts }: { nfts: readonly Nft[] }) {
  return (
    <section className="pf-nft-wall" aria-label="Checked NFTs">
      {nfts.map((nft) => (
        <figure key={nft.id} className="pf-nft-card">
          <NftPicture nft={nft} />
          <figcaption className="pf-nft-name" title={nft.name}>{nft.name}</figcaption>
        </figure>
      ))}
    </section>
  );
}

/**
 * Filter by NFT on a profile (Kev, 2026-11-03): "alle NFTs ..., wobei ich die dann an der ecke oben links ein und
 * auschecken kann". The image UI's menu, a popover from 1024 px and a sheet below, that stays open while tiles are
 * ticked; `checked` lives with the profile, which shows them in place of its tab. The kit's pieces rather than
 * PillMenu, whose face, listbox and option rows are all it is (DEC-2026-11-03-17).
 *
 * The list is a metered read, so only a press asks for it: never a profile's load, a tab or a re-render, and it does
 * not ask by itself again, a failure included.
 */
export default function NftFilter({ viewer, checked, onChecked }: {
  viewer: string | null;
  checked: readonly Nft[];
  onChecked: Dispatch<SetStateAction<Nft[]>>;
}) {
  const { pos, open, toggle, trigRef, wrapRef, panelRef } = usePanelPos(0, true);
  const [sheet, setSheet] = useState(false);
  const { data, error, isFetching, refetch } = useQuery<{ nfts: Nft[]; wallets: number }, Error>({
    queryKey: ["wallet-nfts", viewer],
    // On while the menu is open: a closed menu is out of reach of the app's resetQueries and invalidateQueries, so only a
    // press asks. A failure waits for Try again, whose refetch asks past this.
    enabled: (q) => (open || sheet) && q.state.status !== "error",
    staleTime: 5 * 60_000,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    // Offline it asks now and fails, in words with a Try again; react-query's default would wait, say Loading for as
    // long, and fire by itself on reconnect.
    networkMode: "always",
    queryFn: async () => {
      // Past the browser's minute after a link or unlink in Settings, as the picker reads it (NftGrid).
      const res = await fetch("/api/wallet/nfts", {
        headers: sessionAuthHeaders(), cache: walletsChangedRecently() ? "reload" : "default",
      }).catch(() => null);
      if (!res?.ok) throw new Error(res ? await failureSentence(res, "NFTs unavailable") : "NFTs unavailable");
      return res.json();
    },
  });

  const checks = useNftChecks((open || sheet) && !!data?.nfts.length);

  // Focus goes in when the menu opens, not again each time it is placed anew; it is placed anew once the list is in,
  // which may need the other side of the trigger.
  const focused = useRef(false);
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const trig = trigRef.current;
    if (!pos || !panel || !trig) {
      focused.current = false;
      return;
    }
    placePanel(panel, trig);
    if (!focused.current) {
      focused.current = true;
      (panel.querySelector<HTMLElement>(".pf-nft-tile") ?? panel).focus({ preventScroll: true });
    }
    return () => {
      // With the menu gone to the button; with a control gone from an open menu (the tiles of a list read anew), to the menu.
      if (!document.activeElement || document.activeElement === document.body) (panelRef.current ?? trig).focus({ preventScroll: true });
    };
  }, [pos, isFetching, panelRef, trigRef]);

  // On a phone the tab row slides: the first check brings its X out from past the row's end.
  const clearRef = useRef<HTMLButtonElement>(null);
  const anyChecked = checked.length > 0;
  useEffect(() => {
    if (anyChecked) clearRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [anyChecked]);

  const press = () => {
    if (menuMode(window) === "sheet") setSheet(true);
    else toggle();
  };
  const on = new Set(checked.map((n) => n.id));
  const flip = (nft: Nft) => onChecked((now) => (now.some((n) => n.id === nft.id) ? now.filter((n) => n.id !== nft.id) : [...now, nft]));

  let body: ReactNode;
  if (error) {
    body = (
      <div className="pf-nft-note" role="alert">
        <ImageOff size={14} aria-hidden /> <span>{error.message}</span>
        {/* Only this asks again. */}
        <button type="button" className="ek-btn kit-hit" onClick={(e) => { stayInMenu(e); void refetch(); }}>Try again</button>
      </div>
    );
  } else if (!data) {
    body = <div className="pf-nft-note" role="status"><Loader2 size={14} aria-hidden style={{ animation: "kit-spin 1s linear infinite" }} /> Loading the NFTs…</div>;
  } else if (!data.nfts.length) {
    // No wallet is not no NFTs.
    body = (
      <div className="pf-nft-note">
        {data.wallets
          ? `No NFTs in your ${data.wallets === 1 ? "wallet" : "wallets"}.`
          : "No Solana wallet is linked to this account yet."}
      </div>
    );
  } else {
    body = (
      <>
        <div className="pf-nft-bar">
          <span>{data.nfts.length.toLocaleString("en-US")} {data.nfts.length === 1 ? "NFT" : "NFTs"}</span>
          {checked.length > 0 && <button type="button" className="pf-nft-clear kit-hit" onClick={(e) => { stayInMenu(e); onChecked([]); }}>Clear</button>}
        </div>
        <div className="pf-nft-grid" role="group" aria-label={TITLE}>
          {data.nfts.map((nft) => (
            <NftTile key={nft.id} nft={nft} checks={checks} on={on.has(nft.id)} onUse={() => flip(nft)} className="pf-nft-tile kit-hit" picture={<NftPicture nft={nft} />}>
              <span className="pf-nft-check" aria-hidden><Check size={13} strokeWidth={3} /></span>
              <span className="pf-nft-name">{nft.name}</span>
            </NftTile>
          ))}
        </div>
        <NftCheckNote checks={checks} />
      </>
    );
  }

  return (
    <div ref={wrapRef} style={{ display: "inline-flex", alignItems: "center", marginLeft: 10, flexShrink: 0 }}>
      <button ref={trigRef} type="button" className="kit-focus" aria-haspopup="dialog" aria-expanded={open || sheet} onClick={press}
        style={{ ...trigger, color: checked.length ? "var(--enki-ink)" : "var(--enki-ink-3)", fontWeight: checked.length ? 600 : 400 }}>
        <Sparkles size={14} /> {TITLE}
        {checked.length > 0 && <span className="mono" style={{ fontSize: 11, opacity: 0.6 }}>{checked.length}</span>}
        <ChevronDown size={12} />
      </button>
      {checked.length > 0 && (
        <button ref={clearRef} type="button" className="pf-nft-x kit-hit kit-focus" aria-label="Clear the NFT filter" title="Clear the NFT filter" onClick={() => { trigRef.current?.focus({ preventScroll: true }); onChecked([]); }}>
          <X size={14} aria-hidden />
        </button>
      )}
      {pos && createPortal(
        <div ref={panelRef} className="kit-menu-panel kit-focus pf-nft-panel" role="dialog" aria-label={TITLE} tabIndex={-1} style={panelStyle(pos)}>
          <div className="kit-menu-head"><span>{TITLE}</span></div>
          {body}
        </div>,
        document.body,
      )}
      <BottomSheet open={sheet} title={TITLE} onClose={() => setSheet(false)}>{body}</BottomSheet>
    </div>
  );
}
