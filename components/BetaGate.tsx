"use client";

/**
 * Root-level closed-beta wall. Mounted once in providers around ALL pages, so
 * every route — current and future — is restricted by default; only the few
 * PUBLIC_PATHS render for visitors. Access requires a server-verified session
 * whose role is beta/mod/admin (fails closed on any error).
 *
 * The session lives in localStorage (not cookies), so server middleware can't
 * see it on page loads — this client wall plus per-request auth on the APIs is
 * the enforcement pair.
 */
import { CDP_ADDRESS_EVENT } from "@/lib/cdp-bridge";
import { forgetSession } from "@/hooks/useEmailAuth";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { SHOW_ADULT_KEY, isSessionStorageKey, pillSurvives, sessionAuthHeaders, setPillActive } from "@/lib/session-headers";
import { useQueryClient } from "@tanstack/react-query";
import PrivateBetaWindow from "@/components/PrivateBetaWindow";

export const PUBLIC_PATHS = new Set(["/", "/landing", "/gate", "/guardian", "/reset-password", "/banned", "/auth/complete"]);
const BETA_ROLES = new Set(["beta", "mod", "admin"]);

/**
 * SOC-8 (Kev, 2026-09-24): once the private-beta whitelist stage has ended
 * (TEAM_ACCESS_CODE unset — GET /api/gate's whitelistActive goes false),
 * every signed-in, non-banned account is admitted regardless of role; a
 * role check is pointless once registration itself is open to everyone.
 * During the stage the role/allowlist rules stay exactly as they were.
 * `activeAccount` must only ever be true for a session /api/users/handle
 * already confirmed is signed in and not banned — never for a plain
 * visitor or a failed/absent session, which must still need the team
 * cookie. Pure and exported so it has a real unit test, not just a
 * source-regex one (this repo's tests don't render client components).
 */
export function admitsOnceWhitelistEnded(activeAccount: boolean, whitelistActive: boolean): boolean {
  return activeAccount && !whitelistActive;
}

/** Profile bits the gate check already fetches — pages (profile) reuse them
    for an instant first paint instead of waiting on their own fetch. */
export type GateProfile = {
  handle: string | null;
  bio: string | null;
  avatarUrl: string | null;
  coverUrl: string | null;
};

/** A trial tester's running trial (lib/trial): its end and its budget, in micro-USDC. */
export type TrialState = { endsAt: string; budgetMicro: number; spentMicro: number };

interface BetaAccess {
  /** "out": nobody is signed in; the gate sends a walled page to the landing. */
  access: "checking" | "ok" | "denied" | "out";
  role: string | null;
  /** Stable account identity returned by the session check, including email-only accounts. */
  userId: string | null;
  /** users.handle — undefined while loading, null = signed in but not picked yet. */
  handle: string | null | undefined;
  /** Enki picked the handle (users.handle_auto, SQL 46) and its owner has not chosen one: the name picker asks. */
  handleAuto: boolean;
  /** A name its owner saved: a new one is theirs, no longer Enki's. */
  setHandle: (h: string | null, chosen?: boolean) => void;
  profile: GateProfile | null;
  setProfile: (p: GateProfile) => void;
  /** Confirmed 18 or older in Settings: the feed may offer its 18+ pill. */
  adultConfirmed: boolean;
  setAdultConfirmed: (v: boolean) => void;
  /** The feed's 18+ pill, this account's own. */
  adultPill: boolean;
  setAdultPill: (on: boolean) => void;
  /** The account's running trial, null for everyone else; a trial render updates what it spent. */
  trial: TrialState | null;
  setTrial: (t: TrialState | null) => void;
}

const Ctx = createContext<BetaAccess>({
  access: "checking", role: null, userId: null, handle: undefined, handleAuto: false, setHandle: () => {},
  profile: null, setProfile: () => {},
  adultConfirmed: false, setAdultConfirmed: () => {},
  adultPill: false, setAdultPill: () => {},
  trial: null, setTrial: () => {},
});
export const useBetaAccess = () => useContext(Ctx);

export default function BetaGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [access, setAccess] = useState<BetaAccess["access"]>("checking");
  const [role, setRole] = useState<string | null>(null);
  const [handle, setHandleState] = useState<string | null | undefined>(undefined);
  const [handleAuto, setHandleAuto] = useState(false);
  const [profile, setProfile] = useState<GateProfile | null>(null);
  const [adultConfirmed, setAdultConfirmedState] = useState(false);
  const [adultPill, setAdultPillState] = useState(false);
  const [meId, setMeId] = useState<string | null>(null);
  const [trial, setTrial] = useState<TrialState | null>(null);
  // Every cached read was made with the old pill; a change refetches them all.
  const queryClient = useQueryClient();
  /* The 18+ pill belongs to the account that turned it on: the stored value
     is that account's id, so another account in this browser starts with it
     off, and logging out forgets it. viewerHeaders reads the same key. */
  const setAdultPill = (on: boolean) => {
    try {
      if (on && meId) localStorage.setItem(SHOW_ADULT_KEY, meId);
      else localStorage.removeItem(SHOW_ADULT_KEY);
    } catch { /* not kept */ }
    setAdultPillState(on && Boolean(meId));
    // Set before anything renders again, so every read after the flip carries it.
    setPillActive(on && Boolean(meId) && adultConfirmed);
    void queryClient.invalidateQueries();
  };
  /** A change in Settings: the pill starts off after it, either way. */
  const setAdultConfirmed = (v: boolean) => { setAdultConfirmedState(v); setAdultPill(false); };
  const setHandle = (h: string | null, chosen = false) => {
    // As SQL 46's trigger: the same name saved again (a profile save without a rename) is no choice, the picker's
    // save is one, Enki's name kept included.
    if (chosen || h !== handle) setHandleAuto(false);
    setHandleState(h);
    setProfile((p) => (p ? { ...p, handle: h } : p));
  };
  const [tick, setTick] = useState(0);
  // The session the last check was for: only a new one (a login, a logout,
  // another account) reads its 2FA state afresh. The same one keeps it, or
  // the red bar blinks on every re-check (each wallet address event).
  // null until the first check.
  const checkedSession = useRef<string | undefined | null>(null);

  /* Re-verify when a login/logout happens in this or another tab. Only a
     session key counts as one: every editor autosave used to re-run this in
     all other tabs. And the page stays mounted while it re-checks: blanking
     it to "checking" unmounted whatever was open, an unsaved Editor 2 graph
     included (Kev, 2026-10-06). */
  useEffect(() => {
    const rerun = () => setTick((t) => t + 1);
    const onStorage = (e: StorageEvent) => { if (isSessionStorageKey(e.key)) rerun(); };
    window.addEventListener("enki-email-auth-changed", rerun);
    window.addEventListener(CDP_ADDRESS_EVENT, rerun);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("enki-email-auth-changed", rerun);
      window.removeEventListener(CDP_ADDRESS_EVENT, rerun);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  useEffect(() => {
    let dead = false;
    const headers = sessionAuthHeaders();
    if (headers["X-Session-Token"] !== checkedSession.current) {
      /* Another session's cached reads go with it: a creator's decrypted prompt body, owner-only rows, read under a
         cache key that names no account (ENC review, 2026-10-27). Mounted reads fetch again under the new session. The
         first check has nothing of anyone else's yet. */
      if (checkedSession.current !== null) void queryClient.resetQueries();
      checkedSession.current = headers["X-Session-Token"];
      queryClient.removeQueries({ queryKey: ["stepup-factors"] });
    }
    // A new check is a possibly new account: nothing 18+ until it answers.
    const forgetPill = () => { try { localStorage.removeItem(SHOW_ADULT_KEY); } catch { /* none */ } };
    setAdultConfirmedState(false);
    setAdultPillState(false);
    setPillActive(false);
    /* A session the server could not confirm (a failed request, a role
       outside the beta): a valid TEAM-CODE cookie still opens the UI for
       browsing (Kev, 2026-08-23). No session at all never gets here: the
       landing is the way in (below). Server APIs keep requiring a real
       session for anything user-bound; this wall is only the client half of
       the pair.
       activeAccount (SOC-8): true only from the role-mismatch branch below,
       where a real signed-in, non-banned account was already confirmed by
       /api/users/handle — never from the signed-out or request-failed
       branches, which call this with no argument (false). Once the
       whitelist stage has ended, that confirmed account is admitted
       regardless of role; a plain visitor still needs the team cookie. */
    const teamFallback = async (activeAccount = false) => {
      try {
        const r = await fetch("/api/gate");
        const d = await r.json().catch(() => ({}));
        if (dead) return;
        if (d?.team === true) { setRole("team"); setAccess("ok"); return; }
        // d?.whitelistActive defaults to "still active" (true) on a missing
        // or malformed field — e.g. a network hiccup — so a stale answer
        // never admits by accident; it only widens on an explicit false.
        const whitelistActive = d?.whitelistActive !== false;
        if (admitsOnceWhitelistEnded(activeAccount, whitelistActive)) { setAccess("ok"); return; }
      } catch { /* fall through to denied */ }
      if (!dead) setAccess("denied");
    };
    // Signed out: the pill goes with the session, and so does the name the menu showed. The app is not shown at all,
    // team cookie or not (Kev, 2026-10-27: "eig sollte da ja eher landing page kommen und gar nicht erst enki
    // aufzeigen"): a walled page sends to the landing, whose login is the way in.
    if (Object.keys(headers).length === 0) {
      setHandleState(undefined);
      setHandleAuto(false);
      setProfile(null);
      setMeId(null);
      setTrial(null);
      forgetPill();
      setAccess("out");
      return () => { dead = true; };
    }
    // A session that just appeared (a login on a public page, then a hop to a walled one) waits for this check: a stale
    // "out" sent it to the landing first (review 2026-10-27).
    setAccess((a) => (a === "out" ? "checking" : a));
    (async () => {
      try {
        const res = await fetch("/api/users/handle", { headers });
        if (dead) return;
        // A suspended account has exactly one door.
        if (res.status === 403 && (await res.json().catch(() => null))?.banned) {
          if (window.location.pathname !== "/banned") window.location.href = "/banned";
          return;
        }
        // A session the route no longer knows (24 h, or ended elsewhere) leaves this browser: its
        // stored email kept naming the account in the menu (Kev, 2026-10-21). Only the route's own
        // answer: the proxy's "Access code required" 401 (no team cookie, as for a banned account
        // on /banned) says nothing about the session.
        if (res.status === 401 && (await res.clone().json().catch(() => null))?.error === "Not signed in") {
          forgetSession(headers["X-Session-Token"]);
          // Signed out, whichever login stored it: a wallet's dead session is not the email one forgetSession clears,
          // and the team cookie must not open the app for it (DEC-418; review 2026-10-27).
          forgetPill();
          if (!dead) setAccess("out");
          return;
        }
        // A dead session forgets the pill; a passing error keeps it for later.
        if (!res.ok) { if (res.status === 401) forgetPill(); void teamFallback(); return; }
        const data = (await res.json()) as {
          id?: string; handle: string | null; handleAuto?: boolean; role?: string;
          bio?: string | null; avatarUrl?: string | null; coverUrl?: string | null;
          trial?: TrialState | null;
          adultConfirmed?: boolean;
        };
        // A logout or switch during the read superseded this check: its answer
        // must not set anything, the pill flag least of all.
        if (dead) return;
        setHandleState(data.handle ?? null);
        setHandleAuto(data.handleAuto === true);
        setProfile({
          handle: data.handle ?? null,
          bio: data.bio ?? null,
          avatarUrl: data.avatarUrl ?? null,
          coverUrl: data.coverUrl ?? null,
        });
        setRole(data.role ?? "user");
        const confirmed = data.adultConfirmed === true;
        let stored: string | null = null;
        try { stored = localStorage.getItem(SHOW_ADULT_KEY); } catch { /* none */ }
        // Another account's pill, or one without a confirmation, is switched off.
        if (stored && !pillSurvives(stored, data)) { forgetPill(); stored = null; }
        setMeId(data.id ?? null);
        setTrial(data.trial ?? null);
        // Set here, before the page below mounts in the same render: its first
        // reads go out before any effect of this gate would run.
        setPillActive(confirmed && Boolean(stored));
        setAdultConfirmedState(confirmed);
        setAdultPillState(Boolean(stored));
        // A confirmed, non-banned account reached this far — once the
        // whitelist stage has ended, admit it regardless of role (SOC-8).
        // A trial tester while the trial runs (lib/trial): the server says so, and the session ends with it.
        if (BETA_ROLES.has(data.role ?? "user") || (data.role === "trial" && data.trial)) setAccess("ok");
        else void teamFallback(true);
      } catch {
        if (!dead) void teamFallback();
      }
    })();
    return () => { dead = true; };
  }, [tick, queryClient]);

  // The trial ends in this tab too: the session goes at its end, and the wall comes back.
  useEffect(() => {
    const left = trial ? Date.parse(trial.endsAt) - Date.now() : NaN;
    // Past setTimeout's reach (24.8 days) the session's own end stops it.
    if (!(left < 2 ** 31 - 1)) return;
    const t = setTimeout(() => forgetSession(sessionAuthHeaders()["X-Session-Token"]), Math.max(0, left));
    return () => clearTimeout(t);
  }, [trial?.endsAt]);

  const isPublic = PUBLIC_PATHS.has(pathname ?? "/");
  // Nobody signed in on a walled page: to the landing, in place of this page in the history.
  useEffect(() => {
    if (access === "out" && !isPublic) router.replace("/");
  }, [access, isPublic, router]);

  return (
    <Ctx.Provider value={{ access, role, userId: meId, handle, handleAuto, setHandle, profile, setProfile, adultConfirmed, setAdultConfirmed, adultPill, setAdultPill, trial, setTrial }}>
      {isPublic || access === "ok" ? (
        children
      ) : access === "denied" ? (
        <PrivateBetaWindow />
      ) : (
        <div style={{ minHeight: "100vh" }} />
      )}
    </Ctx.Provider>
  );
}
