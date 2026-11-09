import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";

/**
 * Kev (2026-10-21): stay signed in as an email, Google or X user; a wallet
 * user is signed out as before. Email, Google and X sessions come from
 * mintUserSession; a wallet signature mints its own in /api/auth/session.
 */
const ROOT = join(__dirname, "..", "..");
const MINT = readSource(join(ROOT, "lib", "user-session.ts"));
const WALLET = readSource(join(ROOT, "app", "api", "auth", "session", "route.ts"));
const DAY = 24 * 60 * 60 * 1000;

describe("how long a session lasts", () => {
  it("is 30 days for an email, Google or X login; the access cookie ends with the session", async () => {
    const { SESSION_TTL_MS } = await import("@/lib/user-session");
    expect(SESSION_TTL_MS).toBe(30 * DAY);
    // A trial login's session ends with its trial instead (lib/trial): the default stays the 30 days.
    expect(MINT).toContain("export async function mintUserSession(userId: string, ipHash?: string | null, ttlMs = SESSION_TTL_MS) {");
    expect(MINT).toContain("const expiresAt = new Date(Date.now() + ttlMs).toISOString();");
    // DEC-434: the member cookie is signed until the session it came with ends.
    const allow = readSource(join(ROOT, "lib", "allowlist.ts"));
    expect(allow).toContain("const until = Date.parse(sessionExpiresAt);");
    expect(allow).toContain("res.cookies.set(COOKIE, signTrial(\"member\", subject, until, pepper), {");
    expect(allow).toContain("    maxAge: Math.max(0, Math.floor((until - Date.now()) / 1000)),");
  });

  it("is 24 h for a wallet signature", () => {
    expect(WALLET).toContain("const SESSION_TTL_MS = 24 * 60 * 60 * 1000;");
    expect(WALLET).not.toContain("@/lib/user-session");
  });

  it("covers every email, Google and X login path", () => {
    for (const path of [["lib", "password-login.ts"], ["app", "api", "auth", "password", "register", "route.ts"], ["lib", "password-reset.ts"], ["app", "api", "auth", "oauth", "[provider]", "callback", "route.ts"]]) {
      expect(readSource(join(ROOT, ...path))).toContain("await mintUserSession(");
    }
  });
});
