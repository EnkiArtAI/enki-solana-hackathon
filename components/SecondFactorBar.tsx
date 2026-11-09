"use client";

import { useLayoutEffect } from "react";
import { usePathname } from "next/navigation";
import { PUBLIC_PATHS, useBetaAccess } from "@/components/BetaGate";
import { useNeeds2fa } from "@/hooks/useSecondFactor";
import { trialLine } from "@/lib/ui/trial-line";

/** The one 30 px slot at the top, whichever line it carries. */
const BAR: React.CSSProperties = {
  position: "fixed", top: 0, left: 0, right: 0, height: 30, zIndex: 300,
  color: "#fff", border: "none", padding: "0 14px",
  fontFamily: "inherit", fontWeight: 600, fontSize: 12.5, lineHeight: "30px", textAlign: "center",
  whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
};

/**
 * The permanent red bar (Kev, 2026-10-07): every signed-in account without a
 * second factor sees it at the top, on every page, with no way to close it.
 * 2FA stays optional; the bar is the reminder that the account is at risk.
 * It opens the 2FA settings in the shell, or the Settings page elsewhere.
 * It displaces the page, never covers it: fixed layers read --ek-banner-h,
 * and a page outside the shell starts below it (html.ek-2fa-bar, globals.css).
 */
export default function SecondFactorBar() {
  const pathname = usePathname() ?? "/";
  const needs2fa = useNeeds2fa();
  // A trial tester's slot says when the trial ends and what its budget has left instead (lib/trial): a trial account
  // is not kept, so its risk is not the point.
  const { trial } = useBetaAccess();
  const show = (needs2fa || !!trial) && !PUBLIC_PATHS.has(pathname) && !pathname.startsWith("/banned")
    && typeof window !== "undefined" && window.top === window.self;

  // Before paint: the page moves with the bar, never a frame later.
  useLayoutEffect(() => {
    if (!show) return;
    const root = document.documentElement;
    root.style.setProperty("--ek-banner-h", "30px");
    root.classList.add("ek-2fa-bar");
    return () => {
      root.style.removeProperty("--ek-banner-h");
      root.classList.remove("ek-2fa-bar");
    };
  }, [show]);

  if (!show) return null;
  // Plain text, as the red bar is a plain button: a status region would be read out again on every page.
  // ek-top-slot: on a phone the slot goes up with the shell's header when it tucks (enki-shell.css).
  if (trial) return <div className="ek-top-slot" style={{ ...BAR, background: "#7d1d33", cursor: "default" }}>{trialLine(trial)}</div>;
  const open = () => {
    const notConsumed = window.dispatchEvent(new CustomEvent("enki:open-2fa", { cancelable: true }));
    if (notConsumed) window.location.assign("/settings?tab=recovery");
  };
  return (
    <button
      type="button"
      className="ek-top-slot"
      onClick={open}
      style={{ ...BAR, background: "#b3271e", cursor: "pointer" }}
    >
      No 2FA yet: your account is at risk. Set it up
    </button>
  );
}
