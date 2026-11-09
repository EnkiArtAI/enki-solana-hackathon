"use client";

/**
 * /guardian?token=… — where an INVITED GUARDIAN (a friend, not the account
 * owner) confirms their role. Reached only via the share link from
 * Settings → Recovery & 2FA. Wallet guardians connect the invited wallet and
 * sign one message; email guardians just press confirm.
 * In the look of the app's small windows (EnkiCardPage).
 */
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletReadyState } from "@solana/wallet-adapter-base";
import type { WalletName } from "@solana/wallet-adapter-base";
import { CheckCircle2, Loader2 } from "lucide-react";
import { guardianCheckMessage, guardianFactorMessage, guardianMessage } from "@/lib/guardian-message";
import EnkiCardPage, { EnkiCardButton, EnkiCardInput } from "@/components/EnkiCardPage";
import { CODE, LABEL, PILL, TEXT } from "@/components/enki-window";

interface Invite {
  guardianType: "wallet" | "email";
  maskedValue: string;
  status: "pending" | "confirmed";
  inviterHandle: string;
}

// The card decides the colours (EnkiCardPage, var(--card-*)); the lines take the layout's text (enki-window.ts TEXT), masked
// wallets and the code the layout's mono (LABEL's face, Settings' numbers; DEC-2026-11-08-02).
const SUB = { ...TEXT, color: "var(--card-ink-2)" } as const;

/** Recovery mode: a guardian enters the 7-digit code from their email to
 *  approve a locked-out friend's account recovery. */
function RecoveryApprove({ requestId, guardianId }: { requestId: string; guardianId: string }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ approved: number; threshold: number } | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/recovery/approve", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId, guardianId, code }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Could not approve.");
      setResult({ approved: data.approved, threshold: data.threshold });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not approve.");
    } finally { setBusy(false); }
  };

  if (result) {
    return (
      <EnkiCardPage title="Thank you — approval counted." eyebrow="Enki Art · Recovery">
        <p style={{ ...SUB, display: "flex", alignItems: "flex-start", gap: 8 }}>
          <CheckCircle2 size={20} style={{ color: "var(--card-green)", flexShrink: 0, marginTop: 2 }} />
          <span>
            {result.approved} of {result.threshold} approvals are in.
            {result.approved >= result.threshold
              ? " Your friend can set a new password now."
              : " Once enough guardians approve, your friend gets back in."}
          </span>
        </p>
      </EnkiCardPage>
    );
  }

  return (
    <EnkiCardPage title="Help your friend get back in." eyebrow="Enki Art · Recovery">
      <p style={{ ...SUB, marginBottom: 8 }}>
        Someone who trusts you as their recovery guardian is locked out. You got a
        <b> 7-digit code</b> in the same email as this link.
      </p>
      <p style={{ fontSize: 13, color: "var(--card-accent)", fontWeight: 600, marginBottom: 18 }}>
        Only enter it if they contacted you personally and you&apos;re sure it&apos;s really them.
      </p>
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <EnkiCardInput
          inputMode="numeric" autoComplete="one-time-code" placeholder="1234567" maxLength={7} autoFocus
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 7))}
          style={CODE}
        />
        {error && <p style={{ fontSize: 13, color: "var(--card-danger)", margin: 0 }}>{error}</p>}
        <EnkiCardButton type="submit" disabled={busy || code.length !== 7}>
          {busy ? "Checking…" : "Approve recovery"}
        </EnkiCardButton>
      </form>
    </EnkiCardPage>
  );
}

/** A friend lost a security factor and asks for a yes (lib/mfa-recovery.ts approveGuardianAsk): the link in the mail
 *  (?factor=…&g=…&t=…), or for a wallet guardian the link the owner sent, signed with that wallet. */
function FactorApprove({ requestId, guardianId, token }: { requestId: string; guardianId: string; token: string }) {
  const { wallets, select, connected, signMessage } = useWallet();
  const [info, setInfo] = useState<{ requesterHandle: string | null; factor: string; guardianType: string; maskedValue: string; alreadyApproved: boolean; open: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ approved: number; needed: number; done: boolean } | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/recovery/approve?factor=${encodeURIComponent(requestId)}&g=${encodeURIComponent(guardianId)}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || "This link isn't valid.");
        setInfo(data);
      } catch (e) {
        setError(e instanceof Error ? e.message : "This link isn't valid.");
      }
    })();
  }, [requestId, guardianId]);

  const say = async (proof: { token?: string; signature?: string }) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/recovery/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId, guardianId, ...proof }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Could not count your yes.");
      setResult({ approved: data.approved, needed: data.needed, done: data.done });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not count your yes.");
    } finally { setBusy(false); }
  };
  const signAndSay = async () => {
    if (!connected || !signMessage) { setError("Connect the invited wallet first."); return; }
    try {
      const sig = await signMessage(new TextEncoder().encode(guardianFactorMessage(requestId)));
      await say({ signature: Buffer.from(sig).toString("base64") });
    } catch { /* closed the popup: stay put */ }
  };

  const who = info?.requesterHandle ? `@${info.requesterHandle}` : "your friend";
  if (result) {
    return (
      <EnkiCardPage title="Thank you, your yes counts." eyebrow="Enki Art · Recovery">
        <p style={{ ...SUB, display: "flex", alignItems: "flex-start", gap: 8 }}>
          <CheckCircle2 size={20} style={{ color: "var(--card-green)", flexShrink: 0, marginTop: 2 }} />
          <span>
            {result.approved} of {result.needed} guardians said yes.
            {result.done ? ` The lost factor is removed: ${who} can get in again.` : ` Once ${result.needed} say yes, it is removed.`}
          </span>
        </p>
      </EnkiCardPage>
    );
  }
  if (!info) {
    return error
      ? <EnkiCardPage title="Hm, that didn't work." eyebrow="Enki Art · Recovery"><p style={SUB}>{error}</p></EnkiCardPage>
      : <EnkiCardPage title="One moment…" eyebrow="Enki Art · Recovery"><Loader2 size={18} style={{ animation: "spin 1s linear infinite" }} /></EnkiCardPage>;
  }
  if (!info.open || info.alreadyApproved) {
    return (
      <EnkiCardPage title={info.alreadyApproved ? "Your yes is already counted." : "This request is closed."} eyebrow="Enki Art · Recovery">
        <p style={SUB}>There is nothing more to do. You can close this page.</p>
      </EnkiCardPage>
    );
  }
  const installed = wallets.filter((w) => w.readyState === WalletReadyState.Installed || w.readyState === WalletReadyState.Loadable);
  return (
    <EnkiCardPage title={`${info.requesterHandle ? `@${info.requesterHandle}` : "Your friend"} asks for your help`} eyebrow="Enki Art · Recovery">
      <p style={{ ...SUB, marginBottom: 8 }}>
        {who} lost a security factor (their {info.factor}). Your yes helps remove {who}&apos;s lost security factor so they can get into their money again.
      </p>
      <p style={{ fontSize: 13, color: "var(--card-accent)", fontWeight: 600, marginBottom: 18 }}>
        Only say yes if {who} asked you themselves, by phone or in person, not only by a message.
      </p>
      {info.guardianType === "wallet" ? (
        <>
          <p style={{ fontSize: 13, color: "var(--card-quiet)", marginBottom: 14 }}>
            Your wallet: <span style={{ fontFamily: LABEL.fontFamily }}>{info.maskedValue}</span>. Connect exactly that wallet, then sign one message.
          </p>
          {connected ? (
            <EnkiCardButton onClick={signAndSay} disabled={busy}>{busy ? "Waiting for your signature…" : "Sign and say yes"}</EnkiCardButton>
          ) : installed.length === 0 ? (
            <p style={{ fontSize: 13, color: "var(--card-quiet)" }}>No Solana wallet extension found in this browser.</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {installed.map((w) => (
                <EnkiCardButton key={w.adapter.name} onClick={async () => { setError(null); try { select(w.adapter.name as WalletName); await w.adapter.connect(); } catch { /* closed */ } }}>
                  Connect {w.adapter.name}
                </EnkiCardButton>
              ))}
            </div>
          )}
        </>
      ) : (
        <EnkiCardButton onClick={() => say({ token })} disabled={busy || !token}>{busy ? "One moment…" : "Yes, remove the lost factor"}</EnkiCardButton>
      )}
      <p style={{ fontSize: 13, color: "var(--card-quiet)", marginTop: 14 }}>
        If they did not ask you themselves, do nothing: without your yes nothing changes.
      </p>
      {error && <p style={{ fontSize: 13, color: "var(--card-danger)", marginTop: 12 }}>{error}</p>}
    </EnkiCardPage>
  );
}

/** The yearly check (lib/recovery/guardian-check.ts): a guardian says they can still be reached, by the link in their mail
 *  (?check=…&t=…), or for a wallet guardian by the link the owner sent, signed with that wallet. It moves no money. */
function GuardianCheck({ guardianId, token }: { guardianId: string; token: string }) {
  const { wallets, select, connected, signMessage } = useWallet();
  const [info, setInfo] = useState<{ requesterHandle: string | null; guardianType: string; maskedValue: string; sentAt: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/recovery/guardians/confirm?check=${encodeURIComponent(guardianId)}${token ? `&t=${encodeURIComponent(token)}` : ""}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || "This link isn't valid.");
        setInfo(data);
      } catch (e) {
        setError(e instanceof Error ? e.message : "This link isn't valid.");
      }
    })();
  }, [guardianId, token]);

  const answer = async (proof: { token?: string; signature?: string }) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/recovery/guardians/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ check: guardianId, ...proof }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Could not save your answer.");
      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save your answer.");
    } finally { setBusy(false); }
  };
  const signAndAnswer = async () => {
    if (!info || !connected || !signMessage) { setError("Connect the invited wallet first."); return; }
    try {
      const sig = await signMessage(new TextEncoder().encode(guardianCheckMessage(guardianId, info.sentAt)));
      await answer({ signature: Buffer.from(sig).toString("base64") });
    } catch { /* closed the popup: stay put */ }
  };

  const who = info?.requesterHandle ? `@${info.requesterHandle}` : "your friend";
  if (done) {
    return (
      <EnkiCardPage title="Thank you, you're still on the list." eyebrow="Enki Art · Recovery">
        <p style={{ ...SUB, display: "flex", alignItems: "flex-start", gap: 8 }}>
          <CheckCircle2 size={20} style={{ color: "var(--card-green)", flexShrink: 0, marginTop: 2 }} />
          <span>{who} can count on you. We ask again in a year. You can close this page.</span>
        </p>
      </EnkiCardPage>
    );
  }
  if (!info) {
    return error
      ? <EnkiCardPage title="Hm, that didn't work." eyebrow="Enki Art · Recovery"><p style={SUB}>{error}</p></EnkiCardPage>
      : <EnkiCardPage title="One moment…" eyebrow="Enki Art · Recovery"><Loader2 size={18} style={{ animation: "spin 1s linear infinite" }} /></EnkiCardPage>;
  }
  const installed = wallets.filter((w) => w.readyState === WalletReadyState.Installed || w.readyState === WalletReadyState.Loadable);
  return (
    <EnkiCardPage title={`Still there for ${who}?`} eyebrow="Enki Art · Recovery">
      <p style={{ ...SUB, marginBottom: 18 }}>
        {who} named you as a recovery guardian on Enki Art. Once a year we check that every guardian can still be reached. One click tells us you can: it moves no money and approves nothing.
      </p>
      {info.guardianType === "wallet" ? (
        <>
          <p style={{ fontSize: 13, color: "var(--card-quiet)", marginBottom: 14 }}>
            Your wallet: <span style={{ fontFamily: LABEL.fontFamily }}>{info.maskedValue}</span>. Connect exactly that wallet, then sign one message.
          </p>
          {connected ? (
            <EnkiCardButton onClick={signAndAnswer} disabled={busy}>{busy ? "Waiting for your signature…" : "Sign and confirm"}</EnkiCardButton>
          ) : installed.length === 0 ? (
            <p style={{ fontSize: 13, color: "var(--card-quiet)" }}>No Solana wallet extension found in this browser.</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {installed.map((w) => (
                <EnkiCardButton key={w.adapter.name} onClick={async () => { setError(null); try { select(w.adapter.name as WalletName); await w.adapter.connect(); } catch { /* closed */ } }}>
                  Connect {w.adapter.name}
                </EnkiCardButton>
              ))}
            </div>
          )}
        </>
      ) : (
        <EnkiCardButton onClick={() => answer({ token })} disabled={busy || !token}>{busy ? "One moment…" : "Yes, I can still be reached"}</EnkiCardButton>
      )}
      {error && <p style={{ fontSize: 13, color: "var(--card-danger)", marginTop: 12 }}>{error}</p>}
    </EnkiCardPage>
  );
}

/** Deletion-approval mode: a guardian approves a friend's account deletion. */
function DeletionApprove({ token }: { token: string }) {
  const [info, setInfo] = useState<{ requesterHandle: string; alreadyApproved: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/account/delete/approve?token=${encodeURIComponent(token)}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || "This link isn't valid.");
        setInfo(data);
        if (data.alreadyApproved) setDone(true);
      } catch (e) {
        setError(e instanceof Error ? e.message : "This link isn't valid.");
      }
    })();
  }, [token]);

  const approve = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/account/delete/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Could not approve.");
      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not approve.");
    } finally { setBusy(false); }
  };

  if (done) {
    return (
      <EnkiCardPage title="Approved." eyebrow="Enki Art · Account">
        <p style={SUB}>
          Thanks. Once enough guardians approve, {info?.requesterHandle ?? "their"} account will be deleted. You can close this page.
        </p>
      </EnkiCardPage>
    );
  }
  if (error && !info) {
    return <EnkiCardPage title="Hm, that didn't work." eyebrow="Enki Art · Account"><p style={SUB}>{error}</p></EnkiCardPage>;
  }
  if (!info) {
    return <EnkiCardPage title="One moment…" eyebrow="Enki Art · Account"><Loader2 size={18} style={{ animation: "spin 1s linear infinite" }} /></EnkiCardPage>;
  }
  return (
    <EnkiCardPage title={`Approve deleting ${info.requesterHandle}'s account?`} eyebrow="Enki Art · Account">
      <p style={{ ...SUB, marginBottom: 20 }}>
        {info.requesterHandle} asked to permanently delete their Enki Art account and named you as a guardian.
        Only approve if you know this is really them. Doing nothing is also fine.
      </p>
      <EnkiCardButton onClick={approve} disabled={busy}>
        {busy ? "One moment…" : "Yes, approve deletion"}
      </EnkiCardButton>
      {error && <p style={{ fontSize: 13, color: "var(--card-danger)", marginTop: 12 }}>{error}</p>}
    </EnkiCardPage>
  );
}

function GuardianInner() {
  const params = useSearchParams();
  const token = params.get("token") ?? "";
  const recoveryId = params.get("recovery");
  const recoveryGuardian = params.get("g");
  const deleteToken = params.get("delete");
  const { wallets, select, publicKey, signMessage, connected } = useWallet();

  const [invite, setInvite] = useState<Invite | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [declined, setDeclined] = useState(false);
  // The email carries separate accept/decline links (?action=…). Neither
  // auto-executes — mail scanners prefetch links — the page just leads with
  // the matching button.
  const [mode, setMode] = useState<"accept" | "decline">(params.get("action") === "decline" ? "decline" : "accept");

  useEffect(() => {
    if (!token) { setError("This link is missing its code — ask your friend to copy it again from their Recovery settings."); return; }
    (async () => {
      try {
        const res = await fetch(`/api/recovery/guardians/confirm?token=${encodeURIComponent(token)}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || "This link isn't valid.");
        setInvite(data as Invite);
        if ((data as Invite).status === "confirmed") setDone(true);
      } catch (e) {
        setError(e instanceof Error ? e.message : "This link isn't valid.");
      }
    })();
  }, [token]);

  const confirm = async (signature?: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/recovery/guardians/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(signature ? { token, signature } : { token }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Could not confirm.");
      setDone(true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Could not confirm.";
      if (!/reject|cancel|denied/i.test(msg)) setError(msg);
    } finally { setBusy(false); }
  };

  const confirmWallet = async () => {
    if (!connected || !publicKey || !signMessage) { setError("Connect the invited wallet first."); return; }
    try {
      const sigBytes = await signMessage(new TextEncoder().encode(guardianMessage(token)));
      await confirm(Buffer.from(sigBytes).toString("base64"));
    } catch { /* user closed the popup — stay put */ }
  };

  const decline = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/recovery/guardians/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, decline: true }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Could not decline.");
      setDeclined(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not decline.");
    } finally { setBusy(false); }
  };

  const installedWallets = wallets.filter(
    (w) => w.readyState === WalletReadyState.Installed || w.readyState === WalletReadyState.Loadable
  );

  // Account-deletion approval mode (?delete=token).
  if (deleteToken) {
    return <DeletionApprove token={deleteToken} />;
  }

  // The yearly check (?check=…[&t=…]).
  const check = params.get("check");
  if (check) {
    return <GuardianCheck guardianId={check} token={params.get("t") ?? ""} />;
  }

  // A friend's lost factor (?factor=…&g=…[&t=…]).
  const factorRequest = params.get("factor");
  if (factorRequest && recoveryGuardian) {
    return <FactorApprove requestId={factorRequest} guardianId={recoveryGuardian} token={params.get("t") ?? ""} />;
  }

  // Recovery-approval mode (?recovery=…&g=…) — a different job than the
  // invite-confirm flow below.
  if (recoveryId && recoveryGuardian) {
    return <RecoveryApprove requestId={recoveryId} guardianId={recoveryGuardian} />;
  }

  if (declined) {
    return (
      <EnkiCardPage title="No problem." eyebrow="Enki Art · Recovery">
        <p style={SUB}>
          You&apos;ve declined the guardian role.
          {invite?.inviterHandle ? ` ${invite.inviterHandle} will see you're no longer on their list.` : ""}
          {" "}You can close this page.
        </p>
      </EnkiCardPage>
    );
  }

  if (done) {
    return (
      <EnkiCardPage title="You're a guardian now." eyebrow="Enki Art · Recovery">
        <p style={{ ...SUB, display: "flex", alignItems: "flex-start", gap: 8 }}>
          <CheckCircle2 size={20} style={{ color: "var(--card-green)", flexShrink: 0, marginTop: 2 }} />
          <span>
            Nothing else to do today. If {invite?.inviterHandle ?? "your friend"} ever loses access,
            we&apos;ll ask you to approve their recovery — that&apos;s the whole job.
          </span>
        </p>
      </EnkiCardPage>
    );
  }

  if (error && !invite) {
    return (
      <EnkiCardPage title="Hm, that didn't work." eyebrow="Enki Art · Recovery">
        <p style={SUB}>{error}</p>
      </EnkiCardPage>
    );
  }

  if (!invite) {
    return (
      <EnkiCardPage title="One moment…" eyebrow="Enki Art · Recovery">
        <Loader2 size={18} style={{ animation: "spin 1s linear infinite" }} />
      </EnkiCardPage>
    );
  }

  if (mode === "decline") {
    return (
      <EnkiCardPage title="Decline the guardian role?" eyebrow="Enki Art · Recovery">
        <p style={{ ...SUB, marginBottom: 20 }}>
          {invite.inviterHandle} asked you to be a recovery guardian for their Enki Art account.
          If that&apos;s not for you, decline below and you&apos;re off their list.
        </p>
        <EnkiCardButton onClick={decline} disabled={busy}>
          {busy ? "One moment…" : "Yes, decline"}
        </EnkiCardButton>
        <button
          onClick={() => setMode("accept")}
          disabled={busy}
          className="disabled:opacity-50"
          style={{ ...PILL, marginTop: 10, cursor: "pointer" }}
        >
          I&apos;d rather accept the role
        </button>
        {error && <p style={{ fontSize: 13, color: "var(--card-danger)", marginTop: 12 }}>{error}</p>}
      </EnkiCardPage>
    );
  }

  return (
    <EnkiCardPage title={`Become a guardian for ${invite.inviterHandle}`} eyebrow="Enki Art · Recovery">
      <p style={{ ...SUB, marginBottom: 20 }}>
        {invite.inviterHandle} trusts you to help them get back into their Enki Art account if they
        ever get locked out. Confirming costs nothing and moves no money — you&apos;d simply be asked
        to approve their recovery one day.
      </p>
      {invite.guardianType === "email" ? (
        <>
          <EnkiCardButton onClick={() => confirm()} disabled={busy}>
            {busy ? "Confirming…" : "Yes, I'll be their guardian"}
          </EnkiCardButton>
          <button
            onClick={decline}
            disabled={busy}
            className="disabled:opacity-50"
            style={{ ...PILL, marginTop: 10, cursor: "pointer" }}
          >
            No thanks, decline
          </button>
        </>
      ) : (
        <>
          <p style={{ fontSize: 13, color: "var(--card-quiet)", marginBottom: 14 }}>
            Invited wallet: <span style={{ fontFamily: LABEL.fontFamily }}>{invite.maskedValue}</span>.
            Connect exactly that wallet, then sign one message to prove it&apos;s yours.
          </p>
          {!connected ? (
            installedWallets.length === 0 ? (
              <p style={{ fontSize: 13, color: "var(--card-quiet)" }}>
                No Solana wallet extension found in this browser.
              </p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {installedWallets.map((w) => (
                  <button
                    key={w.adapter.name}
                    onClick={async () => {
                      setError(null);
                      try {
                        select(w.adapter.name as WalletName);
                        await w.adapter.connect();
                      } catch { /* user closed the popup */ }
                    }}
                    style={{ ...PILL, display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", cursor: "pointer" }}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={w.adapter.icon} alt="" width={20} height={20} />
                    Connect {w.adapter.name}
                  </button>
                ))}
              </div>
            )
          ) : (
            <EnkiCardButton onClick={confirmWallet} disabled={busy}>
              {busy ? "Waiting for your signature…" : "Sign & confirm"}
            </EnkiCardButton>
          )}
          <button
            onClick={decline}
            disabled={busy}
            className="disabled:opacity-50"
            style={{ ...PILL, marginTop: 10, cursor: "pointer" }}
          >
            No thanks, decline
          </button>
        </>
      )}
      {error && <p style={{ fontSize: 13, color: "var(--card-danger)", marginTop: 12 }}>{error}</p>}
    </EnkiCardPage>
  );
}

export default function GuardianPage() {
  return (
    <Suspense fallback={null}>
      <GuardianInner />
    </Suspense>
  );
}
