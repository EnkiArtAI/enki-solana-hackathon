"use client";

import { useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { usePanelPos, panelStyle, placePanel } from "./panel-pos";
import BottomSheet from "./BottomSheet";
import { menuMode, typedPick } from "@/lib/ui/kit/controls";
import "./kit-controls.css";

export interface MenuOption {
  key: string;
  label: ReactNode;
  /** Right-aligned detail in mono: a price, "primary", "not on Flux". */
  sub?: string | null;
  /** A line under the label: what the option is for (opt-in, the Image View's settings, plan B4). */
  desc?: string | null;
  icon?: ReactNode;
  disabled?: boolean;
  title?: string;
}

/**
 * Every picker of the image UI: a pill that opens its options as a popover
 * from 1024 px up and as a bottom sheet below (asked when it opens, so render
 * output never depends on the width). The popover is portaled and fixed
 * (usePanelPos), measured before paint onto the side asked for and inside the
 * viewport, and closes on an outside press, Esc, scroll or resize. In the
 * sheet every option shows at once, a tap takes it and closes, the picked one
 * too (Kev, 2026-10-26: "ich will so wenig wie möglich scrollen müssen").
 */
export default function PillMenu({
  trigger, ariaLabel, title, hint, options, value, onPick, columns = 1, direction, disabled = false, selected,
  sheetHint, sheetColumns, typed,
}: {
  /** The pill's face; the caret is added. */
  trigger: ReactNode;
  /** Also the pill's hover text: several pills show only an icon. */
  ariaLabel: string;
  title: string;
  hint?: string;
  options: MenuOption[];
  value: string | null;
  onPick: (key: string) => void;
  columns?: 1 | 2;
  direction?: "up" | "down";
  disabled?: boolean;
  /** Several at once: each row is a checkbox, `onPick` toggles it, and the menu stays open (the editor's generators). */
  selected?: readonly string[];
  /** The sheet's hint below 1024 px, in place of `hint` (the Image View's settings). */
  sheetHint?: string;
  /** The sheet's options side by side: 2 for the formats, 4 for the counts, so all of them show; `columns` by default. */
  sheetColumns?: 1 | 2 | 4;
  /** Numbered options can also be typed (the count): the sheet's number field, labelled so; Set (or Enter) takes it. */
  typed?: string;
}) {
  const multi = selected !== undefined;
  const on = (key: string) => (multi ? selected.includes(key) : key === value);
  // usePanelPos's own row estimate only seeds the first frame: the layout
  // effect below measures and places the panel before it is painted.
  // A multi menu stays open while its rows are ticked, so it follows its trigger through a scroll instead of closing.
  const { pos, open, toggle, close, trigRef, wrapRef, panelRef } = usePanelPos(options.length, multi);
  const [sheet, setSheet] = useState(false);
  // Focus goes into the list when it opens, not again each time it is placed anew.
  const focused = useRef(false);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    const trig = trigRef.current;
    if (!pos || !panel || !trig) {
      focused.current = false;
      return;
    }
    placePanel(panel, trig, direction);
    if (!focused.current) {
      focused.current = true;
      (panel.querySelector<HTMLElement>('[aria-selected="true"]:not(:disabled)') ?? panel.querySelector<HTMLElement>("button:not(:disabled)"))
        ?.focus({ preventScroll: true });
    }
    return () => {
      if (!document.activeElement || document.activeElement === document.body) trig.focus({ preventScroll: true });
    };
  }, [pos, direction, panelRef, trigRef]);

  // A typed number is taken when it is one of the options and open to take; otherwise it says why and stays.
  const [typedWhy, setTypedWhy] = useState<string | null>(null);
  const shut = () => { setSheet(false); setTypedWhy(null); };
  const pick = (key: string) => {
    onPick(key);
    if (multi) return;
    close();
    shut();
  };
  // A form, so Set takes it on every keyboard: an iPhone's number pad has no Enter (review 2026-10-26).
  const takeTyped = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const typed = typedPick(options, String(new FormData(e.currentTarget).get("n") ?? ""));
    if ("key" in typed) pick(typed.key);
    else setTypedWhy(typed.why);
  };
  const list = (cols: number) => (
    <div className={`kit-opts${cols > 1 ? ` kit-opts--${cols}` : ""}`} role="listbox" aria-label={title} aria-multiselectable={multi || undefined}>
      {options.map((o) => (
        <button key={o.key} type="button" role="option" aria-selected={on(o.key)} disabled={o.disabled}
          title={o.title} className="kit-opt" onClick={() => pick(o.key)}>
          {multi && <span className="kit-check" aria-hidden />}
          {o.icon}
          {o.desc ? <span className="kit-opt-text"><span>{o.label}</span><span className="kit-opt-desc">{o.desc}</span></span> : <span>{o.label}</span>}
          {o.sub && <span className="kit-opt-sub">{o.sub}</span>}
        </button>
      ))}
    </div>
  );

  return (
    <div ref={wrapRef} className="kit-menu">
      <button ref={trigRef} type="button" className="kit-pill kit-hit kit-focus" aria-label={ariaLabel} title={ariaLabel}
        aria-haspopup="listbox" aria-expanded={open || sheet} disabled={disabled}
        onClick={() => (menuMode(window) === "sheet" ? setSheet(true) : toggle())}>
        {trigger}
        <span className="kit-caret" aria-hidden>▾</span>
      </button>
      {pos && createPortal(
        <div ref={panelRef} className="kit-menu-panel kit-focus" style={panelStyle(pos)}>
          <div className="kit-menu-head"><span>{title}</span>{hint && <span>{hint}</span>}</div>
          {list(columns)}
        </div>,
        document.body,
      )}
      <BottomSheet open={sheet} title={title} hint={sheetHint ?? hint} onClose={shut}>
        {typed && (
          <form className="kit-typed" noValidate onSubmit={takeTyped}>
            <label>
              <span>{typed}</span>
              <input name="n" type="number" inputMode="numeric" enterKeyHint="done" defaultValue={value ?? ""} min={options[0]?.key}
                max={options.at(-1)?.key} aria-invalid={typedWhy ? true : undefined} onChange={() => setTypedWhy(null)} />
            </label>
            <button type="submit" className="kit-typed-set">Set</button>
            {typedWhy && <span className="kit-typed-why" role="alert">{typedWhy}</span>}
          </form>
        )}
        {list(sheetColumns ?? columns)}
      </BottomSheet>
    </div>
  );
}
