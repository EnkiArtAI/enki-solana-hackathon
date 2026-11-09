import { describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import type { CatalogueEntry } from "@/hooks/useModelLimits";

/**
 * "for generators on offer, i also need an option saying 'all' at the top that just selects them all" (Kev,
 * 2026-10-26): the menu's first row ticks every generator, and takes them all off again when every one is on.
 */
vi.mock("@/components/kit/PillMenu", () => ({ default: () => null }));
vi.mock("@/components/generation/GeneratorLogo", () => ({ default: () => null }));

import PillMenu from "@/components/kit/PillMenu";
import GeneratorRow from "@/components/prompt-editor/GeneratorRow";

type El = ReactElement<Record<string, unknown>>;
function* walk(node: ReactNode): Generator<El> {
  if (Array.isArray(node)) for (const n of node) yield* walk(n);
  else if (isValidElement<Record<string, unknown>>(node)) { yield node; yield* walk(node.props.children as ReactNode); }
}
const models = ["1", "2", "3"].map((id) => ({ id, name: `Model ${id}`, free: false }) as CatalogueEntry);
const menu = (selected: string[], locked = false) => {
  const onToggle = vi.fn();
  const onAll = vi.fn();
  const el = [...walk(GeneratorRow({ models, selected, locked, prices: [null, null, null], onToggle, onAll }))].find((e) => e.type === PillMenu)!;
  return { props: el.props as { options: { key: string; label: string }[]; selected: string[]; onPick: (k: string) => void }, onToggle, onAll };
};

describe("the All row of generators on offer", () => {
  it("comes first, then every generator in catalogue order", () => {
    expect(menu([]).props.options.map((o) => o.label)).toEqual(["All", "Model 1", "Model 2", "Model 3"]);
  });

  it("is ticked only while every generator is on", () => {
    const all = menu([]).props.options[0].key;
    expect(menu(["1", "2"]).props.selected).toEqual(["1", "2"]);
    expect(menu(["1", "2", "3"]).props.selected).toEqual([all, "1", "2", "3"]);
  });

  it("asks for all at once; a generator's row still toggles that one", () => {
    const { props, onAll, onToggle } = menu(["1"]);
    props.onPick(props.options[0].key);
    expect(onAll).toHaveBeenCalledOnce();
    expect(onToggle).not.toHaveBeenCalled();
    props.onPick("2");
    expect(onToggle).toHaveBeenCalledWith("2");
  });

  it("does nothing on a free prompt, where every generator is on anyway", () => {
    const { props, onAll, onToggle } = menu(["1", "2", "3"], true);
    props.onPick(props.options[0].key);
    expect([onAll.mock.calls.length, onToggle.mock.calls.length]).toEqual([0, 0]);
  });
});

describe("the word on a prompt that runs on every generator", () => {
  const words = (labels?: string[]) => {
    const el = [...walk(GeneratorRow({ models, selected: [], locked: true, prices: [null, null, null], labels, onToggle: vi.fn(), onAll: vi.fn() }))].find((e) => e.type === PillMenu)!;
    return { aria: el.props.ariaLabel, hint: el.props.hint };
  };
  it("a video is never called free (Kev, 2026-11-04: \"videos sind nicht umsonst. die kosten alle.\")", () => {
    expect(words(["$0.45", "$0.68", "$1.10"])).toEqual({ aria: "Every generator is on offer on an Open prompt", hint: "An Open prompt runs on every generator" });
  });
  it("an image keeps its words", () => {
    expect(words()).toEqual({ aria: "Every generator is on offer on a free prompt", hint: "A free prompt runs on every generator" });
  });
});
