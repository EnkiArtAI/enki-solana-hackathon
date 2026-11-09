import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import bs58 from "bs58";
import { ed25519 } from "@noble/curves/ed25519";
import { privateKeyToAccount } from "viem/accounts";
import { fakePostgrest } from "./_fake-postgrest";

/**
 * Kev, 2026-11-05: a wallet changes only with all MFAs. A stolen session used to
 * be able to add any free address as a primary wallet, and artistPayoutWallet
 * pays that table. Real signatures here, in the encodings CDP's types declare
 * (Solana base58, EVM hex); the database is a fake, the mail is captured.
 */

const db = fakePostgrest();
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => db.client }));
const mails = vi.hoisted(() => [] as { to: string; subject: string; text: string }[]);
const mailFails = vi.hoisted(() => ({ on: false }));
vi.mock("@/lib/mailer", () => ({
  sendMail: async (m: { to: string; subject: string; text: string }) => {
    if (mailFails.on) throw new Error("mail down");
    mails.push(m);
    return { ok: true };
  },
}));
vi.hoisted(() => {
  process.env.AUTH_PEPPER = Buffer.alloc(32, 9).toString("base64");
  process.env.FIELD_ENCRYPTION_KEY_B64 = Buffer.alloc(32, 4).toString("base64");
});

import { POST as attachWallet } from "../../app/api/auth/session/attach-wallet/route";
import { POST as login } from "../../app/api/auth/session/route";
import { generateAuthMessage } from "@/lib/auth";
import { mintStepUpToken } from "@/lib/webauthn";
import { encryptString } from "@/lib/crypto";
import { artistPayoutWallet } from "@/lib/payments/generation-quote";
import { mailSecurityNotice } from "@/lib/security-notice";
import { resolveSessionUserId } from "@/lib/session-user";
import { APP_NAME } from "@/shared/app-config";

type Row = Record<string, unknown>;
type Issued = { address: string; family: string; nonce: string; message: string };

const FUTURE = new Date(Date.now() + 3_600_000).toISOString();
const TOKEN = "this-session";
let U: string;

const solWallet = () => {
  const secret = ed25519.utils.randomPrivateKey();
  const address = bs58.encode(ed25519.getPublicKey(secret));
  return { address, sign: async (message: string) => bs58.encode(ed25519.sign(new TextEncoder().encode(message), secret)) };
};
const evmWallet = () => {
  const account = privateKeyToAccount(`0x${randomBytes(32).toString("hex")}`);
  return { address: account.address as string, sign: (message: string) => account.signMessage({ message }) };
};
type Wallet = { address: string; sign: (m: string) => Promise<string> };

const post = (body: unknown, { tokens = [] as string[], token = TOKEN } = {}) =>
  attachWallet(new NextRequest("http://enki.test/api/auth/session/attach-wallet", {
    method: "POST",
    headers: { "X-Session-Token": token, ...(tokens.length ? { "X-StepUp-Token": tokens.join(",") } : {}) },
    body: JSON.stringify(body),
  }));

/** What the client does with a 428: sign each message the server sent. */
async function proofFor(wallets: Wallet[], body: Row): Promise<{ address: string; nonce: string; signature: string }[]> {
  const res = await post(body);
  expect(res.status).toBe(428);
  const { proof } = (await res.json()) as { proof: Issued[] };
  return Promise.all(proof.map(async (p) => ({
    address: p.address,
    nonce: p.nonce,
    signature: await wallets.find((w) => w.address === p.address)!.sign(p.message),
  })));
}
const bodyFor = (sol: Wallet, evm?: Wallet) => ({ solanaAddress: sol.address, ...(evm ? { evmAddress: evm.address } : {}) });

const wallets = () => db.tables.user_wallets;
const row = (address: string) => wallets().find((w) => w.address === address);
const liveOf = (user: string) => wallets().filter((w) => w.user_id === user && !w.removed_at);
const sessionAddress = (token = TOKEN) => db.tables.auth_sessions.find((s) => s.token === token)?.wallet_address;
const usedNonces = () => db.tables.auth_nonces.filter((n) => n.consumed);
const claimed = () => db.tables.consumed_stepup_tokens;

const ownRow = (address: string, extra: Row = {}): Row => ({
  id: randomUUID(), user_id: U, address, chain_family: "solana", wallet_type: "external_eoa", is_primary: true, removed_at: null, ...extra,
});
const enroll = (...kinds: ("passkey" | "totp")[]) => {
  for (const k of kinds) {
    if (k === "passkey") db.tables.webauthn_credentials.push({ id: "pk", user_id: U, credential_id: "c", public_key: "AAAA", counter: 0, created_at: "2026-10-07T00:00:00Z" });
    else db.tables.mfa_factors.push({ user_id: U, kind: "totp", confirmed_at: "2026-10-07T00:00:00Z" });
  }
};
const scopeOf = (sol: Wallet) => `wallet-change:${sol.address}`;

beforeEach(() => {
  for (const k of Object.keys(db.tables)) delete db.tables[k];
  U = randomUUID(); // the proof limit counts per account
  Object.assign(db.tables, {
    auth_sessions: [{ token: TOKEN, wallet_address: U, wallet_type: "password", expires_at: FUTURE }],
    user_wallets: [],
    auth_nonces: [],
    consumed_stepup_tokens: [],
    webauthn_credentials: [],
    mfa_factors: [],
    password_credentials: [{ user_id: U, email: "owner@example.test", email_verified_at: "2026-10-01T00:00:00.000Z" }],
    auth_identities: [],
    bans: [],
    users: [{ id: U }],
  });
  db.state.failing = null;
  db.state.failNext = null;
  db.state.holdNext = null;
  mails.length = 0;
  mailFails.on = false;
});

describe("without proof nothing happens", () => {
  it("answers 428 with one entry per new address and writes no wallet row", async () => {
    const sol = solWallet();
    const evm = evmWallet();
    const res = await post(bodyFor(sol, evm));
    expect(res.status).toBe(428);
    const { proof } = (await res.json()) as { proof: Issued[] };
    expect(proof.map((p) => [p.address, p.family])).toEqual([[sol.address, "solana"], [evm.address, "evm"]]);
    for (const p of proof) {
      expect(p.nonce).toMatch(/^[0-9a-f]{64}$/);
      expect(p.message).toContain(U);
      expect(p.message).toContain(p.address);
      expect(p.message).toContain(p.nonce);
      expect(db.tables.auth_nonces.some((n) => n.nonce === p.nonce && n.wallet_address === p.address.toLowerCase() && n.consumed === false)).toBe(true);
    }
    expect(wallets()).toEqual([]);
    expect(sessionAddress()).toBe(U);
  });

  it("asks again for every new address when a proof is missing for one of them", async () => {
    const sol = solWallet();
    const evm = evmWallet();
    const [first] = await proofFor([sol, evm], bodyFor(sol, evm));
    const res = await post({ ...bodyFor(sol, evm), proof: [first] });
    expect(res.status).toBe(428);
    expect(wallets()).toEqual([]);
  });

  it("refuses a foreign address before it issues anything", async () => {
    const sol = solWallet();
    wallets().push({ id: "v", user_id: randomUUID(), address: sol.address, chain_family: "solana", removed_at: null });
    expect((await post(bodyFor(sol))).status).toBe(409);
    expect(db.tables.auth_nonces).toEqual([]);
    expect(sessionAddress()).toBe(U);
  });

  it("keeps refusing an address another account held and gave up", async () => {
    const sol = solWallet();
    wallets().push({ id: "v", user_id: randomUUID(), address: sol.address, chain_family: "solana", removed_at: "2026-10-01T00:00:00.000Z" });
    expect((await post(bodyFor(sol))).status).toBe(409);
  });

  it("limits how many proofs an account can ask for", async () => {
    const sol = solWallet();
    for (let i = 0; i < 10; i++) expect((await post(bodyFor(sol))).status).toBe(428);
    expect((await post(bodyFor(sol))).status).toBe(429);
    expect(db.tables.auth_nonces).toHaveLength(10);
  });

  it("issues nothing when the nonce cannot be stored", async () => {
    db.state.failNext = { table: "auth_nonces", op: "insert", code: "XX000" };
    expect((await post(bodyFor(solWallet()))).status).toBe(500);
  });
});

describe("the first attach of a fresh account", () => {
  it("passes on the proof alone, asks no factor, mails nobody", async () => {
    const sol = solWallet();
    const evm = evmWallet();
    const proof = await proofFor([sol, evm], bodyFor(sol, evm));
    const res = await post({ ...bodyFor(sol, evm), proof });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ attached: sol.address, evm: evm.address });
    expect(row(sol.address)).toMatchObject({ user_id: U, chain_family: "solana", wallet_type: "external_eoa", is_primary: true });
    expect(row(evm.address)).toMatchObject({ user_id: U, chain_family: "evm", wallet_type: "external_eoa", is_primary: false });
    expect(sessionAddress()).toBe(sol.address);
    expect(usedNonces()).toHaveLength(2);
    expect(mails).toEqual([]);
  });

  it("counts neither another account's live wallet nor this account's removed one against the first attach", async () => {
    const gone = solWallet();
    wallets().push(
      { id: "s", user_id: randomUUID(), address: solWallet().address, chain_family: "solana", is_primary: true, removed_at: null },
      ownRow(gone.address, { removed_at: "2026-10-01T00:00:00.000Z", is_primary: false }),
    );
    const sol = solWallet();
    const proof = await proofFor([sol], bodyFor(sol));
    expect((await post({ ...bodyFor(sol), proof })).status).toBe(200);
    expect(row(sol.address)!.is_primary).toBe(true);
    expect(mails).toEqual([]);
  });

  it("is no free pass on an account with factors: all of them must pass", async () => {
    enroll("totp");
    const sol = solWallet();
    const proof = await proofFor([sol], bodyFor(sol));
    const res = await post({ ...bodyFor(sol), proof });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ all: true, missing: ["totp"], scope: scopeOf(sol) });
    expect(wallets()).toEqual([]);
    expect(usedNonces()).toEqual([]);
    const tokens = [await mintStepUpToken(U, scopeOf(sol), "totp")];
    expect((await post({ ...bodyFor(sol), proof }, { tokens })).status).toBe(200);
    expect(liveOf(U).map((w) => w.address)).toEqual([sol.address]);
  });

  it("a new Solana address on a factor-free account with only a live EVM wallet answers 403 { enroll }: that row is a login too", async () => {
    const evm = evmWallet();
    wallets().push(ownRow(evm.address, { chain_family: "evm", is_primary: false }));
    const sol = solWallet();
    const proof = await proofFor([sol], bodyFor(sol));
    const res = await post({ ...bodyFor(sol), proof });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ enroll: true, error: "Set up a second factor first" });
    expect(row(sol.address)).toBeUndefined();
    expect(sessionAddress()).toBe(U);
    expect(usedNonces()).toEqual([]);
  });

  it("the live EVM row a request names does not make its new Solana address a first attach", async () => {
    const evm = evmWallet();
    wallets().push(ownRow(evm.address, { chain_family: "evm", is_primary: false }));
    const sol = solWallet();
    const proof = await proofFor([sol], bodyFor(sol, evm));
    expect((await post({ ...bodyFor(sol, evm), proof })).status).toBe(403);
    expect(row(sol.address)).toBeUndefined();
  });

  it("the double attach that lost writes nothing, so it tells nobody", async () => {
    enroll("totp");
    const sol = solWallet();
    wallets().push(ownRow(evmWallet().address, { chain_family: "evm", is_primary: false }));
    const proof = await proofFor([sol], bodyFor(sol));
    const tokens = [await mintStepUpToken(U, scopeOf(sol), "totp")];
    db.state.failNext = { table: "user_wallets", op: "insert", code: "23505" };
    expect((await post({ ...bodyFor(sol), proof }, { tokens })).status).toBe(409);
    expect(mails).toEqual([]);
  });

  it("two attaches at once: the row that won stands when it is this account's", async () => {
    const sol = solWallet();
    const proof = await proofFor([sol], bodyFor(sol));
    let release = () => {};
    db.state.holdNext = { table: "user_wallets", until: new Promise<void>((r) => { release = r; }), skip: 2 }; // ownership, live rows
    const answer = post({ ...bodyFor(sol), proof });
    await new Promise((r) => setTimeout(r, 20));
    wallets().push(ownRow(sol.address));
    db.state.failNext = { table: "user_wallets", op: "insert", code: "23505" };
    release();
    expect((await answer).status).toBe(200);
    expect(sessionAddress()).toBe(sol.address);
  });

  it("two attaches at once: another account that won keeps it, and this session stays put", async () => {
    const sol = solWallet();
    const proof = await proofFor([sol], bodyFor(sol));
    let release = () => {};
    db.state.holdNext = { table: "user_wallets", until: new Promise<void>((r) => { release = r; }), skip: 2 };
    const answer = post({ ...bodyFor(sol), proof });
    await new Promise((r) => setTimeout(r, 20));
    wallets().push({ id: "v", user_id: randomUUID(), address: sol.address, chain_family: "solana", removed_at: null });
    db.state.failNext = { table: "user_wallets", op: "insert", code: "23505" };
    release();
    expect((await answer).status).toBe(409);
    expect(sessionAddress()).toBe(U);
  });

  // The other request's row lands between this one's ownership read and its live-rows read.
  const heldBeforeLiveRows = (reads: number, land: () => void, send: () => Promise<Response>) => {
    let release = () => {};
    db.state.holdNext = { table: "user_wallets", until: new Promise<void>((r) => { release = r; }), skip: reads };
    const answer = send();
    return new Promise((r) => setTimeout(r, 20)).then(() => {
      land();
      db.state.failNext = { table: "user_wallets", op: "insert", code: "23505" };
      release();
      return answer;
    });
  };

  it("two attaches at once, no factor: the other request's row is this address, not an old wallet to set a factor up for", async () => {
    const sol = solWallet();
    const proof = await proofFor([sol], bodyFor(sol));
    const res = await heldBeforeLiveRows(1, () => wallets().push(ownRow(sol.address)), () => post({ ...bodyFor(sol), proof }));
    expect(res.status).toBe(200);
    expect(sessionAddress()).toBe(sol.address);
    expect(liveOf(U).map((w) => w.address)).toEqual([sol.address]);
    expect(mails).toEqual([]);
  });

  it("two attaches at once, with a factor: the row, the session and the sessions on it survive", async () => {
    enroll("totp");
    const sol = solWallet();
    db.tables.auth_sessions.push({ token: "my-other-tab", wallet_address: sol.address, wallet_type: "password", expires_at: FUTURE });
    const proof = await proofFor([sol], bodyFor(sol));
    const tokens = [await mintStepUpToken(U, scopeOf(sol), "totp")];
    const res = await heldBeforeLiveRows(1, () => wallets().push(ownRow(sol.address)), () => post({ ...bodyFor(sol), proof }, { tokens }));
    expect(res.status).toBe(200);
    expect(sessionAddress()).toBe(sol.address);
    expect(sessionAddress("my-other-tab")).toBe(sol.address);
    expect(row(sol.address)!.removed_at).toBeNull();
    expect(mails).toEqual([]);
  });

  // The other request wrote the EVM row in the wallet login's lowercase; this one's Solana insert passes, its EVM insert loses.
  const lostEvmInsert = (lowered: string, send: () => Promise<Response>) => {
    let release = () => {};
    db.state.holdNext = { table: "user_wallets", until: new Promise<void>((r) => { release = r; }), skip: 2 };
    const answer = send();
    return new Promise((r) => setTimeout(r, 20)).then(() => {
      wallets().push(ownRow(lowered, { chain_family: "evm", is_primary: false }));
      db.state.failNext = { table: "user_wallets", op: "insert", code: "23505", skip: 1 };
      release();
      return answer;
    });
  };

  it("two attaches at once, with a factor: the row counts as this address in any case", async () => {
    enroll("totp");
    const sol = solWallet();
    const evm = evmWallet();
    const lowered = evm.address.toLowerCase();
    const proof = await proofFor([sol, evm], bodyFor(sol, evm));
    const tokens = [await mintStepUpToken(U, scopeOf(sol), "totp")];
    const res = await lostEvmInsert(lowered, () => post({ ...bodyFor(sol, evm), proof }, { tokens }));
    expect(res.status).toBe(200);
    expect(row(lowered)!.removed_at).toBeNull();
    expect(row(sol.address)!.removed_at ?? null).toBeNull();
  });

  it("two attaches at once, no factor: the row counts as this address in any case, so a first attach stays one", async () => {
    const sol = solWallet();
    const evm = evmWallet();
    const lowered = evm.address.toLowerCase();
    const proof = await proofFor([sol, evm], bodyFor(sol, evm));
    const res = await lostEvmInsert(lowered, () => post({ ...bodyFor(sol, evm), proof }));
    expect(res.status).toBe(200);
    expect(sessionAddress()).toBe(sol.address);
    expect(mails).toEqual([]);
  });
});

describe("a proof must be this wallet's, for this account, for this attach", () => {
  it("refuses a wrong signature and spends no nonce", async () => {
    const sol = solWallet();
    const [p] = await proofFor([sol], bodyFor(sol));
    const res = await post({ ...bodyFor(sol), proof: [{ ...p, signature: await solWallet().sign(db.tables.auth_nonces[0].nonce as string) }] });
    expect(res.status).toBe(401);
    expect(wallets()).toEqual([]);
    expect(usedNonces()).toEqual([]);
  });

  it("refuses a signature that is not base58, and an EVM one by another key", async () => {
    const sol = solWallet();
    const evm = evmWallet();
    const proof = await proofFor([sol, evm], bodyFor(sol, evm));
    expect((await post({ ...bodyFor(sol, evm), proof: [{ ...proof[0], signature: "0OIl not base58" }, proof[1]] })).status).toBe(401);
    expect((await post({ ...bodyFor(sol, evm), proof: [proof[0], { ...proof[1], signature: await evmWallet().sign("x") }] })).status).toBe(401);
    expect(wallets()).toEqual([]);
  });

  it("refuses a signature made for another account", async () => {
    const sol = solWallet();
    const res = await post(bodyFor(sol));
    const { proof: [p] } = (await res.json()) as { proof: Issued[] };
    const signature = await sol.sign(p.message.replace(U, randomUUID()));
    expect((await post({ ...bodyFor(sol), proof: [{ address: p.address, nonce: p.nonce, signature }] })).status).toBe(401);
    expect(wallets()).toEqual([]);
  });

  it("refuses a login signature over the same nonce", async () => {
    const sol = solWallet();
    const [p] = await proofFor([sol], bodyFor(sol));
    const signature = await sol.sign(generateAuthMessage(sol.address, p.nonce).message);
    expect((await post({ ...bodyFor(sol), proof: [{ ...p, signature }] })).status).toBe(401);
    expect(wallets()).toEqual([]);
  });

  it("cannot be replayed as a login: its text names no app, which the login route asks for", async () => {
    const sol = solWallet();
    const res = await post(bodyFor(sol));
    const { proof: [p] } = (await res.json()) as { proof: Issued[] };
    expect(p.message).not.toContain(APP_NAME);
    const signature = Buffer.from(bs58.decode(await sol.sign(p.message))).toString("base64");
    const answer = await login(new NextRequest("http://enki.test/api/auth/session", {
      method: "POST",
      body: JSON.stringify({ walletAddress: sol.address, walletType: "solana", signature, message: p.message, timestamp: Date.now(), nonce: p.nonce }),
    }));
    expect(answer.status).toBe(401);
    expect(usedNonces()).toEqual([]);
  });

  it("refuses a used nonce, and an expired one", async () => {
    const sol = solWallet();
    const proof = await proofFor([sol], bodyFor(sol));
    db.tables.auth_nonces[0].consumed = true;
    expect((await post({ ...bodyFor(sol), proof })).status).toBe(401);
    expect(wallets()).toEqual([]);
    db.tables.auth_nonces[0].consumed = false;
    db.tables.auth_nonces[0].expires_at = "2020-01-01T00:00:00.000Z";
    expect((await post({ ...bodyFor(sol), proof })).status).toBe(401);
    expect(sessionAddress()).toBe(U);
  });

  it("refuses a nonce issued for another address", async () => {
    const sol = solWallet();
    const [p] = await proofFor([sol], bodyFor(sol));
    db.tables.auth_nonces[0].wallet_address = "someone-else";
    expect((await post({ ...bodyFor(sol), proof: [p] })).status).toBe(401);
  });

  it("answers an unreachable database honestly when it dies at the nonce", async () => {
    const sol = solWallet();
    const proof = await proofFor([sol], bodyFor(sol));
    const rpc = vi.spyOn(db.client as unknown as { rpc: (...a: unknown[]) => unknown }, "rpc").mockResolvedValueOnce({ data: null, error: { message: "TypeError: fetch failed" } });
    expect((await post({ ...bodyFor(sol), proof })).status).toBe(503);
    rpc.mockRestore();
    expect(wallets()).toEqual([]);
  });
});

describe("an address that is already this account's", () => {
  it("only re-points the session, with no proof and no factor, on an account with factors", async () => {
    enroll("passkey", "totp");
    const sol = solWallet();
    wallets().push(ownRow(sol.address));
    const res = await post(bodyFor(sol));
    expect(res.status).toBe(200);
    expect(sessionAddress()).toBe(sol.address);
    expect(wallets()).toHaveLength(1);
    expect(db.tables.auth_nonces).toEqual([]);
    expect(mails).toEqual([]);
  });

  // The last letter both of whose cases base58 has, flipped: low digits, so still 32 bytes, and another address.
  const caseFlipped = (address: string) => address.replace(/[a-hjkmnp-zA-HJKMNP-Z](?=[^a-hjkmnp-zA-HJKMNP-Z]*$)/, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));

  it("a case variant of a live address puts the session on the row's own spelling, so it stays this account's and banned with it", async () => {
    enroll("totp");
    const sol = solWallet();
    wallets().push(ownRow(sol.address));
    db.tables.auth_sessions[0].wallet_address = sol.address;
    const variant = caseFlipped(sol.address);
    expect(variant).not.toBe(sol.address);
    const res = await post({ solanaAddress: variant });
    expect(res.status).toBe(200);
    expect((await res.json()).attached).toBe(sol.address);
    expect(sessionAddress()).toBe(sol.address);
    expect(await resolveSessionUserId(db.client, TOKEN)).toBe(U);
    expect(db.tables.auth_nonces).toEqual([]);
    expect(wallets()).toHaveLength(1);
  });

  it("a case variant from the users.id bridge lands on the row's own spelling too", async () => {
    const sol = solWallet();
    wallets().push(ownRow(sol.address));
    await post({ solanaAddress: caseFlipped(sol.address) });
    expect(sessionAddress()).toBe(sol.address);
  });

  it("a live EVM row beside it never becomes what the session points at", async () => {
    const sol = solWallet();
    const evm = evmWallet();
    wallets().push(ownRow(sol.address), ownRow(evm.address, { chain_family: "evm", is_primary: false }));
    expect((await post(bodyFor(sol, evm))).status).toBe(200);
    expect(sessionAddress()).toBe(sol.address);
    expect(mails).toEqual([]);
  });

  // Kev, 2026-11-05: only Solana pays, and an EVM row is a login that outlives the session and a reset.
  for (const [name, factors] of [["no factor", []], ["with factors", ["passkey", "totp"]]] as [string, ("passkey" | "totp")[]][]) {
    it(`a new EVM address beside it is dropped, ${name}: no row, no proof, no factor, no mail, and the answer does not claim it`, async () => {
      enroll(...factors);
      const sol = solWallet();
      const evm = evmWallet();
      wallets().push(ownRow(sol.address));
      const res = await post(bodyFor(sol, evm));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ attached: sol.address, evm: null });
      expect(sessionAddress()).toBe(sol.address);
      expect(wallets()).toHaveLength(1);
      expect(db.tables.auth_nonces).toEqual([]);
      expect(claimed()).toEqual([]);
      expect(mails).toEqual([]);
    });
  }

  it("a session already on it drops a new EVM address the same way", async () => {
    const sol = solWallet();
    wallets().push(ownRow(sol.address));
    db.tables.auth_sessions[0].wallet_address = sol.address;
    const res = await post(bodyFor(sol, evmWallet()));
    expect(await res.json()).toEqual({ attached: sol.address, evm: null });
    expect(wallets()).toHaveLength(1);
  });

  it("a new EVM address beside it does not replace the live EVM row", async () => {
    enroll("totp");
    const sol = solWallet();
    const oldEvm = evmWallet();
    wallets().push(ownRow(sol.address), ownRow(oldEvm.address, { chain_family: "evm", is_primary: false }));
    expect((await post(bodyFor(sol, evmWallet()))).status).toBe(200);
    expect(row(oldEvm.address)!.removed_at).toBeNull();
    expect(liveOf(U)).toHaveLength(2);
  });

  it("an EVM address another account holds is dropped unread too: the side address never stops the money path", async () => {
    const sol = solWallet();
    const taken = evmWallet();
    wallets().push(ownRow(sol.address), { id: "v", user_id: randomUUID(), address: taken.address, chain_family: "evm", removed_at: null });
    expect((await post(bodyFor(sol, taken))).status).toBe(200);
    expect(sessionAddress()).toBe(sol.address);
    expect(liveOf(U)).toHaveLength(1);
  });

  it("a removed Solana row beside it is no reason to mail", async () => {
    const sol = solWallet();
    wallets().push(ownRow(sol.address), ownRow(solWallet().address, { removed_at: "2026-10-01T00:00:00.000Z", is_primary: false }));
    expect((await post(bodyFor(sol))).status).toBe(200);
    expect(mails).toEqual([]);
  });

  it("refuses when the other live rows cannot be read", async () => {
    const sol = solWallet();
    wallets().push(ownRow(sol.address));
    db.state.failNext = { table: "user_wallets", op: "select", code: "XX000", skip: 1 };
    expect((await post(bodyFor(sol))).status).toBe(500);
    expect(sessionAddress()).toBe(U);
  });

  it("a removed row of this account is not its wallet: without a factor and with a live wallet, 403", async () => {
    const old = solWallet();
    const live = solWallet();
    wallets().push(ownRow(old.address, { removed_at: "2026-10-01T00:00:00.000Z", is_primary: false }), ownRow(live.address));
    const proof = await proofFor([old], bodyFor(old));
    const res = await post({ ...bodyFor(old), proof });
    expect(res.status).toBe(403);
    expect(row(old.address)!.removed_at).not.toBeNull();
    expect(sessionAddress()).toBe(U);
  });

  it("a removed row comes back through the whole gate, as one row", async () => {
    enroll("totp");
    const old = solWallet();
    const live = solWallet();
    wallets().push(ownRow(old.address, { removed_at: "2026-10-01T00:00:00.000Z", is_primary: false }), ownRow(live.address));
    const proof = await proofFor([old], bodyFor(old));
    expect((await post({ ...bodyFor(old), proof })).status).toBe(401);
    const tokens = [await mintStepUpToken(U, scopeOf(old), "totp")];
    expect((await post({ ...bodyFor(old), proof }, { tokens })).status).toBe(200);
    expect(liveOf(U).map((w) => w.address)).toEqual([old.address]);
    expect(wallets().filter((w) => w.address === old.address)).toHaveLength(1);
    expect(row(old.address)!.is_primary).toBe(true);
    expect(row(live.address)!.removed_at).not.toBeNull();
  });
});

describe("the factor gate on a change", () => {
  const twoFactorSwitch = async () => {
    enroll("passkey", "totp");
    const old = solWallet();
    const next = solWallet();
    wallets().push(ownRow(old.address));
    db.tables.auth_sessions[0].wallet_address = old.address;
    const proof = await proofFor([next], bodyFor(next));
    return { old, next, proof };
  };

  it("no factor with a live wallet answers 403 { enroll } and changes nothing", async () => {
    const old = solWallet();
    const next = solWallet();
    wallets().push(ownRow(old.address));
    const proof = await proofFor([next], bodyFor(next));
    const res = await post({ ...bodyFor(next), proof });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ enroll: true, error: "Set up a second factor first" });
    expect(liveOf(U).map((w) => w.address)).toEqual([old.address]);
    expect(usedNonces()).toEqual([]);
    expect(mails).toEqual([]);
  });

  it("one factor of two is refused, and neither the nonce nor the token is spent", async () => {
    const { next, proof, old } = await twoFactorSwitch();
    const res = await post({ ...bodyFor(next), proof }, { tokens: [await mintStepUpToken(U, scopeOf(next), "passkey")] });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ all: true, missing: ["totp"] });
    expect(claimed()).toEqual([]);
    expect(usedNonces()).toEqual([]);
    expect(row(next.address)).toBeUndefined();
    expect(sessionAddress()).toBe(old.address);
  });

  it("all factors pass, each jti and the nonce are spent", async () => {
    const { next, proof } = await twoFactorSwitch();
    const tokens = [await mintStepUpToken(U, scopeOf(next), "passkey"), await mintStepUpToken(U, scopeOf(next), "totp")];
    expect((await post({ ...bodyFor(next), proof }, { tokens })).status).toBe(200);
    expect(claimed()).toHaveLength(2);
    expect(usedNonces().map((n) => n.nonce)).toEqual([proof[0].nonce]);
  });

  it("a replayed token is refused: the store has it, a fresh proof does not help", async () => {
    const { next, proof, old } = await twoFactorSwitch();
    const tokens = [await mintStepUpToken(U, scopeOf(next), "passkey"), await mintStepUpToken(U, scopeOf(next), "totp")];
    db.tables.auth_nonces[0].consumed = true; // the gate passes, the nonce does not: the tokens are spent all the same
    expect((await post({ ...bodyFor(next), proof }, { tokens })).status).toBe(401);
    expect(claimed()).toHaveLength(2);
    const again = await proofFor([next], bodyFor(next));
    const res = await post({ ...bodyFor(next), proof: again }, { tokens });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ all: true });
    expect(liveOf(U).map((w) => w.address)).toEqual([old.address]);
  });

  it("refuses a token for another scope, another target, another user, or with no factor claim", async () => {
    const { next, proof, old } = await twoFactorSwitch();
    const other = solWallet();
    const passkey = await mintStepUpToken(U, scopeOf(next), "passkey");
    for (const bad of [
      await mintStepUpToken(U, "wallet", "totp"),
      await mintStepUpToken(U, scopeOf(other), "totp"),
      await mintStepUpToken(randomUUID(), scopeOf(next), "totp"),
      await mintStepUpToken(U, scopeOf(next)),
    ]) {
      expect((await post({ ...bodyFor(next), proof }, { tokens: [passkey, bad] })).status).toBe(401);
    }
    expect(liveOf(U).map((w) => w.address)).toEqual([old.address]);
  });

  it("a failed token store refuses, a failed factor lookup too", async () => {
    const { next, proof, old } = await twoFactorSwitch();
    const tokens = [await mintStepUpToken(U, scopeOf(next), "passkey"), await mintStepUpToken(U, scopeOf(next), "totp")];
    db.state.failNext = { table: "consumed_stepup_tokens", op: "insert", code: "XX000" };
    expect((await post({ ...bodyFor(next), proof }, { tokens })).status).toBe(503);
    db.state.failing = { table: "mfa_factors", code: "XX000" };
    expect((await post({ ...bodyFor(next), proof }, { tokens })).status).toBe(503);
    expect(liveOf(U).map((w) => w.address)).toEqual([old.address]);
    expect(usedNonces()).toEqual([]);
  });

  it("refuses when the live rows cannot be read", async () => {
    const sol = solWallet();
    const proof = await proofFor([sol], bodyFor(sol));
    db.state.failNext = { table: "user_wallets", op: "select", code: "XX000", skip: 1 }; // the ownership check answers, the live rows do not
    expect((await post({ ...bodyFor(sol), proof })).status).toBe(500);
    expect(wallets()).toEqual([]);
  });
});

describe("a real switch", () => {
  const OTHER_USER_SESSION = "someone-elses";
  const doSwitch = async () => {
    enroll("totp");
    const old = solWallet();
    const next = solWallet();
    wallets().push(ownRow(old.address));
    const other = randomUUID();
    db.tables.auth_sessions[0].wallet_address = old.address;
    db.tables.auth_sessions.push(
      { token: "my-other-tab", wallet_address: old.address, wallet_type: "password", expires_at: FUTURE },
      { token: "my-bridge-tab", wallet_address: U, wallet_type: "password", expires_at: FUTURE },
      { token: OTHER_USER_SESSION, wallet_address: other, wallet_type: "password", expires_at: FUTURE },
    );
    const proof = await proofFor([next], bodyFor(next));
    const tokens = [await mintStepUpToken(U, scopeOf(next), "totp")];
    return { old, next, proof, tokens };
  };

  it("retires the old row, promotes the new one, re-points, evicts the other session, mails", async () => {
    const { old, next, proof, tokens } = await doSwitch();
    expect((await post({ ...bodyFor(next), proof }, { tokens })).status).toBe(200);
    expect(row(old.address)).toMatchObject({ is_primary: false });
    expect(row(old.address)!.removed_at).not.toBeNull();
    expect(row(next.address)).toMatchObject({ user_id: U, is_primary: true });
    expect(row(next.address)!.removed_at ?? null).toBeNull();
    expect(sessionAddress()).toBe(next.address);
    expect(db.tables.auth_sessions.map((s) => s.token).sort()).toEqual([TOKEN, "my-bridge-tab", OTHER_USER_SESSION].sort());
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toBe("owner@example.test");
    expect(mails[0].subject).toBe("Your Enki wallet was changed");
    expect(mails[0].text).toContain(next.address);
    expect(mails[0].text).toMatch(/\d{2}:\d{2}:\d{2} GMT/);
    expect(mails[0].text).toMatch(/If it was not/);
    expect(mails[0].text).toContain("reset your password right away. A reset signs you out on every device.");
    expect(mails[0].text).toContain("you have no password to reset");
    expect(mails[0].text).toContain("A reset does not remove that wallet. If it came with a factor you did not add, open Settings, Recovery, Lost a factor, to remove it.");
  });

  it("sends the artist's payouts to the new wallet, not the old", async () => {
    const { next, proof, tokens } = await doSwitch();
    await post({ ...bodyFor(next), proof }, { tokens });
    expect(await artistPayoutWallet(db.client, U)).toEqual({ ok: true, wallet: next.address });
  });

  it("with a new Solana address and every factor, a new EVM address goes along and replaces the old one, and the mail names both", async () => {
    enroll("totp");
    const oldSol = solWallet();
    const nextSol = solWallet();
    const oldEvm = evmWallet();
    const nextEvm = evmWallet();
    wallets().push(ownRow(oldSol.address), ownRow(oldEvm.address, { chain_family: "evm", is_primary: false }));
    const proof = await proofFor([nextSol, nextEvm], bodyFor(nextSol, nextEvm));
    const tokens = [await mintStepUpToken(U, scopeOf(nextSol), "totp")];
    const res = await post({ ...bodyFor(nextSol, nextEvm), proof }, { tokens });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ attached: nextSol.address, evm: nextEvm.address });
    expect(row(oldEvm.address)!.removed_at).not.toBeNull();
    expect(row(oldSol.address)!.removed_at).not.toBeNull();
    expect(row(nextSol.address)).toMatchObject({ is_primary: true });
    expect(row(nextEvm.address)).toMatchObject({ is_primary: false });
    expect(mails[0].text).toContain(nextSol.address);
    expect(mails[0].text).toContain(nextEvm.address);
  });

  it("with a new Solana address and an EVM address that is already a live row, the answer claims no attach of it", async () => {
    enroll("totp");
    const sol = solWallet();
    const evm = evmWallet();
    wallets().push(ownRow(evm.address, { chain_family: "evm", is_primary: false }));
    const proof = await proofFor([sol], bodyFor(sol, evm));
    const tokens = [await mintStepUpToken(U, scopeOf(sol), "totp")];
    const res = await post({ ...bodyFor(sol, evm), proof }, { tokens });
    expect(await res.json()).toEqual({ attached: sol.address, evm: null });
    expect(row(evm.address)!.removed_at).toBeNull();
    // The only alarm for a new row that can sign in and survives a reset.
    expect(mails).toHaveLength(1);
    expect(mails[0].text).toContain(`A wallet was added to your Enki account: ${sol.address}`);
  });

  it("a mail that fails blocks nothing", async () => {
    const { next, proof, tokens } = await doSwitch();
    mailFails.on = true;
    expect((await post({ ...bodyFor(next), proof }, { tokens })).status).toBe(200);
    expect(sessionAddress()).toBe(next.address);
  });

  // Every write of the switch, failing in turn: an error, and never an account with no live wallet.
  const failures: [string, { table: string; op: "select" | "insert" | "update" | "delete"; code: string; skip?: number }][] = [
    ["the new row", { table: "user_wallets", op: "insert", code: "XX000" }],
    ["the session", { table: "auth_sessions", op: "update", code: "XX000" }],
    ["the eviction", { table: "auth_sessions", op: "delete", code: "XX000" }],
    ["the demotion", { table: "user_wallets", op: "update", code: "XX000" }],
    ["the promotion", { table: "user_wallets", op: "update", code: "XX000", skip: 1 }],
    ["the retirement", { table: "user_wallets", op: "update", code: "XX000", skip: 2 }],
  ];
  for (const [step, fail] of failures) {
    it(`answers an error when ${step} fails, and the old wallet is still live`, async () => {
      const { old, next, proof, tokens } = await doSwitch();
      db.state.failNext = fail;
      const res = await post({ ...bodyFor(next), proof }, { tokens });
      expect(res.status).toBe(500);
      expect(liveOf(U).map((w) => w.address)).toContain(old.address);
      // Whatever a constraint on the table may be: never two primaries, at any step.
      expect(liveOf(U).filter((w) => w.is_primary).length).toBeLessThanOrEqual(1);
      // Nothing written, nothing to tell; from the new row on the owner hears, whatever failed.
      expect(mails).toHaveLength(step === "the new row" ? 0 : 1);
      if (mails.length) expect(mails[0].text).toContain(next.address);
    });
  }

  it("a retry after a half-finished switch only re-points, and tells the owner again that both are live", async () => {
    const { next, proof, tokens } = await doSwitch();
    db.state.failNext = { table: "user_wallets", op: "update", code: "XX000", skip: 2 };
    expect((await post({ ...bodyFor(next), proof }, { tokens })).status).toBe(500);
    expect(mails).toHaveLength(1);
    db.tables.auth_sessions[0].wallet_address = U; // a new login, on the users.id bridge
    expect((await post(bodyFor(next))).status).toBe(200);
    expect(liveOf(U)).toHaveLength(2);
    expect(mails).toHaveLength(2);
    expect(mails[1].text).toContain(`did not finish: ${next.address} is live beside the old wallet`);
  });

  it("names every address it wrote when a later one fails", async () => {
    enroll("totp");
    const old = solWallet();
    const next = solWallet();
    const evm = evmWallet();
    wallets().push(ownRow(old.address));
    const proof = await proofFor([next, evm], bodyFor(next, evm));
    db.state.failNext = { table: "user_wallets", op: "insert", code: "XX000", skip: 1 };
    const tokens = [await mintStepUpToken(U, scopeOf(next), "totp")];
    expect((await post({ ...bodyFor(next, evm), proof }, { tokens })).status).toBe(500);
    expect(mails).toHaveLength(1);
    expect(mails[0].text).toContain(next.address);
    expect(mails[0].text).toContain("was changed to");
  });
});

describe("a switch waits out a new factor's first 24 hours", () => {
  const ago = (hours: number) => new Date(Date.now() - hours * 3600_000).toISOString();
  const passkeyFrom = (created_at: unknown, user_id: string = U) => db.tables.webauthn_credentials.push({ id: randomUUID(), user_id, credential_id: "c", public_key: "AAAA", counter: 0, created_at });
  const factorFrom = (kind: string, confirmed_at: unknown, user_id: string = U) => db.tables.mfa_factors.push({ id: randomUUID(), user_id, kind, confirmed_at });
  const change = async () => {
    const old = solWallet();
    const next = solWallet();
    wallets().push(ownRow(old.address));
    db.tables.auth_sessions[0].wallet_address = old.address;
    const proof = await proofFor([next], bodyFor(next));
    return { old, next, proof };
  };
  const tokensFor = (next: Wallet, ...factors: ("passkey" | "totp" | "email")[]) => Promise.all(factors.map((f) => mintStepUpToken(U, scopeOf(next), f)));

  it("holds the switch while the newest factor is younger, spending no token and no nonce, and says until when", async () => {
    factorFrom("totp", ago(23));
    const { old, next, proof } = await change();
    const res = await post({ ...bodyFor(next), proof }, { tokens: await tokensFor(next, "totp") });
    expect(res.status).toBe(403);
    const answer = await res.json();
    expect(answer).toMatchObject({ wait: true });
    expect(Date.parse(answer.until) - Date.now()).toBeGreaterThan(3500_000);
    expect(Date.parse(answer.until) - Date.now()).toBeLessThan(3700_000);
    expect(answer.error).toContain("less than 24 hours ago");
    expect(answer.error).toContain(new Date(answer.until).toUTCString());
    expect(claimed()).toEqual([]);
    expect(usedNonces()).toEqual([]);
    expect(row(next.address)).toBeUndefined();
    expect(sessionAddress()).toBe(old.address);
    expect(mails).toEqual([]);
  });

  it("lets it through once 24 hours have passed, and the factors are still asked", async () => {
    factorFrom("totp", ago(25));
    const { next, proof } = await change();
    expect((await post({ ...bodyFor(next), proof })).status).toBe(401);
    expect((await post({ ...bodyFor(next), proof }, { tokens: await tokensFor(next, "totp") })).status).toBe(200);
  });

  it("the newest counts: an old passkey beside a new authenticator", async () => {
    passkeyFrom(ago(240));
    factorFrom("totp", ago(1));
    const { next, proof } = await change();
    const res = await post({ ...bodyFor(next), proof });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ wait: true });
  });

  it("the newest counts: an old authenticator beside a new passkey", async () => {
    factorFrom("totp", ago(240));
    passkeyFrom(ago(1));
    const { next, proof } = await change();
    const res = await post({ ...bodyFor(next), proof });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ wait: true });
  });

  it("an email factor on a password account does not count, so it starts no wait", async () => {
    passkeyFrom(ago(240));
    factorFrom("email", ago(1));
    const { next, proof } = await change();
    expect((await post({ ...bodyFor(next), proof }, { tokens: await tokensFor(next, "passkey") })).status).toBe(200);
  });

  it("an email factor on an account with no password counts, and holds it", async () => {
    db.tables.password_credentials = [];
    factorFrom("email", ago(1));
    const { next, proof } = await change();
    const res = await post({ ...bodyFor(next), proof });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ wait: true });
  });

  it("a factor still being set up starts no wait", async () => {
    passkeyFrom(ago(240));
    factorFrom("totp", null);
    const { next, proof } = await change();
    expect((await post({ ...bodyFor(next), proof }, { tokens: await tokensFor(next, "passkey") })).status).toBe(200);
  });

  it("another account's new factors start no wait here", async () => {
    factorFrom("totp", ago(240));
    const other = randomUUID();
    passkeyFrom(ago(1), other);
    factorFrom("totp", ago(1), other);
    const { next, proof } = await change();
    expect((await post({ ...bodyFor(next), proof }, { tokens: await tokensFor(next, "totp") })).status).toBe(200);
  });

  it("a first attach is never held", async () => {
    factorFrom("totp", ago(1));
    const first = solWallet();
    const proof = await proofFor([first], bodyFor(first));
    expect((await post({ ...bodyFor(first), proof }, { tokens: [await mintStepUpToken(U, scopeOf(first), "totp")] })).status).toBe(200);
  });

  // No row retires here, yet this row starts paying: leaving the EVM address out of the request must not walk round the wait.
  it("a new Solana address beside a live EVM row is held, spending nothing", async () => {
    factorFrom("totp", ago(1));
    db.tables.user_wallets = [ownRow(evmWallet().address, { chain_family: "evm", is_primary: false })];
    const next = solWallet();
    const proof = await proofFor([next], bodyFor(next));
    const res = await post({ ...bodyFor(next), proof }, { tokens: await tokensFor(next, "totp") });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ wait: true });
    expect(claimed()).toEqual([]);
    expect(usedNonces()).toEqual([]);
    expect(row(next.address)).toBeUndefined();
    expect(await artistPayoutWallet(db.client, U)).not.toEqual({ ok: true, wallet: next.address });
  });

  it("a re-point is never held", async () => {
    factorFrom("totp", ago(1));
    const sol = solWallet();
    wallets().push(ownRow(sol.address));
    expect((await post(bodyFor(sol))).status).toBe(200);
    expect(sessionAddress()).toBe(sol.address);
  });

  it("no factor at all is the enroll answer, not a wait", async () => {
    const { next, proof } = await change();
    const res = await post({ ...bodyFor(next), proof });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ enroll: true });
  });

  it("a wrong signature is refused before the wait is told", async () => {
    factorFrom("totp", ago(1));
    const { next, proof } = await change();
    const res = await post({ ...bodyFor(next), proof: [{ ...proof[0], signature: await solWallet().sign("x") }] });
    expect(res.status).toBe(401);
    expect((await res.json()).wait).toBeUndefined();
  });

  it("fails closed on a read that fails, whichever table, and spends nothing", async () => {
    factorFrom("totp", ago(240));
    const { old, next, proof } = await change();
    const tokens = await tokensFor(next, "totp");
    for (const table of ["webauthn_credentials", "mfa_factors", "password_credentials"]) {
      db.state.failNext = { table, op: "select", code: "XX000" }; // this read only: the factor gate after it would answer 503 on its own
      expect((await post({ ...bodyFor(next), proof }, { tokens })).status).toBe(503);
    }
    expect(claimed()).toEqual([]);
    expect(usedNonces()).toEqual([]);
    expect(liveOf(U).map((w) => w.address)).toEqual([old.address]);
  });

  it("fails closed on a date it cannot read", async () => {
    factorFrom("totp", ago(240));
    passkeyFrom(null);
    const { next, proof } = await change();
    expect((await post({ ...bodyFor(next), proof }, { tokens: await tokensFor(next, "passkey", "totp") })).status).toBe(503);
    expect(row(next.address)).toBeUndefined();
  });
});

describe("no mail names a channel that does not exist (Kev, 2026-11-05: \"support weg\")", () => {
  it("no source in lib, app, components or hooks says contact Enki", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== "__tests__" && e.name !== "node_modules") walk(path); }
        else if (/\.tsx?$/.test(e.name) && /contact enki/i.test(readFileSync(path, "utf8"))) hits.push(path);
      }
    };
    for (const dir of ["lib", "app", "components", "hooks"]) walk(join(__dirname, "..", "..", dir));
    expect(hits).toEqual([]);
  });
});

describe("no factor recovery holds a wallet change: there is no wait anywhere (DEC-2026-11-07-13)", () => {
  it("a live set of mailed codes changes nothing: the factor still guards it", async () => {
    db.tables.mfa_factors.push({ id: randomUUID(), user_id: U, kind: "totp", confirmed_at: "2026-10-07T00:00:00Z" });
    db.tables.mfa_recovery = [{ user_id: U, factor: "totp", code_hashes: ["a", "b"], code_expires_at: new Date(Date.now() + 600_000).toISOString(), failed_attempts: 0, lockouts: 0, sends_count: 1 }];
    const old = solWallet();
    const next = solWallet();
    wallets().push(ownRow(old.address));
    db.tables.auth_sessions[0].wallet_address = old.address;
    const proof = await proofFor([next], bodyFor(next));
    expect((await post({ ...bodyFor(next), proof })).status).toBe(401);
    expect((await post({ ...bodyFor(next), proof }, { tokens: [await mintStepUpToken(U, scopeOf(next), "totp")] })).status).toBe(200);
  });

  it("the route reads no factor recovery at all", () => {
    expect(readFileSync(join(__dirname, "..", "..", "app", "api", "auth", "session", "attach-wallet", "route.ts"), "utf8")).not.toMatch(/mfa-recovery|recoveryWaitUntil|factor recovery/);
  });
});

describe("a suspended account", () => {
  it("issues no proof and writes nothing", async () => {
    db.tables.bans.push({ id: "b1", user_id: U, lifted_at: null, reason: "x", expires_at: null, created_at: "2026-10-01T00:00:00Z" });
    const res = await post(bodyFor(solWallet()));
    expect(res.status).toBe(403);
    expect(db.tables.auth_nonces).toEqual([]);
  });
});

describe("where a security notice goes", () => {
  const sealed = (address: string) => {
    const e = encryptString(address, U);
    return { secret_ct: e.encrypted, secret_iv: e.iv, secret_tag: e.authTag, secret_kid: e.kid ?? "" };
  };

  // Kev, 2026-11-05: no such control exists; a reset is what signs out everywhere (lib/password-reset.ts).
  it("no mail names a control that does not exist", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== "__tests__" && e.name !== "node_modules") walk(path); }
        else if (/\.tsx?$/.test(e.name) && /sign out (on|of) every device|sign out everywhere/i.test(readFileSync(path, "utf8"))) hits.push(path);
      }
    };
    for (const dir of ["lib", "app", "components"]) walk(join(__dirname, "..", "..", dir));
    expect(hits).toEqual([]);
  });

  it("an account with no email anywhere gets no mail, silently", async () => {
    db.tables.password_credentials = [];
    const quiet = vi.spyOn(console, "error");
    await mailSecurityNotice(db.client, U, "wallet-change", "s", "t");
    expect(mails).toEqual([]);
    expect(quiet).not.toHaveBeenCalled();
    quiet.mockRestore();
  });

  it("the wallet notice reaches an unconfirmed login email", async () => {
    db.tables.password_credentials[0].email_verified_at = null;
    enroll("totp");
    const old = solWallet();
    const next = solWallet();
    wallets().push(ownRow(old.address));
    const proof = await proofFor([next], bodyFor(next));
    expect((await post({ ...bodyFor(next), proof }, { tokens: [await mintStepUpToken(U, scopeOf(next), "totp")] })).status).toBe(200);
    expect(mails.map((m) => m.to)).toEqual(["owner@example.test"]);
  });

  // DEC-2026-11-05-40 point 2: one ranked address let a Google a stolen session connected outrank the owner's login email.
  it("every notice goes to every address, an email factor's and an unconfirmed login email included; another account's never", async () => {
    db.tables.password_credentials[0].email_verified_at = null;
    db.tables.auth_identities.push({ user_id: randomUUID(), provider: "google", email: "stranger@example.test" }, { user_id: U, provider: "google", email: "attacker@example.test" });
    db.tables.mfa_factors.push({ id: "f", user_id: U, kind: "email", confirmed_at: "2026-10-07T00:00:00Z", ...sealed("factor@example.test") });
    await mailSecurityNotice(db.client, U, "wallet-change", "the subject", "the text");
    expect(mails).toEqual(["owner@example.test", "attacker@example.test", "factor@example.test"].map((to) => ({ to, subject: "the subject", text: "the text" })));
  });

  it("the limit counts notices, not mails: three an hour per kind, each to every address", async () => {
    db.tables.auth_identities.push({ user_id: U, provider: "google", email: "google@example.test" });
    for (let i = 0; i < 4; i++) await mailSecurityNotice(db.client, U, "wallet-change", "s", "t");
    expect(mails.map((m) => m.to)).toEqual(Array.from({ length: 3 }, () => ["owner@example.test", "google@example.test"]).flat());
  });

  it("three an hour per kind, and an unreadable address sends nothing and does not throw", async () => {
    for (let i = 0; i < 5; i++) await mailSecurityNotice(db.client, U, "wallet-change", "s", "t");
    expect(mails).toHaveLength(3);
    await mailSecurityNotice(db.client, U, "other-kind", "s", "t");
    expect(mails).toHaveLength(4);
    db.state.failing = { table: "password_credentials", code: "XX000" };
    await expect(mailSecurityNotice(db.client, U, "third-kind", "s", "t")).resolves.toBeUndefined();
    expect(mails).toHaveLength(4);
  });
});
