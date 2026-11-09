"use client";

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type DragEvent, type MouseEvent } from "react";
import { Icon } from "@/components/enki-shell/icons";
import { CARD_MAX, deckAt, deckLayout } from "@/lib/ui/image-view/deck";
import { deckHeight } from "@/lib/ui/image-view/layout";
import { ADD_PHOTOS_EVENT } from "@/lib/ui/image-view/slots";
import type { Rect } from "@/lib/ui/image-view/zoom";
import RefPicker from "./RefPicker";
import Zoom from "./Zoom";
import type { ImageViewModel } from "./useImageViewModel";

/** Before the first measurement: the prototype's own start values (S:188). */
const START = { phone: { width: 350, height: 110 }, desktop: { width: 520, height: 150 } };

/** The photo symbol with a plus, wherever a photo can be added (Kev, 2026-10-27: "das "photo" symbol reicht völlig,
    pack da eher nen plus zusätzlich hinzu"). */
const AddPhoto = ({ size }: { size: number }) => (
  <span className="iv-photo-addicon" aria-hidden>
    <Icon name="camera" size={size} stroke={1.5} />
    <span className="iv-photo-addplus"><Icon name="plus" size={Math.max(8, Math.round(size * 0.42))} stroke={2.6} /></span>
  </span>
);

/**
 * The buyer's photos (handoff §5.6, README §5.1): one tile per slot, "Reference
 * image k" in the text for slot k. Empty slots ask for a photo, the buyer's own
 * wear the bordeaux ring; × takes a slot out with its reference, Replace swaps
 * the photo, "+" or a drop of files adds one. Squares in one row that overlap
 * like cards once they do not fit; a click shows a photo whole (Zoom). An
 * empty place or "+" opens the reference picker (an upload, an earlier image,
 * a character, an NFT). The area takes the height the
 * rest of the scroller leaves (README §2, layout.ts deckHeight).
 */
export default function PhotoDeck({ model: m, phone = false, fixed = false, onSize }: {
  model: ImageViewModel;
  phone?: boolean;
  /** A plain prompt's photo area keeps its first size: its words take what the column leaves. A number: that height. */
  fixed?: boolean | number;
  /** The height a measured deck settled on, so another one can keep it (Composer). */
  onSize?: (height: number) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  // The slot a Replace fills; null when the input adds.
  const swapping = useRef<number | null>(null);
  const [area, setArea] = useState(phone ? START.phone : START.desktop);
  // The tapped tile on a phone: its × and Replace show (plan D12).
  const [hot, setHot] = useState<number | null>(null);
  const [over, setOver] = useState(false);
  // An own photo grown from its tile (handoff §5.15).
  const [zoom, setZoom] = useState<{ i: number; from: Rect } | null>(null);
  // The reference picker, open beside what asked for it.
  const [asking, setAsking] = useState<DOMRect | null>(null);
  /* A finger sliding along the phone's deck brings the card under it to the front, larger, to see it better (Kev,
     2026-10-26: "mit einem finger draufclicken und links und rechts führen kann um die bilder besser zu sehen"). It
     counts once it has moved 8 px sideways; until then a tap is a tap, and the click that ends a slide opens nothing. */
  const swipe = useRef<{ x: number; moved: boolean } | null>(null);
  const slid = useRef(false);
  // The area as drawn: small moves keep it, so onSize tells the height on screen (review 2026-10-27).
  const applied = useRef(area);
  const [scrub, setScrub] = useState(false);

  useLayoutEffect(() => {
    const deck = box.current;
    const scroller = deck?.closest<HTMLElement>("[data-scroll]");
    if (!deck || !scroller) return;
    const col = scroller.parentElement;
    const fit = () => {
      const cs = getComputedStyle(scroller);
      const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
      // The content's own extent, not scrollHeight: that never drops below clientHeight, so a short page would read
      // the deck's height back minus 4 on every measure. Hidden children (the file inputs) take no room.
      const kids = [...scroller.children].map((c) => c.getBoundingClientRect()).filter((r) => r.height > 0);
      const content = kids.length ? Math.max(...kids.map((r) => r.bottom)) - Math.min(...kids.map((r) => r.top)) : 0;
      // The scroller keeps its own height: what its column leaves below the last child (the foot) is free too.
      const last = col?.lastElementChild;
      const slack = col && last
        ? Math.max(0, col.getBoundingClientRect().bottom - parseFloat(getComputedStyle(col).paddingBottom) - last.getBoundingClientRect().bottom)
        : 0;
      const free = scroller.clientHeight - pad - (content - deck.offsetHeight) - 4 + slack;
      const height = typeof fixed === "number" ? fixed : fixed ? (phone ? START.phone : START.desktop).height : deckHeight(free, phone);
      const next = { width: deck.clientWidth, height };
      const prev = applied.current;
      const kept = Math.abs(prev.width - next.width) > 2 || Math.abs(prev.height - next.height) > 3 ? next : prev;
      applied.current = kept;
      setArea(kept);
      // A measured deck tells the height it shows, so the deck of the other mode keeps it (Composer).
      if (fixed === false) onSize?.(kept.height);
    };
    fit();
    const ro = new ResizeObserver(fit);
    // The scroller, what it holds, and the column around it: an x402 fold that closes gives its height back.
    for (const el of [scroller, ...scroller.children, ...(col?.children ?? [])]) ro.observe(el);
    return () => ro.disconnect();
  }, [phone, fixed, onSize]);

  useEffect(() => {
    // "Add N photos": the picker, at the first empty place, brought into view first (Generate stays put while the
    // composer scrolls, so the place may sit above it).
    const open = () => {
      const at = box.current?.querySelector(".iv-photo[data-empty]") ?? box.current;
      if (!at) return;
      at.scrollIntoView({ block: "nearest" });
      setAsking(at.getBoundingClientRect());
    };
    window.addEventListener(ADD_PHOTOS_EVENT, open);
    return () => window.removeEventListener(ADD_PHOTOS_EVENT, open);
  }, []);

  const count = m.slotTotal;
  /* "+" stands after the cards while the generator takes another photo, empty places or not: a new photo goes after the
     last one (Kev, 2026-10-29: "i also need the + image als standalone button on the right too to add more images. the
     add image always appends to signify that we can append images"; before, an empty place was the only way in). With no
     photo at all the empty place is the one way in, nothing beside it; a text that names no image draws it as the "+"
     (Kev, 2026-10-29: "if on image ui is no ref image at all, dann zeige auch nicht rechts diesen ref image zusatz, but
     just transform that quadratische ref image to the on the appending one"). */
  const photos = m.refs.length + m.pending.length;
  const canAdd = m.room > 0 && photos > 0;
  const lone = photos === 0 && count === 1 && m.photosNeeded === 0;
  const lay = deckLayout({ ...area, count, gap: phone ? 8 : 10, canAdd, addWidth: 48, max: phone ? Infinity : CARD_MAX });
  const pick = (slot: number | null) => {
    swapping.current = slot;
    input.current?.click();
  };
  const files = (list: FileList | null) => {
    const all = [...(list ?? [])];
    const slot = swapping.current;
    swapping.current = null;
    if (slot !== null && all[0]) m.replacePhoto(slot, all[0]);
    else if (all.length) m.addFiles(all);
  };
  const dragging = (e: DragEvent) => e.dataTransfer.types.includes("Files");
  const ask = (e: MouseEvent<HTMLElement>) => setAsking(e.currentTarget.getBoundingClientRect());

  return (
    <section className="iv-deck" aria-label="Your photos">
      <div ref={box} className="iv-deck-box" data-drop={over || undefined} data-scrub={scrub || undefined} data-overlap={lay.overlap || undefined}
        style={{ height: lay.height }}
        onPointerDown={(e) => {
          if (!phone || e.pointerType === "mouse" || (e.target as HTMLElement).closest(".iv-photo-x, .iv-photo-swap, .iv-photo-add")) return;
          swipe.current = { x: e.clientX, moved: false };
          slid.current = false;
        }}
        onPointerMove={(e) => {
          /* A mouse over overlapping cards peeks the one whose visible strip it is on (Kev, 2026-10-29: "via hover over
             diese leicht hochschauen"): the topmost card under it, which :hover picks, would hide the next ones' strips. */
          if (e.pointerType === "mouse") {
            if (!lay.overlap) return;
            const x = e.clientX - e.currentTarget.getBoundingClientRect().left, last = lay.tiles[lay.tiles.length - 1];
            return setHot(x < last.left + last.size ? deckAt(lay.tiles, x) : null);
          }
          const s = swipe.current;
          if (!s || (!s.moved && Math.abs(e.clientX - s.x) <= 8)) return;
          s.moved = true;
          slid.current = true;
          setScrub(true);
          setHot(deckAt(lay.tiles, e.clientX - e.currentTarget.getBoundingClientRect().left));
        }}
        onPointerUp={() => { swipe.current = null; setScrub(false); }}
        onPointerCancel={() => { swipe.current = null; setScrub(false); }}
        onPointerLeave={(e) => { if (e.pointerType === "mouse" && lay.overlap) setHot(null); }}
        onClickCapture={(e) => { if (!slid.current) return; slid.current = false; e.stopPropagation(); e.preventDefault(); }}
        onDragOver={(e) => { if (!dragging(e)) return; e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        // A drop adds, whatever a cancelled Replace left behind.
        onDrop={(e) => { if (!dragging(e)) return; e.preventDefault(); setOver(false); swapping.current = null; files(e.dataTransfer.files); }}>
        {lay.tiles.map((t, i) => {
          const photo = m.refs[i]?.src ?? null;
          const pending = photo === null ? m.pending[i - m.refs.length] ?? null : null;
          const empty = photo === null && pending === null;
          const front = lay.overlap && hot === i;
          const style = {
            left: t.left, top: t.top, width: t.size, height: t.size, borderRadius: t.radius,
            zIndex: front ? 60 : i + 1,
            backgroundImage: photo || pending ? `url("${photo ?? pending}")` : undefined,
          } as CSSProperties;
          return (
            <div key={i} className="iv-photo" style={style} data-own={photo !== null || undefined} data-empty={empty || undefined}
              data-add={lone || undefined} data-pending={pending !== null || undefined} data-over={(photo !== null && i >= m.cap) || undefined}
              data-hot={hot === i || undefined}>
              <button type="button" className="iv-photo-pick" title={lone ? "Add a photo" : undefined}
                aria-label={lone ? "Add a photo" : empty ? `Add a photo for image ${i + 1}` : `Photo ${i + 1}`}
                onClick={(e) => {
                  if (empty) return ask(e);
                  // A phone's first tap shows the tile's × and Replace (plan D12); a second, or a click, zooms.
                  if (phone && hot !== i) return setHot(i);
                  if (photo !== null) setZoom({ i, from: e.currentTarget.getBoundingClientRect() });
                }}>
                {empty && <AddPhoto size={Math.round(t.size * 0.3)} />}
              </button>
              {!lone && <span className="iv-photo-n" aria-hidden>{i + 1}</span>}
              {photo !== null && t.size >= 84 && (
                <button type="button" className="iv-photo-swap kit-hit" aria-label={`Replace photo ${i + 1}`} title="Replace photo" onClick={() => pick(i)}>
                  <Icon name="refresh" size={13} stroke={1.5} />
                </button>
              )}
              {(!empty || count > 1) && pending === null && (
                <button type="button" className="iv-photo-x kit-hit" aria-label={`Remove image ${i + 1}`} title="Remove"
                  onClick={() => { setHot(null); m.removeSlot(i); }}>×</button>
              )}
            </div>
          );
        })}
        {lay.add && (
          <button type="button" className="iv-photo-add" aria-label="Add a photo" title="Add a photo"
            style={{ left: lay.add.left, top: lay.add.top, width: lay.add.width, height: lay.add.height, borderRadius: lay.add.radius }}
            onClick={ask}><AddPhoto size={Math.round(lay.add.width * 0.3)} /></button>
        )}
      </div>
      <input ref={input} type="file" accept={m.accept} multiple hidden onChange={(e) => { files(e.target.files); e.target.value = ""; }} />
      {asking && <RefPicker model={m} anchor={asking} phone={phone} onUpload={() => pick(null)} onClose={() => setAsking(null)} />}
      {zoom && m.refs[zoom.i] && (
        <Zoom src={m.refs[zoom.i].src} n={zoom.i + 1} from={zoom.from} phone={phone} onClose={() => setZoom(null)} />
      )}
    </section>
  );
}
