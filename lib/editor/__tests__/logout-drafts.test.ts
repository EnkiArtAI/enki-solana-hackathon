import { describe, it, expect, vi } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";
import { draftKey, draftsWithWords, forgetDrafts } from "../draft-store";
import { stashSeed, SEED_PREFIX } from "../editor-seed";

/**
 * DEC-473 (Kev, 2026-10-28: "delete editor drafts on logout"): a log-off leaves no editor work on this browser, every
 * account's drafts and handovers, and the dialog says first how many unreleased drafts it takes.
 */
const store = (items: Record<string, string>) => {
  const s: Record<string, string> = { ...items };
  // Own enumerable keys are the stored items, as Object.keys(localStorage) lists them.
  Object.defineProperties(s, {
    getItem: { value: (k: string) => (k in items && k in s ? s[k] : null) },
    setItem: { value: (k: string, v: string) => { s[k] = v; } },
    removeItem: { value: (k: string) => { delete s[k]; } },
  });
  return s as Record<string, string> & Storage;
};
const draft = (prompt: string) => JSON.stringify({ doc: { prompt }, listing: {}, picks: {}, stars: {}, order: [] });

describe("draftsWithWords", () => {
  it("counts every account's drafts that hold words, nothing else", () => {
    const s = store({
      [draftKey("acct-a", null)]: draft("a fox in the snow"),
      [draftKey("acct-a", "p1")]: draft("   "),
      [draftKey("acct-b", "p2")]: draft("a castle"),
      [draftKey("acct-c", "p3")]: "not json",
      "theme": "light",
      [`${SEED_PREFIX}acct-a`]: JSON.stringify({ kind: "library", title: "t", promptText: "x" }),
    });
    expect(draftsWithWords(s)).toBe(2);
    expect(draftsWithWords(null)).toBe(0);
  });
});

describe("forgetDrafts", () => {
  it("takes every draft and every handover of every account, the drafts' database too, and leaves the rest", () => {
    const s = store({ [draftKey("acct-a", null)]: draft("a"), [draftKey("acct-b", "p")]: draft("b"), theme: "light", enki_session_token: "t" });
    stashSeed(s, "acct-a", { kind: "library", title: "t", promptText: "x" });
    const idb = { deleteDatabase: vi.fn() };
    forgetDrafts(s, idb as unknown as IDBFactory);
    expect(Object.keys(s).sort()).toEqual(["enki_session_token", "theme"]);
    expect(idb.deleteDatabase).toHaveBeenCalledWith("enki-prompt-editor");
  });

  it("works without either storage", () => {
    expect(() => forgetDrafts(null, null)).not.toThrow();
  });
});

describe("the log-off dialog", () => {
  const home = readSource(join(__dirname, "..", "..", "..", "components", "enki-shell", "EnkiHome.tsx"));
  // The log-off itself is hooks/useLogoff.ts since DEC-2026-11-08-42, shared by the shell and Settings; the dialog stays.
  const hook = readSource(join(__dirname, "..", "..", "..", "hooks", "useLogoff.ts"));

  it("counts the drafts as it opens, says how many go, and deletes them once the sign-out ran", () => {
    expect(hook).toContain("setLogoffDrafts(draftsWithWords(typeof window === \"undefined\" ? null : window.localStorage));");
    expect(home).toContain("const { logoffOpen, setLogoffOpen, logoffBusy, logoffDrafts, askLogoff, doLogoff } = useLogoff();");
    expect(home).toContain("onLogoff={authed ? askLogoff : undefined}");
    expect(home).toMatch(/\{logoffDrafts > 0 && \(\n\s+<p className="ek-logoff-drafts" role="alert"/);
    // A draft of a released prompt that was only opened counts too, so the sentence claims no unreleased work (DEC-479).
    expect(home).toContain("will be deleted from this device. What you released stays on Enki; release a draft first to keep its changes.");
    expect(home).not.toMatch(/unreleased draft/);
    const off = hook.slice(hook.indexOf("const doLogoff = async () => {"), hook.indexOf('window.location.href = "/";'));
    expect(off.indexOf("emailLogout();")).toBeGreaterThan(-1);
    expect(off.indexOf('try { forgetDrafts(window.localStorage, typeof indexedDB === "undefined" ? null : indexedDB); } catch {')).toBeGreaterThan(off.indexOf("emailLogout();"));
    // The handovers to the editor wait in this tab's sessionStorage (editorBridge), and go too (review wf_794afa1b-83d).
    expect(off).toContain("try { forgetDrafts(window.sessionStorage, null); } catch {");
    expect(readSource(join(__dirname, "..", "..", "..", "components", "enki-shell", "editorBridge.ts"))).toContain("try { return window.sessionStorage; } catch { return null; }");
  });

  it("signs out every way in, the server session first, and the redirect waits for it whatever fails", () => {
    expect(hook).toMatch(/setLogoffBusy\(true\);\s+try \{\s+await solanaLogout\(\);\s+emailLogout\(\);\s+if \(adapterConnected\) await adapterDisconnect\(\)\.catch\(\(\) => \{\}\);\s+\} finally \{/);
    expect(hook).toContain("const { logout: emailLogout } = useEmailAuth();");
    expect(hook).toContain("const { logout: solanaLogout } = useSolanaAuth();");
    expect(hook).toContain("const { connected: adapterConnected, disconnect: adapterDisconnect } = useWallet();");
    // Esc closes the dialog, which the shell draws: its listener stays with it, heard first (lib/__tests__/esc-top-layer.test.ts).
    expect(home).toMatch(/if \(!logoffOpen\) return;\n\s+const onKey = \(e: KeyboardEvent\) => \{ if \(e\.key === "Escape"\) \{ e\.stopPropagation\(\); setLogoffOpen\(false\); \} \};\n\s+window\.addEventListener\("keydown", onKey, true\);/);
  });
});
