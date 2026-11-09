"use client";

import { useLayoutEffect, useRef, useState, type CSSProperties, type FocusEvent } from "react";
import PromptMirror from "@/components/kit/PromptMirror";
import { parseTokens } from "@/lib/editor/prompt-tokens";
import { fitFont } from "@/lib/ui/image-view/fit-font";
import { PROMPT_KEY, type ImageViewModel } from "./useImageViewModel";

/** The words' type: 19 px on desktop (17 on a phone), up to the title's 36 px where a short prompt leaves room. */
export const WORDS_MIN = 19;
export const WORDS_MAX = 36;
const PHONE = 17;
/** The field's frame: 6 px padding and a 1 px border, above and below. */
const FRAME = 14;

/**
 * A prompt without variables (text-only handoff §2.3): its text in place of
 * the fields, always the editor (Kev, 2026-10-21: a click must not change its
 * size), so a click only puts the caret there. Its "Reference image k" read as
 * pills. On desktop a short prompt's type grows until the words reach the
 * scroller's foot, where the agent row stands under it, so no white gap opens
 * between them.
 */
export default function PlainPrompt({ model: m, phone, onEditing }: {
  model: ImageViewModel;
  phone: boolean;
  /** The field took or left the focus: a variable typed meanwhile keeps this view until it is left. */
  onEditing: (on: boolean) => void;
}) {
  const box = useRef<HTMLElement>(null);
  const words = useRef<HTMLDivElement>(null);
  const probe = useRef<HTMLDivElement>(null);
  const [fitted, setSize] = useState(WORDS_MIN);
  const size = phone ? PHONE : fitted;
  const text = m.text ?? "";

  useLayoutEffect(() => {
    const section = box.current, field = words.current, p = probe.current;
    const scroller = section?.closest<HTMLElement>("[data-scroll]");
    if (phone || !section || !field || !p || !scroller) return;
    const fit = () => {
      // Down to the scroller's own bottom: the agent row stands under it, above the foot.
      const floor = scroller.getBoundingClientRect().bottom - parseFloat(getComputedStyle(scroller).paddingBottom || "0");
      const free = floor - section.getBoundingClientRect().bottom;
      const overflow = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      const room = field.offsetHeight + free - overflow;
      setSize(fitFont((px) => { p.style.fontSize = `${px}px`; return p.offsetHeight; }, room, WORDS_MIN, WORDS_MAX));
      // Back to 19 px, no taller than the field: a larger trial would reach past it and read as overflow next time.
      p.style.fontSize = "";
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(scroller);
    for (const child of scroller.children) ro.observe(child);
    return () => ro.disconnect();
  }, [phone, text]);

  // Leaving the field, not moving inside it (the "+ Variable" pill), ends the edit.
  const left = (e: FocusEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onEditing(false);
  };
  return (
    <section ref={box} className="iv-plain" aria-label="Prompt">
      <div className="iv-plain-head">
        <span className="iv-mode-label">Prompt</span>
        {m.edited && <button type="button" className="iv-link" onClick={m.resetText}>Reset to the artist&apos;s wording</button>}
      </div>
      <div ref={words} className="iv-plain-words" style={{ "--iv-fs": `${size}px` } as CSSProperties}
        onFocus={() => onEditing(true)} onBlur={left}>
        <PromptMirror className="iv-pm" aria-label="Prompt" value={text} onChange={(v) => m.setText(v)}
          tokens={parseTokens(text, { refs: "plain" })} missingRefs={[]}
          // One line at this size: the field measures itself again only when min changes, so every size gives
          // its own (rounded up, 23 and 23.5 px both gave 40).
          min={size * 1.7 + FRAME} max={4000}
          growOnly={m.growOnly(PROMPT_KEY)} onUserInput={() => m.release(PROMPT_KEY)} selectionPill={{ onCreate: m.addVariable }} />
      </div>
      {/* The same words at a trial size: how tall the field would be (desktop only; a phone keeps 17 px). */}
      {!phone && <div ref={probe} className="iv-plain-probe" aria-hidden>{text}</div>}
    </section>
  );
}
