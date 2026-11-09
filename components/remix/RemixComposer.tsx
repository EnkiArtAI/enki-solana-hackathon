"use client";

import { useRef, type DragEvent } from "react";
import AutosizeTextarea from "@/components/kit/AutosizeTextarea";
import CostLine from "@/components/kit/CostLine";
import GenerateButton from "@/components/kit/GenerateButton";
import PillMenu from "@/components/kit/PillMenu";
import Segmented from "@/components/kit/Segmented";
import { notify, useToastOffset } from "@/components/kit/notify";
import { Icon } from "@/components/enki-shell/icons";
import { openLogin } from "@/lib/openLogin";
import { CLIP_TYPES, MAX_PHOTOS, PHOTO_TYPES, lengthLabel } from "@/lib/remix/inputs";
import { REMIX_MODES, type RemixMode } from "@/lib/remix/modes";
import { REMIX_RESOLUTIONS, remixPrice, type RemixResolution } from "@/lib/remix/price";
import type { RemixDraft } from "./useRemixDraft";
import "@/components/kit/kit-media.css";

/** Under Generate, and what its press says, until the remix backend exists. */
export const REMIX_SOON = "Remix opens soon.";
const MODES = (Object.keys(REMIX_MODES) as RemixMode[]).map((key) => ({ key, label: REMIX_MODES[key].label }));
/** Both modes' `pick` in one cell, the other mode's hidden (remix.css .rx-both): a switch never moves what is below. */
const both = (mode: RemixMode, pick: (m: (typeof REMIX_MODES)[RemixMode]) => string) =>
  MODES.map(({ key }) => <span key={key} aria-hidden={key !== mode || undefined}>{pick(REMIX_MODES[key])}</span>);
const allowDrop = (e: DragEvent) => e.preventDefault();
const dropped = (e: DragEvent) => {
  e.preventDefault();
  return [...e.dataTransfer.files];
};
/** An x takes its tile out; focus goes to what then stands at its place in the zone (the next x, the +, or the zone's
    own Add button) instead of falling back to the top of the page. */
const refocus = (x: HTMLElement, i: number) => {
  const zone = x.closest(".rx-drop");
  setTimeout(() => zone?.querySelectorAll<HTMLElement>("button")[i]?.focus());
};

/**
 * Remix's composer column, after Sume's (Kev, 2026-10-30), top to bottom: the title card, Motion transfer | Object
 * swap, the clip, the photos, the hint, the optional prompt, the model and resolution pills, Generate. No style row
 * (Kev, 2026-10-30: "ok erstmal keine styles"). Generate's chip is the price once a clip is in: its seconds at the
 * picked resolution, from the one table in lib/remix/price. Generate stays dimmed and says Remix opens soon; a guest
 * gets Log in, as in the image UI.
 */
export default function RemixComposer({ d, guest }: { d: RemixDraft; guest: boolean }) {
  const clipPick = useRef<HTMLInputElement>(null);
  const photoPick = useRef<HTMLInputElement>(null);
  const m = REMIX_MODES[d.mode];
  const price = (r: RemixResolution) => (d.clip ? remixPrice(d.clip.seconds, r) : null);
  // The toasts (Generate's "Remix opens soon.") sit above the foot, as the image view's do (handoff §5.17).
  useToastOffset(120);
  return (
    <aside className="rx-compose" aria-label="Remix composer">
      <div className="rx-head">
        <h2 className="kit-title">Remix</h2>
        <p className="rx-both">{both(d.mode, (x) => x.line)}</p>
      </div>
      <div className="rx-modes">
        <Segmented slide role="radiogroup" ariaLabel="Remix mode" value={d.mode} onChange={d.setMode} options={MODES} />
      </div>

      <div className="rx-drop" data-filled={d.clip ? true : undefined} onDragOver={allowDrop}
        onDrop={(e) => { const [file] = dropped(e); if (file) void d.addClip(file); }}>
        {d.clip ? (
          <>
            <video className="rx-clip" src={d.clip.src} muted loop playsInline autoPlay />
            <span className="rx-len">{lengthLabel(d.clip.seconds)}</span>
            <button type="button" className="kit-ref-x kit-hit rx-x" aria-label="Remove the video"
              onClick={(e) => { refocus(e.currentTarget, 0); d.removeClip(); }}>
              <Icon name="x" size={11} stroke={2.6} />
            </button>
          </>
        ) : (
          <button type="button" className="rx-pick" onClick={() => clipPick.current?.click()}>
            <Icon name="film" size={22} stroke={1.8} />
            <span className="rx-pick-label">Add video</span>
            <span className="rx-pick-sub">4 to 15 seconds</span>
          </button>
        )}
        <input ref={clipPick} type="file" accept={CLIP_TYPES.join(",")} hidden
          onChange={(e) => {
            const file = e.currentTarget.files?.[0];
            e.currentTarget.value = "";
            if (file) void d.addClip(file);
          }} />
      </div>
      {d.clipWhy && <p className="rx-why" role="alert">{d.clipWhy}</p>}

      <div className="rx-drop rx-drop--photos" data-filled={d.photos.length > 0 || undefined} onDragOver={allowDrop}
        onDrop={(e) => d.addPhotos(dropped(e))}>
        {d.photos.length === 0 ? (
          <button type="button" className="rx-pick" onClick={() => photoPick.current?.click()}>
            <Icon name={d.mode === "motion" ? "user" : "image"} size={22} stroke={1.8} />
            <span className="rx-pick-label">{m.photos}</span>
            <span className="rx-pick-sub">(1-8)</span>
          </button>
        ) : (
          <div className="kit-refs-row rx-photos">
            {d.photos.map((p, i) => (
              <div key={p.src} className="kit-ref">
                <span className="kit-ref-img"><img src={p.src} alt="" /></span>
                <button type="button" className="kit-ref-x kit-hit" aria-label={`Remove photo ${i + 1}`}
                  onClick={(e) => { refocus(e.currentTarget, i); d.removePhoto(p.src); }}>
                  <Icon name="x" size={11} stroke={2.6} />
                </button>
              </div>
            ))}
            {d.photos.length < MAX_PHOTOS && (
              <button type="button" className="kit-ref-add kit-hit" aria-label={m.photos} title={m.photos} onClick={() => photoPick.current?.click()}>
                <span className="kit-ref-glyph" aria-hidden>+</span>
              </button>
            )}
          </div>
        )}
        <input ref={photoPick} type="file" accept={PHOTO_TYPES.join(",")} multiple hidden
          onChange={(e) => {
            const picked = [...(e.currentTarget.files ?? [])];
            e.currentTarget.value = "";
            d.addPhotos(picked);
          }} />
      </div>
      {d.photoWhy && <p className="rx-why" role="alert">{d.photoWhy}</p>}
      <p className="rx-hint rx-both">{both(d.mode, (x) => x.hint)}</p>

      <label className="kit-field-check rx-prompt">
        <span className="rx-label">Prompt</span>
        <input type="checkbox" role="switch" checked={d.promptOn} onChange={(e) => d.setPromptOn(e.target.checked)} />
        <span className="kit-switch" aria-hidden />
      </label>
      {d.promptOn && (
        // Taller (Kev, 2026-10-30: "the prompt davon soll auch länger sein").
        <AutosizeTextarea className="kit-field-text" aria-label="Prompt" value={d.prompt} onChange={d.setPrompt}
          min={112} max={240} growOnly={false} maxLength={500} placeholder={m.placeholder} />
      )}

      <div className="rx-bar">
        <PillMenu trigger={<span>Enki Remix</span>} ariaLabel="Model: Enki Remix" title="Seedance 2.5" direction="up"
          options={[{ key: "enki-remix", label: "Enki Remix" }]} value="enki-remix" onPick={() => {}} />
        <PillMenu trigger={<span>{d.resolution}</span>} ariaLabel={`Resolution ${d.resolution}`} title="Resolution" direction="up"
          options={REMIX_RESOLUTIONS.map((r) => ({ key: r, label: r, sub: price(r) }))} value={d.resolution}
          onPick={(r) => d.setResolution(r as RemixResolution)} />
      </div>

      <div className="rx-foot">
        <GenerateButton label={guest ? "Log in to generate" : "✦ Generate"} chip={guest ? null : price(d.resolution)}
          dimmed={!guest} onPress={guest ? () => openLogin() : () => notify(REMIX_SOON)} size="block" />
        <CostLine left={REMIX_SOON} />
      </div>
    </aside>
  );
}
