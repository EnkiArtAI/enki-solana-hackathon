import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair, SystemProgram, Transaction, VersionedTransaction } from "@solana/web3.js";
import { EventEmitter, type Adapter, type SignerWalletAdapter } from "@solana/wallet-adapter-base";
import { readSource } from "./_read-source";
import { androidGlobals, mobileWalletApp } from "./_mwa";
import {
  connectAdapter, fromBase64, isMobileWalletAdapter, MOBILE_WALLET_ADAPTER, MOBILE_WALLET_DIALOG_CSS, signWithAdapter, toBase64, walletLabel,
} from "@/lib/ui/kit/external-wallet";

/**
 * Android Chrome gets one external wallet, the Mobile Wallet Adapter, and with
 * it nothing worked (2026-10-16): the login picker read the key before the app
 * had opened, the payment refused every deposit, Send USDC threw before the
 * app was asked. The helper here is what every surface goes through now; the
 * tests drive the REAL adapter class over a fake wallet app (_mwa.ts).
 */
const ROOT = join(__dirname, "..", "..");
const lib = (...p: string[]) => readFileSync(join(ROOT, "node_modules", ...p), "utf8");
const src = (...p: string[]) => readSource(join(ROOT, ...p));

const feePayer = Keypair.generate();
const buyer = Keypair.generate();

/** The escrow deposit as the server builds it: both signature slots empty. */
function deposit(): string {
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: buyer.publicKey, toPubkey: feePayer.publicKey, lamports: 1 }));
  tx.recentBlockhash = Keypair.generate().publicKey.toBase58();
  tx.feePayer = feePayer.publicKey;
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
}
const buyerSigned = (b64: string) =>
  Transaction.from(Buffer.from(b64, "base64")).signatures.find((s) => s.publicKey.equals(buyer.publicKey))?.signature !== null;

/** A desktop adapter (Wallet Standard: Phantom, Solflare): connect() comes back connected, the key on the adapter. */
function desktop(key: Keypair, { trusted = false } = {}) {
  const calls: string[] = [];
  const a = {
    name: "Phantom", connected: false, connecting: false, publicKey: null as Keypair["publicKey"] | null,
    on: () => undefined, off: () => undefined,
    connect: async () => { calls.push("connect"); a.connected = true; a.publicKey = key.publicKey; },
    autoConnect: async () => { calls.push("autoConnect"); if (!trusted) throw new Error("User rejected the request."); a.connected = true; a.publicKey = key.publicKey; },
    signTransaction: async (tx: VersionedTransaction) => { calls.push("sign"); tx.sign([key]); return tx; },
  };
  return { adapter: a as unknown as Adapter, calls };
}

describe("the library the fix is written against (re-check these on an upgrade)", () => {
  const adapterLib = lib("@solana-mobile", "wallet-adapter-mobile", "lib", "esm", "index.browser.js");
  const walletLib = lib("@solana-mobile", "wallet-standard-mobile", "lib", "esm", "index.browser.js");

  it("connect() and autoConnect() drop their promise", () => {
    expect(adapterLib).toContain("async autoConnect() {\n\t\tthis.#connect(true);\n\t}");
    expect(adapterLib).toContain("async connect() {\n\t\tthis.#connect();\n\t}");
  });

  it("signs what it is given, serialized with web3.js defaults", () => {
    expect(adapterLib).toContain("transaction: value.serialize()");
  });

  it("is named as the helper expects, and mounts its dialogs as the helper finds them", () => {
    expect(walletLib).toContain(`const SolanaMobileWalletAdapterWalletName = "${MOBILE_WALLET_ADAPTER}";`);
    expect(walletLib).toContain("host.innerHTML = fonts;");
    expect(walletLib).toContain('host.style.setProperty("--spinner-color", "#FFFFFF");');
    expect(walletLib).toContain("family=Inter+Tight");
    expect(walletLib).toContain("document.body.appendChild(host);");
    expect(MOBILE_WALLET_DIALOG_CSS).toBe('body > div:has(> link[href*="Inter+Tight"]), body > div[style*="--spinner-color"] { pointer-events: auto; }');
  });
});

describe("names", () => {
  it("knows the phone's adapter and calls it what Solana Mobile asks for", () => {
    expect(isMobileWalletAdapter({ name: "Mobile Wallet Adapter" })).toBe(true);
    expect(isMobileWalletAdapter({ name: "Phantom" })).toBe(false);
    expect(walletLabel({ name: "Mobile Wallet Adapter" })).toBe("Use Installed Wallet");
    expect(walletLabel({ name: "Solflare" })).toBe("Solflare");
  });
});

describe("connectAdapter with the phone's wallet app", () => {
  let restore: () => void;
  beforeEach(() => { restore = androidGlobals(); });
  afterEach(() => restore());

  it("comes back only when the key is there (the adapter's connect() came back at once)", async () => {
    const phone = mobileWalletApp(buyer);
    const early = phone.adapter.connect().then(() => phone.adapter.publicKey);
    expect(await early).toBeNull();
    const fresh = mobileWalletApp(buyer);
    expect(await connectAdapter(fresh.adapter)).toBe(true);
    expect(fresh.adapter.publicKey?.toBase58()).toBe(buyer.publicKey.toBase58());
    expect(fresh.calls.connect).toEqual([{ silent: false }]);
  });

  it("silent: answers from the cached authorization without opening the app, else comes back false", async () => {
    const cached = mobileWalletApp(buyer, { cached: true });
    expect(await connectAdapter(cached.adapter, { silent: true })).toBe(true);
    expect(cached.calls.connect).toEqual([{ silent: true }]);
    const fresh = mobileWalletApp(buyer);
    expect(await connectAdapter(fresh.adapter, { silent: true })).toBe(false);
    expect(fresh.calls.connect).toEqual([{ silent: true }]);
    expect(fresh.adapter.connected).toBe(false);
  });

  it("throws the wallet's refusal, as the adapter emitted it, instead of waiting for a key that never comes", async () => {
    // Shaped like the phone adapter on a decline: connect() is back at once, the
    // refusal arrives as the 'error' event (and as a rejection nobody can reach).
    const a = Object.assign(new EventEmitter(), {
      name: "Mobile Wallet Adapter", connected: false, connecting: false, publicKey: null,
      connect: async () => {
        a.connecting = true;
        setTimeout(() => { a.connecting = false; a.emit("error", new Error("authorization request declined")); }, 30);
      },
    });
    await expect(connectAdapter(a as unknown as Adapter)).rejects.toThrow("authorization request declined");
    expect(a.listenerCount("error")).toBe(0);
  });

  it("connects again when the wallet let go but the adapter kept the key (a failed reauthorization)", async () => {
    const phone = mobileWalletApp(buyer, { cached: true });
    await connectAdapter(phone.adapter, { silent: true });
    phone.app.connected = phone.app.isAuthorized = false;
    expect(phone.adapter.publicKey).not.toBeNull();
    expect(await connectAdapter(phone.adapter)).toBe(true);
    expect(phone.calls.connect).toEqual([{ silent: true }, { silent: false }]);
  });

  it("asks nothing of a wallet that has its key", async () => {
    const phone = mobileWalletApp(buyer, { cached: true });
    await connectAdapter(phone.adapter, { silent: true });
    expect(await connectAdapter(phone.adapter)).toBe(true);
    expect(phone.calls.connect).toHaveLength(1);
  });
});

describe("connectAdapter with a desktop wallet", () => {
  it("is the plain connect: back as soon as it resolves, the key on the adapter", async () => {
    const { adapter, calls } = desktop(buyer);
    expect(await connectAdapter(adapter)).toBe(true);
    expect(calls).toEqual(["connect"]);
  });

  it("silent: the trusted site connects without a window, any other refusal is thrown", async () => {
    const trusted = desktop(buyer, { trusted: true });
    expect(await connectAdapter(trusted.adapter, { silent: true })).toBe(true);
    expect(trusted.calls).toEqual(["autoConnect"]);
    await expect(connectAdapter(desktop(buyer).adapter, { silent: true })).rejects.toThrow("User rejected the request.");
  });
});

describe("signWithAdapter", () => {
  let restore: () => void;
  beforeEach(() => { restore = androidGlobals(); });
  afterEach(() => restore());

  it("hands the server's bytes over unchanged: a legacy deposit with empty slots, through VersionedTransaction", () => {
    const b64 = deposit();
    expect(toBase64(VersionedTransaction.deserialize(fromBase64(b64)).serialize())).toBe(b64);
  });

  it("the phone's wallet app signs the deposit it was refused before (legacy serialize threw on the empty slot)", async () => {
    const phone = mobileWalletApp(buyer, { cached: true });
    await connectAdapter(phone.adapter, { silent: true });
    const b64 = deposit();
    await expect(Promise.resolve().then(() => Transaction.from(fromBase64(b64)).serialize())).rejects.toThrow(/Signature verification failed/);
    const signed = await signWithAdapter(phone.adapter as SignerWalletAdapter, b64);
    expect(toBase64(phone.calls.signed[0])).toBe(b64);
    expect(buyerSigned(signed)).toBe(true);
  });

  it("a desktop wallet, which answers with a VersionedTransaction, is serialized the same way", async () => {
    const { adapter, calls } = desktop(buyer);
    await connectAdapter(adapter);
    const signed = await signWithAdapter(adapter as SignerWalletAdapter, deposit());
    expect(calls).toEqual(["connect", "sign"]);
    expect(buyerSigned(signed)).toBe(true);
  });
});

describe("every surface goes through the helper", () => {
  it("the payment signer: silent first, the prompting connect ends a phone tap, the signature through the helper", () => {
    const s = src("hooks", "usePaymentSigner.ts");
    expect(s).toContain("if (!adapter.connected) await connectAdapter(adapter, { silent: true }).catch(() => undefined);");
    expect(s).toContain("const prompted = !adapter.connected;\n  if (prompted) await connectAdapter(adapter);");
    expect(s).toContain('const tapAgain = () => new CheckoutError("sign", "Your wallet is connected. Tap again to sign — nothing was charged.");');
    expect(s).toContain("if (prompted && isMobileWalletAdapter(adapter)) throw tapAgain();");
    expect(s).toContain("if ((await inTime(connectFirst(adapter))) && isMobileWalletAdapter(adapter)) throw tapAgain();");
    // The hook hands the connect step to the checkout (verification 2026-10-18).
    expect(s).toContain("{ prepare: () => prepareForBuyer({ adapter, cdpAddress: getCdpSolanaAddress() }) },");
    expect(s).toContain("return signAllWithAdapter(adapter, transactions);");
    expect(s).not.toContain("adapter.connect()");
    expect(s).not.toContain("adapter.signTransaction(");
    expect(s).not.toContain("adapter.signAllTransactions(");
  });

  it("the login picker: waits for the key, stops a phone tap after the connect, never signIn on the phone, keeps its dialogs tappable", () => {
    const s = src("components", "WalletPickerModal.tsx");
    expect(s).toContain("const wasConnected = adapter.connected;\n      if (!wasConnected) await connectAdapter(adapter);");
    expect(s).toContain("if (!wasConnected && isMobileWalletAdapter(adapter)) { setReadyToSign(name); return; }");
    expect(s).toContain('if (typeof capable.signIn === "function" && !isMobileWalletAdapter(adapter)) {');
    expect(s).toContain("onInteractOutside={(e) => { if (isMobileWalletDialog(e.detail.originalEvent.target)) e.preventDefault(); }}");
    expect(s).toContain("${MOBILE_WALLET_DIALOG_CSS}");
    expect(s).toContain("label: walletLabel(w.adapter),");
    expect(s).toContain("readyToSign === w.name ? (");
    expect(s).not.toContain("await adapter.connect()");
  });

  it("linking: the client waits for the key; the buttons take two taps on the phone and let the wallet go after", () => {
    expect(src("components", "settings", "link-wallet.ts")).toContain("if (!wasConnected) await connectAdapter(adapter);");
    const b = src("components", "settings", "LinkWalletButtons.tsx");
    expect(b).toContain("if (phone && !adapter.connected) {");
    expect(b).toContain("setReadyToSign(adapter.name);");
    expect(b).toContain("await linkWallet(adapter);");
    expect(b).toContain("if (readyToSign === adapter.name) { setReadyToSign(null); await adapter.disconnect().catch(() => {  }); }");
    expect(b).toContain('{readyToSign === a.name ? "Sign to link" : `Link ${walletLabel(a)}`}');
  });

  it("Send USDC: connects the remembered wallet inside the tap, stops a phone tap after the connect, signs through the helper", () => {
    const s = src("components", "settings", "SendUsdcPanel.tsx");
    expect(s).toContain("await connectAdapter(adapter).catch(() => undefined);");
    expect(s).toContain('if (adapter.connected && isMobileWalletAdapter(adapter)) { setError({ text: "Your wallet is connected. Tap Send again to sign.", explorer: null }); return; }');
    expect(s).toContain("return (b64) => signWithAdapter(adapter, b64);");
    expect(s).not.toContain("Transaction.from(");
  });
});
