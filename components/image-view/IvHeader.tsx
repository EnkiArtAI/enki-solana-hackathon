"use client";

import { Icon } from "@/components/enki-shell/icons";
import { openLogin } from "@/lib/openLogin";
import type { ImageViewModel } from "./useImageViewModel";

/**
 * The page's top row (handoff §5.2): Back on the left; a guest gets Log in on
 * the right (plan Q5). No balance and no seal in the corner (Kev, 2026-10-29:
 * "remove bitte doch the profile image and the dollar on the top right corner
 * wo auch immer das so auftaucht"): the menu's account row holds both. On
 * desktop the logo shows only while the shell's menu is closed to its strip
 * (CSS); on the phone layout the logo is the way out (plan Q14). No worlds
 * switcher until video prompts exist (plan D1).
 */
export default function IvHeader({ model: m, onBack, phone = false }: { model: ImageViewModel; onBack: () => void; phone?: boolean }) {
  return (
    <header className={phone ? "iv-top iv-top--phone" : "iv-top"}>
      <div className="iv-top-left">
        {phone ? (
          <button type="button" className="iv-top-home" aria-label="Back" title="Back" onClick={onBack}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/enki-wordmark.svg" alt="Enki Art" />
          </button>
        ) : (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="iv-top-logo" src="/enki-wordmark.svg" alt="Enki Art" />
            <button type="button" className="iv-back kit-hit" aria-label="Back" title="Back" onClick={onBack}>
              <Icon name="chevronLeft" size={14} stroke={1.5} />
            </button>
            {/* Where the image belongs, beside the way back (Kev, 2026-10-21). */}
            {m.category && <span className="iv-top-cat">{m.category}</span>}
          </>
        )}
      </div>
      <div className="iv-top-right">
        {m.guest && <button type="button" className="iv-login" onClick={() => openLogin()}>Log in</button>}
      </div>
    </header>
  );
}
