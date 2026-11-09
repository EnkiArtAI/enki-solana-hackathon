"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Lock, ShieldCheck } from "lucide-react";
import SettingsToggle from "@/components/settings/SettingsToggle";
import { useStepUp } from "@/components/StepUpProvider";
import { useToast } from "@/hooks/use-toast";
import { STEPUP_FACTORS_KEY, useStepUpFactors } from "@/hooks/useSecondFactor";
import { BACK_TO_RECOVERY, openLogin } from "@/lib/openLogin";
import { sessionAuthHeaders } from "@/lib/session-headers";
import { STEPUP_ACTIONS, STEPUP_DEFAULTS, type StepUpAction } from "@/lib/stepup-actions";

const LABEL: Record<StepUpAction, string> = {
  upload: "Upload an image",
  publish: "Publish a prompt",
  render: "Render an image",
  delete: "Delete an image or a library item",
};
/** What always asks, shown so the table tells the whole story. */
const ALWAYS = ["Use your wallet, export its key, withdraw", "Change your factors or guardians", "Delete your account"];

/**
 * Which actions ask for the second factor (Kev, 2026-10-17: one table of
 * switches). Switching one off asks for a factor itself; switching one on
 * asks nothing. The rest always asks.
 */
export default function StepUpActionsTable() {
  const { toast } = useToast();
  const { guarded } = useStepUp();
  const queryClient = useQueryClient();
  const { data } = useStepUpFactors();
  const [busy, setBusy] = useState<StepUpAction | null>(null);
  const actions = data?.actions ?? STEPUP_DEFAULTS;

  const change = async (action: StepUpAction, on: boolean) => {
    setBusy(action);
    try {
      const res = await guarded("stepup-settings", (h) => fetch("/api/auth/stepup", {
        method: "PATCH",
        headers: { "content-type": "application/json", ...sessionAuthHeaders(), ...h },
        body: JSON.stringify({ actions: { [action]: on } }),
      }));
      const body = (await res.json().catch(() => ({}))) as { error?: string; stepUp?: boolean; reauth?: boolean };
      // Cancelled at the second factor: nothing changed, nothing to report.
      if (res.status === 401 && body.stepUp) return;
      if (!res.ok) {
        toast({ title: body.error || "Could not save the setting", variant: "destructive" });
        // Without a factor, switching off needs a fresh login: offer it here.
        if (body.reauth) openLogin(BACK_TO_RECOVERY);
        return;
      }
      await queryClient.invalidateQueries({ queryKey: STEPUP_FACTORS_KEY });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="set-list-item" style={{ flexDirection: "column", alignItems: "stretch", gap: 8 }}>
      <div className="set-item-title">Ask for my second factor when I…</div>
      {data && data.factors.length === 0 && <div className="set-item-sub">Takes effect once you add a factor above.</div>}
      {STEPUP_ACTIONS.map((action) => (
        <div key={action} style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div className="set-item-icon"><ShieldCheck size={14} /></div>
          <div className="set-item-content set-item-sub" style={{ flex: 1 }}>{LABEL[action]}</div>
          <SettingsToggle checked={actions[action]} disabled={busy !== null || !data} onChange={(on) => void change(action, on)} />
        </div>
      ))}
      {ALWAYS.map((what) => (
        <div key={what} style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div className="set-item-icon"><Lock size={14} /></div>
          <div className="set-item-content set-item-sub" style={{ flex: 1 }}>{what}</div>
          <span className="set-badge-good">Always</span>
        </div>
      ))}
    </div>
  );
}
