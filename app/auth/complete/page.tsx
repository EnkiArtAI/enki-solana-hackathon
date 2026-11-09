"use client";

/**
 * /auth/complete#next=/path  or  #error=code
 *
 * The OAuth callback lands here with the session in a short lived httpOnly
 * cookie, never in the URL. The page collects it with one POST to
 * /api/auth/oauth/complete (which clears the cookie), stores it exactly like
 * a password login, wipes the fragment from history and moves on to `next`,
 * or to /banned for a banned account. Without the cookie, which only the
 * browser that finished the provider round trip holds, the POST answers 401
 * and nothing is stored: a link somebody else crafted cannot sign anyone in.
 */
import Link from "next/link";
/* Defines `.ek-app` and the --enki-* tokens this page paints with, in the app's colour mode, as /banned does. */
import "@/components/enki-shell/enki-shell.css";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { storeSession } from "@/hooks/useEmailAuth";
import { ERROR_SENTENCES, errorSentence, sanitizeNext } from "@/lib/auth/oauth-shared";
import PrivateBetaWindow from "@/components/PrivateBetaWindow";
import { CARD, CTA, TEXT } from "@/components/enki-window";

// The fragment is browser only state: read it as an external store so the
// server snapshot (empty) hydrates cleanly and the client re-renders with it.
const never = () => () => {};
const useHash = () => useSyncExternalStore(never, () => window.location.hash, () => "");
const sentence = (code: string | null) => (code ? errorSentence(code) : null);

export default function AuthCompletePage() {
  const fragmentCode = new URLSearchParams(useHash().replace(/^#/, "")).get("error");
  const fragmentError = sentence(fragmentCode);
  const [collectError, setCollectError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    // The live fragment, not the render snapshot: the hydration pass renders with an empty one.
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    if (params.get("error") || started.current) return;
    started.current = true; // the cookie is single use: one POST, even under strict mode
    const next = sanitizeNext(params.get("next"));
    window.history.replaceState(null, "", window.location.pathname);
    /* As the landing's adoptSession: one identity at a time. Before the handover, not after: the shell's check on this
       page would otherwise ask with an old, dead token, and its "Not signed in" takes the access cookie this login
       just set (review wf_866ba07b-01a). */
    try {
      localStorage.removeItem("solana-auth-session");
      localStorage.removeItem("enki_session_token");
      localStorage.removeItem("enki_session_email");
    } catch { /* storage off: nothing old to send */ }
    fetch("/api/auth/oauth/complete", { method: "POST" })
      .then(async (res) => {
        if (!res.ok) {
          setCollectError(ERROR_SENTENCES.state_mismatch);
          return;
        }
        const data = (await res.json()) as { token: string; email: string | null; banned: boolean };
        // A locked wallet asks at once.
        try { sessionStorage.setItem("enki:wallet-ask", "1"); } catch { /* storage off: the next wallet action asks */ }
        storeSession({ token: data.token, email: data.email ?? undefined });
        window.location.replace(data.banned ? "/banned" : next);
      })
      .catch(() => setCollectError(ERROR_SENTENCES.provider_error));
  }, []);

  const error = fragmentError ?? collectError;
  // A card of the app's own, in its colour mode and with its Create button's colours (Kev, 2026-10-28, DEC-490).
  return (
    <main className="ek-app" style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 16, background: "var(--enki-paper-2)", color: "var(--enki-ink)" }}>
      <div style={{ ...CARD, width: "100%", maxWidth: 380, padding: "32px 28px", textAlign: "center", borderWidth: 1, borderStyle: "solid" }}>
        {/* Kev's wordmark, see-through; the dark themes turn its black white (enki-shell.css). */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/enki-wordmark.svg" alt="Enki Art" style={{ height: 30, width: "auto", display: "inline-block", marginBottom: 24 }} />
        {error ? (
          <>
            <p style={{ ...TEXT, color: "var(--enki-ink-2)", margin: "0 0 24px" }}>{error}</p>
            <Link
              href="/?login=1"
              style={{ ...CTA, display: "flex", alignItems: "center", justifyContent: "center", textDecoration: "none" }}
            >
              Back to log in
            </Link>
          </>
        ) : (
          <p style={{ ...TEXT, color: "var(--enki-ink-2)", margin: 0 }}>Signing you in…</p>
        )}
      </div>
      {/* Not on the access list: the closed beta's own window, to enter a code or apply (Kev, 2026-11-07). */}
      {fragmentCode === "not_whitelisted" && <PrivateBetaWindow next="/home" />}
    </main>
  );
}
