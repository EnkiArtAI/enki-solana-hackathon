import { describe, it, expect, vi } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";

/**
 * The landing's login is real (Kev, 2026-10-07): email + password log in and
 * open the app at once. Sign-up is wired but closed in the private beta: the
 * access form takes applications; opened, it creates the account and falls
 * back to the application for an email not on the access list. The
 * page is static HTML: the login is read from its script (and was run in a
 * browser against the dev server); the sign-up script runs for real against
 * a small fake DOM, closed as it ships and opened as it will be.
 */

const LANDING = readFileSync(join(__dirname, "..", "..", "public", "landing.html"), "utf8");
const fn = (name: string) => {
  const start = LANDING.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  return LANDING.slice(start, LANDING.indexOf("\n}\n", start));
};

// The page's sign-up script (postJson … showInlineNote), run against a fake
// DOM with SIGNUP_OPEN as given; fetch answers per URL.
type El = {
  style: { display: string }; textContent: string; value: string; required: boolean; disabled: boolean;
  classList: { add(): void; remove(): void }; listeners: Record<string, () => void>; note: El | null; parent?: El;
  className?: string; addEventListener(t: string, f: () => void): void; querySelector(): El | null;
  insertBefore(n: El): void; remove(): void;
};
function runSignup(open: boolean) {
  const els = new Map<string, El>();
  const make = (): El => {
    const e: El = {
      style: { display: "" }, textContent: "", value: "", required: false, disabled: false,
      classList: { add() {}, remove() {} }, listeners: {}, note: null,
      addEventListener: (t, f) => { e.listeners[t] = f; },
      querySelector: () => e.note,
      insertBefore: (n) => { e.note = n; n.parent = e; },
      remove: () => { if (e.parent) e.parent.note = null; },
    };
    return e;
  };
  const el = (id: string) => { if (!els.has(id)) els.set(id, make()); return els.get(id)!; };
  const answers = new Map<string, { ok: boolean; body: unknown }>();
  const posts: { url: string; body: unknown }[] = [];
  const adopted: unknown[] = [];
  const switched: string[] = [];
  const fetch = vi.fn(async (url: string, init: { body: string }) => {
    posts.push({ url, body: JSON.parse(init.body) });
    const a = answers.get(url) ?? { ok: true, body: {} };
    return { ok: a.ok, json: async () => a.body };
  });
  const start = LANDING.indexOf("function postJson(");
  const end = LANDING.indexOf("\n}\n", LANDING.indexOf("function showInlineNote(")) + 3;
  const script = LANDING.slice(start, end).replace("const SIGNUP_OPEN = false;", `const SIGNUP_OPEN = ${open};`);
  expect(script).toContain(`const SIGNUP_OPEN = ${open};`);
  const page = new Function(
    "document", "fetch", "adoptSession", "switchAuthTab", "showAuthSuccess",
    `${script}\nreturn { submitAuth, submitFirstLogin, submitInvite, step: () => signupStep };`,
  )({ getElementById: el, createElement: make }, fetch, (d: unknown) => adopted.push(d), (tab: string) => switched.push(tab), () => {});
  return {
    el, posts, adopted, switched,
    step: page.step as () => string,
    submit: () => page.submitAuth({ preventDefault() {} }, "signup"),
    login: () => page.submitAuth({ preventDefault() {} }, "login"),
    firstLogin: () => page.submitFirstLogin({ preventDefault() {} }),
    invite: () => page.submitInvite({ preventDefault() {} }),
    answer: (url: string, ok: boolean, body: unknown) => answers.set(url, { ok, body }),
  };
}
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };
const fakeSession = (init: Record<string, string> = {}) => {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), has: (k: string) => m.has(k) };
};

// DEC-501 (Kev, 2026-10-29: "be asked to log in again, get sent to home screen: that is wrong, i gotta be sent back to
// the settings"): the path the app asked for, read once and only as a path on this site.
describe("a login the app asked for lands where it asked", () => {
  const after = (stored: Record<string, string>) => {
    const session = fakeSession(stored);
    const next = new Function("sessionStorage", `${fn("afterLogin")}\n}\nreturn afterLogin();`)(session) as string;
    return { next, left: session.has("enki:after-login") };
  };

  it("goes back to Settings after a password, Google or X login, once", () => {
    expect(after({ "enki:after-login": "/home?settings=recovery" })).toEqual({ next: "/home?settings=recovery", left: false });
    expect(after({})).toEqual({ next: "/home", left: false });
    const go = vi.fn();
    const top = { location: { set href(url: string) { go(url); } } };
    new Function("window", "sessionStorage", `${fn("afterLogin")}\n}\n${fn("oauthLogin")}\n}\noauthLogin('google');`)(
      { top }, fakeSession({ "enki:after-login": "/home?settings=recovery" }));
    expect(go).toHaveBeenCalledWith("/api/auth/oauth/google/start?next=%2Fhome%3Fsettings%3Drecovery");
  });

  it("never leaves the site: another host, a scheme, a space or an overlong path lands on Home", () => {
    for (const bad of ["//evil.example", "/\\evil.example", "https://evil.example", "/a b", "home", `/${"a".repeat(512)}`]) {
      expect(after({ "enki:after-login": bad }).next).toBe("/home");
    }
  });
});

describe("the landing login", () => {
  it("logs in with the password and opens the app with the session", () => {
    expect(fn("submitAuth")).toMatch(/postJson\('\/api\/auth\/password\/login', \{ identifier: email, password: /);
    expect(fn("submitAuth")).toMatch(/if \(ok && data\.token\) return adoptSession\(data\);/);
    const adopt = fn("adoptSession");
    expect(adopt).toMatch(/localStorage\.setItem\('enki_session_token', d\.token\)/);
    expect(adopt).toMatch(/localStorage\.setItem\('enki_session_email', d\.email\)/);
    expect(adopt).toMatch(/localStorage\.removeItem\('solana-auth-session'\)/);
    expect(adopt).toMatch(/sessionStorage\.setItem\('enki:wallet-ask', '1'\)/);
    expect(adopt).toMatch(/location\.href = d\.banned \? '\/banned' : afterLogin\(\);/);
  });

  it("offers Google and X: the whole window goes to the provider, and /auth/complete adopts the session the same way", () => {
    expect(LANDING).toContain(`id="oauthGoogle" style="display:none" onclick="oauthLogin('google')"`);
    expect(LANDING).toContain(`id="oauthX" style="display:none" onclick="oauthLogin('x')"`);
    // hidden until the server says the provider is configured
    expect(LANDING).toContain("fetch('/api/auth/oauth/providers')");
    expect(LANDING).toContain("if (on.google) document.getElementById('oauthGoogle').style.display = '';");
    expect(LANDING).toContain("if (on.x) document.getElementById('oauthX').style.display = '';");
    // logos side by side above the email (Kev, 2026-10-17), the wallet stays below the password login
    expect(LANDING).toContain("if (on.google || on.x) document.getElementById('oauthRow').style.display = '';");
    const form = LANDING.slice(LANDING.indexOf('id="formLogin"'), LANDING.indexOf('id="formFirstLogin"'));
    expect(form.indexOf('<div id="oauthRow" style="display:none">')).toBeGreaterThan(-1);
    expect(form.indexOf('id="oauthGoogle"')).toBeLessThan(form.indexOf('id="loginEmail"'));
    expect(form.indexOf('id="oauthX"')).toBeLessThan(form.indexOf('id="loginEmail"'));
    expect(form.indexOf('onclick="walletLogin()"')).toBeGreaterThan(form.indexOf('id="submitLogin"'));
    expect(form).toContain('aria-label="Continue with Google"');
    expect(form).toContain('aria-label="Continue with X"');
    const go = vi.fn();
    const top = { location: { set href(url: string) { go(url); } } };
    new Function("window", "sessionStorage", `${fn("afterLogin")}\n}\n${fn("oauthLogin")}\n}\noauthLogin('x');`)({ top }, fakeSession());
    expect(go).toHaveBeenCalledWith("/api/auth/oauth/x/start?next=%2Fhome");
    const complete = readFileSync(join(__dirname, "..", "..", "app", "auth", "complete", "page.tsx"), "utf8");
    expect(complete).toContain('localStorage.removeItem("solana-auth-session");');
    expect(complete).toContain('sessionStorage.setItem("enki:wallet-ask", "1");');
  });

  it("takes applications only during the private beta: sign-up is wired but closed", () => {
    expect(LANDING).toMatch(/const SIGNUP_OPEN = false;/);
    expect(LANDING).toMatch(/let signupStep = 'apply';/);
    expect(LANDING).toMatch(/id="tabSignup"[^>]*>Request access</);
    expect(LANDING).toMatch(/id="signupPassField" style="display:none"/);
    expect(LANDING).toMatch(/id="signupLabel">Request access</);
  });

  it("takes an application while closed, and never creates an account", async () => {
    const page = runSignup(false);
    page.el("signupEmail").value = "new@example.com";
    page.el("appAbout").value = "I paint with prompts";
    page.submit();
    await settle();
    expect(page.posts.map((p) => p.url)).toEqual(["/api/access-request"]);
    expect(page.el("signupEmail").listeners.input).toBeUndefined();
  });

  it("once open, turns into the application for an email not on the list, and starts over when the email is corrected", async () => {
    const page = runSignup(true);
    expect([page.step(), page.el("signupPass").required, page.el("signupLabel").textContent]).toEqual(["account", true, "Create account"]);
    page.answer("/api/auth/password/register", false, { error: "not on the list", notWhitelisted: true });
    page.el("signupEmail").value = "kev@gmial.com";
    page.el("signupPass").value = "a long password";
    page.submit();
    await settle();
    expect([page.step(), page.el("signupPassField").style.display, page.el("signupPass").required, page.el("applyFields").style.display]).toEqual(["apply", "none", false, ""]);
    expect(page.el("formSignup").note?.textContent).toMatch(/isn't on the access list/);

    page.el("signupEmail").value = "kev@example.com";
    page.el("signupEmail").listeners.input();
    expect([page.step(), page.el("signupPass").required, page.el("signupLabel").textContent]).toEqual(["account", true, "Create account"]);
    expect(page.el("formSignup").note).toBeNull();
    page.answer("/api/auth/password/register", true, { token: "t", email: "kev@example.com" });
    page.submit();
    await settle();
    expect(page.posts.map((p) => p.url)).toEqual(["/api/auth/password/register", "/api/auth/password/register"]);
    expect(page.adopted).toEqual([{ token: "t", email: "kev@example.com" }]);
  });

  it("once open, checks the email in the field: one corrected while the check ran is checked again", async () => {
    const page = runSignup(true);
    page.answer("/api/auth/password/register", false, { error: "not on the list", notWhitelisted: true });
    page.el("signupEmail").value = "kev@gmial.com";
    page.el("signupPass").value = "a long password";
    page.submit(); // the answer for the typo is still on its way
    page.el("signupEmail").value = "kev@example.com";
    page.el("signupEmail").listeners.input();
    await settle();
    expect([page.step(), page.el("formSignup").note]).toEqual(["account", null]);
    page.answer("/api/auth/password/register", true, { token: "t", email: "kev@example.com" });
    page.submit();
    await settle();
    expect(page.posts.map((p) => p.url)).toEqual(["/api/auth/password/register", "/api/auth/password/register"]);
    expect(page.adopted).toEqual([{ token: "t", email: "kev@example.com" }]);
  });

  it("once open on the landing but not yet on the server, falls back to the application", async () => {
    const page = runSignup(true);
    page.answer("/api/auth/password/register", false, { error: "Sign-up opens after the private beta. Request access to join.", closed: true });
    page.el("signupEmail").value = "new@example.com";
    page.el("signupPass").value = "a long password";
    page.submit();
    await settle();
    expect(page.step()).toBe("apply");
    expect(page.el("formSignup").note?.textContent).toBe("Sign-up opens after the private beta. Request access to join.");
  });

  it("turns a login with the mailed one-time password into choosing your own, then enters", async () => {
    const page = runSignup(false);
    page.el("formFirstLogin").style.display = "none";
    page.answer("/api/auth/password/login", true, { setPassword: true });
    page.el("loginEmail").value = "New@Example.com";
    page.el("loginPass").value = "K7QM2XWB9RTPHDZA4NVC";
    page.login();
    await settle();
    expect([page.el("formLogin").style.display, page.el("formFirstLogin").style.display]).toEqual(["none", ""]);
    expect(page.el("loginPass").value).toBe(""); // the one-time password left the login field
    expect(page.adopted).toEqual([]);

    page.el("firstPass").value = "my own password";
    page.el("firstPass2").value = "my own pasword";
    page.firstLogin();
    await settle();
    expect(page.el("formFirstLogin").note?.textContent).toMatch(/differ/);
    expect(page.posts.map((p) => p.url)).toEqual(["/api/auth/password/login"]);

    page.el("firstPass2").value = "my own password";
    page.answer("/api/auth/password/first-login", true, { token: "t", email: "new@example.com" });
    page.firstLogin();
    await settle();
    expect(page.posts[1]).toEqual({
      url: "/api/auth/password/first-login",
      body: { email: "new@example.com", password: "K7QM2XWB9RTPHDZA4NVC", newPassword: "my own password" },
    });
    expect(page.adopted).toEqual([{ token: "t", email: "new@example.com" }]);
  });

  it("sends a user whose password got set, but no session, back to log in with it", async () => {
    const page = runSignup(false);
    page.answer("/api/auth/password/login", true, { setPassword: true });
    page.el("loginEmail").value = "new@example.com";
    page.el("loginPass").value = "K7QM2XWB9RTPHDZA4NVC";
    page.login();
    await settle();
    page.el("firstPass").value = page.el("firstPass2").value = "my own password";
    page.answer("/api/auth/password/first-login", false, { error: "Your password is set. Log in with it.", passwordSet: true });
    page.firstLogin();
    await settle();
    expect(page.switched).toEqual(["login"]);
    expect(page.el("formLogin").note?.textContent).toBe("Your password is set. Log in with it.");
  });

  // DEC-494, DEC-495: inside an inline handler in a form, the form's fields come first in scope, so a field with the
  // handler's name shadows it: "submitFirstLogin is not a function" (bab7d7b1..), then "walletLogin is not a function"
  // (50537716..): every handler a form or a field in it calls, never a field's id or name there.
  it("names no field of a form like a handler called in it, which the field would shadow there", () => {
    const forms = [...LANDING.matchAll(/<form [^>]*?onsubmit="[^"]*"[^>]*>[^]*?<\/form>/g)].map((m) => m[0]);
    const called = (html: string) => [...html.matchAll(/\son[a-z]+="(?:return )?(\w+)\(/g)].map((m) => m[1]);
    const named = (html: string) => new Set([...html.matchAll(/\s(?:id|name)="(\w+)"/g)].map((m) => m[1]));
    expect(forms.flatMap(called)).toEqual(expect.arrayContaining(["submitAuth", "submitFirstLogin", "submitInvite", "walletLogin", "showInvite", "oauthLogin"]));
    for (const form of forms) for (const h of called(form)) expect(named(form).has(h), h).toBe(false);
  });

  it("forgets the one-time password when the first-login step is left, or the modal opens again", () => {
    const fields = new Map<string, { value: string; style: { display: string }; classList: { toggle(): void } }>();
    const el = (id: string) => {
      if (!fields.has(id)) fields.set(id, { value: "", style: { display: "" }, classList: { toggle() {} } });
      return fields.get(id)!;
    };
    const run = new Function("document", `var firstLogin = { email: "e", password: "K7QM2XWB9RTPHDZA4NVC" };\n${fn("switchAuthTab")}\n}\n${fn("forgetFirstLogin")}\n}\nswitchAuthTab('login');\nreturn firstLogin;`);
    el("firstPass").value = el("firstPass2").value = "half typed";
    expect(run({ getElementById: el })).toBeNull();
    expect([el("firstPass").value, el("firstPass2").value, el("formFirstLogin").style.display]).toEqual(["", "", "none"]);
  });

  it("forgets it on every way the modal closes, and never on a click inside it", () => {
    const closed = (code: string, act: (h: { doc: Record<string, unknown>; key?: (e: unknown) => void; msg?: (e: unknown) => void }) => void) => {
      let forgot = 0;
      const backdrop = { classList: { remove() {}, contains: () => true } };
      const h: { doc: Record<string, unknown>; key?: (e: unknown) => void; msg?: (e: unknown) => void } = {
        doc: {
          getElementById: (id: string) => (id === "authBackdrop" ? backdrop : null),
          body: { style: {} },
          addEventListener: (_t: string, f: (e: unknown) => void) => { h.key = f; },
        },
      };
      const win = { addEventListener: (_t: string, f: (e: unknown) => void) => { h.msg = f; } };
      new Function("document", "window", "forgetFirstLogin", "hideResetFrame", "openAuth", code)(h.doc, win, () => forgot++, () => {}, () => {});
      act(h);
      return forgot;
    };
    const handler = (from: string) => {
      const start = LANDING.indexOf(from);
      expect(start).toBeGreaterThan(-1);
      return LANDING.slice(start, LANDING.indexOf("\n});\n", start) + 5);
    };
    expect(closed(`${fn("closeAuth")}\n}\ncloseAuth();`, () => {})).toBe(1); // the close button
    expect(closed(`${fn("closeAuth")}\n}\ncloseAuth({ target: document.getElementById('authBackdrop') });`, () => {})).toBe(1);
    expect(closed(`${fn("closeAuth")}\n}\ncloseAuth({ target: {} });`, () => {})).toBe(0); // a click inside the modal
    expect(closed(`${fn("closeAuthHard")}\n}\ncloseAuthHard();`, () => {})).toBe(1);
    expect(closed(handler("// Close on Escape"), (h) => h.key!({ key: "Escape" }))).toBe(1);
    expect(closed(handler("window.addEventListener('message', function (e) {\n  if (!e || !e.data) return;"), (h) => h.msg!({ data: { type: "enki-esc" } }))).toBe(1);
  });

  it("no longer sends anyone to a wallet email code that does not exist, nor ships an email list", () => {
    expect(LANDING).not.toMatch(/email-code option|isn't live during the whitelist stage/);
    expect(LANDING).not.toMatch(/const WHITELIST/);
  });
});

// DEC-493 (Kev, 2026-10-28: "beim login auch login with invite code möglich sein, also einfach nur 'Invite code'"):
// the code goes to /api/gate as on /gate; a trial code's pass is spent by the next Google, X or email login.
describe("the landing's invite code", () => {
  it("is a button of the login, opening a step of its own that the tabs close again", () => {
    const login = LANDING.slice(LANDING.indexOf('<form class="auth-form" id="formLogin"'), LANDING.indexOf("</form>", LANDING.indexOf('id="formLogin"')));
    expect(login).toMatch(/<button type="button" class="auth-social" onclick="showInvite\(\)" style="margin-bottom:10px">\s*<svg[^]*?<\/svg>\s*Invite code\s*<\/button>/);
    // Above the wallet (Kev, 2026-10-28: "pack mal invite code button über continue with wallet").
    expect(login.indexOf('onclick="showInvite()"')).toBeLessThan(login.indexOf('id="walletButton"'));
    expect(LANDING).toContain('<form class="auth-form" id="formInvite" style="display:none" onsubmit="submitInvite(event)">');
    expect(fn("switchAuthTab")).toContain("document.getElementById('formInvite').style.display = 'none';");
    expect(fn("showInvite")).toMatch(/getElementById\('formLogin'\)\.style\.display = 'none';\n {2}f\.style\.display = '';/);
  });

  it("sends the trimmed code to /api/gate and says a wrong one, or too many tries, in the step", async () => {
    const p = runSignup(false);
    p.el("inviteCode").value = "  abc-123 \n";
    p.answer("/api/gate", false, { ok: false, error: "Wrong access code" });
    p.invite();
    await settle();
    expect(p.posts).toEqual([{ url: "/api/gate", body: { code: "abc-123" } }]);
    expect(p.el("formInvite").note?.textContent).toBe("That invite code is not valid.");
    p.answer("/api/gate", false, { error: "Too many requests" });
    p.invite();
    await settle();
    expect(p.el("formInvite").note?.textContent).toBe("Too many tries. Wait a minute and try again.");
    expect(p.switched).toEqual([]);
  });

  it("goes back to the login with a trial code, without the wallet, whose login spends no trial", async () => {
    const p = runSignup(false);
    p.el("inviteCode").value = "TRIAL-CODE";
    p.answer("/api/gate", true, { ok: true, trial: true });
    p.invite();
    await settle();
    expect(p.switched).toEqual(["login"]);
    expect(p.el("walletButton").style.display).toBe("none");
    expect(p.el("inviteCode").value).toBe("");
    expect(p.el("formLogin").note?.textContent).toBe("Code accepted. Log in with Google, X or email to start your trial. Your time starts when you log in.");
  });

  it("goes back to the login with the team code, the wallet kept", async () => {
    const p = runSignup(false);
    p.el("inviteCode").value = "TEAM";
    p.answer("/api/gate", true, { ok: true, signIn: true });
    p.invite();
    await settle();
    expect(p.switched).toEqual(["login"]);
    expect(p.el("walletButton").style.display).toBe("");
    expect(p.el("formLogin").note?.textContent).toBe("Code accepted. Log in to continue.");
  });
});
