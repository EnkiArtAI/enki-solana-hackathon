"use client";

import GeneratorLogo from "@/components/generation/GeneratorLogo";
import { quoteLabel } from "@/hooks/useServerQuotes";
import { generatorCopy } from "@/lib/ui/kit/option-copy";
import type { CatalogueEntry } from "@/hooks/useModelLimits";
import type { GenerationQuote } from "@/lib/generation-checkout";
import PillMenu from "./PillMenu";

/**
 * The generator picker. `look: "logo"` shows only the mark (handoff §0: the
 * pill is the logo, the list has the names); `"named"` shows a dot and the
 * name; `"logo-name"` both (image UI v2, whose phone hides the name in CSS).
 * `describe` adds what each generator is good at under its name. Each row carries the server's price at the current settings, "$0.00"
 * on the free host (never the word "free", R30), or its tag instead.
 */
export default function GeneratorPill({ models, value, onChange, prices, tags, look, describe = false, placeholder = "Pick a generator", direction, title = "Generator", hint, disabled, sheetHint = "Which AI makes your image" }: {
  models: CatalogueEntry[];
  value: string | null;
  onChange: (id: string) => void;
  /** The caller's useServerQuotes results, aligned with `models`. */
  prices: Array<GenerationQuote | null>;
  /** Replaces a row's price, e.g. "primary". */
  tags?: Record<string, string>;
  look: "logo" | "named" | "logo-name";
  describe?: boolean;
  placeholder?: string;
  direction: "up" | "down";
  /** The menu's heading, for a surface with two pickers ("Primary generator", "Test generator"). */
  title?: string;
  hint?: string;
  /** Nothing to pick from yet (the editor before any generator is on offer). */
  disabled?: boolean;
  /** Over the phone's sheet, with `describe`. */
  sheetHint?: string;
}) {
  const entry = models.find((m) => m.id === value);
  return (
    <PillMenu
      trigger={!entry ? <span className="kit-unset">{placeholder}</span>
        : look === "logo" ? <GeneratorLogo name={entry.name} size={15} />
        : look === "logo-name" ? <><GeneratorLogo name={entry.name} size={15} /><span className="kit-pill-name">{entry.name}</span></>
        : <><span className="kit-dot" aria-hidden />{entry.name}</>}
      ariaLabel={!entry ? placeholder : look === "logo" ? `${entry.name} · the price follows this generator` : entry.name}
      title={title}
      hint={hint}
      options={models.map((m, i) => ({
        key: m.id,
        label: m.name,
        icon: <GeneratorLogo name={m.name} size={15} />,
        desc: describe ? generatorCopy(m.name) : undefined,
        sub: tags?.[m.id] ?? (m.free ? "$0.00" : quoteLabel(prices[i])),
      }))}
      value={value}
      onPick={onChange}
      direction={direction}
      disabled={disabled}
      sheetHint={describe ? sheetHint : undefined}
    />
  );
}
