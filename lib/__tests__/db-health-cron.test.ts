import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * ENG-08. A database outage reaches a human exactly once, its end exactly
 * once, and neither the recipients nor the "already told" state live in the
 * database that is down. An outage is two runs in a row without an answer,
 * each after three tries: twice in October one lost request mailed
 * "unreachable" and the next run mailed "back" (Kev, 2026-10-16).
 */

let dbUp = true;
// Answers for the next tries, first in first; dbUp once they run out.
let script: boolean[] = [];
let tries = 0;
vi.mock("@/lib/supabaseServer", () => ({
  getSupabaseServerClient: () => {
    const q = {
      from: () => q, select: () => q, limit: () => q,
      abortSignal: async () => {
        tries++;
        const answers = script.length ? script.shift()! : dbUp;
        return answers ? { data: [], error: null } : { data: null, error: { code: "PGRST002", message: "Could not query the database for the schema cache" } };
      },
    };
    return q;
  },
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
vi.mock("@vercel/blob", () => ({
  list: async ({ prefix }: { prefix: string }) => ({
    blobs: [...store].filter(([p]) => p.startsWith(prefix)).map(([pathname, uploadedAt]) => ({ pathname, uploadedAt, url: `https://blob.test/${pathname}` })),
  }),
  put: async (pathname: string) => { store.set(pathname, new Date()); return { url: `https://blob.test/${pathname}` }; },
  del: async (url: string) => { store.delete(url.replace("https://blob.test/", "")); },
}));

import { GET } from "../../app/api/cron/db-health/route";

/** One scheduled run; the retries wait on fake timers. */
const run = async () => {
  const res = GET(new NextRequest("http://enki.test/api/cron/db-health", { headers: { authorization: "Bearer cron-secret" } }));
  await vi.runAllTimersAsync();
  return res;
};
const subjects = () => mails.map((m) => m.subject);

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
  dbUp = true;
  script = [];
  tries = 0;
  mailWorks = true;
  mails.length = 0;
  store.clear();
  process.env.CRON_SECRET = "cron-secret";
  process.env.OPS_ALERT_EMAILS = "ops@enki.test, kev@enki.test";
  process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_test";
  process.env.RESEND_API_KEY = "re_test";
  process.env.SUPABASE_URL = "https://db.enki.test";
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the database outage alert", () => {
  it("says nothing while the database answers, and asks it once a run", async () => {
    await run();
    await run();
    expect(mails).toEqual([]);
    expect(tries).toBe(2);
  });

  it("a request the database drops is tried again in the same run, and is no outage", async () => {
    script = [false, false];
    const res = await run();
    expect(await res.json()).toEqual({ up: true });
    expect(tries).toBe(3);
    expect(store.size).toBe(0);
  });

  it("waits five seconds before it asks again", async () => {
    script = [false, true];
    const res = GET(new NextRequest("http://enki.test/api/cron/db-health", { headers: { authorization: "Bearer cron-secret" } }));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(tries).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(tries).toBe(2);
    await vi.runAllTimersAsync();
    expect(await (await res).json()).toEqual({ up: true });
  });

  it("one run without an answer and the next with one mail nothing (the October case)", async () => {
    dbUp = false;
    await run();
    expect(tries).toBe(3);
    expect(mails).toEqual([]);
    expect([...store.keys()]).toEqual(["ops/db-suspect.txt"]);
    dbUp = true;
    await run();
    expect(mails).toEqual([]);
    expect(store.size).toBe(0);
  });

  it("two runs in a row without an answer mail every recipient once, with the error; once more when it is back", async () => {
    dbUp = false;
    await run();
    await run();
    expect(mails.map((m) => [m.to, m.subject])).toEqual([
      ["ops@enki.test", "Enki: database unreachable"],
      ["kev@enki.test", "Enki: database unreachable"],
    ]);
    expect(mails[0].text).toContain("Last error: PGRST002 Could not query the database for the schema cache.");
    expect(mails[0].text).toContain("in two runs a minute apart (3 tries each)");
    expect([...store.keys()]).toEqual(["ops/db-down.txt"]);
    await run();
    await run();
    expect(mails).toHaveLength(2);

    dbUp = true;
    await run();
    expect(subjects().slice(2)).toEqual(["Enki: database back", "Enki: database back"]);
    expect(store.size).toBe(0);
    await run();
    expect(mails).toHaveLength(4);
  });

  it("answers the scheduler with the error a run met", async () => {
    dbUp = false;
    const res = await run();
    expect(await res.json()).toEqual({ up: false, error: "PGRST002 Could not query the database for the schema cache" });
    expect(console.error).toHaveBeenCalledWith("[db-health] the database did not answer:", "PGRST002 Could not query the database for the schema cache");
  });

  it("retries an alert that could not be sent", async () => {
    dbUp = false;
    await run();
    mailWorks = false;
    await run();
    mailWorks = true;
    await run();
    expect(subjects()).toEqual(["Enki: database unreachable", "Enki: database unreachable"]);
  });

  it("retries an all clear that could not be sent", async () => {
    dbUp = false;
    await run();
    await run();
    dbUp = true;
    mailWorks = false;
    await run();
    mailWorks = true;
    await run();
    expect(subjects().slice(2)).toEqual(["Enki: database back", "Enki: database back"]);
  });

  it("refuses to run without recipients, a mail sender or a store for its state", async () => {
    for (const key of ["OPS_ALERT_EMAILS", "RESEND_API_KEY", "BLOB_READ_WRITE_TOKEN"]) {
      const kept = process.env[key];
      delete process.env[key];
      expect((await run()).status, key).toBe(503);
      process.env[key] = kept;
    }
  });

  it("refuses a caller that is not the scheduler", async () => {
    dbUp = false;
    const res = await GET(new NextRequest("http://enki.test/api/cron/db-health"));
    expect(res.status).toBe(401);
    expect(mails).toEqual([]);
  });
});
