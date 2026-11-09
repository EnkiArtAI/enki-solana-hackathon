"use client";

import { useRef, useState, type DragEvent, type MouseEvent } from "react";
import { ArrowLeftRight } from "lucide-react";
import AutosizeTextarea from "@/components/kit/AutosizeTextarea";
import CostLine from "@/components/kit/CostLine";
import GenerateButton from "@/components/kit/GenerateButton";
import PillMenu from "@/components/kit/PillMenu";
import { notify, useToastOffset } from "@/components/kit/notify";
import { Icon } from "@/components/enki-shell/icons";
import RefPicker, { type RefSource } from "@/components/image-view/RefPicker";
import type { SavedReference } from "@/hooks/useReferenceLibrary";
import { readReference } from "@/hooks/useReferenceReads";
import type { VideoRun } from "@/hooks/useVideoRun";
import { openLogin } from "@/lib/openLogin";
import { CLIP_TYPES, PHOTO_TYPES, lengthLabel } from "@/lib/remix/inputs";
import { VIDEO_CONSENT, VIDEO_CONSENT_REFUSED } from "@/lib/video/job-view";
import { overRefs } from "@/lib/video/media";
import { VIDEO_MODELS, VIDEO_NOT_AVAILABLE, fitSettings, placeholderOf, videoCanRun, videoPrice, type Resolution } from "@/lib/video/models";
import { useVideoRoutes } from "@/hooks/useVideoRoutes";
import type { FrameEnd, VideoDraft, VideoMedia } from "./useVideoDraft";
import VideoSettingsRow from "./VideoSettingsRow";
import "@/components/kit/kit-media.css";
import "@/components/image-view/image-view.css";

/** Beside the references while a clip makes the price "…" (Seedance bills its seconds at a rate not read yet). */
export const CLIP_UNPRICED = "With a clip in, the price shows once its rate is confirmed.";
/** Clips stay in the composer but do not go out yet: their rate and minimum are unread, and a clip needs its own checks. */
export const CLIPS_NOT_YET = "Clips can't be sent yet. Take them out to generate.";
const WRITE_FIRST = "Write what the video shows first.";
const NOT_SAVED = "A picture could not be saved. Nothing was charged. Try again.";
/** Under Wan 3.0's media, while nothing else is said there. */
export const ONE_SLOT = "Frames or references, not both.";
const SWAP = "Swap start and end frame";
const ENDS: Array<{ end: FrameEnd; label: string }> = [{ end: "start", label: "Start frame" }, { end: "end", label: "End frame" }];
const allowDrop = (e: DragEvent) => e.preventDefault();
const dropped = (e: DragEvent) => {
  e.preventDefault();
  return [...e.dataTransfer.files];
};

/** The account's saved references, as the composer is handed them (hooks/useReferenceLibrary). */
export interface VideoLibrary {
  saved: SavedReference[];
  /** The hashes of those deleted. */
  deleted: string[];
  save: (image: string) => Promise<SavedReference | null>;
  remove: (id: string) => void;
}

/**
 * Create > Video's composer column, after Sume's "Create Video" (Kev, 2026-10-30: "die UI für image und video
 * generations die genauso aussehen sollten wie bei sume"), top to bottom: the title card, the model card with Change,
 * the media the model takes (a start and an end frame with a swap between them, or reference media) over one kept line
 * for what is said about it, the words with "Make it a prompt", Include audio, then Length in a row of its own and
 * Aspect, Resolution and Bitrate side by side under it (Kev, 2026-10-30: "also alle 3 einstellungen in 1 reihe"),
 * Generate with the price. A model switch moves nothing: the card and that line keep their height (Kev, 2026-10-30:
 * "i also dont like how the UI changes when selecting the video generators"). Edit Video and Motion Control are left out:
 * neither has a model wired, and Remix's Motion transfer already is the second. Generate stays dimmed and says so until the
 * model's operator is set, and then presses `run`, one video a press; a guest gets Log in, as in Remix.
 */
export default function VideoComposer({ d, guest, phone, library, onMakePrompt, run }: {
  d: VideoDraft;
  guest: boolean;
  phone: boolean;
  library: VideoLibrary;
  onMakePrompt: () => void;
  run?: VideoRun;
}) {
  const framePick = useRef<HTMLInputElement>(null);
  const refPick = useRef<HTMLInputElement>(null);
  const frameEnd = useRef<FrameEnd>("start");
  const [asking, setAsking] = useState<DOMRect | null>(null);
  // The pictures the last swap moved, by id: they slide in from the end they left (video.css).
  const [moved, setMoved] = useState<string[]>([]);
  const { model: m, settings: s } = d;
  const { rateOf } = useVideoRoutes();
  const rate = rateOf(m.id);
  const framesHeld = Boolean(d.frames.start || d.frames.end);
  const held = (x: typeof m) => overRefs(x, d.refs, framesHeld && x.slots.includes("frames"));
  const { over, why: overWhy, clipTenths } = held(m);
  // Frames or references under a model that takes one or the other (Wan 3.0): the one held closes the other.
  const blockFrames = Boolean(m.oneSlot && d.refs.length);
  const blockRefs = Boolean(m.oneSlot && framesHeld);
  const price = (r: Resolution) => videoPrice(m, rate, fitSettings(m, { ...s, resolution: r }), clipTenths);
  // Wan 3.0 makes no sound from a frame: Include audio shows off and closed while one is held, the buyer's pick kept.
  const muted = Boolean(m.framesMute && framesHeld);
  // The one sentence under the media: a refusal before the rest, then the clip's missing price, then Wan's rule.
  const why = (m.slots.includes("frames") && d.framesWhy) || (m.slots.includes("refs") && d.refsWhy) || overWhy;
  const hint = clipTenths > 0 && !rate?.clipsAdded ? CLIP_UNPRICED : m.oneSlot ? ONE_SLOT : null;
  const swap = () => {
    setMoved([d.frames.start?.id, d.frames.end?.id].filter((id): id is string => Boolean(id)));
    d.swapFrames();
  };
  /* Reference media comes through the image view's picker (Kev, 2026-10-30: "pack diese popup ref was wir auch bei image
     UI haben wo man dann reference content character und NFTs hat. hier werden aber ref content gespeichert bitte, mit X
     oben rechts löschbar"): Upload (pictures and clips), this visit's pictures, the account's saved references with their
     ×, Characters, NFTs. Every picture uploaded here is saved (library.save); a guest has none saved. */
  const addRef = (e: MouseEvent<HTMLButtonElement>) => setAsking(e.currentTarget.getBoundingClientRect());
  const source: RefSource = {
    uploads: d.uploads.filter((u) => !u.saved),
    library: library.saved,
    deletedRefs: library.deleted,
    myImages: [],
    refs: d.refs.map((r) => ({ id: r.saved ?? r.id })),
    room: d.room,
    toggleRef: (key) => {
      const saved = library.saved.find((l) => l.id === key);
      if (saved) d.toggleSaved(saved);
      else d.toggleUpload(key);
    },
    deleteRef: (id) => {
      library.remove(id);
      d.dropSaved(id);
    },
    addNfts: (picks) => void d.addNfts(picks),
  };
  const addRefs = (files: readonly File[]) => void d.addRefs(files, library.save);
  useToastOffset(120);

  /* What Generate can send: the pictures this model takes. A frame or a reference held asks the consent box first, on the
     client and again on the route (Kev, 2026-10-30: "die pflichten sollten wir alle einbauen"). */
  const [consent, setConsent] = useState(false);
  const runnable = !guest && Boolean(run) && videoCanRun(m, rate, s);
  const heldFrames = m.slots.includes("frames") ? d.frames : {};
  const heldRefs = m.slots.includes("refs") ? d.refs : [];
  const holdsMedia = Boolean(heldFrames.start || heldFrames.end) || heldRefs.length > 0;
  /** The first reason Generate cannot go; null when it can. */
  const stop = !runnable ? VIDEO_NOT_AVAILABLE
    : heldRefs.some((r) => r.kind === "clip") ? CLIPS_NOT_YET
    : overWhy ?? (!d.prompt.trim() ? WRITE_FIRST : holdsMedia && !consent ? VIDEO_CONSENT_REFUSED : null);
  /** A held picture as /api/video/jobs names it: its saved reference, saved now if it is not yet (every picture travels through the library). */
  const savedId = async (x: VideoMedia) => {
    if (x.saved) return x.saved;
    const image = x.url ? await readReference(x.url) : x.src;
    return image ? ((await library.save(image))?.id ?? null) : null;
  };
  const press = async () => {
    if (stop || !run) return notify(stop ?? VIDEO_NOT_AVAILABLE);
    const [start, end, ...refs] = await Promise.all([heldFrames.start, heldFrames.end, ...heldRefs].map((x) => (x ? savedId(x) : undefined)));
    if ([start, end, ...refs].some((id) => id === null)) return notify(NOT_SAVED, { tone: "error" });
    await run.press({
      modelId: m.id, settings: s, words: d.prompt.trim(),
      ...(start || end ? { frames: { start: start ?? undefined, end: end ?? undefined } } : {}),
      ...(refs.length ? { refs: refs as string[] } : {}),
      ...(holdsMedia ? { consent } : {}),
    });
  };

  return (
    <aside className="rx-compose vg-compose" aria-label="Video composer">
      <div className="rx-head">
        <h2 className="kit-title">Video</h2>
        <p>Words, frames or references to a clip.</p>
      </div>

      <div className="vg-model">
        {/* Every model's name and line in one cell, the picked one shown: the card is as tall as the longest. */}
        <span className="vg-model-text rx-both">
          {VIDEO_MODELS.map((x) => (
            <span key={x.id} className="vg-model-pair" aria-hidden={x.id !== m.id || undefined}>
              <span className="vg-model-name">{x.label}</span>
              <span className="vg-model-line">{x.line}</span>
            </span>
          ))}
        </span>
        <PillMenu trigger={<span>Change</span>} ariaLabel={`Model: ${m.label}. Change it`} title="Model" direction="down"
          options={VIDEO_MODELS.map((x) => ({ key: x.id, label: x.label, desc: x.line, sub: videoPrice(x, rateOf(x.id), fitSettings(x, d.wanted), held(x).clipTenths) }))}
          value={m.id} onPick={d.setModel} />
      </div>

      {m.slots.includes("frames") && (
        <div className="vg-frames" onDragOver={allowDrop}>
          {ENDS.map(({ end, label }) => {
            const f = d.frames[end];
            return (
              <div key={end} className="rx-drop vg-frame" data-filled={f ? true : undefined}
                onDrop={(e) => { const [file] = dropped(e); if (file && !blockFrames) void d.addFrame(end, file); }}>
                {f ? (
                  <>
                    {/* Keyed by the picture, so one a swap moved mounts anew and slides in, once: its mark goes as the
                        slide ends, so a model switch out and back does not replay it (review 2026-10-30). */}
                    {/* eslint-disable-next-line @next/next/no-img-element -- the buyer's own picture, read in place */}
                    <img key={f.id} className="vg-frame-img" src={f.src} alt={label} data-moved={moved.includes(f.id) ? end : undefined}
                      onAnimationEnd={() => setMoved((ids) => ids.filter((id) => id !== f.id))} />
                    <button type="button" className="kit-ref-x kit-hit rx-x" aria-label={`Remove the ${label.toLowerCase()}`}
                      onClick={() => d.removeFrame(end)}>
                      <Icon name="x" size={11} stroke={2.6} />
                    </button>
                  </>
                ) : (
                  <button type="button" className="rx-pick vg-pick" disabled={blockFrames}
                    onClick={() => { frameEnd.current = end; framePick.current?.click(); }}>
                    <Icon name="image" size={20} stroke={1.8} />
                    <span className="rx-pick-label">{label}</span>
                    <span className="rx-pick-sub">optional</span>
                  </button>
                )}
              </div>
            );
          })}
          {/* Start and end change places, one alone moves to the other end (Kev, 2026-10-30: "bei video editors, wo
              start und end image drin sein darf, eine funktion haben, wo ich start und end image responsively
              miteinander switchen kann"). */}
          <button type="button" className="vg-swap kit-hit" aria-label={SWAP} title={SWAP} disabled={!framesHeld} onClick={swap}>
            <ArrowLeftRight size={15} strokeWidth={2} aria-hidden />
          </button>
          <input ref={framePick} type="file" accept={PHOTO_TYPES.join(",")} hidden
            onChange={(e) => {
              const file = e.currentTarget.files?.[0];
              e.currentTarget.value = "";
              if (file) void d.addFrame(frameEnd.current, file);
            }} />
        </div>
      )}

      {m.slots.includes("refs") && (
        <>
          <div className="rx-drop rx-drop--photos" data-filled={d.refs.length > 0 || undefined} onDragOver={allowDrop}
            onDrop={(e) => { if (!blockRefs) addRefs(dropped(e)); }}>
            {d.refs.length === 0 ? (
              <button type="button" className="rx-pick vg-pick" disabled={blockRefs} aria-haspopup="dialog" aria-expanded={asking !== null} onClick={addRef}>
                <Icon name="film" size={20} stroke={1.8} />
                <span className="rx-pick-label">Add reference media</span>
                <span className="rx-pick-sub">Images or clips, optional</span>
              </button>
            ) : (
              <div className="kit-refs-row rx-photos">
                {d.refs.map((r, i) => (
                  <div key={r.id} className="kit-ref" data-over={over.includes(i) || undefined}>
                    <span className="kit-ref-img">
                      {r.kind === "clip"
                        ? <video src={r.src} muted loop playsInline autoPlay preload="metadata" />
                        // eslint-disable-next-line @next/next/no-img-element -- the buyer's own picture, read in place
                        : <img src={r.src} alt="" />}
                    </span>
                    {r.kind === "clip" && <span className="kit-ref-label">{lengthLabel(r.seconds ?? 0)}</span>}
                    <button type="button" className="kit-ref-x kit-hit" aria-label={`Remove reference ${i + 1}`} onClick={() => d.removeRef(r.id)}>
                      <Icon name="x" size={11} stroke={2.6} />
                    </button>
                  </div>
                ))}
                <button type="button" className="kit-ref-add kit-hit" aria-label="Add reference media" title="Add reference media"
                  disabled={blockRefs} aria-haspopup="dialog" aria-expanded={asking !== null} onClick={addRef}>
                  <span className="kit-ref-glyph" aria-hidden>+</span>
                </button>
              </div>
            )}
            <input ref={refPick} type="file" accept={[...PHOTO_TYPES, ...CLIP_TYPES].join(",")} multiple hidden
              onChange={(e) => {
                const picked = [...(e.currentTarget.files ?? [])];
                e.currentTarget.value = "";
                addRefs(picked);
              }} />
          </div>
          {asking && !blockRefs && (
            <RefPicker model={source} anchor={asking} phone={phone} onUpload={() => refPick.current?.click()} onClose={() => setAsking(null)} uploads />
          )}
        </>
      )}
      <div className="vg-note">
        {why ? <p className="rx-why" role="alert">{why}</p> : hint && <p className="rx-hint">{hint}</p>}
      </div>

      <div className="vg-prompt-head">
        <span className="rx-label">Prompt</span>
        {/* From a video's words to a prompt to keep or sell, as in Quick Create (Kev, 2026-10-30: "Make it a prompt
            zusatz bei beiden iwo so wie bei quick create"). It opens on Video, the words in it. */}
        <button type="button" className="kit-refs-link vg-make" title="Opens the prompt editor with these words" onClick={onMakePrompt}>
          Make it a prompt →
        </button>
      </div>
      {/* Taller, downwards (Kev, 2026-10-30: "vergrößere prompt editor nach unten"), and sized by its foot's right corner
          ("bei videos unten rechts"). */}
      <AutosizeTextarea className="kit-field-text" aria-label="Prompt" value={d.prompt} onChange={d.setPrompt}
        min={148} max={320} grip="down" growOnly={false} maxLength={2000} placeholder={placeholderOf(m)} />

      <label className="kit-field-check rx-prompt"
        title={m.audio === "on" ? `${m.label} always makes sound` : muted ? `${m.label} makes no sound from frames` : undefined}>
        <span className="rx-label">Include audio</span>
        <input type="checkbox" role="switch" checked={s.audio} disabled={m.audio === "on" || muted} onChange={(e) => d.set({ audio: e.target.checked })} />
        <span className="kit-switch" aria-hidden />
      </label>

      <VideoSettingsRow m={m} s={s} price={price} onSet={d.set} />

      {runnable && holdsMedia && (
        <label className="kit-field-check vg-consent">
          <span>{VIDEO_CONSENT}</span>
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
          <span className="kit-switch" aria-hidden />
        </label>
      )}
      <div className="rx-foot">
        <GenerateButton label={guest ? "Log in to generate" : "✦ Generate"} chip={guest ? null : videoPrice(m, rate, s, clipTenths)}
          dimmed={!guest && (Boolean(stop) || Boolean(run?.busy))} onPress={guest ? () => openLogin() : () => void press()} size="block" />
        <CostLine left={stop} />
      </div>
    </aside>
  );
}
