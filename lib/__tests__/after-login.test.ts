import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { readSource } from "./_read-source";
import { AFTER_LOGIN, BACK_TO_RECOVERY, dropAfterLogin, openLogin, takeAfterLogin } from "@/lib/openLogin";

/**
 * DEC-501 (Kev, 2026-10-29: "be logged in, want to change MFA settings, be asked to log in again, get sent to home
 * screen: that is wrong, i gotta be sent back to the settings"): Settings asks for the fresh login with its own tab as
 * the way back, every login exit honours it once, and the shell opens that tab.
 */
const src = (...p: string[]) => readSource(join(__dirname, "..", "..", ...p));

function stubBrowser() {
  const m = new Map<string, string>();
  vi.stubGlobal("sessionStorage", { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) });
  const assign = vi.fn();
  vi.stubGlobal("window", { dispatchEvent: () => false, location: { assign } });
  vi.stubGlobal("CustomEvent", class { constructor(public type: string) {} });
  return m;
}
afterEach(() => vi.unstubAllGlobals());

describe("a login Settings asked for", () => {
  it("keeps the way back until a login takes it, once; a login opened without one drops an old one", () => {
    const m = stubBrowser();
    openLogin(BACK_TO_RECOVERY);
    expect(m.get(AFTER_LOGIN)).toBe("/home?settings=recovery");
    expect(takeAfterLogin()).toBe("/home?settings=recovery");
    expect(takeAfterLogin()).toBe("/home");
    openLogin("/home?settings=profile");
    openLogin();
    expect(takeAfterLogin()).toBe("/home");
  });

  // Review 2026-10-29: a dismissed re-login, then log-off, then the landing's own Log in landed on Settings.
  it("drops the way back when the login window closes untaken or the account logs off", () => {
    const m = stubBrowser();
    openLogin(BACK_TO_RECOVERY);
    dropAfterLogin();
    expect(m.has(AFTER_LOGIN)).toBe(false);
    const home = src("components", "enki-shell", "EnkiHome.tsx");
    expect(home).toContain("<LoginModal open={loginOpen} prewarm={!authed} onClose={() => { setLoginOpen(false); dropAfterLogin(); }} />");
    // The log-off itself is hooks/useLogoff.ts since DEC-2026-11-08-42, shared by the shell and Settings.
    expect(src("hooks", "useLogoff.ts")).toMatch(/forgetDrafts\(window\.sessionStorage, null\); \} catch \{[^}]*\}\n\s+dropAfterLogin\(\);\n\s+window\.location\.href = "\/";/);
  });

  it("never leaves the site from the wallet login either", () => {
    const m = stubBrowser();
    m.set(AFTER_LOGIN, "//evil.example");
    expect(takeAfterLogin()).toBe("/home");
    expect(src("components", "WalletPickerModal.tsx")).toContain("setTimeout(() => { window.location.href = takeAfterLogin(); }, 750);");
  });

  it("is asked for by every Settings control that needs a fresh login", () => {
    expect(src("components", "settings", "CodeFactors.tsx")).toContain("if (body.reauth) openLogin(BACK_TO_RECOVERY);");
    expect(src("components", "settings", "RecoveryPanel.tsx")).toContain("if (e instanceof StepUpNeeded && e.reauth) openLogin(BACK_TO_RECOVERY);");
    expect(src("components", "settings", "StepUpActionsTable.tsx")).toContain("if (body.reauth) openLogin(BACK_TO_RECOVERY);");
    expect(src("components", "settings", "use-account.ts")).toContain('if (body.reauth) openLogin("/home?settings=profile");');
  });

  // Read by linkedPanel with Inbox's and Studio's tabs since 2026-10-30 (lib/ui/kit/__tests__/shell-nav.test.ts,
  // lib/__tests__/shell-menu.test.ts). Since the panel is in the address (Back is the browser's, 2026-10-30), a reload
  // stays on it; Home and every other panel write it out (panelLink).
  it("opens the shell's Settings on that tab, from the address", () => {
    expect(src("components", "enki-shell", "EnkiHome.tsx")).toContain("const at = panelOf(search);");
    expect(src("lib", "ui", "kit", "shell-nav.ts")).toMatch(/const tab = search\.get\("tab"\) \?\? undefined;[\s\S]*?if \(id && PANELS\.includes\(id\)\) return \{ id, tab \};\n\s+const linked = linkedPanel\(search\);/);
  });
});
