"use client";

import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { useRouter } from "next/navigation";
import { useBetaAccess } from "@/components/BetaGate";
import AutosizeTextarea from "@/components/kit/AutosizeTextarea";
import ComposeFoot from "@/components/image-view/ComposeFoot";
import RefPicker from "@/components/image-view/RefPicker";
import { PROMPT_KEY, type ImageViewModel } from "@/components/image-view/useImageViewModel";
import { stashEditorSeed } from "@/components/enki-shell/editorBridge";
import { librarySeed } from "@/lib/editor/editor-seed";
import { openLogin } from "@/lib/openLogin";
import { promptName } from "@/lib/ui/create/image";
import { ADD_PHOTOS_EVENT } from "@/lib/ui/image-view/slots";
// Quick Create's own "Make it a prompt →" (mobile-modal-add-var-btn), in the app's sans, with its dark values.
import "../../../app/editor/mobile-modal.css";

/**
 * Sume's generate bar in Enki's look (measured 2026-10-30: 1116 x 142, radius 24, floating 18 px over the foot): the
 * words on the first row, its reference images before them and "Make it a prompt →" after, as Quick Create has it (Kev,
 * 2026-10-30: "mit aber Make it a prompt zusatz bei beiden iwo so wie bei quick create"); on the second "+" for
 * references, then the Image View's own foot (ComposeFoot: generator, ratio, size, quality, count, Generate with its
 * price, the line under it), Generate on the right across both rows. Everything it does is the blank composer's
 * (useImageViewModel): one generate logic for every surface. On a phone it is docked to the screen's foot.
 */
export default function ImageBar({ model: m, phone, promptRef, onLift, top, afterPlus }: {
  model: ImageViewModel;
  phone: boolean;
  promptRef: Ref<HTMLTextAreaElement>;
  /** How far the bar reaches up from the screen's foot, for the toasts to stand above it. */
  onLift: (px: number) => void;
  /** A row over the words: the Studio project Create works in (StudioStrip). */
  top?: ReactNode;
  /** Right after "+", in its cell: the communities the next renders go to (BarCommunities). */
  afterPlus?: ReactNode;
}) {
  const router = useRouter();
  const { userId } = useBetaAccess();
  const bar = useRef<HTMLDivElement>(null);
  const plus = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [asking, setAsking] = useState<DOMRect | null>(null);

  // "+" and Generate's "Add N photos" open the picker at "+"; a guest signs in first, as Generate asks.
  const ask = () => {
    if (m.guest) return openLogin();
    if (plus.current) setAsking(plus.current.getBoundingClientRect());
  };
  const asked = useEffectEvent(ask);
  useEffect(() => {
    const open = () => asked();
    window.addEventListener(ADD_PHOTOS_EVENT, open);
    return () => window.removeEventListener(ADD_PHOTOS_EVENT, open);
  }, []);
  const lift = useEffectEvent(() => {
    if (bar.current) onLift(Math.round(window.innerHeight - bar.current.getBoundingClientRect().top + 12));
  });
  useLayoutEffect(() => {
    const el = bar.current;
    if (!el) return;
    const ro = new ResizeObserver(() => lift());
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /* From the bar's words to a prompt to keep or sell, as Quick Create's "Make it a prompt →" (Kev, 2026-10-26): the
     words go to the editor as an import; a guest signs in first. */
  const makePrompt = () => {
    if (m.guest) return openLogin();
    const text = m.text ?? "";
    const seed = librarySeed({ name: promptName(text), prompt_text: text });
    if (seed) stashEditorSeed(seed, userId);
    router.push("/editor");
  };
  // The saved reference library is for video only (Kev, 2026-10-30): the image bar's picker offers this visit's uploads.
  const picks: ImageViewModel = { ...m, library: [], myImages: [] };
  const noRefs = !m.guest && m.cap === 0;
  const plusButton = (
    <button ref={plus} type="button" className="ci-plus kit-pill kit-hit kit-focus" aria-label="Add reference images" disabled={noRefs}
      title={noRefs ? `${m.core.entry?.name ?? "This generator"} takes no reference images` : "Add reference images"}
      onClick={ask}>+</button>
  );

  return (
    <div ref={bar} className="ci-bar" data-phone={phone || undefined}>
      {top}
      <div className="ci-prompt">
        {(m.refs.length > 0 || m.pending.length > 0) && (
          <div className="ci-refs" role="group" aria-label="Reference images">
            {m.refs.map((r, i) => (
              <span key={r.id} className="ci-ref" title={`Reference image ${i + 1}`}>
                {/* eslint-disable-next-line @next/next/no-img-element -- a data URL */}
                <img src={r.src} alt="" draggable={false} />
                <button type="button" className="ci-ref-x kit-hit" aria-label={`Remove reference image ${i + 1}`} onClick={() => m.removeSlot(i)}>×</button>
              </span>
            ))}
            {m.pending.map((src) => (
              // eslint-disable-next-line @next/next/no-img-element -- a preview still being read
              <span key={src} className="ci-ref" data-pending><img src={src} alt="" draggable={false} /></span>
            ))}
          </div>
        )}
        {/* Sized by its top edge, growing up over the wall (Kev, 2026-10-30: "bei images oben nach oben"). */}
        <AutosizeTextarea ref={promptRef} className="ci-text" value={m.text ?? ""} onChange={m.setText} min={40} max={phone ? 120 : 168}
          grip="up" boxClassName="ci-text-box"
          growOnly={m.growOnly(PROMPT_KEY)} onUserInput={() => m.release(PROMPT_KEY)} aria-label="Prompt"
          placeholder={phone ? "Describe your image…" : "Describe the image you want to create"} />
        <button type="button" className="mobile-modal-add-var-btn ci-make" onClick={makePrompt}>Make it a prompt →</button>
      </div>
      {/* With a pill after it, "+" shares its cell (communities.css .ci-plusrow); without, the bar is as it was. */}
      {afterPlus ? <span className="ci-plusrow">{plusButton}{afterPlus}</span> : plusButton}
      <ComposeFoot model={m} phone={phone} />
      {asking && (
        <RefPicker model={picks} anchor={asking} phone={phone} onUpload={() => input.current?.click()} onClose={() => setAsking(null)} />
      )}
      <input ref={input} type="file" accept={m.accept} multiple hidden
        onChange={(e) => {
          m.addFiles([...(e.target.files ?? [])]);
          e.target.value = "";
        }} />
    </div>
  );
}
