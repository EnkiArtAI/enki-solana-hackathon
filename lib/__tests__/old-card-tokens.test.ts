import { describe, it, expect, vi } from "vitest";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readSource } from "./_read-source";
import EnkiCardPage, { EnkiCardButton, EnkiCardInput, LANDING } from "@/components/EnkiCardPage";
import UsernameOnboard from "@/components/enki-shell/UsernameOnboard";
import ResetPasswordPage from "../../app/reset-password/page";

// The reset page's screens are its state: useState answers from `screen` by call order, and the page reads embed from `nav`.
const screen = vi.hoisted(() => ({ i: 0, state: {} as Record<number, unknown> }));
const nav = vi.hoisted(() => ({ query: "embed=1" }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (start: unknown) => { const i = screen.i++; return [i in screen.state ? screen.state[i] : start, () => {}]; },
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({}), useSearchParams: () => new URLSearchParams(nav.query) }));

/**
 * The July screens move onto the app's theme (Kev, 2026-11-07, on /guardian: "that looks like it's my old UI color
 * style"; DEC-2026-11-07-37): the look of the app's windows (components/enki-window.ts) in the theme's tokens. Inside the
 * landing's login popup (/reset-password?embed=1) the reset steps take the popup's own look, in each landing theme (Kev,
 * 2026-11-07, on the popup's "Reset via email.": "that still looks like the old UI ... it must fit to our UI/UX
 * colortones"; DEC-2026-11-07-41). The login's wallet step (WalletPickerModal without inApp) keeps the landing's look.
 */
const ROOT = join(__dirname, "..", "..");
const src = (...p: string[]) => readSource(join(ROOT, ...p));
// The old look's colours and fonts.
const OLD = /e8a83a|d9863f|0e0e12|08080b|245, ?242, ?236|f5f2ec|ff7a6b|7fd99a|a9e6bd|181209|instrument-serif|dm-sans/i;
// What only July had: the cream, the dark ink on ember, the coral and green, the serif. The serif is back on the app's own
// pages as the layout's title (enki-window.ts TITLE, DEC-2026-11-08-01); the popup and the sources here still have none.
const JULY = /245, ?242, ?236|f5f2ec|ff7a6b|7fd99a|a9e6bd|181209|instrument-serif|italic/i;
// Any colour of its own: a hex, rgb(a) or a literal hsl (hsl(var(--background)) is the theme's).
const LITERAL = /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\((?!var\()/i;

const CARD_PAGE = src("components", "EnkiCardPage.tsx");
const LANDING_BLOCK = CARD_PAGE.slice(CARD_PAGE.indexOf("export const LANDING = {"), CARD_PAGE.indexOf("const ON = {"));
const PICKER = src("components", "WalletPickerModal.tsx");
const block = (s: string, name: string) => s.slice(s.indexOf(`const ${name} = \``), s.indexOf("`;", s.indexOf(`const ${name} = \``)));

const card = ({ embed = false, disabled = false } = {}) =>
  renderToStaticMarkup(createElement(
    EnkiCardPage,
    { embed, title: "Get back in.", eyebrow: "Enki Art · Recovery", onBack: () => {} } as ComponentProps<typeof EnkiCardPage>,
    createElement(EnkiCardInput, { placeholder: "you@example.com" }),
    createElement(EnkiCardButton, { disabled }, "Send code"),
  )).replace(/&#x27;/g, "'");

describe("the cards on the app's own pages (/guardian, /reset-password)", () => {
  it("are the windows' card on the app's ground, with the app's mark, title, field and button", () => {
    const out = card();
    expect(out).toContain("background:hsl(var(--background))");
    for (const d of ["background:var(--enki-paper)", "color:var(--enki-ink)", "border-color:var(--enki-rule)", "border-radius:18px", "box-shadow:var(--enki-shadow-pop)", "border-width:1px;border-style:solid"]) expect(out, d).toContain(d);
    expect(out).toContain('<img src="/favicon.svg" alt="" width="16" height="16"/>');
    expect(out).toContain('<h1 style="font-family:var(--font-serif), Georgia, serif;font-style:italic;font-weight:400;font-size:28px;line-height:1.1;letter-spacing:-0.02em;color:var(--card-ink);margin:0 0 12px">Get back in.</h1>');
    // The field is the app's one field (kit-base.css .st-input, DEC-2026-11-08-19), with no frame of its own.
    expect(out).toContain('<input class="st-input" placeholder="you@example.com"/>');
    expect(out).toContain("border:none;background:var(--cta-bg);color:var(--cta-ink)");
    // The back is the windows' corner (enki-window.ts ROUND, DEC-2026-11-08-14).
    expect(out).toContain('style="width:34px;height:34px;border-radius:50%;border:1px solid var(--enki-rule);background:var(--enki-paper-2);color:var(--enki-ink-2);display:flex;align-items:center;justify-content:center;opacity:1;cursor:pointer;margin-right:4px"');
    expect(out).not.toMatch(OLD);
    expect(out).not.toMatch(LITERAL);
    expect(out).not.toMatch(/auth-|<style/);
  });

  it("show the field's placeholder in the quiet label, not Tailwind's ink at 50% (3.48:1 on light's paper-2); the popup keeps its own (DEC-2026-11-07-39)", () => {
    const out = card();
    // The one field's placeholder is the quiet label (kit-base.css, DEC-2026-11-08-19).
    expect(out).toContain('<input class="st-input" placeholder="you@example.com"');
    expect(src("components", "kit", "kit-base.css")).toContain(".st-input::placeholder { color: var(--enki-label-quiet); }");
    expect(out).toContain("--card-quiet:var(--enki-label-quiet)");
    expect(card({ embed: true })).toContain('<input class="auth-input" placeholder="you@example.com"/>');
  });

  it("disable the button as the windows do: the PILL, half see-through, not-allowed", () => {
    expect(card({ disabled: true })).toContain("min-height:46px;border-radius:999px;border:1px solid var(--enki-rule);background:var(--enki-paper-2);color:var(--enki-ink);font-weight:600;opacity:0.5;cursor:not-allowed");
  });

  it("give every colour the pages read a value from the theme", () => {
    const read = new Set([CARD_PAGE, src("app", "guardian", "page.tsx"), src("app", "reset-password", "page.tsx")].flatMap((s) => s.match(/var\(--card-[\w-]+\)/g) ?? []).map((v) => v.slice(4, -1)));
    expect(read.size).toBeGreaterThanOrEqual(9);
    const theme = card();
    for (const name of read) expect(theme, name).toMatch(new RegExp(`${name}:var\\(--enki-[\\w-]+\\)`));
  });
});

// The landing's own CSS, the source of truth for the popup (public/landing.html).
const HTML = readFileSync(join(ROOT, "public", "landing.html"), "utf8").split("\r\n").join("\n");
/** A rule's declarations in order, comments dropped and spaces collapsed: a top-level rule as both files write it. */
const decls = (css: string, selector: string): [string, string][] => {
  const at = css.indexOf(`\n  ${selector} {`);
  if (at < 0) return [];
  const body = css.slice(css.indexOf("{", at) + 1, css.indexOf("}", at)).replace(/\/\*[^]*?\*\//g, "");
  return body.split(";").map((d) => d.trim().replace(/\s+/g, " ")).filter(Boolean).map((d) => [d.slice(0, d.indexOf(":")).trim(), d.slice(d.indexOf(":") + 1).trim()]);
};
const decl = (selector: string, prop: string) => decls(HTML, selector).find(([p]) => p === prop)?.[1];
type Theme = keyof typeof LANDING.themes;
const THEMES: Theme[] = ["teal", "purple", "light"];
/** The landing's tokens in a theme as its popup sees them: :root (teal), its theme block, then .auth-modal's own; var() resolved. */
const landing = (theme: Theme) => {
  const sel = { teal: [":root", ".auth-modal"], purple: [":root", "html.lp-purple", ".auth-modal"], light: [":root", "html.lp-light", ".auth-modal", "html.lp-light .auth-modal"] }[theme];
  const raw: Record<string, string> = Object.assign({}, ...sel.map((s) => Object.fromEntries(decls(HTML, s))));
  const resolve = (v: string): string => v.replace(/var\((--[\w-]+)\)/g, (_, n: string) => resolve(raw[n] ?? `UNDEFINED(${n})`));
  const out: Record<string, string> = { "--ek-panel": resolve(raw.background) };
  for (const [k, v] of Object.entries(raw)) if (k.startsWith("--")) out[k] = resolve(v);
  return out;
};
/** Every token the popup's copied rules and the card's colours read. */
const READ = [...new Set([LANDING.popup, ...Object.values(LANDING.colours)].join(" ").match(/var\(--[\w-]+/g)!.map((v) => v.slice(4)))].filter((n) => !n.startsWith("--font"));
/** Every rule of landing.html's <style> blocks in order, as "<its @media/@supports> <selector>", with its declarations. */
const RULES = (() => {
  const css = [...HTML.matchAll(/<style[^>]*>([^]*?)<\/style>/g)].map((m) => m[1]).join("\n").replace(/\/\*[^]*?\*\//g, "");
  const out: { rule: string; body: string }[] = [];
  const open: string[] = [];
  let text = "";
  for (const ch of css) {
    if (ch === "{") { open.push(text.trim().replace(/\s+/g, " ")); text = ""; continue; }
    if (ch !== "}") { text += ch; continue; }
    const selector = open.pop()!;
    if (!selector.startsWith("@")) out.push({ rule: [...open.filter((s) => s.startsWith("@")), selector].join(" "), body: text });
    text = "";
  }
  return out;
})();
const COPIED = [".auth-close", ".auth-close:hover", "html.lp-light .auth-close", ".auth-input", ".auth-input:focus", ".auth-input::placeholder", ".auth-forgot, .auth-link", ".auth-forgot:hover, .auth-link:hover", ".auth-submit", ".auth-submit:hover", ".auth-submit:disabled", ".auth-social", ".auth-social:hover", ".auth-note", ".auth-success-icon"];

describe("inside the landing's login popup (/reset-password?embed=1)", () => {
  it("copies the popup's rules as the landing writes them, the app's DM Sans named first", () => {
    expect([...LANDING.popup.matchAll(/^ {2}([^{}\n]+?) \{/gm)].map((m) => m[1])).toEqual(COPIED);
    const asLanding = LANDING.popup.replaceAll("var(--font-dm-sans), ", "");
    for (const s of COPIED) {
      expect(decls(HTML, s).length, s).toBeGreaterThan(0);
      expect(decls(asLanding, s), s).toEqual(decls(HTML, s));
    }
  });

  it.each(THEMES)("takes every token those rules read from the landing's %s theme, and no other", (theme) => {
    const want = landing(theme);
    expect(READ.length).toBeGreaterThanOrEqual(7);
    for (const name of ["--ek-panel", ...READ]) expect((LANDING.themes[theme] as Record<string, string>)[name], name).toBe(want[name]);
    expect(Object.keys(LANDING.themes[theme]).filter((k) => k !== "--ek-panel" && !READ.includes(k))).toEqual([]);
  });

  // A closed set (DEC-2026-11-07-42): a landing rule the two tests above do not read (scoped to a theme or a media query,
  // or a second rule for a copied part) would change the popup's login step and leave the reset steps as they were. A new
  // one fails here until it is copied, or listed with the reason the reset steps do without it.
  it("knows every landing rule that reaches a copied part or sets a token, so the popup cannot change without the embed", () => {
    const parts = [...new Set([".auth-modal", ...(LANDING.popup.match(/\.auth-[\w-]+/g) ?? [])])];
    const naming = RULES.map((r) => r.rule).filter((rule) => parts.some((p) => new RegExp(`\\${p}(?![\\w-])`).test(rule)));
    const SMALL = "@media (max-height: 760px), (max-width: 480px)";
    expect(naming.filter((rule) => !COPIED.includes(rule))).toEqual([
      // Resolved into LANDING.themes by the test above: the panel and its tokens.
      ".auth-modal", "html.lp-light .auth-modal",
      // The modal's own scrollbar; the frame scrolls in the app's.
      ".auth-modal::-webkit-scrollbar", ".auth-modal::-webkit-scrollbar-thumb",
      // The small screen's layout: the modal's padding and the ✕'s margin; the back arrow's margin is the card's (LANDING.fit).
      `${SMALL} .auth-close`, `${SMALL} .auth-modal`,
      // The password eye's room and the submit's spinner: the reset steps have neither.
      ".auth-input-wrap .auth-input", ".auth-submit.loading .auth-submit-spin", ".auth-submit.loading .auth-submit-text",
    ]);
    expect(naming.filter((rule) => COPIED.includes(rule)).sort()).toEqual([...COPIED].sort());
    // Tokens are set only in the theme blocks and on the modal, which the test above resolves, and on the showcase, a
    // section of the page the popup is not in (#authBackdrop is a child of <body>).
    expect(RULES.filter((r) => /(^|;)\s*--(lp|auth)-/.test(r.body)).map((r) => r.rule)).toEqual([":root", "html.lp-purple", "html.lp-light", ".auth-modal", "html.lp-light .auth-modal", "html.lp-light .kv-showcase"]);
  });

  it("gives the pages the popup's own colours: its field's ink, its note's text, its link", () => {
    expect(LANDING.colours).toEqual({
      "--card-ink": decl(".auth-input", "color"),
      "--card-ink-2": decl(".auth-note", "color"),
      "--card-quiet": decl(".auth-note", "color"),
      "--card-accent": decl(".auth-forgot, .auth-link", "color"),
      "--card-green": decl(".auth-input", "color"),
    });
  });

  it("paints the frame's page in the popup's panel from its first frame, on the <html> classes the layout's script sets", () => {
    const out = card({ embed: true });
    const css = out.slice(out.indexOf("<style>") + 7, out.indexOf("</style>"));
    const ON = { teal: ":root", purple: ":root.theme-purple", light: ":root:not(.dark)" };
    for (const t of THEMES) {
      const tokens = css.match(new RegExp(`^${ON[t].replace(/[.()]/g, "\\$&")} \\{ ([^}]*) \\}$`, "m"))?.[1];
      expect(tokens, t).toBe(Object.entries(LANDING.themes[t]).map(([k, v]) => `${k}: ${v};`).join(" "));
    }
    expect(css).toContain("\n:root, :root body { background: var(--ek-panel); }\n");
    expect(css).toContain("\n  :root:not(.dark) .auth-close { background: rgba(255, 255, 255, 0.94); }\n");
    expect(css).not.toMatch(/\.lp-(light|purple)\b/);
    expect(css).toContain(LANDING.fit);
    expect(out.indexOf("<style>")).toBeLessThan(out.indexOf("<h1"));
    expect(src("app", "layout.tsx")).toContain("d.classList.toggle('dark',t==='dark'||t==='purple');d.classList.toggle('theme-purple',t==='purple');");
    expect(HTML).toContain("c.toggle('lp-purple', t === 'purple');\n    c.toggle('lp-light',  t === 'light');");
    expect(src("app", "reset-password", "page.tsx")).not.toMatch(/style\.background|LANDING/);
  });

  it("shows the popup's type, its back button and its field and submit, upright and without a serif", () => {
    const out = card({ embed: true });
    expect(out).toContain('<div class="ek-embed" style="font-family:var(--font-dm-sans), \'DM Sans\', system-ui, sans-serif">');
    expect(out).toContain('<h1 style="font-family:var(--font-dm-sans), \'DM Sans\', system-ui, sans-serif;font-weight:800;font-size:1.25rem;line-height:1.3;letter-spacing:normal;margin:0 0 12px;color:var(--card-ink)">Get back in.</h1>');
    expect(out).toContain('<button aria-label="Back" class="auth-close">←</button>');
    expect(out).toContain('<input class="auth-input" placeholder="you@example.com"/><button class="auth-submit">Send code</button>');
    expect(card({ embed: true, disabled: true })).toContain('<button class="auth-submit" disabled="">Send code</button>');
    expect(out).not.toMatch(/italic|instrument|georgia|(?<!sans-)serif/i);
    expect(out).not.toContain("favicon.svg");
    expect(out).not.toContain("text-2xl");
  });

  // DEC-2026-11-07-45: the popup's own button has the modal's padding around its glow; in the frame the card gives it that
  // room, and the landing widens the frame by as much, so the fields keep the login step's width.
  it("leaves the submit's glow room inside the frame, within the modal's small-screen padding, and the landing widens the frame by as much", () => {
    const blur = Number(decl(".auth-submit", "box-shadow")?.match(/^0 6px (\d+)px /)?.[1]);
    const small = Number(RULES.find((r) => r.rule === "@media (max-height: 760px), (max-width: 480px) .auth-modal")?.body.match(/padding: \d+px (\d+)px/)?.[1]);
    const side = Number(card({ embed: true }).match(/;padding:4px (\d+)px"/)?.[1]);
    expect(side).toBeGreaterThanOrEqual(blur);
    expect(side).toBeLessThanOrEqual(small);
    expect(HTML).toContain('<iframe src="/reset-password?embed=1" style="width:calc(100% + ' + 2 * side + 'px);height:520px;margin:0 -' + side + 'px;border:0;background:transparent" allowtransparency="true"></iframe>');
  });

  it("changes only the layout of the popup's rules where the card needs it, never a colour", () => {
    expect(LANDING.fit).not.toMatch(/color|background|border|shadow|opacity|#|rgb|var\(/i);
    expect([...LANDING.fit.matchAll(/^ {2}([^{}\n]+?) \{/gm)].map((m) => m[1])).toEqual([".ek-embed .auth-close", ".ek-embed .auth-submit", ".ek-embed .auth-social", ".ek-embed .auth-success-icon"]);
  });

  // useState in call order: mode 0, email 1, busy 2, error 3, done 4, codeSent 5, code 6, pw 7, pw2 8, request 9,
  // progress 10, approved 11.
  const SCREENS: Record<string, Record<number, unknown>> = {
    choice: {},
    email: { 0: "email" },
    emailReady: { 0: "email", 1: "a@b.co" },
    code: { 0: "email", 1: "a@b.co", 3: "Boom", 5: true, 6: "1234567", 7: "abcdefgh", 8: "abcdefgx" },
    codeReady: { 0: "email", 1: "a@b.co", 5: true, 6: "1234567", 7: "abcdefgh", 8: "abcdefgh" },
    guardian: { 0: "guardian", 1: "a@b.co", 3: "Boom" },
    waiting: { 0: "guardian", 3: "Boom", 9: { id: "i", key: "k" }, 10: { approved: 1, threshold: 3 } },
    approved: { 0: "guardian", 3: "Boom", 7: "abcdefgh", 8: "abcdefgh", 9: { id: "i", key: "k" }, 11: true },
    done: { 4: true },
  };
  const page = (state: Record<number, unknown>) => {
    screen.i = 0; screen.state = state;
    const out = renderToStaticMarkup(createElement(ResetPasswordPage)).replace(/&#x27;/g, "'");
    screen.state = {};
    return out;
  };
  /** Every element below the title that takes a popup rule (its auth-* class) or a colour or font of its own. */
  const look = (state: Record<number, unknown>) =>
    [...page(state).split("</h1>")[1].matchAll(/<([a-z0-9]+)\b([^>]*)>/g)].flatMap(([, tag, attrs]) => {
      const rule = (attrs.match(/class="([^"]*)"/)?.[1] ?? "").split(" ").filter((c) => c.startsWith("auth-")).map((c) => `.${c}`).join("");
      const own = (attrs.match(/style="([^"]*)"/)?.[1] ?? "").split(";").filter((d) => /^(color|background|background-color|border|border-color|font-family):/.test(d));
      return rule || own.length ? [`${tag}${rule}${own.length ? ` ${own.join(";")}` : ""}${/ disabled=""/.test(attrs) ? " disabled" : ""}`] : [];
    });
  const SUB = "p color:var(--card-ink-2)";
  const TILE = ["button.auth-social", "span color:var(--card-accent)", "span color:var(--card-quiet)"];
  const FIELD = "input.auth-input";
  const CODE = "input.auth-input";
  const ON = "button.auth-submit";
  const OFF = "button.auth-submit disabled";
  const NOTE = "p.auth-note";
  const RESEND = "button.auth-link";
  const POPUP: Record<string, string[]> = {
    choice: [SUB, ...TILE, ...TILE],
    email: [SUB, FIELD, OFF],
    emailReady: [SUB, FIELD, ON],
    code: [SUB, CODE, FIELD, FIELD, NOTE, NOTE, OFF, RESEND],
    codeReady: [SUB, CODE, FIELD, FIELD, ON, RESEND],
    guardian: [SUB, FIELD, NOTE, ON],
    waiting: [SUB, "svg color:var(--card-accent)", "span color:var(--card-ink)", NOTE],
    approved: [SUB, FIELD, FIELD, NOTE, ON],
    done: [SUB, "span.auth-success-icon", "svg color:var(--card-green)"],
  };

  it.each(Object.keys(SCREENS))("gives every element of the reset page's %s screen a rule or a colour of the popup's", (name) => {
    expect(look(SCREENS[name])).toEqual(POPUP[name]);
    const out = page(SCREENS[name]);
    const body = out.replace(/<style>[^]*?<\/style>/, "");
    for (const v of body.match(/var\(--card-[\w-]+\)/g) ?? []) expect(Object.keys(LANDING.colours), v).toContain(v.slice(4, -1));
    // A colour value of its own: a hex or a number in rgb()/hsl(); the card's rgb(var(--lp-text-rgb)) is the popup's token.
    expect(body).not.toMatch(/#[0-9a-f]{3,8}\b|(rgba?|hsla?)\(\s*\d/i);
    expect(out).not.toMatch(JULY);
  });

  it("shows 'Send a new code' as the popup's link: its class, no underline of its own (DEC-2026-11-07-43)", () => {
    expect(page(SCREENS.code)).toContain('<button type="button" class="auth-link" style="cursor:pointer">Send a new code</button>');
  });

  it("sets the 7-digit code in the popup's field type, at the page's size and spacing (DEC-2026-11-07-44)", () => {
    const code = page(SCREENS.code).match(/<input class="auth-input"[^>]*placeholder="1234567"[^>]*>/)?.[0];
    expect(code).toContain(' style="text-align:center;font-size:26px;letter-spacing:0.45em;font-weight:700"');
    expect(code).not.toMatch(/font-family|monospace/);
  });

  it("leaves the parts the reset page shares with its own page in the windows' look there", () => {
    nav.query = "";
    try {
      const outs = Object.fromEntries(Object.entries(SCREENS).map(([name, state]) => [name, page(state)]));
      expect(outs.choice).toContain('<button style="display:flex;align-items:center;gap:14px;text-align:left;cursor:pointer;padding:16px 16px;border-radius:12px;border:1px solid var(--card-rule);background:var(--card-field);color:var(--card-ink)"><span style="color:var(--card-accent)">');
      expect(outs.code).toContain('<p style="font-size:13px;color:var(--card-danger);margin:0">Boom</p>');
      expect(outs.code).toMatch(/placeholder="1234567"[^>]*font-family:var\(--font-jetbrains-mono\), ui-monospace, monospace;font-weight:700"/);
      expect(outs.code).toContain('<button type="button" style="background:none;border:none;color:var(--card-faint);font-size:12.5px;cursor:pointer;text-decoration:underline">Send a new code</button>');
      expect(outs.waiting).toContain('<p style="font-size:13px;color:var(--card-danger);margin:10px 0 0">Boom</p>');
      expect(outs.done).toMatch(/gap:8px"><svg [^>]*style="color:var\(--card-green\)"/);
      for (const [name, out] of Object.entries(outs)) expect(out, name).not.toMatch(/auth-|<style|ek-embed/);
    } finally {
      nav.query = "embed=1";
    }
  });
});

describe("the July colours", () => {
  it.each([["app", "guardian", "page.tsx"], ["app", "reset-password", "page.tsx"], ["components", "enki-shell", "UsernameOnboard.tsx"]])("are gone from %s/%s/%s, which carries no colour of its own", (...p) => {
    const s = src(...p);
    expect(s).not.toMatch(OLD);
    expect(s).not.toMatch(LITERAL);
  });

  it("are gone from EnkiCardPage, where the landing's popup keeps its own values in its block only", () => {
    expect(CARD_PAGE).not.toMatch(JULY);
    expect(LANDING_BLOCK).toMatch(LITERAL);
    const rest = CARD_PAGE.replace(LANDING_BLOCK, "");
    expect(rest).not.toMatch(OLD);
    expect(rest).not.toMatch(LITERAL);
  });
});

describe("the username picker after the first login", () => {
  it("is the windows' card over the windows' veil, with the CTA greyed until a name is free", () => {
    const out = renderToStaticMarkup(createElement(UsernameOnboard, { email: null, wallet: null, onDone: () => {} }));
    expect(out).toContain('class="bg-black/50 backdrop-blur-[6px]"');
    for (const d of ["background:var(--enki-paper)", "color:var(--enki-ink)", "border-radius:18px", "box-shadow:var(--enki-shadow-pop)", "border-width:1px;border-style:solid"]) expect(out, d).toContain(d);
    expect(out).toContain('<img src="/favicon.svg" alt="" width="16" height="16"/>');
    expect(out).toContain('<h1 style="font-family:var(--font-serif), Georgia, serif;font-style:italic;font-weight:400;font-size:28px;line-height:1.1;letter-spacing:-0.02em;color:var(--enki-ink);margin:0 0 10px">Pick your name.</h1>');
    expect(out).toContain("background:var(--enki-paper-2);color:var(--enki-ink);font-size:14px;font-weight:600;opacity:0.5;flex:1;cursor:not-allowed");
    expect(out).toContain('placeholder="your_name" class="placeholder:text-[color:var(--enki-label-quiet)]"');
    expect(out).not.toMatch(OLD);
    expect(out).not.toMatch(LITERAL);
  });

  it("turns the CTA on for a free name", () => {
    expect(src("components", "enki-shell", "UsernameOnboard.tsx")).toContain('...(status === "free" ? CTA : { ...PILL, opacity: 0.5 }), flex: 1,');
  });
});

describe("the wallet picker", () => {
  it("in the app (the editor's Generate check) takes over every colour of the landing's rules with the theme's tokens", () => {
    const app = block(PICKER, "APP_CSS");
    expect(app).not.toMatch(LITERAL);
    const coloured = [...block(PICKER, "PICKER_CSS").matchAll(/^(\.wp-[^{\n]*?)\s*\{([^}]*)\}/gm)].filter((m) => LITERAL.test(m[2])).flatMap((m) => m[1].split(/,\s*/));
    expect(coloured).toHaveLength(18);
    for (const selector of coloured) expect(app, selector).toContain(`.wp-app ${selector}`);
    expect(PICKER).toContain('style={inApp ? { ...CARD, borderWidth: 1, borderStyle: "solid" } : {');
    expect(PICKER).toContain('overlayClassName={inApp ? "z-[2000] bg-black/50 backdrop-blur-[6px]" :');
    // Two plain strings: Tailwind writes no rule for a class glued to `${` (DEC-2026-11-08-46).
    expect(PICKER).toContain('className={inApp ? "sm:max-w-[400px] gap-0 border-0 p-0 overflow-hidden z-[2001] wp-app" : "sm:max-w-[400px] gap-0 border-0 p-0 overflow-hidden z-[2001]"}');
    expect(PICKER).toContain("__html: inApp ? PICKER_CSS + APP_CSS : PICKER_CSS");
    expect(PICKER).toContain('color: inApp ? "var(--enki-ink)" : "rgba(244,238,232,0.9)"');
    expect(PICKER).toContain('color: inApp ? "var(--enki-label-quiet)" : "rgba(244,238,232,0.45)"');
    expect(src("components", "prompt-editor", "PromptEditor.tsx")).toContain("<WalletPickerModal inApp open={walletOpen}");
  });

  it("puts the status in the accent's ink: it sits on the hovered row, where purple's ember reads 4.48:1 (DEC-2026-11-07-38)", () => {
    const app = block(PICKER, "APP_CSS");
    expect(app).toContain(".wp-app .wp-row:hover:not(:disabled) { background: var(--enki-paper-2); }");
    expect(app).toContain(".wp-app .wp-status { color: var(--enki-accent-ink); }");
    expect(app.match(/\.wp-status[^{]*\{[^}]*\}/g)).toEqual([".wp-status { color: var(--enki-accent-ink); }"]);
  });

  it("keeps the landing's look as the login's wallet step, on the landing and after its login card", () => {
    expect(PICKER).toContain('background: "#0E0E12",\n          border: "1px solid rgba(232,168,58,0.18)",');
    expect(PICKER).toContain('"z-[2000] bg-[rgba(0,4,24,0.75)] backdrop-blur-[10px]"');
    expect(src("app", "page.tsx")).toContain("<WalletPickerModal open={showWalletPicker}");
    expect(src("components", "LoginModal.tsx")).toContain("<WalletPickerModal open={open && walletOpen}");
  });
});
