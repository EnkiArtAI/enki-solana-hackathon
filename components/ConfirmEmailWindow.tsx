"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { PUBLIC_PATHS } from "@/components/BetaGate";
import { useEmailAuth } from "@/hooks/useEmailAuth";
import { sessionAuthHeaders } from "@/lib/session-headers";
// The account that closed the window in this browser session; it lives in lib so logout (a hook) can clear it.
import { CONFIRM_EMAIL_CLOSED_KEY as CLOSED_KEY, CONFIRM_EMAIL_EVENT } from "@/lib/cdp-bridge";
// The shell's modal look, shared with the "Private beta" window.
import { CARD, CODE, CORNER, CTA, FIELD, PILL, ROUND, TEXT, TITLE } from "@/components/enki-window";
const ROUTE = "/api/auth/password/confirm-email";
const NOT_SENT = "The code could not be sent. Try again in a minute.";
const FAILED = "That did not work. Try again.";

const closedFor = (account: string) => {
  try { return sessionStorage.getItem(CLOSED_KEY) === account; } catch { return false; }
};

/**
 * "Confirm your email" (Kev, 2026-11-07: "enter code oder request code"): a signed-in password account whose login email
 * waits for its code, which keeps the wallet closed (app/api/auth/wallet/jwt/route.ts). It opens on load when the status
 * read says so, and whenever a wallet action is refused for it (lib/cdp-bridge.ts CONFIRM_EMAIL_EVENT). Closed with ×,
 * Escape or the backdrop, it stays closed in this browser session until the wallet asks again. Google, X and wallet
 * sessions have no password account, so the read says no. The server: lib/confirm-email.ts.
 */
export default function ConfirmEmailWindow() {
  const pathname = usePathname() ?? "/";
  const { account } = useEmailAuth();
  const [open, setOpen] = useState(false);
  const [address, setAddress] = useState("");
  const [view, setView] = useState<"ask" | "code" | "done">("ask");
  // Whether a code was sent from here: once from the two buttons, again from the code view (only the newest one works).
  const [sent, setSent] = useState<"" | "once" | "again">("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // "Too many tries": no code confirms before the server's wait is over, so until then none is sent or tried, and its words stay.
  const [wait, setWait] = useState<string | null>(null);
  // Open now: a read that answers while someone types a code leaves the window as it is.
  const shown = useRef(false);
  // The account this page load has read the status for: once per account, not on every page.
  const readFor = useRef<string | null>(null);

  useEffect(() => {
    const check = async () => {
      try {
        const res = await fetch(ROUTE, { headers: sessionAuthHeaders() });
        const status = res.ok ? ((await res.json()) as { needed?: boolean; email?: string | null }) : null;
        if (!status?.needed || shown.current) return;
        shown.current = true;
        setAddress(status.email ?? "");
        setView("ask");
        setSent("");
        setCode("");
        setError(null);
        setOpen(true);
      } catch { /* unread: no window */ }
    };
    // A wallet action refused for the unconfirmed email opens it, whether it was closed before or not.
    const asked = () => void check();
    window.addEventListener(CONFIRM_EMAIL_EVENT, asked);
    // On load of a signed-in page: not on the landing, the other public pages or /banned, nor in a frame.
    if (account && readFor.current !== account && !PUBLIC_PATHS.has(pathname) && !pathname.startsWith("/banned") && window.top === window.self) {
      readFor.current = account;
      if (!closedFor(account)) void check();
    }
    return () => window.removeEventListener(CONFIRM_EMAIL_EVENT, asked);
  }, [account, pathname]);

  const hide = () => {
    shown.current = false;
    setOpen(false);
  };

  const close = () => {
    hide();
    try { sessionStorage.setItem(CLOSED_KEY, account ?? ""); } catch { /* not kept: it may open again on the next load */ }
  };

  const request = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(ROUTE, { method: "POST", headers: sessionAuthHeaders() });
      const data = (await res.json().catch(() => ({}))) as { sent?: boolean; confirmed?: boolean; error?: string };
      if (data.confirmed) return confirmed();
      if (!res.ok || !data.sent) return setError(data.error || NOT_SENT);
      // From the code view it replaced the code the person may be waiting for, so the line says a new one went out.
      setSent(view === "code" ? "again" : "once");
      setCode("");
      setView("code");
    } catch {
      setError(NOT_SENT);
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${ROUTE}/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...sessionAuthHeaders() },
        body: JSON.stringify({ code }),
      });
      const data = (await res.json().catch(() => ({}))) as { confirmed?: boolean; error?: string };
      if (res.ok && data.confirmed) return confirmed();
      if (res.status === 429) {
        setWait(data.error || FAILED);
        // The words say 15 minutes: without the server's Retry-After, that long.
        setTimeout(() => setWait(null), (Number(res.headers.get("Retry-After")) || 900) * 1000);
        return;
      }
      setError(data.error || FAILED);
    } catch {
      setError(FAILED);
    } finally {
      setBusy(false);
    }
  };

  // A short confirmed state, then it closes; the next wallet action opens the wallet.
  const confirmed = () => {
    setView("done");
    setTimeout(hide, 1600);
  };

  const enterCode = () => { setSent(""); setCode(""); setError(null); setView("code"); };
  const back = () => { setError(null); setView("ask"); };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !busy) close(); }}>
      {/* Above sheets (10000), alert dialogs (10010) and toasts (10020); below the step-up dialog (10030). */}
      <DialogContent className="z-[10029] w-[calc(100%-32px)] max-w-[400px] gap-0 px-6 pb-6 pt-10 text-center" overlayClassName="z-[10028] bg-black/50 backdrop-blur-[6px]" style={CARD} closeStyle={ROUND}>
        {view === "code" && (
          <button type="button" className={`${CORNER} left-4 kit-round`} style={ROUND} onClick={back} disabled={busy} aria-label="Back">
            <ChevronLeft className="h-4 w-4" />
          </button>
        )}
        {/* eslint-disable-next-line @next/next/no-img-element -- the sidebar's mark, an SVG: next/image adds nothing here */}
        <img src="/favicon.svg" alt="" width={56} height={56} className="mx-auto mb-4" />
        <DialogTitle className="text-center" style={TITLE}>{view === "done" ? "Email confirmed" : "Confirm your email"}</DialogTitle>
        <DialogDescription className="mt-2 text-center" style={{ ...TEXT, color: "var(--enki-ink-2)" }}>
          {view === "done"
            ? "Your wallet can open now. Any other device signed in to this account was signed out."
            : view === "ask"
              ? `Confirm ${address} to open your wallet and to make sure security alerts reach you.`
              : sent === "again"
                ? `We sent a new code to ${address}. Only the newest code works.`
                : sent
                  ? `We sent a code to ${address}. It works for 15 minutes.`
                  : `Enter the code we emailed to ${address}.`}
        </DialogDescription>
        {view === "ask" && (
          <div className="mt-6 grid gap-3">
            <button type="button" className="disabled:opacity-50" style={PILL} disabled={busy} onClick={enterCode}>Enter code</button>
            <button type="button" className="disabled:opacity-50" style={PILL} disabled={busy || !!wait} onClick={request}>Request code</button>
          </div>
        )}
        {view === "code" && (
          <form className="mt-6 grid gap-3" onSubmit={(e) => { e.preventDefault(); void confirm(); }}>
            <input
              className={FIELD}
              style={CODE}
              aria-label="Code from the email"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={7}
              placeholder="0000000"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              autoFocus
            />
            <button type="submit" className="disabled:opacity-50" style={CTA} disabled={busy || !!wait || code.length !== 7}>Confirm</button>
            <button type="button" className="text-xs underline disabled:opacity-50" disabled={busy || !!wait} onClick={request}>Request a new code</button>
          </form>
        )}
        {(error ?? wait) && <p role="alert" className="mt-3 text-sm" style={{ color: "var(--enki-danger)" }}>{error ?? wait}</p>}
      </DialogContent>
    </Dialog>
  );
}
