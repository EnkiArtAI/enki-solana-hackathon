"use client";

import GeneratorLogo from "@/components/generation/GeneratorLogo";
import PillMenu from "@/components/kit/PillMenu";
import { quoteLabel } from "@/hooks/useServerQuotes";
import type { CatalogueEntry } from "@/hooks/useModelLimits";
import type { GenerationQuote } from "@/lib/generation-checkout";

/** The All row's key; catalogue ids are database ids, never this. */
const ALL = "*";

/**
 * The generators the prompt offers: one pill, a menu of checkboxes that
 * stays open while they are ticked (Kev, 2026-10-13: "ein Dropdown-Menü mit
 * Checkboxes"; the chips before it moved as their prices loaded). There is
 * no primary generator: buyers get the settings of the image they look at.
 * The whole list goes out as aiModels; the test bar below offers only these.
 */
export default function GeneratorRow({ models, selected, locked = false, prices, labels, onToggle, onAll }: {
  models: CatalogueEntry[];
  /** Catalogue ids on offer (the editor's effective listing). */
  selected: readonly string[];
  /** A free prompt: every generator, shown and not for picking (Kev, 2026-10-14). */
  locked?: boolean;
  /** Server quotes at the current settings, aligned with `models`. */
  prices: Array<GenerationQuote | null>;
  /** The price as it is already written, aligned with `models`, in place of `prices` (a video's, from its rate). */
  labels?: string[];
  onToggle: (id: string) => void;
  /** The All row: every generator on offer, or none when every one already is. */
  onAll: () => void;
}) {
  // Ticked while every generator is on (Kev, 2026-10-26: "an option saying 'all' at the top that just selects them all").
  const every = models.length > 0 && models.every((m) => selected.includes(m.id));
  const names = models.filter((m) => selected.includes(m.id)).map((m) => m.name);
  // No surface calls a video free (Kev, 2026-11-04: "videos sind nicht umsonst. die kosten alle."); `labels` is a video's.
  const prompt = labels ? "an Open prompt" : "a free prompt";
  const face = locked ? "Every generator"
    : !names.length ? <span className="kit-unset">Pick generators</span>
    : names.length <= 2 ? names.join(" · ") : `${names.length} generators`;
  return (
    <div className="pe-row pe-gen-row">
      <span className="kit-label">Gen<span className="pe-wide-only">erators</span></span>
      <PillMenu
        trigger={face}
        ariaLabel={locked ? `Every generator is on offer on ${prompt}` : names.length ? `Generators on offer: ${names.join(", ")}` : "Pick the generators buyers may use"}
        title="Generators on offer"
        hint={locked ? `${prompt[0].toUpperCase()}${prompt.slice(1)} runs on every generator` : "Buyers pick from these"}
        direction="down"
        options={[{ key: ALL, label: "All" }, ...models.map((m, i) => ({ key: m.id, label: m.name, icon: <GeneratorLogo name={m.name} size={15} />, sub: labels?.[i] ?? (m.free ? "$0.00" : quoteLabel(prices[i])) }))]}
        value={null}
        selected={every ? [ALL, ...selected] : selected}
        onPick={locked ? () => {} : (key) => (key === ALL ? onAll() : onToggle(key))}
      />
      <span className="pe-note">buyers pick from these</span>
    </div>
  );
}
