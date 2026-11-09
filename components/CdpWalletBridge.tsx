"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useIsInitialized, useSolanaKeyExportIframe } from "@coinbase/cdp-hooks";
import { authenticateWithJWT, getCurrentUser, getCurrentUserSync, isSignedIn, signEvmMessage, signOut, signSolanaMessage, signSolanaTransaction, type User } from "@coinbase/cdp-core";
import { askStepUp, useStepUp, type Factor } from "@/components/StepUpProvider";
import { sessionAuthHeaders } from "@/lib/session-headers";
import {
  setCdpSolanaAddress,
  setCdpEvmAddress,
  fetchWalletJwt,
  isCdpLocked,
  cdpClosedReason,
  registerCdpEnsure,
  rememberCdpAddress,
  rememberedCdpAddress,
  getExportIframeContainer,
  setExportIframeStatus,
  CDP_EXPORT_IFRAME_EVENT,
  CDP_SIGN_REQUEST,
  CDP_SIGN_RESULT,
} from "@/lib/cdp-bridge";

/**
 * Renders CDP's own secure export button into whatever DOM node the caller
 * (KeyExport.tsx) registered via setExportIframeContainer. Lives inside this
 * file so the useSolanaKeyExportIframe call stays inside CDPHooksProvider —
 * the same reason signing and the address read do. The private key never
 * reaches this component: the iframe copies it straight to the clipboard.
 */
function ExportIframeHost({ address }: { address: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { status, message } = useSolanaKeyExportIframe({
    address,
    containerRef,
    label: "Copy private key",
    copiedLabel: "Copied",
  });
  useEffect(() => {
    setExportIframeStatus(status ?? null, message);
  }, [status, message]);
  return <div ref={containerRef} />;
}

/**
 * Bridges our email+password session to CDP. Renders nothing — provisions the
 * wallet invisibly (no connect step the user notices):
 *
 *  1. Each mount signs in to CDP itself (authenticateWithJWT, with our JWT via
 *     the provider's customAuth.getJwt) and trusts only the address of that
 *     sign-in. CDP keeps its user and wallet secret in memory for the page's
 *     lifetime, across our unmounts: after a logout and another account's
 *     login in a second tab it still holds the first account (or receives a
 *     late answer for it), whose wallet must never reach the second one's
 *     session. So any other user CDP holds is signed out before a sign-in,
 *     only this mount's address is published, attached and signed for, and a
 *     call that outlives its mount stops. The runtime is keyed by account.
 *  2. The address is published to the app, remembered for this email, and
 *     attached to our session (auth_sessions + user_wallets). A new address
 *     signs the server's text first; a wallet change also takes every factor,
 *     asked only on the way to a paid generation, never by the silent attach.
 *  3. Before every wallet action the JWT route decides (Kev, 2026-10-07): it
 *     answers 403 { locked } once the account has a second factor and this
 *     session's unlock ran out. Only then is the user asked, and no action's
 *     timeout runs meanwhile. Right after an email login (a one-shot marker
 *     from the landing) it asks at once; without a factor never.
 *
 * Sign uses the core function: it reads CDP's state when called, where the
 * hook version keeps the state of the render that created it. Export is
 * different (CDP-1): the key never passes through this component's JS at
 * all — see ExportIframeHost above.
 */
const solanaOf = (user: User | null | undefined) => user?.solanaAccountObjects?.[0]?.address;

type AttachAnswer = {
  error?: string;
  proof?: { address: string; family: "solana" | "evm"; nonce: string; message: string }[];
  all?: boolean;
  scope?: string;
  missing?: Factor[];
};

// CDP takes a Solana message base64 encoded and an EVM one as text (EIP-191). The server's text is plain ASCII.
const signProof = async ({ address, family, nonce, message }: NonNullable<AttachAnswer["proof"]>[number]) => {
  const { signature } = family === "solana"
    ? await signSolanaMessage({ solanaAccount: address, message: btoa(message) })
    : await signEvmMessage({ evmAccount: address as `0x${string}`, message });
  return { address, nonce, signature };
};

// email is null for a Google or X account without one: nothing is remembered then.
export function CdpWalletBridge({ email }: { email: string | null }) {
  const { isInitialized } = useIsInitialized();
  const { tokenFor } = useStepUp();
  const signingIn = useRef<Promise<string> | null>(null);
  const attaching = useRef<{ run: Promise<void>; asking: boolean } | null>(null);
  const alive = useRef(true);
  const own = useRef<string | null>(null); // the address this mount signed in
  const [mine, setMine] = useState<string | null>(null);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  // A call that outlives its mount (another account's login remounted the
  // runtime meanwhile) must not touch this session or CDP any more.
  const live = useCallback(() => {
    if (!alive.current) throw new Error("The account changed. Try again.");
  }, []);

  // One CDP sign-in at a time; resolves with this account's Solana address.
  // A user CDP holds that is not this mount's own is signed out first, its
  // wallet secret with it; this mount's own stays, an action may be using it.
  const signIn = useCallback(
    () => (signingIn.current ??= (async () => {
      const held = await getCurrentUser(); // with or without a Solana account yet
      if (held && solanaOf(held) !== own.current) await signOut().catch(() => { /* already gone */ });
      const { user } = await authenticateWithJWT();
      live();
      const address = solanaOf(user);
      if (!address) throw new Error("The wallet isn't ready yet. Try again.");
      if (email) rememberCdpAddress(email, address);
      own.current = address;
      setMine(address);
      return address;
    })().finally(() => { signingIn.current = null; })),
    [email, live],
  );

  // Writes the address into our session; a paid generation needs it there.
  // Nothing is awaited before the request, so it goes with the session the
  // caller checked, and every later request of this attach with that session.
  // A new address signs what the server sent (428). Only `asking` puts up a
  // dialog: every factor still missing, one at a time.
  // One attach at a time: parallel jobs share one, so one dialog's tokens, which
  // the server takes once, serve them all. Asking waits out a silent one, which
  // stops at the factors, and then goes itself; the session stays the caller's.
  const attach = useCallback((solana: string, { asking = false } = {}): Promise<void> => {
    const running = attaching.current;
    if (running && (running.asking || !asking)) return running.run;
    const session = sessionAuthHeaders();
    const run: Promise<void> = (async () => {
      await running?.run.catch(() => { /* its own caller hears it */ });
      live();
      let evm = getCurrentUserSync()?.evmAccountObjects?.[0]?.address ?? null;
      const post = async (proof?: unknown, tokens: string[] = []) => {
        const res = await fetch("/api/auth/session/attach-wallet", {
          method: "POST",
          headers: { "content-type": "application/json", ...session, ...(tokens.length ? { "X-StepUp-Token": tokens.join(",") } : {}) },
          body: JSON.stringify({ solanaAddress: solana, evmAddress: evm, proof }),
        });
        return { res, answer: (await res.json().catch(() => ({}))) as AttachAnswer };
      };
      let reply = await post();
      let proof: Awaited<ReturnType<typeof signProof>>[] | undefined;
      if (reply.res.status === 428) {
        // Only Solana pays: a side address whose signature fails is left out, and never stops a paid generation.
        const signed = await Promise.all((reply.answer.proof ?? []).map((p) => (p.family === "evm" ? signProof(p).catch(() => { evm = null; return null; }) : signProof(p))));
        proof = signed.filter((p) => p !== null);
        live();
        reply = await post(proof);
      }
      if (asking && reply.res.status === 401 && reply.answer.all) {
        const tokens: string[] = [];
        for (const factor of reply.answer.missing ?? []) {
          const token = await askStepUp(reply.answer.scope ?? "", [factor]);
          live();
          if (!token) throw new Error("Not confirmed, nothing was changed.");
          tokens.push(token);
        }
        reply = await post(proof, tokens);
      }
      if (!reply.res.ok) throw new Error(reply.answer.error || "Could not link the wallet. Try again.");
    })().finally(() => { if (attaching.current?.run === run) attaching.current = null; });
    attaching.current = { run, asking };
    return run;
  }, [live]);

  // Resolves once CDP can act for this session: the server first, the dialog
  // only when it still says locked (an export step-up, an unlock in another
  // tab or a removed last factor count at once), then this mount's sign-in.
  const ensure = useCallback(async ({ attached = false } = {}) => {
    if (!(await fetchWalletJwt())) {
      if (!isCdpLocked()) throw new Error(cdpClosedReason() ?? "The wallet isn't available right now. Try again.");
      if (!(await tokenFor("wallet"))) throw new Error("Not confirmed, nothing was signed.");
    }
    const held = own.current && (await isSignedIn()) ? solanaOf(await getCurrentUser()) : undefined;
    const address = held && held === own.current ? held : await signIn();
    live();
    if (attached) await attach(address, { asking: true });
  }, [live, tokenFor, signIn, attach]);

  useEffect(() => {
    registerCdpEnsure(ensure);
    return () => registerCdpEnsure(null);
  }, [ensure]);

  // Publish the address to the app outside this provider tree (deposit UI):
  // this mount's own, never whoever CDP holds. Until it signed in (or while
  // the wallet is locked) the last one for this email stands in, so the
  // screens can offer the action that unlocks.
  useEffect(() => {
    setCdpSolanaAddress(mine ?? (email ? rememberedCdpAddress(email) : null));
    return () => setCdpSolanaAddress(null);
  }, [mine, email]);

  // This mount's own wallet → our session.
  useEffect(() => {
    if (mine) attach(mine).catch(() => { /* a paid generation attaches again */ });
  }, [mine, attach]);

  // The silent sign-in, once per mount (its callbacks never change). Right
  // after an email login the landing leaves a one-shot marker: a locked
  // wallet asks at once then.
  useEffect(() => {
    if (!isInitialized) return;
    let askNow = false;
    try {
      askNow = sessionStorage.getItem("enki:wallet-ask") === "1";
      sessionStorage.removeItem("enki:wallet-ask");
    } catch { /* no marker */ }
    (askNow ? ensure() : signIn()).catch(() => { /* locked, cancelled or offline: the next wallet action asks */ });
  }, [isInitialized, ensure, signIn]);

  // Publish the EVM address too (multichain starting point, CDP-1): same
  // mount, same lifetime as the Solana one, informational-only for now.
  useEffect(() => {
    setCdpEvmAddress(mine ? getCurrentUserSync()?.evmAccountObjects?.[0]?.address ?? null : null);
    return () => setCdpEvmAddress(null);
  }, [mine]);

  // Self-custody export (CDP-1): watch for a container a caller outside this
  // provider (KeyExport.tsx) registered, and portal CDP's own secure export
  // button into it once this mount has signed in. Only this mount's address
  // is ever handed to the iframe — CDP refuses export for any other account.
  const [exportContainer, setExportContainerState] = useState<HTMLElement | null>(getExportIframeContainer());
  useEffect(() => {
    const onChange = () => setExportContainerState(getExportIframeContainer());
    window.addEventListener(CDP_EXPORT_IFRAME_EVENT, onChange);
    return () => window.removeEventListener(CDP_EXPORT_IFRAME_EVENT, onChange);
  }, []);

  // Payments: sign here, inside the provider, and hand the result back out.
  // The signing hook exists only in this tree, so the payment flow asks for a
  // signature by event instead of calling the hook where there is no provider.
  useEffect(() => {
    const onRequest = async (e: Event) => {
      const req = (e as CustomEvent).detail as { id: string; transaction: string };
      let detail: { id: string; signedTransaction?: string; error?: string };
      try {
        const solanaAccount = own.current;
        if (!solanaAccount) throw new Error("Wallet isn't ready yet");
        const { signedTransaction } = await signSolanaTransaction({ solanaAccount, transaction: req.transaction });
        detail = { id: req.id, signedTransaction };
      } catch (err) {
        detail = { id: req.id, error: err instanceof Error ? err.message : "Signing failed" };
      }
      window.dispatchEvent(new CustomEvent(CDP_SIGN_RESULT, { detail }));
    };
    window.addEventListener(CDP_SIGN_REQUEST, onRequest);
    return () => window.removeEventListener(CDP_SIGN_REQUEST, onRequest);
  }, []);

  return exportContainer && mine ? createPortal(<ExportIframeHost address={mine} />, exportContainer) : null;
}
