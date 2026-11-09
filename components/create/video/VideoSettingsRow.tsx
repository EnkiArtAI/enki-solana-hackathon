"use client";

import { useId, useRef, useState } from "react";
import PillMenu from "@/components/kit/PillMenu";
import RatioRect from "@/components/generation/RatioRect";
import { formatCopy } from "@/lib/ui/kit/option-copy";
import { AUTO, BITRATES, typedSeconds, type Aspect, type Bitrate, type Resolution, type VideoModel, type VideoSettings } from "@/lib/video/models";
import "@/components/kit/kit-media.css";
import "./video.css";

const shapeLabel = (a: Aspect) => (a === AUTO ? "Auto" : a);

/**
 * Length, then Aspect, Resolution and Bitrate side by side, as model `m` takes them: one row for every surface that sets
 * up a video (Kev, 2026-11-03: "gleiches visualisierungprinzip wie bei den bildern"). `price` is what each resolution
 * would cost, on the open menu.
 */
export default function VideoSettingsRow({ m, s, price, onSet }: {
  m: VideoModel;
  s: VideoSettings;
  price: (r: Resolution) => string | null;
  onSet: (next: Partial<VideoSettings>) => void;
}) {
  // Length's number as typed, while it has focus; Esc leaves it without taking it.
  const [typing, setTyping] = useState<string | null>(null);
  const escaped = useRef(false);
  const lengthId = useId();
  const bitrate = BITRATES.find((b) => b.key === s.bitrate);
  return (
    <div className="vg-rows">
      <div className="vg-row">
        <span className="kit-label" id={lengthId}>Length</span>
        {m.promptLength ? (
          <span className="vg-fixed">Up to {m.seconds.max} s, set by the words</span>
        ) : (
          <div className="kit-field-slider">
            <input type="range" aria-labelledby={lengthId} min={m.seconds.min} max={m.seconds.max} step={1} value={s.seconds}
              onChange={(e) => onSet({ seconds: Number(e.target.value) })} />
            {/* The seconds can be typed (Kev, 2026-10-30: "let me type in the length by clicking on the second anzahl"):
                Enter or leaving the field takes a whole number inside the model's range, Esc keeps the length. Text, not
                a number field, whose value the wheel steps while it has focus: the price moved as the column scrolled
                (review 2026-10-30). The phone still opens its number pad. */}
            <label className="kit-field-num vg-len-num">
              <input type="text" inputMode="numeric" enterKeyHint="done"
                aria-label={`Length in seconds, ${m.seconds.min} to ${m.seconds.max}`} value={typing ?? s.seconds}
                onFocus={(e) => { setTyping(String(s.seconds)); e.currentTarget.select(); }}
                // The click that focused it would undo the selection: a typed number replaces the length.
                onMouseUp={(e) => e.preventDefault()}
                onChange={(e) => setTyping(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" && e.key !== "Escape") return;
                  escaped.current = e.key === "Escape";
                  e.currentTarget.blur();
                }}
                onBlur={() => {
                  const n = escaped.current ? null : typedSeconds(m, typing ?? "");
                  escaped.current = false;
                  setTyping(null);
                  if (n !== null) onSet({ seconds: n });
                }} />
              <span aria-hidden>s</span>
            </label>
          </div>
        )}
      </div>
      {/* Aspect, Resolution and Bitrate side by side (Kev, 2026-10-30: "bei video generatoren, aspect ratio, resolution
          und bitrate kann in einer reihe platziert werden um platz zu sparen"), two where the model has no Bitrate.
          Each shape with its use, as the image pills have it (Kev, 2026-10-30: "damit ich weiß für welche platformn
          oder anwendung diese am besten genutzt werden können"), in the open menu only: a closed pill shows its value
          (Kev, 2026-10-30, on Bitrate's: "remove the zusatz ... zeig das nur beim dropdown, genauso wie bei den
          anderen dropdowns einstellungen"). */}
      <div className="vg-set">
        <div className="vg-cell">
          <span className="kit-label">Aspect</span>
          <PillMenu trigger={<><RatioRect ratio={s.aspect} size={14} /><span>{shapeLabel(s.aspect)}</span></>}
            ariaLabel={`Aspect ${shapeLabel(s.aspect)}`} title="Aspect" direction="up" columns={1} sheetColumns={2} sheetHint="The shape of your video"
            options={m.aspects.map((a) => ({
              key: a, label: shapeLabel(a), icon: <span className="kit-opt-shape"><RatioRect ratio={a} size={22} /></span>, desc: formatCopy(a),
            }))}
            value={s.aspect} onPick={(a) => onSet({ aspect: a as Aspect })} />
        </div>
        <div className="vg-cell">
          <span className="kit-label">Resolution</span>
          <PillMenu trigger={<span>{s.resolution}</span>} ariaLabel={`Resolution ${s.resolution}`} title="Resolution" direction="up"
            options={m.resolutions.map((r) => ({ key: r, label: r, sub: price(r) }))} value={s.resolution}
            onPick={(r) => onSet({ resolution: r as Resolution })} />
        </div>
        {m.bitrate && (
          <div className="vg-cell">
            <span className="kit-label">Bitrate</span>
            <PillMenu trigger={<span>{bitrate?.label}</span>}
              ariaLabel={`Bitrate ${s.bitrate}`} title="Bitrate" direction="up" options={BITRATES.map((b) => ({ ...b }))} value={s.bitrate}
              onPick={(b) => onSet({ bitrate: b as Bitrate })} />
          </div>
        )}
      </div>
    </div>
  );
}
