"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import { useEffect, useState } from "react";
import { getQueryFn, QUERY_RETRY } from "@/lib/queryClient";
import { applyLessMotion } from "@/lib/ui/kit/motion";
import { ThirdwebProvider } from "./ThirdwebProvider";
import { ThemeProvider } from "./ThemeProvider";
import { SolanaWalletProvider } from "./SolanaWalletProvider";

import dynamic from "next/dynamic";
import { useEmailAuth } from "@/hooks/useEmailAuth";
import { expectCdpRuntime } from "@/lib/cdp-bridge";

// The CDP SDK is heavy, so it loads lazily and mounts only while an email,
// Google or X session exists — visitors and wallet-only users never download it.
const CdpRuntime = dynamic(() => import("./CdpProvider"), { ssr: false });

// One runtime per account: another account's login remounts it, and the new
// bridge signs in to CDP itself (see CdpWalletBridge).
function CdpLauncher() {
  const { email, account } = useEmailAuth();
  // Expected only where it really mounts (CdpProvider renders nothing without a project id): a paid order waits for it
  // (lib/cdp-bridge.ts, round 32, 2026-10-21).
  const expected = Boolean(account && process.env.NEXT_PUBLIC_CDP_PROJECT_ID);
  useEffect(() => { expectCdpRuntime(expected); }, [expected]);
  return account ? <CdpRuntime key={account} email={email} /> : null;
}
import { Toaster } from "@/components/ui/toaster";
import RenderNotices from "@/components/kit/RenderNotices";
import ShareHost from "@/components/share/ShareHost";
import BetaGate from "@/components/BetaGate";
import { StepUpProvider } from "@/components/StepUpProvider";
import SecondFactorBar from "@/components/SecondFactorBar";
import ConfirmEmailWindow from "@/components/ConfirmEmailWindow";

/**
 * Provider hierarchy (outermost first):
 *
 *   ThemeProvider          ← theme must survive wallet re-renders
 *     QueryClientProvider  ← data fetching
 *       ThirdwebProvider   ← wallet + x402
 *         TooltipProvider  ← UI
 *
 * ThemeProvider is outermost so that wallet connect/disconnect
 * never causes a theme flash or reset.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            queryFn: getQueryFn({ on401: "throw" }),
            refetchInterval: false,
            refetchOnWindowFocus: false,
            staleTime: Infinity,
            ...QUERY_RETRY,
          },
          mutations: {
            retry: false,
          },
        },
      })
  );
  // Less motion, this device's choice (Settings › App): back on the page at every load.
  useEffect(() => { applyLessMotion(); }, []);

  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <ThirdwebProvider>

            <SolanaWalletProvider>
              <TooltipProvider>
                {/* Closed-beta wall around EVERY page (public paths excepted). */}
                <StepUpProvider>
                  <BetaGate>
                    {/* First: it goes with the page when BetaGate shows its wall. */}
                    <SecondFactorBar />
                    {/* An unconfirmed login email keeps the wallet closed: the window that confirms it, on load and when the wallet asks. */}
                    <ConfirmEmailWindow />
                    {children}
                    {/* A finished render, wherever the reader is (Kev, 2026-10-26); inside the gate: none over its wall. */}
                    <RenderNotices />
                    {/* The share a release offers, over the page it opened; inside the gate as well. */}
                    <ShareHost />
                  </BetaGate>
                  {/* Inside the step-up provider: the wallet unlock asks through its dialog. */}
                  <CdpLauncher />
                </StepUpProvider>
                {/* Without this, every toast() (errors included) went nowhere. */}
                <Toaster />
              </TooltipProvider>
            </SolanaWalletProvider>

        </ThirdwebProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
