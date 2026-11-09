"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import dynamic from "next/dynamic";
import { holdShown, linkedPrompt, promptLink } from "@/lib/ui/image-view/open-link";
import type { ImageViewSeed } from "@/lib/ui/image-view/seed";
import { backState } from "@/lib/ui/kit/shell-nav";
// The frame and its spinner are styled before the view's chunk arrives.
import "@/components/image-view/image-view-frame.css";

/* Client-only, so a phone never paints the desktop layout first. The
   spinner is centred in the FRAME, not the viewport: the frame starts at the
   shell's menu edge and below the recovery banner, so a viewport-centred
   spinner sits visibly off to one side inside it. Create shows the blank
   composer through it too, in its own page (CreateView). */
export const ImageView = dynamic(() => import("@/components/image-view/ImageView"), {
  ssr: false,
  loading: () => (
    <div className="iv-state" role="status" aria-label="Loading">
      <Loader2 className="iv-spin" size={26} aria-hidden />
    </div>
  ),
});

/* Warm the chunk without opening anything. next/dynamic only fetches on first
   render, so the very first image a visitor clicks pays for the download; every
   later one is instant. Calling the loader on hover moves that cost into the
   moment the pointer is still travelling. Idempotent — the module registry
   dedupes, so hovering ten cards fetches once. */
export const preloadImageUI = () => { void import("@/components/image-view/ImageView"); };

/** The Image View over the feed and the profile: a prompt, or the launcher's blank composer. */
export default function EnkiDetailPanel({ seed, onClose }: { seed: ImageViewSeed | "blank"; onClose: () => void }) {
  const id = seed === "blank" ? "blank" : seed.promptId;

  /* Locking the body would otherwise cost the reader their place: a body at
     overflow:hidden collapses to scrollTop 0, so closing the panel drops them
     back at the top of a feed they had scrolled far into. The offset is
     captured on open and put back on close, which is what "zurück wo ich war"
     means for an overlay. */
  useEffect(() => {
    const scrollY = window.scrollY;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
      window.scrollTo({ top: scrollY, behavior: "auto" });
    };
  }, []);

  /* A reload stays on this image (Kev, 2026-10-13): while a prompt's view is
     open its id is in the address (?prompt=<id>), and the feed opens it again
     on arrival. Opened over an address that named no prompt, the view adds a
     history entry for it, once, so the browser's Back closes the view instead
     of leaving /home for the landing (Kev, 2026-10-16); an address that
     already named one (a reload, a link, a switch inside the view) is changed
     in place. Closing takes the prompt out of the address again. The blank
     composer has no prompt and leaves the address alone. Over a shell panel
     its entries carry the panel's way back (backState). */
  const owned = useRef(false);
  useEffect(() => {
    if (id === "blank") return;
    // One open of this prompt, wherever it was opened from: a feed card, a profile, a link (DEC-518). The server dedupes per viewer.
    fetch(`/api/prompts/${encodeURIComponent(id)}/view`, { method: "POST" }).catch(() => {});
    // Counted before the address names it, so the feed opens no second view of it (DEC-461).
    const release = holdShown(id);
    const { href, search } = window.location;
    if (linkedPrompt(search) !== id) {
      const entry = linkedPrompt(search) === null && !owned.current ? "pushState" : "replaceState";
      window.history[entry](backState(entry === "pushState", window.history.state), "", promptLink(href, id));
      if (entry === "pushState") owned.current = true;
    }
    return () => {
      release();
      window.history.replaceState(backState(false, window.history.state), "", promptLink(window.location.href, null));
    };
  }, [id]);
  // Each prompt opens with the phone header showing, and a closed one leaves none behind: the shell drops the image's
  // tuck both times (EnkiHome; review 2026-10-27: a view closed while tucked opened the next one tucked).
  useEffect(() => {
    const drop = () => { window.dispatchEvent(new Event("enki:detail-open")); };
    drop();
    return drop;
  }, [id]);

  /* Hidden-but-mounted: a sidebar menu (leaderboard, settings ...) opened
     over this view HIDES it instead of closing it, so Home can bring back
     exactly the image the reader had open — state, scroll and all (Kev,
     2026-08-22). The flag names the prompt it hid, so a NEW prompt never
     inherits it. While hidden, ESC belongs to whatever covers us. */
  const [hiddenFor, setHiddenFor] = useState<string | null>(null);
  const hidden = hiddenFor === id;

  /* Two more ways out, both landing on the same close: ESC, and the shell's
     Home item, which cannot reach this component's state and asks by event
     (Kev, 2026-08-13: "clicking on home when in image ui muss mich wieder
     zurück befördern wo ich war, das sollte auch mitm ESC gehen"). ESC is
     heard on the document, bubbling: after every layer inside the view that
     takes it first (viewer, sheets, menus, the history drawer in the capture
     phase; a field's own Esc in React, which stops it), and before the
     shell's panel under the view (EnkiPanel, on the window), which keeps
     its place: the profile stays open behind a prompt opened from it. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || hidden || e.cancelBubble || e.defaultPrevented) return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    const onHide = () => setHiddenFor(id);
    const onShow = () => setHiddenFor(null);
    document.addEventListener("keydown", onKey);
    window.addEventListener("enki:close-detail", onClose);
    window.addEventListener("enki:hide-detail", onHide);
    window.addEventListener("enki:show-detail", onShow);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("enki:close-detail", onClose);
      window.removeEventListener("enki:hide-detail", onHide);
      window.removeEventListener("enki:show-detail", onShow);
    };
  }, [onClose, hidden, id]);

  return (
    /* No close button of its own: the view draws Back and X (handoff §2). */
    <div className={"iv-frame" + (hidden ? " is-hidden" : "")}>
      <ImageView key={id} seed={seed} onClose={onClose} />
    </div>
  );
}
