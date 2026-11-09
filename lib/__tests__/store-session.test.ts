import { describe, it, expect, vi, beforeEach } from "vitest";
import { forgetSession, storeSession } from "@/hooks/useEmailAuth";

/**
 * Every login stores its session the same way (password, Google, X). A new
 * session replaces the previous account's email too: an X login carries none,
 * and the email left behind would name, and key the wallet of, someone else.
 */
const local = new Map<string, string>();
beforeEach(() => {
  local.clear();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => local.get(k) ?? null,
    setItem: (k: string, v: string) => void local.set(k, v),
    removeItem: (k: string) => void local.delete(k),
  });
  vi.stubGlobal("window", { dispatchEvent: fired });
  fired.mockClear();
});
const fired = vi.fn(() => true);

describe("storeSession", () => {
  it("stores the token and the email of a password login", () => {
    storeSession({ token: "a", email: "kev@example.com" });
    expect(Object.fromEntries(local)).toEqual({ enki_session_token: "a", enki_session_email: "kev@example.com" });
  });

  it("drops the previous account's email when the new session has none", () => {
    storeSession({ token: "a", email: "kev@example.com" });
    storeSession({ token: "b" });
    expect(Object.fromEntries(local)).toEqual({ enki_session_token: "b" });
  });

  it("changes nothing without a token", () => {
    storeSession({ token: "a", email: "kev@example.com" });
    storeSession({});
    expect(Object.fromEntries(local)).toEqual({ enki_session_token: "a", enki_session_email: "kev@example.com" });
  });
});

describe("forgetSession", () => {
  const signedIn = () => storeSession({ token: "t1", email: "kev@example.com" });

  it("drops the session the server no longer knows, and says so", () => {
    signedIn();
    fired.mockClear();
    forgetSession("t1");
    expect(Object.fromEntries(local)).toEqual({});
    expect(fired).toHaveBeenCalledOnce();
  });

  it("keeps a login stored while the dead one was being checked", () => {
    storeSession({ token: "t2", email: "kev@example.com" });
    fired.mockClear();
    forgetSession("t1");
    expect(Object.fromEntries(local)).toEqual({ enki_session_token: "t2", enki_session_email: "kev@example.com" });
    expect(fired).not.toHaveBeenCalled();
  });

  it("drops whatever is stored on a logout", () => {
    signedIn();
    forgetSession();
    expect(Object.fromEntries(local)).toEqual({});
  });
});
