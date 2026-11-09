import { describe, it, expect } from "vitest";
import {
  Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage,
  VersionedTransaction, MessageV0, Transaction, SendTransactionError,
} from "@solana/web3.js";
import bs58 from "bs58";
import {
  TOKEN_PROGRAM_ID, createTransferCheckedInstruction, getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { ComputeBudgetProgram } from "@solana/web3.js";
import type { Connection } from "@solana/web3.js";
import { parseXPayment, verifyAgentPayment, cosignAsFeePayer, submitAndConfirm, x402Network, paymentResponseHeader } from "@/lib/payments/x402-settle";

/**
 * Every reject rule in verifyAgentPayment guards the fee payer's key or the
 * platform's money, so every rule gets a transaction that violates exactly
 * it. All offline — the txs are real (web3.js-built and signed), the chain
 * is never involved.
 */

const feePayer = Keypair.generate();
const client = Keypair.generate();
const mintAuthority = Keypair.generate();
const mint = mintAuthority.publicKey; // any pubkey works as a mint offline
const payTo = Keypair.generate().publicKey;
const platformAta = getAssociatedTokenAddressSync(mint, payTo);
const clientAta = getAssociatedTokenAddressSync(mint, client.publicKey);
const BLOCKHASH = "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k";
const AMOUNT = 269_000;

const params = { legs: [{ owner: payTo, amountMicro: AMOUNT }], mint, feePayer: feePayer.publicKey };

function transferIx(over: { amount?: number | bigint; dest?: PublicKey; mint?: PublicKey; authority?: PublicKey; source?: PublicKey; decimals?: number } = {}) {
  return createTransferCheckedInstruction(
    over.source ?? clientAta,
    over.mint ?? mint,
    over.dest ?? platformAta,
    over.authority ?? client.publicKey,
    over.amount ?? AMOUNT,
    over.decimals ?? 6,
  );
}

function buildTx(instructions: TransactionInstruction[], opts: { payer?: PublicKey; sign?: boolean } = {}) {
  const msg = new TransactionMessage({
    payerKey: opts.payer ?? feePayer.publicKey,
    recentBlockhash: BLOCKHASH,
    instructions,
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  if (opts.sign !== false) tx.sign([client]);
  return tx;
}

const budget = () => [
  ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
  ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }),
];

describe("verifyAgentPayment", () => {
  it("accepts the canonical payment: budget + exact TransferChecked, client-signed", () => {
    const r = verifyAgentPayment(buildTx([...budget(), transferIx()]), params);
    expect(r).toEqual({ ok: true, payer: client.publicKey });
  });

  it("accepts a memo riding along", () => {
    const memo = new TransactionInstruction({
      programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
      keys: [], data: Buffer.from("nonce-1"),
    });
    expect(verifyAgentPayment(buildTx([...budget(), transferIx(), memo]), params).ok).toBe(true);
  });

  it("rejects a wrong amount — over and under — and says the price is now another (Kev, 2026-10-18: \"write the clear message\")", () => {
    for (const [amount, paid] of [[AMOUNT - 1, "0.268999"], [AMOUNT + 1, "0.269001"]] as const) {
      const r = verifyAgentPayment(buildTx([transferIx({ amount })]), params);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBe(`Your payment carries ${paid} USDC, but the price is now 0.269 USDC (it changed since your quote). Pay the new amount — nothing was charged.`);
    }
  });

  it("rejects a foreign mint", () => {
    const other = Keypair.generate().publicKey;
    const r = verifyAgentPayment(
      buildTx([transferIx({ mint: other, source: getAssociatedTokenAddressSync(other, client.publicKey), dest: getAssociatedTokenAddressSync(other, payTo) })]),
      params,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("USDC");
  });

  it("rejects a redirected destination", () => {
    const elsewhere = getAssociatedTokenAddressSync(mint, Keypair.generate().publicKey);
    const r = verifyAgentPayment(buildTx([transferIx({ dest: elsewhere })]), params);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("extra.legs");
  });

  it("rejects wrong decimals", () => {
    const r = verifyAgentPayment(buildTx([transferIx({ decimals: 5 })]), params);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("decimals");
  });

  it("rejects any unknown program — a system transfer smuggled in", () => {
    const smuggle = SystemProgram.transfer({ fromPubkey: client.publicKey, toPubkey: payTo, lamports: 1 });
    const r = verifyAgentPayment(buildTx([transferIx(), smuggle]), params);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("not accepted");
  });

  it("rejects a transfer beyond the required legs", () => {
    const r = verifyAgentPayment(buildTx([transferIx(), transferIx()]), params);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("extra.legs");
  });

  it("rejects the fee payer as transfer authority — its funds, our signature", () => {
    const tx = buildTx(
      [transferIx({ authority: feePayer.publicKey, source: getAssociatedTokenAddressSync(mint, feePayer.publicKey) })],
      { sign: false },
    );
    const r = verifyAgentPayment(tx, params);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("fee payer");
  });

  it("rejects the fee payer appearing in any instruction account", () => {
    const memoTouching = new TransactionInstruction({
      programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
      keys: [{ pubkey: feePayer.publicKey, isSigner: false, isWritable: false }],
      data: Buffer.from("x"),
    });
    const r = verifyAgentPayment(buildTx([transferIx(), memoTouching]), params);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("fee payer");
  });

  it("rejects a wrong fee payer at account 0", () => {
    const r = verifyAgentPayment(buildTx([transferIx()], { payer: client.publicKey }), params);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("fee payer");
  });

  it("rejects a compute unit price above the facilitator ceiling", () => {
    const greedy = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5_000_001 });
    const r = verifyAgentPayment(buildTx([greedy, transferIx()]), params);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("ceiling");
  });

  it("rejects an unsigned client — signature slot still zeroed", () => {
    const r = verifyAgentPayment(buildTx([transferIx()], { sign: false }), params);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("signed");
  });

  it("rejects address table lookups — accounts must be static", () => {
    const base = buildTx([transferIx()]).message as MessageV0;
    const withAlt = new VersionedTransaction(new MessageV0({
      header: base.header,
      staticAccountKeys: base.staticAccountKeys,
      recentBlockhash: base.recentBlockhash,
      compiledInstructions: base.compiledInstructions,
      addressTableLookups: [{ accountKey: Keypair.generate().publicKey, writableIndexes: [0], readonlyIndexes: [] }],
    }));
    const r = verifyAgentPayment(withAlt, params);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("table");
  });
});

describe("verifyAgentPayment — artist source-split (two legs)", () => {
  const artist = Keypair.generate().publicKey;
  const artistAta = getAssociatedTokenAddressSync(mint, artist);
  const ARTIST_MICRO = 500_000;
  const PLATFORM_MICRO = 190_000;
  const twoLegs = {
    legs: [
      { owner: artist, amountMicro: ARTIST_MICRO },
      { owner: payTo, amountMicro: PLATFORM_MICRO },
    ],
    mint,
    feePayer: feePayer.publicKey,
  };
  const artistIx = () => transferIx({ dest: artistAta, amount: ARTIST_MICRO });
  const platformIx = () => transferIx({ amount: PLATFORM_MICRO });

  it("accepts artist + platform transfers in one transaction, either order", () => {
    expect(verifyAgentPayment(buildTx([...budget(), artistIx(), platformIx()]), twoLegs).ok).toBe(true);
    expect(verifyAgentPayment(buildTx([...budget(), platformIx(), artistIx()]), twoLegs).ok).toBe(true);
  });

  it("rejects a payment missing the artist leg — the platform may not hold artist money", () => {
    const r = verifyAgentPayment(buildTx([platformIx()]), twoLegs);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("Missing transfer");
  });

  it("rejects a short-changed artist leg", () => {
    const r = verifyAgentPayment(
      buildTx([transferIx({ dest: artistAta, amount: ARTIST_MICRO - 1 }), platformIx()]),
      twoLegs,
    );
    expect(r.ok).toBe(false);
  });

  it("rejects two different authorities — one buyer pays every leg", () => {
    const other = Keypair.generate();
    const otherAta = getAssociatedTokenAddressSync(mint, other.publicKey);
    const tx = buildTx([
      artistIx(),
      transferIx({ amount: PLATFORM_MICRO, authority: other.publicKey, source: otherAta }),
    ], { sign: false });
    // Compiled honestly, the second authority is a third signer, refused first.
    const r = verifyAgentPayment(tx, twoLegs);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("exactly two signatures");
    // Crafted so it is not a signer at all, the one-authority rule still refuses it.
    const base = tx.message as MessageV0;
    const crafted = new VersionedTransaction(new MessageV0({
      header: { ...base.header, numRequiredSignatures: 2 },
      staticAccountKeys: base.staticAccountKeys,
      recentBlockhash: base.recentBlockhash,
      compiledInstructions: base.compiledInstructions,
      addressTableLookups: [],
    }));
    const c = verifyAgentPayment(crafted, twoLegs);
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.error).toContain("one authority");
  });
});

describe("verifyAgentPayment — the fee payer's exposure (exact-svm §2.1.4, §2.2.1, §3.1)", () => {
  it("rejects a compute unit limit above 200,000", () => {
    const r = verifyAgentPayment(buildTx([ComputeBudgetProgram.setComputeUnitLimit({ units: 200_001 }), transferIx()]), params);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("limit");
  });

  it("caps the whole priority fee at 50,000 lamports, with or without a limit instruction", () => {
    const limit = (units: number) => ComputeBudgetProgram.setComputeUnitLimit({ units });
    const price = (microLamports: number) => ComputeBudgetProgram.setComputeUnitPrice({ microLamports });
    // 200,000 units x 250,000 µlamports = 50,000 lamports: at the cap, accepted; one µlamport more is refused.
    expect(verifyAgentPayment(buildTx([limit(200_000), price(250_000), transferIx()]), params).ok).toBe(true);
    const over = verifyAgentPayment(buildTx([limit(200_000), price(250_005), transferIx()]), params);
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error).toContain("priority fee");
    // No limit: the runtime grants 200,000 units per other instruction, so the same price counts against that.
    expect(verifyAgentPayment(buildTx([price(250_000), transferIx()]), params).ok).toBe(true);
    expect(verifyAgentPayment(buildTx([price(250_005), transferIx()]), params).ok).toBe(false);
    // A high price with a low limit stays under the cap: the reference client's own shape.
    expect(verifyAgentPayment(buildTx([limit(20_000), price(2_500_000), transferIx()]), params).ok).toBe(true);
  });

  it("rejects a third signer — every signature costs the fee payer", () => {
    const third = Keypair.generate();
    const memo = new TransactionInstruction({
      programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
      keys: [{ pubkey: third.publicKey, isSigner: true, isWritable: false }], data: Buffer.from("x"),
    });
    const tx = buildTx([transferIx(), memo], { sign: false });
    tx.sign([client, third]);
    const r = verifyAgentPayment(tx, params);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("exactly two signatures");
  });

  it("accepts the Lighthouse guards wallets inject, and still keeps the fee payer out of them", () => {
    const lighthouse = (keys: TransactionInstruction["keys"] = []) => new TransactionInstruction({
      programId: new PublicKey("L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95"), keys, data: Buffer.from([1, 2, 3]),
    });
    expect(verifyAgentPayment(buildTx([...budget(), transferIx(), lighthouse(), lighthouse()]), params).ok).toBe(true);
    const touching = verifyAgentPayment(buildTx([transferIx(), lighthouse([{ pubkey: feePayer.publicKey, isSigner: false, isWritable: true }])]), params);
    expect(touching.ok).toBe(false);
  });

  it("rejects more than 8 instructions", () => {
    const memo = () => new TransactionInstruction({ programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"), keys: [], data: Buffer.from("m") });
    expect(verifyAgentPayment(buildTx([...budget(), transferIx(), memo(), memo(), memo(), memo(), memo()]), params).ok).toBe(true);
    const r = verifyAgentPayment(buildTx([...budget(), transferIx(), memo(), memo(), memo(), memo(), memo(), memo()]), params);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("at most 8");
  });
});

describe("parseXPayment", () => {
  const wrap = (envelope: unknown) => Buffer.from(JSON.stringify(envelope)).toString("base64");
  const MAINNET = ["solana", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"];

  it("round-trips a v0 transaction", () => {
    const tx = buildTx([transferIx()]);
    const header = wrap({ x402Version: 1, scheme: "exact", network: "solana", payload: { transaction: Buffer.from(tx.serialize()).toString("base64") } });
    const r = parseXPayment(header, MAINNET);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.version).toBe(1);
      expect(verifyAgentPayment(r.tx, params).ok).toBe(true);
    }
  });

  it("reads a v2 PAYMENT-SIGNATURE envelope: scheme and network under `accepted`, CAIP-2 network", () => {
    const tx = buildTx([transferIx()]);
    const header = wrap({
      x402Version: 2, resource: { url: "https://www.enki.gallery/api/x402/generate" },
      accepted: { scheme: "exact", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" },
      payload: { transaction: Buffer.from(tx.serialize()).toString("base64") },
    });
    const r = parseXPayment(header, MAINNET);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.version).toBe(2);
  });

  it("takes only the deployment's own network: devnet is refused on mainnet and the other way round", () => {
    const tx = Buffer.from(buildTx([transferIx()]).serialize()).toString("base64");
    expect(parseXPayment(wrap({ x402Version: 1, scheme: "exact", network: "solana-devnet", payload: { transaction: tx } }), MAINNET).ok).toBe(false);
    expect(parseXPayment(wrap({ x402Version: 1, scheme: "exact", network: "solana", payload: { transaction: tx } }), ["solana-devnet"]).ok).toBe(false);
    expect(parseXPayment(wrap({ x402Version: 2, accepted: { scheme: "exact", network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" }, payload: { transaction: tx } }), MAINNET).ok).toBe(false);
  });

  it("accepts a LEGACY transaction wire format", () => {
    const legacy = new Transaction({ feePayer: feePayer.publicKey, blockhash: BLOCKHASH, lastValidBlockHeight: 1 }).add(transferIx());
    legacy.partialSign(client);
    const header = wrap({ x402Version: 1, scheme: "exact", network: "solana", payload: { transaction: legacy.serialize({ requireAllSignatures: false }).toString("base64") } });
    const r = parseXPayment(header, MAINNET);
    expect(r.ok).toBe(true);
    if (r.ok) expect(verifyAgentPayment(r.tx, params).ok).toBe(true);
  });

  it("rejects garbage, wrong scheme, wrong network, missing payload", () => {
    expect(parseXPayment("not-base64-json!!", MAINNET).ok).toBe(false);
    expect(parseXPayment(wrap({ scheme: "upto", network: "solana", payload: { transaction: "AA==" } }), MAINNET).ok).toBe(false);
    expect(parseXPayment(wrap({ scheme: "exact", network: "base", payload: { transaction: "AA==" } }), MAINNET).ok).toBe(false);
    expect(parseXPayment(wrap({ scheme: "exact", network: "solana", payload: {} }), MAINNET).ok).toBe(false);
  });
});

describe("x402Network", () => {
  it("names each chain in v1 and CAIP-2, and refuses anything else", () => {
    expect(x402Network("solana")).toEqual({ v1: "solana", caip2: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" });
    expect(x402Network("solana-devnet")).toEqual({ v1: "solana-devnet", caip2: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" });
    expect(() => x402Network("base")).toThrow();
  });
});

describe("paymentResponseHeader", () => {
  it("names the buyer as payer, as the v1 and v2 specs ask", () => {
    const decoded = JSON.parse(Buffer.from(paymentResponseHeader("sig", "solana", client.publicKey), "base64").toString("utf8"));
    expect(decoded).toEqual({ success: true, transaction: "sig", network: "solana", payer: client.publicKey.toBase58() });
  });
});

describe("cosignAsFeePayer", () => {
  it("is deterministic — the replay guard's premise: same tx, same signature", () => {
    const mk = () => {
      const tx = buildTx([...budget(), transferIx()]);
      return cosignAsFeePayer(tx, feePayer);
    };
    expect(mk()).toBe(mk());
  });
});

describe("submitAndConfirm", () => {
  // A real signed transaction: the signature is read from it before the send.
  const tx = buildTx([...budget(), transferIx()]);
  cosignAsFeePayer(tx, feePayer);
  const SIG = bs58.encode(tx.signatures[0]);
  const conn = (send: () => Promise<unknown>, statuses: () => Promise<unknown>) =>
    ({ sendRawTransaction: send, getSignatureStatuses: statuses }) as unknown as Connection;
  const sent = async () => SIG;

  it("confirms once the status says so", async () => {
    const c = conn(sent, async () => ({ value: [{ confirmationStatus: "confirmed", err: null }] }));
    expect(await submitAndConfirm(c, tx, 5_000)).toEqual({ ok: true, signature: SIG });
  });

  it("keeps the signature and leaves it pending when the status read fails after the broadcast", async () => {
    const c = conn(sent, async () => { throw new Error("429 Too Many Requests"); });
    expect(await submitAndConfirm(c, tx, 5_000)).toEqual({ ok: false, pending: true, signature: SIG, error: expect.stringMatching(/429/) });
  });

  it("is final when the send is refused and the network does not know the transaction", async () => {
    const refused = new SendTransactionError({ action: "send", signature: SIG, transactionMessage: "Blockhash not found" });
    const c = conn(async () => { throw refused; }, async () => ({ value: [null] }));
    expect(await submitAndConfirm(c, tx, 5_000)).toMatchObject({ ok: false, pending: false, signature: SIG, error: expect.stringMatching(/Blockhash/) });
  });
});
