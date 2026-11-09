"use client";

import type { RefSource } from "@/components/image-view/RefPicker";
import { useStudioScope } from "./StudioScope";
import "./studio.css";

/**
 * The project's pictures first in the reference picker, while Create works in one (Kev, 2026-10-30: "There I have
 * access to my reference images from that project and characters"): its assets on Images, under the project's name,
 * its characters on Characters, their names under them. A tile is a switch as the picker's own are: on while that
 * picture is in the prompt, off and greyed when the generator takes no more. Nothing goes in by itself: each reference
 * is one of at most four and changes the price. Nothing at all outside a project.
 */

/** A picture's address without its signature: every read of Studio signs its assets anew (a new ?token=), so the one in
 *  the prompt is matched by its path and taken out by its own key (review 2026-10-30: a second press added a copy). */
const unsigned = (url: string) => url.split(/[?#]/)[0];

export default function StudioRefTiles({ model: m, at, kind }: { model: RefSource; at?: number; kind: "assets" | "characters" }) {
  const scope = useStudioScope();
  if (!scope) return null;
  const tiles = kind === "assets"
    ? scope.project.assets.map((a) => ({ key: a.id, url: a.url, thumb: a.thumb, name: null as string | null }))
    : scope.project.characters.flatMap((c) => (c.picture ? [{ key: c.id, url: c.picture.url, thumb: c.picture.thumb, name: c.name }] : []));
  if (!tiles.length) return null;
  const full = m.room <= 0;
  return (
    <section className="st-rt" data-kind={kind} aria-label={kind === "assets" ? `${scope.project.project.name}'s pictures` : `${scope.project.project.name}'s characters`}>
      {kind === "assets" && <span className="kit-label st-rt-head">{scope.project.project.name}</span>}
      <div className="iv-rp-grid">
        {tiles.map(({ key, url, thumb, name }) => {
          const ref = m.refs.find((r) => unsigned(r.id) === unsigned(url));
          const on = !!ref;
          return (
            <figure key={key} className="st-rt-tile">
              <button type="button" className="iv-rp-item" disabled={full && !on} aria-pressed={on} data-on={on || undefined}
                aria-label={name ?? undefined} title={on ? "In the prompt · press to take it out" : name ?? "Use this image"}
                onClick={() => m.toggleRef(ref?.id ?? url, at)}>
                {/* eslint-disable-next-line @next/next/no-img-element -- a signed tile */}
                <img src={thumb} alt="" loading="lazy" draggable={false} />
              </button>
              {name && <figcaption className="st-rt-name">{name}</figcaption>}
            </figure>
          );
        })}
      </div>
    </section>
  );
}
