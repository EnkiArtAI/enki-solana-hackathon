"use client";

import { useState, type CSSProperties, type ReactNode } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { sessionAuthHeaders } from "@/lib/session-headers";
import { CARD, CTA, FIELD, PILL, ROUND, TEXT, TITLE } from "@/components/enki-window";
import { REPORT_REASONS, type ReportReason, type ReportTarget } from "@/lib/report-reasons";

const NOUN: Record<ReportTarget, string> = { prompt: "prompt", generation: "image", user: "profile" };

/**
 * A button that opens the report popup (Kev, 2026-10-08): pick what is wrong,
 * say it in your own words, send. The report lands in the admin panel's
 * Reports tab. Clicks and keys inside stay here, so a lightbox around the
 * button neither closes nor pages while someone types.
 */
export function ReportButton({ targetType, targetId, className, style, children }: {
  targetType: ReportTarget;
  targetId: string;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<ReportReason | "">("");
  const [details, setDetails] = useState("");
  const [state, setState] = useState<{ busy?: boolean; error?: string; sent?: boolean }>({});
  const noun = NOUN[targetType];
  const needsWords = reason === "other" && !details.trim();

  const close = () => {
    setOpen(false);
    setReason("");
    setDetails("");
    setState({});
  };
  const send = async () => {
    setState({ busy: true });
    try {
      const res = await fetch("/api/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...sessionAuthHeaders() },
        body: JSON.stringify({ targetType, targetId, reason, details: details.trim() || undefined }),
      });
      const d = await res.json().catch(() => ({}));
      setState(res.ok ? { sent: true } : { error: d.error ?? "Could not send the report. Try again." });
    } catch {
      setState({ error: "Network hiccup. Nothing was sent." });
    }
  };

  return (
    <span className="contents" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <button type="button" className={className} style={style} aria-label={`Report this ${noun}`} title={`Report this ${noun}`} onClick={() => setOpen(true)}>
        {children}
      </button>
      <Dialog open={open} onOpenChange={(o) => { if (!o && !state.busy) close(); }}>
        {/* Level with the lightbox (z 9999), above it by coming later in the
            page, and under the step-up dialog (10000) should a report ever
            need it; 16px clear of the edges on a phone. Escape closes the
            popup alone: Radix acts on it while capturing, before the
            bubbling the wrapper above stops. */}
        <DialogContent
          className="w-[calc(100%-32px)] max-w-md z-[9999]"
          overlayClassName="z-[9999] bg-black/50 backdrop-blur-[6px]"
          style={CARD}
          closeStyle={ROUND}
          onEscapeKeyDown={(e) => e.stopPropagation()}
        >
          {state.sent ? (
            <div className="grid gap-4">
              <DialogHeader>
                <DialogTitle style={TITLE}>Thanks, it is with us</DialogTitle>
                <DialogDescription style={{ ...TEXT, color: "var(--enki-ink-2)" }}>An admin looks at every report.</DialogDescription>
              </DialogHeader>
              <button type="button" style={PILL} onClick={close}>Close</button>
            </div>
          ) : (
            <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); void send(); }}>
              <DialogHeader>
                <DialogTitle style={TITLE}>Report this {noun}</DialogTitle>
                <DialogDescription style={{ ...TEXT, color: "var(--enki-ink-2)" }}>An admin reviews every report. The person you report does not see who sent it.</DialogDescription>
              </DialogHeader>
              <select required value={reason} onChange={(e) => setReason(e.target.value as ReportReason)} className={FIELD} aria-label="What is wrong">
                <option value="" disabled>What is wrong?</option>
                {REPORT_REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
              </select>
              <textarea
                value={details}
                onChange={(e) => setDetails(e.target.value)}
                maxLength={1000}
                rows={4}
                placeholder={reason === "other" ? "Tell us what is wrong" : "Anything an admin should know (optional)"}
                className={FIELD}
                aria-label="What is the problem"
              />
              {state.error && <p className="text-sm" style={{ color: "var(--enki-danger)" }}>{state.error}</p>}
              <button type="submit" className="disabled:opacity-50" style={CTA} disabled={!reason || needsWords || state.busy}>
                {state.busy ? "Sending…" : "Send report"}
              </button>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </span>
  );
}
