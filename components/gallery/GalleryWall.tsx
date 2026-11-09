"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Download, Share, Link2, X, Globe, Lock, Trash2, Loader2, ImageOff, ChevronLeft, ChevronRight, RotateCw, Check, Heart, Copy } from "lucide-react";
import { notify } from "@/components/kit/notify";
import { openCreator } from "@/lib/openCreator";
import { downloadImage, shareImage, shareWithLink } from "@/components/kit/share";
import ConfirmDialog from "@/components/kit/ConfirmDialog";
import type { StoredCreation } from "@/lib/creations";
import { justifyRows, ROW_GAP as GAP, rowTarget } from "./justify";
import "./gallery-wall.css";
import { countImageOpen } from "@/lib/ui/view-beacon";

/**
 * The profile's Gallery tab (Kev, 2026-10-14): the images alone, in rows that
 * span the full width, one height per row and that height free to vary, no
 * dates or numbers on them, loading on as the end scrolls into view. A click
 * opens the image near full screen, with the prompt, what it was made with,
 * Download, Share, and for the owner Publish and Remove beside it.
 */

export type GalleryItem = StoredCreation & {
  visibility?: "public" | "private";
  isUploaded?: boolean;
  /** 18+: it has no share page, Share hands out the file. */
  isAdult?: boolean;
  /** The original file, for Download; the display URL may be a preview. */
  originalUrl?: string;
  /** The WebP thumb, for the wall's tiles. */
  thumbUrl?: string;
  promptId?: string | null;
  made?: { model: string | null; ratio: string | null; resolution: string | null } | null;
  /** The reference images the render was sent, in order. */
  references?: string[];
  /** The owner's own text (open prompts), or null when the prompt's text is not theirs to see. */
  text?: string | null;
  /** The variable values the owner filled in, for a prompt bought from someone. */
  values?: Record<string, string> | null;
  promptTitle?: string | null;
  /** "own": a prompt written here (Quick Create or the editor); "market": someone's listed prompt. */
  promptKind?: "own" | "market" | null;
  modelName?: string | null;
  /** Who made the prompt, for the link under its title. */
  artist?: { handle: string | null; name: string | null } | null;
  /** The owner's own heart on the image; shown red while on. */
  liked?: boolean;
};

/** One page of the wall; the API caps a page at 100. */
export const GALLERY_PAGE = 60;

type GenerationRow = {
  id: string;
  image_url?: string;
  image_urls?: string[];
  thumbnail_url?: string | null;
  final_prompt?: string | null;
  prompt?: string | null;
  prompt_id?: string | null;
  settings?: { origin?: string; modelId?: string | null; aspectRatio?: string | null; resolution?: string | null; references?: string[]; [key: string]: unknown } | null;
  status?: string;
  created_at: string;
  visibility?: "public" | "private";
  isUploaded?: boolean;
  isAdult?: boolean;
  prompt_text?: string | null;
  variable_values?: Record<string, string> | null;
  prompt_title?: string | null;
  prompt_kind?: "own" | "market" | null;
  model_name?: string | null;
  prompt_artist?: { handle: string | null; name: string | null } | null;
  liked?: boolean;
};

/** One /api/generations row as a wall item; null without an image. */
export function toGalleryItem(g: GenerationRow): GalleryItem | null {
  const imageUrl = g.image_urls && g.image_urls.length > 0 ? g.image_urls[0] : g.image_url || "";
  if (!imageUrl) return null;
  const prompt = g.final_prompt || g.prompt || "";
  return {
    id: String(g.id),
    imageUrl: String(imageUrl),
    originalUrl: g.image_url ? String(g.image_url) : undefined,
    thumbUrl: g.thumbnail_url ? String(g.thumbnail_url) : undefined,
    prompt: typeof prompt === "string" ? prompt : "",
    createdAt: typeof g.created_at === "string" ? g.created_at : new Date().toISOString(),
    isUploaded: g.isUploaded === true || g.settings?.origin === "uploaded" || g.status === "uploaded",
    isAdult: g.isAdult === true,
    visibility: g.visibility === "public" ? "public" : "private",
    promptId: g.prompt_id ?? null,
    made: g.settings && !g.settings.origin
      ? { model: g.settings.modelId ?? null, ratio: g.settings.aspectRatio ?? null, resolution: g.settings.resolution ?? null }
      : null,
    references: Array.isArray(g.settings?.references) ? g.settings.references.filter((u): u is string => typeof u === "string") : [],
    text: typeof g.prompt_text === "string" ? g.prompt_text : null,
    values: g.variable_values && typeof g.variable_values === "object" ? g.variable_values : null,
    promptTitle: g.prompt_title ?? null,
    promptKind: g.prompt_kind === "own" || g.prompt_kind === "market" ? g.prompt_kind : null,
    modelName: g.model_name ?? null,
    artist: g.prompt_artist && typeof g.prompt_artist === "object" ? { handle: g.prompt_artist.handle ?? null, name: g.prompt_artist.name ?? null } : null,
    liked: g.liked === true,
  };
}

/** The rows the generations API returns, from either response shape. */
export function rowsOf(json: unknown): GenerationRow[] {
  const j = json as { data?: { generations?: unknown }; generations?: unknown; items?: unknown } | null;
  const raw = j?.data?.generations ?? j?.generations ?? j?.items ?? [];
  return Array.isArray(raw) ? (raw as GenerationRow[]) : [];
}

/** Text in a frame with a copy icon on its top-right corner (Kev, 2026-10-15). */
function CopyBox({ label, text, className }: { label?: string; text: string; className?: string }) {
  const copy = () => {
    navigator.clipboard.writeText(text).then(() => notify("Copied"), () => notify("Copy failed", { tone: "error" }));
  };
  return (
    <div className={"gw-copybox" + (className ? " " + className : "")}>
      {label && <div className="gw-copybox-label">{label}</div>}
      <button type="button" className="gw-copy" onClick={copy} aria-label={label ? `Copy ${label}` : "Copy"} title="Copy">
        <Copy size={14} aria-hidden />
      </button>
      <div className="gw-copybox-text">{text}</div>
    </div>
  );
}

export default function GalleryWall({ items, loading, hasMore, loadingMore, onMore, onRemove, onVisibility, onRecreate, onOpenPrompt, onLike, emptyText }: {
  items: GalleryItem[];
  loading: boolean;
  /** More pages on the server: the end of the wall asks for the next one. */
  hasMore: boolean;
  loadingMore: boolean;
  onMore: () => void;
  /** Owner only: Remove and Publish in the viewer. */
  onRemove?: (id: string) => void | Promise<void>;
  onVisibility?: (id: string, visibility: "public" | "private") => void | Promise<void>;
  /** Recreate: back into the surface the image was made on, set up as it was made. */
  onRecreate?: (item: GalleryItem) => void;
  /** The prompt's title above the text opens that prompt's image view. */
  onOpenPrompt?: (item: GalleryItem) => void;
  /** The owner's heart on an image; without it there is no heart. */
  onLike?: (id: string, liked: boolean) => void | Promise<void>;
  emptyText?: string;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /* Marking (Kev, 2026-10-15): a checkbox on each tile's corner, and while any
     are marked a bar below the screen: "N selected | Download | heart | bin | x".
     Nothing is deleted without an "are you sure". */
  const [marked, setMarked] = useState<ReadonlySet<string>>(() => new Set());
  const [confirm, setConfirm] = useState<{ ids: string[] } | null>(null);
  const toggleMark = (id: string) => setMarked((m) => { const n = new Set(m); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const markedItems = items.filter((c) => marked.has(c.id));
  useEffect(() => {
    if (!marked.size || selectedId || confirm) return;
    // The marks stay while other layers open over them, and a stop does not hold back a second listener on the same
    // node: in the window's capture both would close. So on the document's bubble, as the image view hears: after every
    // layer that took the Esc, before the panel on the window (DEC-2026-11-03-29).
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.defaultPrevented) { e.stopPropagation(); setMarked(new Set()); } };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [marked.size, selectedId, confirm]);
  const removeAll = async (ids: string[]) => {
    setConfirm(null);
    setMarked((m) => { const n = new Set(m); for (const id of ids) n.delete(id); return n; });
    for (const id of ids) await onRemove?.(id);
  };
  const sentinel = useRef<HTMLDivElement | null>(null);
  const wall = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  // Each image's aspect ratio (width / height), read once it has loaded; 1 until then.
  const [ratios, setRatios] = useState<Record<string, number>>({});

  useEffect(() => {
    const el = wall.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const pending = items.filter((c) => ratios[c.id] === undefined);
    if (!pending.length) return;
    let live = true;
    for (const c of pending) {
      const img = new Image();
      img.onload = () => { if (live && img.naturalHeight) setRatios((r) => ({ ...r, [c.id]: img.naturalWidth / img.naturalHeight })); };
      img.onerror = () => { if (live) setRatios((r) => ({ ...r, [c.id]: 1 })); };
      img.src = c.imageUrl;
    }
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  const rows = useMemo(() => {
    const target = rowTarget(width);
    return justifyRows(items.map((c) => ({ item: c, ratio: ratios[c.id] ?? 1 })), width, target, GAP);
  }, [items, ratios, width]);

  // The next page, once the end of the wall scrolls into view.
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasMore || loadingMore) return;
    const io = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      io.disconnect();
      onMore();
    }, { rootMargin: "600px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loadingMore, onMore]);

  const index = selectedId ? items.findIndex((c) => c.id === selectedId) : -1;
  const selected = index >= 0 ? items[index] : null;
  const step = (by: number) => setSelectedId(items[index + by]?.id ?? selectedId);

  // A public image opened large here counts as watched, once a day per browser (DEC-518).
  useEffect(() => {
    if (selected?.visibility === "public") countImageOpen(selected.id);
  }, [selected?.id, selected?.visibility]);

  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); setSelectedId(null); }
      if (e.key === "ArrowLeft") step(-1);
      if (e.key === "ArrowRight") step(1);
    };
    window.addEventListener("keydown", onKey, true);
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", onKey, true); document.body.style.overflow = ""; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, index]);
  if (selectedId && !selected) setSelectedId(null);

  return (
    <div className="gw" ref={wall} data-menu-autohide>
      {loading ? (
        <div className="gw-empty">
          <Loader2 size={24} color="var(--enki-ink-3)" className="gw-spin" style={{ margin: "0 auto 12px" }} />
          <p style={{ margin: 0, fontSize: 13, color: "var(--enki-ink-3)" }}>Loading gallery…</p>
        </div>
      ) : items.length === 0 ? (
        <div className="gw-empty">
          <ImageOff size={32} color="var(--enki-ink-3)" style={{ margin: "0 auto 12px" }} />
          <p style={{ margin: 0, fontSize: 14, color: "var(--enki-ink-2)" }}>
            {emptyText ?? "No creations yet. Generate an image or upload one and it will appear here."}
          </p>
        </div>
      ) : (
        /* The wall: justified rows, edge to edge, one height per row. */
        <div className="gw-rows">
          {rows.map((row, i) => (
            <div key={i} className="gw-row" style={{ height: row.height }}>
              {row.items.map(({ item: c, ratio }) => (
                <div key={c.id} className={"gw-shot" + (marked.has(c.id) ? " gw-shot--marked" : "")} style={{ width: row.height * ratio }} data-testid={`my-creation-${c.id}`}>
                  <button type="button" className="gw-shot-open" onClick={() => setSelectedId(c.id)} aria-label="Open">
                    <img src={c.thumbUrl ?? c.imageUrl} alt={c.isUploaded ? "Uploaded" : "Generated"} loading="lazy" />
                  </button>
                  {onRemove && (
                    <button type="button" className="gw-mark" role="checkbox" aria-checked={marked.has(c.id)} aria-label="Select"
                      onClick={(e) => { e.stopPropagation(); toggleMark(c.id); }}>
                      {marked.has(c.id) && <Check size={14} strokeWidth={3} aria-hidden />}
                    </button>
                  )}
                  {/* Only an image the database holds (visibility is its mark) can take a like. */}
                  {onLike && c.visibility && (
                    <button type="button" className={"gw-heart" + (c.liked ? " gw-heart--on" : "")} aria-pressed={!!c.liked} aria-label={c.liked ? "Unlike" : "Like"}
                      onClick={(e) => { e.stopPropagation(); void onLike(c.id, !c.liked); }}>
                      <Heart size={16} fill={c.liked ? "currentColor" : "none"} aria-hidden />
                    </button>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
      <div ref={sentinel} className="gw-more">
        {loadingMore && <Loader2 size={18} color="var(--enki-ink-3)" className="gw-spin" />}
      </div>

      {markedItems.length > 0 && (
        <div className="gw-bar" role="toolbar" aria-label="Selected images">
          <span className="gw-bar-count">{markedItems.length} selected</span>
          <span className="gw-bar-sep" aria-hidden />
          <button type="button" className="gw-bar-btn" title="Download" aria-label="Download"
            onClick={() => { void (async () => { for (const c of markedItems) await downloadImage(c.originalUrl ?? c.imageUrl, c.promptTitle ?? ""); })(); }}>
            <Download size={18} aria-hidden />
          </button>
          {onLike && (
            <button type="button" className="gw-bar-btn" title="Like" aria-label="Like"
              onClick={() => { const held = markedItems.filter((c) => c.visibility); const on = !held.every((c) => c.liked); for (const c of held) void onLike(c.id, on); }}>
              <Heart size={18} aria-hidden />
            </button>
          )}
          <button type="button" className="gw-bar-btn gw-bar-btn--danger" title="Delete" aria-label="Delete" onClick={() => setConfirm({ ids: markedItems.map((c) => c.id) })}>
            <Trash2 size={18} aria-hidden />
          </button>
          <button type="button" className="gw-bar-btn" title="Clear selection" aria-label="Clear selection" onClick={() => setMarked(new Set())}>
            <X size={18} aria-hidden />
          </button>
        </div>
      )}
      {confirm && (
        <ConfirmDialog
          title={confirm.ids.length === 1 ? "Delete this image?" : `Delete ${confirm.ids.length} images?`}
          text="It is removed from your gallery and from anywhere it was shown. This cannot be undone."
          onConfirm={() => void removeAll(confirm.ids)}
          onCancel={() => setConfirm(null)}
        />
      )}

      {selected && (
        /* The viewer: the image near full screen, its details beside it. */
        <div className="gw-viewer" role="dialog" aria-label="Image" onClick={() => setSelectedId(null)}>
          <button type="button" className="gw-close" onClick={() => setSelectedId(null)} aria-label="Close"><X size={18} /></button>
          {index > 0 && (
            <button type="button" className="gw-nav gw-nav--prev" onClick={(e) => { e.stopPropagation(); step(-1); }} aria-label="Previous"><ChevronLeft size={22} /></button>
          )}
          {index < items.length - 1 && (
            <button type="button" className="gw-nav gw-nav--next" onClick={(e) => { e.stopPropagation(); step(1); }} aria-label="Next"><ChevronRight size={22} /></button>
          )}
          {/* The dark around the image closes it too (Kev, 2026-10-15): only the image and the details keep a click. */}
          <div className="gw-viewer-body" onClick={(e) => { e.stopPropagation(); if (e.target === e.currentTarget) setSelectedId(null); }}>
            <div className="gw-stage" onClick={(e) => { if (e.target === e.currentTarget) setSelectedId(null); }}>
              {/* The WebP preview; Download and Share hand over the original (Kev, 2026-10-16). */}
              <img className="gw-viewer-img" src={selected.imageUrl} alt="" />
            </div>
            <aside className="gw-details">
              {selected.promptKind === "market" && (selected.promptTitle || selected.artist) && (
                /* Where it came from (Kev, 2026-10-15): the prompt's title opens its view, the artist their page. */
                <div className="gw-source">
                  {selected.promptTitle && (onOpenPrompt && selected.promptId
                    ? <button type="button" className="gw-title gw-link" onClick={() => onOpenPrompt(selected)}>{selected.promptTitle}</button>
                    : <div className="gw-title">{selected.promptTitle}</div>)}
                  {selected.artist?.handle && (
                    <button type="button" className="gw-artist gw-link" onClick={() => openCreator(selected.artist?.handle ?? "")}>
                      {selected.artist.name || `@${selected.artist.handle}`}
                    </button>
                  )}
                </div>
              )}
              {selected.text ? (
                <CopyBox text={selected.text} className="gw-copybox--prompt" />
              ) : selected.values && Object.keys(selected.values).length ? (
                /* A bought prompt: its text stays the creator's; what was filled in is the owner's. */
                <div className="gw-values">
                  {Object.entries(selected.values).map(([name, value]) => (
                    <CopyBox key={name} label={name} text={String(value)} />
                  ))}
                </div>
              ) : selected.promptTitle ? null : (
                /* A prompt with neither text nor values here keeps its title link: its own page says the rest. */
                <p className="gw-prompt gw-prompt--none">{selected.isUploaded ? "Uploaded image" : "No prompt recorded"}</p>
              )}
              {selected.made && (
                <div className="gw-made">
                  {[selected.modelName ?? selected.made.model, selected.made.ratio, selected.made.resolution].filter(Boolean).map((v) => (
                    <span key={String(v)} className="gw-chip">{String(v)}</span>
                  ))}
                </div>
              )}
              {!!selected.references?.length && (
                <div className="gw-refs" aria-label="Reference images">
                  {selected.references.map((url, i) => <img key={url + i} src={url} alt={`Reference image ${i + 1}`} loading="lazy" />)}
                </div>
              )}
              <div className="gw-actions">
                {onRecreate && !selected.isUploaded && (
                  <button type="button" className="gw-act gw-act--primary" onClick={() => onRecreate(selected)} title="Open the generator set up as this image was made">
                    <RotateCw size={17} aria-hidden />Recreate
                  </button>
                )}
                <button type="button" className="gw-act" onClick={() => void downloadImage(selected.originalUrl ?? selected.imageUrl, selected.promptTitle ?? "")}>
                  <Download size={17} aria-hidden />Download
                </button>
                {/* A public image shares its page, which unfurls as the image with "Made with Enki" (SHR); 18+ has no page.
                    The text names no prompt: the page itself names one only when it is listed (review 2026-10-17). */}
                {selected.visibility === "public" && !selected.isUploaded && !selected.isAdult ? (
                  <button type="button" className="gw-act" title="Its page: the image with Enki's card"
                    onClick={() => void shareWithLink(selected.originalUrl ?? selected.imageUrl, `${window.location.origin}/i/${selected.id}`, "An image")}>
                    <Share size={17} aria-hidden />Share
                  </button>
                ) : (
                  <button type="button" className="gw-act" title="Anyone with the link can open this image" onClick={() => void shareImage(selected.originalUrl ?? selected.imageUrl)}>
                    <Share size={17} aria-hidden />Share
                  </button>
                )}
                {selected.promptId && selected.visibility === "public" && (
                  <button type="button" className="gw-act" title="The image and a link to its prompt"
                    onClick={() => void shareWithLink(selected.originalUrl ?? selected.imageUrl, `${window.location.origin}/generator/${selected.promptId}`, "My image")}>
                    <Link2 size={17} aria-hidden />Share + prompt
                  </button>
                )}
                {onVisibility && selected.visibility && !selected.isUploaded && (
                  <button type="button" className="gw-act" data-testid={`button-visibility-${selected.id}`}
                    onClick={() => void onVisibility(selected.id, selected.visibility === "public" ? "private" : "public")}>
                    {selected.visibility === "public" ? <><Globe size={17} aria-hidden />Public</> : <><Lock size={17} aria-hidden />Publish</>}
                  </button>
                )}
                {onRemove && (
                  <button type="button" className="gw-act gw-act--danger" data-testid={`button-delete-creation-${selected.id}`}
                    onClick={() => { setSelectedId(null); setConfirm({ ids: [selected.id] }); }}>
                    <Trash2 size={17} aria-hidden />Remove
                  </button>
                )}
              </div>
            </aside>
          </div>
        </div>
      )}
    </div>
  );
}
