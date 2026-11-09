"use client";

import { useEffect, useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { sessionAuthHeaders } from "@/lib/session-headers";
import { useBetaAccess } from "@/components/BetaGate";
import { useStepUp } from "@/components/StepUpProvider";
import { openLogin } from "@/lib/openLogin";
import { errorSentence } from "@/lib/auth/oauth-shared";

/**
 * Settings' account logic, out of the view that draws it (DEC-2026-11-08-41), one hook per thing an area shows, so an
 * area reads only what it draws: the Hall of Fame and 18+ flags, the connected accounts with the X author claim,
 * deleting the account, and the admin role. Moved as it was; the view keeps the markup.
 */

export const DELETE_EXPIRED = "This request ran out after 7 days and nothing was deleted. Ask again if you still want to delete your account.";

/** The Hall of Fame and 18+ switches: read once, saved at once, reverted when the save fails. */
export function useAccountFlags() {
  const { toast } = useToast();
  // Leaderboard visibility — real flag (users.hide_from_leaderboard).
  const [hideLb, setHideLb] = useState<boolean | null>(null);
  // 18 or older (users.adult_confirmed_at); null until loaded.
  const [adult, setAdult] = useState<boolean | null>(null);
  const { setAdultConfirmed } = useBetaAccess();
  useEffect(() => {
    const headers = sessionAuthHeaders();
    if (Object.keys(headers).length === 0) return;
    let dead = false;
    (async () => {
      try {
        const res = await fetch("/api/users/handle", { headers });
        if (!res.ok) return;
        const d = (await res.json()) as { hideFromLeaderboard?: boolean; adultConfirmed?: boolean };
        if (!dead) { setHideLb(!!d.hideFromLeaderboard); setAdult(!!d.adultConfirmed); }
      } catch { /* leave null (toggle stays until loaded) */ }
    })();
    return () => { dead = true; };
  }, []);
  const toggleLeaderboard = async (showMe: boolean) => {
    const next = !showMe; // toggle shows "Show me", stored flag is "hide me"
    const prev = hideLb;
    setHideLb(next);
    try {
      const res = await fetch("/api/users/handle", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...sessionAuthHeaders() },
        body: JSON.stringify({ hideFromLeaderboard: next }),
      });
      if (!res.ok) throw new Error();
      toast({ title: "Saved", description: next ? "You're hidden from the Hall of Fame." : "You'll appear on the Hall of Fame." });
    } catch {
      setHideLb(prev); // revert on failure
      toast({ title: "Couldn't save", variant: "destructive" });
    }
  };
  const toggleAdult = async (next: boolean) => {
    const prev = adult;
    setAdult(next);
    try {
      const res = await fetch("/api/users/handle", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...sessionAuthHeaders() },
        body: JSON.stringify({ adultConfirmed: next }),
      });
      if (!res.ok) throw new Error();
      setAdultConfirmed(next);
      toast({ title: "Saved", description: next ? "The feed now offers an 18+ filter." : "18+ is hidden again." });
    } catch {
      setAdult(prev);
      toast({ title: "Couldn't save", variant: "destructive" });
    }
  };
  return { hideLb, adult, toggleLeaderboard, toggleAdult };
}

/* Connected accounts (Kev, 2026-10-17): a Google or X account connected
   here signs in to this one. Connecting is adding a way in, so it takes the
   second factor (or a fresh login without one); the last way in cannot be
   disconnected. Instagram is still a placeholder. */
export function useConnectedAccounts() {
  const { toast } = useToast();
  const { guarded } = useStepUp();
  type Identity = { provider: string; handle: string | null; email: string | null };
  const [identities, setIdentities] = useState<Identity[]>([]);
  const [configured, setConfigured] = useState<{ google?: boolean; x?: boolean }>({});
  useEffect(() => {
    // A Connect the provider or the server refused comes back here as #connect_error=<code>.
    const refused = new URLSearchParams(window.location.hash.replace(/^#/, "")).get("connect_error");
    if (refused) {
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
      toast({ title: errorSentence(refused), variant: "destructive" });
    }
    fetch("/api/auth/oauth/providers")
      .then((r) => (r.ok ? r.json() : {}))
      .then((d: { google?: boolean; x?: boolean }) => setConfigured(d))
      .catch(() => { /* no provider tiles */ });
    const headers = sessionAuthHeaders();
    if (!Object.keys(headers).length) return;
    fetch("/api/auth/identities", { headers })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { identities?: Identity[] } | null) => { if (d?.identities) setIdentities(d.identities); })
      .catch(() => { /* the tiles offer Connect */ });
  }, [toast]);
  const connectAccount = async (provider: "google" | "x") => {
    const res = await guarded("add-factor", (h) =>
      fetch(`/api/auth/oauth/${provider}/start?next=/settings`, { method: "POST", headers: { ...sessionAuthHeaders(), ...h } }),
    );
    const body = (await res.json().catch(() => ({}))) as { url?: string; error?: string; stepUp?: boolean; reauth?: boolean };
    if (res.ok && body.url) return void (window.location.href = body.url);
    if (res.status === 401 && body.stepUp) return; // cancelled at the second factor
    toast({ title: body.error || "Could not connect it", variant: "destructive" });
    if (body.reauth) openLogin("/home?settings=profile");
  };
  // A way in and an address leave: with a factor, every factor confirms it, as removing a factor does.
  const disconnectAccount = async (provider: string) => {
    const res = await guarded(`disconnect:${provider}`, (h) =>
      fetch(`/api/auth/identities/${provider}`, { method: "DELETE", headers: { ...sessionAuthHeaders(), ...h } }),
    );
    const body = (await res.json().catch(() => ({}))) as { error?: string; stepUp?: boolean };
    if (res.status === 401 && body.stepUp) return; // cancelled at a factor
    if (!res.ok) return toast({ title: body.error || "Could not disconnect it", variant: "destructive" });
    setIdentities((list) => list.filter((i) => i.provider !== provider));
    toast({ title: "Disconnected" });
  };
  /* What the posts of a connected X account earn (Kev, 2026-10-17): prompts
     someone referred from them pay their author a share of every render. */
  type Claim = { prompts: number; claimed: boolean; open: number; vaultUsd: number | null; payoutWallet: boolean };
  const [claim, setClaim] = useState<Claim | null>(null);
  const [claimRound, setClaimRound] = useState(0); // a claim reads the line again from the server
  const hasX = identities.some((i) => i.provider === "x");
  useEffect(() => {
    if (!hasX) return;
    fetch("/api/referrals/claim", { headers: sessionAuthHeaders() })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: Claim | null) => { if (d) setClaim(d); })
      .catch(() => { /* no line */ });
  }, [hasX, claimRound]);
  const claimShares = async () => {
    const res = await fetch("/api/referrals/claim", { method: "POST", headers: sessionAuthHeaders() });
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) return toast({ title: body.error || "Could not claim", variant: "destructive" });
    setClaimRound((n) => n + 1);
    toast({ title: "Claimed" });
  };
  return { identities, configured, connectAccount, disconnectAccount, hasX, claim, claimShares };
}

/** Deleting the account: at once without confirmed guardians, else a request they approve, polled until it ends. */
export function useAccountDelete() {
  const { toast } = useToast();
  const { guarded } = useStepUp();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deletePending, setDeletePending] = useState(false); // guardians notified
  const [deleteReq, setDeleteReq] = useState<{ id: string; key: string } | null>(null);
  const [deleteHeld, setDeleteHeld] = useState<string | null>(null); // the server's sentence while a suspension holds it
  const finishDelete = () => { try { localStorage.clear(); } catch { /* ignore */ } window.location.href = "/"; };
  const submitDelete = async () => {
    setDeleteBusy(true);
    try {
      // Step-up 2FA once the user has a factor (MFA-3).
      const res = await guarded("delete-account", (h) => fetch("/api/account/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...sessionAuthHeaders(), ...h },
        body: JSON.stringify({ confirm: deleteConfirm.trim().replace(/^@/, "") }),
      }));
      const data = await res.json();
      // Cancelled at the second factor: nothing happened, nothing to report.
      if (res.status === 401 && data?.stepUp) return setDeleteBusy(false);
      if (!res.ok) throw new Error(data?.error || "Could not delete");
      if (data.pending) {
        setDeleteHeld(null); // an earlier request's sentence
        setDeleteReq({ id: data.requestId, key: data.ownerKey }); // start polling
        setDeletePending(true);
      } else {
        finishDelete(); // deleted immediately (no guardians)
      }
    } catch (e) {
      toast({ title: "Couldn't delete", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
      setDeleteBusy(false);
    }
  };
  // While guardians approve, poll until the request finalizes → then sign out.
  useEffect(() => {
    if (!deleteReq) return;
    const t = setInterval(async () => {
      try {
        const res = await fetch(`/api/account/delete?id=${deleteReq.id}&key=${deleteReq.key}`);
        const d = await res.json();
        if (d.done) { clearInterval(t); finishDelete(); }
        else if (d.status === "expired") { clearInterval(t); setDeleteHeld(DELETE_EXPIRED); }
        else if (res.ok) setDeleteHeld(d.status === "held" ? d.message : null);
      } catch { /* keep polling */ }
    }, 5000);
    return () => clearInterval(t);
  }, [deleteReq]);
  return { deleteOpen, setDeleteOpen, deleteConfirm, setDeleteConfirm, deleteBusy, deletePending, setDeletePending, deleteHeld, submitDelete };
}

/** Admin or mod (users.role via the session): only the Admin row's visibility. Server-side admin APIs re-check on their own. */
export function useAccountRole() {
  const [role, setRole] = useState<string>("user");
  useEffect(() => {
    // Signed out the role stays "user", as it starts.
    const headers = sessionAuthHeaders();
    if (Object.keys(headers).length === 0) return;
    let dead = false;
    (async () => {
      try {
        const res = await fetch("/api/users/handle", { headers });
        if (!res.ok) return;
        const data = (await res.json()) as { role?: string };
        if (!dead && data.role) setRole(data.role);
      } catch { /* stay 'user' */ }
    })();
    return () => { dead = true; };
  }, []);
  return role === "admin" || role === "mod";
}
