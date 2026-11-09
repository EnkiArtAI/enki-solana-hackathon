"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { KeyRound, LifeBuoy, Loader2, ShieldCheck } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { STEPUP_FACTORS_KEY, useStepUpFactors } from "@/hooks/useSecondFactor";
import { refreshRecoveryStatus } from "@/hooks/useRecoveryStatus";
import { sessionAuthHeaders } from "@/lib/session-headers";
import { useStepUp, type Factor } from "@/components/StepUpProvider";

const FACTOR_LABEL: Record<Factor, string> = { passkey: "Passkeys", totp: "Authenticator app", email: "Code by email" };
// The look of the panel's other inputs (the guardian field).
const field: React.CSSProperties = {
  height: 34, fontSize: 13, padding: "0 10px", border: "1px solid var(--enki-rule)",
  borderRadius: 6, background: "transparent", color: "var(--enki-ink)", outline: "none",
};

export const RECOVERY_STATUS_KEY = "mfa-recovery";

// As lib/mfa-recovery.ts normalizeCode, a server module: a leading "3. " goes, case, dashes and spaces do not matter, O reads
// as 0, I and L as 1.
const sameCode = (a: string, b: string) => {
  const norm = (s: string) => s.replace(/^\s*\d+[.)]\s*/, "").toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  return norm(a) === norm(b);
};

/**
 * Codes are shown once, here. Only "I saved them" closes it: neither a click beside it nor Esc may lose them. Esc stops here,
 * as at every layer over the panel; a browser's Back still closes the panel behind it (DEC-2026-11-05-47). On the page
 * itself: .set-tabpane's will-change would hold it inside the tab, with Back and the menu still clickable.
 * "I saved them" asks for one code, named by its number, typed back (Kev: "recovery codes werden meist vergessen"); checked
 * here against the codes just shown (DEC-2026-11-07-25).
 */
export function RecoveryCodesDialog({ codes, onClose }: { codes: string[]; onClose: () => void }) {
  const { toast } = useToast();
  const [asked] = useState(() => Math.floor(Math.random() * codes.length));
  const [typed, setTyped] = useState("");
  const [wrong, setWrong] = useState(false);
  const n = (asked % codes.length) + 1;
  const done = () => (sameCode(typed, codes[n - 1]) ? onClose() : setWrong(true));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") e.stopPropagation(); };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      toast({ title: "Copied" });
    } catch { toast({ title: "Copy failed", variant: "destructive" }); }
  };
  const dialog = (
    <div className="set-pay-overlay">
      <div className="set-pay-card set-pay-card--fiat" style={{ overflowY: "auto" }} role="dialog" aria-modal="true" aria-label="Recovery codes">
        <div className="set-item-title" style={{ marginBottom: 6 }}>Recovery codes</div>
        <p className="set-item-sub" style={{ marginBottom: 12 }}>
          Save these recovery codes. Each works once. If you lose a factor, one code removes it. They are not shown again.
        </p>
        <code style={{ display: "block", padding: "10px 12px", borderRadius: 8, fontSize: 13, lineHeight: 1.7, textAlign: "center", userSelect: "all", whiteSpace: "pre-line", border: "1px solid var(--enki-rule)", background: "var(--enki-paper-2)", color: "var(--enki-ink)" }}>
          {codes.map((c, i) => `${i + 1}. ${c}`).join("\n")}
        </code>
        <button className="set-btn set-btn-outline" style={{ width: "100%", justifyContent: "center", marginTop: 12 }} onClick={copy}>Copy</button>
        <p className="set-item-sub" style={{ marginTop: 12, marginBottom: 6 }}>{`To make sure you saved them, type code ${n} from where you keep them.`}</p>
        <input style={{ ...field, width: "100%", textAlign: "center" }} placeholder="XXXX-XXXX-XXXX-XXXX" autoComplete="off" spellCheck={false} aria-label={`Code ${n}`} value={typed}
          onChange={(e) => { setTyped(e.target.value); setWrong(false); }} onKeyDown={(e) => { if (e.key === "Enter" && typed.trim()) done(); }} />
        {wrong && <p role="alert" className="set-item-sub" style={{ marginTop: 6, color: "var(--enki-danger)" }}>{`That is not code ${n}. Check it against the list above.`}</p>}
        <button className="set-btn set-btn-dark" style={{ width: "100%", justifyContent: "center", marginTop: 8 }} onClick={done} disabled={!typed.trim()}>I saved them</button>
      </div>
    </div>
  );
  return typeof document !== "undefined" && document.body ? createPortal(dialog, document.body) : dialog;
}

type GuardianAsk = { factor: Factor; approved: number; needed: number; expiresAt: string; wallets: { guardian: string; link: string }[] };
type Status = {
  available: boolean; codesLeft: number; addresses?: number; mailRefused?: string | null;
  guardians?: { askable: number; reachable?: number; total?: number; needed: number; ask: GuardianAsk | null } | null;
};

/**
 * The ways back in for a lost factor (lib/mfa-recovery.ts): a recovery code, the guardians' yes (two or more who can be
 * asked, and as many as must say yes still reachable: lib/recovery/guardian-check.ts) and a code to each address (two
 * addresses or more). With one way or none left: what losing it means and what to add.
 */
function waysBack(s: Status) {
  const g = s.guardians ?? { askable: 0, reachable: 0, total: 0, needed: 2 };
  const reachable = g.reachable ?? g.askable;
  const guardiansWork = g.askable >= 2 && reachable >= g.needed;
  const addresses = s.addresses ?? 0;
  const ways = [
    ...(s.codesLeft ? ["a recovery code"] : []),
    ...(guardiansWork ? ["your guardians"] : []),
    ...(addresses >= 2 ? ["a code to each of your email addresses"] : []),
  ];
  const add = [
    ...(s.codesLeft ? [] : ["new recovery codes"]),
    ...(guardiansWork ? [] : [reachable < g.askable ? "a guardian in place of one not reachable" : "guardians (three is best)"]),
    ...(addresses >= 2 ? [] : ["a second email address (Lost a factor below says how)"]),
  ];
  const what = add.length > 1 ? `${add.slice(0, -1).join(", ")} or ${add.at(-1)}` : add[0];
  const warning = ways.length === 1
    ? `Only one way back is left: ${ways[0]}. Lose it together with a factor and your wallet stays locked. Add ${what}.`
    : ways.length === 0 ? `No way back is left: lose a factor and your wallet stays locked. Add ${what}.` : null;
  // Every guardian who can still be reached must say yes: one more out of reach blocks the way. Two is the floor of how many
  // must say yes (lib/mfa-recovery.ts yesNeeded), so at two only adding or replacing a guardian helps (DEC-2026-11-07-31).
  const allMustSay = guardiansWork && reachable <= g.needed
    ? `All ${reachable} of your guardians${reachable < g.askable ? " who can be reached" : ""} must say yes, so one you cannot reach blocks that way. ${g.askable === 2 ? "Add a third: three guardians is best." : g.needed > 2 ? "Add another guardian, or lower how many must approve." : "Add another guardian, or replace one who is not reachable."}`
    : null;
  return {
    count: ways.length,
    // Of all on the list, the ones this way can use: an authenticator or phone guardian is confirmed and still never asked.
    line: `Recovery codes: ${s.codesLeft} left · Guardians: ${reachable} of ${g.total ?? 0} can be asked and reached · Email addresses: ${addresses}`,
    warning,
    allMustSay,
  };
}

/**
 * Codes left, a new set, and the way out for a lost factor (lib/mfa-recovery.ts). Hidden until SQL 74 ran and while the
 * account has no factor, as there is nothing to lose. /banned renders it too: a banned account with a lost factor cannot
 * reach its money otherwise.
 */
export default function RecoveryCodes({ onRemoved }: { onRemoved?: () => void }) {
  const { toast } = useToast();
  const { guarded } = useStepUp();
  const queryClient = useQueryClient();
  const factors = useStepUpFactors().data?.factors ?? [];
  const { data, refetch } = useQuery({
    // A factor added or removed elsewhere changes what shows here, and so does a guardian's yes with the same factors, so the
    // area reads again whenever the tab comes back, as the factors do.
    queryKey: [RECOVERY_STATUS_KEY, factors.join()],
    refetchOnWindowFocus: "always",
    queryFn: async (): Promise<Status> => {
      const res = await fetch("/api/auth/mfa/recovery", { headers: sessionAuthHeaders() });
      if (!res.ok) throw new Error(`Could not read your recovery codes (${res.status})`);
      return res.json();
    },
  });
  const [shown, setShown] = useState<string[] | null>(null);
  const [lost, setLost] = useState<Factor | "">("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  const post = (path: string, body: unknown = {}) => fetch(`/api/auth/mfa/recovery/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...sessionAuthHeaders() },
    body: JSON.stringify(body),
  });
  // An ask began or ended, or a factor went: this area and the red banner read again.
  const reread = () => { void refetch(); refreshRecoveryStatus(); };

  const say = async (res: Response, fallback: string) => {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    toast({ title: body.error || fallback, variant: "destructive" });
  };

  const newSet = async () => {
    setBusy(true);
    try {
      const res = await guarded("recovery-codes", (h) => fetch("/api/auth/mfa/recovery/codes", { method: "POST", headers: { ...sessionAuthHeaders(), ...h } }));
      if (!res.ok) return say(res, "Could not make new codes");
      setShown(((await res.json()) as { recoveryCodes: string[] }).recoveryCodes);
      void refetch();
    } finally { setBusy(false); }
  };

  const removed = () => {
    setLost("");
    setCode("");
    void queryClient.invalidateQueries({ queryKey: STEPUP_FACTORS_KEY });
    reread();
    onRemoved?.();
  };

  const redeem = async () => {
    setBusy(true);
    try {
      const res = await post("redeem", { code, factor: lost });
      if (!res.ok) return say(res, "Could not remove it");
      const { recoveryCodes } = (await res.json()) as { recoveryCodes: string[] };
      toast({ title: "Removed" });
      if (recoveryCodes.length) setShown(recoveryCodes);
      removed();
    } finally { setBusy(false); }
  };

  // The mail path: one code went to each address, named here masked in the order the codes go back.
  const [mailTo, setMailTo] = useState<string[] | null>(null);
  const [mailCodes, setMailCodes] = useState<string[]>([]);
  const sendCodes = async () => {
    setBusy(true);
    try {
      const res = await post("mail", { factor: lost });
      if (!res.ok) return say(res, "The codes could not be sent");
      const { to } = (await res.json()) as { to: string[] };
      setMailTo(to);
      setMailCodes(to.map(() => ""));
      toast({ title: "Codes sent", description: "One to each of your email addresses. They are valid for 10 minutes." });
    } finally { setBusy(false); }
  };
  const removeWithCodes = async () => {
    setBusy(true);
    try {
      const res = await post("mail/confirm", { codes: mailCodes });
      if (!res.ok) return say(res, "Wrong code");
      setMailTo(null);
      toast({ title: "Removed", description: "We emailed every address you have." });
      removed();
    } finally { setBusy(false); }
  };

  // The guardians: an ask goes out, the moment enough say yes the factor is gone; the owner can take it back.
  const askGuardians = async () => {
    setBusy(true);
    try {
      const res = await post("guardians", { factor: lost });
      if (!res.ok) return say(res, "Your guardians could not be asked");
      const { emailed, wallets, notReached = [] } = (await res.json()) as { emailed: number; wallets: unknown[]; notReached?: string[] };
      // Enough were reached to say yes; a guardian whose mail did not go out has no link, so a new ask is the way to retry them.
      const missed = notReached.length ? ` Not reached: ${notReached.join(", ")}. Withdraw and ask again to try them again.` : "";
      toast({ title: "Your guardians were asked", description: `${emailed} by email.${missed}${wallets.length ? " Send each wallet guardian their link below." : ""}` });
      reread();
    } finally { setBusy(false); }
  };
  const withdrawAsk = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/auth/mfa/recovery/guardians", { method: "DELETE", headers: sessionAuthHeaders() });
      if (!res.ok) { reread(); return say(res, "Could not withdraw it"); }
      toast({ title: "Withdrawn", description: "Your guardians' yes no longer counts." });
      reread();
    } finally { setBusy(false); }
  };
  const copyLink = async (link: string) => {
    try {
      await navigator.clipboard.writeText(link);
      toast({ title: "Link copied", description: "Send it to that guardian yourself." });
    } catch { toast({ title: "Copy failed", variant: "destructive" }); }
  };

  const dialog = shown && <RecoveryCodesDialog codes={shown} onClose={() => setShown(null)} />;
  // The dialog outlives the area: the code that removed the last factor hides the area while its replacement has yet to be read.
  if (!data?.available || !factors.length) return dialog || null;
  const guardianAsk = data.guardians?.ask ?? null;
  const ways = waysBack(data);
  return (
    <>
      <div className="set-list-item">
        <div className="set-item-icon"><ShieldCheck size={14} /></div>
        <div className="set-item-content">
          <div className="set-item-title">
            Ways back in
            <span className={ways.count >= 2 ? "set-badge-good" : "set-badge-warn"}>{ways.count ? `${ways.count} of 3` : "None"}</span>
          </div>
          <div className="set-item-sub">{ways.line}</div>
          {ways.warning && <div className="set-item-sub" role="note" style={{ marginTop: 6 }}>{ways.warning}</div>}
          {ways.allMustSay && <div className="set-item-sub" style={{ marginTop: 6 }}>{ways.allMustSay}</div>}
        </div>
      </div>
      <div className="set-list-item">
        <div className="set-item-icon"><KeyRound size={14} /></div>
        <div className="set-item-content">
          <div className="set-item-title">
            Recovery codes
            {data.codesLeft ? <span className="set-badge-good">{data.codesLeft} left</span> : <span className="set-badge-warn">None</span>}
          </div>
          <div className="set-item-sub">If you lose a factor, one code removes it. New codes take every factor, and the old ones stop working.</div>
        </div>
        <button className="set-btn set-btn-outline" onClick={newSet} disabled={busy}>New codes</button>
      </div>
      <div className="set-list-item">
        <div className="set-item-icon"><LifeBuoy size={14} /></div>
        <div className="set-item-content">
          <div className="set-item-title">Lost a factor</div>
            <>
              <div className="set-item-sub">Pick the factor you lost and enter one recovery code to remove it. We email you when it is gone.</div>
              <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
                <select className="set-btn set-btn-secondary" style={{ outline: "none" }} value={lost} onChange={(e) => { setLost(e.target.value as Factor | ""); setMailTo(null); }} aria-label="The factor you lost">
                  <option value="">Pick a factor</option>
                  {factors.map((f) => <option key={f} value={f}>{FACTOR_LABEL[f]}</option>)}
                </select>
                <input style={{ ...field, flex: 1, minWidth: 180 }} placeholder="XXXX-XXXX-XXXX-XXXX" autoComplete="off" spellCheck={false} aria-label="Recovery code" value={code} onChange={(e) => setCode(e.target.value)} />
                <button className="set-btn set-btn-dark" onClick={redeem} disabled={busy || !lost || !code.trim()}>
                  {busy ? <Loader2 size={14} className="set-spin" /> : "Remove it"}
                </button>
              </div>
              {/* Fewer than two addresses: the server does not offer the mail path and says why and what opens it (lib/mfa-recovery.ts mailRefusal). */}
              {data.mailRefused ? (
                <div className="set-item-sub" style={{ marginTop: 8 }}>{data.mailRefused}</div>
              ) : (
                <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  <button className="set-btn set-btn-outline" onClick={sendCodes} disabled={busy || !lost}>No code left</button>
                  <span className="set-item-sub" style={{ flex: 1, minWidth: 180 }}>We email a code to each of your email addresses. Entered together, they remove it at once, and every address hears about it.</span>
                </div>
              )}
              {mailTo && (
                <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {/* The address stays in view above its box once a code is typed: swapped codes are refused, and each try counts. */}
                  {mailTo.map((to, i) => (
                    <label key={`${i}:${to}`} style={{ flex: 1, minWidth: 120, display: "grid", gap: 4 }}>
                      <span className="set-item-sub">{`Code sent to ${to}`}</span>
                      <input style={{ ...field, width: "100%" }} inputMode="numeric" autoComplete="off" maxLength={6} placeholder="6 digits" aria-label={`Code sent to ${to}`} value={mailCodes[i] ?? ""}
                        onChange={(e) => { const next = [...mailCodes]; next[i] = e.target.value.replace(/\D/g, ""); setMailCodes(next); }} />
                    </label>
                  ))}
                  <button className="set-btn set-btn-dark" onClick={removeWithCodes} disabled={busy || mailCodes.some((c) => c.length !== 6)}>Remove it with these codes</button>
                </div>
              )}
              {guardianAsk ? (
                <>
                  <div className="set-item-sub" style={{ marginTop: 8 }}>
                    {`${FACTOR_LABEL[guardianAsk.factor]}: your guardians were asked. ${guardianAsk.approved} of ${guardianAsk.needed} said yes. It ends on ${new Date(guardianAsk.expiresAt).toLocaleDateString()}.`}
                  </div>
                  <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {guardianAsk.wallets.map((w) => (
                      <button key={w.link} className="set-btn set-btn-outline" onClick={() => copyLink(w.link)}>{`Copy the link for ${w.guardian}`}</button>
                    ))}
                    <button className="set-btn set-btn-outline" onClick={withdrawAsk} disabled={busy}>Withdraw</button>
                  </div>
                </>
              ) : (data.guardians?.askable ?? 0) >= 2 ? (
                <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  <button className="set-btn set-btn-outline" onClick={askGuardians} disabled={busy || !lost}>Ask my guardians</button>
                  <span className="set-item-sub" style={{ flex: 1, minWidth: 180 }}>{`They get a message. The moment ${data.guardians!.needed} say yes, it is removed, and every address hears about it.`}</span>
                </div>
              ) : (
                <div className="set-item-sub" style={{ marginTop: 8 }}>Asking your guardians needs two confirmed guardians or more, by email or wallet. Add them under Guardians.</div>
              )}
            </>
        </div>
      </div>
      {dialog}
    </>
  );
}
