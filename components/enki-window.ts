import type { CSSProperties } from "react";

/**
 * The look of the app's small centred windows ("Confirm your email", "Private beta"): the shell's modal (enki-shell.css
 * .ek-modal, .ek-btn-2) in tokens every theme sets on <html>. Only the theme's tokens, no colour of its own.
 */
export const CARD: CSSProperties = {
  background: "var(--enki-paper)", color: "var(--enki-ink)", borderColor: "var(--enki-rule)", borderRadius: 18,
  boxShadow: "var(--enki-shadow-pop)", maxHeight: "calc(100vh - 32px)", overflowY: "auto",
};
export const PILL: CSSProperties = {
  width: "100%", minHeight: 46, borderRadius: 999, border: "1px solid var(--enki-rule)", background: "var(--enki-paper-2)",
  color: "var(--enki-ink)", fontSize: 14, fontWeight: 600,
};
export const CTA: CSSProperties = { ...PILL, border: "none", background: "var(--cta-bg)", color: "var(--cta-ink)" };
/** The windows' field: the app's one field, kit-base.css .st-input, its frame, type, colours and focus ring (DEC-2026-11-08-19). */
export const FIELD = "st-input";

/**
 * The layout's type, as in Settings (Kev, 2026-11-08: "die sollen die font struktur von unserem layout haben, was wir u.a.
 * auch bei settings haben"; DEC-2026-11-08-01). TITLE is the panels' page title (enki-shell.css .ek-page-title, Settings'
 * "Settings.") at a window's size, inline so the global h1-h6 rule (globals.css: serif 600, tracked tight) cannot reach it.
 * LABEL is Settings' small label (settings.css .set-holdings-label) in the quiet label tone. TEXT is Settings' text: the
 * page's sans (.set-page) at a section description's size (.set-section-desc); each window keeps its own colour for it.
 * lib/__tests__/window-type.test.ts holds the three to those rules.
 */
export const TITLE: CSSProperties = {
  fontFamily: "var(--font-serif), Georgia, serif", fontStyle: "italic", fontWeight: 400, fontSize: 28, lineHeight: 1.1,
  letterSpacing: "-0.02em", color: "var(--enki-ink)",
};
export const LABEL: CSSProperties = {
  fontFamily: "var(--font-jetbrains-mono), ui-monospace, monospace", fontSize: 10, letterSpacing: "2px", textTransform: "uppercase",
  color: "var(--enki-label-quiet)",
};
/** Settings' table column head (settings.css .set-table th): LABEL's face at 10px, uppercase, tracked 1px, in ink-3 (DEC-2026-11-08-09). */
export const TABLE_HEAD: CSSProperties = {
  fontFamily: LABEL.fontFamily, fontSize: 10, letterSpacing: "1px", textTransform: "uppercase", color: "var(--enki-ink-3)",
};
/** The one code field (DEC-2026-11-08-11): the card pages' code (DEC-2026-11-08-02), LABEL's face at 26px, 700, tracked
 *  0.45em, centred. Keep the key order: the login popup's field drops only the face, and its markup is pinned byte for byte. */
export const CODE: CSSProperties = { textAlign: "center", fontSize: 26, letterSpacing: "0.45em", fontFamily: LABEL.fontFamily, fontWeight: 700 };
export const TEXT: CSSProperties = { fontFamily: "var(--font-geist-sans), system-ui, sans-serif", fontSize: 13.5, lineHeight: 1.6 };
/** The windows' corner button, close and back (DEC-2026-11-08-14): the shell's .ek-modal-x, a 34px circle on paper-2 with the
 *  rule, in ink-2, its icon centred; opaque, so a corner never reads as disabled. */
export const ROUND: CSSProperties = {
  width: 34, height: 34, borderRadius: "50%", border: "1px solid var(--enki-rule)", background: "var(--enki-paper-2)", color: "var(--enki-ink-2)",
  display: "flex", alignItems: "center", justifyContent: "center", opacity: 1,
};
export const CORNER = "absolute top-4 rounded-sm opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring disabled:pointer-events-none";
