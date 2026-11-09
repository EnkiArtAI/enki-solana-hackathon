import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";
import { holdShown, linkedPrompt, promptLink, promptPage, showing } from "../open-link";

/**
 * A reload on an open Image View stays on the image (Kev, 2026-10-13: "wenn
 * ich aktualisieren klicke … will ich weiterhin auf dem Image bleiben und
 * nicht erneut in Home reinkommen"): the open prompt is in the address.
 */

const ID = "db1ba7e7-a803-4e7f-8934-93f2180db816";

describe("promptLink", () => {
  it("adds the open prompt to the address and keeps everything else of it", () => {
    expect(promptLink("http://enki.test/home", ID)).toBe(`/home?prompt=${ID}`);
    expect(promptLink("http://enki.test/home?q=cat&creator=kev#top", ID)).toBe(`/home?q=cat&creator=kev&prompt=${ID}#top`);
  });

  it("replaces another prompt, and takes it away on close", () => {
    const other = "11111111-1111-4111-8111-111111111111";
    expect(promptLink(`http://enki.test/home?prompt=${other}&q=cat`, ID)).toBe(`/home?prompt=${ID}&q=cat`);
    expect(promptLink(`http://enki.test/home?prompt=${ID}&q=cat`, null)).toBe("/home?q=cat");
    expect(promptLink(`http://enki.test/home?prompt=${ID}`, null)).toBe("/home");
  });
});

describe("promptPage", () => {
  it("is the feed with the prompt's view over it, which linkedPrompt reads back", () => {
    expect(promptPage(ID)).toBe(`/home?prompt=${ID}`);
    expect(linkedPrompt(promptPage(ID).slice("/home".length))).toBe(ID);
  });
});

describe("linkedPrompt", () => {
  it("reads the prompt an address asks to open", () => {
    expect(linkedPrompt(`?q=cat&prompt=${ID}`)).toBe(ID);
    expect(linkedPrompt(new URLSearchParams({ prompt: ID.toUpperCase() }))).toBe(ID.toUpperCase());
  });

  it("opens nothing for an address without one, or with anything that is not an id", () => {
    expect(linkedPrompt("?q=cat")).toBeNull();
    expect(linkedPrompt("?prompt=")).toBeNull();
    expect(linkedPrompt("?prompt=../../api/admin")).toBeNull();
    expect(linkedPrompt(`?prompt=${ID}x`)).toBeNull();
  });
});

// DEC-465 (review wf_cb05c8c6-2aa): with the feed's copy gone (DEC-461), a view opened in a panel at 768-1023 px sat
// in the panel's layer, under the shell's 10 px strip; Home's own view covers it at z 167.
describe("a view opened in a panel, 768-1023 px", () => {
  it("raises its panel to the view's layer while it shows, and only then", () => {
    const css = readSource(join(__dirname, "..", "..", "..", "..", "components", "image-view", "image-view-frame.css"));
    expect(css).toMatch(/@media \(min-width: 768px\) and \(max-width: 1023\.98px\) \{\n  \.iv-frame \{ left: 0; z-index: 167; \}\n\s*\.ek-panel-scrim:has\(\.iv-frame:not\(\.is-hidden\)\) \{ z-index: 167; \}\n\}/);
  });
});

describe("showing (DEC-461)", () => {
  it("is true while at least one view holds the prompt, each release once", () => {
    const other = "11111111-2222-4333-8444-555555555555";
    expect(showing(ID)).toBe(false);
    const a = holdShown(ID);
    const b = holdShown(ID);
    expect([showing(ID), showing(other)]).toEqual([true, false]);
    a();
    expect(showing(ID)).toBe(true);
    b();
    expect(showing(ID)).toBe(false);
  });
});

describe("the wiring", () => {
  const src = (...p: string[]) => readSource(join(__dirname, "..", "..", "..", "..", "components", ...p));

  it("the view puts its prompt into the address: one history entry when the address named none, in place otherwise, and takes it out on close; never for the blank composer", () => {
    const panel = src("enki", "EnkiDetailPanel.tsx");
    expect(panel).toContain('if (id === "blank") return;');
    expect(panel).toContain('const entry = linkedPrompt(search) === null && !owned.current ? "pushState" : "replaceState";');
    // With the shell panel's way back (backState; lib/__tests__/shell-menu.test.ts, Back past an image on a profile).
    expect(panel).toContain('window.history[entry](backState(entry === "pushState", window.history.state), "", promptLink(href, id));');
    expect(panel).toContain('if (entry === "pushState") owned.current = true;');
    expect(panel).toMatch(/return \(\) => \{\n\s+release\(\);\n\s+window\.history\.replaceState\(backState\(false, window\.history\.state\), "", promptLink\(window\.location\.href, null\)\);\n\s+\};/);
  });

  // DEC-461: a view opened over a panel wrote its prompt here, and the feed under the panel opened a copy of it.
  it("the view counts itself as showing its prompt before the address names it", () => {
    const panel = src("enki", "EnkiDetailPanel.tsx");
    const at = panel.indexOf("const release = holdShown(id);");
    expect(at).toBeGreaterThan(panel.indexOf('if (id === "blank") return;'));
    expect(at).toBeLessThan(panel.indexOf("window.history[entry]("));
  });

  it("the feed opens no copy of a prompt a view already shows", () => {
    expect(src("enki", "EnkiFeedPage.tsx")).toContain("if (id) { if (!showing(id)) { setLinked(id); if (open && open.id !== id) setOpen(null); } }");
  });

  it("the feed closes the view when the address loses its prompt (the browser's Back)", () => {
    const feed = src("enki", "EnkiFeedPage.tsx");
    expect(feed).toContain("if (id) { if (!showing(id)) { setLinked(id); if (open && open.id !== id) setOpen(null); } }");
    expect(feed).toContain("else if (open || linked) { setOpen(null); setLinked(null); }");
  });

  it("the feed opens the linked prompt on arrival and whenever the shell pushes one, and forgets it on close", () => {
    const feed = src("enki", "EnkiFeedPage.tsx");
    expect(feed).toContain("const [linked, setLinked] = useState<string | null>(() => linkedPrompt(searchParams));");
    // Adjusted during render as the address changes (no effect: react-hooks/set-state-in-effect is a CI gate).
    expect(feed).toContain("const [seenParams, setSeenParams] = useState(searchParams);");
    expect(feed).toContain("if (searchParams !== seenParams) {");
    expect(feed).toContain("setSeenParams(searchParams);");
    expect(feed).toContain("const id = linkedPrompt(searchParams);");
    expect(feed).toContain("if (id) { if (!showing(id)) { setLinked(id); if (open && open.id !== id) setOpen(null); } }");
    expect(feed).toContain("const seed = open ? seedFromFeedCard(open) : linked ? { promptId: linked } : null;");
    expect(feed).toMatch(/setOpen\(null\);\n\s+setLinked\(null\);/);
    expect(feed).toMatch(/\{seed && \(\n\s+<EnkiDetailPanel seed=\{seed\} onClose=\{closeCard\} \/>/);
  });
});
