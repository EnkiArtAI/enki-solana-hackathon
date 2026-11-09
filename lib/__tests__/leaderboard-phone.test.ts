import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { readSource } from "./_read-source";

/**
 * DEC-467 (Kev, 2026-10-27, phone screenshot: "at hall of fame, the table is broken"): on a phone the list scrolled
 * sideways at 540 px and cut its right end off. It fits the screen now: rank, creator, the count and the trend's
 * number; the prompt count and the trend's line give way.
 */
const ROOT = join(__dirname, "..", "..");
const css = readSource(join(ROOT, "components", "enki-shell", "enki-shell.css"));
const phone = css.slice(css.indexOf("@media (max-width: 767.98px) {"), css.indexOf("/* ── Base Leaderboard styles ── */"));
const page = readSource(join(ROOT, "app", "leaderboard", "page.tsx"));

describe("the Hall of Fame list on a phone", () => {
  it("fits the screen in four columns and scrolls nothing sideways", () => {
    expect(phone).toContain(".ek-lb-row { grid-template-columns: 30px minmax(0, 1fr) auto 58px !important; }");
    expect(phone).toContain(".ek-lb-sub, .ek-lb-spark { display: none !important; }");
    expect(css).not.toMatch(/min-width: 540px|overflow-x: auto !important/);
  });

  it("puts the head and every row on that grid, and marks what gives way in both", () => {
    expect(page).toMatch(/<div className="ek-lb-row" style=\{\{ display: "grid", gridTemplateColumns: "44px 1fr 110px 84px 90px 70px"/);
    expect(page).toMatch(/<div key=\{r\.rank\} className="ek-lb-row" style=\{\{\n\s+display: "grid", gridTemplateColumns: "44px 1fr 110px 84px 90px 70px"/);
    expect(page).toContain('<span className="ek-lb-sub" style={headCell({ textAlign: "right" })}>{isGens ? "" : "Prompts"}</span>');
    expect(page).toContain('<span className="ek-lb-spark" style={headCell()}>Trend</span>');
    expect(page).toContain('<span className="ek-lb-sub" style={mono(10.5, "var(--enki-ink-3)", { textAlign: "right" })}>');
    expect(page).toContain('<svg className="ek-lb-spark" viewBox="0 0 90 20"');
    expect(page).toContain(') : <span className="ek-lb-spark" />}');
  });

  // DEC-470 (review wf_e68176b7-d81): at 40 px "↑ +$100" broke after its arrow.
  it("keeps the trend's number on one line, in a column wide enough for \"↑ +$1,000\"", () => {
    expect(page).toContain('<span style={mono(10.5, deltaInk(r), { textAlign: "right", whiteSpace: "nowrap" })}>{fmtDelta(r)}</span>');
  });
});
