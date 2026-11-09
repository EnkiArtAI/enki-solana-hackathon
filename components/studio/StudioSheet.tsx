"use client";

import EnkiDetailPanel from "@/components/enki/EnkiDetailPanel";
import { useSheet } from "./StudioScope";

/** The character sheet the address names, in the real image view over Create > Image (Kev, 2026-10-30: "I select one
 *  of many character sheets, put my referenced character to it and the result is then being saved in Characters for
 *  this specific project"): its photo, fields, generator, price and Generate are the image view's own. */
export default function StudioSheet() {
  const sheet = useSheet();
  return sheet && <EnkiDetailPanel key={`sheet:${sheet.seed.promptId}`} seed={sheet.seed} onClose={sheet.close} />;
}
