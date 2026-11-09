"use client";

import { useEffect, useState } from "react";
import { gateNext } from "@/lib/gate-next";
import { CARD, CTA, FIELD, PILL, TEXT, TITLE } from "@/components/enki-window";

// Decorative, non-interactive copy of the app's left menu — shown ONLY as an
// ultra-blurred backdrop so the gate reads as "the app, locked", without ever
// rendering real app content. The real protection is server-side (proxy.ts):
// removing this popup in devtools reveals nothing, because /home & co. are
// blocked at the edge and never sent to an unauthenticated visitor.
const MENU = [
  "Home",
  "Search",
  "Favorites",
  "Hall of Fame",
  "History",
  "Messages",
  "Color Setup",
  "Settings",
];

/** The gate is one of the app's windows ("Private beta" sends people here): the windows' card, title, lines, field and
 *  buttons (components/enki-window.ts) over the windows' veil (.ek-modal-scrim), in the theme's tones (DEC-2026-11-08-20). */
const LINE: React.CSSProperties = { ...TEXT, color: "var(--enki-ink-2)" };
const VEIL: React.CSSProperties = { background: "rgba(0, 0, 0, 0.5)", backdropFilter: "blur(6px)", WebkitBackdropFilter: "blur(6px)" };

/** A trial code's second step: the tester signs in with an own account, so Enki can reach them later (Kev, 2026-10-26). */
function TrialSignIn() {
  const [providers, setProviders] = useState<{ google: boolean; x: boolean } | null>(null);
  useEffect(() => {
    fetch("/api/auth/oauth/providers").then((r) => r.json()).then(setProviders).catch(() => setProviders({ google: false, x: false }));
  }, []);
  const start = (p: "google" | "x") => `/api/auth/oauth/${p}/start?next=${encodeURIComponent(gateNext(new URLSearchParams(window.location.search).get("next")))}`;
  const button: React.CSSProperties = { ...PILL, display: "flex", alignItems: "center", justifyContent: "center", marginTop: 10, textDecoration: "none" };
  return (
    <>
      <h1 style={{ ...TITLE, margin: "0 0 10px" }}>Code accepted</h1>
      <p style={{ ...LINE, margin: "0 0 18px" }}>
        Sign in with your own account to start your trial. Your time starts when you sign in.
      </p>
      {providers?.google && <a href={start("google")} style={button}>Continue with Google</a>}
      {providers?.x && <a href={start("x")} style={button}>Continue with X</a>}
      {/* The landing's own sign-in, opened in place (lib/openLogin falls back to it outside the shell). */}
      <button type="button" onClick={() => window.location.assign("/?login=1")} style={{ ...button, cursor: "pointer" }}>Sign in with email</button>
    </>
  );
}

export default function GatePage() {
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [trial, setTrial] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!code.trim()) return;
    setLoading(true);
    setErr("");
    try {
      const r = await fetch("/api/gate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        /* Trimmed: a code pasted from a password manager or chat often
           carries a trailing space or newline, and the server compares
           exactly — "Wrong access code" for a correct code (Kev,
           2026-08-22). Whitespace is never part of the code. */
        body: JSON.stringify({ code: code.trim() }),
      });
      if (r.ok) {
        // A trial code: the tester signs in next, with an own account.
        if ((await r.clone().json().catch(() => null))?.trial === true) {
          setTrial(true);
          return;
        }
        // The team code opens nothing by itself (DEC-434): the landing's sign-in, which opens /home.
        window.location.href = "/?login=1";
        return;
      }
      const j = await r.json().catch(() => ({}));
      setErr(j?.error || "Wrong access code");
    } catch {
      setErr("Something went wrong. Try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        overflow: "hidden",
        background: "hsl(var(--background))",
        color: "var(--enki-ink)",
      }}
    >
      {/* ── ultra-blurred left menu (decoration only, never interactive) ── */}
      <aside
        aria-hidden
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          bottom: 0,
          width: 248,
          padding: "24px 18px",
          background: "var(--enki-paper)",
          borderRight: "1px solid var(--enki-rule)",
          filter: "blur(7px)",
          opacity: 0.55,
          pointerEvents: "none",
          userSelect: "none",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 30 }}>
          <img src="/favicon.svg" alt="" width={30} height={30} />
          <span style={{ fontWeight: 800, letterSpacing: "0.04em", fontSize: "1.05rem" }}>ENKI ART</span>
        </div>
        {MENU.map((label) => (
          <div key={label} style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 10px" }}>
            <span
              style={{
                width: 18,
                height: 18,
                borderRadius: 6,
                background: "var(--enki-paper-3)",
                flexShrink: 0,
              }}
            />
            <span style={{ fontSize: "0.92rem", color: "var(--enki-ink-2)" }}>{label}</span>
          </div>
        ))}
      </aside>

      {/* the windows' veil over the app, so the whole scene reads as out of reach */}
      <div style={{ position: "absolute", inset: 0, ...VEIL, pointerEvents: "none" }} />

      {/* ── the popup: centered over everything, nothing else in the middle ── */}
      <div
        style={{
          position: "fixed",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
        }}
      >
        <form onSubmit={submit} style={{ ...CARD, width: "100%", maxWidth: 380, padding: "32px 28px", textAlign: "center", borderWidth: 1, borderStyle: "solid" }}>
          <img src="/favicon.svg" alt="Enki Art" width={56} height={56} style={{ margin: "0 auto 16px", display: "block" }} />
          {trial ? <TrialSignIn /> : (
          <>
          <h1 style={{ ...TITLE, margin: "0 0 10px" }}>Private build</h1>
          <p style={{ ...LINE, margin: "0 0 22px" }}>
            Enki Art is in private development. Enter your access code or trial code to continue.
          </p>

          <input
            type="password"
            className={FIELD}
            aria-invalid={err ? true : undefined}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="Access code"
            autoFocus
            autoComplete="off"
          />

          {/* Always rendered with reserved height so the centered card never shifts when the error appears */}
          <div style={{ color: "var(--enki-danger)", fontSize: "0.8rem", marginTop: 10, textAlign: "left", minHeight: "1.2em", visibility: err ? "visible" : "hidden" }}>{err || " "}</div>

          <button
            type="submit"
            disabled={loading}
            style={{ ...CTA, marginTop: 18, cursor: loading ? "default" : "pointer", opacity: loading ? 0.7 : 1 }}
          >
            {loading ? "Checking…" : "Enter"}
          </button>
          </>
          )}

          <a href="/" style={{ display: "inline-block", marginTop: 16, fontSize: 12.5, color: "var(--enki-label-quiet)", textDecoration: "underline" }}>
            ← Back to landing page
          </a>
        </form>
      </div>
    </div>
  );
}
