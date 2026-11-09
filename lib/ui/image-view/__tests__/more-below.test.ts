import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { emptyRoom, laidOut, moreBelow, morePill, moreStep, type MoreMeasure } from "../more-below";

/** "↓ N more settings": the variable rows still under the fold (S:176-180), hidden while an element is active, a tap scrolls 0.7 × the viewport (S:594-595). */
describe("moreBelow", () => {
  const at = (over: Partial<MoreMeasure>) =>
    moreBelow({ rowTops: [], bottom: 800, scrollHeight: 2000, scrollTop: 0, clientHeight: 700, ...over });

  it("counts the rows whose top 28 px are not in view 6 px above the scroller's bottom", () => {
    // edge = 800 − 6 = 794: a top of 766 reaches 794 (in view), 767 reaches 795 (below)
    expect(at({ rowTops: [100, 300, 766, 767, 900] })).toBe(2);
    expect(at({ rowTops: [767] })).toBe(1);
  });

  it("is -1 when more is below but every row is in view", () => {
    expect(at({ rowTops: [100, 300, 766] })).toBe(-1);
    expect(at({ rowTops: [] })).toBe(-1);
  });

  it("is 0 once at most 16 px are left to scroll, whatever the rows", () => {
    expect(at({ rowTops: [900], scrollHeight: 1716 + 700, scrollTop: 1700 })).toBe(0); // 16 left
    expect(at({ rowTops: [900], scrollHeight: 1717 + 700, scrollTop: 1700 })).toBe(1); // 17 left
    expect(at({ rowTops: [900], scrollHeight: 700 })).toBe(0);
  });
});

describe("morePill", () => {
  it("says how many settings are below, singular for one, or More below without a count", () => {
    expect(morePill(3, false)).toBe("↓ 3 more settings");
    expect(morePill(1, false)).toBe("↓ 1 more setting");
    expect(morePill(-1, false)).toBe("↓ More below");
  });

  it("hides with nothing below, and while an element is active", () => {
    expect(morePill(0, false)).toBeNull();
    expect(morePill(3, true)).toBeNull();
    expect(morePill(-1, true)).toBeNull();
  });
});

describe("moreStep", () => {
  it("scrolls 70 % of the visible height", () => {
    expect(moreStep(600)).toBe(420);
    expect(moreStep(1000)).toBe(700);
  });
});

// DEC-471 (Kev, 2026-10-28: "ich will keinen reststreifen haben"): the phone composer is at least its scroller less 14 px,
// so its head always reaches its place under the burger; that room is not "More below".
describe("the phone composer's room", () => {
  const ROOT = join(__dirname, "..", "..", "..", "..");
  const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");

  it("is the box's bottom less its last shown child's, never below 0, and 0 with no child shown", () => {
    expect(emptyRoom(900, [300, 420, 380])).toBe(480);
    expect(emptyRoom(420, [300, 420])).toBe(0);
    expect(emptyRoom(400, [420])).toBe(0);
    expect(emptyRoom(900, [])).toBe(0);
  });

  it("lets the head reach its place: a composer with a head is the scroller's content box less the head's 14 px", () => {
    const shell = read("components", "enki-shell", "enki-shell.css");
    const phone = shell.slice(shell.indexOf("@media (max-width: 767.98px) {"));
    // Without a head (a guest's plain prompt) there is nothing to bring there (review wf_794afa1b-83d).
    expect(phone).toContain("  .ek-app .iv-frame .iv-mobile-compose:has(> .iv-mode-head) { min-height: calc(100% - 14px); }");
    expect(phone).toContain(".iv-mode-head { top: 14px; }");
    // The head is the composer's own child: Composer is a fragment put straight into it.
    expect(read("components", "image-view", "ImageViewMobile.tsx")).toContain('<div className="iv-mobile-compose">\n            <Composer model={m} phone />');
    expect(read("components", "image-view", "Composer.tsx")).toMatch(/return \(\n {4}<>\n {6}\{\(switchable \|\| label\) && \([\s\S]{0,300}<div ref=\{head\} className="iv-mode-head">/);
  });

  it("is taken off the scroll height MoreBelow measures, counting only shown children", () => {
    const more = read("components", "image-view", "MoreBelow.tsx");
    expect(more).toContain('const compose = scroller.querySelector(".iv-mobile-compose");');
    expect(more).toContain("laidOut(compose).map((c) => c.getBoundingClientRect()).filter((r) => r.height > 0).map((r) => r.bottom)) : 0;");
    expect(more).toContain("scrollHeight: scroller.scrollHeight - room(),");
  });

  // Review wf_794afa1b-83d: Full prompt's text sits in a `display: contents` wrapper (Composer), whose own box is empty.
  it("counts the children of a display: contents wrapper in its place", () => {
    type Fake = Element & { d: string };
    const el = (d: string, ...children: Fake[]) => ({ d, children }) as unknown as Fake;
    const text = el("block");
    const head = el("flex");
    const nested = el("block");
    const box = el("flex", head, el("contents", text, el("contents", nested)));
    expect(laidOut(box, (e) => (e as Fake).d)).toEqual([head, text, nested]);
  });

  it("re-measures when the composer's rows grow inside its min-height, or change with the mode", () => {
    const more = read("components", "image-view", "MoreBelow.tsx");
    expect(more).toContain("const watch = () => { if (compose) for (const c of laidOut(compose)) ro.observe(c); };\n    watch();");
    expect(more).toContain("const mo = new MutationObserver(() => { watch(); measure(); });\n    if (compose) mo.observe(compose, { childList: true });");
    expect(more).toContain("ro.disconnect();\n      mo.disconnect();");
  });
});
