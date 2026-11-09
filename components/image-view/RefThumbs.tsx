"use client";

import { useState } from "react";
import type { Rect } from "@/lib/ui/image-view/zoom";
import Zoom from "./Zoom";

/**
 * The references someone's public image was made with, where its owner shows them (Kev, 2026-10-29: "als mini bild ...
 * click auf das kleine bild macht es normal groß wie bei image ui behavior und wenn ich hover over mache, wird es nur
 * auf 2x größer responsively"; DEC-514): small squares that grow to twice their size under the pointer, back when it
 * leaves, and open large on a click as a photo of the composer does.
 */
export default function RefThumbs({ refs, phone, overViewer, className }: {
  refs: string[];
  phone: boolean;
  /** Inside the fullscreen viewer: the large photo opens above it. */
  overViewer?: boolean;
  className: string;
}) {
  const [zoom, setZoom] = useState<{ i: number; from: Rect } | null>(null);
  if (!refs.length) return null;
  return (
    <>
      <div className={className} role="group" aria-label="Reference images">
        {refs.map((src, i) => (
          <button key={`${i}:${src}`} type="button" className="iv-ref" aria-label={`Reference image ${i + 1}`} title={`Reference image ${i + 1}`}
            style={{ backgroundImage: `url("${src}")` }}
            onClick={(e) => setZoom({ i, from: e.currentTarget.getBoundingClientRect() })} />
        ))}
      </div>
      {zoom && <Zoom src={refs[zoom.i]} n={zoom.i + 1} from={zoom.from} phone={phone} overViewer={overViewer} onClose={() => setZoom(null)} />}
    </>
  );
}
