"use client";

import { CONFIRM_EMAIL_CLOSED_KEY, forgetCdpAddresses } from "@/lib/cdp-bridge";
import { useCallback, useEffect, useState } from "react";

/**
 * Email + password auth (register / login / forgot).
 *
 * Stores the session token in localStorage; every session-protected fetch
 * picks it up via lib/session-headers. The wallet is provisioned separately by
 * Dynamic from this session — this hook only owns login state.
 */
const TOKEN_KEY = "enki_session_token";
const EMAIL_KEY = "enki_session_email";
const EVENT = "enki-email-auth-changed";

async function post(path: string, body: unknown) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || "Something went wrong");
  return data as { token?: string; expiresAt?: string; email?: string; banned?: boolean };
}

/** Persist a fresh session the way every login path does (password, Google, X). */
export function storeSession(data: { token?: string; email?: string }) {
  if (data.token) {
    localStorage.setItem(TOKEN_KEY, data.token);
    // A new session replaces the old account's email too: an X login carries none.
    if (data.email) localStorage.setItem(EMAIL_KEY, data.email);
    else localStorage.removeItem(EMAIL_KEY);
  }
  window.dispatchEvent(new Event(EVENT));
}

/**
 * This browser forgets its session: on logout, and once the server no longer
 * knows `dead` (BetaGate's 401). A login stored in the meantime stays.
 */
export function forgetSession(dead?: string) {
  if (dead !== undefined && localStorage.getItem(TOKEN_KEY) !== dead) return;
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(EMAIL_KEY);
  forgetCdpAddresses();
  // The "Confirm your email" window's close: the next login shows it again (DEC-2026-11-07-23).
  try { sessionStorage.removeItem(CONFIRM_EMAIL_CLOSED_KEY); } catch { /* storage off: nothing kept */ }
  // Kill the Dynamic SDK session too: its runtime unmounts on logout (lazy
  // mount, see providers), so it can't log itself out — clearing its storage
  // keeps wallet sessions from leaking into the next account's login.
  Object.keys(localStorage)
    .filter((k) => k.startsWith("dynamic_"))
    .forEach((k) => localStorage.removeItem(k));
  window.dispatchEvent(new Event(EVENT));
}

export function useEmailAuth() {
  const [email, setEmail] = useState<string | null>(null);
  // Signed in means a session token: a Google or X login may carry no email.
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    const sync = () => {
      setToken(localStorage.getItem(TOKEN_KEY));
      setEmail(localStorage.getItem(EMAIL_KEY));
    };
    sync();
    window.addEventListener(EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const register = useCallback(async (e: string, password: string) => {
    storeSession(await post("/api/auth/password/register", { email: e, password }));
  }, []);

  const login = useCallback(async (identifier: string, password: string) => {
    const data = await post("/api/auth/password/login", { identifier, password });
    storeSession(data);
    // banned accounts keep exactly one door: status, appeal, funds
    if (data.banned) window.location.href = "/banned";
  }, []);

  const forgot = useCallback(async (e: string) => {
    await post("/api/auth/password/forgot", { email: e });
  }, []);

  const logout = useCallback(() => {
    // The session dies on the server too: a copied token must not outlive the logout.
    const token = localStorage.getItem(TOKEN_KEY);
    if (token) void fetch("/api/auth/session", { method: "DELETE", headers: { "X-Session-Token": token }, keepalive: true }).catch(() => {});
    forgetSession();
  }, []);

  // The wallet runtime's key: the email, or for a Google or X account without one the session.
  const account = token ? email ?? token : null;
  return { email, account, isAuthed: !!token, register, login, forgot, logout };
}
