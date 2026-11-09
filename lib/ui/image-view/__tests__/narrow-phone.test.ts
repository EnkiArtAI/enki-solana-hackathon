import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";

// Absolute, so the in-memory mutant runner reaches what these pins read.
const src = (p: string) => readSource(join(__dirname, "..", "..", "..", "..", p));

/**
 * The Image View on a narrow phone (Kev, 2026-10-27, a 320 px pane): "in kleiner ansicht kann das mit let your ai
 * agent use this prompt ruhig kleiner sein. also eine zeile lang max", and "wenn alles schmaler ist, so kann alles auch
 * bisschen kleiner werden. aktuell sehen die elemente alle viel zu groß aus während textbox für prompt zu klein ist".
 */
describe("the agent row", () => {
  it("keeps its words on one line at any width, ending in … where they run short", () => {
    expect(src("components/image-view/image-view.css")).toContain(
      ".iv-agent-toggle > span:first-of-type { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }",
    );
  });
});

describe("the agent row opened on a phone", () => {
  // Kev, 2026-10-27 (the pill over the x402 request): "lass das da ruhig sein mit more below wenn ich das da aufklappe".
  it("hides More below while it is open, and only then", () => {
    const css = src("components/image-view/image-view-mobile.css");
    expect(css).toContain('.iv-mobile:has(.iv-agent-toggle[aria-expanded="true"]) .iv-more { display: none; }');
    // The open state the rule reads is the toggle's own.
    expect(src("components/image-view/AgentRow.tsx")).toContain('<button type="button" className="iv-agent-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>');
  });
});

describe("a narrow phone, under 360 px", () => {
  const css = src("components/image-view/image-view-mobile.css");
  const narrow = css.slice(css.indexOf("@media (max-width: 359.98px) {"));

  it("draws the foot, the title, the switch and the agent row a size smaller", () => {
    expect(css).toContain("@media (max-width: 359.98px) {");
    expect(narrow).toContain("  .iv-mobile .iv-foot { gap: 6px; padding: 8px 0 16px; }");
    // 32 px pills: 6 px above and below keep their 44 px press inside the row (review 2026-10-27).
    expect(narrow).toContain("  .iv-mobile .iv-foot .iv-bar { --kit-pill-h: 32px; gap: 4px; padding-block: 6px; margin-block: -6px; }");
    expect(narrow).toContain("  .iv-mobile .iv-foot .kit-pill { font-size: 12px; gap: 4px; padding: 0 7px 0 8px; }");
    expect(narrow).toContain("  .iv-mobile .kit-gen--hero { height: 48px; padding: 0 76px; font-size: 15.5px; }");
    expect(narrow).toContain("  .iv-mobile .kit-gen--hero .kit-gen-chip { top: 6px; right: 6px; bottom: 6px; font-size: 13px; }");
    expect(narrow).toContain("  .iv-mtitle { font-size: 19px; }");
    expect(narrow).toContain("  .iv-mobile .iv-mode-btn { height: 26px; font-size: 12px; }");
    expect(narrow).toContain("  .iv-mobile .iv-agent-toggle { height: 32px; gap: 6px; font-size: 12px; }");
  });

  it("keeps the fields' text at 17 px, over the 16 px where iOS zooms into a field", () => {
    expect(narrow).toContain("  .iv-mobile .iv-easy .kit-field-text { font-size: 17px; }");
  });
});

// Kev, 2026-10-27 (five pills, the count on a second row): "ich mag hier kein freien abstand da, kannste das nicht so
// anordnen, dass das in einer reihe einfach immer zu finden ist?"
describe("the settings row on a phone", () => {
  it("never wraps: too narrow a screen slides it sideways, each pill's 44 px press kept inside", () => {
    expect(src("components/image-view/image-view-mobile.css")).toContain(
      ".iv-mobile .iv-foot .iv-bar {\n  --kit-pill-h: 36px; flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none;\n  padding: 4px; margin: -4px; scroll-padding-inline: 4px;\n}",
    );
    // The reset stays in sight at the row's end, on an opaque ground (review 2026-10-27).
    expect(src("components/image-view/image-view-mobile.css")).toContain(".iv-mobile .iv-foot .iv-reset { position: sticky; right: 0; background: linear-gradient(var(--enki-fill), var(--enki-fill)) var(--enki-paper);");
  });
});

describe("a phone's text fields", () => {
  it("grow to 260 px before they scroll; the desktop keeps 120", () => {
    const field = src("components/kit/VariableField.tsx");
    expect(field).toContain("changed = false, onReset, max = 120 }: {");
    expect(field).toContain("min={40} max={max} growOnly={growOnly}");
    const panel = src("components/image-view/PromptPanel.tsx");
    expect(panel).toContain("export const PHONE_FIELD_MAX = 260;");
    expect(panel).toContain("export function Fields({ model: m, head = true, max }: { model: ImageViewModel; head?: boolean; max?: number }) {");
    expect(panel).toContain("maxLength={m.premium ? 300 : undefined} max={max}");
    // Both ways a phone shows the fields: under the text, and alone in Variable (Easy) mode.
    expect(panel).toContain("<Fields model={m} max={phone ? PHONE_FIELD_MAX : undefined} />");
    expect(src("components/image-view/Composer.tsx")).toContain('<div className="iv-easy" data-in={switched || undefined}><Fields model={m} head={false} max={phone ? PHONE_FIELD_MAX : undefined} /></div>');
  });
});
