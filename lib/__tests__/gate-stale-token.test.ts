import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { readSource } from "./_read-source";

/**
 * Review wf_866ba07b-01a (DEC-434): a dead token left in the browser must never be the one sent right after a new
 * login, or its "Not signed in" takes the access cookie that login just set. Both logins clear the other identity
 * before the shell can ask; the OAuth handover clears it before it collects the new session.
 */
const ROOT = join(__dirname, "..", "..");

describe("one identity at a time, before the shell asks", () => {
  it("the OAuth handover forgets the old session before it collects the new one", () => {
    const page = readSource(join(ROOT, "app", "auth", "complete", "page.tsx"));
    const fetchAt = page.indexOf('fetch("/api/auth/oauth/complete", { method: "POST" })');
    expect(fetchAt).toBeGreaterThan(-1);
    for (const key of ["solana-auth-session", "enki_session_token", "enki_session_email"]) {
      const at = page.indexOf(`localStorage.removeItem("${key}");`);
      expect(at, key).toBeGreaterThan(-1);
      expect(at, key).toBeLessThan(fetchAt);
    }
  });

  it("a wallet login drops an email session before it stores its own", () => {
    const hook = readSource(join(ROOT, "hooks", "useSolanaAuth.ts"));
    const store = hook.indexOf("localStorage.setItem(SOLANA_AUTH_KEY, JSON.stringify(stored));");
    for (const key of ["enki_session_token", "enki_session_email"]) {
      const at = hook.indexOf(`localStorage.removeItem("${key}");`);
      expect(at, key).toBeGreaterThan(-1);
      expect(at, key).toBeLessThan(store);
    }
  });
});
