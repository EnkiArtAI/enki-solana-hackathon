/**
 * Tiny bridge between the standalone CDP runtime tree (CdpWalletBridge, which
 * owns the @coinbase/cdp-hooks context) and the rest of the app, which mounts
 * outside that provider. Addresses flow out via a module store + event.
 * Signing is request/response over window events. Key EXPORT is different
 * again (CDP-1): the key never passes through this module, or through any
 * app JS, at all — a caller hands over a DOM node via
 * setExportIframeContainer, CdpWalletBridge portals CDP's own secure iframe
 * button into it (useSolanaKeyExportIframe), and the button copies the key
 * straight to the clipboard inside that iframe. Only the iframe's status
 * (idle/loading/success/error) relays back, via setExportIframeStatus.
 */
import { sessionAuthHeaders } from "@/lib/session-headers";

export const CDP_ADDRESS_EVENT = "enki-cdp-address";
export const CDP_SIGN_REQUEST = "enki-cdp-sign-request";
export const CDP_SIGN_RESULT = "enki-cdp-sign-result";
export const CDP_EXPORT_IFRAME_EVENT = "enki-cdp-export-iframe";
/** A wallet action the server refused for an unconfirmed login email: components/ConfirmEmailWindow.tsx opens. */
export const CONFIRM_EMAIL_EVENT = "enki:confirm-email";
/** sessionStorage: the account that closed that window in this browser session; it does not open by itself again until the
    wallet asks. Cleared at logout (hooks/useEmailAuth.ts forgetSession), so the next login shows it again. */
export const CONFIRM_EMAIL_CLOSED_KEY = "enki:confirm-email-closed";

let solanaAddress: string | null = null;
let evmAddress: string | null = null;

/* The wallet unlock (Kev, 2026-10-07). Once an account has a second factor,
   CDP may act only for a session that passed a wallet step-up: the JWT route
   answers 403 { locked } otherwise. Its last answer is recorded here. The
   runtime registers how to get past the lock; a wallet action awaits
   ensureCdpWallet() before it starts, so no timeout runs while the user
   answers the dialog. */
let locked = false;
// Why the server keeps the wallet closed until the user acts elsewhere (an
// email to confirm, a wallet account that pays with its own wallet), in its
// own words; no dialog opens it.
let closed: string | null = null;
// The server's word that this account pays with its own wallet: it has no embedded one.
let ownWalletAccount = false;
// The server's word that the login email waits for its code.
let confirmEmail = false;
type Ensure = (opts?: { attached?: boolean }) => Promise<void>;
let ensure: Ensure | null = null;

/** Our JWT for CDP, or undefined; records whether the wallet is locked. CDP
    asks for it before every request, the bridge before every wallet action. */
export async function fetchWalletJwt(): Promise<string | undefined> {
  let res: Response;
  // A read that got no answer says nothing about the wallet: the last answer (a lock since confirmed, a closure) is
  // forgotten, or it would block requestCdpSign's one retry (round 27, 2026-10-21).
  try { res = await fetch("/api/auth/wallet/jwt", { method: "POST", headers: sessionAuthHeaders() }); }
  catch (error) { locked = false; closed = null; ownWalletAccount = false; confirmEmail = false; throw error; }
  const body = (await res.json().catch(() => ({}))) as { jwt?: string; locked?: boolean; confirmEmail?: boolean; walletAccount?: boolean; error?: string };
  locked = res.status === 403 && body.locked === true;
  closed = res.status === 403 && (body.confirmEmail === true || body.walletAccount === true)
    ? body.error ?? "Your wallet cannot open from this sign-in."
    : null;
  ownWalletAccount = res.status === 403 && body.walletAccount === true;
  confirmEmail = res.status === 403 && body.confirmEmail === true;
  return res.ok ? body.jwt : undefined;
}

export function cdpClosedReason(): string | null {
  return closed;
}

export function cdpOwnWalletAccount(): boolean {
  return ownWalletAccount;
}

export function isCdpLocked(): boolean {
  return locked;
}

// A runtime this session is about to mount (an email, Google or X login with CDP configured; set by providers'
// CdpLauncher): a readiness check before it registers waits for it, at most RUNTIME_WAIT_MS, instead of going ahead as a
// wallet login does. Going ahead opened the order under the session's user id, and the runtime's attach then re-pointed
// the session to the wallet mid-order: every later request of the order read "not found" (round 32, 2026-10-21).
const RUNTIME_WAIT_MS = 15_000;
let expected = false;
let waiting: (() => void)[] = [];

export function expectCdpRuntime(on: boolean) {
  expected = on;
  if (!on) for (const arrived of [...waiting]) arrived();
}

function runtimeArrival(): Promise<void> {
  return new Promise((done) => {
    const arrived = () => { clearTimeout(timer); waiting = waiting.filter((w) => w !== arrived); done(); };
    const timer = setTimeout(arrived, RUNTIME_WAIT_MS);
    waiting.push(arrived);
  });
}

export function registerCdpEnsure(fn: Ensure | null) {
  ensure = fn;
  if (fn) for (const arrived of [...waiting]) arrived();
}

/** Whether this session has an embedded wallet to open (an email, Google or X login with CDP configured): a wallet
    login, or a deployment without CDP, has none, and ensureCdpWallet would resolve doing nothing. */
export function cdpRuntimeExpected(): boolean {
  return expected || ensure !== null;
}

/** Resolves once the embedded wallet can act: at once without a CDP runtime
    (wallet logins, guests), after the unlock dialog when it is locked; with
    attached, once its address is on our session too (a paid generation).
    Rejects when the user cancels, or when a runtime the session is about to
    mount has not come in time (nothing is opened yet). */
export async function ensureCdpWallet(opts?: { attached?: boolean }): Promise<void> {
  if (!ensure && expected) await runtimeArrival();
  // A wallet action refused for the unconfirmed login email opens the window that confirms it; CDP's own token reads,
  // the silent sign-in on load among them, do not come through here.
  if (ensure) return ensure(opts).catch((error) => {
    if (confirmEmail) window.dispatchEvent(new Event(CONFIRM_EMAIL_EVENT));
    throw error;
  });
  if (expected) throw new Error("Your wallet is still loading. Try again — nothing was charged.");
}

/* The last address per email: CDP forgets it while the wallet is locked, and
   every wallet screen needs it to offer the action that unlocks. Public data,
   cleared on logout. */
const ADDRESS_KEY = "enki-cdp-address:";

export function rememberCdpAddress(email: string, address: string) {
  try { localStorage.setItem(ADDRESS_KEY + email, address); } catch { /* storage off: no memory */ }
}

export function rememberedCdpAddress(email: string): string | null {
  try { return localStorage.getItem(ADDRESS_KEY + email); } catch { return null; }
}

export function forgetCdpAddresses() {
  try {
    Object.keys(localStorage).filter((k) => k.startsWith(ADDRESS_KEY)).forEach((k) => localStorage.removeItem(k));
  } catch { /* nothing stored */ }
}

export function setCdpSolanaAddress(addr: string | null) {
  solanaAddress = addr;
  if (typeof window !== "undefined") window.dispatchEvent(new Event(CDP_ADDRESS_EVENT));
}

export function getCdpSolanaAddress(): string | null {
  return solanaAddress;
}

/** The signed-in account's EVM address — informational only here (CDP
    wallets are Solana-primary); same store/event pattern as the Solana one. */
export function setCdpEvmAddress(addr: string | null) {
  evmAddress = addr;
  if (typeof window !== "undefined") window.dispatchEvent(new Event(CDP_ADDRESS_EVENT));
}

export function getCdpEvmAddress(): string | null {
  return evmAddress;
}

/**
 * Key export (CDP-1): a caller outside the provider (KeyExport.tsx) hands
 * over the DOM node that should host CDP's secure export button.
 * CdpWalletBridge watches this and portals the iframe hook into it once an
 * address is signed in; null unregisters (the dialog closed). The container
 * is plain DOM state — no key material ever passes through this module.
 */
let exportContainer: HTMLElement | null = null;
let exportStatus: { status: string | null; message?: string } = { status: null };

export function setExportIframeContainer(container: HTMLElement | null) {
  exportContainer = container;
  if (typeof window !== "undefined") window.dispatchEvent(new Event(CDP_EXPORT_IFRAME_EVENT));
}

export function getExportIframeContainer(): HTMLElement | null {
  return exportContainer;
}

/** CdpWalletBridge publishes the iframe's live status here so the caller's
    UI (a "preparing…"/error line) can reflect it without importing
    @coinbase/cdp-hooks itself. */
export function setExportIframeStatus(status: string | null, message?: string) {
  exportStatus = { status, message };
  if (typeof window !== "undefined") window.dispatchEvent(new Event(CDP_EXPORT_IFRAME_EVENT));
}

export function getExportIframeStatus(): { status: string | null; message?: string } {
  return exportStatus;
}

let signSeq = 0;

/**
 * Ask the CDP runtime to sign a serialized Solana transaction (base64 in,
 * base64 out). Same request/response shape as the export above, for the same
 * reason: the signing hook only exists inside the lazily-mounted provider.
 */
export async function requestCdpSign(transaction: string, timeoutMs = 60_000): Promise<string> {
  // Asked once more, readiness check included, when the wallet could not act (CDP's API, our wallet token route, CDP
  // dropping its sign-in after a token it could not get): the checkout cancels an order it could not sign as the
  // buyer's (Kev, 2026-10-21: DEC-257 stays a residual, with one retry; round 26). Never again for a wallet that did
  // not answer, one the buyer must unlock (a dialog they cancelled), one the server keeps closed, or another account.
  const address = getCdpSolanaAddress();
  const attempt = async () => { await ensureCdpWallet(); return signRequest(transaction, timeoutMs); };
  try { return await attempt(); }
  catch (error) {
    if (error instanceof NoAnswer || isCdpLocked() || cdpClosedReason() !== null || getCdpSolanaAddress() !== address) throw error;
    return attempt();
  }
}

class NoAnswer extends Error {}

function signRequest(transaction: string, timeoutMs: number): Promise<string> {
  const id = String(++signSeq);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new NoAnswer("The wallet didn't answer. Reload and try again."));
    }, timeoutMs);
    const onResult = (e: Event) => {
      const d = (e as CustomEvent).detail as
        | { id?: string; signedTransaction?: string; error?: string }
        | undefined;
      // Two signings can overlap (a payment while another is still open).
      // Ignore answers meant for a different request rather than settling one
      // payment with the other's signature.
      if (!d || d.id !== id) return;
      cleanup();
      if (d.signedTransaction) resolve(d.signedTransaction);
      else reject(new Error(d.error || "Signing failed"));
    };
    const cleanup = () => {
      clearTimeout(timer);
      window.removeEventListener(CDP_SIGN_RESULT, onResult);
    };
    window.addEventListener(CDP_SIGN_RESULT, onResult);
    window.dispatchEvent(new CustomEvent(CDP_SIGN_REQUEST, { detail: { id, transaction } }));
  });
}
