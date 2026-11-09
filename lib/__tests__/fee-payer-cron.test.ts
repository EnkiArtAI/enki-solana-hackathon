import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";

/**
 * The fee payer's low-balance mail. RPC, mail and Blob are all stubbed: no call leaves this file. Blind spots: real Blob's
 * uploadedAt after an overwrite is the stub's word here; no real RPC or mail ran.
 */
const rpc = vi.hoisted(() => ({
  lamports: 500_000_000,
  fails: false,
  deadChain: "",
  reads: [] as string[],
}));
vi.mock("@/lib/payments/solana", async (orig) => ({
  ...(await orig<typeof import("@/lib/payments/solana")>()),
  solanaConnection: (chain: string) => ({
    getBalance: async () => {
      rpc.reads.push(chain);
      if (rpc.fails || chain === rpc.deadChain) throw new Error("failed to get balance of account: https://rpc.test/?api-key=RPCKEYSHAPED");
      return rpc.lamports;
    },
  }),
}));

let mailWorks = true;
const mails: { to: string; subject: string; text: string }[] = [];
vi.mock("@/lib/mailer", () => ({
  sendMail: async (m: { to: string; subject: string; text: string }) => {
    if (!mailWorks) return { ok: false };
    mails.push(m);
    return { ok: true };
  },
}));

const store = new Map<string, Date>();
const blob = { listFails: false, putFails: false, delFails: false };
vi.mock("@vercel/blob", () => ({
  list: async ({ prefix }: { prefix: string }) => {
    if (blob.listFails) throw new Error("blob down");
    return { blobs: [...store].filter(([p]) => p.startsWith(prefix)).map(([pathname, uploadedAt]) => ({ pathname, uploadedAt, url: `https://blob.test/${pathname}` })) };
  },
  put: async (pathname: string) => {
    if (blob.putFails) throw new Error("blob down");
    store.set(pathname, new Date());
    return { url: `https://blob.test/${pathname}` };
  },
  del: async (url: string) => {
    if (blob.delFails) throw new Error("blob down");
    store.delete(url.replace("https://blob.test/", ""));
  },
}));

import { GET } from "../../app/api/cron/fee-payer/route";
import { resetFeePayerCache } from "@/lib/payments/solana";

const START = Date.parse("2026-11-04T12:00:00Z");
const HOUR = 60 * 60_000;
const LOW = 99_999_999;
const run = (auth = "Bearer cron-secret") => GET(new NextRequest("http://enki.test/api/cron/fee-payer", { headers: { authorization: auth } }));
const at = (ms: number) => vi.setSystemTime(START + ms);
const key = Keypair.generate();
const SECRET = JSON.stringify([...key.secretKey]);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  at(0);
  vi.spyOn(console, "error").mockImplementation(() => {});
  rpc.lamports = 500_000_000;
  rpc.fails = false;
  rpc.deadChain = "";
  rpc.reads = [];
  Object.assign(blob, { listFails: false, putFails: false, delFails: false });
  mailWorks = true;
  mails.length = 0;
  store.clear();
  resetFeePayerCache();
  vi.stubEnv("CRON_SECRET", "cron-secret");
  vi.stubEnv("OPS_ALERT_EMAILS", "ops@enki.test, kev@enki.test");
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", "vercel_blob_rw_test");
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("SOLANA_FEE_PAYER_SECRET_KEY", SECRET);
  vi.stubEnv("SOLANA_PAYMENT_CHAIN", "solana-devnet");
  vi.stubEnv("X402_PAYMENT_CHAIN", "");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetFeePayerCache();
});

describe("the fee payer's low-balance mail", () => {
  it("refuses a caller that is not the scheduler, and reads nothing", async () => {
    rpc.lamports = LOW;
    expect((await run("Bearer wrong")).status).toBe(401);
    expect(rpc.reads).toEqual([]);
    expect(mails).toEqual([]);
  });

  it("a balance at the mark is healthy: no mail, no marker, and the answer says so", async () => {
    rpc.lamports = 100_000_000;
    const res = await run();
    expect(await res.json()).toEqual({ chains: [{ chain: "solana-devnet", sol: "0.100", low: false }] });
    expect(mails).toEqual([]);
    expect(store.size).toBe(0);
  });

  it("just under the mark mails every recipient once, with the chain, the SOL and the mark", async () => {
    rpc.lamports = 90_000_000;
    const res = await run();
    expect(await res.json()).toEqual({ chains: [{ chain: "solana-devnet", sol: "0.090", low: true }] });
    expect(mails.map((m) => [m.to, m.subject])).toEqual([["ops@enki.test", "Enki: the fee payer is running low"], ["kev@enki.test", "Enki: the fee payer is running low"]]);
    expect(mails[0].text).toContain("The fee payer on solana-devnet holds 0.090 SOL, under the mark of 0.100 SOL.");
    expect([...store.keys()]).toEqual(["ops/fee-payer-low-solana-devnet.txt"]);
  });

  it("one lamport under the mark counts as low", async () => {
    rpc.lamports = LOW;
    await run();
    expect(mails).toHaveLength(2);
  });

  it("while it stays low: nobody for 24 hours, then once more", async () => {
    rpc.lamports = LOW;
    await run();
    at(HOUR);
    await run();
    at(24 * HOUR - 1);
    await run();
    expect(mails).toHaveLength(2);
    at(24 * HOUR);
    await run();
    expect(mails).toHaveLength(4);
    at(25 * HOUR);
    await run();
    expect(mails).toHaveLength(4);
  });

  it("a send that failed leaves no marker and tries again next hour", async () => {
    rpc.lamports = LOW;
    mailWorks = false;
    await run();
    expect(store.size).toBe(0);
    mailWorks = true;
    at(HOUR);
    await run();
    expect(mails).toHaveLength(2);
    expect(store.size).toBe(1);
  });

  it("no answer from the RPC: 503, no mail, no marker, and the RPC's own words nowhere", async () => {
    rpc.lamports = LOW;
    rpc.fails = true;
    const res = await run();
    expect(res.status).toBe(503);
    expect(console.error).toHaveBeenCalledWith("[fee-payer] the balance could not be read");
    const said = `${JSON.stringify(await res.json())} ${vi.mocked(console.error).mock.calls.flat().map(String).join(" ")}`;
    expect(said).not.toContain("RPCKEYSHAPED");
    expect(said).not.toContain("rpc.test");
    expect(mails).toEqual([]);
    expect(store.size).toBe(0);
  });

  it("a fee payer key that cannot be read: 503 in fixed words, no mail, and nothing of the key", async () => {
    vi.stubEnv("SOLANA_FEE_PAYER_SECRET_KEY", "not-a-key-KEYSHAPED0OIl");
    const res = await run();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({ error: "The fee payer's balance could not be read.", chains: [] });
    expect(vi.mocked(console.error).mock.calls.flat().map(String).join(" ")).not.toContain("KEYSHAPED");
    expect(mails).toEqual([]);
  });

  it("one dead RPC does not hide the other chain: it is told, its marker written, and the cron is red", async () => {
    vi.stubEnv("X402_PAYMENT_CHAIN", "solana");
    rpc.lamports = LOW;
    rpc.deadChain = "solana-devnet";
    const res = await run();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "The fee payer's balance could not be read.", chains: [{ chain: "solana", sol: "0.100", low: true }] });
    expect(mails.map((m) => m.to)).toEqual(["ops@enki.test", "kev@enki.test"]);
    expect(mails[0].text).toContain("on solana holds");
    expect([...store.keys()]).toEqual(["ops/fee-payer-low-solana.txt"]);
  });

  it("a mail nobody got turns the cron red: not a green run with low:true", async () => {
    rpc.lamports = LOW;
    mailWorks = false;
    const res = await run();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "The fee payer is low and the mail did not go out.", chains: [{ chain: "solana-devnet", sol: "0.100", low: true }] });
    expect(store.size).toBe(0);
  });

  it("markers that cannot be read do not silence the mail", async () => {
    rpc.lamports = LOW;
    blob.listFails = true;
    expect((await run()).status).toBe(200);
    expect(mails).toHaveLength(2);
  });

  it("a marker that cannot be written leaves the mail sent and the cron green", async () => {
    rpc.lamports = LOW;
    blob.putFails = true;
    expect((await run()).status).toBe(200);
    expect(mails).toHaveLength(2);
    expect(store.size).toBe(0);
  });

  it("topped up, then drained: the next low reading mails at once, not a day later", async () => {
    rpc.lamports = LOW;
    await run();
    expect(mails).toHaveLength(2);
    at(HOUR);
    rpc.lamports = 500_000_000;
    await run();
    expect(store.size).toBe(0);
    at(2 * HOUR);
    rpc.lamports = 0;
    await run();
    expect(mails).toHaveLength(4);
  });

  it("a marker that cannot be removed fails nothing: the run stays green and it is tried next hour", async () => {
    rpc.lamports = LOW;
    await run();
    rpc.lamports = 500_000_000;
    blob.delFails = true;
    expect((await run()).status).toBe(200);
    expect(store.size).toBe(1);
  });

  it("drained while still low within the 24 hours stays one mail: the day's bound is by design", async () => {
    rpc.lamports = LOW;
    await run();
    at(HOUR);
    rpc.lamports = 0;
    await run();
    expect(mails).toHaveLength(2);
  });

  it("the same chain twice is one read; x402 on another chain is read and marked on its own", async () => {
    await run();
    expect(rpc.reads).toEqual(["solana-devnet"]);
    rpc.reads = [];
    vi.stubEnv("X402_PAYMENT_CHAIN", "solana");
    rpc.lamports = LOW;
    await run();
    expect(rpc.reads.sort()).toEqual(["solana", "solana-devnet"]);
    expect([...store.keys()].sort()).toEqual(["ops/fee-payer-low-solana-devnet.txt", "ops/fee-payer-low-solana.txt"]);
    expect(mails.map((m) => /on (\S+) holds/.exec(m.text)![1]).sort()).toEqual(["solana", "solana", "solana-devnet", "solana-devnet"]);
  });

  it("the mail holds no key and no address, and the answer neither", async () => {
    rpc.lamports = LOW;
    const res = await run();
    const said = JSON.stringify([mails, await res.json()]);
    expect(said).not.toContain(SECRET);
    expect(said).not.toContain(key.publicKey.toBase58());
  });

  it("refuses to run without recipients, a mail sender or a store for its state, and reads nothing", async () => {
    for (const name of ["OPS_ALERT_EMAILS", "RESEND_API_KEY", "BLOB_READ_WRITE_TOKEN"]) {
      vi.stubEnv(name, "");
      expect((await run()).status, name).toBe(503);
      vi.stubEnv(name, "set");
    }
    expect(rpc.reads).toEqual([]);
  });

  it("is scheduled hourly at a fixed minute", () => {
    const crons = JSON.parse(readFileSync(join(__dirname, "..", "..", "vercel.json"), "utf8")).crons as { path: string; schedule: string }[];
    expect(crons.find((c) => c.path === "/api/cron/fee-payer")?.schedule).toBe("17 * * * *");
  });
});
