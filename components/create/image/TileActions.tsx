"use client";

import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import {
  Bookmark, ChevronLeft, ChevronRight, Clapperboard, Copy, Download, Ellipsis, FilePen, FolderPlus, ImagePlus, Link2, Share, Trash2, Users,
  type LucideIcon,
} from "lucide-react";
import BookmarkPicker from "@/components/enki/BookmarkPicker";
import CommunityAsk, { type RenderAsk } from "@/components/communities/CommunityAsk";
import CommunityLinks from "@/components/communities/CommunityLinks";
import type { PostRender } from "@/components/communities/PostDialog";
import { PRIVATE_RENDERS_LINE } from "@/lib/communities/types";
import BottomSheet from "@/components/kit/BottomSheet";
import ConfirmDialog from "@/components/kit/ConfirmDialog";
import { notify } from "@/components/kit/notify";
import { downloadImage, shareImage, shareWithLink } from "@/components/kit/share";
import { copyText } from "@/components/image-view/useImageViewModel";
import { openLogin } from "@/lib/openLogin";
import { promptName, wallShot, type WallItem } from "@/lib/ui/create/image";
import { ALL, refusal, shareLink, sharePlatforms, tileFacts, tileLayout, type TileAct, type TileFacts } from "@/lib/ui/create/tile-actions";
import type { BookmarkIndex } from "@/lib/ui/feed/bookmark-index";
import { HOVER } from "@/lib/ui/kit/breakpoints";
import { menuMode } from "@/lib/ui/kit/controls";
import StudioPick from "./StudioPick";
import TileMenu from "./TileMenu";

/** What the page does for a picture's actions (CreateImage): the bar, the editor, Create > Video, the delete. */
export interface TileActs {
  guest: boolean;
  /** The viewer's bookmarks by prompt: Bookmark is filled once the picture's prompt is kept. */
  marks: BookmarkIndex | undefined;
  recreate: (item: WallItem) => void;
  /** Make it a prompt: the words to the editor, as the bar's own button. */
  prompt: (words: string) => void;
  reference: (f: TileFacts) => void;
  animate: (f: TileFacts) => void;
  /** Delete, once confirmed. */
  remove: (item: WallItem) => void;
}

const ACT: Record<TileAct, { label: string; icon: LucideIcon; hint?: string }> = {
  bookmark: { label: "Bookmark", icon: Bookmark },
  download: { label: "Download", icon: Download },
  // Kev, 2026-10-30: "dieses copy symbol ist dann recreate" (and the viewer's Regenerate, a paid render, keeps RotateCw).
  recreate: { label: "Recreate", icon: Copy, hint: "Its settings and reference images into the bar" },
  prompt: { label: "Make it a prompt", icon: FilePen, hint: "Its words to the prompt editor" },
  reference: { label: "Reference", icon: ImagePlus, hint: "Into the bar as a reference image" },
  animate: { label: "Animate", icon: Clapperboard, hint: "Into Create > Video as its picture" },
  studio: { label: "Add to Studio", icon: FolderPlus },
  // The agreed shape, 2026-10-30: "the tile ⋯ menu / viewer of an own render ("Communities")".
  communities: { label: "Communities", icon: Users },
  share: { label: "Share", icon: Share },
  delete: { label: "Delete", icon: Trash2 },
};
type Page = "main" | "bookmark" | "studio" | "communities" | "share";
const TITLE: Record<Page, string> = { main: "This image", bookmark: "Save to", studio: "Add to Studio", communities: "Communities", share: "Share" };
const SHARE_TEXT = "An image on Enki Art";

/**
 * A finished picture's actions on Create > Image's wall (Kev, 2026-10-30, after Higgsfield's rail, in Enki's look; the
 * layout is lib/ui/create/tile-actions): with a pointer, the rail at its top right and Reference and Animate at its
 * bottom left, shown on hover or keyboard focus (feed.css); ⋯ opens the rest as a popover, as a sheet below 1024 px. A
 * touch screen shows ⋯ alone, whose sheet holds every action. Esc closes a menu and the button that opened it takes the
 * focus back.
 */
export default function TileActions({ item, width, height, acts }: { item: WallItem; width: number; height: number; acts: TileActs }) {
  const [menu, setMenu] = useState<DOMRect | null>(null);
  const [float, setFloat] = useState<DOMRect | null>(null);
  const [sheet, setSheet] = useState(false);
  const [page, setPage] = useState<Page>("main");
  // The rows the sheet or popover lists, and which button opened it.
  const [list, setList] = useState<{ by: "more" | "dots" | "bookmark"; rows: readonly TileAct[] }>({ by: "dots", rows: ALL });
  const [confirming, setConfirming] = useState(false);
  // Its communities' dialogs, each in the menu's place: "+ Create c/…" from its picker, and Post to Showroom.
  const [asked, setAsked] = useState<RenderAsk | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const closed = !menu && !float && !sheet && !confirming && !asked;
  // The opener takes the focus back once a menu is gone, unless something else took it (a sheet hands it back itself).
  useEffect(() => {
    if (closed && (!document.activeElement || document.activeElement === document.body)) opener.current?.focus({ preventScroll: true });
  }, [closed]);

  const f = tileFacts(item);
  if (!f) return null;
  const layout = tileLayout(width, height);
  const kept = f.promptId ? acts.marks?.get(f.promptId) ?? [] : [];
  const close = () => {
    setMenu(null);
    setFloat(null);
    setSheet(false);
  };
  // Opens a page of the menu: a popover from what was pressed, or the sheet (below 1024 px, and every touch screen).
  const open = (e: MouseEvent<HTMLElement>, at: Page, by: "more" | "dots" | "bookmark", rows: readonly TileAct[], asSheet: boolean) => {
    opener.current = e.currentTarget;
    setPage(at);
    setList({ by, rows });
    if (asSheet || menuMode(window) === "sheet") return setSheet(true);
    const box = e.currentTarget.getBoundingClientRect();
    setMenu((m) => (m ? null : box));
  };

  // The actions that run at once; the menu closes first.
  const run = (a: TileAct) => {
    const why = refusal(a, f);
    if (why) return notify(why);
    close();
    if (a === "download") void downloadImage(f.url, promptName(f.words ?? ""));
    else if (a === "recreate") acts.recreate(item);
    else if (a === "prompt" && f.words) acts.prompt(f.words);
    else if (a === "reference") acts.reference(f);
    else if (a === "animate") acts.animate(f);
    else if (a === "delete") setConfirming(true);
  };
  // A row of the menu: Bookmark, Add to Studio and Share open their own page; the rest run.
  const pick = (a: TileAct) => {
    const why = refusal(a, f);
    if (why) return notify(why);
    if (acts.guest && (a === "bookmark" || a === "studio" || a === "communities")) return openLogin();
    if (a === "bookmark" || a === "studio" || a === "communities" || a === "share") return setPage(a);
    run(a);
  };
  // The rail's Bookmark: its picker floats at the button; from the keyboard (a click without a pointer, detail 0) and
  // below 1024 px it opens as the menu's page, which takes the focus to its first row (review 2026-10-30: the float
  // never got it, so Tab walked past the groups).
  const bookmark = (e: MouseEvent<HTMLButtonElement>) => {
    const why = refusal("bookmark", f);
    if (why) return notify(why);
    if (acts.guest) return openLogin();
    opener.current = e.currentTarget;
    if (e.detail === 0 || menuMode(window) === "sheet") return open(e, "bookmark", "bookmark", [], false);
    const box = e.currentTarget.getBoundingClientRect();
    setFloat((b) => (b ? null : box));
  };

  // Whether the menu (popover or sheet) is open from this button.
  const shown = (by: "more" | "dots" | "bookmark") => (!!menu || sheet) && list.by === by;
  const icon = (a: TileAct, size: number) => {
    const Icon = ACT[a].icon;
    return <Icon size={size} strokeWidth={1.75} fill={a === "bookmark" && kept.length ? "currentColor" : "none"} aria-hidden />;
  };
  const button = (a: TileAct, labelled = false) => {
    const why = refusal(a, f);
    return (
      <button key={a} type="button" className="ci-act kit-hit" aria-label={ACT[a].label} title={why ?? ACT[a].hint ?? ACT[a].label}
        aria-disabled={why ? true : undefined} aria-expanded={a === "bookmark" ? !!float || shown("bookmark") : undefined}
        onClick={a === "bookmark" ? bookmark : () => run(a)}>
        {icon(a, 15)}{labelled && <span>{ACT[a].label}</span>}
      </button>
    );
  };
  const row = (a: TileAct) => {
    const why = refusal(a, f);
    return (
      <button key={a} type="button" role="menuitem" className="kit-opt" title={why ?? ACT[a].hint} aria-disabled={why ? true : undefined}
        data-tone={a === "delete" ? "danger" : undefined} onClick={() => pick(a)}>
        {icon(a, 16)}<span>{ACT[a].label}</span>
        {(a === "studio" || a === "communities" || a === "share") && <ChevronRight className="ci-menu-sub" size={14} aria-hidden />}
      </button>
    );
  };

  const body = (): ReactNode => {
    if (page === "bookmark" && f.promptId) {
      return (
        <div className="iv-sheet-bmp">
          <BookmarkPicker promptId={f.promptId} imageUrl={f.url} memberships={kept} onClose={close}
            onChange={(kind, name) => notify(kind === "added" ? `Saved to ${name}` : `Removed from ${name}`)} />
        </div>
      );
    }
    const back = list.rows.includes(page as TileAct) && (
      <button type="button" role="menuitem" className="kit-opt ci-menu-back" onClick={() => setPage("main")}>
        <ChevronLeft size={16} aria-hidden /><span>{TITLE[page]}</span>
      </button>
    );
    if (page === "studio") return <>{back}<StudioPick shot={wallShot(item)!} promptId={f.promptId} /></>;
    if (page === "communities" && f.rowId) {
      const post: PostRender = { id: f.rowId, thumb: f.thumb, public: item.kind === "row" && item.row.visibility === "public" };
      return (
        <>{back}
          <CommunityLinks kind="image" id={f.rowId} text={f.words ?? ""} note={post.public ? undefined : PRIVATE_RENDERS_LINE}
            onCreate={(name) => { close(); setAsked({ create: name }); }}
            foot={<button type="button" className="st-btn st-btn--small" onClick={() => { close(); setAsked({ post }); }}>Post to Showroom</button>} />
        </>
      );
    }
    if (page === "share") return <>{back}<ShareRows f={f} onDone={close} /></>;
    return <div className="kit-opts" role="menu" aria-label={TITLE.main}>{list.rows.map(row)}</div>;
  };

  return (
    <>
      <div className="ci-rail kit-focus" role="group" aria-label="Image actions">
        {layout.rail.map((a) => button(a))}
        <button type="button" className="ci-act kit-hit" aria-label="More" title="More" aria-haspopup="menu" aria-expanded={shown("more")}
          onClick={(e) => open(e, "main", "more", layout.more, false)}>
          <Ellipsis size={16} strokeWidth={1.75} aria-hidden />
        </button>
      </div>
      {layout.pair.length > 0 && <div className="ci-pair kit-focus">{layout.pair.map((a) => button(a, true))}</div>}
      <button type="button" className="ci-act ci-dots kit-hit kit-focus" aria-label="Image actions" aria-haspopup="menu" aria-expanded={shown("dots")}
        onClick={(e) => open(e, "main", "dots", ALL, true)}>
        <Ellipsis size={18} strokeWidth={1.75} aria-hidden />
      </button>

      {float && f.promptId && (
        <BookmarkPicker promptId={f.promptId} imageUrl={f.url} anchor={float} memberships={kept} onClose={() => setFloat(null)}
          onChange={(kind, name) => notify(kind === "added" ? `Saved to ${name}` : `Removed from ${name}`)} />
      )}
      {menu && <TileMenu anchor={menu} label={TITLE[page]} page={page} onClose={close}>{body()}</TileMenu>}
      <BottomSheet open={sheet} title={TITLE[page]} onClose={close}>
        <div className="ci-sheet">{body()}</div>
      </BottomSheet>
      {confirming && (
        <ConfirmDialog title="Delete this image?" text="It is removed from your gallery and from anywhere it was shown. This cannot be undone."
          onConfirm={() => { setConfirming(false); acts.remove(item); }} onCancel={() => setConfirming(false)} />
      )}
      {asked && f.rowId && <CommunityAsk ask={asked} id={f.rowId} onClose={() => setAsked(null)} />}
    </>
  );
}

/**
 * The same three in the viewer's panel (ViewerPanel's `more`), its own look: Recreate, Reference, Animate. The viewer
 * closes first, so the bar they fill is in sight (Animate leaves for Create > Video).
 */
export function ViewerActs({ item, acts, onClose }: { item: WallItem; acts: TileActs; onClose: () => void }) {
  const f = tileFacts(item);
  if (!f) return null;
  const go = (a: "recreate" | "reference" | "animate") => {
    onClose();
    if (a === "recreate") acts.recreate(item);
    else acts[a](f);
  };
  return (["recreate", "reference", "animate"] as const).map((a) => {
    const Icon = ACT[a].icon;
    return (
      <button key={a} type="button" className="iv-vact kit-hit" title={ACT[a].hint} onClick={() => go(a)}>
        <Icon size={18} strokeWidth={2} aria-hidden />{ACT[a].label}
      </button>
    );
  });
}

/**
 * Share (Kev, 2026-10-30: "Share -> Copy link -> share to platform (und dann kann man was auswählen, was auch bei mobile
 * gut klappen sollte)"): Copy link, then the device's own share sheet where a touch screen has one (the viewer's Share:
 * the picture as a file where the phone can share one, its page with it once public), else the platforms, each by its
 * own share address.
 */
function ShareRows({ f, onDone }: { f: TileFacts; onDone: () => void }) {
  const link = shareLink(f, window.location.origin);
  if (!link) return <p className="ci-menu-note" role="status">This image has no link yet.</p>;
  const native = typeof navigator.share === "function" && !window.matchMedia(HOVER).matches;
  return (
    <>
      <p className="ci-menu-note">{f.page ? "Its page on Enki: the image with Enki's card." : "Anyone with the link can open this image."}</p>
      <div className="kit-opts" role="menu" aria-label="Share">
        <button type="button" role="menuitem" className="kit-opt" onClick={() => { onDone(); copyText(link, "Link copied"); }}>
          <Link2 size={16} aria-hidden /><span>Copy link</span>
        </button>
        {native ? (
          <button type="button" role="menuitem" className="kit-opt" onClick={() => { onDone(); void (f.page ? shareWithLink(f.url, link, "An image") : shareImage(f.url)); }}>
            <Share size={16} aria-hidden /><span>Share to an app…</span>
          </button>
        ) : sharePlatforms(link, SHARE_TEXT).map((p) => (
          <a key={p.key} role="menuitem" className="kit-opt" href={p.href} target={p.key === "email" ? undefined : "_blank"} rel="noopener noreferrer"
            onClick={onDone}>
            <span>{p.label}</span>
          </a>
        ))}
      </div>
    </>
  );
}
