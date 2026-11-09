import { afterEach, beforeEach, describe, it, expect, vi, type Mock } from "vitest";
import { Keypair, SystemProgram, Transaction, VersionedTransaction } from "@solana/web3.js";
import type { Adapter } from "@solana/wallet-adapter-base";
import { androidGlobals, mobileWalletApp } from "./_mwa";

/**
 * The intent rail signs with the wallet the payment is FOR. Before this, the
 * checkout called CDP unconditionally, so every external-wallet buyer
 * (Phantom, Solflare: all 16 live wallets on 2026-10-02) could not pay.
 * The transactions here are real web3.js transactions, partial-signed by a
 * fee payer exactly as lib/payments/authorize-tx.ts does it.
 */

const cdpSign = vi.hoisted(() => vi.fn());
vi.mock("@/lib/cdp-bridge", () => ({ requestCdpSign: cdpSign, getCdpSolanaAddress: () => null }));

import { buyerOf, prepareForBuyer, signForBuyer } from "@/hooks/usePaymentSigner";
import { CheckoutError } from "@/lib/generation-checkout";

/** One transaction, the way the escrow deposit is signed: a list of one. */
const signOne = async (tx: string, on: Parameters<typeof signForBuyer>[1]) => (await signForBuyer([tx], on))[0];

const feePayer = Keypair.generate();
const buyer = Keypair.generate();
const stranger = Keypair.generate();

function authorization(from: Keypair = buyer): string {
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: stranger.publicKey, lamports: 1 }),
  );
  tx.recentBlockhash = Keypair.generate().publicKey.toBase58();
  tx.feePayer = feePayer.publicKey;
  tx.partialSign(feePayer);
  return tx.serialize({ requireAllSignatures: false }).toString("base64");
}

/**
 * A wallet-adapter stand-in holding `key`, disconnected like after a reload.
 * It behaves like the Wallet Standard adapter every detected wallet gets
 * (Phantom, Solflare, Backpack): signTransaction is on the adapter only while
 * an account is connected (@solana/wallet-standard-wallet-adapter-base, #reset).
 * `signs: false` is a wallet that cannot sign transactions at all.
 * autoConnect is the silent connect: it never opens a window, so it connects
 * only a site the wallet trusts and refuses any other (`trusted`).
 */
function wallet(key: Keypair, { signs = true, trusted = false } = {}) {
  // Signs the way a Wallet Standard adapter answers: the VersionedTransaction it was handed.
  const sign = vi.fn(async (tx: VersionedTransaction) => {
    tx.sign([key]);
    return tx;
  });
  // Several in one window, as the Standard adapter sets it next to signTransaction.
  const signAll = vi.fn(async (txs: VersionedTransaction[]) => txs.map((tx) => (tx.sign([key]), tx)));
  const open = async () => {
    w.connected = true;
    w.publicKey = key.publicKey;
    if (signs) { w.signTransaction = sign; w.signAllTransactions = signAll; }
  };
  const w: {
    connected: boolean; publicKey: Keypair["publicKey"] | null; sign: typeof sign; signAll: typeof signAll;
    connect: Mock<() => Promise<void>>; autoConnect: Mock<() => Promise<void>>; signTransaction?: typeof sign;
    signAllTransactions?: typeof signAll; on: () => void; off: () => void;
  } = {
    connected: false,
    publicKey: null,
    sign,
    signAll,
    on: () => undefined,
    off: () => undefined,
    connect: vi.fn(open),
    autoConnect: vi.fn(async () => {
      if (!trusted) throw new Error("WalletConnectionError: not trusted");
      await open();
    }),
  };
  return w;
}
const asAdapter = (w: ReturnType<typeof wallet>) => w as unknown as Adapter;

/** The escrow deposit as /api/payments/generation/authorize returns it: the
 *  operator is the fee payer and has NOT signed yet (it co-signs on submit). */
function escrowDeposit(): string {
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: buyer.publicKey, toPubkey: stranger.publicKey, lamports: 1 }),
  );
  tx.recentBlockhash = Keypair.generate().publicKey.toBase58();
  tx.feePayer = feePayer.publicKey;
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
}

describe("buyerOf", () => {
  it("names the one signer the fee payer left unsigned", () => {
    expect(buyerOf(authorization())).toBe(buyer.publicKey.toBase58());
  });

  it("skips the unsigned fee payer of an escrow deposit (found on devnet 2026-10-13)", () => {
    // Both slots empty, fee payer first: the old rule named the operator and
    // every browser wallet refused with "this payment is for the wallet you signed in with".
    expect(buyerOf(escrowDeposit())).toBe(buyer.publicKey.toBase58());
  });

  it("signs the escrow deposit with the buyer's external wallet", async () => {
    const phantom = wallet(buyer);
    const signed = await signOne(escrowDeposit(), { adapter: asAdapter(phantom), cdpAddress: null });
    const tx = Transaction.from(Buffer.from(signed, "base64"));
    expect(tx.signatures.find((s) => s.publicKey.equals(buyer.publicKey))?.signature).not.toBeNull();
    expect(tx.signatures.find((s) => s.publicKey.equals(feePayer.publicKey))?.signature).toBeNull();
  });
});

describe("signForBuyer", () => {
  it("an external wallet holding the buyer key connects and signs, CDP is never asked", async () => {
    cdpSign.mockReset();
    const phantom = wallet(buyer);
    const signed = await signOne(authorization(), { adapter: asAdapter(phantom), cdpAddress: null });
    expect(phantom.connect).toHaveBeenCalledTimes(1);
    expect(cdpSign).not.toHaveBeenCalled();
    // Fee payer's signature survived and the buyer's is valid over the message.
    expect(Transaction.from(Buffer.from(signed, "base64")).verifySignatures()).toBe(true);
  });

  it("an embedded buyer signs through CDP even while a foreign Phantom is connected", async () => {
    cdpSign.mockReset();
    cdpSign.mockResolvedValue("signed-by-cdp");
    const phantom = wallet(stranger);
    const tx = authorization();
    expect(await signOne(tx, { adapter: asAdapter(phantom), cdpAddress: buyer.publicKey.toBase58() })).toBe(
      "signed-by-cdp",
    );
    expect(cdpSign).toHaveBeenCalledWith(tx);
    expect(phantom.connect).not.toHaveBeenCalled();
    expect(phantom.sign).not.toHaveBeenCalled();
  });

  it("after a reload the wallet is connected first, then asked to sign (Kev's first browser payment, 2026-10-13)", async () => {
    // Not connected yet, so the adapter has no signTransaction: the old order
    // looked for it before connecting and refused without ever asking the wallet.
    const phantom = wallet(buyer);
    expect("signTransaction" in phantom).toBe(false);
    const signed = await signOne(escrowDeposit(), { adapter: asAdapter(phantom), cdpAddress: null });
    expect(phantom.connect).toHaveBeenCalledTimes(1);
    expect(phantom.sign).toHaveBeenCalledTimes(1);
    expect(Transaction.from(Buffer.from(signed, "base64")).signatures.find((s) => s.publicKey.equals(buyer.publicKey))?.signature).not.toBeNull();
  });

  it("a wallet already connected is not connected a second time", async () => {
    const phantom = wallet(buyer);
    await phantom.connect();
    phantom.connect.mockClear();
    await signOne(escrowDeposit(), { adapter: asAdapter(phantom), cdpAddress: null });
    expect(phantom.connect).not.toHaveBeenCalled();
    expect(phantom.autoConnect).not.toHaveBeenCalled();
    expect(phantom.sign).toHaveBeenCalledTimes(1);
  });

  it("a wallet that cannot sign transactions is a refusal, even with the buyer's key", async () => {
    const readOnly = wallet(buyer, { signs: false });
    const err = await signOne(escrowDeposit(), { adapter: asAdapter(readOnly), cdpAddress: null }).catch((e) => e);
    expect(err).toBeInstanceOf(CheckoutError);
    expect(readOnly.sign).not.toHaveBeenCalled();
  });

  it("a wallet holding another key is never asked to sign", async () => {
    cdpSign.mockReset();
    const phantom = wallet(stranger);
    const err = await signOne(authorization(), {
      adapter: asAdapter(phantom),
      cdpAddress: stranger.publicKey.toBase58(),
    }).catch((e) => e);
    expect(err).toBeInstanceOf(CheckoutError);
    expect(err.step).toBe("sign");
    expect(err.message).toMatch(/nothing was charged/);
    expect(phantom.sign).not.toHaveBeenCalled();
    expect(cdpSign).not.toHaveBeenCalled();
  });

  it("no wallet at all is a refusal, not a hang", async () => {
    await expect(signOne(authorization(), { adapter: null, cdpAddress: null })).rejects.toBeInstanceOf(
      CheckoutError,
    );
  });
});

describe("a wallet that trusts the site (Kev, 2026-10-15)", () => {
  it("connects silently and signs, without the connect window", async () => {
    const solflare = wallet(buyer, { trusted: true });
    const signed = await signOne(escrowDeposit(), { adapter: asAdapter(solflare), cdpAddress: null });
    expect(solflare.autoConnect).toHaveBeenCalledTimes(1);
    expect(solflare.connect).not.toHaveBeenCalled();
    expect(Transaction.from(Buffer.from(signed, "base64")).signatures.find((s) => s.publicKey.equals(buyer.publicKey))?.signature).not.toBeNull();
  });

  it("a site it does not trust yet gets the connect window after the silent try", async () => {
    const solflare = wallet(buyer);
    await signOne(escrowDeposit(), { adapter: asAdapter(solflare), cdpAddress: null });
    expect(solflare.autoConnect).toHaveBeenCalledTimes(1);
    expect(solflare.connect).toHaveBeenCalledTimes(1);
    expect(solflare.autoConnect.mock.invocationCallOrder[0]).toBeLessThan(solflare.connect.mock.invocationCallOrder[0]);
    expect(solflare.sign).toHaveBeenCalledTimes(1);
  });
});

describe("a wallet that never answers (Solflare on Colosseum, 2026-10-15)", () => {
  afterEach(() => vi.useRealTimers());
  const silence = () => new Promise<never>(() => {});

  async function after(ms: number, signing: Promise<string>) {
    const settled = signing.then((v) => ({ v }), (e: unknown) => ({ e }));
    await vi.advanceTimersByTimeAsync(ms);
    return Promise.race([settled, Promise.resolve("pending" as const)]);
  }

  it("is a refusal after 60 seconds, not a hang: connect window never opened", async () => {
    vi.useFakeTimers();
    const solflare = wallet(buyer);
    solflare.connect.mockImplementation(silence);
    const signing = signOne(escrowDeposit(), { adapter: asAdapter(solflare), cdpAddress: null });
    expect(await after(59_999, signing)).toBe("pending");
    const out = await after(1, signing);
    expect(out).toHaveProperty("e");
    const err = (out as { e: CheckoutError }).e;
    expect(err).toBeInstanceOf(CheckoutError);
    expect(err.step).toBe("sign");
    expect(err.message).toBe("Your wallet didn't answer. Open it and try again — nothing was charged.");
  });

  it("is a refusal after 60 seconds, not a hang: signature window never answered", async () => {
    vi.useFakeTimers();
    const solflare = wallet(buyer, { trusted: true });
    solflare.sign.mockImplementation(silence);
    const signing = signOne(escrowDeposit(), { adapter: asAdapter(solflare), cdpAddress: null });
    expect(await after(59_999, signing)).toBe("pending");
    expect(await after(1, signing)).toHaveProperty("e.message", "Your wallet didn't answer. Open it and try again — nothing was charged.");
  });

  it("a wallet that answers in time signs, and leaves no timer behind", async () => {
    vi.useFakeTimers();
    const solflare = wallet(buyer);
    solflare.sign.mockImplementation((tx: VersionedTransaction) => new Promise((done) => setTimeout(() => done((tx.sign([buyer]), tx)), 59_000)));
    const signing = signOne(escrowDeposit(), { adapter: asAdapter(solflare), cdpAddress: null });
    expect(await after(59_000, signing)).toHaveProperty("v");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("the phone's wallet app (Mobile Wallet Adapter, Android Chrome)", () => {
  let restore: () => void;
  beforeEach(() => { restore = androidGlobals(); });
  afterEach(() => restore());

  it("after a reload, with its authorization cached: connects without opening the app, then signs", async () => {
    const phone = mobileWalletApp(buyer, { cached: true });
    const signed = await signOne(escrowDeposit(), { adapter: phone.adapter, cdpAddress: null });
    expect(phone.calls.connect).toEqual([{ silent: true }]);
    expect(Transaction.from(Buffer.from(signed, "base64")).signatures.find((s) => s.publicKey.equals(buyer.publicKey))?.signature).not.toBeNull();
  });

  it("after a reload, without: the app opens to connect, and the signature waits for the next tap", async () => {
    const phone = mobileWalletApp(buyer);
    const tx = escrowDeposit();
    const err = await signOne(tx, { adapter: phone.adapter, cdpAddress: null }).catch((e) => e);
    expect(err).toBeInstanceOf(CheckoutError);
    expect(err.message).toBe("Your wallet is connected. Tap again to sign — nothing was charged.");
    expect(phone.calls.connect).toEqual([{ silent: true }, { silent: false }]);
    expect(phone.calls.signed).toHaveLength(0);
    // The next tap finds it connected and signs.
    await signOne(tx, { adapter: phone.adapter, cdpAddress: null });
    expect(phone.calls.connect).toHaveLength(2);
    expect(phone.calls.signed).toHaveLength(1);
  });

  it("signs the server's bytes unchanged, both slots empty (the legacy path threw before the app was asked)", async () => {
    const phone = mobileWalletApp(buyer, { cached: true });
    const tx = escrowDeposit();
    await signOne(tx, { adapter: phone.adapter, cdpAddress: null });
    expect(Buffer.from(phone.calls.signed[0]).toString("base64")).toBe(tx);
  });
});

describe("an intent order: one payment per image, one wallet prompt (2026-10-18)", () => {
  const blockhashOf = (wire: string) => Transaction.from(Buffer.from(wire, "base64")).recentBlockhash;

  it("an external wallet signs every unit in one window, in order", async () => {
    const phantom = wallet(buyer);
    const txs = [authorization(), authorization(), authorization()];
    const signed = await signForBuyer(txs, { adapter: asAdapter(phantom), cdpAddress: null });
    expect(phantom.signAll).toHaveBeenCalledTimes(1);
    expect(phantom.sign).not.toHaveBeenCalled();
    expect(signed.map(blockhashOf)).toEqual(txs.map(blockhashOf));
    for (const wire of signed) expect(Transaction.from(Buffer.from(wire, "base64")).verifySignatures()).toBe(true);
  });

  it("the embedded wallet signs them one after another", async () => {
    cdpSign.mockReset();
    const txs = [authorization(), authorization()];
    cdpSign.mockImplementation(async (tx: string) => `cdp-${txs.indexOf(tx)}`);
    expect(await signForBuyer(txs, { adapter: null, cdpAddress: buyer.publicKey.toBase58() })).toEqual(["cdp-0", "cdp-1"]);
    expect(cdpSign.mock.calls.map((call) => call[0])).toEqual(txs);
  });

  it("a list that names two buyers, or none, is signed by nobody", async () => {
    cdpSign.mockReset();
    const phantom = wallet(buyer);
    const on = { adapter: asAdapter(phantom), cdpAddress: buyer.publicKey.toBase58() };
    await expect(signForBuyer([authorization(), authorization(stranger)], on)).rejects.toBeInstanceOf(CheckoutError);
    await expect(signForBuyer([], on)).rejects.toBeInstanceOf(CheckoutError);
    expect(phantom.connect).not.toHaveBeenCalled(); expect(phantom.signAll).not.toHaveBeenCalled(); expect(cdpSign).not.toHaveBeenCalled();
  });

  describe("on the phone's wallet app", () => {
    let restore: () => void;
    beforeEach(() => { restore = androidGlobals(); });
    afterEach(() => restore());

    it("signs every unit's bytes unchanged in one session", async () => {
      const phone = mobileWalletApp(buyer, { cached: true });
      const txs = [escrowDeposit(), escrowDeposit()];
      const signed = await signForBuyer(txs, { adapter: phone.adapter, cdpAddress: null });
      expect(phone.calls.signed.map((bytes) => Buffer.from(bytes).toString("base64"))).toEqual(txs);
      expect(signed.map(blockhashOf)).toEqual(txs.map(blockhashOf));
    });
  });
});

describe("connecting before an order is opened (verification 2026-10-18)", () => {
  it("leaves the embedded wallet and a missing adapter alone", async () => {
    const phantom = wallet(buyer);
    await prepareForBuyer({ adapter: asAdapter(phantom), cdpAddress: buyer.publicKey.toBase58() });
    await prepareForBuyer({ adapter: null, cdpAddress: null });
    expect(phantom.connect).not.toHaveBeenCalled(); expect(phantom.autoConnect).not.toHaveBeenCalled();
  });

  it("connects a desktop wallet, silently first, and lets the order go on", async () => {
    const solflare = wallet(buyer);
    await expect(prepareForBuyer({ adapter: asAdapter(solflare), cdpAddress: null })).resolves.toBeUndefined();
    expect(solflare.autoConnect).toHaveBeenCalledTimes(1); expect(solflare.connect).toHaveBeenCalledTimes(1);
    // The signature then needs no second connect.
    await signForBuyer([escrowDeposit()], { adapter: asAdapter(solflare), cdpAddress: null });
    expect(solflare.connect).toHaveBeenCalledTimes(1);
  });

  describe("on the phone's wallet app", () => {
    let restore: () => void;
    beforeEach(() => { restore = androidGlobals(); });
    afterEach(() => restore());

    it("spends a first tap on the connect and says tap again, before anything is opened", async () => {
      const phone = mobileWalletApp(buyer);
      const err = await prepareForBuyer({ adapter: phone.adapter, cdpAddress: null }).catch((e) => e);
      expect(err).toBeInstanceOf(CheckoutError);
      expect(err.message).toBe("Your wallet is connected. Tap again to sign — nothing was charged.");
      // The next tap finds it connected: prepare passes and the signature goes through.
      await expect(prepareForBuyer({ adapter: phone.adapter, cdpAddress: null })).resolves.toBeUndefined();
      await signForBuyer([escrowDeposit()], { adapter: phone.adapter, cdpAddress: null });
      expect(phone.calls.signed).toHaveLength(1);
    });

    it("passes at once when the app's authorization is cached", async () => {
      const phone = mobileWalletApp(buyer, { cached: true });
      await expect(prepareForBuyer({ adapter: phone.adapter, cdpAddress: null })).resolves.toBeUndefined();
    });
  });
});
