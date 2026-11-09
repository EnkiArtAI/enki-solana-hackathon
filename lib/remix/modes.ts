/**
 * Remix's two ways (Kev, 2026-10-30: "do you see the UI of sume? we need EXACTLY the same one, slightly angepasst an
 * unsere UI aber ... bei Remix kommt dann diese UI"), in Enki's own words. Motion transfer: the people in the photos
 * move the way the clip moves. Object swap: people or things in the clip become the ones in the photos. Both take a
 * 4 to 15 s clip and 1 to 8 photos; the prompt is optional.
 */
export type RemixMode = "motion" | "swap";

export const REMIX_MODES: Readonly<Record<RemixMode, {
  /** The switch, and a card's mode label. */
  label: string;
  /** The title card's line under "Remix". */
  line: string;
  /** The photo drop zone's label. */
  photos: string;
  /** The line under the drop zones. */
  hint: string;
  placeholder: string;
}>> = {
  motion: {
    label: "Motion transfer",
    line: "Your photos move the way the clip moves.",
    photos: "Add person photo",
    hint: "A 4-15 s clip and 1-8 photos that move like it. The prompt is optional.",
    placeholder: "Anything to keep or change, e.g. keep the background",
  },
  swap: {
    label: "Object swap",
    line: "People or things in the clip become the ones in your photos.",
    photos: "Add reference image",
    hint: "A 4-15 s clip and 1-8 photos that take the place of people or things in it. The prompt is optional.",
    placeholder: "Which person or thing to replace, e.g. the dog",
  },
};
