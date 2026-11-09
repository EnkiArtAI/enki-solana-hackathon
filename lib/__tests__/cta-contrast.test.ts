import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Kev, 2026-11-04: every button's label reads, "with the other color themes ofc". The tokens as the stylesheets declare them,
 * in light, dark and purple, at the page, inside the shell and inside the feed (.ek-app and .enki redeclare a part of them), and every rule that fills a
 * button with an accent token and names its ink. Blind spots: a rule that names no colour (a dot, a bar, or a label whose ink
 * sits on another rule) is not read here; a fill drawn over glass or a picture is not.
 *
 * Kev, 2026-11-05: "we gotta keep the precise tones". A tone never moves for a label; a label moves to another tone of the theme.
 * Where the pair is the tone itself, white on purple's violets, the tone wins and the number is named (VIOLETS, 3.49 to 4.23).
 */
const ROOT = join(__dirname, "..", "..");
const read = (file: string) => readFileSync(join(ROOT, file), "utf8").replace(/\r\n/g, "\n").replace(/\/\*[\s\S]*?\*\//g, "");

const declared = (css: string, selector: string) => {
  const out: Record<string, string> = {};
  const blocks = css.matchAll(new RegExp(`(?:^|\\n)${selector.replace(/\./g, "\\.")}\\s*\\{([\\s\\S]*?)\\n\\}`, "g"));
  for (const block of blocks) for (const m of block[1].matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
};

const GLOBALS = read("app/globals.css"), SHELL = read("components/enki-shell/enki-shell.css"), SHARE = read("components/share/share.css"), FEED = read("components/enki/enki.css");
const light = declared(GLOBALS, ":root"), dark = { ...light, ...declared(GLOBALS, ".dark") }, purple = { ...dark, ...declared(GLOBALS, ".dark.theme-purple") };
const THEMES = {
  "light": light,
  "dark": dark,
  "purple": purple,
  "light in the shell": { ...light, ...declared(SHELL, ".ek-app") },
  "dark in the shell": { ...dark, ...declared(SHELL, ".dark .ek-app") },
  "purple in the shell": { ...purple, ...declared(SHELL, ".dark.theme-purple .ek-app") },
  "dark in the feed": { ...dark, ...declared(FEED, ".dark .enki") },
  "purple in the feed": { ...purple, ...declared(FEED, ".dark.theme-purple .enki") },
};
type Tokens = Record<string, string>;

type Rgb = number[];
const hex = (h: string): Rgb => {
  const raw = h.slice(1), long = raw.length === 3 ? [...raw].map((c) => c + c).join("") : raw;
  return [0, 2, 4].map((i) => parseInt(long.slice(i, i + 2), 16));
};
const hsl = (value: string): Rgb => {
  const [h, s, l] = value.replace(/%/g, "").split(/\s+/).map(Number);
  const f = (n: number) => {
    const k = (n + h / 30) % 12, a = (s / 100) * Math.min(l / 100, 1 - l / 100);
    return Math.round(255 * (l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
};
/** Every colour a value paints: one, or a gradient's ends. */
function colours(value: string, t: Tokens): Rgb[] {
  const v = value.trim();
  const named = v.match(/^var\((--[a-z0-9-]+)\)$/);
  if (named) {
    if (!t[named[1]]) throw new Error(`${named[1]} has no value`);
    return colours(t[named[1]], t);
  }
  const mix = v.match(/^color-mix\(in srgb, (.+) (\d+)%, (.+)\)$/);
  if (mix) {
    const [a, b, p] = [colours(mix[1], t)[0], colours(mix[3], t)[0], Number(mix[2]) / 100];
    return [a.map((c, i) => Math.round(c * p + b[i] * (1 - p)))];
  }
  if (v.startsWith("linear-gradient")) return (v.match(/#[0-9a-fA-F]{3,6}/g) ?? []).map(hex);
  if (v.startsWith("#")) return [hex(v)];
  throw new Error(`cannot read the colour ${v}`);
}
const luminance = (rgb: Rgb) => {
  const [r, g, b] = rgb.map((c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: Rgb, b: Rgb) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const AA = 4.5;
/** Purple's fills under its white labels: exact tones, so they are named instead of lifted. Nothing else may read under 4.5. */
const VIOLETS = /^var\(--(enki-ember|enki-accent-hover|cta-solid|cta-bg|cta-hover|qc-bg|primary|sidebar-primary|accent)\)$/;
const least = (theme: string, fill: string) => (theme.startsWith("purple") && VIOLETS.test(fill) ? 3.4 : AA);
const QUIET = /btn|button|pill|chip|\btab|link|copy|logoff|boost|action|toggle|more|back|close|clear|cancel|-item|-opt|select|add|-new|edit|remove|write|plus|swatch|knob/i;

const filesEnding = (ending: string) => function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(ROOT, dir))) {
    const path = `${dir}/${name}`;
    if (statSync(join(ROOT, path)).isDirectory()) walk(path, out);
    else if (name.endsWith(ending)) out.push(path);
  }
  return out;
};
const cssFiles = filesEnding(".css");
const FILLS = /^var\(--(enki-ember|enki-accent-hover|cta-solid|cta-bg|cta-hover|qc-bg|enki-danger|enki-green|enki-turq)\)$/;
/** Each rule that fills with an accent token and names its ink. */
const filled = [...cssFiles("app"), ...cssFiles("components")].flatMap((file) =>
  [...read(file).matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap((m) => {
    const fill = m[2].match(/(?:^|[;\s])background(?:-color)?:\s*([^;]+)/)?.[1].trim(), ink = m[2].match(/(?:^|[;\s])color:\s*([^;]+)/)?.[1].trim();
    return fill && ink && FILLS.test(fill) ? [{ where: `${file}: ${m[1].trim()}`, selectors: m[1].split(",").map((s) => s.trim()), fill, ink }] : [];
  }),
);

/** Each such rule's hover that only brightens or darkens it: the fill stays, so the filter moves the pair. */
const hoverFilters = [...cssFiles("app"), ...cssFiles("components")].flatMap((file) =>
  [...read(file).matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap((m) => {
    const k = Number(m[2].match(/filter:\s*brightness\(([\d.]+)\)/)?.[1]);
    if (!k || !m[1].includes(":hover")) return [];
    return m[1].split(",").flatMap((s) => {
      const base = s.replace(/:hover|:not\([^)]*\)/g, "").trim(), rule = filled.find((f) => f.selectors.includes(base));
      return rule ? [{ where: `${file}: ${s.trim()}`, k, fill: rule.fill, ink: rule.ink }] : [];
    });
  }),
);

/** Each rule that tints with the accent and whose text is the accent, its own or its base rule's: 16% of the accent over transparent is that alpha over the paper. */
const rules = [...cssFiles("app"), ...cssFiles("components")].flatMap((file) => [...read(file).matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ file, selector: m[1].trim(), body: m[2] })));
const EMBER_TEXT = /(?:^|[;\s])color:\s*var\(--enki-ember/;
const tinted = rules.flatMap(({ file, selector, body }) => {
  const percent = body.match(/background(?:-color)?:\s*color-mix\(in oklab, var\(--enki-ember[^)]*\) (\d+)%, transparent\)/)?.[1];
  if (!percent) return [];
  const base = selector.replace(/:hover/g, "");
  return EMBER_TEXT.test(body) || rules.some((r) => r.selector === base && EMBER_TEXT.test(r.body)) ? [{ where: `${file}: ${selector}`, base, alpha: Number(percent) / 100 }] : [];
});

/** Purple's labels that leave the accent for the theme's ink, read from the stylesheet. */
const PURPLE_LABELS = [...GLOBALS.matchAll(/([^{}]+)\{\s*color: var\(--enki-ink\); \}/g)].flatMap((m) => m[1].split(",").map((s) => s.trim())).filter((s) => s.startsWith(".dark.theme-purple ")).map((s) => s.slice(".dark.theme-purple ".length));

describe.each(Object.entries(THEMES))("the buttons' labels in %s", (theme, t: Tokens) => {
  const isPurple = theme.startsWith("purple");
  it.each(isPurple ? ["--enki-paper"] : ["--enki-paper", "--enki-paper-2", "--enki-paper-3", "--enki-accent-soft", "--enki-accent-soft-hover", "--enki-fill", "--enki-fill-hover"])("the accent as text reads on %s", (under) => {
    expect(ratio(colours("var(--enki-ember)", t)[0], colours(`var(${under})`, t)[0])).toBeGreaterThanOrEqual(AA);
  });

  it.each(["--enki-paper", "--enki-paper-2", "--enki-paper-3"])("the quiet buttons' label, --enki-label-quiet, reads on %s", (paper) => {
    expect(ratio(colours("var(--enki-label-quiet)", t)[0], colours(`var(${paper})`, t)[0])).toBeGreaterThanOrEqual(AA);
  });

  it("the accent as text reads on its own tints, hovers included", () => {
    const [ember, paper] = [colours("var(--enki-ember)", t)[0], colours("var(--enki-paper)", t)[0]];
    const ink = colours("var(--enki-ink)", t)[0];
    const low = tinted.flatMap(({ where, base, alpha }) => {
      const moved = isPurple && PURPLE_LABELS.includes(base);
      const r = ratio(moved ? ink : ember, ember.map((c, i) => Math.round(c * alpha + paper[i] * (1 - alpha))));
      return r < AA ? [`${where}: ${r.toFixed(2)}`] : [];
    });
    expect(low).toEqual([]);
  });

  const pairs: [string, string][] = [["--cta-solid", "--cta-ink"], ["--cta-bg", "--cta-ink"], ["--cta-hover", "--cta-ink"], ["--qc-bg", "--qc-ink"]];
  it.each(pairs)("%s under %s reaches 4.5:1, a gradient at both ends", (fill, ink) => {
    const under = colours(`var(${fill})`, t), over = colours(`var(${ink})`, t)[0];
    expect(under.length).toBeGreaterThan(0);
    for (const c of under) expect(ratio(c, over)).toBeGreaterThanOrEqual(least(theme, `var(${fill})`));
  });

  it("the Create and primary buttons' 5% brighter hover keeps it", () => {
    for (const c of colours("var(--cta-bg)", t)) {
      expect(ratio(c.map((v) => Math.min(255, v * 1.05)), colours("var(--cta-ink)", t)[0])).toBeGreaterThanOrEqual(least(theme, "var(--cta-bg)"));
    }
  });

  it.each(["--enki-paper", "--enki-paper-2", "--enki-paper-3"])("the accent's text reads on %s", (paper) => {
    expect(ratio(colours("var(--enki-accent-ink)", t)[0], colours(`var(${paper})`, t)[0])).toBeGreaterThanOrEqual(AA);
  });

  it.each([["--primary", "--primary-foreground"], ["--sidebar-primary", "--sidebar-primary-foreground"], ["--accent", "--accent-foreground"]])("the kit's button, %s under %s", (fill, ink) => {
    expect(ratio(hsl(t[fill]), hsl(t[ink]))).toBeGreaterThanOrEqual(least(theme, `var(${fill})`));
  });

  it("a hover's brightness filter on such a rule keeps it", () => {
    const low = hoverFilters.flatMap(({ where, k, fill, ink }) => colours(fill, t).flatMap((c) => {
      const r = ratio(c.map((v) => Math.min(255, v * k)), colours(ink, t)[0]);
      return r < least(theme, fill) ? [`${where}: x${k} = ${r.toFixed(2)}`] : [];
    }));
    expect(low).toEqual([]);
  });

  it("the Delete button's hover names its own fill: without it .kit-confirm-btn:hover paints a 6% ink mix under its label", () => {
    const hover = read("components/kit/kit-dialog.css").match(/\.kit-confirm-btn--danger:hover \{([^}]*)\}/)?.[1] ?? "";
    const fill = hover.match(/background:\s*([^;]+)/)?.[1].trim() ?? "";
    expect(ratio(colours(fill, t)[0], colours("var(--cta-ink)", t)[0])).toBeGreaterThanOrEqual(least(theme, fill));
    expect(hover).toContain("filter: none");
  });

  it("every rule that fills with an accent and names its ink reads", () => {
    const low = filled.flatMap(({ where, fill, ink }) => colours(fill, t).flatMap((c) => {
      const r = ratio(c, colours(ink, t)[0]);
      return r < least(theme, fill) ? [`${where}: ${fill} under ${ink} = ${r.toFixed(2)}`] : [];
    }));
    expect(low).toEqual([]);
  });
});

/** Kev, 2026-11-05. Every copy of a token, in the three files that declare one. */
describe("the tones are Kev's", () => {
  const EXACT: [string, Tokens, Tokens][] = [
    ["light", light, { "--enki-ember": "#7d1d33", "--enki-ink-3": "#6b6a67", "--enki-danger": "#b3271e", "--cta-bg": "#7d1d33", "--qc-bg": "#7d1d33" }],
    ["dark", dark, { "--enki-ember": "#cba24a", "--enki-ink-3": "#6a8493", "--enki-danger": "#e0584f", "--cta-solid": "#cba24a", "--cta-hover": "#d8b362", "--qc-bg": "#f0a868" }],
    ["purple", purple, { "--enki-ember": "#a855f7", "--enki-ink-3": "#7d7295", "--enki-danger": "#e0584f", "--cta-solid": "#a855f7", "--cta-hover": "#9d6ef8", "--cta-bg": "linear-gradient(135deg, #8b5cf6 0%, #6d28d9 100%)", "--qc-bg": "#8b5cf6", "--primary": "271 85% 66%", "--sidebar-primary": "271 85% 66%", "--accent": "271 85% 66%" }],
    ["dark in the shell", THEMES["dark in the shell"], { "--enki-ember": "#cba24a", "--enki-ink-3": "#6a8493", "--qc-bg": "#f0a868" }],
    ["purple in the shell", THEMES["purple in the shell"], { "--enki-ember": "#a855f7", "--enki-ink-3": "#7d7295", "--qc-bg": "#8b5cf6", "--cta-bg": "linear-gradient(135deg, #8b5cf6 0%, #6d28d9 100%)" }],
    ["dark in the feed", THEMES["dark in the feed"], { "--enki-ember": "#cba24a", "--enki-ink-3": "#6a8493" }],
    ["purple in the feed", THEMES["purple in the feed"], { "--enki-ember": "#a855f7", "--enki-ink-3": "#7d7295" }],
  ];
  it.each(EXACT)("%s", (_name, tokens, want) => {
    for (const [name, value] of Object.entries(want)) expect([name, tokens[name]]).toEqual([name, value]);
  });

  it("a label on purple's accent tint moved to the theme's ink, and its tint stays the accent", () => {
    for (const label of [".ek-balance", ".feed-pill.on", ".feed-gen-chip.on", ".enki-boost--on", ".kit-tok--var", ".mobile-modal-pill", ".kit-gen-chip", ".iv-review-plus", ".iv-rv-write", '.iv-pact[data-on="saved"]']) expect(PURPLE_LABELS).toContain(label);
  });

  it("a control that names --enki-ink-3 reads --enki-label-quiet, and what stays is a caption by name", () => {
    const CAPTIONS = [".pe-undo button[aria-disabled=\"true\"]", ".cm-closest-text small", ".cm-merge-table th", ".vg-model-line", ".ci-menu-note", ".feed-suggest-item small", ".iv-agent-toggle > svg", ".iv-mode-label", ".kit-menu-head", ".set-item-icon", ".set-item-sub", ".set-table th", ".st-item-text"];
    const block = GLOBALS.match(/:is\(([^{}]*)\) \{ --enki-ink-3: var\(--enki-label-quiet\); \}/)?.[1] ?? "";
    const listed = block.split(",").map((s) => s.trim());
    expect(listed.length).toBeGreaterThanOrEqual(30);
    const missing = rules.filter((r) => /(?:^|[;\s])color:\s*var\(--enki-ink-3/.test(r.body) && QUIET.test(r.selector)).flatMap((r) => r.selector.split(",").map((s) => s.trim().replace(/\s+/g, " ")))
      .filter((s) => QUIET.test(s) && !listed.includes(s) && !CAPTIONS.includes(s));
    expect(missing).toEqual([]);
  });
});

describe("the labels the last round named and left", () => {
  const STUDIO = read("components/studio/studio.css"), EDITOR = read("components/prompt-editor/prompt-editor.css"), MODAL = read("app/editor/mobile-modal.css"), VIEW = read("components/image-view/image-view.css"), SET = read("components/settings/settings.css");
  it.each(Object.entries(THEMES))("the send button's glyph on its muted fill, in %s", (_theme, t: Tokens) => {
    const [a, b] = [colours("var(--enki-ink-3)", t)[0], colours("var(--enki-paper-2)", t)[0]];
    expect(ratio(colours("var(--enki-ink)", t)[0], a.map((c, i) => Math.round(c * 0.55 + b[i] * 0.45)))).toBeGreaterThanOrEqual(AA);
  });
  it("the send button's off state names the theme's ink", () => expect(SHELL).toMatch(/\.ek-msg-send \{[^}]*color: var\(--enki-ink\);/));
  it("the mobile modal has no hard-coded warm grey left", () => {
    expect(MODAL).not.toMatch(/#8a7f72/i);
    expect(readFileSync(join(ROOT, "components/EnkiMobileGenerateModal.tsx"), "utf8")).not.toMatch(/#8a7f72/i);
    // 18 since its label takes the one label's quiet tone (DEC-2026-11-08-28).
    expect(MODAL.split("var(--enki-label-quiet)").length - 1).toBe(18);
  });
  it("an inert .st-btn and Undo keep a label, with no opacity", () => {
    expect(STUDIO).toContain(".st-btn:disabled, .st-btn[aria-disabled] { background: var(--enki-paper-3); color: var(--enki-ink-2); cursor: default; }");
    expect(EDITOR).toContain('.pe-undo button[aria-disabled="true"] { color: var(--enki-ink-3); cursor: default; }');
  });
  it("an unlit star is a shape one can see: 3:1 on paper in every theme", () => {
    expect(VIEW).toMatch(/\.iv-star \{[^}]*color: var\(--enki-ink-3\);/);
    expect(VIEW).toMatch(/\.iv-rv-stars \.iv-star \{[^}]*color: var\(--enki-ink-3\);/);
    for (const t of Object.values(THEMES)) expect(ratio(colours("var(--enki-ink-3)", t)[0], colours("var(--enki-paper)", t)[0])).toBeGreaterThanOrEqual(3);
  });
  it("the settings badges read on their tints over paper", () => {
    expect(SET).toMatch(/\.set-badge-good \{[^}]*background: rgba\(31, 138, 91, 0\.1\);\s*color: var\(--enki-green\);/);
    expect(SET).toMatch(/\.set-badge-warn \{[^}]*background: rgba\(201, 154, 56, 0\.18\);\s*color: var\(--enki-ink-2\);/);
    const over = (rgb: Rgb, a: number, t: Tokens) => { const p = colours("var(--enki-paper)", t)[0]; return rgb.map((c, i) => Math.round(c * a + p[i] * (1 - a))); };
    for (const t of Object.values(THEMES)) expect(ratio(colours("var(--enki-green)", t)[0], over([31, 138, 91], 0.1, t))).toBeGreaterThanOrEqual(AA);
    expect(ratio(colours("var(--enki-ink-2)", light)[0], over([201, 154, 56], 0.18, light))).toBeGreaterThanOrEqual(AA);
    expect(ratio(hex("#e3b957"), over([201, 154, 56], 0.18, purple))).toBeGreaterThanOrEqual(AA);
  });
});

/** A control that cannot be pressed, or waits, keeps a label one can read: opacity on the fill took it to 2.05. */
describe("a disabled or busy primary button", () => {
  const INERT = [".ek-btn:disabled", ".iv-send:disabled", ".iv-rv-btn:disabled", ".st-btn--cta:disabled", ".enki-bmp-go:disabled", '.pe-release-btn[aria-disabled="true"]', ".share-fr .tb.dn[aria-disabled=true]", ".share-fr .ds button[aria-busy=true]", ".share-fr .ds button[aria-disabled=true]"];
  it.each(INERT)("%s stands on paper-3 with ink-2, no opacity", (selector) => {
    const rule = rules.find((r) => r.selector.split(",").map((s) => s.trim()).includes(selector));
    expect(rule?.body).toContain("background: var(--enki-paper-3)");
    expect(rule?.body).toContain("color: var(--enki-ink-2)");
    expect(rule?.body).not.toMatch(/opacity: 0|opacity: \./);
  });
  it("Generate that cannot go yet stays a shade darker (Kev, 2026-10-14), and its label reads", () => {
    expect(read("components/kit/kit-controls.css")).toContain(".dark .kit-gen[aria-disabled=\"true\"] { color: #fff; }");
    for (const [name, t] of Object.entries(THEMES)) {
      const ink = name.startsWith("light") ? colours("var(--cta-ink)", t)[0] : [255, 255, 255];
      for (const c of colours("var(--cta-bg)", t)) expect(ratio(c.map((v) => v * 0.7), ink)).toBeGreaterThanOrEqual(AA);
    }
  });

  it.each(Object.entries(THEMES))("that pair reaches 4.5:1 in %s", (_theme, t: Tokens) => {
    expect(ratio(colours("var(--enki-ink-2)", t)[0], colours("var(--enki-paper-3)", t)[0])).toBeGreaterThanOrEqual(AA);
  });
});

describe("inline styles", () => {
  it("no style object in a .tsx paints a white label on an accent fill", () => {
    const tsx = filesEnding(".tsx");
    const low = [...tsx("app"), ...tsx("components")].flatMap((file) => {
      const lines = readFileSync(join(ROOT, file), "utf8").split("\n");
      return lines.flatMap((line, i) => {
        if (!/background[^,]*var\(--(enki-ember|cta-)/.test(line)) return [];
        const near = lines.slice(Math.max(0, i - 3), i + 5).join(" ").match(/\bcolor:\s*[^,}]*/g) ?? [];
        return near.some((c) => /#fff|white/i.test(c)) ? [`${file}:${i + 1}`] : [];
      });
    });
    expect(low).toEqual([]);
  });
});

describe("what the scan stands on", () => {
  it("holds the rules a person would name, so an empty scan cannot pass", () => {
    const seen = filled.map((f) => f.where).join("\n");
    expect(filled.length).toBeGreaterThanOrEqual(30);
    expect(hoverFilters.map((h) => h.where).join(" ")).toContain(".ek-btn:hover");
    expect(tinted.map((h) => h.where).join(" ")).toContain(".ek-balance:hover");
    for (const rule of [".share-fr .ac .pr", ".share-fr .ds button.on", ".share-fr .tb.dn", ".share-fr .rd.on", ".ek-btn", ".kit-confirm-btn--danger", ".ek-msg-send.on", ".kit-gen[data-short]", ".ci-copy", ".ts.hot", ".set-btn-danger", ".iv-yours", ".kit-tile-check", ".pe-release-btn[data-released]"]) expect(seen).toContain(rule);
  });

  it("the settings save bar turns over with the theme: white on --enki-ink read 1.19 in dark", () => {
    const SETTINGS = read("components/settings/settings.css");
    expect(SETTINGS).toMatch(/\.set-save-floater \{[^}]*background: var\(--enki-ink\);\s*color: var\(--enki-paper\);/);
    expect(SETTINGS).toMatch(/\.set-save-floater button \{\s*background: var\(--enki-paper\);\s*color: var\(--enki-ink\);/);
  });

  it("the rotate knob's glyph stands on the stage's colour, not the accent, on its white", () => {
    expect(SHARE).toMatch(/\.share-fr \.rk \{[^}]*background: var\(--enki-on-stage\); color: var\(--enki-stage\);/);
  });

  it("the accent's own token can read on dark paper because the filled labels no longer stand on it", () => {
    expect(SHARE).toMatch(/\.share-fr \.ac \.pr \{ background: var\(--cta-solid\); color: var\(--cta-ink\); \}/);
    expect(SHARE).toMatch(/\.share-fr \.ds button\.on \{ background: var\(--cta-solid\); color: var\(--cta-ink\); \}/);
    expect(SHARE).toMatch(/\.share-fr \.tb\.dn \{ background: var\(--cta-solid\); color: var\(--cta-ink\); \}/);
    expect(SHARE).toMatch(/\.share-fr \.rd\.on \{ background: var\(--cta-solid\); color: var\(--cta-ink\); \}/);
  });

  it("Share's desktop hover goes to --cta-hover: brightness(1.15) would take white under 4.5 on the purple", () => {
    expect(ratio(colours("var(--cta-solid)", purple)[0].map((v) => Math.min(255, v * 1.15)), colours("var(--cta-ink)", purple)[0])).toBeLessThan(AA);
    expect(SHARE).toContain(".share-fr.desk .ds button.on:hover, .share-fr.desk .ac .pr:hover { filter: none; background: var(--cta-hover); }");
  });
});
