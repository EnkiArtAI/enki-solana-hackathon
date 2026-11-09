import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import type { ImageViewModel } from "@/components/image-view/useImageViewModel";

/**
 * Easy | Expert (image UI v2, README §1, handoff §5.5): Easy shows the
 * buyer's photos and the variables with the text hidden, Expert the text to
 * edit; a premium prompt, whose text never reaches the client, has Easy only.
 */
const ui = vi.hoisted(() => ({ state: [] as unknown[], refs: [] as { current: unknown }[], s: 0, r: 0, click: vi.fn(), doc: true, effects: [] as (() => (() => void) | void)[] }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: <T>(start: T) => {
    const i = ui.s++;
    if (!(i in ui.state)) ui.state[i] = start;
    return [ui.state[i] as T, (next: T) => { ui.state[i] = next; }];
  },
  useRef: <T>(start: T) => {
    const i = ui.r++;
    ui.refs[i] ??= { current: start };
    return ui.refs[i];
  },
  useEffect: (run: () => (() => void) | void) => { ui.effects.push(run); },
}));
vi.mock("@/components/image-view/PhotoDeck", () => ({ default: () => null }));
vi.mock("@/components/image-view/RefPicker", () => ({ default: () => null }));
vi.mock("@/components/image-view/PromptPanel", () => ({ default: () => null, Fields: () => null, inDocument: () => ui.doc, PHONE_FIELD_MAX: 260 }));

import Composer from "@/components/image-view/Composer";
import { ADD_PHOTOS_EVENT } from "@/lib/ui/image-view/slots";
import PhotoDeck from "@/components/image-view/PhotoDeck";
import RefPicker from "@/components/image-view/RefPicker";
import PromptPanel, { Fields } from "@/components/image-view/PromptPanel";

type El = ReactElement<Record<string, unknown>>;
function* walk(node: ReactNode): Generator<El> {
  if (Array.isArray(node)) for (const n of node) yield* walk(n);
  else if (isValidElement<Record<string, unknown>>(node)) { yield node; yield* walk(node.props.children as ReactNode); }
}
const of = (tree: ReactNode, type: unknown) => [...walk(tree)].filter((el) => el.type === type);
const byClass = (tree: ReactNode, name: string) => [...walk(tree)].filter((el) => el.props.className === name);
const press = (el: El) => (el.props.onClick as () => void)();

let model: ImageViewModel;
const draw = (phone = false) => {
  ui.s = 0; ui.r = 0;
  const tree = Composer({ model, phone }) as El;
  (ui.refs[0] as { current: unknown }).current = { click: ui.click };
  return tree;
};
beforeEach(() => {
  ui.state = []; ui.refs = []; ui.effects = []; ui.click.mockClear(); ui.doc = true;
  model = { text: "a portrait of Reference image 1", guest: false, room: 3, slotTotal: 2, photosNeeded: 0, textMissing: false, accept: "image/*", addFiles: vi.fn() } as unknown as ImageViewModel;
});

describe("the composer", () => {
  it("opens on Easy: the photos and the variables, the text hidden", () => {
    const tree = draw();
    expect(of(tree, PhotoDeck)).toHaveLength(1);
    expect(of(tree, Fields)[0].props.head).toBe(false);
    expect(of(tree, PromptPanel)).toHaveLength(0);
    expect([byClass(tree, "iv-mode-label")[0].props.children].flat().filter((c) => typeof c === "string").join("")).toBe("Your images");
    expect(byClass(tree, "iv-mode-count")).toHaveLength(0);
  });

  it("puts the switch at the head's left on the desktop, before the label or Ref image", () => {
    const first = (tree: ReactNode) => [byClass(tree, "iv-mode-head")[0].props.children].flat().find((c) => isValidElement(c)) as El;
    expect(first(draw()).props.role).toBe("radiogroup");
    ui.state[0] = "expert";
    expect(first(draw()).props.role).toBe("radiogroup");
    model.text = null;
    expect(first(draw()).props.className).toBe("iv-mode-label");
  });

  // Kev, 2026-10-27: "variable, / prompt darunter image und your images da rechts, das macht gar keinen sinn. your images
  // muss darüber und variable/full prompt dann halt rechts zum umschalten".
  it("on a phone names the photos at the head's left and keeps the switch at its right, in both modes", () => {
    const kids = (tree: ReactNode) => [byClass(tree, "iv-mode-head")[0].props.children].flat().filter((c) => isValidElement(c)) as El[];
    let row = kids(draw(true));
    expect(row[0].props.className).toBe("iv-mode-label");
    expect(row[row.length - 1].props.role).toBe("radiogroup");
    ui.state[0] = "expert";
    row = kids(draw(true));
    expect(row[0].props.className).toBe("iv-mode-left");
    expect(row[row.length - 1].props.role).toBe("radiogroup");
    expect(readFileSync(join(__dirname, "..", "..", "..", "..", "components", "image-view", "image-view-mobile.css"), "utf8"))
      .toContain(".iv-mobile .iv-mode { width: 150px; margin-left: auto; }");
  });

  it("counts the images in the head on the phone", () => {
    const say = (node: ReactNode): string => Array.isArray(node) ? node.map(say).join("") : isValidElement<{ children?: ReactNode }>(node) ? say(node.props.children) : typeof node === "string" || typeof node === "number" ? String(node) : "";
    expect(say(byClass(draw(true), "iv-mode-label")[0])).toBe("Your images · 2 images");
    expect(byClass(draw(true), "iv-mode-count")).toHaveLength(1);
    model.slotTotal = 1;
    expect(say(byClass(draw(true), "iv-mode-label")[0])).toBe("Your images");
  });

  it("switches to Expert: the text to edit, photos added from the head", () => {
    const expert = [...walk(draw())].find((el) => el.props.role === "radio" && el.props.children === "Full prompt")!;
    // Named by what each shows (Kev, 2026-10-26: "easy / expert is vague ... just show Variable | full prompt").
    expect([...walk(draw())].filter((el) => el.props.role === "radio").map((el) => el.props.children)).toEqual(["Variable", "Full prompt"]);
    expect([...walk(draw())].find((el) => el.props.role === "radiogroup")!.props["aria-label"]).toBe("Variable or full prompt");
    press(expert);
    const tree = draw();
    expect(of(tree, PromptPanel)).toHaveLength(1);
    expect(of(tree, PhotoDeck)).toHaveLength(0);
    expect([...walk(tree)].find((el) => el.props.role === "radio" && el.props.children === "Full prompt")!.props["aria-checked"]).toBe(true);
    // "+ Ref image" asks the reference picker beside it; its Upload opens the file picker.
    const rect = { left: 10, top: 20, bottom: 54 };
    (byClass(tree, "iv-refimg")[0].props.onClick as (e: unknown) => void)({ currentTarget: { getBoundingClientRect: () => rect } });
    const picker = of(draw(), RefPicker)[0];
    expect(picker.props.anchor).toBe(rect);
    expect(ui.click).not.toHaveBeenCalled();
    (picker.props.onUpload as () => void)();
    expect(ui.click).toHaveBeenCalledOnce();
    (picker.props.onClose as () => void)();
    expect(of(draw(), RefPicker)).toHaveLength(0);
    const input = [...walk(tree)].find((el) => el.type === "input")!;
    const files = [new File(["a"], "a.png")];
    (input.props.onChange as (e: unknown) => void)({ target: { files, value: "x" } });
    expect(model.addFiles).toHaveBeenCalledWith(files, undefined);
  });

  it("says Ref image at cursor once a word is clicked and no named slot waits, puts the photo there and drops the cursor", () => {
    ui.state = ["expert", 12, null];
    const words = (node: ReactNode): string => Array.isArray(node) ? node.map(words).join("") : isValidElement<{ children?: ReactNode }>(node) ? words(node.props.children) : typeof node === "string" ? node : "";
    const label = (tree: ReactNode) => words(byClass(tree, "iv-refimg")[0].props.children as ReactNode).slice(1);
    let tree = draw();
    expect(label(tree)).toBe("Ref image at cursor");
    const files = [new File(["a"], "a.png")];
    // As a click goes: the button asks the picker, its Upload closes it, the files come once it is gone.
    const upload = () => {
      (byClass(draw(), "iv-refimg")[0].props.onClick as (e: unknown) => void)({ currentTarget: { getBoundingClientRect: () => ({}) } });
      const picker = of(draw(), RefPicker)[0];
      (picker.props.onClose as () => void)();
      (picker.props.onUpload as () => void)();
      tree = draw();
      ([...walk(tree)].find((el) => el.type === "input")!.props.onChange as (e: unknown) => void)({ target: { files, value: "x" } });
    };
    upload();
    expect(model.addFiles).toHaveBeenLastCalledWith(files, 12);
    expect(ui.state[1]).toBeNull();
    ui.state[1] = 12; model.photosNeeded = 1;
    tree = draw();
    expect(label(tree)).toBe("Ref image");
    upload();
    expect(model.addFiles).toHaveBeenLastCalledWith(files, undefined);
    expect(ui.state[1]).toBe(12);
  });

  it("drops the picked element on a switch, and the cursor too on the way to Easy", () => {
    const radio = (k: string) => [...walk(draw())].find((el) => el.props.role === "radio" && el.props.children === k)!;
    ui.state = ["easy", 5, { kind: "ref", n: 1 }];
    press(radio("Full prompt"));
    expect(ui.state.slice(0, 3)).toEqual(["expert", 5, null]);
    ui.state[2] = { kind: "ref", n: 1 };
    press(radio("Variable"));
    expect(ui.state.slice(0, 3)).toEqual(["easy", null, null]);
  });

  it("answers Generate's Add N photos in Expert with the picker at + Ref image, else at the head; not in Easy", () => {
    const heard: string[] = [];
    let open: (() => void) | undefined;
    vi.stubGlobal("window", { addEventListener: (t: string, l: () => void) => { heard.push(t); open = l; }, removeEventListener: vi.fn() });
    ui.state[0] = "expert";
    draw();
    const seen = vi.fn(), rect = { left: 5, top: 6, bottom: 30 };
    // The head's ref: the third (input, upAt, head).
    ui.refs[2].current = { querySelector: (q: string) => (q === ".iv-refimg" ? { scrollIntoView: seen, getBoundingClientRect: () => rect } : null) };
    ui.effects.at(-1)!();
    expect(heard).toEqual([ADD_PHOTOS_EVENT]);
    open!();
    expect(seen).toHaveBeenCalledWith({ block: "nearest" });
    expect(of(draw(), RefPicker)[0].props.anchor).toBe(rect);
    // No "+ Ref image" (no room): the head itself.
    const whole = { left: 0, top: 0, bottom: 34 };
    ui.refs[2].current = { querySelector: () => null, scrollIntoView: seen, getBoundingClientRect: () => whole };
    open!();
    expect(of(draw(), RefPicker)[0].props.anchor).toBe(whole);
    // Easy: the photo area answers, the composer stays out.
    ui.state = ["easy"]; ui.effects = []; heard.length = 0;
    draw();
    ui.effects.at(-1)!();
    expect(heard).toEqual([]);
    vi.unstubAllGlobals();
  });

  it("marks the buyer's changes in the desktop head while the document shows", () => {
    ui.state[0] = "expert";
    expect(byClass(draw(), "iv-legend")).toHaveLength(1);
    expect(byClass(draw(true), "iv-legend")).toHaveLength(0);
    ui.doc = false;
    expect(byClass(draw(), "iv-legend")).toHaveLength(0);
  });

  it("offers Ref image only while a photo can be added", () => {
    ui.state[0] = "expert";
    expect(byClass(draw(), "iv-refimg")).toHaveLength(1);
    model.room = 0;
    expect(byClass(draw(), "iv-refimg")).toHaveLength(0);
    model.room = 3; model.slotTotal = 14;
    expect(byClass(draw(), "iv-refimg")).toHaveLength(0);
  });

  it("has no switch on a premium prompt, and stays on Easy there", () => {
    model.text = null;
    ui.state[0] = "expert";
    const tree = draw();
    expect([...walk(tree)].filter((el) => el.props.role === "radiogroup")).toHaveLength(0);
    expect(of(tree, PhotoDeck)).toHaveLength(1);
    expect(of(tree, PromptPanel)).toHaveLength(0);
  });

  it("shows a guest no photos to add, nor their heading: the switch alone, else no head", () => {
    model.guest = true;
    let tree = draw();
    expect(of(tree, PhotoDeck)).toHaveLength(0);
    expect(byClass(tree, "iv-mode-label")).toHaveLength(0);
    expect([...walk(tree)].filter((el) => el.props.role === "radiogroup")).toHaveLength(1);
    model.text = null;
    tree = draw();
    expect(byClass(tree, "iv-mode-head")).toHaveLength(0);
  });

  it("shows no photos on a premium prompt its creator switched them off for, no heading, no empty head; the fields stay", () => {
    model.text = null; model.premium = true; model.photosOff = true;
    for (const phone of [false, true]) {
      const tree = draw(phone);
      expect(of(tree, PhotoDeck)).toHaveLength(0);
      expect(byClass(tree, "iv-mode-label")).toHaveLength(0);
      expect(byClass(tree, "iv-mode-head")).toHaveLength(0);
      expect(of(tree, Fields)).toHaveLength(1);
    }
    // Left on, or a creator's own view (the route says allowed): as today.
    model.photosOff = false;
    const on = draw();
    expect(of(on, PhotoDeck)).toHaveLength(1);
    expect(byClass(on, "iv-mode-label")).toHaveLength(1);
  });

  it("says so when a premium text failed to load", () => {
    model.guest = false; model.text = null; model.textMissing = true;
    expect(byClass(draw(), "iv-note")).toHaveLength(1);
  });
});

describe("the head's styles", () => {
  const CSS = readFileSync(join(__dirname, "..", "..", "..", "..", "components", "image-view", "image-view.css"), "utf8");
  // Kev (2026-10-21): too big a gap between "Your images" and the photos; 22 px from the label to the first square.
  it("keep the photos close under the head", () => {
    expect(CSS).toMatch(/\.iv-mode-head \{[^}]*padding: 12px 0 6px;/);
    expect(CSS).toContain(".iv-mode-head + .iv-deck { margin-top: -8px; }");
    expect(CSS).toMatch(/\.iv-deck \{[^}]*padding: 0 0 14px;/);
  });

  it("stick it to the top of the scroller and slide the switch in .28 s", () => {
    expect(CSS).toMatch(/\.iv-mode-head \{\n  position: sticky;\n  top: 0;/);
    expect(CSS).toContain(".iv-mode-slide[data-expert] { transform: translateX(100%); }");
    expect(CSS).toContain("transition: transform 0.28s cubic-bezier(0.3, 0.7, 0.3, 1);");
  });
});

describe("Full prompt on a phone (Kev, 2026-10-26: the referenced images lined up at \"+ Ref image\" as a card deck)", () => {
  const expert = (phone: boolean) => {
    model = { ...model, segments: [{ kind: "text", text: "a portrait of " }, { kind: "ref", text: "Reference image 1", n: 1 }] } as unknown as ImageViewModel;
    press([...walk(draw(phone))].find((el) => el.props.role === "radio" && el.props.children === "Full prompt")!);
    return draw(phone);
  };

  it("shows the photo deck under the head, before the text, at its fixed size", () => {
    const tree = expert(true);
    const decks = of(tree, PhotoDeck);
    expect(decks.map((el) => [el.props.phone, el.props.fixed])).toEqual([[true, true]]);
    const all = [...walk(tree)];
    expect(all.indexOf(decks[0])).toBeLessThan(all.indexOf(of(tree, PromptPanel)[0]));
  });

  it("not on desktop, nor for a guest, nor for a text without images", () => {
    expect(of(expert(false), PhotoDeck)).toHaveLength(0);
    model.guest = true;
    expect(of(expert(true), PhotoDeck)).toHaveLength(0);
  });
});

it("the deck slides under one finger: 8 px sideways first, the card under it to the front; the click after a slide opens nothing", () => {
  const deck = readFileSync(join(__dirname, "..", "..", "..", "..", "components", "image-view", "PhotoDeck.tsx"), "utf8");
  expect(deck).toContain('if (!phone || e.pointerType === "mouse" || (e.target as HTMLElement).closest(".iv-photo-x, .iv-photo-swap, .iv-photo-add")) return;');
  expect(deck).toContain("if (!s || (!s.moved && Math.abs(e.clientX - s.x) <= 8)) return;");
  expect(deck).toContain("setHot(deckAt(lay.tiles, e.clientX - e.currentTarget.getBoundingClientRect().left));");
  expect(deck).toContain("onClickCapture={(e) => { if (!slid.current) return; slid.current = false; e.stopPropagation(); e.preventDefault(); }}");
  expect(deck).toContain("data-scrub={scrub || undefined}");
  const css = readFileSync(join(__dirname, "..", "..", "..", "..", "components", "image-view", "image-view.css"), "utf8");
  expect(css).toContain(".iv-deck-box[data-scrub] .iv-photo[data-hot] { z-index: 80 !important; transform: translateY(-6px) scale(1.18);");
  // A mouse over overlapping cards: the card PhotoDeck marks hot peeks up, :hover only where no card covers the next.
  expect(css.replace(/\r\n/g, "\n")).toContain(".iv-deck-box:not([data-overlap]) .iv-photo:hover,\n  .iv-deck-box[data-overlap] .iv-photo[data-hot] { z-index: 80 !important; transform: translateY(-8px);");
});

it("shows no deck in a phone's Full prompt whose text names no image (review 2026-10-26)", () => {
  model = { ...model, segments: [{ kind: "text", text: "a portrait" }] } as unknown as ImageViewModel;
  press([...walk(draw(true))].find((el) => el.props.role === "radio" && el.props.children === "Full prompt")!);
  expect(of(draw(true), PhotoDeck)).toHaveLength(0);
});

it("opens one picker for Add N photos: on a phone the deck in Full prompt answers it, not the head (review 2026-10-26)", () => {
  const src = readFileSync(join(__dirname, "..", "..", "..", "..", "components", "image-view", "Composer.tsx"), "utf8");
  expect(src).toContain("  const deck = phone && !m.guest && slots;");
  expect(src).toContain("    if (!expert || deck) return;");
  expect(src).toContain("  }, [expert, deck]);");
});

// Kev, 2026-10-27: "das "+ ref image" ist unnötig, das "photo" symbol reicht völlig, pack da eher nen plus zusätzlich hinzu".
describe("adding a photo on a phone's Full prompt", () => {
  it("leaves it to the deck's photo symbol: the head says Your images there, no + Ref image; elsewhere + Ref image stays", () => {
    const head = (tree: ReactNode) => [byClass(tree, "iv-mode-head")[0].props.children].flat().filter((c) => isValidElement(c)) as El[];
    model = { ...model, segments: [{ kind: "text", text: "a portrait of " }, { kind: "ref", text: "Reference image 1", n: 1 }] } as unknown as ImageViewModel;
    ui.state[0] = "expert";
    const phone = draw(true);
    expect(byClass(phone, "iv-refimg")).toHaveLength(0);
    expect(head(phone)[0].props.className).toBe("iv-mode-label");
    expect(of(phone, PhotoDeck)).toHaveLength(1);
    // The desktop's Full prompt has no deck: its + Ref image is the way in; so on a phone whose text names no image.
    expect(byClass(draw(), "iv-refimg")).toHaveLength(1);
    model = { ...model, segments: [{ kind: "text", text: "a portrait" }] } as unknown as ImageViewModel;
    expect(byClass(draw(true), "iv-refimg")).toHaveLength(1);
  });

  // Kev, 2026-10-27: "variable / full prompt ändert the größe of the platzhalter of add ref image, as nicht der fall sein
  // soll. keep the size of when it is visible on variable".
  it("keeps the deck at the height Variable's deck settled on when switching to Full prompt", () => {
    model = { ...model, segments: [{ kind: "text", text: "a portrait of " }, { kind: "ref", text: "Reference image 1", n: 1 }] } as unknown as ImageViewModel;
    const variable = of(draw(true), PhotoDeck)[0];
    // Variable's deck measures and tells its height; the setter is Composer's own state (index 6, after asking).
    expect(variable.props.fixed).toBeUndefined();
    (variable.props.onSize as (h: number) => void)(72);
    expect(ui.state[6]).toBe(72);
    ui.state[0] = "expert";
    expect(of(draw(true), PhotoDeck)[0].props.fixed).toBe(72);
    // Nothing measured yet: the start height, as before.
    ui.state[6] = null;
    expect(of(draw(true), PhotoDeck)[0].props.fixed).toBe(true);
    // The desktop's Variable deck tells nobody: its Full prompt has no deck.
    ui.state[0] = "easy";
    expect(of(draw(), PhotoDeck)[0].props.onSize).toBeUndefined();
    // The deck: a number for fixed is that height; a measured one reports what it settled on.
    const deck = readFileSync(join(__dirname, "..", "..", "..", "..", "components", "image-view", "PhotoDeck.tsx"), "utf8");
    expect(deck).toContain('const height = typeof fixed === "number" ? fixed : fixed ? (phone ? START.phone : START.desktop).height : deckHeight(free, phone);');
    // The height as drawn, small moves kept (review 2026-10-27).
    expect(deck).toContain("const kept = Math.abs(prev.width - next.width) > 2 || Math.abs(prev.height - next.height) > 3 ? next : prev;\n      applied.current = kept;\n      setArea(kept);");
    expect(deck).toContain("if (fixed === false) onSize?.(kept.height);");
    expect(deck).toContain("}, [phone, fixed, onSize]);");
  });

  // Kev, 2026-10-27: "wenn ich von full prompt zu variable rum switche sollte auch quasi the prompt drunter auch so nach
  // links wischen, so wie sie nach rechts wischt von variable to full prompt".
  it("slides Variable's fields in from the left once the switch was used, never on the first view", () => {
    const easy = (tree: ReactNode) => byClass(tree, "iv-easy")[0];
    expect(easy(draw(true)).props["data-in"]).toBeUndefined();
    // The checked Variable tapped again on the first view changes nothing (review 2026-10-27).
    press([...walk(draw(true))].find((el) => el.props.role === "radio" && el.props.children === "Variable")!);
    expect(easy(draw(true)).props["data-in"]).toBeUndefined();
    press([...walk(draw(true))].find((el) => el.props.role === "radio" && el.props.children === "Full prompt")!);
    press([...walk(draw(true))].find((el) => el.props.role === "radio" && el.props.children === "Variable")!);
    expect(easy(draw(true)).props["data-in"]).toBe(true);
    const css = readFileSync(join(__dirname, "..", "..", "..", "..", "components", "image-view", "image-view.css"), "utf8");
    expect(css).toContain(".iv-easy[data-in] { animation: iv-in-l 0.3s cubic-bezier(0.3, 0.7, 0.3, 1); }");
    expect(css).toContain("@media (prefers-reduced-motion: reduce) { .iv-easy[data-in] { animation: none; } }");
    expect(css).toMatch(/@keyframes iv-in-l \{ from \{ transform: translateX\(-26px\); opacity: 0; \} \}/);
  });

  it("draws the photo symbol with a plus on an empty place and on the + tile", () => {
    const deck = readFileSync(join(__dirname, "..", "..", "..", "..", "components", "image-view", "PhotoDeck.tsx"), "utf8");
    expect(deck).toContain('<Icon name="camera" size={size} stroke={1.5} />\n    <span className="iv-photo-addplus"><Icon name="plus"');
    expect(deck).toContain("{empty && <AddPhoto size={Math.round(t.size * 0.3)} />}");
    expect(deck).toContain("onClick={ask}><AddPhoto size={Math.round(lay.add.width * 0.3)} /></button>");
    const css = readFileSync(join(__dirname, "..", "..", "..", "..", "components", "image-view", "image-view.css"), "utf8");
    expect(css).toContain(".iv-photo-addplus { position: absolute; top: -22%; right: -28%; display: flex; padding: 1px; border-radius: 50%; background: currentColor; }");
  });
});
