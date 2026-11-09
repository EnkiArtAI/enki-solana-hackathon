"use client";

import { useEffect, useRef, useState, type FocusEvent } from "react";
import { ADD_PHOTOS_EVENT, MAX_SLOTS } from "@/lib/ui/image-view/slots";
import PhotoDeck from "./PhotoDeck";
import PlainPrompt from "./PlainPrompt";
import PromptPanel, { Fields, PHONE_FIELD_MAX, inDocument, type Active } from "./PromptPanel";
import RefPicker from "./RefPicker";
import type { ImageViewModel } from "./useImageViewModel";

type Mode = "easy" | "expert";

/**
 * What the buyer makes the image with (README §1, handoff §5.5): Easy shows
 * only their photos and the variables, the prompt text stays hidden; Expert
 * shows the whole text, editable. A sticky head says which, the switch first.
 * A premium prompt's text never reaches the client, so it has Easy only. A
 * prompt without variables has nothing to switch: its text stands in place of
 * the fields, its photos as in Easy (text-only handoff §2).
 */
export default function Composer({ model: m, phone = false }: { model: ImageViewModel; phone?: boolean }) {
  const [mode, setMode] = useState<Mode>("easy");
  const [caret, setCaret] = useState<number | null>(null);
  const [active, setActive] = useState<Active>(null);
  // A plain prompt's words in the focus: a variable typed meanwhile keeps this view until the field is left.
  const [editing, setEditing] = useState(false);
  // Expert's text in the focus: a prompt that just lost its last variable keeps Expert until the text is left.
  const [held, setHeld] = useState(false);
  // Expert's "+ Ref image" asks the reference picker, beside the button.
  const [asking, setAsking] = useState<DOMRect | null>(null);
  // The height Variable's photo deck settled on: a phone's Full prompt keeps it, the switch leaves the photos as they were
  // (Kev, 2026-10-27: "variable / full prompt ändert the größe of the platzhalter ... keep the size of when it is
  // visible on variable").
  const [deckSize, setDeckSize] = useState<number | null>(null);
  // Switched by hand at least once: Variable's fields then slide in from the left, as Full prompt's text does from the
  // right (Kev, 2026-10-27: "von full prompt zu variable ... auch so nach links wischen"); the first view stays still.
  const [switched, setSwitched] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const upAt = useRef<number | undefined>(undefined);
  const head = useRef<HTMLDivElement>(null);
  const plain = (m.plain && !held) || editing;
  // Nothing to switch on a plain prompt: a stored Expert never shows for it (§2.1).
  const switchable = m.text !== null && !plain;
  const expert = switchable && mode === "expert";
  const slots = !m.photosOff && !!m.segments?.some((s) => s.kind === "ref");
  const room = !m.guest && m.room > 0 && m.slotTotal < MAX_SLOTS;
  // "Your images" heads the photos, which a guest has none of; the head goes when it has nothing left to hold.
  // Every prompt takes your images (Kev, 2026-11-01: "bei jedem free image ein muss"), a plain one too; a premium one
  // unless its creator switched them off ("bei premium images das eingestellt werden kann").
  const label = !m.guest && !m.photosOff;
  // A photo fills a slot the text already names first; only a new slot's reference goes in at the cursor.
  const at = expert && caret !== null && m.photosNeeded === 0 ? caret : null;
  // A reference put in or taken out (the picker stays open) moves the words under the caret: it starts again from a
  // click, and the next pick goes after the last reference (review 2026-10-29, DEC-506).
  useEffect(() => setCaret(null), [m.text]);
  const pick = (k: Mode) => {
    setMode(k);
    setActive(null);
    setHeld(false);
    // Only a real change: the checked Variable tapped on the first view slid its fields in (review 2026-10-27).
    if (k !== mode) setSwitched(true);
    if (k === "easy") setCaret(null);
  };
  // A phone's Full prompt shows the photo deck too (Kev, 2026-10-26), whose photo symbol adds one: no "+ Ref image"
  // beside it (Kev, 2026-10-27: "das "+ ref image" ist unnötig, das "photo" symbol reicht völlig").
  const deck = phone && !m.guest && slots;
  useEffect(() => {
    // On a phone the deck in Full prompt answers it itself: two pickers opened at once (review 2026-10-26).
    if (!expert || deck) return;
    // Generate's "Add N photos" in Expert, where no photo area answers it: the picker at "+ Ref image", else the head.
    const open = () => {
      const by = head.current?.querySelector<HTMLElement>(".iv-refimg") ?? head.current;
      if (!by) return;
      by.scrollIntoView({ block: "nearest" });
      setAsking(by.getBoundingClientRect());
    };
    window.addEventListener(ADD_PHOTOS_EVENT, open);
    return () => window.removeEventListener(ADD_PHOTOS_EVENT, open);
  }, [expert, deck]);

  const toggle = switchable && (
    <div className="iv-mode" role="radiogroup" aria-label="Variable or full prompt"
      title="Variable: only the fields, your images and settings · Full prompt: the whole prompt, editable in place">
      <span className="iv-mode-slide" data-expert={expert || undefined} aria-hidden />
      {(["easy", "expert"] as const).map((k) => (
        <button key={k} type="button" role="radio" aria-checked={mode === k} className="iv-mode-btn" onClick={() => pick(k)}>
          {/* Named by what each shows (Kev, 2026-10-26: "easy / expert is vague"); the modes keep their keys. */}
          {k === "easy" ? "Variable" : "Full prompt"}
        </button>
      ))}
    </div>
  );

  return (
    <>
      {(switchable || label) && (
        // Stays while the phone header is tucked over the image (Kev, 2026-10-27: "verschwindet ... with scrolling, that
        // shouldnt be the case"); stuck, it stops under the small burger, not beneath it (enki-shell.css, DEC-455).
        <div ref={head} className="iv-mode-head">
          {/* The switch leads on the desktop (Kev, 2026-10-21). A phone names the photos at the left, over them, and
              keeps the switch at the right in both modes (Kev, 2026-10-27: "your images muss darüber und variable/full
              prompt dann halt rechts zum umschalten"). */}
          {!phone && toggle}
          {expert && !deck ? (
            <span className="iv-mode-left">
              {room && (
                <button type="button" className="iv-refimg" title="Adds a photo at the cursor, or after the last image" onClick={(e) => setAsking(e.currentTarget.getBoundingClientRect())}>
                  <span className="iv-refimg-plus" aria-hidden>+</span><span className="iv-refimg-word">Ref image</span>{at !== null && <span className="iv-refimg-at"> at cursor</span>}
                </button>
              )}
              {!phone && inDocument(m) && <span className="iv-legend">your changes</span>}
            </span>
          ) : label && (
            <span className="iv-mode-label">Your images{phone && m.slotTotal > 1 && <span className="iv-mode-count"> · {m.slotTotal} images</span>}</span>
          )}
          {phone && toggle}
        </div>
      )}
      {expert ? (
        <>
          {/* On a phone the photos line up at "+ Ref image" too, a deck to slide through with a finger (Kev, 2026-10-26:
              "die referenced images sollten auch dann bei der schaltfläche wo ich + reference images geclickt hab in ner
              art responsive kartendeck in einer row aufgereiht sein"); this reverses DEC-307's "no deck in Expert" there. */}
          {deck && <PhotoDeck model={m} phone fixed={deckSize ?? true} />}
          <div style={{ display: "contents" }} onFocus={() => setHeld(true)}
            onBlur={(e: FocusEvent<HTMLDivElement>) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHeld(false); }}>
            <PromptPanel model={m} phone={phone} doc={{ caret, onCaret: setCaret, active, onActive: setActive }} />
          </div>
        </>
      ) : plain ? (
        <>
          {/* A fixed photo area: the words, not the photos, take what the column leaves. */}
          {!m.guest && !m.photosOff && <PhotoDeck model={m} phone={phone} fixed />}
          <PlainPrompt model={m} phone={phone} onEditing={setEditing} />
        </>
      ) : (
        <>
          {label && <PhotoDeck model={m} phone={phone} onSize={phone ? setDeckSize : undefined} />}
          {m.textMissing && <p className="iv-note">The prompt text could not load. Try again later.</p>}
          <div className="iv-easy" data-in={switched || undefined}><Fields model={m} head={false} max={phone ? PHONE_FIELD_MAX : undefined} /></div>
        </>
      )}
      {asking && (
        // The picker closes before the files come, and closing drops the cursor: the upload keeps where it was.
        <RefPicker model={m} anchor={asking} phone={phone} at={at ?? undefined} onUpload={() => { upAt.current = at ?? undefined; input.current?.click(); }}
          // A reference put in at the cursor moved the text under it: the cursor starts again from a click.
          onClose={() => { setAsking(null); if (at !== null) setCaret(null); }} />
      )}
      <input ref={input} type="file" accept={m.accept} multiple hidden
        onChange={(e) => {
          m.addFiles([...(e.target.files ?? [])], upAt.current);
          e.target.value = "";
        }} />
    </>
  );
}
