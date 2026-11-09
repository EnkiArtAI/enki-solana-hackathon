"use client";

/**
 * Signs a payment authorisation with the wallet it is FOR.
 *
 * The server builds the transaction for the session's wallet and has already
 * partial-signed it as fee payer, so exactly one signer is missing: the buyer.
 * That address picks the signer. An external wallet (Phantom, Solflare) signs
 * through the wallet adapter; an embedded wallet signs through CDP. Matching
 * on the address rather than on "whichever is connected" matters when both
 * exist: a Phantom left connected must not be asked to sign for a CDP account.
 */
import { useMemo } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { Transaction } from "@solana/web3.js";
import type { Adapter } from "@solana/wallet-adapter-base";
import { requestCdpSign, getCdpSolanaAddress } from "@/lib/cdp-bridge";
import { CheckoutError, type PaymentSigner } from "@/lib/generation-checkout";
import { connectAdapter, fromBase64, isMobileWalletAdapter, signAllWithAdapter, WALLET_WAIT_MS } from "@/lib/ui/kit/external-wallet";

/** The required signer that is not the fee payer: the buyer. The escrow
 *  deposit arrives with BOTH slots empty (the operator co-signs after the
 *  buyer), so "the first unsigned slot" would name the operator. */
export function buyerOf(transaction: string): string | null {
  const tx = Transaction.from(fromBase64(transaction));
  const feePayer = tx.feePayer?.toBase58();
  return tx.signatures.find((s) => !s.signature && s.publicKey.toBase58() !== feePayer)?.publicKey.toBase58() ?? null;
}

const refusal = () =>
  new CheckoutError("sign", "This payment is for the wallet you signed in with. Connect that wallet — nothing was charged.");

/** Solflare once never opened its window and the payment waited forever, every
 *  queued payment behind it (Colosseum, 2026-10-15). Unsigned means never sent:
 *  nothing was charged. */
function inTime<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new CheckoutError("sign", "Your wallet didn't answer. Open it and try again — nothing was charged.")),
      WALLET_WAIT_MS,
    );
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/**
 * Connect the adapter; true when the wallet had to be asked. autoConnect is
 * off (see SolanaWalletProvider), so after a reload the chosen wallet is
 * remembered but not connected yet. Connect FIRST: a Wallet Standard adapter
 * (Phantom, Solflare, Backpack) has signTransaction only while an account is
 * connected, so looking for it before connecting refused every external
 * wallet after a reload, without ever asking it (Kev's first browser payment,
 * 2026-10-13). Silently first: a site the wallet trusts connects without a
 * window. Only the prompting connect ran before, so Solflare showed its
 * window every time and "Trust this website" never took (Kev, 2026-10-15).
 */
async function connectFirst(adapter: Adapter): Promise<boolean> {
  if (!adapter.connected) await connectAdapter(adapter, { silent: true }).catch(() => undefined);
  const prompted = !adapter.connected;
  if (prompted) await connectAdapter(adapter);
  return prompted;
}

/** The phone's wallet app took this tap for the connect, and Chrome lets it open once per tap (external-wallet.ts). */
const tapAgain = () => new CheckoutError("sign", "Your wallet is connected. Tap again to sign — nothing was charged.");

async function signWith(adapter: Adapter, buyer: string, transactions: string[]): Promise<string[]> {
  const prompted = await connectFirst(adapter);
  if (adapter.publicKey?.toBase58() !== buyer || !("signTransaction" in adapter) || !adapter.signTransaction) throw refusal();
  // The signature needs the next tap.
  if (prompted && isMobileWalletAdapter(adapter)) throw tapAgain();
  return signAllWithAdapter(adapter, transactions);
}

/**
 * Connect an external wallet before an order is opened, so the phone's
 * "Tap again" happens while nothing is held (verification 2026-10-18). The
 * embedded wallet needs no connect.
 */
export async function prepareForBuyer({ adapter, cdpAddress }: { adapter: Adapter | null; cdpAddress: string | null }): Promise<void> {
  if (cdpAddress || !adapter) return;
  if ((await inTime(connectFirst(adapter))) && isMobileWalletAdapter(adapter)) throw tapAgain();
}

/** Every transaction of one order is for the same buyer; a list that names two, or none, is signed by nobody. */
export async function signForBuyer(
  transactions: string[],
  { adapter, cdpAddress }: { adapter: Adapter | null; cdpAddress: string | null },
): Promise<string[]> {
  const buyers = new Set(transactions.map(buyerOf));
  const buyer = buyers.size === 1 ? [...buyers][0] : null;
  // The embedded wallet asks nobody and keeps its own deadline (requestCdpSign): one after another.
  if (buyer && buyer === cdpAddress) {
    const signed: string[] = [];
    for (const transaction of transactions) signed.push(await requestCdpSign(transaction));
    return signed;
  }
  if (!buyer || !adapter) throw refusal();
  return inTime(signWith(adapter, buyer, transactions));
}

export function usePaymentSigner(): PaymentSigner {
  const { wallet } = useWallet();
  const adapter = wallet?.adapter ?? null;
  return useMemo(() => Object.assign(
    (transactions: string[]) => signForBuyer(transactions, { adapter, cdpAddress: getCdpSolanaAddress() }),
    { prepare: () => prepareForBuyer({ adapter, cdpAddress: getCdpSolanaAddress() }) },
  ), [adapter]);
}
