import { vi } from "vitest";
import { Keypair, Transaction } from "@solana/web3.js";
import { ed25519 } from "@noble/curves/ed25519";
import type { Adapter } from "@solana/wallet-adapter-base";
import { LocalSolanaMobileWalletAdapter, createDefaultAddressSelector } from "@solana-mobile/wallet-adapter-mobile";

/**
 * The phone's wallet, as Android Chrome gets it: the REAL Mobile Wallet Adapter
 * class (@solana-mobile/wallet-adapter-mobile, the one wallet-adapter-react
 * builds) over a stand-in for the wallet app behind it. Only the app is faked.
 * It answers the way wallet-standard-mobile's wallet does as far as the adapter
 * can see: a silent connect answers from its cache or not at all, a prompting
 * one opens the app (after `latencyMs`), every signature is a visit to the app.
 */
export type WalletCalls = { connect: { silent: boolean }[]; signed: Uint8Array[]; messages: Uint8Array[] };

export function mobileWalletApp(key: Keypair, { cached = false, latencyMs = 20, signs = true } = {}) {
  const calls: WalletCalls = { connect: [], signed: [], messages: [] };
  const listeners: ((p: { accounts: unknown[] }) => void)[] = [];
  const account = {
    address: key.publicKey.toBase58(), publicKey: key.publicKey.toBytes(), chains: ["solana:devnet"],
    features: ["solana:signTransaction", "solana:signMessage"],
  };
  const app = {
    name: "Mobile Wallet Adapter", icon: "data:,", url: "https://solanamobile.com",
    connected: false, isAuthorized: false, accounts: [] as unknown[], currentAuthorization: { chain: "solana:devnet" },
    features: {
      "standard:connect": {
        connect: async (input?: { silent?: boolean }) => {
          calls.connect.push({ silent: input?.silent === true });
          await new Promise((r) => setTimeout(r, latencyMs));
          if (input?.silent && !cached) return { accounts: [] };
          app.connected = app.isAuthorized = true;
          app.accounts = [account];
          listeners.forEach((l) => l({ accounts: app.accounts }));
          return { accounts: app.accounts };
        },
      },
      "standard:events": { on: (_e: string, l: (p: { accounts: unknown[] }) => void) => { listeners.push(l); return () => {}; } },
      "standard:disconnect": {
        disconnect: async () => { app.connected = app.isAuthorized = false; app.accounts = []; listeners.forEach((l) => l({ accounts: [] })); },
      },
      "solana:signMessage": {
        signMessage: async (...inputs: { message: Uint8Array }[]) => inputs.map((i) => {
          calls.messages.push(i.message);
          return { signedMessage: i.message, signature: ed25519.sign(i.message, key.secretKey.slice(0, 32)) };
        }),
      },
      ...(signs ? {
        "solana:signTransaction": {
          signTransaction: async (...inputs: { transaction: Uint8Array }[]) => inputs.map((i) => {
            calls.signed.push(i.transaction);
            const tx = Transaction.from(i.transaction);
            tx.partialSign(key);
            return { signedTransaction: new Uint8Array(tx.serialize({ requireAllSignatures: false })) };
          }),
        },
      } : {}),
    },
  };
  // The base class is not exported: SolanaMobileWalletAdapter = Local… extends it. The config is the one WalletProvider passes.
  const Base = Object.getPrototypeOf(LocalSolanaMobileWalletAdapter) as new (wallet: unknown, config: unknown) => Adapter;
  const adapter = new Base(app, { addressSelector: createDefaultAddressSelector(), chain: "solana:devnet" });
  adapter.on("error", () => { /* the adapter emits every refusal; a listener keeps it off the console */ });
  return { adapter, app, calls };
}

const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";

/** Android Chrome's globals, as far as the adapter reads them (getIsSupported, fromUint8Array). Returns the undo. */
export function androidGlobals() {
  vi.stubGlobal("window", { isSecureContext: true, btoa: globalThis.btoa, location: { host: "enki.gallery", origin: "https://enki.gallery" } });
  vi.stubGlobal("document", {});
  vi.stubGlobal("navigator", { userAgent: ANDROID });
  return () => vi.unstubAllGlobals();
}
