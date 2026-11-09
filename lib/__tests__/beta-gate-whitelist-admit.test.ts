import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";
import { admitsOnceWhitelistEnded } from "@/components/BetaGate";

/**
 * SOC-8: once the whitelist stage has ended (TEAM_ACCESS_CODE unset),
 * BetaGate admits every signed-in, non-banned account regardless of role.
 * During the stage, nothing changes.
 *
 * admitsOnceWhitelistEnded is a real, exported pure function — tested here
 * behaviorally, not by source regex, because it is the one piece of this
 * ticket's logic that doesn't need a rendered component to verify. The
 * surrounding wiring (which call site passes activeAccount, the ban branch,
 * PUBLIC_PATHS) is still only regex-checkable, matching this repo's existing
 * pattern for client components the suite can't render (see
 * beta-gate-recheck.test.ts, banned-door.test.ts).
 */

describe("admitsOnceWhitelistEnded", () => {
  it("admits a confirmed account once the stage has ended", () => {
    expect(admitsOnceWhitelistEnded(true, false)).toBe(true);
  });

  it("still requires the role/allowlist rules while the stage is active", () => {
    expect(admitsOnceWhitelistEnded(true, true)).toBe(false);
  });

  it("never admits a plain visitor (no confirmed account), stage or no stage", () => {
    expect(admitsOnceWhitelistEnded(false, false)).toBe(false);
    expect(admitsOnceWhitelistEnded(false, true)).toBe(false);
  });
});

describe("BetaGate wiring (SOC-8)", () => {
  const GATE = readSource(join(__dirname, "..", "..", "components", "BetaGate.tsx"));

  it("passes activeAccount=true only from the role-mismatch branch, where a real account was already confirmed", () => {
    expect(GATE).toContain("else void teamFallback(true);");
  });

  // Kev, 2026-10-27: "warum kann ich das hier anschauen obwohl ich nicht logged in bin??? eig sollte da ja eher
  // landing page kommen und gar nicht erst enki aufzeigen".
  it("sends a signed-out visitor to the landing, team cookie or not: no session never reaches teamFallback", () => {
    expect(GATE).toMatch(/if \(Object\.keys\(headers\)\.length === 0\) \{[^}]*forgetPill\(\);\s*setAccess\("out"\);\s*return \(\) => \{ dead = true; \};/);
    expect(GATE.slice(GATE.indexOf("if (Object.keys(headers).length === 0) {"), GATE.indexOf("(async () => {"))).not.toContain("teamFallback");
    expect(GATE).toMatch(/useEffect\(\(\) => \{\n\s+if \(access === "out" && !isPublic\) router\.replace\("\/"\);\n\s+\}, \[access, isPublic, router\]\);/);
    // Nothing of the app renders meanwhile: "out" is neither "ok" nor "denied".
    expect(GATE).toMatch(/\{isPublic \|\| access === "ok" \? \(\n\s+children\n\s+\) : access === "denied" \? \(\n\s+<PrivateBetaWindow \/>\n\s+\) : \(\n\s+<div style=\{\{ minHeight: "100vh" \}\} \/>/);
    expect(GATE).toContain('access: "checking" | "ok" | "denied" | "out";');
  });

  // Review 2026-10-27: a dead wallet session (solana-auth-session) answered 401 "Not signed in", forgetSession cleared
  // nothing for it (it clears the email token only), and teamFallback then opened the app with the team cookie.
  it("sends the route's own 401 Not signed in to the landing, whichever login stored the session", () => {
    expect(GATE).toMatch(/\?\.error === "Not signed in"\) \{\n\s+forgetSession\(headers\["X-Session-Token"\]\);\n\s+forgetPill\(\);\n\s+if \(!dead\) setAccess\("out"\);\n\s+return;\n\s+\}/);
  });

  // Review 2026-10-27: a login on a public page (reset-password) then a hop to /home before the check answered met the
  // stale "out" and was sent to the landing.
  it("drops a stale out when a session appears, so the redirect waits for the check", () => {
    expect(GATE).toMatch(/setAccess\(\(a\) => \(a === "out" \? "checking" : a\)\);\n\s+\(async \(\) => \{\n\s+try \{\n\s+const res = await fetch\("\/api\/users\/handle", \{ headers \}\);/);
  });

  it("the failed-request / non-ok-response branches still call teamFallback with no argument (unchanged)", () => {
    expect(GATE).toMatch(/if \(!res\.ok\) \{ if \(res\.status === 401\) forgetPill\(\); void teamFallback\(\); return; \}/);
    expect(GATE).toMatch(/\} catch \{\s*if \(!dead\) void teamFallback\(\);\s*\}/);
  });

  it("the banned-account 403 branch is untouched: still fires before any role/whitelist decision", () => {
    expect(GATE).toMatch(/if \(res\.status === 403 && \(await res\.json\(\)\.catch\(\(\) => null\)\)\?\.banned\) \{\n\s+if \(window\.location\.pathname !== "\/banned"\) window\.location\.href = "\/banned";/);
  });

  it("whitelistActive defaults to true (still active) when /api/gate's answer is missing or malformed", () => {
    expect(GATE).toContain('const whitelistActive = d?.whitelistActive !== false;');
  });
});
