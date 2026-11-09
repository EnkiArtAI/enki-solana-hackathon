import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { readSource } from "./_read-source";
import PanelHead from "@/components/enki-shell/PanelHead";

/**
 * DEC-499 (Kev, 2026-10-29: "hall of fame, analytics, notifications, messages and settings they all have different
 * fonts and different layouts ... make it unified fitting my style"): every panel page opens in one 880 px frame with
 * one headline, the Hall of Fame's italic serif with a full stop. Messages keeps it at the left of its list.
 */

const src = (...p: string[]) => readSource(join(__dirname, "..", "..", ...p));
function* walk(node: ReactNode): Generator<ReactElement<Record<string, unknown>>> {
  if (Array.isArray(node)) for (const n of node) yield* walk(n);
  else if (isValidElement<Record<string, unknown>>(node)) { yield node; yield* walk(node.props.children as ReactNode); }
}
const classes = (tree: ReactNode) => [...walk(tree)].map((el) => `${String(el.type)}.${el.props.className ?? ""}`);

describe("the panels' headline", () => {
  it("is one title, the line under it (even an empty one, which holds Settings' tab menu still) and the page's controls", () => {
    const tools = createElement("button", null, "This week");
    expect(classes(PanelHead({ title: "Analytics.", sub: "How your prompts earn.", children: tools }))).toEqual(
      ["div.ek-page-head", "div.", "h1.ek-page-title", "p.ek-page-sub", "button."]);
    expect(classes(PanelHead({ title: "Profile.", sub: "" }))).toContain("p.ek-page-sub");
    expect(classes(PanelHead({ title: "Bookmarks." }))).not.toContain("p.ek-page-sub");
  });

  it("opens Hall of Fame, Analytics, Notifications, Settings and the other panels, each in the same frame", () => {
    const hof = src("app", "leaderboard", "page.tsx");
    expect(hof).toMatch(/<div className="ek-page">\n\s+\{\}\n\s+<PanelHead title="Hall of Fame\." sub=\{isGens/);
    const analytics = src("components", "enki-shell", "AnalyticsPanel.tsx");
    expect(analytics).toMatch(/<div className="ek-page">\n\s+<PanelHead title="Analytics\." sub=\{view === "enki" \? "Everything happening on Enki\." : "How your prompts earn, print, and convert\."\}>/);
    const home = src("components", "enki-shell", "EnkiHome.tsx");
    expect(home).toMatch(/<div className="ek-page">\n\s+<PanelHead title="Notifications\." sub=/);
    expect(home).toMatch(/<div className="ek-page">\n\s+<PanelHead title=\{`\$\{PANEL_TITLES\[key\] \|\| key\}\.`\} \/>/);
    expect(src("components", "settings", "SettingsLayout.tsx")).toMatch(/<div className="set-container ek-page">\n\s+<PanelHead title=\{title\} sub=\{description \?\? ""\} \/>/);
    // No panel styles its own headline or period pills any more.
    for (const f of [hof, analytics]) expect(f).not.toContain("<h1 style=");
    for (const f of [hof, analytics]) expect(f).toContain('className={"ek-page-pill" + (period === p.key ? " on" : "")}');
  });

  it("ends every title with a full stop, Settings' tabs too", () => {
    const view = src("components", "settings", "SettingsView.tsx");
    expect(view).toContain('profile: "Profile.",\n    payment: "Payment.",\n    recovery: <>Recovery <span>&</span> 2FA.</>,');
    expect(view).toContain('title={titleMap[activeTab] || "Settings."}');
  });

  it("gives Messages the same type, as high as the others, at the left of its list", () => {
    expect(src("components", "enki-shell", "MessagesPanel.tsx")).toContain('<div className="ek-msg-side-head">\n          <h1 className="ek-page-title ek-msg-title">Messages.</h1>');
    const css = src("components", "enki-shell", "enki-shell.css");
    expect(css).toContain(".ek-msg-side-head { padding: 34px 16px 10px; flex-shrink: 0; }\n.ek-msg-title { margin-bottom: 14px; }");
  });

  // Measured on a replica of the real CSS at 390 to 1920 px windows: the four framed titles stand at one left and top
  // at every width (405 / 34 px at 1920), Messages' at 16 / 34; before, they used 30, 34, 44, 52 and 56 px.
  it("is the Hall of Fame's frame and type, smaller on a phone", () => {
    const css = src("components", "enki-shell", "enki-shell.css");
    expect(css).toContain(".ek-page { max-width: 880px; margin: 0 auto; padding: 34px 28px 60px; }");
    expect(css).toContain(".ek-page-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px 16px; flex-wrap: wrap; margin-bottom: 22px; }");
    expect(css).toContain(".ek-page-title { font-family: var(--font-serif), Georgia, serif; font-style: italic; font-weight: 400; font-size: 44px; line-height: 1.05; margin: 0; color: var(--enki-ink); }");
    expect(css).toContain(".ek-page-sub { margin: 4px 0 0; max-width: 560px; font-size: 13.5px; line-height: 1.55; color: var(--enki-ink-3); }");
    expect(css).toMatch(/@media \(max-width: 767\.98px\) \{[\s\S]*?\n {2}\.ek-page \{ padding: 16px 14px calc\(24px \+ env\(safe-area-inset-bottom, 0px\)\); \}\n {2}\.ek-page-title \{ font-size: 30px; \}\n {2}\.ek-page-sub \{ font-size: 13px; \}\n {2}\.ek-msg-side-head \{ padding-top: 16px; \}/);
    expect(src("components", "settings", "settings.css")).toContain(".set-page .ek-page-sub { min-height: calc(1.55em * 3); }");
  });
});
