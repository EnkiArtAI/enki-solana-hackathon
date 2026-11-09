"use client";

import { useState, type MouseEvent, type Ref } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import BookmarkPicker from "@/components/enki/BookmarkPicker";
import { preloadImageUI } from "@/components/enki/EnkiDetailPanel";
import FeedVideo from "@/components/enki/FeedVideo";
import { Icon } from "@/components/enki-shell/icons";
import { notify } from "@/components/kit/notify";
import { openCreator } from "@/lib/openCreator";
import { openVideoChip, priceChipLabel, type FeedCard as Card } from "@/lib/ui/feed/card";
import { useVideoRoutes } from "@/hooks/useVideoRoutes";
import type { Membership } from "@/lib/ui/feed/bookmark-index";
import { CARD_MAX } from "@/lib/ui/kit/breakpoints";

/** What a card is wide: its laid-out width where the browser reads `auto`
 *  (lazy images), else half a phone or at most CARD_MAX (columnsFor). */
const CARD_SIZES = `auto, (max-width: 639px) 50vw, ${CARD_MAX}px`;
/**
 * The renditions' widths at their narrowest (lib/imageDerivatives: thumb and preview fit inside 384 and 2048 px squares,
 * so a 9:16 picture is 216 and 1152 px wide). Claimed at 384w and 1280w, a portrait thumb was picked for a card wider
 * than itself and stretched: the wall looked blurry until a picture was opened (Kev, 2026-10-31).
 */
const THUMB_W = 216;
const PREVIEW_W = 1152;
/** A card's numbers, in the order they show, each with its icon. */
const NUMBERS = [["uses", "sparkles"], ["likes", "heart"], ["views", "eye"]] as const;

/**
 * One card of the wall: the picture and its price chip top left ("Open" for
 * an open prompt, its generator's price for an open video). Everything else waits for a hover or the keyboard focus
 * (Kev, 2026-10-13): then the title, the artist (a link) and the bookmark
 * rise in. A bookmark that is set stays visible top right. A tap opens the
 * image view.
 */
export default function FeedCard({ ref, card, onOpen, canBookmark, saved, onEdit, numbers = false }: {
  ref?: Ref<HTMLElement>;
  card: Card;
  onOpen: (card: Card) => void;
  /** Signed in: guests and team visitors get no bookmark. */
  canBookmark: boolean;
  /** Where the prompt is bookmarked (the session's bookmark index). */
  saved: readonly Membership[] | undefined;
  /** The owner's own card on their profile: a pencil into the editor, always shown. */
  onEdit?: (card: Card) => void;
  /** A profile's Released: uses, likes and views, always shown; a count that failed is a dash, never a 0. */
  numbers?: boolean;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [img, setImg] = useState<"loading" | "loaded" | "error">("loading");
  // A rendition that failed to load gives way to the original, once.
  const [original, setOriginal] = useState(false);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);

  const title = card.title || "Untitled prompt";
  const art = card.images[0];
  const renditions = !original && !!art?.thumb && !!art?.preview;
  const { rateOf } = useVideoRoutes(!!card.openVideo);
  const price = openVideoChip(card, rateOf) ?? priceChipLabel(card.priceCents);
  const by = card.creator;
  const artist = by ? (by.handle ? `@${by.handle}` : by.name) : null;
  const isSaved = Boolean(saved?.length);
  const said = card.stats
    ? NUMBERS.map(([key]) => { const n = card.stats![key]; return `${n} ${n === 1 ? key.slice(0, -1) : key}`; }).join(", ")
    : "Numbers not available";

  // Warm what a click needs while the pointer is still on its way.
  const warm = () => {
    preloadImageUI();
    queryClient.prefetchQuery({ queryKey: [`/api/prompts/${card.id}`] }).catch(() => {});
  };
  const toggleMark = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    const at = e.currentTarget.getBoundingClientRect();
    setAnchor(anchor ? null : at);
  };

  return (
    <article ref={ref} data-pid={card.id}
      className={"feed-card" + (img === "loaded" ? " is-loaded" : "") + (isSaved || anchor ? " is-marked" : "")}
      onPointerEnter={warm} onFocus={warm}>
      {art && img !== "error" && (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img className="feed-card-img" src={original ? art.url : art.thumb ?? art.preview ?? art.url}
          srcSet={renditions ? `${art.thumb} ${THUMB_W}w, ${art.preview} ${PREVIEW_W}w` : undefined} sizes={renditions ? CARD_SIZES : undefined}
          alt={title} loading="lazy" decoding="async" draggable={false}
          onLoad={() => setImg("loaded")} onError={() => (original || !(art.thumb || art.preview) ? setImg("error") : setOriginal(true))} />
      )}
      {card.video && <FeedVideo src={card.video.preview} />}
      <button type="button" className="feed-card-hit" onClick={() => onOpen(card)}
        aria-label={`${title}${by ? ` by ${artist}` : ""}${price ? `, ${price}` : ""}`} />
      {price && <span className={"feed-card-price" + (price === "Open" ? " is-free" : "")}>{price}</span>}
      <div className="feed-card-foot">
        <span className="feed-card-title">{title}</span>
        {by && (
          <button type="button" className="feed-card-artist kit-hit"
            onClick={(e) => { e.stopPropagation(); openCreator(by.handle || by.id, router); }}>
            {artist}
          </button>
        )}
      </div>
      {numbers && (
        // It lies over the card's own button, so a tap on it opens the card too; the keyboard has that button.
        <div className="feed-card-nums" role="img" aria-label={said} title={said} onClick={() => onOpen(card)}>
          {NUMBERS.map(([key, icon]) => (
            <span key={key}><Icon name={icon} size={12} stroke={2} />{card.stats?.[key].toLocaleString("en-US") ?? "—"}</span>
          ))}
        </div>
      )}
      {canBookmark && (
        <button type="button" className="feed-card-mark kit-hit" onClick={toggleMark}
          aria-pressed={isSaved} aria-label={`Bookmark ${title}`} title={isSaved ? "Saved · click to change" : "Save to bookmarks"}>
          <Icon name="bookmark" size={15} stroke={2} fill={isSaved ? "currentColor" : "none"} />
        </button>
      )}
      {onEdit && (
        <button type="button" className="feed-card-edit kit-hit" onClick={(e) => { e.stopPropagation(); onEdit(card); }}
          aria-label={`Edit ${title}`} title="Edit prompt">
          <Icon name="pen" size={14} stroke={2} />
        </button>
      )}
      {anchor && (
        <BookmarkPicker promptId={card.id} imageUrl={art?.url} anchor={anchor} memberships={saved}
          onChange={(kind, name) => notify(kind === "added" ? `Saved to ${name}` : `Removed from ${name}`)}
          onClose={() => setAnchor(null)} />
      )}
    </article>
  );
}
