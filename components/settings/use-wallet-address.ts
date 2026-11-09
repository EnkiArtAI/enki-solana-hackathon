"use client";

import { useActiveAccount } from "thirdweb/react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useCdpAddress } from "@/hooks/useCdpAddress";
import { useSolanaAuth } from "@/hooks/useSolanaAuth";
import { useBetaAccess } from "@/components/BetaGate";
import { cdpRuntimeExpected } from "@/lib/cdp-bridge";

/**
 * Whose money Settings shows and moves (DEC-2026-11-08-41): the wallet's address, and whether an embedded wallet can be
 * opened from here when there is none yet. Moved as it was from the Payment panel.
 */
export function useWalletAddress() {
  const account = useActiveAccount();
  const { publicKey: solanaPublicKey } = useWallet();
  const { address: cdpAddress } = useCdpAddress();
  // Session-backed Solana identity: after a reload the wallet ADAPTER is
  // disconnected (autoConnect off) but the signed session lives on — without
  // this, wallet users saw "Sign in to see it" although they're logged in.
  const { isAuthenticated: solanaSessionActive, walletAddress: solanaSessionAddress } = useSolanaAuth();

  const address =
    account?.address ??
    (solanaSessionActive ? solanaSessionAddress : null) ??
    solanaPublicKey?.toBase58() ??
    cdpAddress ??
    null;
  /* Signed in is the session's word, as everywhere else (EnkiHome's authed): an email, Google or X login whose wallet
     has not opened yet has no address, and was told to sign in (Kev, 2026-10-26: "warum steht bei mir Sign in to see
     ... even tho i am connected with my GOOGLE ACCOUNT?"). */
  const { access, role } = useBetaAccess();
  const signedIn = access === "ok" && role !== "team";
  // Only an embedded wallet can be opened from here; a wallet login whose session ran out signs in again (review fix).
  const walletCanOpen = signedIn && cdpRuntimeExpected();
  return { address, walletCanOpen };
}
