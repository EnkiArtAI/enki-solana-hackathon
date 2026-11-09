"use client";

import AddFundsPopover from "@/components/kit/AddFundsPopover";
import CountStepper from "@/components/kit/CountStepper";
import CostLine from "@/components/kit/CostLine";
import GenerateButton from "@/components/kit/GenerateButton";
import GeneratorPill from "@/components/kit/GeneratorPill";
import PillMenu from "@/components/kit/PillMenu";
import { QualityPill, RatioPill, ResolutionPill } from "@/components/kit/SettingsPills";
import VideoSettingsRow from "@/components/create/video/VideoSettingsRow";
import { quoteLabel } from "@/hooks/useServerQuotes";
import { openAddFunds } from "@/lib/ui/kit/controls";
import { lockedFor } from "@/lib/ui/kit/wheel";
import type { ImageViewModel } from "./useImageViewModel";

/** One count in the phone's grid: its price, and locked where the balance cannot pay for that many (plan D18). No line
    under it: it said the same for every count (Kev, 2026-10-26: "weil der text original der gleiche ist"). */
function countOption(m: ImageViewModel, n: number) {
  const locked = !m.core.free && m.quote !== null && m.balanceUsd !== null && lockedFor(m.quote.totalMicro / 1_000_000, n, m.balanceUsd);
  return {
    key: String(n),
    label: `×${n}`,
    sub: m.core.free ? null : quoteLabel(m.quote, n),
    disabled: locked,
    title: locked ? "More than your balance covers. Add funds or pick fewer." : undefined,
  };
}

/**
 * The composer's foot, the same on desktop and phone: the settings row,
 * Generate with the low-balance question, the line under it. The count is a
 * stepper on desktop and a pill on the phone, whose sheet shows every count at
 * once and takes a typed one (Kev, 2026-10-26: "einfach auswählen zwischen
 * anzahl oder halt selbst was eintippen via click auf die zahl"). A video
 * prompt has the video settings row and no count at all (Kev, 2026-11-03: "allow
 * also only the creation of 1 video for premium prompts").
 */
export default function ComposeFoot({ model: m, phone = false }: { model: ImageViewModel; phone?: boolean }) {
  // The phone's count pill only; the desktop has its stepper.
  const counts = phone && !m.guest ? Array.from({ length: m.countMax }, (_, i) => countOption(m, i + 1)) : [];
  // A greyed count says why on screen, where a touch has no hover title (review 2026-10-26).
  const lockedFrom = counts.find((o) => o.disabled);
  const reset = m.settingsChanged && (
    <button type="button" className="iv-reset kit-hit" aria-label="Set back to the prompt's settings" title="Set back to the prompt's settings"
      onClick={m.resetSettings}>↺</button>
  );
  return (
    <div className="iv-foot">
      <div className="iv-bar">
        <GeneratorPill models={m.models} value={m.core.entry?.id ?? null} onChange={m.pickModel} prices={m.modelPrices}
          look={m.video ? "named" : "logo-name"} describe direction="up" sheetHint={m.video ? "Which AI makes your video" : undefined} />
        {!m.guest && m.video && reset}
        {!m.guest && !m.video && (
          <>
            <RatioPill core={m.core} value={m.ratio} onChange={m.setRatio} describe />
            <ResolutionPill core={m.core} value={m.resolution} onChange={m.setResolution} prices={m.tierPrices} describe />
            {m.core.supportsQuality && <QualityPill value={m.quality} onChange={m.setQuality} prices={m.qualityPrices} describe />}
            {/* No Boost toggle for now: it will pick the cheapest or fastest host by itself later (Kev, 2026-10-13). */}
            {phone ? (
              <PillMenu trigger={<span>×{m.count}</span>} ariaLabel={`${m.count} image${m.count === 1 ? "" : "s"} per run`} title="How many images"
                options={counts} value={String(m.count)} onPick={(k) => m.setCount(Number(k))}
                sheetHint={lockedFrom ? `${lockedFrom.label} and up: more than your balance` : "Several takes in one go"} sheetColumns={4}
                typed="Or type a number" />
            ) : <CountStepper value={m.count} max={m.countMax} onChange={m.setCount} />}
            {reset}
          </>
        )}
      </div>
      {!m.guest && m.video?.foot && <VideoSettingsRow m={m.video.foot.model} s={m.video.foot.settings} price={m.video.foot.price} onSet={m.video.foot.set} />}
      <div className="iv-gen">
        {m.funds && (
          <AddFundsPopover balanceUsd={m.funds.balanceUsd} totalUsd={m.funds.totalUsd} onAddFunds={openAddFunds}
            onTryAnyway={m.tryAnyway} onClose={m.closeFunds} />
        )}
        <GenerateButton label={m.button.label} chip={m.photosNeeded ? null : m.chip} chipPending={!m.photosNeeded && m.quotePending}
          dimmed={m.button.dimmed} short={m.photosNeeded ? null : m.short} onPress={m.generate} size="hero" />
      </div>
      <CostLine left={m.cost} />
    </div>
  );
}
