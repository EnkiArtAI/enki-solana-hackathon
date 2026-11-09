"use client";

import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useEmailAuth } from "@/hooks/useEmailAuth";
import { useSolanaAuth } from "@/hooks/useSolanaAuth";
import { draftsWithWords, forgetDrafts } from "@/lib/editor/draft-store";
import { dropAfterLogin } from "@/lib/openLogin";

/**
 * Log off on this device (DEC-2026-11-08-42), shared by the shell's account menu and Settings: the confirm's state, the
 * drafts it will delete, and the sign-out across every auth surface. Moved as it was from EnkiHome; whoever draws the
 * confirm keeps its markup and its Esc. Each logout reads the stored session itself, so this hook's own instances of
 * useEmailAuth and useSolanaAuth end the same session the shell's do.
 */
export function useLogoff() {
  const { logout: emailLogout } = useEmailAuth();
  const { logout: solanaLogout } = useSolanaAuth();
  const { connected: adapterConnected, disconnect: adapterDisconnect } = useWallet();
  // Log off: confirm dialog + the actual sign-out across every auth surface.
  const [logoffOpen, setLogoffOpen] = useState(false);
  const [logoffBusy, setLogoffBusy] = useState(false);
  // The editor drafts a log-off deletes from this browser (Kev, 2026-10-28), counted as the dialog opens.
  const [logoffDrafts, setLogoffDrafts] = useState(0);
  const askLogoff = () => {
    setLogoffDrafts(draftsWithWords(typeof window === "undefined" ? null : window.localStorage));
    setLogoffOpen(true);
  };
  const doLogoff = async () => {
    setLogoffBusy(true);
    try {
      await solanaLogout(); // deletes the server session, then local storage
      emailLogout();
      if (adapterConnected) await adapterDisconnect().catch(() => {});
    } finally {
      // The next person on this browser finds none of the editor's drafts (DEC-473), nor a handover to the editor waiting
      // in this tab's sessionStorage (DEC-479). Blocked storage holds nothing to take and never stops the redirect.
      try { forgetDrafts(window.localStorage, typeof indexedDB === "undefined" ? null : indexedDB); } catch { /* blocked storage */ }
      try { forgetDrafts(window.sessionStorage, null); } catch { /* blocked storage */ }
      dropAfterLogin();
      window.location.href = "/"; // hard reload → landing, all client state reset
    }
  };
  return { logoffOpen, setLogoffOpen, logoffBusy, logoffDrafts, askLogoff, doLogoff };
}
