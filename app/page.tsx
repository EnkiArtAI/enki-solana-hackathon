"use client";

import { useEffect, useRef, useState } from "react";
import { useTheme } from "../providers/ThemeProvider";
import { WalletPickerModal } from "@/components/WalletPickerModal";
import { sessionAuthHeaders } from "@/lib/session-headers";

/** When the landing last renewed a signed-in browser's access cookie (sessionStorage, ms). */
const RENEWED = "enki:access-renewed";

// The marketing site is the landing page. It lives as a self-contained
// document at /landing.html and is embedded below the app's global header.
// The browse/feed experience now lives at /explore.
//
// The landing reads the active "Color setup" from localStorage on load and
// from the `storage` event; we also postMessage the theme directly so a switch
// in the profile menu re-tints the landing instantly.
export default function HomePage() {
  const { theme } = useTheme();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [showWalletPicker, setShowWalletPicker] = useState(false);

  useEffect(() => {
    iframeRef.current?.contentWindow?.postMessage({ type: "enki-theme", theme }, "*");
  }, [theme]);

  // The landing iframe owns all scrolling. Without this, the app shell's
  // `scrollbar-gutter: stable` (globals.css) reserves a permanent dark
  // gutter next to the iframe's own scrollbar — a dead dark column on the
  // right edge. Neutralise both while the landing is mounted.
  useEffect(() => {
    const html = document.documentElement;
    const prevOverflow = html.style.overflow;
    const prevGutter = html.style.scrollbarGutter;
    html.style.overflow = "hidden";
    html.style.scrollbarGutter = "auto";
    return () => {
      html.style.overflow = prevOverflow;
      html.style.scrollbarGutter = prevGutter;
    };
  }, []);

  // The landing (inside the iframe) has its own email/password login. Its
  // "Continue with Wallet" button postMessages enki-open-wallet; the app shell
  // opens the external-wallet picker (the wallet list) so the user stays put.
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.source !== iframeRef.current?.contentWindow) return;
      if ((e.data as { type?: string })?.type === "enki-open-wallet") {
        setShowWalletPicker(true);
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  /* Signed in, but the server walled this browser out: its access cookie is gone or predates the signed one (DEC-434).
     The session renews it and the app opens, as after a login ("immer zu home pls nach landing page"). A session the
     server refuses stays here, and once a minute at most, so a cookie that does not stick never loops. */
  useEffect(() => {
    const headers = sessionAuthHeaders();
    if (!headers["X-Session-Token"]) return;
    try {
      if (Date.now() - Number(sessionStorage.getItem(RENEWED) ?? 0) < 60_000) return;
      sessionStorage.setItem(RENEWED, String(Date.now()));
    } catch { return; }
    void (async () => {
      const gate = await fetch("/api/gate").then((r) => r.json()).catch(() => null);
      if (!gate?.whitelistActive || gate.team) return;
      const me = await fetch("/api/ban/me", { headers }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      if (me?.admitted === true) window.location.replace("/home");
    })();
  }, []);

  // ESC pressed while focus sits in THIS window (not the landing iframe) —
  // forward it so the auth modal steps back / closes like a local ESC.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      iframeRef.current?.contentWindow?.postMessage({ type: "enki-esc" }, "*");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0 }}>
      <iframe
        ref={iframeRef}
        src="/landing.html"
        title="Enki Art"
        onLoad={() => {
          iframeRef.current?.contentWindow?.postMessage({ type: "enki-theme", theme }, "*");
          /* /?login=1 — in-app "Log in" buttons (profile gate, creator
             notice) land straight in the landing's auth modal instead of
             on the marketing page (Kev, 2026-08-24). */
          if (new URLSearchParams(window.location.search).get("login") === "1") {
            iframeRef.current?.contentWindow?.postMessage({ type: "enki-open-login" }, "*");
          }
        }}
        style={{ width: "100%", height: "100%", border: "none", display: "block" }}
      />
      <WalletPickerModal open={showWalletPicker} onClose={() => setShowWalletPicker(false)} />
    </div>
  );
}
