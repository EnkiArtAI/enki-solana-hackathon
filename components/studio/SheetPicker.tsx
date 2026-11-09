"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { sessionAuthHeaders } from "@/lib/session-headers";
import { SHEET_CATEGORY } from "@/lib/studio/types";
import { sheetLink } from "@/lib/ui/studio/links";
import StudioDialog from "./StudioDialog";
import { openingSheet } from "./StudioScope";

type Sheet = { id: string; title: string; image: string | null };

/** The sheets whose title holds every word typed, in any order and case (Kev, 2026-10-30: "gimme auch eine suche beim
 *  character sheet auswahl, damit es fix ist"): filtered in place, no request per key. */
export function sheetsMatching(sheets: readonly Sheet[], query: string): Sheet[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return words.length ? sheets.filter((s) => words.every((w) => s.title.toLowerCase().includes(w))) : [...sheets];
}

/** The sheets on offer: the feed's Characters category, as the feed lists it (listed, active, adult-gated). */
export function useSheets(enabled = true) {
  return useQuery({
    enabled,
    queryKey: ["studio-sheets"],
    queryFn: async (): Promise<Sheet[]> => {
      const res = await fetch(`/api/marketplace/prompts?category=${encodeURIComponent(SHEET_CATEGORY)}&limit=60`, { headers: sessionAuthHeaders() });
      const body = (await res.json().catch(() => ({}))) as { prompts?: Array<{ id: string; title: string; previewImages?: string[] }>; error?: string };
      if (!res.ok) throw new Error(body.error ?? "Couldn't load the character sheets.");
      return (body.prompts ?? []).map((p) => ({ id: p.id, title: p.title, image: p.previewImages?.[0] ?? null }));
    },
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/**
 * The character sheets to pick one from (Kev, 2026-10-30: "Create Characters ... character sheets beispiele mir
 * vorgeschlagen werden, die ich dann auswählen kann ... very minimalistic but also responsive and similar to my image Ui
 * experience"): their pictures in a grid, one pick, ringed as the reference picker's tiles.
 */
export function SheetGrid({ picked, onPick }: { picked: string | null; onPick: (id: string) => void }) {
  const { data, error, isLoading } = useSheets();
  const [query, setQuery] = useState("");
  if (isLoading) return <p className="st-note">Loading the sheets…</p>;
  if (error || !data?.length) return <p className="st-note">{error?.message ?? "No character sheets on Enki yet."}</p>;
  const shown = sheetsMatching(data, query);
  return (
    <>
      <input type="search" className="st-input st-sheet-search" value={query} onChange={(e) => setQuery(e.target.value)}
        placeholder="Search character sheets" aria-label="Search character sheets" autoComplete="off" />
      {!shown.length && <p className="st-note">No sheet matches &ldquo;{query.trim()}&rdquo;.</p>}
      <div className="st-sheets" role="radiogroup" aria-label="Character sheets">
        {shown.map((s) => (
          <button key={s.id} type="button" role="radio" aria-checked={picked === s.id} data-on={picked === s.id || undefined}
            className="st-sheet" onClick={() => onPick(s.id)}>
            <span className="st-sheet-pic">
              {/* eslint-disable-next-line @next/next/no-img-element -- a feed picture, any size */}
              {s.image && <img src={s.image} alt="" loading="lazy" draggable={false} />}
            </span>
            <span className="st-sheet-title">{s.title}</span>
          </button>
        ))}
      </div>
      <p className="st-note">You add your character&apos;s photo in the next view.</p>
    </>
  );
}

/** "← Back" and "Use this sheet →", dimmed until a sheet is picked. */
export function SheetFoot({ picked, onBack, onUse }: { picked: string | null; onBack: () => void; onUse: () => void }) {
  return (
    <>
      <button type="button" className="st-btn st-btn--quiet" onClick={onBack}>← Back</button>
      <button type="button" className="st-btn st-btn--cta" aria-disabled={!picked || undefined} onClick={() => picked && onUse()}>Use this sheet →</button>
    </>
  );
}

/** Opens Create > Image on the sheet, for `project`: the image view asks for the photo, prices and renders it. Its entry
 *  is marked once it shows (useSheet), so its Back comes back here. */
export function useOpenSheet(project: string) {
  const router = useRouter();
  return (sheet: string) => { openingSheet(sheet); router.push(sheetLink(project, sheet)); };
}

/** "+ Character" on a project's page: the sheets in a dialog of their own. */
export default function SheetPicker({ project, onClose }: { project: string; onClose: () => void }) {
  const [picked, setPicked] = useState<string | null>(null);
  const open = useOpenSheet(project);
  return (
    <StudioDialog title="Pick a character sheet." onClose={onClose}
      foot={<SheetFoot picked={picked} onBack={onClose} onUse={() => { onClose(); open(picked!); }} />}>
      <SheetGrid picked={picked} onPick={setPicked} />
    </StudioDialog>
  );
}
