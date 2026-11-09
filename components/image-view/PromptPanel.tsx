"use client";

import { useLayoutEffect, useRef, useState, type ClipboardEvent, type FocusEvent, type KeyboardEvent, type MouseEvent, type PointerEvent, type RefObject } from "react";
import { Copy } from "lucide-react";
import PromptMirror from "@/components/kit/PromptMirror";
import VariableField from "@/components/kit/VariableField";
import { parseTokens } from "@/lib/editor/prompt-tokens";
import { PROMPT_MAX } from "@/lib/ui/image-view/assemble";
import type { Segment } from "@/lib/ui/image-view/segments";
import { moveRef } from "@/lib/ui/image-view/slots";
import { isFilled, sendValue, type Field } from "@/lib/ui/image-view/variables";
import { fieldKind, type PromptVariable as KitVariable } from "@/lib/ui/kit/fields";
import { copyText, PROMPT_KEY, type ImageViewModel } from "./useImageViewModel";

/** What the document's panel works on: a variable, every place it stands, or reference image n. */
export type Active = { kind: "var"; key: string } | { kind: "ref"; n: number } | null;
/** Expert's cursor (a text index, after the clicked word) and the element its panel works on; the Composer keeps them. */
export interface DocState {
  caret: number | null;
  onCaret: (at: number | null) => void;
  active: Active;
  onActive: (active: Active) => void;
}

/** Expert shows the document while the text has a [slot] or an image in it, unless a "text" view is still held. */
export const inDocument = (m: ImageViewModel) => m.view === "filled" && !!m.segments?.some((s) => s.kind !== "text");

/** The kit field for a composer input; a slot the buyer typed is asked as text. */
const asVariable = (f: Field): KitVariable =>
  f.variable
    ? { ...f.variable, defaultValue: null }
    : { id: f.key, name: f.key, label: f.label, description: "", type: "text", defaultValue: null, required: false, position: 0, min: null, max: null, options: null };

/**
 * Expert (handoff §5.3, prototype S:446-463): the prompt as a document,
 * edited where it stands. A click on the words types into them there; a
 * variable is edited in place, every place it stands at once; a variable or
 * an image opens the panel under the text. A text without slots or images,
 * and the blank composer's, shows as words to edit.
 */
export default function PromptPanel({ model: m, phone = false, doc }: { model: ImageViewModel; phone?: boolean; doc: DocState }) {
  // Where Backspace or Delete at a variable leaves the caret: the document puts it in its run, and once no token is left
  // the words' editor shows instead and it goes in there (review 2026-10-30: it fell to the page, a second Backspace
  // deleted nothing).
  const caretRef = useRef<Join | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const p = caretRef.current;
    if (!p || p.text !== m.text || !field.current) return;
    caretRef.current = null;
    // The caret before the focus: the focus scrolls a long text's field to it, a caret set after it stays out of view
    // (Edge, 2026-10-30).
    field.current.setSelectionRange(p.at, p.at);
    field.current.focus();
  });
  // A premium prompt has no text here: the Composer keeps it on Easy (DEC-307).
  if (m.text === null) return null;
  const tokens = !!m.segments?.some((s) => s.kind !== "text");
  const shown = inDocument(m);
  // Nothing opens the "text" view any more (the document is edited in place): one still held goes back to the document.
  const flip = () => {
    doc.onActive(null);
    doc.onCaret(null);
    m.setView("filled");
  };
  return (
    <section className="iv-prompt" data-doc={shown || undefined}>
      <div className="iv-doc-tools">
        {shown && !phone && <span className="iv-doc-hint">Click the words to edit them · click a colored word or an image to change it</span>}
        <span className="iv-sec-tools">
          {/* Edited in the document, so the document offers the artist's wording back, as the words' editor does. */}
          {shown && m.edited && !m.blank && <button type="button" className="iv-link" onClick={m.resetText}>Reset to the artist&apos;s wording</button>}
          {tokens && !shown && <button type="button" className="iv-link" onClick={flip}>Done editing</button>}
          <button type="button" className="iv-copy kit-hit" aria-label="Copy prompt" title="Copy prompt" onClick={m.copyPrompt}>
            <Copy size={12} strokeWidth={2.2} aria-hidden />
          </button>
        </span>
      </div>
      {shown ? (
        <>
          <Document model={m} segments={m.segments ?? []} doc={doc} caretRef={caretRef} />
          {doc.active && <ActivePanel model={m} segments={m.segments ?? []} doc={doc} />}
        </>
      ) : (
        <>
          <Text model={m} text={m.text} field={field} />
          <Fields model={m} max={phone ? PHONE_FIELD_MAX : undefined} />
        </>
      )}
    </section>
  );
}

function Text({ model: m, text, field }: { model: ImageViewModel; text: string; field: RefObject<HTMLTextAreaElement | null> }) {
  const tokens = parseTokens(text, { refs: "plain" });
  return (
    <>
      <PromptMirror ref={field} className="iv-pm" aria-label="Prompt" value={text} onChange={(v) => m.setText(v)} tokens={tokens}
        missingRefs={tokens.flatMap((t) => (t.kind === "ref" && t.n > m.refs.length ? [t.n] : []))}
        min={150} max={300} growOnly={m.growOnly(PROMPT_KEY)} onUserInput={() => m.release(PROMPT_KEY)}
        placeholder={m.blank ? "Describe the image you want…" : undefined}
        selectionPill={{ onCreate: m.addVariable }} />
      <p className="iv-hint">
        {m.blank ? "Your own prompt · [brackets] become fields below" : "Open prompt · edit anything, [brackets] are the variables"}
        {m.edited && !m.blank && (
          <> · <button type="button" className="iv-link" onClick={m.resetText}>Reset to the artist&apos;s wording</button></>
        )}
      </p>
      {text.length > 3600 && (
        <p className="iv-count" data-over={text.length > PROMPT_MAX || undefined}>
          {text.length.toLocaleString("en-US")} / {PROMPT_MAX.toLocaleString("en-US")}
        </p>
      )}
    </>
  );
}

/** A word with the space after it (S:127). */
const WORDS = /\S+\s*|\s+/g;
/** A key that ends an IME's composition is the composition's (Safari sends it after compositionend as 229). */
const composing = (e: KeyboardEvent) => e.nativeEvent.isComposing || e.keyCode === 229;
/** Backspace or Delete, an IME's left to it: at a variable they take the variable out of the text. Pressed anew only:
    a held one stops at the variable as the browser stops it at an edge (review 2026-10-30: a held Backspace clearing a
    value went on through the variable and into the words before it). */
const erases = (e: KeyboardEvent) => !composing(e) && !e.repeat && (e.key === "Backspace" || e.key === "Delete");
/** Where an unwrap leaves the caret: an index into the text it set, placed once that text is drawn. */
type Join = { text: string; at: number };
/** How many characters into `el` a collapsed caret stands; null for a selection, which the browser deletes as ever. */
const caretIn = (el: HTMLElement) => {
  const sel = getSelection();
  if (!sel?.rangeCount || !sel.isCollapsed) return null;
  const before = sel.getRangeAt(0).cloneRange();
  before.setStart(el, 0);
  return before.toString().length;
};

/* An image in the document is dragged as the editor drags a token (PromptField): a mouse lifts it after 4 px, a
   finger after a 400 ms hold, and a finger that moves 8 px first is scrolling. */
const HOLD_MS = 400;
const SLOP = 8;
const MOUSE_SLOP = 4;
/** While an image is held the page does not scroll under the finger. */
const still = (e: TouchEvent) => e.preventDefault();
interface Press {
  id: number;
  x: number;
  y: number;
  touch: boolean;
  /** The image's key: where it stands in the text is read at the drop, after the words a press committed moved it. */
  ref: string;
  el: HTMLElement;
  active: boolean;
  /** The drop: the end of the word under the pointer, as a click there would set the cursor. */
  to: number | null;
  timer?: ReturnType<typeof setTimeout>;
  esc?: (e: globalThis.KeyboardEvent) => void;
}

/**
 * The sentence with each value written in, its words typed into where they
 * stand: the words between two tokens are one run (committed on blur or
 * Enter, Esc puts it back). A text value is edited in place the same way, an
 * empty one shows its label as a placeholder, never as a value; a checkbox
 * toggles; a choice, a multi-choice or a slider opens the panel under the
 * words, with its options or its field.
 */
function Document({ model: m, segments, doc, caretRef }: { model: ImageViewModel; segments: Segment[]; doc: DocState; caretRef: RefObject<Join | null> }) {
  const named = new Set<string>();
  // An empty run too wherever a token opens or ends the text or two tokens meet: words can go there as well, and
  // nothing else reaches those places now (review 2026-10-29).
  const parts = segments.flatMap((s, i): Segment[] => (s.kind !== "text" && segments[i - 1]?.kind !== "text" ? [{ kind: "text", text: "" }, s] : [s]));
  if (parts[parts.length - 1]?.kind !== "text") parts.push({ kind: "text", text: "" });
  // Where each part starts in the text (the cursor is an index into it), and its key: its own text and how many alike
  // stand before it, never its index, so a commit that adds or drops a token leaves every other node, and the focus a
  // click put in one, where it is (review 2026-10-29: a typed "[mood]" sent the next click's typing nowhere).
  const starts: number[] = [];
  const ids: string[] = [];
  const seen = new Map<string, number>();
  for (let at = 0, i = 0; i < parts.length; at += parts[i++].text.length) {
    const n = seen.get(parts[i].text) ?? 0;
    seen.set(parts[i].text, n + 1);
    starts.push(at);
    ids.push(`${parts[i].text}#${n}`);
  }
  // An image moved by drag (Kev, 2026-10-26: "i want to move the images too that are there with the vorschau im
  // text"): the cursor shows where it lands, a drop moves it there (moveRef, its " and " going with it), Esc puts it back.
  const press = useRef<Press | null>(null);
  // The click that ends a drag opens nothing.
  const dragged = useRef(false);
  // A run the browser typed into is drawn anew once it is left (a new key), the same text or not: React never patches
  // nodes the browser rewrote. Only that run: the one a click moves into keeps its node, so the click lands.
  const [fresh, setFresh] = useState<Record<string, number>>({});
  const redraw = (id: string) => setFresh((o) => ({ ...o, [id]: (o[id] ?? 0) + 1 }));
  const typed = useRef(false);
  const end = (cancel: boolean) => {
    const p = press.current;
    press.current = null;
    if (!p) return;
    clearTimeout(p.timer);
    document.removeEventListener("touchmove", still);
    if (p.esc) window.removeEventListener("keydown", p.esc, true);
    p.el.removeAttribute("data-dragged");
    if (p.active && cancel) doc.onCaret(null);
  };
  const lift = (p: Press) => {
    // Words typed and not yet left are committed first, as a mouse's press does (a finger's hold blurs nothing): the
    // drag then draws its cursor in words React drew and moves the image in a text that has them (review 2026-10-29).
    const typing = document.activeElement as HTMLElement | null;
    if (typing?.isContentEditable) typing.blur();
    p.active = true;
    dragged.current = true;
    // A pointer the browser no longer tracks cannot be captured; the drag goes on without it.
    try { p.el.setPointerCapture(p.id); } catch { /* released meanwhile */ }
    p.el.setAttribute("data-dragged", "");
    document.addEventListener("touchmove", still, { passive: false });
    // First, before the Image View's own Esc closes it (review 2026-10-26): this Esc only puts the image back.
    p.esc = (e) => { if (e.key !== "Escape") return; e.stopPropagation(); end(true); };
    window.addEventListener("keydown", p.esc, true);
    navigator.vibrate?.(10);
  };
  const drag = (ref: string) => ({
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      dragged.current = false;
      const p: Press = { id: e.pointerId, x: e.clientX, y: e.clientY, touch: e.pointerType !== "mouse", ref, el: e.currentTarget, active: false, to: null };
      if (p.touch) p.timer = setTimeout(() => lift(p), HOLD_MS);
      press.current = p;
    },
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      const p = press.current;
      if (!p) return;
      if (!p.active) {
        const far = Math.hypot(e.clientX - p.x, e.clientY - p.y);
        if (p.touch && far > SLOP) end(true);
        else if (!p.touch && far > MOUSE_SLOP) lift(p);
        return;
      }
      const word = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>(".iv-word");
      if (word?.dataset.at) {
        p.to = Number(word.dataset.at);
        doc.onCaret(p.to);
      }
    },
    onPointerUp: () => {
      const p = press.current;
      const k = p ? ids.indexOf(p.ref) : -1;
      if (p?.active && p.to !== null && m.text !== null && k >= 0) {
        const moved = moveRef(m.text, starts[k], p.to);
        if (moved) m.setText(moved.text);
        doc.onCaret(null);
      }
      end(false);
    },
    onPointerCancel: () => end(true),
  });
  /* Backspace or Delete at a variable takes it out of the text and leaves its value there as words (Kev, 2026-10-29:
     "wenn ich backspace oder entf mache an der variable, so soll variable verschwinden und variable inhalt drin
     bleiben"): what Generate sends for it, nothing when it is empty, in that one place only. Words typed and not yet
     left in the run the key was pressed in go into the same text; the caret stays where it stood, at the join
     (`after`: past the value), in the run that holds the words once they are drawn (in the words' editor, PromptPanel,
     once no token is left). */
  const box = useRef<HTMLDivElement>(null);
  const unwrap = (e: KeyboardEvent<HTMLElement>, j: number, after: boolean, typedValue?: string, run?: number) => {
    const s = parts[j];
    // Never an image: a reference keeps its Remove in the panel, an image variable has no words to leave.
    if (s?.kind !== "var" || (s.variable && !fieldKind(s.variable))) return;
    e.preventDefault();
    const value = typedValue ?? m.values[s.key] ?? "";
    const texts = parts.map((p) => p.text);
    texts[j] = isFilled(s.variable, value) ? sendValue(s.variable, value) : "";
    if (run !== undefined && typed.current) {
      typed.current = false;
      redraw(ids[run]);
      texts[run] = (e.currentTarget.textContent ?? "").replace(/\u00a0/g, " ");
    }
    const text = texts.join("");
    caretRef.current = { text, at: texts.slice(0, j).join("").length + (after ? texts[j].length : 0) };
    if (doc.active?.kind === "var" && doc.active.key === s.key) doc.onActive(null);
    m.setText(text);
  };
  useLayoutEffect(() => {
    const p = caretRef.current;
    if (!p || p.text !== m.text) return;
    caretRef.current = null;
    // Each part draws one child of the document, so the run's index is its node's.
    const k = parts.findIndex((s, i) => s.kind === "text" && starts[i] <= p.at && p.at <= starts[i] + s.text.length);
    const run = box.current?.children[k] as HTMLElement | undefined;
    if (!run) return;
    let node: Node = run;
    let left = p.at - starts[k];
    for (const walk = document.createTreeWalker(run, NodeFilter.SHOW_TEXT); walk.nextNode();) {
      node = walk.currentNode;
      if (left <= node.textContent!.length) break;
      left -= node.textContent!.length;
    }
    // Where the token stood, on screen when the key went down: the focus scrolls nothing (review 2026-10-30: a long
    // run's focus jumped the scroller to its top, the caret out of view).
    run.focus({ preventScroll: true });
    getSelection()?.collapse(node, left);
  });
  return (
    <div className="iv-doc" ref={box}>
      {parts.map((s, i) => {
        const start = starts[i];
        const id = ids[i];
        if (s.kind === "text") {
          /* The words are typed into where they stand, the images and the values staying as they look (Kev, 2026-10-29:
             "lass doch einfach die view mit den images and just lemme change texts without the UI actually changing at
             all ... i gotta see the entire prompt"): the browser's own caret goes where the click or the tap was, a
             phone's keyboard comes up with it. The words keep their spans: a dragged image drops on a word's data-at. */
          const commit = (e: FocusEvent<HTMLSpanElement>) => {
            if (!typed.current) return;
            typed.current = false;
            redraw(id);
            // A space the browser typed as U+00A0 is a space.
            const run = (e.currentTarget.textContent ?? "").replace(/\u00a0/g, " ");
            if (run !== s.text && m.text !== null) m.setText(m.text.slice(0, start) + run + m.text.slice(start + s.text.length));
          };
          const key = (e: KeyboardEvent<HTMLSpanElement>) => {
            if (erases(e)) {
              // At the run's start Backspace reaches the variable before it, at its end Delete the one after; an
              // empty run's start is its end.
              const back = e.key === "Backspace";
              if (caretIn(e.currentTarget) === (back ? 0 : (e.currentTarget.textContent ?? "").length)) unwrap(e, back ? i - 1 : i + 1, back, undefined, i);
              return;
            }
            if (composing(e)) return;
            if (e.key === "Enter") e.preventDefault();
            else if (e.key === "Escape") {
              // Before the Image View's own Esc closes it: this Esc only puts the words back, drawn anew from the text.
              e.stopPropagation();
              if (typed.current) {
                typed.current = false;
                redraw(id);
              }
            } else return;
            e.currentTarget.blur();
          };
          // An empty run has no place for the browser's caret, which a click then puts into a text value beside it
          // (seen in Edge, 2026-10-29): the click goes in here itself.
          const reach = (e: MouseEvent<HTMLSpanElement>) => {
            if (e.currentTarget.textContent) return;
            e.preventDefault();
            e.currentTarget.focus();
          };
          return (
            <span key={`${id}.${fresh[id] ?? 0}`} className="iv-run" contentEditable="plaintext-only" suppressContentEditableWarning
              spellCheck={false} onMouseDown={reach} onFocus={() => doc.onActive(null)} onInput={() => { typed.current = true; }} onBlur={commit} onKeyDown={key}>
              {[...s.text.matchAll(WORDS)].map((w) => {
                const word = w[0].trimEnd();
                const at = start + w.index + word.length;
                return (
                  <span key={w.index} className="iv-word" data-at={at}>
                    {word}
                    {doc.caret === at && <span className="iv-caret" aria-hidden />}
                    {w[0].slice(word.length)}
                  </span>
                );
              })}
            </span>
          );
        }
        if (s.kind === "ref") {
          const photo = m.refs[s.n - 1]?.src;
          const on = doc.active?.kind === "ref" && doc.active.n === s.n;
          const look = { className: "iv-tok-img", title: `Image ${s.n}`, "aria-label": `Image ${s.n}`, "data-on": on || undefined, "data-empty": !photo || undefined };
          // eslint-disable-next-line @next/next/no-img-element -- the buyer's photo is a data URL, nothing to optimise
          const img = photo && <img src={photo} alt="" draggable={false} />;
          // A guest adds no photos (the Composer offers none), so their tokens only show.
          return m.guest
            ? <span key={id} role="img" {...look}>{img}</span>
            : (
              <button key={id} type="button" {...look} aria-pressed={on} {...drag(id)}
                onContextMenu={(e) => e.preventDefault()}
                onClick={() => { if (dragged.current) dragged.current = false; else doc.onActive({ kind: "ref", n: s.n }); }}>
                {img}
              </button>
            );
        }
        const value = m.values[s.key] ?? "";
        const label = s.variable?.label || s.name;
        // The first token of a field is where Generate points.
        const at = named.has(s.key) ? undefined : s.key;
        named.add(s.key);
        const tone = {
          "data-iv-field": at,
          "data-changed": m.changed(s.key) || undefined,
          "data-on": (doc.active?.kind === "var" && doc.active.key === s.key) || undefined,
        };
        const open = () => doc.onActive({ kind: "var", key: s.key });
        const kind = s.variable ? fieldKind(s.variable) : "text";
        if (kind === "text") {
          const commit = (e: FocusEvent<HTMLSpanElement>) => {
            const v = e.currentTarget.textContent?.trim() ?? "";
            if (v !== value) m.setValue(s.key, v);
            m.release(s.key);
          };
          const key = (e: KeyboardEvent<HTMLSpanElement>) => {
            if (erases(e)) {
              // Backspace at its start or Delete at its end leaves it as words, as typed; inside it they type.
              const el = e.currentTarget;
              const typedValue = el.textContent ?? "";
              if (caretIn(el) !== (e.key === "Backspace" ? 0 : typedValue.length)) return;
              unwrap(e, i, e.key === "Delete", typedValue.trim());
              // Its own value back, so a blur or the same variable drawn in this node elsewhere commits nothing typed.
              el.textContent = value;
              return;
            }
            if (composing(e)) return;
            if (e.key === "Enter") e.preventDefault();
            else if (e.key === "Escape") {
              e.stopPropagation();
              e.currentTarget.textContent = value;
            } else return;
            e.currentTarget.blur();
          };
          const paste = (e: ClipboardEvent<HTMLSpanElement>) => {
            e.preventDefault();
            document.execCommand("insertText", false, e.clipboardData.getData("text/plain").replace(/\s*\n\s*/g, " "));
          };
          return (
            // Keyed by its value: a commit remounts it rather than fighting the DOM.
            <span key={`${id}:${value}`} className="iv-tok" role="textbox" aria-label={label} title={`${label} · click to edit`}
              contentEditable suppressContentEditableWarning spellCheck={false} data-placeholder={label} {...tone}
              onFocus={open} onBlur={commit} onKeyDown={key} onPaste={paste}>
              {value}
            </span>
          );
        }
        // A button's value has no caret: Backspace or Delete on it while it has the focus takes it out.
        const erase = (e: KeyboardEvent<HTMLButtonElement>) => { if (erases(e)) unwrap(e, i, e.key === "Backspace"); };
        if (kind === "check") {
          const on = value === "true";
          return (
            <button key={id} type="button" className="iv-tok" data-off={!on || undefined} aria-pressed={on} {...tone}
              title={on ? "Click to leave it out" : "Click to put it in"} onClick={() => m.setValue(s.key, on ? "false" : "true")} onKeyDown={erase}>
              {sendValue(s.variable, "true")}
            </button>
          );
        }
        if (kind === "choice") {
          return (
            <button key={id} type="button" className="iv-tok" title={`${label} · pick one below`} {...tone} onClick={open} onKeyDown={erase}>
              {s.variable?.options?.find((o) => o.promptValue === value)?.visibleName || label}
            </button>
          );
        }
        // A multi-choice or a slider opens its field under the words, the document left as it is (Kev, 2026-10-29: "it
        // even changes to the variable names which is off").
        return (
          <button key={id} type="button" className="iv-tok" title={`${label} · change it below`} {...tone} onClick={open} onKeyDown={erase}>
            {value || label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Under the text while a variable or an image is picked (prototype S:42@20761):
 * a choice's options, Reset once it is changed; a multi-choice's or a
 * slider's field; an image's Replace photo (Add photo while empty) and Remove
 * while there is more than one; Done.
 */
function ActivePanel({ model: m, segments, doc }: { model: ImageViewModel; segments: Segment[]; doc: DocState }) {
  const file = useRef<HTMLInputElement>(null);
  const active = doc.active;
  const done = <button type="button" className="iv-done" onClick={() => doc.onActive(null)}>Done</button>;
  // A value being typed keeps its focus while its options are tapped.
  const keep = (e: MouseEvent) => e.preventDefault();
  if (active?.kind === "var") {
    const s = segments.find((x): x is Extract<Segment, { kind: "var" }> => x.kind === "var" && x.key === active.key);
    if (!s) return null;
    const kind = s.variable && fieldKind(s.variable);
    const field = (kind === "multi" || kind === "slider") && m.fields.find((f) => f.key === active.key);
    if (field) return <div className="iv-active"><Value model={m} field={field} />{done}</div>;
    const value = m.values[active.key] ?? "";
    const options = kind === "choice" ? (s.variable?.options ?? []) : [];
    return (
      <div className="iv-active">
        <span className="iv-active-label">{s.variable?.label || s.name}</span>
        {options.map((o) => (
          <button key={o.promptValue} type="button" className="iv-chip" data-on={o.promptValue === value || undefined}
            onMouseDown={keep} onClick={() => m.setValue(active.key, o.promptValue)}>
            {o.visibleName}
          </button>
        ))}
        {m.changed(active.key) && (
          <button type="button" className="iv-chip" data-quiet onMouseDown={keep} onClick={() => m.resetValue(active.key)}>↺ Reset</button>
        )}
        {done}
      </div>
    );
  }
  if (active?.kind !== "ref" || !segments.some((x) => x.kind === "ref" && x.n === active.n)) return null;
  const i = active.n - 1;
  const photo = !!m.refs[i];
  return (
    <div className="iv-active">
      <span className="iv-active-label">Image {active.n}</span>
      {(photo || m.room > 0) && (
        <button type="button" className="iv-chip" onClick={() => file.current?.click()}>{photo ? "Replace photo" : "Add photo"}</button>
      )}
      {m.slotTotal > 1 && (
        <button type="button" className="iv-chip" data-danger onClick={() => { m.removeSlot(i); doc.onActive(null); }}>Remove</button>
      )}
      {done}
      <input ref={file} type="file" accept={m.accept} hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f && photo) m.replacePhoto(i, f);
          else if (f) m.addFiles([f]);
          e.target.value = "";
        }} />
    </div>
  );
}

/** A phone's text fields grow this tall before they scroll; 120 px held under five lines (Kev, 2026-10-27: "textbox
    für prompt zu klein"). */
export const PHONE_FIELD_MAX = 260;

/** The buyer's values. `head`: the "Variables · from the [brackets] above" line, for when the text shows above them.
    `max`: the text fields' tallest before they scroll (VariableField's own when unset). */
export function Fields({ model: m, head = true, max }: { model: ImageViewModel; head?: boolean; max?: number }) {
  if (!m.fields.length) return null;
  return (
    <div className="iv-fields">
      {head && m.text !== null && (
        <div className="iv-sec-head">
          <span className="iv-label">Variables</span>
          <span className="iv-sub">from the [brackets] above</span>
        </div>
      )}
      {m.fields.map((f) => (
        <div key={f.key} data-iv-field={f.key}><Value model={m} field={f} max={max} /></div>
      ))}
    </div>
  );
}

/** One value's field: each of Fields', and a multi-choice's or a slider's in the document's panel. */
function Value({ model: m, field: f, max }: { model: ImageViewModel; field: Field; max?: number }) {
  return (
    <VariableField variable={asVariable(f)} value={m.values[f.key] ?? ""} onChange={(v) => m.setValue(f.key, v)}
      growOnly={m.growOnly(f.key)} onUserInput={() => m.release(f.key)} changed={m.changed(f.key)} onReset={() => m.resetValue(f.key)}
      // A premium value travels as typed, and the server takes 300 characters (VALUE_MAX).
      maxLength={m.premium ? 300 : undefined} max={max}
      onCopy={() => copyText(sendValue(f.variable, m.values[f.key]), `Copied ${f.label}`)} />
  );
}
