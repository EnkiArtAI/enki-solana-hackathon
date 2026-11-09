import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CARD, CTA, FIELD, LABEL, PILL, ROUND, TABLE_HEAD, TEXT, TITLE } from "@/components/enki-window";
import { readSource } from "./_read-source";

/**
 * Kev, 2026-11-08: "fixe alles uneinheitliche" (fix everything inconsistent), after the app's windows took "die font struktur
 * von unserem layout, was wir u.a. auch bei settings haben" (DEC-2026-11-08-01..06). One look per role across the app's
 * windows, dialogs, sheets, popovers and panels, taken from the layout's own system: components/enki-window.ts (TITLE, LABEL,
 * TEXT) and the shell's rules. These pins read the system's source, not numbers typed here, so a role cannot drift from it.
 * Settings' own stylesheet is not read: Settings is replaced right after this sweep. Blind spot: no browser, so computed
 * style and the loaded font files are not seen here.
 */
const ROOT = join(__dirname, "..", "..");
const raw = (file: string) => readFileSync(join(ROOT, file), "utf8").split("\r\n").join("\n");
const sheet = (file: string) => raw(file).replace(/\/\*[^]*?\*\//g, "");
/** Every source file under the folders, as paths relative to the repo root; tests and generated folders left out. */
function sources(dirs: string[], ext: RegExp): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) { if (!/^(node_modules|__tests__|\.next)$/.test(e.name)) walk(rel); }
      else if (ext.test(e.name)) out.push(rel);
    }
  };
  dirs.forEach(walk);
  return out;
}
/** A file's code: CSS without its comments, TS/TSX as the compiler sees it. */
const code = (file: string) => (file.endsWith(".css") ? sheet(file) : readSource(join(ROOT, file)));
const APP = sources(["components", "app", "hooks", "providers", "lib"], /\.(css|tsx?)$/);

describe("one mono family: every small figure, label, code and metadata is LABEL's face (DEC-2026-11-08-08)", () => {
  it("--font-mono resolves to LABEL's family in both :root blocks, and Tailwind's font-mono follows it", () => {
    const g = sheet("app/globals.css");
    const decls = [...g.matchAll(/--font-mono:\s*([^;]+);/g)].map((m) => {
      const before = g.slice(0, m.index);
      const open = before.lastIndexOf("{");
      const block = before.slice(before.lastIndexOf("}", open) + 1, open).trim();
      return [block, m[1].trim()];
    });
    expect(decls).toEqual([
      [":root", LABEL.fontFamily],
      [":root", LABEL.fontFamily],
      ["@theme inline", "var(--font-mono)"],
    ]);
  });

  it("no source names Geist Mono, and the layout no longer loads it (DEC-2026-11-08-18)", () => {
    expect(APP.length).toBeGreaterThan(300);
    expect(APP).toContain("app/layout.tsx");
    const named = APP.filter((f) => /--font-geist-mono|geist[ -]?mono/i.test(code(f)));
    expect(named).toEqual([]);
    // The fonts the layout still loads each give <html> a variable, JetBrains Mono among them.
    expect(code("app/layout.tsx")).toMatch(/const fonts = `[^`]*\$\{jetbrainsMono\.variable\}[^`]*`;/);
  });
});

/** A rule's declarations, as the stylesheet writes them (its first rule of that selector at a line's start). */
const rule = (css: string, selector: string): Record<string, string> => {
  const body = css.match(new RegExp(`\\n${selector.replace(/[.()[\]*+?]/g, "\\$&")} \\{([^}]*)\\}`))?.[1];
  if (body === undefined) throw new Error(`no rule ${selector}`);
  return Object.fromEntries(body.split(";").map((d) => d.trim()).filter(Boolean).map((d) => [d.slice(0, d.indexOf(":")).trim(), d.slice(d.indexOf(":") + 1).trim()]));
};
/** A rule's type, with a `font` shorthand read into its parts (the shorthand sets the weight, 400 when it names none). */
function type(decls: Record<string, string>) {
  const f = decls.font?.match(/^(?:(italic|normal)\s+)?(?:(\d{3}|normal|bold)\s+)?([\d.]+px)(?:\/\S+)?\s+(.+)$/);
  return {
    family: f ? f[4] : decls["font-family"], size: f ? f[3] : decls["font-size"], weight: f ? (f[2] ?? "400") : decls["font-weight"],
    spacing: decls["letter-spacing"], transform: decls["text-transform"], color: decls.color,
  };
}
const px = (n: unknown) => `${n}px`;

describe("one label: LABEL's values everywhere, and Settings' table head (DEC-2026-11-08-09)", () => {
  it("TABLE_HEAD is Settings' table column head: LABEL's face at 10px, uppercase, tracked 1px, in ink-3", () => {
    expect(TABLE_HEAD).toEqual({ fontFamily: LABEL.fontFamily, fontSize: 10, letterSpacing: "1px", textTransform: "uppercase", color: "var(--enki-ink-3)" });
  });

  it(".kit-label, the image UI's label, is LABEL and nothing else", () => {
    expect(rule(sheet("components/kit/kit-base.css"), ".kit-label")).toEqual({
      "font-family": LABEL.fontFamily, "font-size": px(LABEL.fontSize), "letter-spacing": LABEL.letterSpacing,
      "text-transform": LABEL.textTransform, color: LABEL.color,
    });
  });

  // [stylesheet, selector, tone]: "quiet" was ink-3 and takes LABEL's tone; "stage" sits on the image stage and keeps its own;
  // "inherit" names none (the copy box dims its text with opacity).
  const LABELS: [string, string, "quiet" | "stage" | "inherit"][] = [
    ["components/kit/kit-controls.css", ".kit-menu-head", "quiet"],
    ["components/enki-shell/enki-shell.css", ".ek-color-dd-h", "quiet"],
    ["components/enki-shell/enki-shell.css", ".ek-msg-lab", "quiet"],
    ["components/enki-shell/enki-shell.css", ".ek-msg-sep span", "quiet"],
    ["components/image-view/image-view.css", ".iv-label", "quiet"],
    ["components/image-view/image-view.css", ".iv-vrefs > span", "stage"],
    ["components/image-view/image-view.css", ".iv-vsettings span", "stage"],
    ["components/prompt-editor/prompt-editor.css", ".pe-live-label", "quiet"],
    ["components/prompt-editor/verify.css", ".pe-sibs-label", "stage"],
    ["components/gallery/gallery-wall.css", ".gw-copybox-label", "inherit"],
    ["components/enki/feed.css", ".feed-gen-label", "quiet"],
    ["components/enki/feed.css", ".feed-suggest-kind", "quiet"],
    // Quick Create's label, the PROMPT over its live prompt (DEC-2026-11-08-28).
    ["app/editor/mobile-modal.css", ".mobile-modal-label", "quiet"],
  ];
  it.each(LABELS)("%s %s is LABEL's face, size, tracking, case and weight", (file, selector, tone) => {
    const t = type(rule(sheet(file), selector));
    expect({ family: t.family, size: t.size, spacing: t.spacing, transform: t.transform }).toEqual({
      family: LABEL.fontFamily, size: px(LABEL.fontSize), spacing: LABEL.letterSpacing, transform: LABEL.textTransform,
    });
    expect([undefined, "400"]).toContain(t.weight);
    if (tone === "quiet") expect(t.color).toBe(LABEL.color);
    else if (tone === "stage") expect(t.color).toMatch(/^color-mix\(in oklab, var\(--enki-on-stage\) \d+%, transparent\)$/);
    else expect(t.color).toBeUndefined();
  });

  it(".cm-merge-table th, Communities' table head, is TABLE_HEAD", () => {
    expect(type(rule(sheet("components/communities/communities.css"), ".cm-merge-table th"))).toEqual({
      family: TABLE_HEAD.fontFamily, size: px(TABLE_HEAD.fontSize), weight: "400", spacing: TABLE_HEAD.letterSpacing,
      transform: TABLE_HEAD.textTransform, color: TABLE_HEAD.color,
    });
  });

  const SITES: Record<string, string[]> = {
    "components/enki-shell/AnalyticsPanel.tsx": [
      "<span style={LABEL}>{label}</span>", "<span style={TABLE_HEAD}>#</span>", "<span style={TABLE_HEAD}>Creator</span>",
      'style={{ ...TABLE_HEAD, textAlign: "right", border: "none", background: "none", padding: 0, cursor: "pointer", fontWeight: on ? 700 : 400, color: on ? "var(--enki-ember)" : TABLE_HEAD.color }}',
    ],
    "components/enki-shell/NotificationsPanel.tsx": ['<div style={{ ...LABEL, margin: "6px 0 10px" }}>'],
    "components/profile/ProfileView.tsx": [
      "<div style={{ ...LABEL, marginBottom: 6 }}>Username</div>", "<div style={{ ...LABEL, marginBottom: 6 }}>Bio</div>",
      "<div style={LABEL}>{label}</div>", "<span style={LABEL}>{it.kind}</span>",
    ],
    "app/banned/page.tsx": [
      '<div style={{ ...card, ...LABEL, textAlign: "center" }}>Checking your account…</div>', "<div style={{ ...LABEL, marginBottom: 6 }}>Account status</div>",
      "<div style={{ ...LABEL, marginBottom: 6 }}>Appeal</div>", "<div style={{ ...LABEL, marginBottom: 6 }}>Your funds</div>",
    ],
    "app/leaderboard/page.tsx": [
      "const headCell = (extra?: React.CSSProperties): React.CSSProperties => ({ ...TABLE_HEAD, ...extra });",
      '<span style={{ ...LABEL, display: "block", marginBottom: 5 }}>Best prompt</span>', "<span style={headCell()}>Visibility</span>",
    ],
  };
  it.each(Object.entries(SITES))("%s spreads LABEL or TABLE_HEAD for every label and column head, and writes none by hand", (file, sites) => {
    const src = readSource(join(ROOT, file));
    for (const s of sites) expect(src).toContain(s);
    // The role carries the type: no spread overrides it, and no uppercase style of its own is left in the file.
    expect([...src.matchAll(/\.\.\.(?:LABEL|TABLE_HEAD)\b[^}]*\}/g)].map((m) => m[0]).filter((s) => /fontFamily|fontSize|letterSpacing|textTransform/.test(s))).toEqual([]);
    expect(src).not.toMatch(/textTransform:/);
    expect(src).not.toMatch(/headCell\(\{[^)]*fontSize/);
  });
});

/** The weight a rule sets, from font-weight or a font shorthand (which sets 400 when it names none); undefined when neither. */
const weightOf = (d: Record<string, string>) => d["font-weight"] ?? (d.font ? (d.font.match(/^(?:italic\s+|normal\s+)?(\d{3}|bold|bolder)\s/)?.[1] ?? "400") : undefined);
const heavy = (w: string | undefined) => w !== undefined && (/bold/.test(w) || Number(w) > 400);
/** Every rule of a stylesheet, innermost first, as [selector, declarations]. */
const rules = (css: string) =>
  [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, sel, body]) => [sel.trim().replace(/\s+/g, " "), Object.fromEntries(body.split(";").map((d) => d.trim()).filter((d) => d.includes(":")).map((d) => [d.slice(0, d.indexOf(":")).trim(), d.slice(d.indexOf(":") + 1).trim()]))] as const);
/** In scope: the app's stylesheets and components; Settings (replaced next), the login popup and the global heading rule's file are not. */
const IN_SCOPE = (f: string) => !f.startsWith("components/settings/") && f !== "components/LoginModal.tsx" && f !== "app/globals.css";

describe("UI titles are TITLE's type, content names stay upright, and nothing sets the serif above the 400 it ships (DEC-2026-11-08-10)", () => {
  const MODAL_TITLE = rule(sheet("components/enki-shell/enki-shell.css"), ".ek-modal-title");

  it(".kit-title is TITLE's face, style, weight, tracking and ink, and leaves the size to its place", () => {
    expect(rule(sheet("components/kit/kit-base.css"), ".kit-title")).toEqual({
      "font-family": TITLE.fontFamily, "font-style": TITLE.fontStyle, "font-weight": String(TITLE.fontWeight),
      "letter-spacing": TITLE.letterSpacing, color: TITLE.color,
    });
  });

  it(".kit-confirm-title is TITLE's type at a header's 22px", () => {
    const t = rule(sheet("components/kit/kit-dialog.css"), ".kit-confirm-title");
    expect([t["font-family"], t["font-style"], t["font-weight"], t["letter-spacing"], t.color, t["font-size"]])
      .toEqual([TITLE.fontFamily, TITLE.fontStyle, String(TITLE.fontWeight), TITLE.letterSpacing, TITLE.color, MODAL_TITLE["font-size"]]);
  });

  it.each([["components/kit/kit-controls.css", ".kit-sheet-title"], ["components/enki/bookmarks.css", ".enki-nftp-head"]])(
    "%s %s titles a header row, so it is .ek-modal-title's type", (file, selector) => {
      const r = rule(sheet(file), selector);
      expect(Object.keys(MODAL_TITLE).length).toBe(6);
      for (const [k, v] of Object.entries(MODAL_TITLE)) expect(r[k], k).toBe(v);
      expect(r.font).toBeUndefined();
    });

  it("Quick Create's confirm title (an h4) is a UI title: TITLE's style, weight and tracking", () => {
    const t = rule(sheet("app/editor/mobile-modal.css"), ".mobile-modal-confirm-title");
    expect([t["font-style"], t["font-weight"], t["letter-spacing"]]).toEqual([TITLE.fontStyle, String(TITLE.fontWeight), TITLE.letterSpacing]);
  });

  it("the reviews' empty title is a UI title; the image view's state title keeps the prompt name's upright face", () => {
    const empty = rule(sheet("components/image-view/image-view.css"), ".iv-rv-empty-title");
    expect(empty.font).toMatch(/^italic 400 21px\/1\.1 var\(--font-serif\), Georgia, serif$/);
    expect(empty["letter-spacing"]).toBe(TITLE.letterSpacing);
    expect(rule(sheet("components/image-view/image-view-frame.css"), ".iv-state-title")["font-style"]).toBe("normal");
    expect(raw("components/image-view/ImageView.tsx")).toMatch(/className="kit-title iv-state-title"/);
  });

  it("no stylesheet in scope sets the serif, or a serif heading, above 400", () => {
    // Headings that take the serif from the global h1-h6 rule (app/globals.css: serif 600), by their own class.
    const HEADINGS = new Set([".cm-post-title", ".rx-card-title", ".mobile-modal-confirm-title"]);
    const sheets = APP.filter((f) => f.endsWith(".css") && IN_SCOPE(f));
    expect(sheets.length).toBeGreaterThan(20);
    const found = sheets.flatMap((f) => rules(sheet(f))
      .filter(([sel, d]) => (/--font-serif|--font-instrument-serif/.test(d["font-family"] ?? d.font ?? "") || HEADINGS.has(sel)) && heavy(weightOf(d)))
      .map(([sel, d]) => `${f} ${sel} ${weightOf(d)}`));
    expect(found).toEqual([]);
    // The headings name 400 themselves, or the global rule's 600 reaches them.
    for (const [file, sel] of [["components/communities/communities.css", ".cm-post-title"], ["components/remix/remix.css", ".rx-card-title"], ["app/editor/mobile-modal.css", ".mobile-modal-confirm-title"]]) {
      expect(weightOf(rule(sheet(file), sel)), sel).toBe("400");
    }
  });

  it("no style object in scope sets the serif above 400", () => {
    const found = APP.filter((f) => f.endsWith(".tsx") && IN_SCOPE(f)).flatMap((f) => {
      const src = readSource(join(ROOT, f));
      return [...src.matchAll(/\{\{?([^{}]*)\}\}?/g)]
        .filter((m) => /fontWeight:\s*("?bold"?|"?[5-9]00"?)/.test(m[1]) && (/\bSERIF\b|--font-serif|--font-instrument-serif/.test(m[1]) || /className="[^"]*\bserif\b[^"]*"[^>]*$/.test(src.slice(Math.max(0, m.index - 80), m.index))))
        .map((m) => `${f}:${src.slice(0, m.index).split("\n").length}`);
    });
    expect(found).toEqual([]);
  });

  it("the section titles, empty states and the Edit profile card take TITLE or .kit-title, with no colour or weight of their own", () => {
    const count = (s: string, part: string) => s.split(part).length - 1;
    const ap = readSource(join(ROOT, "components/enki-shell/AnalyticsPanel.tsx"));
    expect(count(ap, "{ ...TITLE, fontSize: 17")).toBe(5);
    expect(ap).not.toMatch(/fontFamily: SERIF, fontSize: 17/);
    const pv = readSource(join(ROOT, "components/profile/ProfileView.tsx"));
    expect(pv).toContain('<h2 style={{ ...TITLE, margin: "14px 0 18px" }}>Edit profile</h2>');
    expect(count(pv, '<div className="kit-title" style={{ fontSize: 24')).toBe(6);
    expect(pv).not.toMatch(/className="serif" style=\{\{ fontSize: 24/);
    expect(readSource(join(ROOT, "components/enki-shell/NotificationsPanel.tsx"))).toContain('<div className="kit-title" style={{ fontSize: 22 }}>');
    expect(readSource(join(ROOT, "app/leaderboard/page.tsx"))).toContain('<div className="kit-title" style={{ fontSize: 24 }}>No rankings yet.</div>');
    expect(readSource(join(ROOT, "app/not-found.tsx"))).toContain('<h1 className="kit-title text-4xl">404</h1>');
    for (const f of ["components/profile/ProfileView.tsx", "components/enki-shell/NotificationsPanel.tsx", "app/leaderboard/page.tsx", "app/not-found.tsx"]) {
      expect(readSource(join(ROOT, f)), f).not.toMatch(/className="kit-title[^"]*"( style=\{\{[^}]*(color|fontWeight|fontStyle|fontFamily)|[^>]*font-bold)/);
    }
  });

  it("the Radix confirm title is the kit's confirm title, its stylesheet loaded with it", () => {
    const src = readSource(join(ROOT, "components/ui/alert-dialog.tsx"));
    expect(src).toContain('import "@/components/kit/kit-dialog.css"');
    expect(src).toMatch(/<AlertDialogPrimitive\.Title\n\s+ref=\{ref\}\n\s+className=\{cn\("kit-confirm-title", className\)\}/);
    expect(src).not.toMatch(/font-semibold"?, className\)/);
  });
});

/** The windows' frame outside the shadcn dialogs (those are rendered in window-type.test.ts): the shell's veil (.ek-modal-scrim),
 *  CARD's corner, the windows' pill buttons (DEC-2026-11-08-13). */
describe("every window takes the windows' frame: the veil, the corner, the pill buttons (DEC-2026-11-08-13)", () => {
  const SCRIM = rule(sheet("components/enki-shell/enki-shell.css"), ".ek-modal-scrim");

  it("the NFT picker: the shell's veil, CARD's corner, pill buttons in PILL's weight", () => {
    const css = sheet("components/enki/bookmarks.css");
    const scrim = rule(css, ".enki-nftp-scrim");
    expect([SCRIM.background, SCRIM["backdrop-filter"]]).toEqual(["rgba(0, 0, 0, 0.5)", "blur(6px)"]);
    expect([scrim.background, scrim["backdrop-filter"], scrim["-webkit-backdrop-filter"]]).toEqual([SCRIM.background, SCRIM["backdrop-filter"], SCRIM["backdrop-filter"]]);
    expect(rule(css, ".enki-nftp")["border-radius"]).toBe(px(CARD.borderRadius));
    const go = rule(css, ".enki-bmp-go");
    expect([go["border-radius"], go["font-weight"]]).toEqual([px(PILL.borderRadius), String(PILL.fontWeight)]);
  });

  it("Edit profile: the shell's veil, CARD's corner, Cancel PILL and Save the CTA at the row's 40px", () => {
    const pv = readSource(join(ROOT, "components/profile/ProfileView.tsx"));
    expect(pv).toContain(`background: "${SCRIM.background}", backdropFilter: "${SCRIM["backdrop-filter"]}", WebkitBackdropFilter: "${SCRIM["backdrop-filter"]}", padding: 20,`);
    expect(pv).toContain('borderRadius: CARD.borderRadius, boxShadow: "0 30px 80px rgba(0,0,0,0.35)",');
    expect(pv).toContain("height: fh, borderRadius: `${CARD.borderRadius}px ${CARD.borderRadius}px 0 0`,");
    expect(pv).toContain('<button style={{ ...PILL, width: "auto", minHeight: 40, padding: "0 20px", cursor: "pointer" }} onClick={onClose} disabled={busy}>');
    expect(pv).toContain('style={{ ...CTA, width: "auto", minHeight: 40, padding: "0 20px", cursor: "pointer", minWidth: 96 }}');
    expect(pv).not.toContain('background: "var(--enki-ink)", borderColor: "var(--enki-ink)", color: "var(--enki-paper)"');
    expect(pv).not.toMatch(/rgba\(0,0,0,0\.45\)|borderRadius: 20\b|"20px 20px 0 0"/);
  });

  it("/auth/complete: the windows' card, its button the CTA, its lines TEXT", () => {
    const page = readSource(join(ROOT, "app/auth/complete/page.tsx"));
    expect(page).toContain('import { CARD, CTA, TEXT } from "@/components/enki-window";');
    expect(page).toContain('<div style={{ ...CARD, width: "100%", maxWidth: 380, padding: "32px 28px", textAlign: "center", borderWidth: 1, borderStyle: "solid" }}>');
    expect(page).toContain('style={{ ...CTA, display: "flex", alignItems: "center", justifyContent: "center", textDecoration: "none" }}');
    expect(page.split('{ ...TEXT, color: "var(--enki-ink-2)", margin:').length - 1).toBe(2);
    expect(page).not.toMatch(/borderRadius: (12|20)\b|enki-shadow-card|ember-rgb|fontSize: 14\b/);
  });
});

/** ROUND as a stylesheet writes it: kebab-case, numbers in px. */
const asCss = (o: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`), typeof v === "number" ? px(v) : String(v)]));

describe("one window corner: the dialog takes ROUND by a prop, and the stylesheets' closes are ROUND (DEC-2026-11-08-14)", () => {
  it("ui/dialog.tsx hands closeStyle to its close and sets none by default, so the landing keeps shadcn's X", () => {
    const src = readSource(join(ROOT, "components/ui/dialog.tsx"));
    expect(src).toContain("    closeStyle?: React.CSSProperties\n");
    expect(src).toContain(">(({ className, overlayClassName, closeStyle, children, ...props }, ref) => (");
    // With a corner given, the close also wears the corner's hover (DEC-2026-11-08-34); with none, its classes are shadcn's.
    expect(src).toMatch(/<DialogPrimitive\.Close className=\{"[^"]*" \+ \(closeStyle \? " kit-round" : ""\)\} style=\{closeStyle\}>/);
  });

  it.each([["components/enki/bookmarks.css", ".enki-nftp-x"], ["components/image-view/image-view.css", ".iv-rv-close"]])("%s %s is ROUND, with the shell close's hover", (file, selector) => {
    const css = sheet(file);
    const { opacity, ...round } = ROUND;
    expect(opacity).toBe(1);
    expect(rule(css, selector)).toMatchObject(asCss(round));
    expect(rule(css, `${selector}:hover`)).toEqual(rule(sheet("components/enki-shell/enki-shell.css"), ".ek-modal-x:hover"));
  });
});

/** Kev, 2026-11-08: "fixe alles uneinheitliche". Two confirm dialogs looked apart: the kit's (ConfirmDialog: radius 14, a 50%
 *  veil without blur, radius-10 buttons) and Radix's (shadcn's frame, an 80% veil, shadcn's buttons; the mixed-model order
 *  dialog's native label, select, lines and buttons). One confirm: the kit's classes at the windows' corner, veil and pill
 *  (DEC-2026-11-08-15). */
describe("one confirm dialog: the kit's, at the windows' veil, corner and pill, for ConfirmDialog and the Radix dialogs (DEC-2026-11-08-15)", () => {
  const SCRIM = rule(sheet("components/enki-shell/enki-shell.css"), ".ek-modal-scrim");
  const KIT = sheet("components/kit/kit-dialog.css");

  it("kit-dialog.css: the windows' veil, CARD's corner, pill buttons on the paper at the dialog's 38px", () => {
    const scrim = rule(KIT, ".kit-confirm-scrim");
    expect([scrim.background, scrim["backdrop-filter"], scrim["-webkit-backdrop-filter"]]).toEqual([SCRIM.background, SCRIM["backdrop-filter"], SCRIM["backdrop-filter"]]);
    expect(rule(KIT, ".kit-confirm")["border-radius"]).toBe(px(CARD.borderRadius));
    const btn = rule(KIT, ".kit-confirm-btn");
    expect([btn["border-radius"], btn.background, btn["min-height"]]).toEqual([px(PILL.borderRadius), "var(--enki-paper)", "38px"]);
  });

  it("ui/alert-dialog.tsx wears the kit's classes: veil, frame, line, actions, buttons; shadcn's button variants are gone", () => {
    const src = readSource(join(ROOT, "components/ui/alert-dialog.tsx"));
    expect(src).toContain('"fixed inset-0 z-[10010] bg-black/50 backdrop-blur-[6px] data-[state=open]:animate-in');
    expect(src).toContain('className={cn("enk-pop kit-confirm relative pointer-events-auto", className)}');
    expect(src).toContain('className={cn("kit-confirm-text space-y-1", className)}');
    expect(src).toContain('className={cn("kit-confirm-actions", className)}');
    expect(src).toContain('className={cn("kit-confirm-btn kit-confirm-btn--danger", className)}');
    expect(src).toContain('className={cn("kit-confirm-btn", className)}');
    expect(src).not.toMatch(/buttonVariants|bg-black\/80|bg-background|sm:rounded-lg|text-muted-foreground|text-center/);
  });

  it("the mixed-model order dialog and the pending-order bar: every label, field, line and button carries the kit's class", () => {
    const src = readSource(join(ROOT, "components/GenerateLauncher.tsx"));
    const part = src.slice(src.indexOf("<AlertDialog open={!!mixed}"), src.indexOf("{nftPickerOpen && ("));
    expect(part.length).toBeGreaterThan(500);
    const tags = [...part.matchAll(/<(button|select|label|p)\b([^>]*)>/g)];
    expect(tags.map((m) => m[1])).toEqual(["label", "select", "p", "p", "p", "button", "p", "button", "button"]);
    // The bar's own line stays in the bar's Quick Create ink (--qc-ink); everything else is the kit's.
    expect(part).toContain("<p>Your existing payment is being checked.");
    for (const [i, [tag, , attrs]] of tags.entries()) if (i !== 6) expect(attrs, `${i} ${tag}`).toMatch(/className=/);
    expect(part).toContain('<label htmlFor="mixed-paid-model" className="kit-label"');
    // The app's one field, by its class alone (DEC-2026-11-08-19).
    expect(part).toContain('<select id="mixed-paid-model" className={FIELD} value={mixedPaidId}');
    expect(part.split('<p className="kit-confirm-text"').length - 1).toBe(2);
    expect(part).toContain('<p role="status" className="kit-confirm-text">');
    expect(part).toContain('<button type="button" className="kit-confirm-btn kit-confirm-btn--danger" disabled={!mixedPaid');
    expect(part.split('<button type="button" className="kit-confirm-btn" disabled={generating}').length - 1).toBe(2);
  });
});

/** Kev, 2026-11-08: "fixe alles uneinheitliche". Two panel heads switched two options in two looks: Analytics' pill switch
 *  (.ek-msg-box, the Messages switch, with tabs) and Hall of Fame's grey radius-8 track with a --cta-solid thumb; the Analytics
 *  chart's metric pills wore an ember tint where the period pills beside them are .ek-page-pill (DEC-2026-11-08-16). */
describe("one panel switch: .ek-msg-box with tabs in the panel head, .ek-page-pill for small pill toggles (DEC-2026-11-08-16)", () => {
  const HOF = () => readSource(join(ROOT, "app/leaderboard/page.tsx"));
  const AP = () => readSource(join(ROOT, "components/enki-shell/AnalyticsPanel.tsx"));
  /** The panel head's two-option switch: the box with its tablist role and size, each option a tab marked by aria-selected. */
  const SWITCH = /<div className="ek-msg-box" role="tablist" aria-label="[^"]+" style=\{\{ width: 170, marginBottom: 0 \}\}>\n\s+\{\(\[[^\]]+\][^)]*\)\.map\(\((\w)\) => \(\n\s+<button key=\{\1\} type="button" role="tab" aria-selected=\{(\w+) === \1\} className=\{"ek-msg-box-btn" \+ \(\2 === \1 \? " on" : ""\)\} onClick=\{\(\) => set\w+\(\1\)\}>/;

  it.each([["Analytics (whose numbers)", AP], ["Hall of Fame (what to rank by)", HOF]])("%s switches by the one panel switch", (_name, src) => {
    const s = src();
    expect(s).toMatch(SWITCH);
    expect(s.split('className="ek-msg-box"').length - 1).toBe(1);
  });

  it("Hall of Fame keeps no switch of its own: no grey track, no --cta-solid thumb", () => {
    const s = HOF();
    expect(s.match(SWITCH)?.[2]).toBe("metric");
    expect(s).not.toMatch(/--cta-solid|borderRadius: 8, padding: 2|height: 26, padding: "0 14px"/);
  });

  it("the Analytics chart's metric pills are .ek-page-pill, as the period pills beside them", () => {
    const s = AP();
    expect(s).toContain('<button key={m} type="button" className={"ek-page-pill" + (metric === m ? " on" : "")} onClick={() => setMetric(m)}>');
    expect(s).not.toMatch(/rgba\(var\(--ember-rgb\), 0\.45\)|metric === m \? "rgba/);
  });
});

/** Kev, 2026-11-08: "fixe alles uneinheitliche". Status lines wrote their own reds and greens (#b33a3a, #e0584f: dark's
 *  danger in every theme, #c0392b, #1f8a5b) where the theme has --enki-danger and --enki-green (DEC-2026-11-08-17). The green
 *  tint pairs (#E8F8EE ground with a dark green ink) stay: the theme has no green tint, and a new token is Kev's. */
describe("status text takes the theme's danger and green (DEC-2026-11-08-17)", () => {
  const FILES = ["components/enki-shell/ReferModal.tsx", "components/enki-shell/FeedbackModal.tsx", "components/enki-shell/AnalyticsPanel.tsx", "app/leaderboard/page.tsx", "components/profile/ProfileView.tsx"];
  /** A file's code with its green tint pairs taken out: the pair is the tone, and it is listed for Kev. */
  const untinted = (src: string) => src.replace(/background: "#E8F8EE", color: "#1F8A5B"/g, "");

  it.each(FILES)("%s writes no red or green of its own", (file) => {
    expect(untinted(readSource(join(ROOT, file)))).not.toMatch(/#(b33a3a|e0584f|c0392b|1f8a5b)\b/i);
  });

  it("Analytics' and Hall of Fame's trend colours are the theme's, by name", () => {
    expect(readSource(join(ROOT, "components/enki-shell/AnalyticsPanel.tsx"))).toContain('const GREEN = "var(--enki-green)", RED = "var(--enki-danger)";');
    expect(readSource(join(ROOT, "app/leaderboard/page.tsx"))).toContain('const GREEN = "var(--enki-green)", RED = "var(--enki-danger)";');
  });

  it("each status line names the token: Refer's errors and its link field, Feedback's check and Paid link, Edit profile's error", () => {
    const refer = readSource(join(ROOT, "components/enki-shell/ReferModal.tsx"));
    expect(refer.split('color: "var(--enki-danger)"').length - 1).toBe(3);
    // The link field's frame is the one field (DEC-2026-11-08-19); its invalid border is still the theme's danger.
    expect(refer).toContain('...(url && !link ? { borderColor: "var(--enki-danger)" } : null)');
    const fb = readSource(join(ROOT, "components/enki-shell/FeedbackModal.tsx"));
    expect(fb).toContain('stroke="var(--enki-green)"');
    expect(fb).toContain('style={{ fontSize: 10, fontWeight: 700, color: "var(--enki-green)", flexShrink: 0 }}>Paid $');
    expect(readSource(join(ROOT, "components/profile/ProfileView.tsx"))).toContain('<div style={{ marginTop: 12, fontSize: 13, color: "var(--enki-danger)" }}>{err}</div>');
  });

  it("the green tint pairs stay as they are (Kev's call: a tint token would be a palette decision)", () => {
    expect(readSource(join(ROOT, "components/enki-shell/ReferModal.tsx"))).toContain('background: "#E8F8EE", color: "#1F8A5B"');
    expect(readSource(join(ROOT, "components/enki-shell/AnalyticsPanel.tsx"))).toContain('green: { bg: "#E8F8EE", ink: "#1F5C38" },');
  });
});

/** A JSX element's opening tag from its `<`, read to the `>` that closes it (braces and strings skipped, so `=>` in a handler
 *  does not end it). */
function openTag(src: string, at: number): string {
  let depth = 0, quote = "";
  for (let i = at + 1; i < src.length; i++) {
    const c = src[i];
    if (quote) { if (c === quote) quote = ""; continue; }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0) return src.slice(at, i + 1);
  }
  return src.slice(at);
}

/** Kev, 2026-11-08: "fixe alles uneinheitliche", and on the field: one field look across the app, Studio's .st-input (radius
 *  12, 44px, the one designed focus ring) as one class in kit-base.css, and that ring on every field in scope that showed no
 *  focus (DEC-2026-11-08-19). */
describe("one field: .st-input in kit-base.css, worn by every field in scope, its ring on every field (DEC-2026-11-08-19)", () => {
  const KB = sheet("components/kit/kit-base.css");

  it("kit-base.css holds the one field: Studio's look, the quiet label for its placeholder, the ring on focus-within, 16px on a phone", () => {
    expect(rule(KB, ".st-input")).toEqual({
      width: "100%", "min-height": "44px", padding: "11px 14px", border: "1px solid var(--enki-rule)", "border-radius": "12px",
      background: "var(--enki-paper-2)", color: "var(--enki-ink)", font: "400 15px/1.4 var(--font-sans), sans-serif", outline: "none",
      transition: "border-color 0.15s, box-shadow 0.15s",
    });
    expect(rule(KB, ".st-input::placeholder")).toEqual({ color: "var(--enki-label-quiet)" });
    expect(rule(KB, ".st-input:focus-within, .kit-ring:focus-within")).toEqual({ "border-color": "var(--enki-ember)", "box-shadow": "0 0 0 3px rgba(var(--ember-rgb), 0.13)" });
    expect(rule(KB, ".st-input[aria-invalid]")).toEqual({ "border-color": "var(--enki-danger)" });
    expect(KB).toMatch(/\n@media \(max-width: 767\.98px\) \{\n {2}\.st-input \{ font-size: 16px; \}\n\}/);
  });

  it("only kit-base.css writes the field's own rules; Studio and the rest keep only their places' overrides", () => {
    const owners = APP.filter((f) => f.endsWith(".css")).filter((f) => rules(sheet(f)).some(([sel]) => sel.split(",").some((s) => /^\.st-input(?![\w-])/.test(s.trim()))));
    expect(owners).toEqual(["components/kit/kit-base.css"]);
  });

  it("FIELD, the windows' field, is the one field's class, and every window field wears it with no frame or colour of its own", () => {
    expect(FIELD).toBe("st-input");
    const WINDOWS: [string, number][] = [
      ["components/PrivateBetaWindow.tsx", 3], ["components/ReportButton.tsx", 2], ["components/profile/MessageButton.tsx", 1],
      ["components/GenerateLauncher.tsx", 1], ["components/StepUpProvider.tsx", 1], ["components/ConfirmEmailWindow.tsx", 1],
    ];
    for (const [file, n] of WINDOWS) {
      const src = readSource(join(ROOT, file));
      const tags = [...src.matchAll(/<(?:input|textarea|select)\b/g)].map((m) => openTag(src, m.index));
      expect(tags.length, file).toBe(n);
      for (const t of tags) {
        expect(t, file).toContain("className={FIELD}");
        expect(t, file).not.toMatch(/FIELD_LOOK|rounded-|background:|borderColor:|border:|padding:/);
      }
    }
  });

  // The fields outside the window family: each wears the class (a frame that holds an icon or a prefix wears it on the frame).
  const SITES: Record<string, string[]> = {
    "components/enki-shell/ReferModal.tsx": [
      '<input className="st-input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} aria-label="Name" />',
      '<select className="st-input" value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category">',
      '<select className="st-input" value={generator} onChange={(e) => setGenerator(e.target.value)} aria-label="Primary generator">',
      '<div className="st-input" style={{ display: "flex", alignItems: "center", gap: 7, ...(url && !link ? { borderColor: "var(--enki-danger)" } : null) }}>',
      'style={{ flex: 1, minWidth: 0, border: "none", background: "transparent", outline: "none", font: "inherit", color: "inherit" }}',
    ],
    "components/enki-shell/FeedbackModal.tsx": ['<textarea className="st-input" rows={4} value={text} onChange={(e) => setText(e.target.value)}', 'style={{ display: "block", resize: "vertical" }} />'],
    "components/profile/ProfileView.tsx": [
      'maxLength={20}\n                className="st-input"\n                placeholder="your_name"',
      'rows={4}\n                className="st-input"\n                style={{ resize: "vertical" }}',
      'onClick={offerStyleEditor} className="st-input" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", textAlign: "left", cursor: "pointer" }}>',
      'className="st-input" style={{ width: "clamp(120px, 24vw, 260px)", minHeight: 0, padding: "7px 12px", fontSize: 13 }} />',
    ],
    "app/banned/page.tsx": ['<textarea className="st-input" value={statement}', 'rows={4}\n                    style={{ resize: "vertical" }} />'],
    "components/EnkiCardPage.tsx": ['return <input className="st-input" {...props} />;'],
    "components/enki-shell/UsernameOnboard.tsx": [
      '<div\n          className="st-input"\n          style={{\n            display: "flex", alignItems: "center", gap: 2, padding: "0 16px", height: 52,\n            ...(status === "free" ? { borderColor: "var(--enki-green)" } : status === "taken" || status === "invalid" ? { borderColor: "var(--enki-danger)" } : null),',
    ],
  };
  it.each(Object.entries(SITES))("%s: every field wears the one field, with no frame of its own", (file, sites) => {
    const src = readSource(join(ROOT, file));
    for (const s of sites) expect(src).toContain(s);
    // None of the fields' old frames is left: Refer's 32/34px boxes, Feedback's, Edit profile's fieldStyle, the appeal's, the
    // card pages' radius-6 field, the username picker's radius-6 frame.
    expect(src).not.toMatch(/fieldStyle|height: (32|34), (padding|border)|padding: "8px 10px", fontSize: 12|padding: "9px 11px"|padding: "8px 12px", borderRadius: 6|placeholder:text-\[color:var\(--card-quiet\)\]|borderRadius: 6, padding: "0 16px"/);
  });

  it("no field in scope hides its focus: an inline `outline: none` sits only on a field that wears the ring, or inside a frame that does", () => {
    const hidden = APP.filter((f) => f.endsWith(".tsx") && IN_SCOPE(f)).flatMap((f) => {
      const src = readSource(join(ROOT, f));
      return [...src.matchAll(/outline: ?(?:"none"|0\b|"0")/g)].flatMap((m) => {
        const open = src.lastIndexOf("<", m.index);
        if (!/^<(?:input|textarea|select)\b/.test(src.slice(open))) return [];
        if (/className="[^"]*\b(?:st-input|kit-ring)\b/.test(openTag(src, open))) return [];
        // The frame that holds it: the nearest element before it with the class, within the field's own markup.
        if (/<(?:div|span|label)\b[^<]*className="(?:st-input|kit-ring)"[^]*$/.test(src.slice(Math.max(0, open - 600), open))) return [];
        return [`${f}:${src.slice(0, m.index).split("\n").length}`];
      });
    });
    // /gate wears the one field since DEC-2026-11-08-20.
    expect(hidden).toEqual([]);
  });

  it("the staff page's dense fields keep their frames and take the ring (.kit-ring), its search on its frame", () => {
    const src = readSource(join(ROOT, "app/admin/page.tsx"));
    expect(src.split('<input className="kit-ring"').length - 1).toBe(7);
    expect(src).toContain('<input\n                        className="kit-ring"\n                        type="number"');
    expect(src).toContain('<span className="kit-ring" style={{ marginLeft: "auto", display: "flex"');
  });
});

/** Kev, 2026-11-08: "fixe alles uneinheitliche", and on /gate: it takes the app's window look (CARD, TITLE, CTA, FIELD), since
 *  "Private beta" sends people there; its tones move to the theme's (no palette value changes) and its synthesised bold goes
 *  (DEC-2026-11-08-20). */
describe("/gate is one of the app's windows: the windows' card, title, lines, field and buttons over their veil (DEC-2026-11-08-20)", () => {
  const GATE = () => readSource(join(ROOT, "app/gate/page.tsx"));

  it("it takes the look from components/enki-window.ts and the veil from .ek-modal-scrim", () => {
    const src = GATE();
    const SCRIM = rule(sheet("components/enki-shell/enki-shell.css"), ".ek-modal-scrim");
    expect(src).toContain('import { CARD, CTA, FIELD, PILL, TEXT, TITLE } from "@/components/enki-window";');
    expect(src).toContain(`const VEIL: React.CSSProperties = { background: "${SCRIM.background}", backdropFilter: "${SCRIM["backdrop-filter"]}", WebkitBackdropFilter: "${SCRIM["backdrop-filter"]}" };`);
    expect(src).toContain('<div style={{ position: "absolute", inset: 0, ...VEIL, pointerEvents: "none" }} />');
    expect(src).toContain('<form onSubmit={submit} style={{ ...CARD, width: "100%", maxWidth: 380, padding: "32px 28px", textAlign: "center", borderWidth: 1, borderStyle: "solid" }}>');
  });

  it("its titles are TITLE, its lines TEXT, its field the one field, its error the theme's danger, its buttons the CTA and pills", () => {
    const src = GATE();
    expect(src).toContain('<h1 style={{ ...TITLE, margin: "0 0 10px" }}>Private build</h1>');
    expect(src).toContain('<h1 style={{ ...TITLE, margin: "0 0 10px" }}>Code accepted</h1>');
    expect(src).toContain('const LINE: React.CSSProperties = { ...TEXT, color: "var(--enki-ink-2)" };');
    expect(src.split("style={{ ...LINE, margin:").length - 1).toBe(2);
    expect(src).toContain('type="password"\n            className={FIELD}\n            aria-invalid={err ? true : undefined}');
    expect(src).toContain('<div style={{ color: "var(--enki-danger)", fontSize: "0.8rem"');
    expect(src).toContain('style={{ ...CTA, marginTop: 18, cursor: loading ? "default" : "pointer", opacity: loading ? 0.7 : 1 }}');
    expect(src).toContain('const button: React.CSSProperties = { ...PILL, display: "flex", alignItems: "center", justifyContent: "center", marginTop: 10, textDecoration: "none" };');
    expect(src).toContain('color: "var(--enki-label-quiet)", textDecoration: "underline" }}>');
  });

  it("it keeps no colour, font or weight of its own: no hex, no rgba but the veil's, no gradient, no DM Sans, no bold on a title", () => {
    const src = GATE();
    expect(src.replace('"rgba(0, 0, 0, 0.5)"', "")).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|gradient\(|DM Sans|dm-sans/i);
    expect(src).not.toMatch(/<h1 style=\{\{ (?!\.\.\.TITLE)/);
    expect(src).not.toMatch(/fontWeight: 700|borderRadius: 11/);
  });
});

/** Kev, 2026-11-08: "fixe alles uneinheitliche", and on the shell's primary button: .ek-btn's 1px ink border goes, as the
 *  windows' CTA has none (DEC-2026-11-08-21). */
describe("the shell's primary button is the windows' CTA: no border of its own (DEC-2026-11-08-21)", () => {
  const SHELL = sheet("components/enki-shell/enki-shell.css");

  it(".ek-btn is CTA's pill, fill, ink and type, with no border", () => {
    const b = rule(SHELL, ".ek-btn");
    expect([b.border, b["border-radius"], b.background, b.color, b["min-height"], b.width, b["font-size"], b["font-weight"]]).toEqual([
      String(CTA.border), px(CTA.borderRadius), String(CTA.background), String(CTA.color), px(CTA.minHeight), String(CTA.width), px(CTA.fontSize), String(CTA.fontWeight),
    ]);
    expect(b["border-color"]).toBeUndefined();
  });

  it("disabled, it stands on paper-3 with ink-2 and draws no border either", () => {
    const d = rule(SHELL, ".ek-btn:disabled");
    expect([d.background, d.color]).toEqual(["var(--enki-paper-3)", "var(--enki-ink-2)"]);
    expect(Object.keys(d).filter((k) => k.startsWith("border"))).toEqual([]);
  });
});

/** FIELD_LOOK (the windows' field colours as inline style) lost its last user with the one field (DEC-2026-11-08-19): an
 *  inline border colour would beat the field's focus border, so it goes (DEC-2026-11-08-22). */
describe("the windows' field has no inline look left to reach for (DEC-2026-11-08-22)", () => {
  it("enki-window.ts exports FIELD and no FIELD_LOOK, and no source names it", () => {
    expect(readSource(join(ROOT, "components/enki-window.ts"))).not.toMatch(/FIELD_LOOK/);
    expect(APP.filter((f) => /FIELD_LOOK/.test(code(f)))).toEqual([]);
  });
});

/** Kev, 2026-11-08: "fixe alles uneinheitliche", and on Quick Create (EnkiMobileGenerateModal, app/editor/mobile-modal.css):
 *  restyled onto the theme as its own small series, no behaviour change. First its type: Outfit (17 rules) and a Playfair
 *  fallback (7) were the only families of their own left in the app's windows (DEC-2026-11-08-23). */
describe("Quick Create's type is the layout's: TEXT's sans, LABEL's mono, TITLE's serif (DEC-2026-11-08-23)", () => {
  it("every family mobile-modal.css names is one of the layout's three; Outfit and Playfair are gone", () => {
    const css = sheet("app/editor/mobile-modal.css");
    const families = [...new Set([...css.matchAll(/font-family:\s*([^;]+);/g)].map((m) => m[1].trim()))].sort();
    expect(families).toEqual([String(LABEL.fontFamily), String(TEXT.fontFamily), String(TITLE.fontFamily)].sort());
    expect(css).not.toMatch(/outfit|playfair|\bfont:/i);
  });
});

/** Quick Create, second step: the windows' veil and corner. Its overlay dimmed at 40% with a 2px blur (25% on a wide
 *  screen) and its close was a 28px circle on the paper in ink, recoloured navy in dark (DEC-2026-11-08-24). */
describe("Quick Create opens over the windows' veil and closes by the windows' corner (DEC-2026-11-08-24)", () => {
  const QC = sheet("app/editor/mobile-modal.css");
  const SHELL = sheet("components/enki-shell/enki-shell.css");

  it("its overlay and its in-sheet confirm's veil are .ek-modal-scrim's, on every screen", () => {
    const scrim = rule(SHELL, ".ek-modal-scrim");
    for (const sel of [".mobile-modal-overlay", ".mobile-modal-confirm"]) {
      const o = rule(QC, sel);
      expect([o.background, o["backdrop-filter"], o["-webkit-backdrop-filter"]], sel).toEqual([scrim.background, scrim["backdrop-filter"], scrim["backdrop-filter"]]);
      // No other rule (a wide screen's, a theme's) gives it a veil of its own.
      expect(rules(QC).filter(([s, d]) => s.split(",").some((x) => x.trim().endsWith(sel)) && ("background" in d || "backdrop-filter" in d)), sel).toHaveLength(1);
    }
  });

  it("its close is ROUND, with the shell close's hover, and no theme recolours it", () => {
    const { opacity, ...round } = ROUND;
    expect(opacity).toBe(1);
    expect(rule(QC, ".mobile-modal-close")).toMatchObject(asCss(round));
    expect(rule(QC, ".mobile-modal-close:hover")).toEqual(rule(SHELL, ".ek-modal-x:hover"));
    // A rule that names the close only to leave it out (`:not(.mobile-modal-close)`, DEC-2026-11-08-27) does not recolour it.
    expect(rules(QC).filter(([sel]) => /\.dark[^,]*\.mobile-modal-close\b/.test(sel.replace(/:not\([^)]*\)/g, ""))).map(([sel]) => sel)).toEqual([]);
  });
});

/** Quick Create, third step: its in-sheet confirm ("Identical image already queued", "Reset the Verify section?") had its
 *  own card on the old cream (#FCFBF8, radius 14), its own radius-8 buttons and an ink-filled primary; it wears the kit's
 *  confirm, the one confirm dialog (DEC-2026-11-08-15, DEC-2026-11-08-25). */
describe("Quick Create's confirm is the kit's confirm (DEC-2026-11-08-25)", () => {
  it("its card, title, line, actions and buttons wear kit-dialog.css's classes, loaded with it", () => {
    const src = readSource(join(ROOT, "components/EnkiMobileGenerateModal.tsx"));
    expect(src).toContain('import "@/components/kit/kit-dialog.css";');
    const part = src.slice(src.indexOf("{verifyDialog && ("), src.indexOf("{verifyDialog && (") + 4000);
    expect(part).toContain('<div className="kit-confirm" onClick={(e) => e.stopPropagation()}>');
    for (const [cls, n] of [['<h4 className="kit-confirm-title">', 2], ['<p className="kit-confirm-text">', 2], ['<div className="kit-confirm-actions">', 2], ['className="kit-confirm-btn"', 2], ['className="kit-confirm-btn kit-confirm-btn--danger"', 2]] as const) {
      expect(part.split(cls).length - 1, cls).toBe(n);
    }
    expect(src).not.toMatch(/mobile-modal-confirm-(card|title|text|actions|btn)/);
  });
});

/** Quick Create, fourth step: in dark and purple its sheet stood on a navy set of its own (--surface-1/-2/-3, -chrome,
 *  -text, -rule, defined beside the theme's tokens in app/globals.css); it takes the theme's own paper, paper-2, paper-3,
 *  ink and rule, as its bright theme does (DEC-2026-11-08-26). */
describe("Quick Create's dark and purple sheet stands on the theme's tones (DEC-2026-11-08-26)", () => {
  const QC = sheet("app/editor/mobile-modal.css");

  it("mobile-modal.css names no --surface- token", () => {
    expect(QC).not.toMatch(/--surface-/);
  });

  it("the sheet is the paper with the ink and the rule, as in the bright theme, and every hairline is the rule", () => {
    expect(rule(QC, ".mobile-modal-sheet").background).toBe("var(--enki-paper)");
    expect(rule(QC, ".dark .mobile-modal-sheet")).toEqual({ background: "var(--enki-paper)", color: "var(--enki-ink)", "border-color": "var(--enki-rule)" });
    // The hairline rule, scoped to Quick Create's own parts since DEC-2026-11-08-27 (pinned exactly below).
    expect(rules(QC).filter(([s, d]) => s.startsWith(".dark .mobile-modal-sheet :where(") && d["border-color"] === "var(--enki-rule)")).toHaveLength(1);
  });

  it("raised parts take paper-3, fields and secondary parts paper-2, the foot the paper, text the ink", () => {
    const of = (sel: string) => rules(QC).find(([s]) => s.split(",").map((x) => x.trim()).includes(sel))?.[1] ?? {};
    expect([of(".dark .mobile-modal-tab.active").background, of(".dark .mobile-modal-prompt-box").background, of(".dark .mobile-modal-footer").background])
      .toEqual(["var(--enki-paper-3)", "var(--enki-paper-2)", "var(--enki-paper)"]);
    expect(of(".dark .mobile-modal-select").background).toMatch(/^var\(--enki-paper-2\) url\(/);
    expect(of(".dark .mobile-modal-varimg-title").color).toBe("var(--enki-ink)");
  });
});

/** Quick Create, fifth step: in dark and purple one rule (`.dark .mobile-modal-sheet *`) painted every border inside the sheet
 *  in the rule, the kit's parts too, so the in-sheet kit confirm's danger pill lost the ring the one confirm draws and the
 *  close lost its hover border. It reaches only Quick Create's own parts now, at the weight it had (DEC-2026-11-08-27). */
describe("Quick Create's hairline rule reaches only its own parts (DEC-2026-11-08-27)", () => {
  const QC = sheet("app/editor/mobile-modal.css");

  it("in dark and purple it paints the rule on parts with a mobile-modal- class only, never the close, at the old (0,2,0) weight", () => {
    const hair = rules(QC).filter(([s, d]) => s.startsWith(".dark .mobile-modal-sheet ") && Object.keys(d).join() === "border-color");
    expect(hair.map(([s, d]) => [s, d["border-color"]])).toEqual([
      ['.dark .mobile-modal-sheet :where([class*="mobile-modal-"]:not(.mobile-modal-close, .kit-ring:focus-within))', "var(--enki-rule)"],
    ]);
    expect(QC).not.toMatch(/\.mobile-modal-sheet \*/);
  });

  it("every border its stylesheet draws sits on one of its own parts, so the scoped rule still reaches each of them", () => {
    const stray = rules(QC).flatMap(([sel, d]) => {
      const colour = Object.entries(d).some(([k, v]) => /^border(-(top|right|bottom|left))?(-color)?$/.test(k) && !/^(none|0)$/.test(v));
      if (!colour || sel.startsWith(".dark .mobile-modal-sheet :where(")) return [];
      return sel.split(",").map((s) => s.trim()).filter((s) => !/\.mobile-modal-/.test(s.split(/[ >+~]+/).pop() ?? ""));
    });
    expect(stray).toEqual([]);
  });
});

/** Kev's answer on the field (DEC-2026-11-08-19): every field in scope that shows no focus gets the ring. The first pin read
 *  only inline styles, so a stylesheet's `outline: none` passed unseen, and Quick Create's prompt, variable, title, select and
 *  price fields showed no focus. They wear the ring (.kit-ring) now, and this pin reads the stylesheets (DEC-2026-11-08-29). */
describe("no field hides its focus in a stylesheet either; Quick Create's fields wear the ring (DEC-2026-11-08-29)", () => {
  /** A selector list split at its top-level commas (a comma inside :not() or :where() stays). */
  const parts = (sel: string) => {
    const out: string[] = [];
    let depth = 0, cur = "";
    for (const c of sel) {
      if (c === "(") depth++;
      else if (c === ")") depth--;
      if (c === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += c;
    }
    return [...out, cur.trim()];
  };
  const CSS = APP.filter((f) => f.endsWith(".css") && IN_SCOPE(f)).map((f) => [f, rules(sheet(f))] as const);
  const TSX = APP.filter((f) => f.endsWith(".tsx") && IN_SCOPE(f)).map((f) => [f, readSource(join(ROOT, f))] as const);
  /** Every selector whose rule shows a focus: a border, a shadow or an outline that is not none, on :focus (not inside :not). */
  const FOCUS = CSS.flatMap(([, rs]) => rs)
    .filter(([, d]) => Object.entries(d).some(([k, v]) => /^(border|box-shadow|outline)/.test(k) && !/^(none|0)$/.test(v)))
    .flatMap(([s]) => parts(s)).filter((s) => /:focus/.test(s.replace(/:not\([^)]*\)/g, "")));
  /** A frame shows the focus of the field inside it: every class with a :focus-within or :has(... :focus) rule of its own,
   *  the one field and the ring (kit-base.css) among them. */
  const FRAMES = new Set(FOCUS.flatMap((s) => [...s.matchAll(/\.([\w-]+):(?:focus-within|has\([^)]*:focus)/g)].map((m) => m[1])));
  const classesOf = (tag: string) => (tag.match(/className=(?:"([^"]*)"|\{`([^`]*)`\})/)?.slice(1).find(Boolean) ?? "").split(/\s+/);
  /** The opening tags still open at a position: a stack walk over the JSX before it. */
  const around = (src: string, at: number) => {
    const stack: string[] = [];
    for (const m of src.slice(0, at).matchAll(/<(\/?)([A-Za-z][\w.]*)/g)) {
      if (m[1]) { const i = stack.map((t) => t.slice(1).split(/[\s>/]/)[0]).lastIndexOf(m[2]); if (i >= 0) stack.length = i; continue; }
      const t = openTag(src, m.index);
      if (!t.endsWith("/>")) stack.push(t);
    }
    return stack;
  };
  const FIELDS = TSX.flatMap(([f, src]) => [...src.matchAll(/<(input|textarea|select)\b/g)].map((m) => ({
    where: `${f}:${src.slice(0, m.index).split("\n").length}`, tag: openTag(src, m.index), around: () => around(src, m.index),
  })));
  const ringed = (x: (typeof FIELDS)[number]) => [x.tag, ...x.around()].some((t) => classesOf(t).some((k) => FRAMES.has(k)));

  it("finds the stylesheets, the fields and the frames it reads", () => {
    expect(CSS.length).toBeGreaterThan(20);
    expect(FIELDS.length).toBeGreaterThan(40);
    // Communities' picker box and the prompt editor's price show the focus of the field inside them.
    expect([...FRAMES]).toEqual(expect.arrayContaining(["st-input", "kit-ring", "cm-picker-box", "pe-price"]));
  });

  it("a rule that drops a field's outline leaves it a focus: a focus rule of its own, a frame that shows one, or the ring", () => {
    const hidden = CSS.flatMap(([file, rs]) => rs.flatMap(([sel, d]) => {
      if (!/^(none|0)$/.test(d.outline ?? "")) return [];
      return parts(sel).filter((s) => !/:focus|::/.test(s)).flatMap((s) => {
        const subject = s.split(/[ >+~]+/).pop() ?? "";
        const cls = [...subject.matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
        if (FOCUS.some((x) => x.startsWith(`${s}:focus`) || cls.some((k) => new RegExp(`\\.${k}(?![\\w-])[^ >+~]*:focus`).test(x)))) return [];
        // The fields it reaches: by their own class, or (`.box input`) by their type inside an element with the box's class.
        const type = subject.match(/^(input|textarea|select)\b/)?.[1];
        const box = [...s.matchAll(/\.([\w-]+)/g)].map((m) => m[1]).pop();
        const users = cls.length ? FIELDS.filter((x) => cls.some((k) => classesOf(x.tag).includes(k)))
          : type && box ? FIELDS.filter((x) => x.tag.startsWith(`<${type}`) && x.around().some((t) => classesOf(t).includes(box))) : [];
        return users.filter((x) => !ringed(x)).map((x) => `${file} ${s} <- ${x.where}`);
      });
    }));
    expect(hidden).toEqual([]);
  });

  it("Quick Create's fields wear the ring: the prompt and the selects themselves, the variable row and the price on their frame", () => {
    const src = readSource(join(ROOT, "components/EnkiMobileGenerateModal.tsx"));
    for (const [cls, n] of [
      ['className="mobile-modal-hl-textarea kit-ring"', 1], ['className="mobile-modal-var-row kit-ring"', 1],
      ['className="mobile-modal-var-manager-input kit-ring"', 2], ['className="mobile-modal-select mobile-modal-select--full kit-ring"', 2],
      ['className="mobile-modal-select mobile-modal-select--full mobile-modal-multiselect-trigger kit-ring"', 1],
      ['<div className="mobile-modal-price-input-wrap kit-ring">', 1],
    ] as const) expect(src.split(cls).length - 1, cls).toBe(n);
  });

  it("in dark and purple the sheet's hairline rule steps aside for a field that shows the ring", () => {
    const QC = sheet("app/editor/mobile-modal.css");
    expect(rules(QC).filter(([s]) => s.startsWith(".dark .mobile-modal-sheet :where(")).map(([s]) => s))
      .toEqual(['.dark .mobile-modal-sheet :where([class*="mobile-modal-"]:not(.mobile-modal-close, .kit-ring:focus-within))']);
  });

  it("the live variable rows draw the variable's own colours inline, so the stylesheet's cream under them is never drawn", () => {
    const src = readSource(join(ROOT, "components/EnkiMobileGenerateModal.tsx"));
    expect(src).toContain('className="mobile-modal-var-row kit-ring"\n                          style={{ background: c.bg, border: `1px solid ${c.border}` }}');
    expect(src).toContain('className="mobile-modal-var-name"\n                            style={{ color: c.text, borderRightColor: c.border }}');
  });
});

/** The staff page's dense fields wore the ring (.kit-ring) beside an inline `border: 1px solid var(--enki-rule)`, and an inline
 *  border colour outranks the ring's ember border, so their focus was the halo alone (DEC-2026-11-08-30). */
describe("a field that keeps its own frame shows the whole ring: .kit-ring draws the frame's line (DEC-2026-11-08-30)", () => {
  it("kit-base.css: .kit-ring's line is the one field's rule, set before its focus rule", () => {
    const KB = sheet("components/kit/kit-base.css");
    expect(rule(KB, ".kit-ring")).toEqual({ "border-color": rule(KB, ".st-input").border.replace(/^1px solid /, "") });
    expect(KB.indexOf("\n.kit-ring {")).toBeLessThan(KB.indexOf(".kit-ring:focus-within"));
  });

  it("no field that wears .kit-ring names a border colour inline: its width and style stay, the class draws the line", () => {
    const tags = APP.filter((f) => f.endsWith(".tsx") && IN_SCOPE(f)).flatMap((f) => {
      const src = readSource(join(ROOT, f));
      return [...src.matchAll(/className="kit-ring"/g)].map((m) => [f, openTag(src, src.lastIndexOf("<", m.index))] as const);
    });
    expect(tags.length).toBe(9);
    for (const [f, t] of tags) {
      expect(t, f).not.toMatch(/\bborder: "|borderColor:/);
      expect(t, f).toContain('borderWidth: 1, borderStyle: "solid"');
    }
  });
});

/** The bookmark picker's create field kept a field of its own (28px, radius 7, an ember border on focus and no halo) beside
 *  the one field (DEC-2026-11-08-19 left it); it wears the one field at the picker's row size (DEC-2026-11-08-31). */
describe("the bookmark picker's create field is the one field at its row's size (DEC-2026-11-08-31)", () => {
  it("its input wears .st-input, and bookmarks.css sizes it to the 28px row and draws nothing of its own", () => {
    expect(readSource(join(ROOT, "components/enki/BookmarkPicker.tsx"))).toContain('<input\n            className="st-input" autoFocus value={name} maxLength={60}');
    const css = sheet("components/enki/bookmarks.css");
    expect(rule(css, ".enki-bmp-create .st-input")).toEqual({ flex: "1", "min-width": "0", "min-height": "0", height: "28px", padding: "0 8px", "font-size": "12px" });
    expect(rules(css).filter(([s]) => /\.enki-bmp-create (input|\.st-input)/.test(s)).map(([s]) => s)).toEqual([".enki-bmp-create .st-input"]);
  });
});

/** /banned kept a window look of its own: an ink-filled appeal button where the windows' primary is the CTA, radius-14 cards
 *  where the windows' is CARD's 18, and titles typed out by hand that took the global h1 rule's --foreground and tracking
 *  (DEC-2026-11-08-32). */
describe("/banned takes the windows' look: CARD's corner, TITLE's titles, the CTA (DEC-2026-11-08-32)", () => {
  const src = () => readSource(join(ROOT, "app/banned/page.tsx"));

  it("its cards take CARD's corner and its titles TITLE at their size; 'Banned.' keeps the theme's danger", () => {
    const s = src();
    expect(s).toContain('import { CARD, CTA, LABEL, TITLE } from "@/components/enki-window";');
    expect(s).toMatch(/const card: React\.CSSProperties = \{[^}]*borderRadius: CARD\.borderRadius,/);
    expect(s).toContain('<h1 style={{ ...TITLE, fontSize: 24, margin: "0 0 6px" }}>Sign in first.</h1>');
    expect(s).toContain('<h1 style={{ ...TITLE, fontSize: 24, margin: "0 0 6px" }}>You&apos;re not banned.</h1>');
    expect(s).toContain('<h1 style={{ ...TITLE, fontSize: 30, margin: "0 0 6px", color: "var(--enki-danger)" }}>Banned.</h1>');
    expect(s.match(/<h1\b/g)).toHaveLength(3);
    expect(s).not.toMatch(/SERIF|fontStyle:|borderRadius: 14/);
  });

  it("the appeal is filed by the CTA at the row's 40px, as Edit profile's Save", () => {
    const s = src();
    expect(s).toContain('style={{ ...CTA, width: "auto", minHeight: 40, padding: "0 20px", cursor: busy || statement.trim().length < 20 ? "default" : "pointer"');
    expect(s).not.toMatch(/background: "var\(--enki-ink\)"/);
  });
});

/** The signed-out Profile ("Your profile lives behind the door.") kept the hand-typed `.serif` + <em> title DEC-10 moved
 *  everywhere else, and an inline copy of .ek-btn with the 1px ink border Kev's answer took off it (DEC-21)
 *  (DEC-2026-11-08-33). */
describe("the signed-out Profile: its title is .kit-title, its Log in the CTA without a border (DEC-2026-11-08-33)", () => {
  const pv = () => readSource(join(ROOT, "components/profile/ProfileView.tsx"));

  it("its title is a UI title, .kit-title at its 34px, with no <em>, weight or colour of its own", () => {
    expect(pv()).toContain('<h1 className="kit-title" style={{ fontSize: 34, margin: "0 0 10px" }}>Your profile lives behind the door.</h1>');
    expect(pv()).not.toMatch(/<em>Your profile lives/);
  });

  it("its Log in is the windows' CTA as .ek-btn draws it: CTA's pill, fill and ink, no border of its own", () => {
    const s = pv();
    const at = s.indexOf('<a href="/?login=1"');
    const tag = openTag(s, at);
    expect(tag).toContain('...CTA, display: "inline-flex", alignItems: "center", justifyContent: "center", width: "auto", padding: "0 28px"');
    expect(tag).not.toMatch(/border|background|color:|minHeight|fontSize|fontWeight/);
    expect(CTA.border).toBe("none");
  });
});

/** One corner had two hovers: the stylesheet corners (.ek-modal-x, the NFT picker's, the reviews', Quick Create's) darken on
 *  hover, while the corners that wear ROUND inline (the six shadcn windows' close, the two windows' backs, the card pages'
 *  back) could not, as an inline style has no hover (DEC-2026-11-08-14's residual risk). They wear .kit-round now
 *  (DEC-2026-11-08-34). */
describe("one corner, one hover: the corners that wear ROUND inline take .ek-modal-x's hover by .kit-round (DEC-2026-11-08-34)", () => {
  it("kit-base.css .kit-round:hover is .ek-modal-x:hover, each value marked to reach past the inline ROUND", () => {
    const hover = rule(sheet("components/kit/kit-base.css"), ".kit-round:hover");
    expect(Object.values(hover).every((v) => v.endsWith(" !important"))).toBe(true);
    expect(Object.fromEntries(Object.entries(hover).map(([k, v]) => [k, v.replace(/ !important$/, "")]))).toEqual(rule(sheet("components/enki-shell/enki-shell.css"), ".ek-modal-x:hover"));
  });

  it("the dialog's close wears it when a window gives it the corner, and every element that wears ROUND inline wears it", () => {
    expect(readSource(join(ROOT, "components/ui/dialog.tsx"))).toContain('data-[state=open]:text-muted-foreground" + (closeStyle ? " kit-round" : "")} style={closeStyle}>');
    const tags = APP.filter((f) => f.endsWith(".tsx") && IN_SCOPE(f)).flatMap((f) => {
      const src = readSource(join(ROOT, f));
      return [...src.matchAll(/style=\{(?:ROUND\}|embed \? undefined : \{ \.\.\.ROUND)/g)].map((m) => [f, openTag(src, src.lastIndexOf("<", m.index))] as const);
    });
    expect(tags.map(([f]) => f).sort()).toEqual(["components/ConfirmEmailWindow.tsx", "components/EnkiCardPage.tsx", "components/PrivateBetaWindow.tsx"]);
    for (const [f, t] of tags) expect(t, f).toMatch(/className=\{(`\$\{CORNER\} left-4 kit-round`|embed \? "auth-close" : "kit-round")\}/);
  });
});
