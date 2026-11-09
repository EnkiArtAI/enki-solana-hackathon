"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import NftGrid from "@/components/enki/NftGrid";
import BottomSheet from "@/components/kit/BottomSheet";
import Segmented from "@/components/kit/Segmented";
import { placeMenu, type MenuPlace } from "@/lib/ui/kit/controls";
import { storedHash, type SavedReference } from "@/hooks/useReferenceLibrary";
import StudioRefTiles from "@/components/studio/StudioRefTiles";
import type { NftPick } from "@/hooks/useReferenceReads";

export type RefTab = "images" | "characters" | "nfts";
const TABS: { key: RefTab; label: string }[] = [
  { key: "images", label: "Images" },
  { key: "characters", label: "Characters" },
  { key: "nfts", label: "NFTs" },
];

/** What the picker reads and asks: the image view's model (useImageViewModel) has it all; Create > Video hands its own
 *  (VideoComposer), the saved references with it. */
export interface RefSource {
  /** This visit's uploads not saved yet; a clip shows as itself (Create > Video). */
  uploads: ReadonlyArray<{ id: string; src: string; kind?: "image" | "clip" }>;
  library: readonly SavedReference[];
  deletedRefs: readonly string[];
  myImages: ReadonlyArray<{ url: string; src: string }>;
  /** What is in the prompt now, by the tiles' keys. */
  refs: ReadonlyArray<{ id: string }>;
  /** Pictures that still fit. */
  room: number;
  toggleRef: (key: string, at?: number) => void;
  deleteRef: (id: string) => void;
  addNfts: (picks: NftPick[], at?: number) => void;
}

/**
 * Where a reference photo comes from (Kev, 2026-10-21): a dropdown at the
 * button that asked, with three tabs. Images: a new upload, or one used or
 * uploaded before. Characters: a character's sheet (no store for them yet).
 * NFTs: the wallets' NFTs. A popover on desktop, a bottom sheet on a phone.
 */
export default function RefPicker({ model: m, anchor, phone, at, onUpload, onClose, uploads = false }: {
  model: RefSource;
  /** What was clicked; the popover opens beside it. */
  anchor: DOMRect;
  phone: boolean;
  /** Expert's cursor: a new slot's reference goes in there. */
  at?: number;
  /** Opens the device's file picker. */
  onUpload: () => void;
  onClose: () => void;
  /** Create > Video's: the first tab is "Uploads", pictures and clips (Kev, 2026-10-30: "bei videos, instead of images,
   *  mach da Uploads, and also show videos there"); its Upload stays open while pictures are full, as clips count apart. */
  uploads?: boolean;
}) {
  const [tab, setTab] = useState<RefTab>("images");
  const panel = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<MenuPlace | null>(null);

  useLayoutEffect(() => {
    if (phone || !panel.current) return;
    const size = { width: panel.current.offsetWidth, height: panel.current.offsetHeight };
    setPlace(placeMenu(anchor, size, { width: window.innerWidth, height: window.innerHeight }));
  }, [phone, anchor, tab, m.uploads.length, m.library.length]);
  // Into the popover once it stands in place, back to what asked when it closes on what had the focus (as
  // PillMenu does; the sheet keeps its own).
  const back = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!place || back.current) return;
    back.current = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLElement>("button:not(:disabled)")?.focus({ preventScroll: true });
  }, [place]);
  useEffect(() => () => {
    if (!document.activeElement || document.activeElement === document.body) back.current?.focus({ preventScroll: true });
  }, []);
  // The sheet closes itself; the popover on a click outside it, Esc, a scroll outside it or a resize, so it never
  // sits away from what asked (the kit's single-pick rule, panel-pos.ts).
  useEffect(() => {
    if (phone) return;
    const down = (e: PointerEvent) => { if (!panel.current?.contains(e.target as Node)) onClose(); };
    const scrolled = (e: Event) => { if (!panel.current?.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key, true);
    // From the next frame: the scroll its own opening caused (a place brought into view) is no reason to close.
    const late = requestAnimationFrame(() => window.addEventListener("scroll", scrolled, true));
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key, true);
      cancelAnimationFrame(late);
      window.removeEventListener("scroll", scrolled, true);
      window.removeEventListener("resize", onClose);
    };
  }, [phone, onClose]);

  const full = m.room <= 0;
  /* This visit's uploads first, in upload order, then the earlier images, wrapping on the grid. A tile is a switch
     (Kev, 2026-10-29: "uploaded images ... erst dort aufgezeigt ... auswählen, wodurch sie einen farbigen rand erhalten,
     und dann erst tauchen sie im prompt window auf. aber auto selecte die"; DEC-506): an upload arrives selected,
     selected means in the prompt with the photo ring, a press takes it out or back in, and the picker stays open.
     The account's saved references come next, newest first, each with a × (Kev, 2026-10-29: "must remain in that image
     upload UI until i delete them"; DEC-525), then the earlier renders' references that are no saved or deleted
     picture (a render's copy is named by the same hash). */
  const saved = new Set(m.library.map((l) => l.id));
  const known = new Set<string | undefined>([...m.library.map((l) => l.hash), ...m.deletedRefs]);
  const tiles: { key: string; src: string; id?: string; clip?: boolean }[] = [
    ...m.uploads.filter((u) => !saved.has(u.id)).map((u) => ({ key: u.id, src: u.src, clip: u.kind === "clip" })),
    ...m.library.map((l) => ({ key: l.id, src: l.src, id: l.id })),
    ...m.myImages.filter((p) => !known.has(storedHash(p.url))).map((p) => ({ key: p.url, src: p.src })),
  ];
  const body = (
    <div className="iv-rp-body">
      <Segmented role="tablist" ariaLabel="Where the reference comes from" value={tab} onChange={setTab}
        options={uploads ? TABS.map((t) => (t.key === "images" ? { ...t, label: "Uploads" } : t)) : TABS} />
      {tab === "images" && (
        <>
          <StudioRefTiles model={m} at={at} kind="assets" />
          <div className="iv-rp-grid">
            <button type="button" className="iv-rp-upload" disabled={full && !uploads} onClick={onUpload}>
              <span aria-hidden>+</span>Upload
            </button>
            {tiles.map(({ key, src, id, clip }) => {
              const on = m.refs.some((r) => r.id === key);
              const tile = (
                <button key={key} type="button" className="iv-rp-item" disabled={full && !on && !clip} aria-pressed={on}
                  data-on={on || undefined} title={on ? "In the prompt · press to take it out" : clip ? "Use this clip" : "Use this image"}
                  onClick={() => m.toggleRef(key, at)}>
                  {clip
                    ? <video src={src} muted loop playsInline autoPlay preload="metadata" />
                    // eslint-disable-next-line @next/next/no-img-element -- our own image, any size
                    : <img src={src} alt="" loading="lazy" draggable={false} />}
                </button>
              );
              return id ? (
                <div key={key} className="iv-rp-tile">
                  {tile}
                  <button type="button" className="iv-rp-del kit-hit" aria-label="Delete this reference" title="Delete"
                    onClick={() => m.deleteRef(id)}>×</button>
                </div>
              ) : tile;
            })}
          </div>
          {!tiles.length && (
            <p className="iv-rp-note">{uploads ? "The pictures and clips you upload show up here." : "The images you used or uploaded before show up here."}</p>
          )}
        </>
      )}
      {/* No character store yet: a character's picture goes in as an upload, on the Images tab where it lands (DEC-506). */}
      {tab === "characters" && (
        <>
          <StudioRefTiles model={m} at={at} kind="characters" />
          <div className="iv-rp-grid">
            <button type="button" className="iv-rp-upload" disabled={full} onClick={() => { setTab("images"); onUpload(); }}>
              <span aria-hidden>+</span>Add character
            </button>
          </div>
          <p className="iv-rp-note">Your characters and their sheets will show up here.</p>
        </>
      )}
      {tab === "nfts" && <NftGrid max={m.room} onPick={(picks) => m.addNfts(picks, at)} onDone={onClose} />}
      {full && <p className="iv-rp-note">Every photo place this generator takes is filled.</p>}
    </div>
  );

  if (phone) return <BottomSheet open title="Add a reference" onClose={onClose}>{body}</BottomSheet>;
  return createPortal(
    <div ref={panel} className="iv-rp kit-focus" role="dialog" aria-label="Add a reference"
      style={place ? { left: place.left, top: place.top, bottom: place.bottom, maxHeight: place.maxHeight } : { visibility: "hidden" }}>
      {body}
    </div>,
    document.body,
  );
}
