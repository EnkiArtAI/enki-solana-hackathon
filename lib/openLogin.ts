import { sanitizeNext } from "@/lib/auth/oauth-shared";

/**
 * Open the login UI where the user stands (Kev, 2026-08-24: "just pop up
 * the login UI … without opening the homepage"). The shell listens and pops
 * the login modal (email + password, or a wallet) in place; only outside the
 * shell does this fall back to the landing route, which deep-links into its
 * auth modal.
 *
 * `next` is where the finished login lands instead of Home, e.g. back on the
 * Settings tab that asked for a fresh login (Kev, 2026-10-29: "i gotta be sent
 * back to the settings"; DEC-501). Without one, a path left by an earlier,
 * cancelled login is dropped.
 */
export const AFTER_LOGIN = "enki:after-login";
/** The shell's Settings panel on its Recovery & 2FA tab (EnkiHome reads ?settings=). */
export const BACK_TO_RECOVERY = "/home?settings=recovery";
export function openLogin(next?: string): void {
  try {
    if (next) sessionStorage.setItem(AFTER_LOGIN, next);
    else sessionStorage.removeItem(AFTER_LOGIN);
  } catch { /* the login still opens; it lands on Home */ }
  const notConsumed = window.dispatchEvent(
    new CustomEvent("enki:open-login", { cancelable: true }),
  );
  if (notConsumed) window.location.assign("/?login=1");
}

/** A login asked for and not taken (its window closed, a log-off) drops its way back, so it never steers a later
 *  login that does not start here: the landing's own Log in, /gate, the wallet picker (review 2026-10-29). */
export function dropAfterLogin(): void {
  try { sessionStorage.removeItem(AFTER_LOGIN); } catch { /* nothing kept */ }
}

/** Where a finished login lands: the path openLogin was given, read once and only as a path on this site, else Home
 *  (public/landing.html's afterLogin is the same rule, for the login window). */
export function takeAfterLogin(): string {
  let next: string | null = null;
  try {
    next = sessionStorage.getItem(AFTER_LOGIN);
    sessionStorage.removeItem(AFTER_LOGIN);
  } catch { /* Home */ }
  return sanitizeNext(next);
}
