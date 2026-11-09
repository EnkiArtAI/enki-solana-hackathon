import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { readSource } from "@/lib/__tests__/_read-source";
import type { PromptVariable } from "@/lib/ui/kit/fields";

/**
 * Easy's variables (image UI v2, handoff §5.7, plan B8): the creator's value
 * in ember, the buyer's own in green with "● yours" and "reset", on a dashed
 * line; and "↓ N more settings" while rows are still under the fold. The
 * marker is opt-in: VariableField draws it only when asked.
 */
const ui = vi.hoisted(() => ({ state: [] as unknown[], s: 0 }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useId: () => "field",
  useState: <T>(start: T) => {
    const i = ui.s++;
    if (!(i in ui.state)) ui.state[i] = start;
    return [ui.state[i] as T, (next: T) => { ui.state[i] = next; }];
  },
  useRef: <T>(start: T) => ({ current: start }),
  useEffect: () => {},
}));
vi.mock("@/components/kit/AutosizeTextarea", () => ({ default: () => null }));
vi.mock("@/components/kit/PillMenu", () => ({ default: () => null }));

import VariableField from "@/components/kit/VariableField";
import MoreBelow from "@/components/image-view/MoreBelow";

type El = ReactElement<Record<string, unknown>>;
function* walk(node: ReactNode): Generator<El> {
  if (Array.isArray(node)) for (const n of node) yield* walk(n);
  else if (isValidElement<Record<string, unknown>>(node)) { yield node; yield* walk(node.props.children as ReactNode); }
}
const byClass = (tree: ReactNode, name: string) => [...walk(tree)].filter((el) => el.props.className === name);
const outfit = { id: "v", name: "outfit", label: "Outfit", description: "", type: "text", defaultValue: "black turtleneck", required: false, position: 0, min: null, max: null, options: null } as PromptVariable;
const field = (changed?: boolean, onReset?: () => void) =>
  VariableField({ variable: outfit, value: "red coat", onChange: vi.fn(), growOnly: false, onUserInput: vi.fn(), changed, onReset }) as El;

beforeEach(() => { ui.state = []; ui.s = 0; });

describe("a variable", () => {
  it("says the value is the buyer's own and offers the creator's back", () => {
    const onReset = vi.fn();
    const tree = field(true, onReset);
    expect(tree.props["data-changed"]).toBe(true);
    expect(byClass(tree, "kit-field-yours")[0].props.children).toBe("● yours");
    (byClass(tree, "kit-field-reset")[0].props.onClick as () => void)();
    expect(onReset).toHaveBeenCalledOnce();
  });

  it("offers no reset where the caller has none to give", () => {
    const tree = field(true);
    expect(byClass(tree, "kit-field-yours")).toHaveLength(1);
    expect(byClass(tree, "kit-field-reset")).toHaveLength(0);
  });

  it("says nothing while it is the creator's value, nor when the caller does not ask", () => {
    for (const tree of [field(false, vi.fn()), field()]) {
      expect(tree.props["data-changed"]).toBeUndefined();
      expect(byClass(tree, "kit-field-yours")).toHaveLength(0);
      expect(byClass(tree, "kit-field-reset")).toHaveLength(0);
    }
  });
});

describe("the model", () => {
  const MODEL = readSource(join(__dirname, "..", "..", "..", "..", "components", "image-view", "useImageViewModel.ts"));
  it("calls a value the buyer's own when it differs from the prompt's, and reset drops the buyer's edit", () => {
    expect(MODEL).toContain('changed: (key: string) => (values[key] ?? "") !== (defaults[key] ?? ""),');
    expect(MODEL).toMatch(/resetValue: \(key: string\) =>\n\s+setOverrides\(\(o\) => \{\n\s+const next = \{ \.\.\.o \};\n\s+delete next\[key\];\n\s+return next;/);
    const panel = readSource(join(__dirname, "..", "..", "..", "..", "components", "image-view", "PromptPanel.tsx"));
    expect(panel).toContain("changed={m.changed(f.key)} onReset={() => m.resetValue(f.key)}");
  });
});

describe("more settings below", () => {
  const draw = () => { ui.s = 0; return MoreBelow() as El; };
  it("says how many rows are under the fold, or More below, and hides while a field is edited", () => {
    expect(draw().props.hidden).toBe(true);
    ui.state[0] = 3;
    expect(byClass(draw(), "iv-more-pill")[0].props.children).toBe("↓ 3 more settings");
    ui.state[0] = -1;
    expect(byClass(draw(), "iv-more-pill")[0].props.children).toBe("↓ More below");
    ui.state[1] = true;
    expect(draw().props.hidden).toBe(true);
  });

  it("measures the variable rows of its own scroller as it scrolls and resizes", () => {
    const src = readSource(join(__dirname, "..", "..", "..", "..", "components", "image-view", "MoreBelow.tsx"));
    expect(src).toContain('rowTops: [...scroller.querySelectorAll("[data-iv-field]")].map((r) => r.getBoundingClientRect().top),');
    expect(src).toContain('scroller.addEventListener("scroll", measure, { passive: true });');
    expect(src).toContain('const focus = (e: FocusEvent) => setActive(e.type === "focusin" && !!(e.target as Element | null)?.closest("[data-iv-field]"));');
    expect(src).toContain('scroller?.scrollBy({ top: moreStep(scroller.clientHeight), behavior: "smooth" });');
    for (const view of ["ImageViewDesktop.tsx", "ImageViewMobile.tsx"]) {
      expect(readSource(join(__dirname, "..", "..", "..", "..", "components", "image-view", view)), view).toContain("<MoreBelow />");
    }
  });
});

describe("the styles", () => {
  const CSS = readFileSync(join(__dirname, "..", "..", "..", "..", "components", "image-view", "image-view.css"), "utf8");
  it("draw the value ember on a dashed line, green once it is the buyer's own, solid while typing", () => {
    expect(CSS).toContain(".iv-easy .kit-field { --iv-tone: var(--enki-ember);");
    expect(CSS).toContain(".iv-easy .kit-field[data-changed] { --iv-tone: var(--enki-green); }");
    expect(CSS).toContain("border-bottom: 2px dashed color-mix(in oklab, var(--iv-tone) 55%, transparent);");
    expect(CSS).toContain(".iv-easy .kit-field-text:focus { border-bottom-style: solid; border-color: var(--iv-tone); }");
  });
  it("pin the pill to the scroller's foot without taking room", () => {
    expect(CSS).toContain(".iv-more { position: sticky; bottom: 8px; z-index: 4; display: flex; justify-content: center; height: 34px; margin-top: -34px; pointer-events: none; }");
  });
});
