import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { CARD, CTA } from "@/components/enki-window";

/**
 * DEC-480 (Kev, 2026-10-28): the landing's header is his ENKI wordmark (bordeaux, black, on white), and the light
 * theme's bubble among the theme swatches is white and bordeaux, no cream left at the top of the page.
 */
const PUBLIC = join(__dirname, "..", "..", "public");
const LANDING = readFileSync(join(PUBLIC, "landing.html"), "utf8");
const WORDMARK = readFileSync(join(PUBLIC, "enki-wordmark.svg"), "utf8");

describe("the landing's brand bar", () => {
  it("shows Kev's wordmark as the header", () => {
    const bar = LANDING.slice(LANDING.indexOf('<div class="brand-bar">'), LANDING.indexOf('<div class="theme-swatches"'));
    expect(bar).toContain('<img src="/enki-wordmark.svg" alt="Enki Art" />');
    expect(bar).not.toContain("enki-art-logo.png");
  });

  it("shows it in the login window too, its black turned white: the window is dark in every theme (DEC-485, DEC-490)", () => {
    const modal = LANDING.slice(LANDING.indexOf('<div class="auth-modal" id="authModal">'), LANDING.indexOf('<div class="auth-tabs">'));
    expect(modal).toContain('<div class="auth-logo"><img src="/enki-wordmark.svg" alt="Enki Art" /></div>');
    expect(LANDING).toContain(".auth-logo img { display: inline-block; height: 40px; width: auto; padding: 5px 9px; filter: url(#enki-wordmark-on-dark); }");
    expect(LANDING).not.toContain("enki-art-logo.png");
  });

  it("ships the wordmark cropped to its letters, without the white square, and with nothing but shapes", () => {
    expect(WORDMARK).toContain('viewBox="361 328 801 387"');
    expect(WORDMARK).not.toMatch(/fill="#fff"/i);
    expect(WORDMARK).not.toMatch(/<(script|image|foreignObject|use)\b|href|\son[a-z]+=|url\(/i);
    expect(WORDMARK.match(/fill="#8A0312"/g)?.length).toBeGreaterThan(5);
  });

  it("turns the wordmark's black white on the dark themes and shows it as drawn on the light one, never on a plate (DEC-490)", () => {
    expect(LANDING).toMatch(/\n {2}\.brand-mark img \{[^}]*\n {4}filter: url\(#enki-wordmark-on-dark\);\n/);
    expect(LANDING).toContain("html.lp-light .brand-mark img { filter: drop-shadow(0 0 6px rgba(255,255,255,0.9)); }");
    expect(LANDING).not.toMatch(/\.(brand-mark|auth-logo) img \{[^}]*(background|box-shadow)/);
  });

  it("paints the light theme's bubble white blending into bordeaux, like its teal and purple neighbours (DEC-489)", () => {
    expect(LANDING).toContain(".lp-sw-light  { background: linear-gradient(135deg,#fff,#850814); }");
    expect(LANDING).not.toMatch(/#faf8f4|#e2d8c6/i);
  });
});

// DEC-481: the light theme's dark-on-dark leftovers (review wf_794afa1b-83d).
describe("the light theme on dark ground", () => {
  it("keeps the showcase's words light on the scrims over its images", () => {
    expect(LANDING).toContain("html.lp-light .kv-showcase { --lp-text-rgb: 244, 238, 232; --lp-bright-rgb: 240, 168, 177; }");
  });

});

// DEC-492 (Kev, 2026-10-28: "diese oberfläche sollte sich auch je nach dem farbschema anpassen. bright mode ist das
// zumindest auf jeden fall nicht und sieht zu düster aus"): the light theme's login window is light.
describe("the login window on the light theme", () => {
  const rule = (selector: string) => { const at = LANDING.indexOf(`\n  ${selector} {`); return at < 0 ? "" : LANDING.slice(at, LANDING.indexOf("}", at) + 1); };

  it("is white with black text, bordeaux links and a light veil, and shows the wordmark as drawn", () => {
    expect(rule("html.lp-light .auth-modal")).toMatch(/--lp-text-rgb: 12, 12, 12; --auth-link: var\(--lp-accent\);\s+background: #fff;/);
    expect(LANDING).toContain("html.lp-light .auth-backdrop { background: rgba(246, 244, 244, 0.72); }");
    expect(LANDING).toContain("html.lp-light .auth-close { background: rgba(255, 255, 255, 0.94); }");
    expect(LANDING).toContain("html.lp-light .auth-logo img { filter: none; }");
    expect(LANDING).not.toContain("--lp-bright: #f0a8b1");
  });

  it("paints its text, fields and buttons in the theme's ink, never a fixed white", () => {
    for (const s of [".auth-tab.active", ".auth-input", ".auth-social", ".auth-textarea"]) expect(rule(s), s).toContain("color: rgb(var(--lp-text-rgb));");
    expect(LANDING).toContain(".auth-close:hover { background: rgba(var(--lp-accent-rgb),0.22); color: rgb(var(--lp-text-rgb));");
    for (const s of [".auth-forgot, .auth-link", ".auth-switch a"]) expect(rule(s), s).toContain("color: var(--auth-link, var(--lp-light1));");
  });

  // DEC-2026-11-07-41 (Kev, 2026-11-07: "that still looks like the old UI ... it must fit to our UI/UX colortones"): the
  // reset steps take the popup's own look inside it (components/EnkiCardPage.tsx LANDING), so the popup is never painted over.
  it("keeps its own panel around the reset flow, in every theme", () => {
    const css = LANDING.slice(LANDING.indexOf("/* ══ AUTH MODAL ══ */"), LANDING.indexOf("/* ══ PROFILE PAGE ══ */"));
    const strip = (s: string) => s.replace(/\/\*[^]*?\*\//g, "");
    const panels = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .map((m) => [strip(m[1]).trim(), strip(m[2])])
      .filter(([selector, body]) => /\.auth-modal\b(?!::)/.test(selector) && /(^|;)\s*background:/.test(body))
      .map(([selector, body]) => `${selector}: ${body.match(/(?:^|;)\s*background:\s*([^;]+)/)![1].trim()}`);
    expect(panels).toEqual([".auth-modal: #0E0E12", "html.lp-light .auth-modal: #fff"]);
    expect(LANDING).not.toContain(".auth-resetting");
    expect(LANDING).toContain('<iframe src="/reset-password?embed=1" style="width:calc(100% + 40px);height:520px;margin:0 -20px;border:0;background:transparent" allowtransparency="true"></iframe>');
    expect(LANDING).toMatch(/function showResetFrame\(\) \{[^]*?modal\.classList\.add\('auth-resetting'\);[^]*?\n\}/);
    expect(LANDING).toMatch(/function hideResetFrame\(\) \{[^]*?wrap\.remove\(\);\n {2}modal\.classList\.remove\('auth-resetting'\);/);
  });
});

// DEC-486 (Kev, 2026-10-28): the app's logos are the wordmark too, its black turned white where the ground is dark (DEC-490).
describe("the app's logos", () => {
  const ROOT = join(__dirname, "..", "..");
  const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
  const PLACES = ["components/enki-shell/EnkiSidebar.tsx", "components/enki-shell/EnkiHome.tsx", "components/image-view/IvHeader.tsx", "app/auth/complete/page.tsx"];

  it("are the wordmark in the sidebar, the phone header, both image view headers and after a provider login", () => {
    const uses = PLACES.map((p) => read(p).split('src="/enki-wordmark.svg"').length - 1);
    expect(uses).toEqual([1, 1, 2, 1]);
    for (const p of PLACES) expect(read(p), p).not.toContain("enki-art-logo.png");
  });

  it("turn their black white on the dark themes, with no plate and no tint (DEC-490)", () => {
    const css = read("components/enki-shell/enki-shell.css");
    expect(css).toContain('\n.dark img[src="/enki-wordmark.svg"] { filter: url(#enki-wordmark-on-dark); }\n');
    expect(css).not.toContain("hue-rotate");
  });

  it("after a provider login sit on a card of the app's own, in its colour mode, with its Create button's colours (DEC-490)", () => {
    const page = read("app/auth/complete/page.tsx");
    expect(page).toContain('import "@/components/enki-shell/enki-shell.css";');
    expect(page).toContain('<main className="ek-app" style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 16, background: "var(--enki-paper-2)", color: "var(--enki-ink)" }}>');
    // The windows' card and button (enki-window.ts CARD, CTA; DEC-2026-11-08-13): the paper, the rule, the Create button's colours.
    expect(page).toContain('<div style={{ ...CARD, width: "100%", maxWidth: 380,');
    expect(page).toContain('style={{ ...CTA, display: "flex",');
    expect([CARD.background, CARD.borderColor, CTA.background, CTA.color]).toEqual(["var(--enki-paper)", "var(--enki-rule)", "var(--cta-bg)", "var(--cta-ink)"]);
    expect(page).not.toMatch(/#b4602c|#e2a14a|#f6dcb0|#0a0e13|#15120f|244,239,232|background: "#fff"/i);
  });
});

// DEC-490 (Kev, 2026-10-28: "why is there this white background, this should be transparent instead"): one filter
// turns the wordmark's black white on dark ground and keeps his bordeaux exact; the app and the landing define it.
describe("the wordmark's filter for dark ground", () => {
  const ROOT = join(__dirname, "..", "..");
  const LAYOUT = readFileSync(join(ROOT, "app", "layout.tsx"), "utf8");
  const values = (src: string, tag: RegExp) => { const m = src.match(tag); return m ? m[1].trim().split(/\s+/).map(Number) : []; };
  const M = values(LAYOUT, /<filter id="enki-wordmark-on-dark" colorInterpolationFilters="sRGB">\s*<feColorMatrix values="([^"]+)"/);
  const apply = (rgb: number[]) => [0, 1, 2].map((row) => {
    const v = M[row * 5] * rgb[0] / 255 + M[row * 5 + 1] * rgb[1] / 255 + M[row * 5 + 2] * rgb[2] / 255 + M[row * 5 + 3] + M[row * 5 + 4];
    return Math.round(255 * Math.min(1, Math.max(0, v)));
  });

  it("is the same in the app and on the landing, worked in sRGB", () => {
    expect(M).toHaveLength(20);
    expect(values(LANDING, /<filter id="enki-wordmark-on-dark" color-interpolation-filters="sRGB"><feColorMatrix values="([^"]+)"/)).toEqual(M);
  });

  it("sends black to white, keeps #8A0312 and leaves the alpha alone", () => {
    expect(apply([0, 0, 0])).toEqual([255, 255, 255]);
    expect(apply([138, 3, 18])).toEqual([138, 3, 18]);
    expect(M.slice(15)).toEqual([0, 0, 0, 1, 0]);
  });

  it("meets a wordmark of only those two colours", () => {
    expect(new Set(WORDMARK.match(/fill="[^"]*"/g))).toEqual(new Set(['fill="#8A0312"', 'fill="#000"']));
  });
});

// DEC-488 (Kev, 2026-10-28): the browser icon and the rail's mark are his symbol, the woman in the hexagon.
describe("the browser icon", () => {
  const ROOT = join(__dirname, "..", "..");
  const SYMBOL = readFileSync(join(ROOT, "public", "favicon.svg"), "utf8");
  const pngSize = (path: string) => { const b = readFileSync(join(ROOT, path)); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };

  it("is Kev's symbol, squared around it, with nothing but shapes", () => {
    expect(SYMBOL).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="77\.1 72\.2 870\.1 870\.1" role="img" aria-label="Enki">/);
    expect(SYMBOL.match(/<(path|circle)\b/g)).toHaveLength(36);
    expect(SYMBOL).not.toMatch(/<(svg)\b[^]*<svg\b|<!--|<(script|image|foreignObject|use|style|rect)\b|href|\son[a-z]+=|url\(/i);
  });

  it("is the same in every link the pages send, the rail and the gate", () => {
    expect(readFileSync(join(ROOT, "app", "icon.svg"), "utf8")).toBe(SYMBOL);
    expect([pngSize("app/icon.png"), pngSize("public/favicon.png"), pngSize("public/favicon-64.png")]).toEqual([[256, 256], [256, 256], [64, 64]]);
    expect(readFileSync(join(ROOT, "app", "icon.png"))).toEqual(readFileSync(join(ROOT, "public", "favicon.png")));
    expect(readFileSync(join(ROOT, "components/enki-shell/EnkiSidebar.tsx"), "utf8")).toContain('<img className="ek-logo-mark-img" src="/favicon.svg" alt="Enki Art" />');
  });

  it("is drawn in Kev's red in the PNGs, where the old E was peach (207, 147, 122)", async () => {
    const sharp = (await import("sharp")).default;
    for (const p of ["app/icon.png", "public/favicon-64.png"]) {
      const { data } = await sharp(readFileSync(join(ROOT, p))).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      let r = 0, g = 0, b = 0, n = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 200) { r += data[i]; g += data[i + 1]; b += data[i + 2]; n++; }
      expect([r / n, g / n, b / n].map(Math.round), p).toEqual([expect.closeTo(188, -1), expect.closeTo(41, -1), expect.closeTo(42, -1)]);
    }
  });
});

// DEC-491 (Kev, 2026-10-28): "mach das rote als default, also ganz links neben turquoise".
describe("the theme swatches", () => {
  it("put the bordeaux default first, then teal, then purple", () => {
    const row = LANDING.slice(LANDING.indexOf('<div class="theme-swatches"'), LANDING.indexOf("</div>", LANDING.indexOf('<div class="theme-swatches"')));
    expect([...row.matchAll(/data-theme="(\w+)"/g)].map((m) => m[1])).toEqual(["light", "dark", "purple"]);
  });

  it("start a first visit on the bordeaux one, before paint and on the swatch ring", () => {
    expect(LANDING).toContain("try { apply(localStorage.getItem('theme') || 'light'); } catch(e) {}");
    expect(LANDING).toContain("try { t = localStorage.getItem('theme') || 'light'; } catch (e) {}");
  });
});
