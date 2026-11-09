import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import type { ReactElement } from "react";
import { readSource } from "@/lib/__tests__/_read-source";

/**
 * "a super tiny little bar at the very top of the UI so that i can just pull it down to close it" (Kev, 2026-10-26).
 */
vi.mock("react", async (original) => ({ ...(await original<typeof import("react")>()), useRef: <T>(start: T) => ({ current: start }) }));

import PullBar from "@/components/prompt-editor/PullBar";

const DIR = join(__dirname, "..", "..", "..", "components", "prompt-editor");
type Handlers = Record<"onPointerDown" | "onPointerMove" | "onPointerUp", (e: unknown) => void>;
const setup = (asks = false) => {
  const style = { translate: "", removeProperty: vi.fn(function (this: { translate: string }) { this.translate = ""; }) };
  const target = { current: { style } as unknown as HTMLElement };
  const onClose = vi.fn();
  const bar = PullBar({ target, asks, onClose }) as ReactElement<Handlers>;
  const at = (y: number) => ({ clientY: y, pointerId: 1, currentTarget: { setPointerCapture: vi.fn() } });
  return { style, onClose, h: bar.props, at };
};

describe("the editor's pull bar", () => {
  it("lets the editor follow the finger down, never up", () => {
    const { style, h, at } = setup();
    h.onPointerDown(at(100));
    h.onPointerMove(at(130));
    expect(style.translate).toBe("0 30px");
    h.onPointerMove(at(60));
    expect(style.translate).toBe("0 0px");
  });

  it("springs back short of the sheets' threshold, and closes past it, staying where it was let go", () => {
    const short = setup();
    short.h.onPointerDown(short.at(100)); short.h.onPointerMove(short.at(160)); short.h.onPointerUp({});
    expect(short.onClose).not.toHaveBeenCalled();
    expect(short.style.removeProperty).toHaveBeenCalledWith("translate");
    const long = setup();
    long.h.onPointerDown(long.at(100)); long.h.onPointerMove(long.at(161)); long.h.onPointerUp({});
    expect(long.onClose).toHaveBeenCalledOnce();
    expect(long.style.removeProperty).not.toHaveBeenCalled();
  });

  it("springs back under Back's question while renders run", () => {
    const { style, onClose, h, at } = setup(true);
    h.onPointerDown(at(100)); h.onPointerMove(at(200)); h.onPointerUp({});
    expect(onClose).toHaveBeenCalledOnce();
    expect(style.removeProperty).toHaveBeenCalledWith("translate");
  });

  it("sits at the very top of the editor on a phone only, closing as Back does", () => {
    expect(readSource(join(DIR, "PromptEditor.tsx"))).toContain('className="pe-root kit-focus" data-tab={tab} style={{ "--pe-split": `${split.value}px` } as CSSProperties}>\n      <PullBar target={root} asks={busy} onClose={leave} />');
    const css = readSource(join(DIR, "prompt-editor.css"));
    expect(css).toContain(".pe-pull { display: none; }");
    const phone = css.slice(css.indexOf("@media (max-width: 767.98px)"));
    expect(phone).toMatch(/  \.pe-pull \{ position: absolute; top: 0;[^}]*touch-action: none;/);
    expect(phone).toContain("  .pe-head { padding-top: max(20px, env(safe-area-inset-top)); }");
  });
});

it("springs back when the browser takes the touch away, however far it was pulled (review 2026-10-26)", () => {
  const style = { translate: "", removeProperty: vi.fn() };
  const onClose = vi.fn();
  const bar = PullBar({ target: { current: { style } as unknown as HTMLElement }, asks: false, onClose }) as ReactElement<Handlers & { onPointerCancel: (e: unknown) => void }>;
  const at = (y: number) => ({ clientY: y, pointerId: 1, currentTarget: { setPointerCapture: vi.fn() } });
  bar.props.onPointerDown(at(100));
  bar.props.onPointerMove(at(300));
  bar.props.onPointerCancel({});
  expect(onClose).not.toHaveBeenCalled();
  expect(style.removeProperty).toHaveBeenCalledWith("translate");
});

it("leaves Back its whole press where it reaches into the bar (review 2026-10-26)", () => {
  const css = readSource(join(DIR, "prompt-editor.css"));
  expect(css.slice(css.indexOf("@media (max-width: 767.98px)"))).toContain("  .pe-head .pe-back { position: relative; z-index: 2; }");
});
