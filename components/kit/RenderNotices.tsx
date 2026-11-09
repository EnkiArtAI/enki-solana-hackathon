"use client";

import { useEffect, useEffectEvent, useState, useSyncExternalStore, type FocusEvent } from "react";
import { useRouter } from "next/navigation";
import { promptPage } from "@/lib/ui/image-view/open-link";
import { clearRenders, dismissRender, noticeSeconds, OPEN_RENDER_EVENT, renderNotices, subscribeRenders, wantRender, type OpenRender, type RenderNotice } from "@/lib/ui/kit/render-notices";
import "./kit-notices.css";

const NONE: RenderNotice[] = [];
/** Where the app is a phone: one notice at a time there, so they never cover its Back and image. */
const PHONE = "(max-width: 1023.98px)";
const onPhone = (l: () => void) => { const q = window.matchMedia(PHONE); q.addEventListener("change", l); return () => q.removeEventListener("change", l); };
const onShown = (l: () => void) => { document.addEventListener("visibilitychange", l); return () => document.removeEventListener("visibilitychange", l); };

/**
 * Finished renders, wherever the reader is on the site (Kev, 2026-10-26): a
 * notice slides in at the top right, along the top on a phone, above every
 * layer. A click leads straight to the image: the Image View that shows its
 * prompt opens it in its viewer, else the prompt's page opens and its view
 * does (a blank composer's render: the reader's gallery); the viewer's Esc or
 * close leaves it on that view's stage. × or the reader's seconds in sight
 * (Settings → Profile, 5 by default) let it go; the time waits in a
 * background tab and under the pointer or the focus.
 */
export default function RenderNotices() {
  const all = useSyncExternalStore(subscribeRenders, renderNotices, () => NONE);
  const phone = useSyncExternalStore(onPhone, () => window.matchMedia(PHONE).matches, () => false);
  const away = useSyncExternalStore(onShown, () => document.hidden, () => false);
  const router = useRouter();
  // Walled by the gate (signed out): the notices go with the page.
  useEffect(() => clearRenders, []);
  const open = (n: RenderNotice) => {
    dismissRender(n.key);
    const taken = !window.dispatchEvent(new CustomEvent<OpenRender>(OPEN_RENDER_EVENT, { detail: { promptId: n.promptId, src: n.src }, cancelable: true }));
    if (taken) return;
    if (!n.promptId) return router.push("/profile");
    wantRender(n.promptId, n.src);
    // Its address names no panel: a panel over the view (Settings, a profile) gives way, and Back brings it back (EnkiHome).
    router.push(promptPage(n.promptId));
  };
  // Always there, empty or not: a live region must exist before what it announces arrives.
  return (
    <div className="ek-ready-list" role="region" aria-label="Finished renders" aria-live="polite">
      {all.slice(0, phone ? 1 : 3).map((n) => (
        <Notice key={n.key} notice={n} paused={away} onOpen={() => open(n)} onClose={() => dismissRender(n.key)} />
      ))}
    </div>
  );
}

function Notice({ notice: n, paused, onOpen, onClose }: { notice: RenderNotice; paused: boolean; onOpen: () => void; onClose: () => void }) {
  const [held, setHeld] = useState(false);
  const leave = useEffectEvent(onClose);
  useEffect(() => {
    // Read as the time starts: a choice made in Settings counts from the next notice or the next pause.
    const seconds = noticeSeconds();
    if (paused || held || !seconds) return;
    const t = setTimeout(leave, seconds * 1000);
    return () => clearTimeout(t);
  }, [paused, held]);
  // Moving between its own two buttons keeps it held.
  const out = (e: FocusEvent<HTMLDivElement>) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHeld(false); };
  return (
    // Esc on a focused notice lets it go, and nothing behind it hears the key (the Image View would close).
    <div className="ek-ready" onPointerEnter={() => setHeld(true)} onPointerLeave={() => setHeld(false)} onFocus={() => setHeld(true)} onBlur={out}
      onKeyDown={(e) => { if (e.key !== "Escape") return; e.stopPropagation(); onClose(); }}>
      <button type="button" className="ek-ready-open" aria-label={`Your render is ready · ${n.title} · open it`} onClick={onOpen}>
        {/* eslint-disable-next-line @next/next/no-img-element -- the render's own stored image */}
        <img src={n.src} alt="" draggable={false} />
        <span className="ek-ready-text"><b>Your render is ready</b><span>{n.title}</span></span>
      </button>
      <button type="button" className="ek-ready-x kit-hit" aria-label="Dismiss" onClick={onClose}>×</button>
    </div>
  );
}
