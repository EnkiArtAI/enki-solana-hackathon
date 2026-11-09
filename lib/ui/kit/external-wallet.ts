/**
 * The external Solana wallet (Phantom, Solflare, the phone's wallet app)
 * through its wallet-adapter, for every place that connects or signs with it:
 * the login picker, the payment signer, wallet linking, Send USDC.
 *
 * On Android Chrome the only adapter is the Mobile Wallet Adapter (MWA), the
 * bridge to the wallet apps on the phone (@solana-mobile/wallet-adapter-mobile
 * 2.2.8, added by wallet-adapter-react when no extension is injected). It
 * differs from the desktop adapters in three ways this module absorbs:
 *  - connect() and autoConnect() return before the wallet has answered: they
 *    start the connect and drop its promise (lib/esm/index.browser.js:89-94;
 *    unfixed upstream, solana-mobile/mobile-wallet-adapter PR #1660).
 *  - signTransaction serializes what it is given with web3.js defaults, so a
 *    legacy Transaction with an empty signature slot throws before the wallet
 *    is asked (index.browser.js:246). A VersionedTransaction carries the same
 *    bytes and serializes without that check.
 *  - every call switches the user to the wallet app, and Chrome allows one
 *    such launch per tap (Chromium components/external_intents/README:
 *    "repeatedly attempting to launch apps with the same user activation" is
 *    blocked). A connect that opened the app ends the tap; the signature waits
 *    for the next one.
 */
import type { Adapter, SignerWalletAdapter } from "@solana/wallet-adapter-base";
import { Transaction, VersionedTransaction } from "@solana/web3.js";

/** SolanaMobileWalletAdapterWalletName in @solana-mobile/wallet-adapter-mobile (a transitive dependency; pinned in external-wallet.test.ts). */
export const MOBILE_WALLET_ADAPTER = "Mobile Wallet Adapter";
export const isMobileWalletAdapter = (adapter: { name: string }) => adapter.name === MOBILE_WALLET_ADAPTER;

/** What a row or button calls the wallet. The phone's wallet app has no name of its own until it answers; Solana Mobile's UX guideline asks for this text. */
export const walletLabel = (adapter: { name: string }) => (isMobileWalletAdapter(adapter) ? "Use Installed Wallet" : adapter.name);

/** How long a wallet gets to answer a connect or a signature. */
export const WALLET_WAIT_MS = 60_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Connect, and come back only when the wallet has its key or has given up.
 * `silent` asks without a window or an app switch (a site the wallet trusts,
 * or the phone wallet's cached authorization) and comes back false otherwise.
 * A refusal the wallet reports is thrown, as the adapter emitted it.
 * Connected AND a key: the phone adapter keeps a stale key after the wallet
 * itself let go (a failed reauthorization), with connected false.
 */
const ready = (adapter: Adapter) => adapter.connected && !!adapter.publicKey;

export async function connectAdapter(adapter: Adapter, { silent = false } = {}): Promise<boolean> {
  if (ready(adapter)) return true;
  let refused: unknown;
  const onError = (error: unknown) => { refused = error; };
  adapter.on("error", onError);
  try {
    await (silent ? adapter.autoConnect() : adapter.connect());
    // A desktop adapter is done here. The Mobile Wallet Adapter is still at it
    // (connecting), or connected without its key for a moment more.
    for (let waited = 0; !ready(adapter) && refused === undefined && (adapter.connecting || adapter.connected) && waited < WALLET_WAIT_MS; waited += 100) {
      await sleep(100);
    }
  } finally {
    adapter.off("error", onError);
  }
  if (refused !== undefined) throw refused;
  return ready(adapter);
}

export const fromBase64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
export const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

/**
 * The wallet's signature on a server-built transaction, base64 in and out.
 * The bytes go in unchanged as a VersionedTransaction (a legacy message stays
 * legacy); the wallet sees exactly what the server built, whatever it returns.
 */
export async function signWithAdapter(adapter: SignerWalletAdapter, transaction: string): Promise<string> {
  return toWire(await adapter.signTransaction(VersionedTransaction.deserialize(fromBase64(transaction))));
}

/**
 * Several at once, in order, in ONE wallet prompt (an intent order signs one
 * payment per image, 2026-10-18). A wallet without its own batch signing gets
 * them one by one from the adapter base class.
 */
export async function signAllWithAdapter(adapter: SignerWalletAdapter, transactions: string[]): Promise<string[]> {
  if (transactions.length === 1) return [await signWithAdapter(adapter, transactions[0])];
  const signed = await adapter.signAllTransactions(transactions.map((t) => VersionedTransaction.deserialize(fromBase64(t))));
  return signed.map(toWire);
}

const toWire = (signed: VersionedTransaction | Transaction) =>
  toBase64("version" in signed ? signed.serialize() : signed.serialize({ requireAllSignatures: false }));

/**
 * The Mobile Wallet Adapter's own dialogs (the local-network permission,
 * "Connect Wallet", "We can't find a wallet") are hosts it appends to <body>
 * with a closed shadow root (wallet-standard-mobile 0.5.2 EmbeddedModal
 * #injectHTML: a fonts <link> in the host, or --spinner-color on it). A modal
 * of ours takes the page's pointer events (Radix) and would count a tap in
 * them as a tap outside.
 */
export function isMobileWalletDialog(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.parentElement === document.body
    && (target.querySelector('link[href*="Inter+Tight"]') !== null || target.style.getPropertyValue("--spinner-color") !== "");
}
/** Keeps those dialogs tappable while a modal of ours is open. */
export const MOBILE_WALLET_DIALOG_CSS = 'body > div:has(> link[href*="Inter+Tight"]), body > div[style*="--spinner-color"] { pointer-events: auto; }';
