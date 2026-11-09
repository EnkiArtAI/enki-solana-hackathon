"use client";

import { useCallback, useEffect, useState } from "react";
import { useStepUp } from "@/components/StepUpProvider";
import { useToast } from "@/hooks/use-toast";
import { sessionAuthHeaders } from "@/lib/session-headers";
import { refreshRecoveryStatus } from "@/hooks/useRecoveryStatus";

/**
 * Settings' guardians, out of the panel that draws them (DEC-2026-11-08-41): the list and how many must approve, adding
 * one (with the authenticator and phone setups it can open), reminders, the links to copy, re-inviting and removing.
 * Moved as it was; the panel keeps the markup. A wallet guardian confirms by signing a message on /guardian.
 */

type GuardianKind = "wallet" | "email" | "authenticator" | "phone";
export type AddType = GuardianKind;

export interface Guardian {
  id: string;
  guardianType: GuardianKind;
  value: string;
  label: string | null;
  status: "pending" | "confirmed" | "unresponsive";
  inviteToken: string | null; // a wallet guardian's, while pending or unresponsive
  reminderCount?: number;
  manualRemindersLeft?: number;
  nextManualReminderAt?: string | null;
  // The yearly check (lib/recovery/guardian-check.ts): one is open, or none came back within 14 days.
  checkOpen?: boolean;
  unreachable?: boolean;
}

// Module cache so re-opening the tab paints guardians INSTANTLY (the panel
// remounts on every open) while a fresh copy loads in the background.
let guardianCache: { guardians: Guardian[]; threshold: number } | null = null;

/** The panel starts the read (loadGuardians) in its own mount effect, as before the move: an effect here that calls it
 *  trips react-hooks/set-state-in-effect. Signed out nothing reads it, and the panel draws "Sign in first" first. */
export function useGuardians() {
  const { toast } = useToast();
  const { guarded } = useStepUp();
  const [guardians, setGuardians] = useState<Guardian[] | null>(guardianCache?.guardians ?? null);
  const [threshold, setThreshold] = useState(guardianCache?.threshold ?? 2);
  const [addType, setAddType] = useState<AddType>("wallet");
  const [addValue, setAddValue] = useState("");
  const [addBusy, setAddBusy] = useState(false);

  const loadGuardians = useCallback(async () => {
    try {
      const res = await fetch("/api/recovery/guardians", { headers: sessionAuthHeaders() });
      if (res.ok) {
        const data = (await res.json()) as { guardians: Guardian[]; threshold: number };
        guardianCache = { guardians: data.guardians, threshold: data.threshold };
        setGuardians(data.guardians);
        setThreshold(data.threshold);
      } else setGuardians([]);
    } catch { setGuardians([]); }
    refreshRecoveryStatus(); // keep the red "no recovery" banners in sync
  }, []);

  // Authenticator setup modal (QR + code entry) after adding that type.
  const [totpSetup, setTotpSetup] = useState<{ guardianId: string; secret: string; otpauthUri: string } | null>(null);

  const addGuardian = async () => {
    const needsValue = addType !== "authenticator";
    const value = addValue.trim();
    if (needsValue && !value) return;
    setAddBusy(true);
    try {
      const res = await guarded("guardians", (h) => fetch("/api/recovery/guardians", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...sessionAuthHeaders(), ...h },
        body: JSON.stringify(addType === "authenticator" ? { guardianType: "authenticator" } : { guardianType: addType, value }),
      }));
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Could not add guardian");
      setAddValue("");
      if (data.setup) {
        setTotpSetup(data.setup); // open the QR/verify modal
      } else if (data.phoneSetup) {
        setPhoneSetup({ guardianId: data.phoneSetup.guardianId, phone: data.phoneSetup.phone });
        setResendAt(new Date(data.phoneSetup.resendAvailableAt).getTime());
      } else {
        toast({
          title: "Guardian added",
          description: data.emailed
            ? "We emailed them their invite. They show as Confirmed once they accept."
            : addType === "email"
              ? "Couldn't send the email — use Copy link and send it to them yourself."
              : "Send them their confirmation link (Copy link).",
        });
      }
      loadGuardians();
    } catch (e) {
      toast({ title: "Couldn't add guardian", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally { setAddBusy(false); }
  };

  const [totpCode, setTotpCode] = useState("");
  const [totpBusy, setTotpBusy] = useState(false);
  const [totpErr, setTotpErr] = useState<string | null>(null);
  const [totpDone, setTotpDone] = useState(false);
  const verifyTotpSetup = async () => {
    if (!totpSetup) return;
    setTotpBusy(true); setTotpErr(null);
    try {
      const res = await fetch("/api/recovery/guardians", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...sessionAuthHeaders() },
        body: JSON.stringify({ verifyId: totpSetup.guardianId, code: totpCode }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "That code isn't right.");
      setTotpDone(true); // green check inside the modal — closes via Done
      loadGuardians();
    } catch (e) {
      setTotpErr(e instanceof Error ? e.message : "That code isn't right.");
    } finally { setTotpBusy(false); }
  };
  const closeTotpSetup = () => {
    // A pending authenticator stays on the list; verify later via "Verify"
    // or remove it. Just close.
    setTotpSetup(null); setTotpCode(""); setTotpErr(null); setTotpDone(false); loadGuardians();
  };

  // ── Phone (SMS) setup modal ──
  const [phoneSetup, setPhoneSetup] = useState<{ guardianId: string; phone: string } | null>(null);
  const [phoneCode, setPhoneCode] = useState("");
  const [phoneBusy, setPhoneBusy] = useState(false);
  const [phoneErr, setPhoneErr] = useState<string | null>(null);
  const [phoneDone, setPhoneDone] = useState(false);
  const [resendAt, setResendAt] = useState(0);       // ms; when resend is allowed
  const [bannedUntil, setBannedUntil] = useState(0); // ms; hard block
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    if (!phoneSetup) return;
    const t = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, [phoneSetup]);
  const closePhoneSetup = () => {
    // Reset every code/cooldown bit of client state on close, as requested.
    setPhoneSetup(null); setPhoneCode(""); setPhoneErr(null); setPhoneDone(false);
    setResendAt(0); setBannedUntil(0); loadGuardians();
  };
  const verifyPhone = async () => {
    if (!phoneSetup) return;
    setPhoneBusy(true); setPhoneErr(null);
    try {
      const res = await fetch("/api/recovery/guardians", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...sessionAuthHeaders() },
        body: JSON.stringify({ phoneVerifyId: phoneSetup.guardianId, code: phoneCode }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "That code isn't right.");
      setPhoneDone(true);
      loadGuardians();
    } catch (e) {
      setPhoneErr(e instanceof Error ? e.message : "That code isn't right.");
    } finally { setPhoneBusy(false); }
  };
  const resendPhone = async () => {
    if (!phoneSetup) return;
    setPhoneBusy(true); setPhoneErr(null);
    try {
      const res = await fetch("/api/recovery/guardians", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...sessionAuthHeaders() },
        body: JSON.stringify({ phoneResendId: phoneSetup.guardianId }),
      });
      const data = await res.json();
      if (res.ok) {
        if (data.resendAvailableAt) setResendAt(new Date(data.resendAvailableAt).getTime());
        if (data.bannedUntil) setBannedUntil(new Date(data.bannedUntil).getTime());
        toast({ title: "Code sent" });
      } else {
        if (data.bannedUntil) setBannedUntil(new Date(data.bannedUntil).getTime());
        if (data.resendAvailableAt) setResendAt(new Date(data.resendAvailableAt).getTime());
        setPhoneErr(data?.error || "Please wait before trying again.");
      }
    } catch {
      setPhoneErr("Couldn't resend — try again.");
    } finally { setPhoneBusy(false); }
  };

  // Removing is confirmed in a dialog first — and the removed email guardian
  // gets a goodbye mail from the server.
  const [removeAsk, setRemoveAsk] = useState<Guardian | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const removeGuardian = async (id: string) => {
    setRemoveBusy(true);
    try {
      const res = await guarded("guardians", (h) => fetch(`/api/recovery/guardians?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { ...sessionAuthHeaders(), ...h },
      }));
      if (res.ok) { toast({ title: "Guardian removed", description: "If they were an email guardian, we let them know." }); loadGuardians(); }
      else toast({ title: "Couldn't remove guardian", variant: "destructive" });
    } catch {
      toast({ title: "Couldn't remove guardian", description: "Check your connection and try again.", variant: "destructive" });
    } finally {
      setRemoveBusy(false);
      setRemoveAsk(null);
    }
  };

  const saveThreshold = async (n: number) => {
    setThreshold(n);
    const res = await guarded("guardians", (h) => fetch("/api/recovery/guardians", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...sessionAuthHeaders(), ...h },
      body: JSON.stringify({ threshold: n }),
    }));
    if (res.ok) toast({ title: "Saved", description: `${n} guardian${n === 1 ? "" : "s"} must approve a recovery.` });
    else toast({ title: "Couldn't save threshold", variant: "destructive" });
  };

  const [remindBusy, setRemindBusy] = useState<string | null>(null);
  /* Re-render when the earliest reminder cooldown expires, so the green
     "Reminder sent" state flips back to an active button by itself instead
     of waiting for a reload. */
  const [remindTick, setRemindTick] = useState(0);
  useEffect(() => {
    const next = (guardians ?? [])
      .map((g) => (g.nextManualReminderAt ? Date.parse(g.nextManualReminderAt) : NaN))
      .filter((t) => Number.isFinite(t) && t > Date.now());
    if (!next.length) return;
    const t = window.setTimeout(() => setRemindTick((x) => x + 1), Math.min(...next) - Date.now() + 500);
    return () => window.clearTimeout(t);
    /* remindTick in the deps re-runs this after each firing, so the NEXT
       earliest expiry gets its own timer — one-shot left every later
       guardian stuck on green past its unlock (found by review). */
  }, [guardians, remindTick]);
  const sendReminder = async (guardianId: string) => {
    setRemindBusy(guardianId);
    try {
      const res = await fetch("/api/recovery/guardians/remind", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...sessionAuthHeaders() },
        body: JSON.stringify({ guardianId }),
      });
      const d = await res.json().catch(() => ({}));
      if (res.ok) {
        toast({
          title: "Reminder sent",
          description: `${d.remindersLeft ?? "?"} of 7 reminders left for this guardian.`,
        });
      } else {
        toast({ title: "Couldn't send the reminder", description: d.error, variant: "destructive" });
      }
      // Either way the server state moved (or told us why not) — re-read it so
      // the button's disabled state stays the server's answer, not our guess.
      loadGuardians();
    } finally {
      setRemindBusy(null);
    }
  };

  const copyInvite = async (g: Guardian) => {
    if (!g.inviteToken) return;
    const url = `${window.location.origin}/guardian?token=${encodeURIComponent(g.inviteToken)}`;
    try {
      await navigator.clipboard.writeText(url);
      toast({ title: "Link copied", description: "Send it to your guardian — they confirm on that page." });
    } catch { toast({ title: "Copy failed", variant: "destructive" }); }
  };
  // A wallet guardian's yearly check: no address of ours reaches a wallet, so the owner sends the link; the wallet signs there.
  const copyCheck = async (g: Guardian) => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/guardian?check=${encodeURIComponent(g.id)}`);
      toast({ title: "Link copied", description: "Send it to your guardian: they sign with their wallet to say they can still be reached." });
    } catch { toast({ title: "Copy failed", variant: "destructive" }); }
  };

  // Only CONFIRMED guardians count — pending invites can't approve anything,
  // so the threshold is capped by (and displayed against) the confirmed set.
  const confirmedCount = guardians?.filter((g) => g.status === "confirmed").length ?? 0;
  const maxThreshold = Math.max(confirmedCount, 1);

  // The dropdown only offers reachable values (1..confirmed); the server caps
  // the stored threshold the same way (lib/recovery/threshold.ts), so saving
  // the cap here would only ask for a step-up nobody started.

  // A fresh invite reopens a way to approve a factor's removal: with a factor, every factor confirms it.
  const reInvite = async (id: string) => {
    const res = await guarded("guardians", (h) => fetch("/api/recovery/guardians", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...sessionAuthHeaders(), ...h },
      body: JSON.stringify({ reinviteId: id }),
    }));
    if (res.ok) { toast({ title: "Invite re-sent", description: "We emailed them a fresh invite." }); loadGuardians(); }
    else toast({ title: "Couldn't re-invite", variant: "destructive" });
  };

  return {
    guardians, setGuardians, loadGuardians, threshold, confirmedCount, maxThreshold, saveThreshold,
    addType, setAddType, addValue, setAddValue, addBusy, addGuardian,
    totpSetup, setTotpSetup, totpCode, setTotpCode, totpBusy, totpErr, totpDone, verifyTotpSetup, closeTotpSetup,
    phoneSetup, setPhoneSetup, phoneCode, setPhoneCode, phoneBusy, phoneErr, phoneDone, resendAt, setResendAt, bannedUntil, nowTick,
    verifyPhone, resendPhone, closePhoneSetup,
    removeAsk, setRemoveAsk, removeBusy, removeGuardian,
    remindBusy, sendReminder, copyInvite, copyCheck, reInvite,
  };
}
