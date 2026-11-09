"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useEmailAuth } from "@/hooks/useEmailAuth";
import { CARD, CORNER, CTA, FIELD, PILL, ROUND, TEXT, TITLE } from "@/components/enki-window";

const NOT_SAVED = "Your request could not be sent. Try again.";

/**
 * "Private beta" (Kev, 2026-11-07: "nicht in der beta, ja. die sollen sich ruhig drauf bewerben"): where a signed-in account
 * without beta access meets the closed beta (components/BetaGate.tsx), and after a provider login refused as not on the access
 * list (app/auth/complete). The look of "Confirm your email" (components/enki-window.ts), laid out as Kev's screenshot: the
 * logo, the title, one grey line, two stacked pills. "Enter access code" opens the existing code entry (/gate) with this page
 * as its next; "Request access code" is an application, posted to the existing /api/access-request (table access_requests).
 * × leaves for the landing: behind this window there is nothing to show.
 */
export default function PrivateBetaWindow({ next }: { next?: string }) {
  const router = useRouter();
  const { email: known } = useEmailAuth();
  const [view, setView] = useState<"ask" | "form" | "done">("ask");
  // useEmailAuth reads the session in an effect, so its email arrives after the first render: the field shows it until
  // something is typed (DEC-2026-11-07-34).
  const [typedEmail, setEmail] = useState<string | null>(null);
  const email = typedEmail ?? known ?? "";
  const [about, setAbout] = useState("");
  const [socials, setSocials] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const enterCode = () => {
    const back = next ?? `${window.location.pathname}${window.location.search}`;
    router.push(`/gate?next=${encodeURIComponent(back)}`);
  };

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/access-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), about: about.trim(), socials: socials.trim() }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) return setError(data.error || NOT_SAVED);
      setView("done");
    } catch {
      setError(NOT_SAVED);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) router.push("/"); }}>
      {/* The confirm window's layers: above sheets, alert dialogs and toasts; below the step-up dialog. */}
      <DialogContent className="z-[10029] w-[calc(100%-32px)] max-w-[400px] gap-0 px-6 pb-6 pt-10 text-center" overlayClassName="z-[10028] bg-black/50 backdrop-blur-[6px]" style={CARD} closeStyle={ROUND}>
        {view === "form" && (
          <button type="button" className={`${CORNER} left-4 kit-round`} style={ROUND} onClick={() => { setError(null); setView("ask"); }} disabled={busy} aria-label="Back">
            <ChevronLeft className="h-4 w-4" />
          </button>
        )}
        {/* eslint-disable-next-line @next/next/no-img-element -- the sidebar's mark, an SVG: next/image adds nothing here */}
        <img src="/favicon.svg" alt="" width={56} height={56} className="mx-auto mb-4" />
        <DialogTitle className="text-center" style={TITLE}>{view === "done" ? "Request sent" : view === "form" ? "Request access code" : "Private beta"}</DialogTitle>
        <DialogDescription className="mt-2 text-center" style={{ ...TEXT, color: "var(--enki-ink-2)" }}>
          {view === "done"
            ? `Thanks. We read every request. If we let you in, an email to ${email.trim()} tells you how to sign in.`
            : view === "form"
              ? "Tell us a little about you. We read every request."
              : "You'll need an access code to get in."}
        </DialogDescription>
        {view === "ask" && (
          <div className="mt-6 grid gap-3">
            <button type="button" style={PILL} onClick={enterCode}>Enter access code</button>
            <button type="button" style={PILL} onClick={() => setView("form")}>Request access code</button>
          </div>
        )}
        {view === "form" && (
          <form className="mt-6 grid gap-3" onSubmit={(e) => { e.preventDefault(); void send(); }}>
            <input className={FIELD} type="email" aria-label="Your email" placeholder="Your email" autoComplete="email" maxLength={254}
              value={email} onChange={(e) => setEmail(e.target.value)} />
            <textarea className={FIELD} rows={4} aria-label="A few words about you" placeholder="A few words about you: what you make, what brings you here" maxLength={2000}
              value={about} onChange={(e) => setAbout(e.target.value)} />
            <input className={FIELD} aria-label="Socials (optional)" placeholder="Socials (optional): X, Instagram, a website" maxLength={500}
              value={socials} onChange={(e) => setSocials(e.target.value)} />
            <button type="submit" className="disabled:opacity-50" style={CTA} disabled={busy || !email.trim() || !about.trim()}>Send request</button>
          </form>
        )}
        {error && <p role="alert" className="mt-3 text-sm" style={{ color: "var(--enki-danger)" }}>{error}</p>}
      </DialogContent>
    </Dialog>
  );
}
