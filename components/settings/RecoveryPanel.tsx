"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Key, Loader2, Mail, Users, Wallet, Smartphone, ShieldCheck, CheckCircle2 } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";

import { usePasskey, StepUpNeeded } from "@/hooks/usePasskey";
import { useStepUp } from "@/components/StepUpProvider";
import { useQueryClient } from "@tanstack/react-query";
import { STEPUP_FACTORS_KEY, useStepUpFactors } from "@/hooks/useSecondFactor";
import { BACK_TO_RECOVERY, openLogin } from "@/lib/openLogin";
import CodeFactors from "@/components/settings/CodeFactors";
import RecoveryCodes, { RECOVERY_STATUS_KEY, RecoveryCodesDialog } from "@/components/settings/RecoveryCodes";
import StepUpActionsTable from "@/components/settings/StepUpActionsTable";
import { useToast } from "@/hooks/use-toast";
import { sessionAuthHeaders } from "@/lib/session-headers";
import { refreshRecoveryStatus } from "@/hooks/useRecoveryStatus";
import SettingsSection from "@/components/settings/SettingsSection";
import { useGuardians, type AddType } from "@/components/settings/use-guardians";

interface Passkey {
  id: string;
  deviceLabel: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

/**
 * Recovery & 2FA — everything here is live:
 *  - Passkeys (2FA): registered devices from webauthn_credentials, add/remove.
 *  - Guardians: trusted wallets/emails who can approve getting you back in.
 *    A wallet guardian confirms by signing a message on /guardian.
 */
export default function RecoveryPanel({ focus = false }: { focus?: boolean } = {}) {
  const { toast } = useToast();
  const { enroll: enrollPasskey, busy: passkeyBusy } = usePasskey();
  const { guarded, everyFactorToken } = useStepUp();
  const queryClient = useQueryClient();
  const { emailCodes = false, addressFirst = null } = useStepUpFactors().data ?? {};

  // When arrived here via the red "no recovery" banner: scroll the Guardians
  // area into view and pulse it (same heartbeat as the Payment "Add money").
  const guardiansRef = useRef<HTMLDivElement | null>(null);
  const [guardiansPulse, setGuardiansPulse] = useState(false);
  useEffect(() => {
    if (!focus) return;
    const t = setTimeout(() => {
      guardiansRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      setGuardiansPulse(true);
    }, 180);
    const off = setTimeout(() => setGuardiansPulse(false), 4200);
    return () => { clearTimeout(t); clearTimeout(off); };
  }, [focus]);

  const [passkeys, setPasskeys] = useState<Passkey[] | null>(null);
  const {
    guardians, setGuardians, loadGuardians, threshold, confirmedCount, maxThreshold, saveThreshold,
    addType, setAddType, addValue, setAddValue, addBusy, addGuardian,
    totpSetup, setTotpSetup, totpCode, setTotpCode, totpBusy, totpErr, totpDone, verifyTotpSetup, closeTotpSetup,
    phoneSetup, setPhoneSetup, phoneCode, setPhoneCode, phoneBusy, phoneErr, phoneDone, resendAt, setResendAt, bannedUntil, nowTick,
    verifyPhone, resendPhone, closePhoneSetup,
    removeAsk, setRemoveAsk, removeBusy, removeGuardian,
    remindBusy, sendReminder, copyInvite, copyCheck, reInvite,
  } = useGuardians();

  const authed = Object.keys(sessionAuthHeaders()).length > 0;

  const loadPasskeys = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/passkey/credentials", { headers: sessionAuthHeaders() });
      if (res.ok) setPasskeys(((await res.json()) as { credentials: Passkey[] }).credentials);
      else setPasskeys([]);
    } catch { setPasskeys([]); }
  }, []);

  useEffect(() => {
    if (!authed) { setPasskeys([]); setGuardians([]); return; }
    loadPasskeys();
    loadGuardians();
  }, [authed, loadPasskeys, loadGuardians]);

  // The codes a first factor issued: shown once, before anything else.
  const [firstCodes, setFirstCodes] = useState<string[] | null>(null);
  // A factor added or removed can close a request or issue codes with the same factor list: the area and the red banner read again.
  const recoveryChanged = () => {
    void queryClient.invalidateQueries({ queryKey: [RECOVERY_STATUS_KEY] });
    refreshRecoveryStatus();
  };

  const handleAddPasskey = async () => {
    const label = typeof navigator !== "undefined" ? navigator.platform || "This device" : undefined;
    try {
      let codes: string[] | null;
      try {
        codes = await enrollPasskey(label);
      } catch (e) {
        // A further factor takes every factor; the first one needs a fresh login.
        if (!(e instanceof StepUpNeeded) || e.reauth) throw e;
        const token = await everyFactorToken("add-factor");
        if (!token) return;
        codes = await enrollPasskey(label, { "X-StepUp-Token": token });
      }
      if (codes?.length) setFirstCodes(codes);
      toast({ title: "Passkey added", description: "We'll ask for it before risky actions." });
      loadPasskeys();
      void queryClient.invalidateQueries({ queryKey: STEPUP_FACTORS_KEY });
      recoveryChanged();
    } catch (e) {
      // The first factor needs a login younger than ten minutes: offer it here.
      if (e instanceof StepUpNeeded && e.reauth) openLogin(BACK_TO_RECOVERY);
      const msg = e instanceof Error ? e.message : "Could not add passkey";
      if (!/cancel|abort|NotAllowed/i.test(msg)) toast({ title: "Couldn't add passkey", description: msg, variant: "destructive" });
    }
  };

  const removePasskey = async (id: string) => {
    const res = await guarded(`remove-factor:${id}`, (h) => fetch("/api/auth/passkey/credentials", {
      method: "DELETE",
      headers: { "Content-Type": "application/json", ...sessionAuthHeaders(), ...h },
      body: JSON.stringify({ id }),
    }));
    if (res.ok) { toast({ title: "Passkey removed" }); loadPasskeys(); void queryClient.invalidateQueries({ queryKey: STEPUP_FACTORS_KEY }); recoveryChanged(); }
    else toast({ title: "Couldn't remove passkey", variant: "destructive" });
  };

  if (!authed) {
    return (
      <SettingsSection num="01" title="Sign in first">
        <div className="set-section-desc" style={{ paddingBottom: 20 }}>
          Recovery settings belong to your account — log in to see and change them.
        </div>
      </SettingsSection>
    );
  }

  return (
    <>
      {/* ── 01 · Passkeys (2FA) ── */}
      <SettingsSection num="01" title="Two-step check (2FA)">
        <div className="set-section-desc" style={{ paddingBottom: 16 }}>
          A passkey is the fingerprint, face or PIN lock of one of your devices, used for this site.
          An authenticator app works too{emailCodes ? ", and so does a code by email" : ""}. Add any of
          them and we&apos;ll ask for one before anything serious happens: using your wallet, deleting
          your work, changing these factors or your guardians.
        </div>
        {/* No email anywhere: a first passkey or authenticator app waits for Code by email, and an X account hears why an
            email matters (lib/webauthn.ts ADDRESS_FIRST, ADDRESS_FIRST_X). The card of the Settings mock, in the theme's classes. */}
        {addressFirst && (
          <div className="set-list-item set-soft" role="note" style={{ marginBottom: 12 }}>
            <div className="set-item-content">
              <div className="set-item-title">Add an email <span className="set-badge-warn">important</span></div>
              <div className="set-item-sub">{addressFirst}</div>
            </div>
          </div>
        )}
        <div className="set-list-item set-soft">
          <div className="set-item-icon"><Key size={14} /></div>
          <div className="set-item-content">
            <div className="set-item-title">
              Your passkeys
              {passkeys && passkeys.length > 0
                ? <span className="set-badge-good">✓ {passkeys.length} active</span>
                : <span className="set-badge-warn">None yet</span>}
            </div>
            <div className="set-item-sub">Each one is a device that can confirm it&apos;s really you.</div>
          </div>
          <button className="set-btn set-btn-dark" onClick={handleAddPasskey} disabled={passkeyBusy}>
            {passkeyBusy ? "Waiting…" : "+ Add a passkey"}
          </button>
        </div>
        {passkeys === null ? (
          <div className="set-list-item"><Loader2 size={14} className="set-spin" /></div>
        ) : (
          passkeys.map((p) => (
            <div key={p.id} className="set-list-item">
              <div className="set-item-icon"><Key size={14} /></div>
              <div className="set-item-content">
                <div className="set-item-title">{p.deviceLabel || "Passkey"}</div>
                <div className="set-item-sub">
                  Added {new Date(p.createdAt).toLocaleDateString()}
                  {p.lastUsedAt ? ` · last used ${new Date(p.lastUsedAt).toLocaleDateString()}` : ""}
                </div>
              </div>
              <button className="set-btn set-btn-outline" onClick={() => removePasskey(p.id)}>Remove</button>
            </div>
          ))
        )}
        <CodeFactors onChange={recoveryChanged} onCodes={setFirstCodes} />
        <RecoveryCodes onRemoved={loadPasskeys} />
        <StepUpActionsTable />
      </SettingsSection>

      {/* ── 02 · Guardians ── */}
      <div ref={guardiansRef} className={guardiansPulse ? "set-heartbeat--red" : undefined}>
      <SettingsSection num="02" title="Guardians">
        <div className="set-section-desc" style={{ paddingBottom: 16 }}>
          Guardians are accounts that can help you back in if you ever get locked out — a wallet or email
          you trust. They can even be your own (a second email or wallet). Enough of them approving is what
          unlocks your account. Wallet guardians confirm by signing; email guardians confirm via their link.
        </div>

        <div className="set-list-item set-soft" style={{ gap: 8 }}>
          <select
            className="set-btn set-btn-secondary"
            style={{ outline: "none" }}
            value={addType}
            onChange={(e) => setAddType(e.target.value as AddType)}
          >
            <option value="wallet">Wallet</option>
            <option value="email">Email</option>
            <option value="authenticator">Authenticator</option>
            {/* Phone (SMS) hidden — needs a paid SMS provider; Authenticator
                gives the same own-device factor for free. Server code stays,
                re-enable by restoring this option. */}
          </select>
          {addType !== "authenticator" && (
            <input
              className="set-amount-wrap"
              style={{ flex: 1, height: 34, fontSize: 13, padding: "0 10px", border: "1px solid var(--enki-rule)", borderRadius: 6, background: "transparent", color: "var(--enki-ink)", outline: "none" }}
              placeholder={addType === "wallet" ? "Guardian's Solana address" : "guardian@email.com"}
              value={addValue}
              onChange={(e) => setAddValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") addGuardian(); }}
            />
          )}
          {addType === "authenticator" && (
            <div className="set-item-sub" style={{ flex: 1 }}>Set up a code from your authenticator app.</div>
          )}
          <button className="set-btn set-btn-dark" onClick={addGuardian} disabled={addBusy || (addType !== "authenticator" && !addValue.trim())}>
            {addBusy ? <Loader2 size={14} className="set-spin" /> : addType === "authenticator" ? "Set up" : "+ Add"}
          </button>
        </div>

        {guardians === null ? (
          <div className="set-list-item"><Loader2 size={14} className="set-spin" /></div>
        ) : guardians.length === 0 ? (
          <div className="set-list-item">
            <div className="set-item-sub">No guardians yet. Two or three trusted people is a good start.</div>
          </div>
        ) : (
          guardians.map((g) => {
            const icon = g.guardianType === "wallet" ? <Wallet size={14} />
              : g.guardianType === "authenticator" ? <ShieldCheck size={14} />
              : g.guardianType === "phone" ? <Smartphone size={14} />
              : <Mail size={14} />;
            const sub = g.status === "unresponsive"
              ? "Didn't answer after 3 reminders — re-invite to try again."
              : g.status === "confirmed" && g.unreachable
                ? g.guardianType === "wallet"
                  ? "Did not answer the yearly check within 14 days. We cannot write to a wallet: send them the check link (Copy check link), or add another guardian, then remove this one."
                  : "Did not answer the yearly check within 14 days. Add another guardian, then remove this one."
              : g.status === "confirmed" && g.checkOpen
                ? g.guardianType === "wallet" ? "Yearly check: copy their link and send it, they sign with this wallet." : "Yearly check sent: one click in their email confirms they can still be reached."
              : g.guardianType === "wallet" ? "Confirms by signing with this wallet"
              : g.guardianType === "authenticator" ? "Confirms with a code from your authenticator app"
              : g.guardianType === "phone" ? "Text-message verification is coming soon"
              : "Confirms via the link in their email";
            return (
            <div key={g.id} className="set-list-item">
              <div className="set-item-icon">{icon}</div>
              <div className="set-item-content">
                <div className="set-item-title" style={{ fontFamily: g.guardianType === "wallet" ? "monospace" : undefined, fontSize: g.guardianType === "wallet" ? 12 : 14 }}>
                  {g.guardianType === "wallet" ? `${g.value.slice(0, 6)}…${g.value.slice(-6)}` : g.value}
                  {g.status === "confirmed"
                    ? g.unreachable ? <span className="set-badge-warn">Not reachable</span> : <span className="set-badge-good">✓ Confirmed</span>
                    : g.status === "unresponsive"
                      ? <span className="set-badge-muted">No response</span>
                      : <span className="set-badge-warn">Pending</span>}
                </div>
                <div className="set-item-sub">{sub}</div>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                {g.status === "pending" && g.guardianType === "authenticator" && (
                  <button className="set-btn set-btn-dark" onClick={() => setTotpSetup({ guardianId: g.id, secret: "", otpauthUri: "" })}>Verify</button>
                )}
                {g.status === "pending" && g.guardianType === "phone" && (
                  <button className="set-btn set-btn-dark" onClick={() => { setPhoneSetup({ guardianId: g.id, phone: g.value }); setResendAt(0); }}>Verify</button>
                )}
                {g.status === "unresponsive" && (
                  <button className="set-btn set-btn-dark" onClick={() => reInvite(g.id)}>Re-invite</button>
                )}
                {g.status === "pending" && g.guardianType === "email" && (() => {
                  /* Disabled states mirror what the remind route would answer,
                     so the button never clicks into a 429. The limits protect
                     the guardian — a stranger who never asked for the role —
                     which is why they live on the server and this only reads
                     them. */
                  const left = g.manualRemindersLeft ?? 0;
                  const readyAt = g.nextManualReminderAt ? Date.parse(g.nextManualReminderAt) : 0;
                  const cooling = Number.isFinite(readyAt) && readyAt > Date.now();
                  const disabled = remindBusy === g.id || left <= 0 || cooling;
                  const title = left <= 0
                    ? "All 7 reminders for this guardian have been used"
                    : cooling
                      ? `A reminder went out in the last 24 hours — next one ${new Date(readyAt).toLocaleString()}`
                      : `${left} of 7 reminders left`;
                  /* While the 24h cooldown runs the button itself says so in
                     green — "Reminder sent" with a check — and the tiny line
                     under it names the moment the next one unlocks (Kev,
                     2026-08-22). */
                  const sent = cooling && left > 0;
                  return (
                    <span style={{ display: "inline-flex", flexDirection: "column", gap: 2 }}>
                      <button className={"set-btn set-btn-outline" + (sent ? " set-btn-sent" : "")} disabled={disabled} title={title} onClick={() => sendReminder(g.id)}>
                        {remindBusy === g.id ? "Sending…" : sent ? <><CheckCircle2 size={12} aria-hidden /> Reminder sent</> : "Send reminder"}
                      </button>
                      {sent && <span className="set-remind-next">Next reminder available {new Date(readyAt).toLocaleString()}</span>}
                    </span>
                  );
                })()}
                {g.status === "pending" && g.guardianType === "wallet" && (
                  <button className="set-btn set-btn-outline" onClick={() => copyInvite(g)}>Copy link</button>
                )}
                {g.status === "confirmed" && g.checkOpen && g.guardianType === "wallet" && (
                  <button className="set-btn set-btn-outline" onClick={() => copyCheck(g)}>Copy check link</button>
                )}
                <button className="set-btn set-btn-outline" onClick={() => setRemoveAsk(g)}>Remove</button>
              </div>
            </div>
            );
          })
        )}
        <div className="set-section-desc" style={{ fontSize: 12, paddingTop: 4 }}>
          We remind pending email guardians every 14 days, up to 3 times, then mark them “No response”.
          Once a year we check that each confirmed guardian can still be reached; one who does not answer within 14 days shows
          as “Not reachable”, and we email you to replace them.
        </div>

        <div className="set-list-item">
          <div className="set-item-icon"><Users size={14} /></div>
          <div className="set-item-content">
            <div className="set-item-title">How many must approve</div>
            <div className="set-item-sub">
              {confirmedCount === 0
                ? "Takes effect once your guardians have confirmed."
                : `${confirmedCount} of your guardians ${confirmedCount === 1 ? "has" : "have"} confirmed so far.`}
            </div>
          </div>
          <select
            className="set-btn set-btn-secondary"
            style={{ outline: "none" }}
            // Only reachable options (1..confirmed) — the effect above already
            // clamped+persisted any stored value above the confirmed count.
            value={confirmedCount === 0 ? 1 : Math.min(threshold, maxThreshold)}
            onChange={(e) => saveThreshold(Number(e.target.value))}
            disabled={confirmedCount === 0}
          >
            {confirmedCount === 0 ? (
              <option value={1}>Waiting for confirmations</option>
            ) : (
              Array.from({ length: maxThreshold }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>{n} of {confirmedCount}</option>
              ))
            )}
          </select>
        </div>

      </SettingsSection>
      </div>

      {firstCodes && <RecoveryCodesDialog codes={firstCodes} onClose={() => setFirstCodes(null)} />}

      {/* ── Remove guardian: are you sure? ── */}
      {removeAsk && (
        <div className="set-pay-overlay" onClick={() => !removeBusy && setRemoveAsk(null)}>
          <div className="set-pay-card set-pay-card--fiat" onClick={(e) => e.stopPropagation()}>
            <div className="set-item-title" style={{ marginBottom: 6 }}>Remove this guardian?</div>
            <p className="set-item-sub" style={{ marginBottom: 16, wordBreak: "break-all" }}>
              {removeAsk.guardianType === "wallet"
                ? `${removeAsk.value.slice(0, 6)}…${removeAsk.value.slice(-6)}`
                : removeAsk.value}{" "}
              won&apos;t be able to help you recover this account anymore.
              {removeAsk.guardianType === "email" ? " We'll send them a short note." : ""}
            </p>
            <button
              className="set-btn set-btn-dark"
              style={{ width: "100%", justifyContent: "center" }}
              onClick={() => removeGuardian(removeAsk.id)}
              disabled={removeBusy}
            >
              {removeBusy ? <Loader2 size={14} className="set-spin" /> : "Yes, remove"}
            </button>
            <button
              className="set-btn set-btn-outline"
              style={{ width: "100%", justifyContent: "center", marginTop: 8 }}
              onClick={() => setRemoveAsk(null)}
              disabled={removeBusy}
            >
              Keep them
            </button>
          </div>
        </div>
      )}

      {/* ── Authenticator setup / verify ── */}
      {totpSetup && (
        <div className="set-pay-overlay" onClick={() => !totpBusy && closeTotpSetup()}>
          <div className="set-pay-card set-pay-card--fiat" onClick={(e) => e.stopPropagation()}>
            {totpDone ? (
              /* Success — same green check as the login screen. */
              <div style={{ textAlign: "center", padding: "8px 0" }}>
                <CheckCircle2 size={48} style={{ color: "#1f8a5b", margin: "0 auto 12px" }} />
                <div className="set-item-title" style={{ marginBottom: 6 }}>Authenticator connected</div>
                <p className="set-item-sub" style={{ marginBottom: 18 }}>
                  It&apos;s linked and confirmed. You can use it to help recover your account.
                </p>
                <button className="set-btn set-btn-dark" style={{ width: "100%", justifyContent: "center" }} onClick={closeTotpSetup}>
                  Done
                </button>
              </div>
            ) : (
              <>
                <div className="set-item-title" style={{ marginBottom: 6 }}>
                  {totpSetup.otpauthUri ? "Set up your authenticator" : "Enter your authenticator code"}
                </div>
                {totpSetup.otpauthUri && (
                  <>
                    <p className="set-item-sub" style={{ marginBottom: 12 }}>
                      Scan the QR with your authenticator app (Google Authenticator, Authy, 1Password…), or paste the key. Then type the 6-digit code it shows.
                    </p>
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, marginBottom: 14 }}>
                      <div style={{ background: "#fff", padding: 10, borderRadius: 12 }}>
                        <QRCodeSVG value={totpSetup.otpauthUri} size={172} level="M" />
                      </div>
                      <div style={{ width: "100%" }}>
                        <div className="mono" style={{ fontSize: 10.5, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--enki-ink-3)", marginBottom: 5, textAlign: "center" }}>Or paste this key</div>
                        <code style={{ display: "block", padding: "10px 12px", borderRadius: 8, fontSize: 13, letterSpacing: 1.5, wordBreak: "break-all", textAlign: "center", userSelect: "all", border: "1px solid var(--enki-rule)", background: "var(--enki-paper-2)", color: "var(--enki-ink)" }}>
                          {totpSetup.secret}
                        </code>
                      </div>
                    </div>
                  </>
                )}
                {!totpSetup.otpauthUri && (
                  <p className="set-item-sub" style={{ marginBottom: 12 }}>Open your authenticator app and type the current 6-digit code for Enki Art.</p>
                )}
                <input
                  value={totpCode}
                  onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  onKeyDown={(e) => { if (e.key === "Enter" && totpCode.length === 6) verifyTotpSetup(); }}
                  placeholder="123456"
                  inputMode="numeric"
                  autoFocus
                  style={{ width: "100%", height: 44, padding: "0 12px", borderRadius: 8, fontSize: 22, letterSpacing: 8, textAlign: "center", border: "1px solid var(--enki-rule)", background: "transparent", color: "var(--enki-ink)", outline: "none" }}
                />
                {totpErr && <p style={{ fontSize: 12.5, color: "#e0584f", marginTop: 8 }}>{totpErr}</p>}
                <button className="set-btn set-btn-dark" style={{ width: "100%", justifyContent: "center", marginTop: 12 }} onClick={verifyTotpSetup} disabled={totpBusy || totpCode.length !== 6}>
                  {totpBusy ? <Loader2 size={14} className="set-spin" /> : "Confirm"}
                </button>
                <button className="set-btn set-btn-outline" style={{ width: "100%", justifyContent: "center", marginTop: 8 }} onClick={closeTotpSetup} disabled={totpBusy}>
                  Later
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Phone (SMS) verification ── */}
      {phoneSetup && (() => {
        const resendSecs = Math.max(0, Math.ceil((resendAt - nowTick) / 1000));
        const banSecs = Math.max(0, Math.ceil((bannedUntil - nowTick) / 1000));
        const banText = banSecs > 3600 ? `${Math.ceil(banSecs / 3600)}h` : banSecs > 60 ? `${Math.ceil(banSecs / 60)}m` : `${banSecs}s`;
        const canResend = !phoneBusy && banSecs === 0 && resendSecs === 0;
        return (
        <div className="set-pay-overlay" onClick={() => !phoneBusy && closePhoneSetup()}>
          <div className="set-pay-card set-pay-card--fiat" onClick={(e) => e.stopPropagation()}>
            {phoneDone ? (
              <div style={{ textAlign: "center", padding: "8px 0" }}>
                <CheckCircle2 size={48} style={{ color: "#1f8a5b", margin: "0 auto 12px" }} />
                <div className="set-item-title" style={{ marginBottom: 6 }}>Number confirmed</div>
                <p className="set-item-sub" style={{ marginBottom: 18 }}>Your phone can now help recover your account.</p>
                <button className="set-btn set-btn-dark" style={{ width: "100%", justifyContent: "center" }} onClick={closePhoneSetup}>Done</button>
              </div>
            ) : (
              <>
                <div className="set-item-title" style={{ marginBottom: 6 }}>Enter the code we texted you</div>
                <p className="set-item-sub" style={{ marginBottom: 12 }}>
                  We sent a 6-digit code to <strong>{phoneSetup.phone}</strong>. Type it below.
                </p>
                <input
                  value={phoneCode}
                  onChange={(e) => setPhoneCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  onKeyDown={(e) => { if (e.key === "Enter" && phoneCode.length === 6) verifyPhone(); }}
                  placeholder="123456"
                  inputMode="numeric"
                  autoFocus
                  style={{ width: "100%", height: 44, padding: "0 12px", borderRadius: 8, fontSize: 22, letterSpacing: 8, textAlign: "center", border: "1px solid var(--enki-rule)", background: "transparent", color: "var(--enki-ink)", outline: "none" }}
                />
                {phoneErr && <p style={{ fontSize: 12.5, color: "#e0584f", marginTop: 8 }}>{phoneErr}</p>}
                <button className="set-btn set-btn-dark" style={{ width: "100%", justifyContent: "center", marginTop: 12 }} onClick={verifyPhone} disabled={phoneBusy || phoneCode.length !== 6}>
                  {phoneBusy ? <Loader2 size={14} className="set-spin" /> : "Confirm"}
                </button>
                <button
                  className="set-btn set-btn-outline"
                  style={{ width: "100%", justifyContent: "center", marginTop: 8 }}
                  onClick={resendPhone}
                  disabled={!canResend}
                >
                  {banSecs > 0 ? `Too many tries — wait ${banText}` : resendSecs > 0 ? `Resend SMS code (${resendSecs}s)` : "Resend SMS code"}
                </button>
                <button className="set-btn" style={{ width: "100%", justifyContent: "center", marginTop: 8, background: "transparent", color: "var(--enki-ink-3)", border: "none" }} onClick={closePhoneSetup} disabled={phoneBusy}>
                  Later
                </button>
              </>
            )}
          </div>
        </div>
        );
      })()}
    </>
  );
}
