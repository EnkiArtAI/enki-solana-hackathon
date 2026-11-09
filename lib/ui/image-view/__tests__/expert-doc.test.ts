import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import type { ImageViewModel } from "@/components/image-view/useImageViewModel";
import { parseSegments, type PromptVariable } from "@/lib/ui/image-view/segments";
import { moveRef } from "@/lib/ui/image-view/slots";
import { fieldsFor } from "@/lib/ui/image-view/variables";

/**
 * Expert's document (image UI v2, handoff §5.3, plan B9b): its words are
 * typed into where they stand, a variable is edited in place everywhere it
 * stands, a variable or an image opens the panel under the text, and the
 * document never turns into the words' editor (Kev, 2026-10-29).
 */
const ui = vi.hoisted(() => ({ state: undefined as unknown, refs: [] as { current: unknown }[], ref: 0, top: 0, effect: undefined as (() => void) | undefined }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  // The refs, in the order the parts ask for them on a walk, and the tree's one state (the document's runs drawn
  // anew), kept from draw to draw as React keeps them.
  useRef: <T>(start: T) => (ui.refs[ui.ref++] ??= { current: start }),
  useState: <T>(start: T) => [ui.state ?? start, (next: (x: T) => T) => { ui.state = next((ui.state ?? start) as T); }],
  // The document's layout effect, the last draw's, for a test to run as React would after that draw.
  useLayoutEffect: (run: () => void) => { ui.effect = run; },
}));
vi.mock("@/components/kit/PromptMirror", () => ({ default: () => null }));
vi.mock("@/components/kit/VariableField", () => ({ default: () => null }));
vi.mock("@/components/image-view/useImageViewModel", async (original) => ({ ...(await original<object>()), copyText: vi.fn() }));

import PromptPanel, { inDocument, PHONE_FIELD_MAX, type Active, type DocState } from "@/components/image-view/PromptPanel";
import { copyText } from "@/components/image-view/useImageViewModel";
import PromptMirror from "@/components/kit/PromptMirror";
import VariableField from "@/components/kit/VariableField";

type El = ReactElement<Record<string, unknown>>;
/** The tree with the panel's own parts (Document, ActivePanel, Text, Fields, Value) drawn in; the kit's stay elements. */
function* walk(node: ReactNode): Generator<El> {
  if (Array.isArray(node)) for (const n of node) yield* walk(n);
  else if (isValidElement<Record<string, unknown>>(node)) {
    if (typeof node.type === "function" && node.type !== PromptMirror && node.type !== VariableField) return yield* walk((node.type as (p: unknown) => ReactNode)(node.props));
    yield node;
    yield* walk(node.props.children as ReactNode);
  }
}
/** Every element of a tree, its parts asking for their refs from the first again, after PromptPanel's own: a tree walked
    twice is one draw. */
const nodes = (tree: ReactNode) => {
  ui.ref = ui.top;
  return [...walk(tree)];
};
const byClass = (tree: ReactNode, name: string) => nodes(tree).filter((el) => el.props.className === name);
const text = (node: ReactNode): string =>
  Array.isArray(node) ? node.map(text).join("")
    : isValidElement<{ children?: ReactNode }>(node) ? text(node.props.children)
      : typeof node === "string" || typeof node === "number" ? String(node) : "";
const press = (el: El) => (el.props.onClick as () => void)();
const file = new File(["a"], "a.png");
const choose = (tree: ReactNode) => {
  const input = nodes(tree).find((el) => el.type === "input")!;
  (input.props.onChange as (e: unknown) => void)({ target: { files: [file], value: "x" } });
};

const variable = (name: string, type: string, options: PromptVariable["options"] = null) =>
  ({ id: name, name, label: name, description: "", type, defaultValue: null, required: false, position: 0, min: null, max: null, options }) as PromptVariable;
const VARS = [variable("Subject", "text"), variable("Style", "single-select", [{ promptValue: "oil", visibleName: "Oil" }, { promptValue: "ink", visibleName: "Ink" }])];
const TEXT = "a [Subject] in [Style] beside Reference image 1 and Reference image 2, [Subject] again";

let m: ImageViewModel;
let doc: DocState;
let changed: Set<string>;
const draw = (phone = false) => {
  ui.ref = 0;
  const tree = PromptPanel({ model: m, phone, doc });
  ui.top = ui.ref;
  return tree;
};
const tokens = (tree: ReactNode, label: string) => nodes(tree).filter((el) => el.props["aria-label"] === label);
const chip = (tree: ReactNode, label: string) => byClass(tree, "iv-chip").find((el) => text(el) === label);

beforeEach(() => {
  ui.state = undefined;
  ui.refs = [];
  changed = new Set();
  m = {
    text: TEXT, segments: parseSegments(TEXT, VARS), view: "filled", setView: vi.fn(), copyPrompt: vi.fn(),
    refs: [{ id: "1", src: "data:a" }], guest: false, values: { Subject: "a fox", Style: "oil" },
    changed: (k: string) => changed.has(k), setValue: vi.fn(), release: vi.fn(), resetValue: vi.fn(),
    room: 2, slotTotal: 2, accept: "image/*", removeSlot: vi.fn(), replacePhoto: vi.fn(), addFiles: vi.fn(),
    fields: [], blank: false, edited: false, premium: false, growOnly: () => false, setText: vi.fn(), resetText: vi.fn(), addVariable: vi.fn(),
  } as unknown as ImageViewModel;
  doc = { caret: null, onCaret: vi.fn(), active: null, onActive: vi.fn() };
});

describe("the document", () => {
  // The words are typed into where they stand; the cursor drawn in the document marks where a dragged image lands.
  it("draws the cursor after the word an image is dropped on", () => {
    const at = TEXT.indexOf("beside") + "beside".length;
    doc.caret = at;
    const words = byClass(draw(), "iv-word");
    const marked = words.filter((el) => byClass(el.props.children as ReactNode, "iv-caret").length);
    expect(marked.map(text)).toEqual(["beside "]);
    expect((marked[0].props.children as ReactNode[])[0]).toBe("beside");
  });

  it("edits a variable in place, every place it stands, green once it is the buyer's own", () => {
    let subject = tokens(draw(), "Subject");
    expect(subject).toHaveLength(2);
    expect(subject.map((el) => el.props["data-iv-field"])).toEqual(["Subject", undefined]);
    expect(subject.map((el) => el.props["data-changed"])).toEqual([undefined, undefined]);
    (subject[1].props.onFocus as () => void)();
    expect(doc.onActive).toHaveBeenCalledWith({ kind: "var", key: "Subject" });
    (subject[1].props.onBlur as (e: unknown) => void)({ currentTarget: { textContent: " a hare " } });
    expect(m.setValue).toHaveBeenCalledWith("Subject", "a hare");
    changed.add("Subject");
    doc.active = { kind: "var", key: "Subject" };
    subject = tokens(draw(), "Subject");
    expect(subject.map((el) => el.props["data-changed"])).toEqual([true, true]);
    expect(subject.map((el) => el.props["data-on"])).toEqual([true, true]);
    expect(byClass(draw(), "iv-tok").find((el) => text(el) === "Oil")!.props["data-on"]).toBeUndefined();
  });

  it("shows each image as its photo, dashed while it waits for one, and picks it", () => {
    const [one, two] = byClass(draw(), "iv-tok-img");
    expect([one.props["data-empty"], two.props["data-empty"]]).toEqual([undefined, true]);
    expect((one.props.children as El).props.src).toBe("data:a");
    expect(two.props.children).toBeFalsy();
    press(two);
    expect(doc.onActive).toHaveBeenCalledWith({ kind: "ref", n: 2 });
    doc.active = { kind: "ref", n: 2 };
    expect(byClass(draw(), "iv-tok-img").map((el) => el.props["data-on"])).toEqual([undefined, true]);
  });

  it("only shows a guest's images: they add no photos", () => {
    m.guest = true;
    const imgs = byClass(draw(), "iv-tok-img");
    expect(imgs.map((el) => [el.type, el.props.onClick])).toEqual([["span", undefined], ["span", undefined]]);
  });
});

describe("the panel", () => {
  const pick = (a: Active) => { doc.active = a; return draw(); };

  it("opens a choice with its options, the current one marked; a tap picks without taking the focus", () => {
    press(byClass(draw(), "iv-tok").find((el) => text(el) === "Oil")!);
    expect(doc.onActive).toHaveBeenCalledWith({ kind: "var", key: "Style" });
    const tree = pick({ kind: "var", key: "Style" });
    expect(byClass(tree, "iv-active-label").map(text)).toEqual(["Style"]);
    expect(byClass(tree, "iv-chip").map((el) => [text(el), el.props["data-on"]])).toEqual([["Oil", true], ["Ink", undefined]]);
    const keep = { preventDefault: vi.fn() };
    (chip(tree, "Ink")!.props.onMouseDown as (e: unknown) => void)(keep);
    expect(keep.preventDefault).toHaveBeenCalled();
    press(chip(tree, "Ink")!);
    expect(m.setValue).toHaveBeenCalledWith("Style", "ink");
  });

  it("offers Reset once the value is the buyer's own, and Done closes it", () => {
    expect(chip(pick({ kind: "var", key: "Subject" }), "↺ Reset")).toBeUndefined();
    changed.add("Subject");
    const tree = pick({ kind: "var", key: "Subject" });
    expect(byClass(tree, "iv-chip").map(text)).toEqual(["↺ Reset"]);
    press(chip(tree, "↺ Reset")!);
    expect(m.resetValue).toHaveBeenCalledWith("Subject");
    press(byClass(tree, "iv-done")[0]);
    expect(doc.onActive).toHaveBeenCalledWith(null);
  });

  it("replaces an image's photo, and adds one to an empty image while there is room", () => {
    let tree = pick({ kind: "ref", n: 1 });
    expect(byClass(tree, "iv-active-label").map(text)).toEqual(["Image 1"]);
    expect(byClass(tree, "iv-chip").map(text)).toEqual(["Replace photo", "Remove"]);
    choose(tree);
    expect(m.replacePhoto).toHaveBeenCalledWith(0, file);
    tree = pick({ kind: "ref", n: 2 });
    expect(chip(tree, "Add photo")).toBeDefined();
    choose(tree);
    expect(m.addFiles).toHaveBeenCalledWith([file]);
    m.room = 0;
    expect(chip(pick({ kind: "ref", n: 2 }), "Add photo")).toBeUndefined();
  });

  it("removes an image while there is more than one, and closes", () => {
    press(chip(pick({ kind: "ref", n: 2 }), "Remove")!);
    expect(m.removeSlot).toHaveBeenCalledWith(1);
    expect(doc.onActive).toHaveBeenCalledWith(null);
    m.slotTotal = 1;
    expect(chip(pick({ kind: "ref", n: 1 }), "Remove")).toBeUndefined();
  });

  // Kev, 2026-10-29: "it even changes to the variable names which is off, shouldnt be the case, i gotta see the entire prompt".
  it("opens a multi-choice's or a slider's own field under the words, the document left as it is", () => {
    const vars = [...VARS, variable("Moods", "multi-select", [{ promptValue: "calm", visibleName: "Calm" }, { promptValue: "wild", visibleName: "Wild" }]), variable("Size", "slider")];
    m.text = "a [Subject] in [Moods] at [Size]";
    m.segments = parseSegments(m.text, vars);
    m.fields = fieldsFor(vars, m.segments);
    const fields = (tree: ReactNode) => nodes(tree).filter((el) => el.type === VariableField);
    for (const key of ["Moods", "Size"]) {
      press(byClass(draw(), "iv-tok").find((el) => text(el) === key)!);
      expect(doc.onActive).toHaveBeenLastCalledWith({ kind: "var", key });
      const tree = pick({ kind: "var", key });
      expect(byClass(tree, "iv-doc")).toHaveLength(1);
      expect(fields(tree).map((el) => (el.props.variable as PromptVariable).name)).toEqual([key]);
      // The field and Done stand in the panel, pinned to the scroller's foot, the field taking the row (.iv-active).
      const panel = byClass(tree, "iv-active");
      expect(panel).toHaveLength(1);
      expect(fields(panel[0].props.children as ReactNode)).toHaveLength(1);
      expect(byClass(panel[0].props.children as ReactNode, "iv-done")).toHaveLength(1);
      expect(byClass(tree, "iv-chip")).toHaveLength(0);
      (fields(tree)[0].props.onChange as (v: string) => void)("calm");
      expect(m.setValue).toHaveBeenLastCalledWith(key, "calm");
      press(byClass(tree, "iv-done")[0]);
      expect(doc.onActive).toHaveBeenLastCalledWith(null);
    }
    expect(m.setView).not.toHaveBeenCalled();
    // A text value keeps its own panel, no field.
    expect(fields(pick({ kind: "var", key: "Subject" }))).toHaveLength(0);
  });

  // One value's field (Value), each of Fields' and the panel's: review 2026-10-29 found its wiring pinned only in part.
  it("gives a value's field its growth, release, copy, reset, untrimmed value and cap; Fields marks each and caps a phone's", () => {
    m.view = "text";
    m.fields = fieldsFor(VARS, m.segments!);
    m.growOnly = (k: string) => k === "Style";
    m.premium = true;
    changed.add("Style");
    for (const phone of [false, true]) {
      const rows = nodes(draw(phone)).filter((el) => el.type === "div" && el.props["data-iv-field"] !== undefined);
      expect(rows.map((el) => el.props["data-iv-field"])).toEqual(["Subject", "Style"]);
      for (const row of rows) {
        const key = row.props["data-iv-field"] as string;
        const [f] = nodes(row.props.children as ReactNode).filter((el) => el.type === VariableField);
        expect([f.props.value, f.props.growOnly, f.props.changed, f.props.maxLength, f.props.max])
          .toEqual([m.values[key], key === "Style", key === "Style", 300, phone ? PHONE_FIELD_MAX : undefined]);
        (f.props.onChange as (v: string) => void)("  a hare ");
        expect(m.setValue).toHaveBeenLastCalledWith(key, "  a hare ");
        (f.props.onUserInput as () => void)();
        expect(m.release).toHaveBeenLastCalledWith(key);
        (f.props.onReset as () => void)();
        expect(m.resetValue).toHaveBeenLastCalledWith(key);
        (f.props.onCopy as () => void)();
        expect(copyText).toHaveBeenLastCalledWith(m.values[key], `Copied ${key}`);
      }
    }
  });

  it("is gone once what it worked on left the text", () => {
    m.segments = parseSegments("a plain sentence with [Style]", VARS);
    expect(byClass(pick({ kind: "var", key: "Subject" }), "iv-active")).toHaveLength(0);
    expect(byClass(pick({ kind: "ref", n: 1 }), "iv-active")).toHaveLength(0);
    expect(byClass(pick({ kind: "var", key: "Style" }), "iv-active")).toHaveLength(1);
  });
});

describe("the words", () => {
  const link = (tree: ReactNode) => byClass(tree, "iv-link").find((el) => /words|editing/.test(text(el)));
  const reset = (tree: ReactNode) => byClass(tree, "iv-link").filter((el) => text(el) === "Reset to the artist's wording");
  const runs = (tree: ReactNode = draw()) => byClass(tree, "iv-run");
  const run = (said: string, tree?: ReactNode) => runs(tree).find((el) => text(el) === said)!;
  const type = (el: El) => (el.props.onInput as () => void)();
  const leave = (el: El, said: string) => (el.props.onBlur as (e: unknown) => void)({ currentTarget: { textContent: said } });
  const keyDown = (el: El, key: string, ime: { isComposing?: boolean; keyCode?: number } = {}) => {
    const e = { key, keyCode: ime.keyCode ?? 0, nativeEvent: { isComposing: !!ime.isComposing }, preventDefault: vi.fn(), stopPropagation: vi.fn(), currentTarget: { blur: vi.fn() } };
    (el.props.onKeyDown as (e: unknown) => void)(e);
    return e;
  };
  /** [preventDefault, stopPropagation, blur], how often each was called. */
  const calls = (e: ReturnType<typeof keyDown>) => [e.preventDefault, e.stopPropagation, e.currentTarget.blur].map((f) => f.mock.calls.length);
  const said = () => (m.setText as Mock).mock.lastCall?.[0] as string | undefined;

  // Kev, 2026-10-29: "i dont get why the textfeld changes to that "reference image" thing, lass doch einfach die view mit
  // den images and just lemme change texts without the UI actually changing at all".
  it("are typed into where they stand, a run between two tokens, the browser's caret where the click was: nothing flips", () => {
    for (const tree of [draw(), draw(true)]) {
      expect(runs(tree).map(text)).toEqual(["a ", " in ", " beside ", " and ", ", ", " again"]);
      for (const r of runs(tree)) {
        expect([r.type, r.props.contentEditable, r.props.spellCheck]).toEqual(["span", "plaintext-only", false]);
        // The words keep their spans in the run: a dragged image drops on a word's data-at.
        expect(byClass(r.props.children as ReactNode, "iv-word").map(text).join("")).toBe(text(r));
      }
      expect([...runs(tree), ...byClass(tree, "iv-word")].every((el) => el.props.onClick === undefined)).toBe(true);
      (run(" beside ", tree).props.onFocus as () => void)();
      expect(doc.onActive).toHaveBeenLastCalledWith(null);
    }
    expect(m.setView).not.toHaveBeenCalled();
    expect(doc.onCaret).not.toHaveBeenCalled();
  });

  it("commit on blur exactly their own slice of the text", () => {
    const r = run(" in ");
    type(r);
    leave(r, " painted in ");
    expect(m.setText).toHaveBeenCalledWith("a [Subject] painted in [Style] beside Reference image 1 and Reference image 2, [Subject] again");
    // Two runs alike (after the empty one a token opening the text leaves): the one typed into is the one changed.
    m.text = "[Subject] and [Style] and [Subject]";
    m.segments = parseSegments(m.text, VARS);
    const second = runs()[2];
    type(second);
    leave(second, " or ");
    expect(m.setText).toHaveBeenLastCalledWith("[Subject] and [Style] or [Subject]");
  });

  // Review 2026-10-29: nothing else reaches the places before, between and after tokens, now that no click opens the words.
  it("stand empty where a token opens or ends the text or two meet, so words can go there too", () => {
    m.text = "[Subject] walks in [Style]Reference image 1";
    m.segments = parseSegments(m.text, VARS);
    expect(runs().map(text)).toEqual(["", " walks in ", "", ""]);
    const typedAt = (j: number, words: string) => {
      const r = runs()[j];
      type(r);
      leave(r, words);
      return said();
    };
    expect(typedAt(0, "A ")).toBe("A [Subject] walks in [Style]Reference image 1");
    expect(typedAt(2, " beside ")).toBe("[Subject] walks in [Style] beside Reference image 1");
    expect(typedAt(3, ", calm")).toBe("[Subject] walks in [Style]Reference image 1, calm");
    // An empty run has no place for the browser's caret, which would land in the value beside it: the click goes in itself.
    const into = (words: string) => {
      const e = { preventDefault: vi.fn(), currentTarget: { textContent: words, focus: vi.fn() } };
      (runs()[0].props.onMouseDown as (e: unknown) => void)(e);
      return [e.preventDefault, e.currentTarget.focus].map((f) => f.mock.calls.length);
    };
    expect(into("")).toEqual([1, 1]);
    expect(into("A")).toEqual([0, 0]);
  });

  it("commit nothing when left untouched or typed back to the same words; a space typed as U+00A0 is a space", () => {
    let r = run(" beside ");
    type(r);
    leave(r, " beside ");
    expect(m.setText).not.toHaveBeenCalled();
    // The artist's own U+00A0 stays while nothing is typed: before an edit, and after one (the typing is the edit's alone).
    m.text = "a\u00a0quiet [Subject]";
    m.segments = parseSegments(m.text, VARS);
    const untouched = () => {
      const q = runs()[0];
      (q.props.onFocus as () => void)();
      leave(q, "a\u00a0quiet ");
    };
    untouched();
    expect(m.setText).not.toHaveBeenCalled();
    const q = runs()[0];
    type(q);
    leave(q, "a\u00a0quietly ");
    expect(m.setText).toHaveBeenCalledTimes(1);
    untouched();
    expect(m.setText).toHaveBeenCalledTimes(1);
    m.text = TEXT;
    m.segments = parseSegments(TEXT, VARS);
    r = run(" beside ");
    type(r);
    leave(r, " next\u00a0\u00a0to ");
    expect(m.setText).toHaveBeenLastCalledWith(TEXT.replace(" beside ", " next  to "));
  });

  it("commit on Enter, which adds no line; other keys type", () => {
    expect(calls(keyDown(run(" beside "), "Enter"))).toEqual([1, 0, 1]);
    expect(calls(keyDown(run(" beside "), "a"))).toEqual([0, 0, 0]);
  });

  // Review 2026-10-29: Enter that takes an IME's candidate must not end the edit (Chrome: isComposing; Safari: 229).
  it("leave a key that ends an IME's composition to the IME, in the words and in a value", () => {
    for (const el of [run(" beside "), tokens(draw(), "Subject")[0]]) {
      for (const k of ["Enter", "Escape"]) {
        expect(calls(keyDown(el, k, { isComposing: true }))).toEqual([0, 0, 0]);
        expect(calls(keyDown(el, k, { keyCode: 229 }))).toEqual([0, 0, 0]);
      }
      expect(calls(keyDown(el, "Enter"))).toEqual([1, 0, 1]);
    }
  });

  it("go back on Esc, nothing committed and the run drawn anew from the text; the Image View stays open", () => {
    const before = run(" beside ").key;
    const r = run(" beside ");
    type(r);
    expect(calls(keyDown(r, "Escape"))).toEqual([0, 1, 1]);
    leave(r, " next to ");
    expect(m.setText).not.toHaveBeenCalled();
    expect(run(" beside ").key).not.toBe(before);
    // Esc with nothing typed stays at the run too.
    expect(calls(keyDown(run(" in "), "Escape"))).toEqual([0, 1, 1]);
    expect(m.setText).not.toHaveBeenCalled();
  });

  // React patches only what it drew: the run the browser typed into is drawn anew, the same words or not; the others
  // keep their nodes, so a click from one run into another lands.
  it("are drawn anew each time they are left after typing, that run only", () => {
    const keys = () => runs().map((el) => el.key);
    const first = keys();
    leave(run(" beside "), " beside ");
    expect(keys()).toEqual(first);
    let r = run(" beside ");
    type(r);
    leave(r, " beside ");
    const after = keys();
    expect(after.map((k, j) => k !== first[j])).toEqual([false, false, true, false, false, false]);
    // The same run once more (review 2026-10-29: a second edit on a reused node threw removeChild): a key it never had.
    r = run(" beside ");
    type(r);
    leave(r, " beside ");
    const again = keys();
    expect(again.map((k, j) => k !== after[j])).toEqual([false, false, true, false, false, false]);
    expect(again[2]).not.toBe(first[2]);
  });

  // Review 2026-10-29: keyed by index, a typed "[mood]" moved every later key, and the click that ended the edit, with
  // the typing after it, went to another run.
  it("leave every other part's key as it was when a commit adds a token or empties a run, each key its own", () => {
    const keys = () => (byClass(draw(), "iv-doc")[0].props.children as El[]).map((el) => el.key);
    const take = () => {
      m.text = said()!;
      m.segments = parseSegments(m.text, VARS);
    };
    const before = keys();
    expect(new Set(before).size).toBe(before.length);
    let r = run(" beside ");
    type(r);
    leave(r, " beside [mood] ");
    take();
    const after = keys();
    expect(new Set(after).size).toBe(after.length);
    expect(after).toHaveLength(before.length + 2);
    expect(after.slice(0, 4)).toEqual(before.slice(0, 4));
    expect(after[4]).not.toBe(before[4]);
    expect(after.slice(7)).toEqual(before.slice(5));
    // " in " emptied between [Subject] and [Style]: an empty run stands there, nothing else moves.
    r = run(" in ");
    type(r);
    leave(r, "");
    take();
    const emptied = keys();
    expect(new Set(emptied).size).toBe(emptied.length);
    expect(emptied.filter((k, j) => k !== after[j])).toHaveLength(1);
    expect(runs()[1].props.children).toEqual([]);
  });

  it("offer the artist's wording back once changed, not for a blank composer's own words", () => {
    expect(reset(draw())).toHaveLength(0);
    m.edited = true;
    const [back] = reset(draw());
    expect(back.props.onClick).toBe(m.resetText);
    expect(reset(draw(true))).toHaveLength(1);
    m.blank = true;
    expect(reset(draw())).toHaveLength(0);
    // The words' editor offers it under itself: once.
    m.blank = false;
    m.view = "text";
    expect(reset(draw())).toHaveLength(1);
  });

  it("offer Done editing only to a text view still held, which goes back to the document", () => {
    expect(link(draw())).toBeUndefined();
    expect(link(draw(true))).toBeUndefined();
    m.view = "text";
    const tree = draw();
    expect(nodes(tree).filter((el) => el.type === PromptMirror)).toHaveLength(1);
    expect(byClass(tree, "iv-doc")).toHaveLength(0);
    expect(text(link(tree))).toBe("Done editing");
    expect(text(link(draw(true)))).toBe("Done editing");
    press(link(tree)!);
    expect(m.setView).toHaveBeenLastCalledWith("filled");
    expect(doc.onActive).toHaveBeenCalledWith(null);
    expect(doc.onCaret).toHaveBeenCalledWith(null);
  });

  it("never turn the document into the words' editor", () => {
    const src = readFileSync(join(__dirname, "..", "..", "..", "..", "components", "image-view", "PromptPanel.tsx"), "utf8");
    expect(src).not.toContain('setView("text")');
    // The words' editor gets a caret only where it shows anyway, once Backspace or Delete took out the last token.
    expect(src).not.toMatch(/flushSync|focusField/);
    expect(src.match(/setSelectionRange/g)).toHaveLength(1);
  });

  it("show as words to edit, without the link, when the text has no slot and no image", () => {
    m.segments = parseSegments("a plain sentence", VARS);
    const tree = draw();
    expect(inDocument(m)).toBe(false);
    expect(nodes(tree).filter((el) => el.type === PromptMirror)).toHaveLength(1);
    expect(link(tree)).toBeUndefined();
  });

  it("open on the document, not on the words", () => {
    const MODEL = readFileSync(join(__dirname, "..", "..", "..", "..", "components", "image-view", "useImageViewModel.ts"), "utf8");
    expect(MODEL).toContain('const [view, setView] = useState<"text" | "filled">("filled");');
  });

  it("are explained on a desktop above the document, not on the phone", () => {
    expect(byClass(draw(), "iv-doc-hint").map(text)).toEqual(["Click the words to edit them · click a colored word or an image to change it"]);
    expect(byClass(draw(true), "iv-doc-hint")).toHaveLength(0);
    m.view = "text";
    expect(byClass(draw(), "iv-doc-hint")).toHaveLength(0);
  });
});

describe("a variable taken out by Backspace or Delete (Kev, 2026-10-29: \"wenn ich backspace oder entf mache an der variable, so soll variable verschwinden und variable inhalt drin bleiben\")", () => {
  const LIT = { ...variable("Lit", "checkbox"), description: "soft light" } as PromptVariable;
  const MORE = [...VARS, LIT, variable("Moods", "multi-select", [{ promptValue: "calm", visibleName: "Calm" }, { promptValue: "wild", visibleName: "Wild" }]),
    variable("Size", "slider"), variable("Photo", "image")];
  const put = (t: string) => {
    m.text = t;
    m.segments = parseSegments(t, MORE);
  };
  // Where the browser's caret stands in the node the key goes to: `caret` characters in, or a selection (null).
  let caret: number | null;
  let collapse: Mock;
  beforeEach(() => {
    caret = 0;
    collapse = vi.fn();
    vi.stubGlobal("getSelection", () => ({
      rangeCount: 1, isCollapsed: caret !== null, collapse,
      // A collapsed range at the caret, stretched back to the start of the node setStart(node, 0) names.
      getRangeAt: () => ({
        cloneRange: () => {
          let from: { textContent: string } | null = null;
          return { setStart: (node: { textContent: string }, at: number) => { if (at === 0) from = node; }, toString: () => from?.textContent.slice(0, caret!) ?? "" };
        },
      }),
    }));
  });
  afterEach(() => vi.unstubAllGlobals());
  const runs = () => byClass(draw(), "iv-run");
  const run = (said: string) => runs().find((el) => text(el) === said)!;
  const tok = (said: string) => byClass(draw(), "iv-tok").find((el) => text(el) === said)!;
  /** A key on a part whose node holds `dom` (what is drawn, when unset); `how`: an IME's, or held down. */
  const hit = (el: El, key: string, dom = text(el), how: { isComposing?: boolean; keyCode?: number; repeat?: boolean } = {}) => {
    const e = { key, keyCode: how.keyCode ?? 0, repeat: !!how.repeat, nativeEvent: { isComposing: !!how.isComposing }, preventDefault: vi.fn(), stopPropagation: vi.fn(), currentTarget: { textContent: dom, blur: vi.fn() } };
    (el.props.onKeyDown as (e: unknown) => void)(e);
    return e;
  };
  const said = () => (m.setText as Mock).mock.lastCall?.[0] as string | undefined;
  const handled = (e: ReturnType<typeof hit>) => e.preventDefault.mock.calls.length;
  type Text = { textContent: string };
  /** The draw after the key, its text taken, and its layout effect run: the run it put the focus in, and that run's words before the caret. */
  const land = () => {
    put(said()!);
    const box = byClass(draw(), "iv-doc")[0];
    // Each child its own text nodes; a run's as its words draw them, the word and then the space after it.
    const kids = (box.props.children as El[]).map((el) => ({
      said: text(el),
      focus: vi.fn(),
      texts: byClass(el.props.children as ReactNode, "iv-word")
        .flatMap((w) => (w.props.children as ReactNode[]).filter((c): c is string => typeof c === "string" && c !== ""))
        .map((t): Text => ({ textContent: t })),
    }));
    (box.props.ref as { current: unknown }).current = { children: kids };
    vi.stubGlobal("NodeFilter", { SHOW_TEXT: 4 });
    vi.stubGlobal("document", {
      createTreeWalker: (root: { texts: Text[] }, what: number) => {
        let n = what === 4 ? -1 : Infinity;
        return { get currentNode() { return root.texts[n]; }, nextNode: () => root.texts[++n] ?? null };
      },
    });
    ui.effect!();
    const into = kids.filter((k) => k.focus.mock.calls.length);
    // The focus scrolls nothing: the caret goes where the token stood, on screen when the key went down.
    const scrolls = into.some((k) => k.focus.mock.calls.some(([o]) => (o as FocusOptions | undefined)?.preventScroll !== true));
    if (into.length !== 1 || collapse.mock.calls.length !== 1 || scrolls) return { focused: into.length, collapsed: collapse.mock.calls.length, scrolls };
    const [node, at] = collapse.mock.lastCall as [unknown, number];
    const k = into[0].texts.indexOf(node as Text);
    const before = node === into[0] ? "".padEnd(at, "?") : k < 0 ? "elsewhere" : into[0].texts.slice(0, k).map((t) => t.textContent).join("") + (node as Text).textContent.slice(0, at);
    return { run: into[0].said, before };
  };

  it("Backspace at a run's start leaves the variable before it as its value, the caret after it; Delete at a run's end the one after, the caret before it", () => {
    let e = hit(run(" in "), "Backspace");
    expect(said()).toBe("a a fox in [Style] beside Reference image 1 and Reference image 2, [Subject] again");
    expect(handled(e)).toBe(1);
    expect(land()).toEqual({ run: "a a fox in ", before: "a a fox" });
    put(TEXT);
    collapse.mockClear();
    caret = 4;
    e = hit(run(" in "), "Delete");
    expect(said()).toBe("a [Subject] in oil beside Reference image 1 and Reference image 2, [Subject] again");
    expect(handled(e)).toBe(1);
    expect(land()).toEqual({ run: " in oil beside ", before: " in " });
    expect(m.setText).toHaveBeenCalledTimes(2);
    expect(m.setValue).not.toHaveBeenCalled();
  });

  it("puts the caret in once the words are drawn, and only once", () => {
    hit(run(" in "), "Backspace");
    // A draw of the text before the key moves nothing: the document's, walked, so its effect is the one run.
    nodes(draw());
    vi.stubGlobal("document", { createTreeWalker: vi.fn() });
    ui.effect!();
    expect(collapse).not.toHaveBeenCalled();
    expect(land()).toEqual({ run: "a a fox in ", before: "a a fox" });
    // The next draw leaves the caret to the browser.
    ui.effect!();
    expect(collapse).toHaveBeenCalledTimes(1);
  });

  it("an empty run's start is its end: Backspace takes out the variable before it, Delete the one after", () => {
    put("[Subject][Style]");
    expect(runs().map(text)).toEqual(["", "", ""]);
    expect(handled(hit(runs()[1], "Backspace"))).toBe(1);
    expect(said()).toBe("a fox[Style]");
    expect(land()).toEqual({ run: "a fox", before: "a fox" });
    put("[Subject][Style]");
    collapse.mockClear();
    expect(handled(hit(runs()[1], "Delete"))).toBe(1);
    expect(said()).toBe("[Subject]oil");
    expect(land()).toEqual({ run: "oil", before: "" });
    // The run after the last token: the caret ends the words.
    put("Reference image 1 and a fox called [Subject]");
    collapse.mockClear();
    hit(runs()[2], "Backspace");
    expect(said()).toBe("Reference image 1 and a fox called a fox");
    expect(land()).toEqual({ run: " and a fox called a fox", before: " and a fox called a fox" });
  });

  it("a text value: Backspace at its start or Delete at its end leaves what is typed in it, nothing committed; inside it, keys type", () => {
    const subject = () => tokens(draw(), "Subject")[0];
    let e = hit(subject(), "Backspace", " a hare ");
    expect(said()).toBe("a a hare in [Style] beside Reference image 1 and Reference image 2, [Subject] again");
    expect(handled(e)).toBe(1);
    // The node gets its own value back: a blur, or the same variable drawn in it again, commits nothing typed.
    expect(e.currentTarget.textContent).toBe("a fox");
    expect(m.setValue).not.toHaveBeenCalled();
    expect(land()).toEqual({ run: "a a hare in ", before: "a " });
    put(TEXT);
    collapse.mockClear();
    caret = 6;
    e = hit(subject(), "Delete", "a hare");
    expect(said()).toBe("a a hare in [Style] beside Reference image 1 and Reference image 2, [Subject] again");
    expect(land()).toEqual({ run: "a a hare in ", before: "a a hare" });
    // Its end is the end of what the node holds, a space typed after the words too (review 2026-10-30).
    put(TEXT);
    caret = 6;
    expect(handled(hit(subject(), "Delete", "a hare "))).toBe(0);
    caret = 7;
    e = hit(subject(), "Delete", "a hare ");
    expect([handled(e), said()]).toEqual([1, "a a hare in [Style] beside Reference image 1 and Reference image 2, [Subject] again"]);
    put(TEXT);
    // Inside it, at its end for Backspace, at its start for Delete: the browser's.
    const calls = (m.setText as Mock).mock.calls.length;
    for (const [at, key] of [[2, "Backspace"], [2, "Delete"], [6, "Backspace"], [0, "Delete"]] as const) {
      caret = at;
      e = hit(subject(), key, "a hare");
      expect([handled(e), e.currentTarget.textContent]).toEqual([0, "a hare"]);
    }
    expect(m.setText).toHaveBeenCalledTimes(calls);
  });

  it("a choice, a checkbox, a multi-choice or a slider that has the focus leaves the words it sends", () => {
    const e = hit(tok("Oil"), "Backspace");
    expect(said()).toBe("a [Subject] in oil beside Reference image 1 and Reference image 2, [Subject] again");
    expect(handled(e)).toBe(1);
    expect(land()).toEqual({ run: " in oil beside ", before: " in oil" });
    put(TEXT);
    collapse.mockClear();
    hit(tok("Oil"), "Delete");
    expect(land()).toEqual({ run: " in oil beside ", before: " in " });
    m.values = { Lit: "true", Moods: "calm,wild", Size: "7" };
    for (const [t, out] of [["by [Lit] now", "by soft light now"], ["in [Moods] now", "in calm,wild now"], ["at [Size] now", "at 7 now"]]) {
      put(t);
      const [b] = byClass(draw(), "iv-tok");
      expect(b.type).toBe("button");
      hit(b, "Backspace");
      expect(said()).toBe(out);
    }
    // An unticked checkbox sends nothing: it goes, nothing left.
    m.values.Lit = "false";
    put("by [Lit] now");
    hit(byClass(draw(), "iv-tok")[0], "Delete");
    expect(said()).toBe("by  now");
    // Other keys on it do nothing.
    m.values = { Style: "oil" };
    put(TEXT);
    const calls = (m.setText as Mock).mock.calls.length;
    for (const k of ["a", "Enter", " "]) expect(handled(hit(tok("Oil"), k))).toBe(0);
    expect(m.setText).toHaveBeenCalledTimes(calls);
  });

  it("an empty value takes the variable out and leaves nothing", () => {
    m.values = { Subject: "", Style: "" };
    hit(run(" in "), "Backspace");
    expect(said()).toBe("a  in [Style] beside Reference image 1 and Reference image 2, [Subject] again");
    hit(tokens(draw(), "Subject")[0], "Delete", "");
    expect(said()).toBe("a  in [Style] beside Reference image 1 and Reference image 2, [Subject] again");
    hit(tok("Style"), "Backspace");
    expect(said()).toBe("a [Subject] in  beside Reference image 1 and Reference image 2, [Subject] again");
    // Spaces alone are no value: nothing is left of them either.
    m.values = { Subject: "   " };
    hit(run(" in "), "Backspace");
    expect(said()).toBe("a  in [Style] beside Reference image 1 and Reference image 2, [Subject] again");
  });

  it("only from that one place: the same variable elsewhere keeps its token and its value", () => {
    hit(run(" again"), "Backspace");
    expect(said()).toBe("a [Subject] in [Style] beside Reference image 1 and Reference image 2, a fox again");
    caret = 0;
    hit(tokens(draw(), "Subject")[1], "Backspace", "a hare");
    expect(said()).toBe("a [Subject] in [Style] beside Reference image 1 and Reference image 2, a hare again");
    expect(m.setValue).not.toHaveBeenCalled();
  });

  it("keeps the words typed in the run and not yet left, a space typed as U+00A0 a space, and draws that run anew", () => {
    const before = run(" in ").key;
    const r = run(" in ");
    (r.props.onInput as () => void)();
    hit(r, "Backspace", " painted\u00a0in ");
    expect(said()).toBe("a a fox painted in [Style] beside Reference image 1 and Reference image 2, [Subject] again");
    expect(run(" in ").key).not.toBe(before);
    // The typing went with it: the blur of the run it was typed in commits nothing more.
    (r.props.onBlur as (e: unknown) => void)({ currentTarget: { textContent: " painted in " } });
    expect(m.setText).toHaveBeenCalledTimes(1);
    // Delete at the end of the typed run: the caret after the typing, before the value (review 2026-10-30).
    put(TEXT);
    collapse.mockClear();
    const typed = run(" in ");
    (typed.props.onInput as () => void)();
    caret = 6;
    hit(typed, "Delete", " in QQ");
    expect(said()).toBe("a [Subject] in QQoil beside Reference image 1 and Reference image 2, [Subject] again");
    expect(land()).toEqual({ run: " in QQoil beside ", before: " in QQ" });
    caret = 0;
    // Nothing typed: the run's own words, the artist's U+00A0 kept.
    put(TEXT.replace(" in ", " in\u00a0"));
    hit(runs()[1], "Backspace");
    expect(said()).toBe("a a fox in\u00a0[Style] beside Reference image 1 and Reference image 2, [Subject] again");
  });

  it("does nothing with a selection, beside an image, away from the edge, or for an IME", () => {
    const none = (e: ReturnType<typeof hit>) => expect(handled(e)).toBe(0);
    caret = null;
    none(hit(run(" in "), "Backspace"));
    none(hit(run(" in "), "Delete", ""));
    none(hit(tokens(draw(), "Subject")[0], "Backspace"));
    // An image before or after the run: a reference keeps its Remove in the panel.
    caret = 0;
    none(hit(run(" and "), "Backspace"));
    caret = 8;
    none(hit(run(" beside "), "Delete"));
    // Nothing before the first run, nothing after the last.
    caret = 0;
    none(hit(run("a "), "Backspace"));
    caret = 6;
    none(hit(run(" again"), "Delete"));
    // Off the edge.
    caret = 1;
    none(hit(run(" in "), "Backspace"));
    caret = 3;
    none(hit(run(" in "), "Delete"));
    // An IME's key (Chrome: isComposing; Safari: 229), in a run, in a text value, on a button.
    caret = 0;
    for (const ime of [{ isComposing: true }, { keyCode: 229 }]) {
      none(hit(run(" in "), "Backspace", " in ", ime));
      none(hit(tokens(draw(), "Subject")[0], "Backspace", "a fox", ime));
      none(hit(tok("Oil"), "Delete", "Oil", ime));
    }
    // A key held down: it stops at the variable, as the browser stops it at an edge, so a held Backspace that clears a
    // value leaves the variable and the words before it (review 2026-10-30).
    none(hit(run(" in "), "Backspace", " in ", { repeat: true }));
    none(hit(tokens(draw(), "Subject")[0], "Backspace", "", { repeat: true }));
    none(hit(tok("Oil"), "Delete", "Oil", { repeat: true }));
    // An image variable: no words to leave.
    put("a [Photo] here");
    none(hit(runs()[1], "Backspace"));
    none(hit(byClass(draw(), "iv-tok")[0], "Backspace"));
    expect(m.setText).not.toHaveBeenCalled();
  });

  // Review 2026-10-30: the last token out, the document gave way to the words' editor and the caret fell to the page.
  it("the last token out: the words' editor shows, the caret in it at the join, once", () => {
    for (const [t, key, at, out] of [
      ["a portrait of [Subject] at dusk", "run", 19, "a portrait of a fox at dusk"],
      ["a portrait of [Subject] at dusk", "value", 14, "a portrait of a fox at dusk"],
      ["a portrait in [Style] at dusk", "choice", 14, "a portrait in oil at dusk"],
    ] as const) {
      put(t);
      if (key === "run") hit(run(" at dusk"), "Backspace");
      else if (key === "value") hit(tokens(draw(), "Subject")[0], "Backspace", "a fox");
      else hit(tok("Oil"), "Delete");
      expect(said()).toBe(out);
      const field = { focus: vi.fn(), setSelectionRange: vi.fn() };
      const place = (shown: string) => {
        put(shown);
        const [editor] = nodes(draw()).filter((el) => el.type === PromptMirror);
        (editor.props.ref as { current: unknown }).current = field;
        ui.effect!();
      };
      // A draw of another text moves nothing.
      place("a portrait");
      expect(field.focus).not.toHaveBeenCalled();
      place(out);
      expect(field.focus).toHaveBeenCalledTimes(1);
      expect(field.setSelectionRange).toHaveBeenCalledWith(at, at);
      // The caret first: the focus then scrolls a long text's field to it.
      expect(field.setSelectionRange.mock.invocationCallOrder[0]).toBeLessThan(field.focus.mock.invocationCallOrder[0]);
      place(out);
      expect(field.setSelectionRange).toHaveBeenCalledTimes(1);
    }
  });

  it("closes the panel open for that variable, and no other", () => {
    doc.active = { kind: "var", key: "Style" };
    hit(run(" in "), "Backspace");
    expect(doc.onActive).not.toHaveBeenCalled();
    doc.active = { kind: "var", key: "Subject" };
    hit(run(" in "), "Backspace");
    expect(doc.onActive).toHaveBeenCalledWith(null);
  });
});

describe("the document's styles", () => {
  const CSS = readFileSync(join(__dirname, "..", "..", "..", "..", "components", "image-view", "image-view.css"), "utf8");
  const PHONE = readFileSync(join(__dirname, "..", "..", "..", "..", "components", "image-view", "image-view-mobile.css"), "utf8");

  it("tint a variable 9 %, 16 % while picked, on a dashed line, radius 6, padding 1px 5px, green once changed", () => {
    expect(CSS).toMatch(/\.iv-tok \{[^}]*padding: 1px 5px;[^}]*border-bottom: 2px dashed color-mix\(in oklab, var\(--iv-tone\) 55%, transparent\);[^}]*border-radius: 6px;[^}]*background: color-mix\(in oklab, var\(--iv-tone\) 9%, transparent\);/);
    expect(CSS).toContain(".iv-tok[data-changed] { --iv-tone: var(--enki-green); }");
    expect(CSS).toMatch(/\.iv-tok\[data-on\],\n\.iv-tok:focus-visible \{ background: color-mix\(in oklab, var\(--iv-tone\) 16%, transparent\); \}/);
  });

  // Kev, 2026-10-29: "just lemme change texts without the UI actually changing at all".
  it("show a run's focus as its caret alone, keep the document's spaces, and give a panel's field the row", () => {
    expect(CSS).toContain(".iv-run { outline: 0; cursor: text; }");
    expect(CSS).not.toMatch(/\.iv-run(?!:empty)[^{]*\{[^}]*(border|background|box-shadow|padding)/);
    // An empty run is 1ch to click into; at the start it sits left of the text, so the first line keeps its place.
    expect(CSS).toContain(".iv-run:empty { padding-inline-end: 1ch; }");
    expect(CSS).toContain(".iv-run:empty:first-child { margin-inline-start: -1ch; }");
    // A touch screen draws the words 16 px, where iOS stops zooming on the tap into them (the kit's rule).
    expect(PHONE).toContain("@media (pointer: coarse) { .iv-mobile .iv-doc { font-size: 16px; } }");
    expect(CSS).toMatch(/\.iv-doc \{[^}]*white-space: pre-wrap;/);
    expect(CSS).toContain(".iv-active .kit-field { flex: 1 1 260px; }");
  });

  it("draw an image 36 px with radius 10, 30 px with radius 8 on the phone", () => {
    expect(CSS).toMatch(/\.iv-tok-img \{[^}]*width: 36px;\n  height: 36px;[^}]*border-radius: 10px;/);
    expect(PHONE).toContain(".iv-mobile .iv-tok-img { width: 30px; height: 30px; border-radius: 8px; }");
  });

  it("keep the composer's head on one line: the legend goes below 469 px, then \"at cursor\"", () => {
    expect(CSS).toMatch(/\.iv-mode-head \{[^}]*container-type: inline-size;/);
    expect(CSS).toContain("@container (max-width: 468.98px) { .iv-legend { display: none; } }");
    expect(CSS).toContain("@container (max-width: 364.98px) { .iv-v2 .iv-refimg-at { display: none; } }");
    expect(CSS).toContain("@container (max-width: 334.98px) { .iv-mobile .iv-refimg-at { display: none; } }");
    expect(CSS).toContain("@container (max-width: 295.98px) { .iv-mode-count { display: none; } }");
    expect(CSS).toContain("@container (max-width: 269.98px) { .iv-refimg-word { display: none; } }");
    expect(CSS).toMatch(/\.iv-refimg \{[^}]*flex-shrink: 0;[^}]*white-space: nowrap;/);
  });

  it("pin the panel to the scroller's foot and hold back the more-settings pill while it shows", () => {
    expect(CSS).toMatch(/\.iv-active \{\n  position: sticky;\n  bottom: 0;/);
    expect(CSS).toContain("[data-scroll]:has(.iv-active) .iv-more { display: none; }");
  });
});

describe("moving an image by drag (Kev, 2026-10-26: \"i want to move the images too that are there with the vorschau im text\")", () => {
  let keys: ((e: { key: string }) => void)[];
  // Whether each key listener listens first (capture): the Image View's own Esc must never see a drag's Esc.
  let firsts: unknown[];
  let el: { setPointerCapture: ReturnType<typeof vi.fn>; setAttribute: ReturnType<typeof vi.fn>; removeAttribute: ReturnType<typeof vi.fn> };
  // The word under the pointer: a click on it would put the cursor at its end, so a drop lands there.
  let under: string | null;
  beforeEach(() => {
    keys = [];
    firsts = [];
    under = "1";
    el = { setPointerCapture: vi.fn(), setAttribute: vi.fn(), removeAttribute: vi.fn() };
    vi.stubGlobal("window", {
      addEventListener: (_: string, f: (e: { key: string }) => void, capture?: unknown) => { keys.push(f); firsts.push(capture); },
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal("document", {
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      elementFromPoint: () => ({ closest: () => (under === null ? null : { dataset: { at: under } }) }),
    });
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
  const call = (tok: El, name: string, e: Record<string, unknown> = {}) =>
    (tok.props[name] as (e: unknown) => void)({ pointerId: 1, clientX: 0, clientY: 0, pointerType: "mouse", currentTarget: el, ...e });
  const first = () => byClass(draw(), "iv-tok-img")[0];

  it("lifts with a mouse after 4 px, shows where it lands, and a drop moves it there, its \" and \" going with it", () => {
    const one = first();
    call(one, "onPointerDown");
    call(one, "onPointerMove", { clientX: 4 });
    expect(el.setAttribute).not.toHaveBeenCalled();
    call(one, "onPointerMove", { clientX: 5 });
    expect(el.setAttribute).toHaveBeenCalledWith("data-dragged", "");
    call(one, "onPointerMove", { clientX: 40 });
    expect(doc.onCaret).toHaveBeenLastCalledWith(1);
    call(one, "onPointerUp");
    const moved = moveRef(TEXT, TEXT.indexOf("Reference image 1"), 1)!.text;
    expect(moved).toBe("a Reference image 1 [Subject] in [Style] beside Reference image 2, [Subject] again");
    expect(m.setText).toHaveBeenCalledWith(moved);
    expect(doc.onCaret).toHaveBeenLastCalledWith(null);
    expect(el.removeAttribute).toHaveBeenCalledWith("data-dragged");
    // The click that ends the drag opens nothing; the next one does.
    press(one);
    expect(doc.onActive).not.toHaveBeenCalled();
    press(one);
    expect(doc.onActive).toHaveBeenCalledWith({ kind: "ref", n: 1 });
  });

  it("lifts with a finger only after a 400 ms hold; a finger that moves 8 px first is scrolling", () => {
    vi.useFakeTimers();
    let one = first();
    call(one, "onPointerDown", { pointerType: "touch" });
    call(one, "onPointerMove", { pointerType: "touch", clientY: 9 });
    vi.advanceTimersByTime(500);
    expect(el.setAttribute).not.toHaveBeenCalled();
    one = first();
    call(one, "onPointerDown", { pointerType: "touch" });
    vi.advanceTimersByTime(399);
    expect(el.setAttribute).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(el.setAttribute).toHaveBeenCalledWith("data-dragged", "");
  });

  // Review 2026-10-29: a finger's hold blurs nothing, so a drag over words still being typed threw in React or lost them.
  it("commits words typed and not yet left before it lifts, a finger's hold as a mouse's press", () => {
    vi.useFakeTimers();
    const typing = { isContentEditable: true, blur: vi.fn() };
    Object.assign(document, { activeElement: typing });
    call(first(), "onPointerDown", { pointerType: "touch" });
    vi.advanceTimersByTime(400);
    expect(typing.blur).toHaveBeenCalledTimes(1);
    expect(typing.blur.mock.invocationCallOrder[0]).toBeLessThan(el.setAttribute.mock.invocationCallOrder[0]);
    // What takes no typing (the image a mouse's press focused) keeps its focus.
    const button = { isContentEditable: false, blur: vi.fn() };
    Object.assign(document, { activeElement: button });
    const one = first();
    call(one, "onPointerDown");
    call(one, "onPointerMove", { clientX: 5 });
    expect(el.setAttribute).toHaveBeenCalledTimes(2);
    expect(button.blur).not.toHaveBeenCalled();
  });

  // Review 2026-10-29: the press's blur commits words before the image, so where it started at the press is stale.
  it("moves the image from where it stands at the drop, after the words a press committed moved it", () => {
    const one = first();
    call(one, "onPointerDown");
    m.text = TEXT.replace(" beside ", " right beside ");
    m.segments = parseSegments(m.text, VARS);
    const now = first();
    call(now, "onPointerMove", { clientX: 5 });
    call(now, "onPointerMove", { clientX: 40 });
    call(now, "onPointerUp");
    expect(m.setText).toHaveBeenCalledWith(moveRef(m.text, m.text.indexOf("Reference image 1"), 1)!.text);
  });

  it("puts it back on Esc, and a drop off the words moves nothing", () => {
    let one = first();
    call(one, "onPointerDown");
    call(one, "onPointerMove", { clientX: 10 });
    // Over a word: a drop is armed, then Esc takes it back, first and alone (the Image View's own Esc would close it).
    call(one, "onPointerMove", { clientX: 40 });
    expect(doc.onCaret).toHaveBeenLastCalledWith(1);
    const esc = { key: "Escape", stopPropagation: vi.fn() };
    keys.forEach((k) => k(esc));
    expect(esc.stopPropagation).toHaveBeenCalled();
    expect(firsts).toEqual([true]);
    expect(el.removeAttribute).toHaveBeenCalledWith("data-dragged");
    expect(doc.onCaret).toHaveBeenLastCalledWith(null);
    call(one, "onPointerUp");
    expect(m.setText).not.toHaveBeenCalled();
    under = null;
    one = first();
    call(one, "onPointerDown");
    call(one, "onPointerMove", { clientX: 10 });
    call(one, "onPointerMove", { clientX: 60 });
    call(one, "onPointerUp");
    expect(m.setText).not.toHaveBeenCalled();
  });
});

it("a held image neither opens the phone's image menu nor scrolls, and fades while it is dragged", () => {
  const css = readFileSync(join(__dirname, "..", "..", "..", "..", "components", "image-view", "image-view.css"), "utf8");
  expect(css).toContain("button.iv-tok-img { -webkit-touch-callout: none; -webkit-user-select: none; user-select: none; touch-action: manipulation; }");
  expect(css).toContain(".iv-tok-img[data-dragged] { opacity: 0.35; }");
});

it("marks each word with the index a click on it sets, the drop target of a dragged image", () => {
  const words = byClass(PromptPanel({ model: m, phone: false, doc }), "iv-word");
  const beside = words.find((el) => text(el).startsWith("beside"))!;
  expect(beside.props["data-at"]).toBe(TEXT.indexOf("beside") + "beside".length);
  expect(words.every((el) => typeof el.props["data-at"] === "number")).toBe(true);
});

it("a hold lifts an image instead of opening the browser's image menu (Android; review 2026-10-26)", () => {
  const panel = readFileSync(join(__dirname, "..", "..", "..", "..", "components", "image-view", "PromptPanel.tsx"), "utf8");
  expect(panel).toContain("onContextMenu={(e) => e.preventDefault()}");
  const css = readFileSync(join(__dirname, "..", "..", "..", "..", "components", "image-view", "image-view.css"), "utf8");
  expect(css).toContain("button.iv-tok-img img { pointer-events: none; }");
});
