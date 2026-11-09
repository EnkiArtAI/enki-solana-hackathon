import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { readSource } from "@/lib/__tests__/_read-source";
import { isSessionStorageKey } from "@/lib/session-headers";

/**
 * BetaGate re-checked on EVERY storage event from another tab and blanked the
 * page while it did. The editors autosave every 400 ms, so typing in one tab
 * unmounted the whole app in every other tab, an open Editor 2 graph with it
 * (Kev, 2026-10-06).
 */

const ROOT = join(__dirname, "..", "..");
const GATE = readSource(join(ROOT, "components", "BetaGate.tsx"));

describe("which storage changes re-check the session", () => {
  it("a session key, or the whole store cleared", () => {
    for (const key of ["enki_session_token", "turnkey_session_token", "solana-auth-session", null]) {
      expect(isSessionStorageKey(key)).toBe(true);
    }
  });

  it("never an editor draft, the 18+ pill or the theme", () => {
    for (const key of ["symphora-editor-draft-v1", "enki-node-creator-draft", "enki:show-adult", "theme"]) {
      expect(isSessionStorageKey(key)).toBe(false);
    }
  });

  it("every key sessionAuthHeaders reads a session from", () => {
    const src = readFileSync(join(ROOT, "lib", "session-headers.ts"), "utf8");
    const body = src.slice(src.indexOf("export function sessionAuthHeaders"), src.indexOf("/** The localStorage keys"));
    const keys = [...body.matchAll(/localStorage\.getItem\("([^"]+)"\)/g)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) expect(isSessionStorageKey(key)).toBe(true);
  });
});

describe("BetaGate", () => {
  it("re-checks on a storage event only for a session key", () => {
    expect(GATE).toMatch(/const onStorage = \(e: StorageEvent\) => \{ if \(isSessionStorageKey\(e\.key\)\) rerun\(\); \};/);
    expect(GATE).toMatch(/window\.addEventListener\("storage", onStorage\);/);
    expect(GATE).not.toMatch(/addEventListener\("storage", rerun\)/);
  });

  it("keeps the page mounted while it re-checks", () => {
    expect(GATE).toMatch(/const rerun = \(\) => setTick\(\(t\) => t \+ 1\);/);
    expect(GATE).not.toMatch(/setAccess\("checking"\)/);
  });
});

/**
 * A session the server no longer knows (24 h) stayed in localStorage: the menu
 * named the account from its stored email while every page treated the viewer
 * as signed out (Kev, 2026-10-21).
 */
describe("a dead session", () => {
  it("leaves this browser when the route says it is not signed in", () => {
    expect(GATE).toContain('if (res.status === 401 && (await res.clone().json().catch(() => null))?.error === "Not signed in") {\n          forgetSession(headers["X-Session-Token"]);');
    expect(GATE).toContain('import { forgetSession } from "@/hooks/useEmailAuth";');
  });

  /** A banned account has no team cookie, so the proxy answers every closed API with its own 401: that one keeps the session, or /banned could not appeal (review, 2026-10-21). */
  it("keeps it on the proxy's 401, whose words differ from the route's", () => {
    // The GET without ?name= is the check BetaGate makes.
    const src = readSource(join(ROOT, "app", "api", "users", "handle", "route.ts"));
    const route = src.slice(src.indexOf("if (name === null) {"), src.indexOf("const wantStats"));
    const proxy = readSource(join(ROOT, "proxy.ts"));
    expect(route).toContain('if (!userId) return revokeGateCookie(NextResponse.json({ error: "Not signed in" }, { status: 401 }));');
    expect(proxy).toContain('JSON.stringify({ error: "Access code required" })');
    expect(GATE).not.toMatch(/if \(res\.status === 401\) forgetSession/);
  });

  it("takes the name the menu showed with it once the check finds no session", () => {
    const out = GATE.slice(GATE.indexOf("if (Object.keys(headers).length === 0) {"), GATE.indexOf("(async () => {"));
    expect(out).toContain("setHandleState(undefined);");
    expect(out).toContain("setProfile(null);");
    expect(out).toContain("setMeId(null);");
  });
});

/** Kev (2026-10-21): no more "the menu names me, the page says I am signed out". One verdict everywhere. */
describe("who counts as signed in", () => {
  const HOME = readSource(join(ROOT, "components", "enki-shell", "EnkiHome.tsx"));
  const PROFILE = readSource(join(ROOT, "components", "profile", "ProfileView.tsx"));

  it("is the session the server confirmed, in the menu and on the profile alike", () => {
    expect(HOME).toContain('const authed = access === "ok" && role !== "team";');
    expect(PROFILE).toContain('const isAuthed = access === "ok" && role !== "team";');
  });

  it("names nobody in the menu before that: a stored email or a connected wallet alone shows Guest", () => {
    expect(HOME).toContain("account={authed ? { name, handle } : GUEST}");
    expect(HOME).toContain('const GUEST = { name: "Guest", handle: "guest" };');
    expect(PROFILE).not.toContain("!!walletAddress || (access");
  });
});
