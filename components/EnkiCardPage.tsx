"use client";

import { createContext, useContext, type CSSProperties } from "react";
import { ChevronLeft } from "lucide-react";
import { CARD, CTA, LABEL, PILL, ROUND, TITLE } from "@/components/enki-window";

/**
 * Shared full-screen card for standalone link-target pages (/reset-password, /guardian): the look of the app's small
 * windows ("Confirm your email", "Private beta": components/enki-window.ts) in the theme's tokens. Inside the landing's
 * login popup (embed) it takes the popup's own look (LANDING). What the pages put on the card reads its colours from the
 * card (var(--card-*)) or is one of the parts below, so this file alone decides them and the pages carry none of their own.
 */

/** The colours the card's contents read, from the theme. --enki-label-quiet is the theme's quiet label: ink-3 in light,
 *  ink-2 in dark and purple, where ink-3 stays under 4.5:1 (DEC-2026-11-07-37). */
const THEME = {
  "--card-ink": "var(--enki-ink)",
  "--card-ink-2": "var(--enki-ink-2)",
  "--card-quiet": "var(--enki-label-quiet)",
  "--card-faint": "var(--enki-label-quiet)",
  "--card-field": "var(--enki-paper-2)",
  "--card-rule": "var(--enki-rule)",
  "--card-accent": "var(--enki-ember)",
  "--card-danger": "var(--enki-danger)",
  "--card-green": "var(--enki-green)",
} as CSSProperties;

/** The landing login popup's own look, inside it (/reset-password?embed=1): public/landing.html's .auth-modal and the rules
 *  of its login step, in each landing theme (DEC-2026-11-07-41). The only place the app keeps these values;
 *  lib/__tests__/old-card-tokens.test.ts holds every one of them to the landing's. */
export const LANDING = {
  font: "var(--font-dm-sans), 'DM Sans', system-ui, sans-serif",
  /** The popup's type (.auth-success-title's DM Sans 800) at a heading's size; upright. */
  title: { fontFamily: "var(--font-dm-sans), 'DM Sans', system-ui, sans-serif", fontWeight: 800, fontSize: "1.25rem", lineHeight: 1.3, letterSpacing: "normal" },
  /** What the pages read, in the popup's declarations: the ink of .auth-input, the text of .auth-note, the colour of
   *  .auth-forgot / .auth-link; the done mark in the ink, as the popup's ✦ in its success ring. */
  colours: {
    "--card-ink": "rgb(var(--lp-text-rgb))",
    "--card-ink-2": "rgba(var(--lp-text-rgb),0.6)",
    "--card-quiet": "rgba(var(--lp-text-rgb),0.6)",
    "--card-accent": "var(--auth-link, var(--lp-light1))",
    "--card-green": "rgb(var(--lp-text-rgb))",
  } as CSSProperties,
  /** Per landing theme, the tokens the rules below read: its theme block (:root = teal, html.lp-purple, html.lp-light)
   *  with .auth-modal's own on top; --ek-panel is .auth-modal's background. */
  themes: {
    teal: {
      "--ek-panel": "#0E0E12", "--lp-text-rgb": "244, 238, 232", "--lp-accent-rgb": "240, 168, 104", "--lp-accent2-rgb": "240, 168, 104",
      "--lp-deep": "#d9863f", "--lp-glow": "#e8a83a", "--lp-glow-rgb": "232, 168, 58", "--lp-light1": "#ffe8c2", "--lp-bright": "#ffd9a0",
    },
    purple: {
      "--ek-panel": "#0E0E12", "--lp-text-rgb": "244, 238, 232", "--lp-accent-rgb": "168, 85, 247", "--lp-accent2-rgb": "139, 92, 246",
      "--lp-deep": "#d9863f", "--lp-glow": "#e8a83a", "--lp-glow-rgb": "232, 168, 58", "--lp-light1": "#A78BFA", "--lp-bright": "#ffd9a0",
    },
    light: {
      "--ek-panel": "#fff", "--lp-text-rgb": "12, 12, 12", "--auth-link": "#850814", "--lp-accent-rgb": "133, 8, 20", "--lp-accent2-rgb": "133, 8, 20",
      "--lp-deep": "#850814", "--lp-glow": "#a01426", "--lp-glow-rgb": "160, 20, 38", "--lp-light1": "#d06a77", "--lp-bright": "#b3233a",
    },
  },
  /** The popup's rules, copied as public/landing.html writes them; the app's DM Sans is named first (its font variable). */
  popup: `
  .auth-close {
    position: sticky; top: 2px; z-index: 10;
    display: flex; align-items: center; justify-content: center;
    width: 30px; height: 30px; padding: 0; margin: -14px -22px 0 auto;
    border: 1px solid rgba(var(--lp-text-rgb),0.16); border-radius: 50%;
    background: rgba(18,18,24,0.94); -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
    color: rgba(var(--lp-text-rgb),0.72); font-size: 14px; line-height: 0; cursor: pointer;
    transition: background .2s, color .2s, border-color .2s;
  }
  .auth-close:hover { background: rgba(var(--lp-accent-rgb),0.22); color: rgb(var(--lp-text-rgb)); border-color: rgba(var(--lp-accent-rgb),0.55); }
  html.lp-light .auth-close { background: rgba(255, 255, 255, 0.94); }
  .auth-input {
    width: 100%; padding: 11px 14px; border-radius: 10px;
    background: rgba(var(--lp-text-rgb),0.05); border: 1.5px solid rgba(var(--lp-text-rgb),0.1);
    color: rgb(var(--lp-text-rgb)); font-family: var(--font-dm-sans), 'DM Sans', sans-serif; font-size: 0.85rem;
    outline: none; transition: border-color 0.15s, background 0.15s;
  }
  .auth-input:focus { border-color: rgba(var(--lp-accent2-rgb),0.55); background: rgba(var(--lp-accent2-rgb),0.06); }
  .auth-input::placeholder { color: rgba(var(--lp-text-rgb),0.25); }
  .auth-forgot, .auth-link {
    font-size: 0.75rem; color: var(--auth-link, var(--lp-light1)); text-decoration: none;
    transition: color 0.15s;
  }
  .auth-forgot:hover, .auth-link:hover { color: var(--lp-bright); }
  .auth-submit {
    width: 100%; padding: 13px; border-radius: 11px; border: none;
    background: linear-gradient(135deg, var(--lp-deep), var(--lp-glow), var(--lp-light1));
    color: white; font-family: var(--font-dm-sans), 'DM Sans', sans-serif; font-size: 0.875rem;
    font-weight: 800; cursor: pointer; letter-spacing: 0.01em;
    box-shadow: 0 6px 20px rgba(var(--lp-glow-rgb),0.45);
    transition: all 0.2s; display: flex; align-items: center; justify-content: center;
    gap: 8px; position: relative; margin-bottom: 16px;
  }
  .auth-submit:hover { box-shadow: 0 8px 28px rgba(var(--lp-glow-rgb),0.65); transform: translateY(-1px); }
  .auth-submit:disabled { opacity: 0.6; transform: none; }
  .auth-social {
    width: 100%; padding: 11px; border-radius: 11px;
    background: rgba(var(--lp-text-rgb),0.06); border: 1.5px solid rgba(var(--lp-text-rgb),0.1);
    color: rgb(var(--lp-text-rgb)); font-family: var(--font-dm-sans), 'DM Sans', sans-serif; font-size: 0.82rem; font-weight: 600;
    cursor: pointer; display: flex; align-items: center; justify-content: center;
    gap: 10px; transition: all 0.15s; margin-bottom: 20px;
  }
  .auth-social:hover { background: rgba(var(--lp-text-rgb),0.1); border-color: rgba(var(--lp-text-rgb),0.2); }
  .auth-note {
    font-size: 0.74rem; line-height: 1.55; color: rgba(var(--lp-text-rgb),0.6);
    background: rgba(var(--lp-accent2-rgb),0.08); border: 1px solid rgba(var(--lp-accent2-rgb),0.2);
    border-radius: 10px; padding: 10px 13px; margin-bottom: 18px;
  }
  .auth-success-icon {
    width: 56px; height: 56px; border-radius: 50%;
    background: rgba(52,211,153,0.15); border: 2px solid rgba(52,211,153,0.3);
    display: flex; align-items: center; justify-content: center;
    font-size: 1.4rem; margin: 0 auto 16px;
  }
`,
  /** Where the card's layout differs from the popup's: the back arrow on the left, the card's gaps instead of the popup's
   *  bottom margins, the two-line tiles left-aligned, the done mark at its line's height. No colour. */
  fit: `
  .ek-embed .auth-close { margin: 0; }
  .ek-embed .auth-submit { margin-bottom: 0; }
  .ek-embed .auth-social { justify-content: flex-start; gap: 14px; padding: 16px; margin-bottom: 0; text-align: left; font-weight: 400; }
  .ek-embed .auth-success-icon { width: 30px; height: 30px; margin: 0; flex-shrink: 0; }
`,
};

/** The landing's themes on the iframe's <html>: it is a page of the app, whose layout script (app/layout.tsx) sets the
 *  classes before the first paint from the same localStorage 'theme' the landing reads: light none (lp-light), teal .dark
 *  (the landing's default), purple .dark.theme-purple (lp-purple). The frame's page takes the popup's panel. */
const ON = { teal: ":root", purple: ":root.theme-purple", light: ":root:not(.dark)" } as const;
const EMBED_CSS = [
  ...(Object.keys(ON) as (keyof typeof ON)[]).map((t) => `${ON[t]} { ${Object.entries(LANDING.themes[t]).map(([k, v]) => `${k}: ${v};`).join(" ")} }`),
  ":root, :root body { background: var(--ek-panel); }",
  LANDING.popup.replaceAll("html.lp-light ", `${ON.light} `),
  LANDING.fit,
].join("\n");

/** Whether the card sits in the landing's popup: its parts take the popup's rules there. */
const Embedded = createContext(false);

export default function EnkiCardPage({
  eyebrow = "Enki Art",
  title,
  children,
  maxWidth = 440,
  embed = false,
  onBack,
}: {
  eyebrow?: string;
  title: string;
  children: React.ReactNode;
  maxWidth?: number;
  /** embed=true: no full-screen backdrop/card chrome — for iframing inside the login popup. */
  embed?: boolean;
  /** Renders a ← back arrow next to the eyebrow. */
  onBack?: () => void;
}) {
  const card = (
    <div
      style={
        embed
          ? { ...LANDING.colours, width: "100%", color: "var(--card-ink)", padding: "4px 20px" }
          : { ...THEME, ...CARD, width: "100%", maxWidth, borderWidth: 1, borderStyle: "solid", padding: "36px 32px" }
      }
    >
      {/* Embedded in the login popup the modal provides its own context — no
          eyebrow; just the back arrow when there's somewhere to go back to. */}
      {(!embed || onBack) && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 18 }}>
          {onBack && (
            <button
              onClick={onBack}
              aria-label="Back"
              className={embed ? "auth-close" : "kit-round"}
              style={embed ? undefined : { ...ROUND, cursor: "pointer", marginRight: 4 }}
            >
              {embed ? "←" : <ChevronLeft className="h-4 w-4" />}
            </button>
          )}
          {!embed && (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element -- the windows' mark, an SVG: next/image adds nothing here */}
              <img src="/favicon.svg" alt="" width={16} height={16} />
              <span style={{ ...LABEL, color: "var(--card-quiet)" }}>
                {eyebrow}
              </span>
            </>
          )}
        </div>
      )}
      {/* The windows' title, the layout's (enki-window.ts TITLE); the popup's type in its popup. */}
      <h1 style={{ ...(embed ? LANDING.title : TITLE), margin: "0 0 12px", color: "var(--card-ink)" }}>
        {title}
      </h1>
      {children}
    </div>
  );

  if (embed) {
    // The popup's rules and its panel per theme, in the server's HTML: the frame paints the popup's look from its first
    // frame, keyed on the <html> classes the layout's script has already set.
    return (
      <Embedded.Provider value>
        <style dangerouslySetInnerHTML={{ __html: EMBED_CSS }} />
        <div className="ek-embed" style={{ fontFamily: LANDING.font }}>
          {card}
        </div>
      </Embedded.Provider>
    );
  }
  // Around the card, the app's own ground (globals.css body: hsl(var(--background))), so the page reads as the app.
  return (
    <div
      style={{
        position: "fixed", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
        background: "hsl(var(--background))", padding: 20,
      }}
    >
      {card}
    </div>
  );
}

/** The card's field: the app's one field (kit-base.css .st-input, DEC-2026-11-08-19) on the app's pages; the popup's field
 *  in its popup. Its placeholder is the quiet label: Tailwind's default (the ink at 50%) reads 3.48:1 on light's paper-2,
 *  and some of these placeholders are the field's only label (DEC-2026-11-07-39). In the popup the field keeps the popup's
 *  type: a page's own font family stays on its own page (DEC-2026-11-07-44). */
export function EnkiCardInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  const embed = useContext(Embedded);
  if (embed) return <input className="auth-input" {...props} style={props.style && { ...props.style, fontFamily: undefined }} />;
  return <input className="st-input" {...props} />;
}

/** The card's primary button: the windows' CTA, and the PILL half see-through while disabled; the popup's submit in its popup. */
export function EnkiCardButton({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const embed = useContext(Embedded);
  if (embed) return <button className="auth-submit" {...props}>{children}</button>;
  const look = props.disabled ? { ...PILL, opacity: 0.5 } : CTA;
  return (
    <button {...props} style={{ width: "100%", fontSize: 14, ...look, cursor: props.disabled ? "not-allowed" : "pointer", ...props.style }}>
      {children}
    </button>
  );
}

/** A text button: underlined in the quiet label on the app's pages; the popup's link (.auth-link, its hover colour
 *  included) in its popup, where the app's preflight already clears a button's fill and border (DEC-2026-11-07-43). */
export function EnkiCardLink({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const embed = useContext(Embedded);
  return (
    <button type="button" {...props} className={embed ? "auth-link" : undefined}
      style={embed ? { cursor: "pointer" } : { background: "none", border: "none", color: "var(--card-faint)", fontSize: 12.5, cursor: "pointer", textDecoration: "underline" }}>
      {children}
    </button>
  );
}

/** A choice tile: the field's fill and rule on the app's pages; the popup's social button (.auth-social) in its popup. */
export function EnkiCardChoice({ icon, title, sub, onClick }: { icon: React.ReactNode; title: string; sub: string; onClick: () => void }) {
  const embed = useContext(Embedded);
  return (
    <button onClick={onClick} className={embed ? "auth-social" : undefined}
      style={embed ? undefined : {
        display: "flex", alignItems: "center", gap: 14, textAlign: "left", cursor: "pointer",
        padding: "16px 16px", borderRadius: 12, border: "1px solid var(--card-rule)",
        background: "var(--card-field)", color: "var(--card-ink)",
      }}>
      <span style={{ color: "var(--card-accent)" }}>{icon}</span>
      <span>
        <span style={{ display: "block", fontSize: 14, fontWeight: 700 }}>{title}</span>
        <span style={{ display: "block", fontSize: 12.5, color: "var(--card-quiet)" }}>{sub}</span>
      </span>
    </button>
  );
}

/** The card's error line: the danger colour on the app's pages; in the popup a note (.auth-note), as the popup shows its own errors. */
export function EnkiCardNote({ children, style }: { children: React.ReactNode; style?: CSSProperties }) {
  const embed = useContext(Embedded);
  return (
    <p className={embed ? "auth-note" : undefined} style={{ ...(embed ? {} : { fontSize: 13, color: "var(--card-danger)" }), margin: "10px 0 0", ...style }}>
      {children}
    </p>
  );
}

/** The done mark: as drawn on the app's pages; in the popup inside its success ring (.auth-success-icon). */
export function EnkiCardDoneMark({ children }: { children: React.ReactNode }) {
  const embed = useContext(Embedded);
  return embed ? <span className="auth-success-icon">{children}</span> : <>{children}</>;
}
