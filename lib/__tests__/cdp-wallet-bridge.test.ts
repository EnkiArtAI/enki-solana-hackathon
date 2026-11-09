import { describe, it, expect, beforeEach, vi } from "vitest";
import { join } from "node:path";
import { readSource } from "./_read-source";

/**
 * The CDP bridge, run for real (review of the email login, 2026-10-07):
 * - CDP keeps its user and wallet secret in memory across our unmounts, so a
 *   mount signs that out and trusts only its own sign-in, and a call that
 *   outlives its mount stops: another account's wallet never reaches this
 *   session.
 * - Before every wallet action the JWT route decides; the unlock dialog shows
 *   only while it still says locked, and before the action, not inside it.
 * - A ban never stops the wallet: only a paid generation needs the attach.
 *
 * No DOM: the bridge renders nothing, so a minimal hooks runtime (state, refs,
 * callbacks, effects) runs it as React would.
 */

const rt = vi.hoisted(() => {
  type Slot = { v?: unknown; current?: unknown; fn?: unknown; deps?: unknown[]; cleanup?: unknown };
  let slots: Slot[] = [];
  let cursor = 0;
  let effects: (() => void)[] = [];
  let component: (() => unknown) | null = null;
  let rendering = false;
  let dirty = false;
  let pending = false;
  const same = (a?: unknown[], b?: unknown[]) => !!a && !!b && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
  const render = () => {
    if (!component) return;
    rendering = true;
    try {
      do {
        dirty = false;
        cursor = 0;
        effects = [];
        component();
        const run = effects;
        run.forEach((f) => f());
      } while (dirty && component);
    } finally {
      rendering = false;
    }
  };
  const update = () => {
    if (rendering) { dirty = true; return; }
    if (pending) return;
    pending = true;
    // Like React's scheduler: an update from a promise renders in a later task.
    setTimeout(() => { pending = false; render(); }, 0);
  };
  const react = {
    useState(init: unknown) {
      const s = (slots[cursor++] ??= { v: init });
      return [s.v, (next: unknown) => { if (!Object.is(next, s.v)) { s.v = next; update(); } }];
    },
    useRef(init: unknown) {
      return (slots[cursor++] ??= { current: init });
    },
    useCallback(fn: unknown, deps: unknown[]) {
      const i = cursor++;
      if (slots[i] && same(slots[i].deps, deps)) return slots[i].fn;
      slots[i] = { fn, deps };
      return fn;
    },
    useEffect(fn: () => unknown, deps?: unknown[]) {
      const i = cursor++;
      const prev = slots[i];
      if (prev && same(prev.deps, deps)) return;
      slots[i] = { deps: prev?.deps, cleanup: prev?.cleanup };
      effects.push(() => {
        if (typeof prev?.cleanup === "function") prev.cleanup();
        slots[i] = { deps, cleanup: fn() };
      });
    },
  };
  return {
    react,
    mount(c: () => unknown) { slots = []; component = c; render(); },
    unmount() {
      component = null;
      for (const s of slots) if (s && "cleanup" in s && typeof s.cleanup === "function") s.cleanup();
      slots = [];
    },
    update,
  };
});
vi.mock("react", () => rt.react);

type User = { solanaAccountObjects: { address: string }[]; evmAccountObjects: { address: string }[] };
// The EVM address is derived from the Solana one (distinct per account) so
// tests can tell "my own EVM address" from "the one CDP happens to hold".
const wallet = (sol: string): User => ({ solanaAccountObjects: [{ address: sol }], evmAccountObjects: [{ address: `0xevm-${sol}` }] });

// CDP: one user and one wallet secret in memory for the page.
// authenticateWithJWT asks our JWT route (customAuth.getJwt) and replaces the
// user, but keeps the secret; a refused JWT leaves both as they were. Only
// signOut clears both. A secret signs for the user who registered it, only.
// initialized: false is a runtime whose SDK has not started yet; gate holds
// getCurrentUser until released (a slow read across an account switch);
// signGate holds a signing halfway, after it started.
const cdp = vi.hoisted(() => ({
  user: null as null | User, secret: null as null | string, walletOf: {} as Record<string, User>, signIns: 0,
  initialized: true, gate: null as null | Promise<void>, signGate: null as null | Promise<void>, signFails: 0,
  // authLost: CDP's CustomAuthManager clears its sign-in when getJwt answers nothing, and the signing then fails.
  authLost: 0, onSignFail: null as null | (() => void),
  // What the attach signed, as CDP received it; proofGate holds a proof's signing halfway.
  signed: [] as { family: string; account: string; message: string }[], proofGate: null as null | Promise<void>,
  evmProofFails: false, solanaProofFails: false,
}));
vi.mock("@coinbase/cdp-hooks", () => ({
  useIsInitialized: () => ({ isInitialized: cdp.initialized }),
  // Never actually called by this harness (ExportIframeHost, which calls it,
  // is only ever referenced as a JSX element — never invoked — since nothing
  // here exercises CdpWalletBridge's createPortal return path; see
  // cdp-export-iframe-migration.test.ts for the static wiring checks that
  // cover the portal itself). Present only so the module import resolves.
  useSolanaKeyExportIframe: () => ({ status: null, message: undefined }),
}));
vi.mock("@coinbase/cdp-core", async () => {
  const { fetchWalletJwt } = await import("../cdp-bridge");
  const own = (account: string) => {
    if (cdp.user?.solanaAccountObjects[0]?.address !== account) throw new Error("not this user's account");
    cdp.secret ??= account;
    if (cdp.secret !== account) throw new Error("wallet secret of another user");
  };
  return {
    authenticateWithJWT: async () => {
      cdp.signIns++;
      const jwt = await fetchWalletJwt();
      if (!jwt) throw new Error("customAuth.getJwt returned null or undefined");
      cdp.user = cdp.walletOf[jwt];
      rt.update(); // CDP's auth state callback re-renders its hooks
      return { user: cdp.user, message: "ok", isNewUser: false };
    },
    signOut: async () => {
      if (!cdp.user) throw new Error("User not signed in");
      cdp.user = null;
      cdp.secret = null;
      rt.update();
    },
    isSignedIn: async () => cdp.user !== null,
    getCurrentUser: async () => {
      if (cdp.gate) await cdp.gate;
      return cdp.user;
    },
    getCurrentUserSync: () => cdp.user,
    signSolanaMessage: async ({ solanaAccount, message }: { solanaAccount: string; message: string }) => {
      own(solanaAccount);
      if (cdp.solanaProofFails) throw new Error("cdp solana 500");
      cdp.signed.push({ family: "solana", account: solanaAccount, message });
      if (cdp.proofGate) await cdp.proofGate;
      return { signature: `solana-signature-${cdp.signed.length}` };
    },
    signEvmMessage: async ({ evmAccount, message }: { evmAccount: string; message: string }) => {
      if (cdp.evmProofFails) throw new Error("cdp evm 500");
      cdp.signed.push({ family: "evm", account: evmAccount, message });
      return { signature: `0xevm-signature-${cdp.signed.length}` };
    },
    signSolanaTransaction: async ({ solanaAccount, transaction }: { solanaAccount: string; transaction: string }) => {
      own(solanaAccount);
      const secret = cdp.secret; // a signing holds the secret it started with
      if (cdp.signGate) await cdp.signGate;
      if (cdp.signFails > 0) { cdp.signFails--; cdp.onSignFail?.(); throw new Error("CDP is down"); }
      if (cdp.authLost > 0) { cdp.authLost--; cdp.user = null; throw new Error("User not signed in"); }
      if (cdp.secret !== secret) throw new Error("wallet secret cleared while signing");
      events.push("sign");
      return { signedTransaction: `${transaction} signed by ${solanaAccount}` };
    },
  };
});

// The step-up dialog: the user confirms (the server then unlocks), cancels,
// or leaves it open until release().
const dialog = vi.hoisted(() => ({ answer: "confirm" as "confirm" | "cancel" | "hold", release: () => {} }));
vi.mock("@/components/StepUpProvider", () => ({
  useStepUp: () => ({ tokenFor }),
  askStepUp: (scope: string, factors: string[]) => askFactor(scope, factors),
}));
const tokenFor = vi.fn(async (scope: string) => {
  events.push(`dialog:${scope}`);
  if (dialog.answer === "cancel") return null;
  if (dialog.answer === "hold") await new Promise<void>((r) => { dialog.release = r; });
  server.jwt = "open";
  return "step-up-token";
});

// The dialog for one factor of a wallet change; "cancel:totp" cancels at that factor.
const asked: { scope: string; factors: string[] }[] = [];
let answerFactor = (factor: string): string | null => `token-${factor}`;
let factorGate: Promise<void> | null = null;
const askFactor = async (scope: string, factors: string[]) => {
  asked.push({ scope, factors });
  if (factorGate) await factorGate;
  return answerFactor(factors[0]);
};

// Our server: the JWT route and attach-wallet.
const server = {
  jwt: "open" as "open" | "locked" | "down" | "unconfirmed" | "walletAccount",
  // downOnce: the next N JWT reads answer 503 (a database blip); lostOnce: the next N get no answer at all (the fetch
  // rejects); jwtCalls counts the reads.
  downOnce: 0,
  lostOnce: 0,
  jwtCalls: 0,
  banned: false,
  attached: [] as { address: string; session: string }[],
  // attach-wallet's gate: a new address answers 428 until it signed; factors answer 401 until each has its token.
  newAddress: false,
  spent: new Set<string>(), // a token passes once, as requireAllFactors claims it
  enroll: false,
  wait: false,
  factors: [] as string[],
  attachCalls: [] as { body: { solanaAddress: string; evmAddress: string | null; proof?: unknown }; session: string; tokens: string }[],
};
const events: string[] = [];
vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { body?: string; headers?: Record<string, string> }) => {
  const session = init?.headers?.["X-Session-Token"] ?? "";
  const json = (status: number, body: unknown) => ({ ok: status < 300, status, json: async () => body });
  if (url === "/api/auth/wallet/jwt") {
    server.jwtCalls++;
    if (server.lostOnce > 0) { server.lostOnce--; throw new TypeError("Failed to fetch"); }
    if (server.downOnce > 0) { server.downOnce--; return json(503, { error: "Could not read the session" }); }
    if (server.jwt === "locked") return json(403, { error: "Confirm it's you to use the wallet", locked: true, scope: "wallet", factors: ["totp"] });
    if (server.jwt === "down") return json(503, { error: "Could not read the session" });
    if (server.jwt === "unconfirmed") return json(403, { error: "Confirm your email to open your wallet.", confirmEmail: true });
    if (server.jwt === "walletAccount") return json(403, { error: "This account pays with its own wallet: sign in with that wallet to pay.", walletAccount: true });
    return json(200, { jwt: `jwt-${session}` });
  }
  if (url === "/api/auth/session/attach-wallet") {
    if (server.banned) return json(403, { error: "This account is suspended.", banned: true });
    const body = JSON.parse(init!.body!);
    const tokens = init?.headers?.["X-StepUp-Token"] ?? "";
    server.attachCalls.push({ body, session, tokens });
    if (server.newAddress && !body.proof) {
      return json(428, { proof: [
        { address: body.solanaAddress, family: "solana", nonce: "n-sol", message: "the Solana text" },
        ...(body.evmAddress ? [{ address: body.evmAddress, family: "evm", nonce: "n-evm", message: "the EVM text" }] : []),
      ] });
    }
    if (server.enroll) return json(403, { error: "Set up a second factor first", enroll: true });
    if (server.wait) return json(403, { error: "A security factor was added to this account less than 24 hours ago.", wait: true, until: "2026-11-06T00:00:00.000Z" });
    const sent = tokens.split(",");
    const missing = server.factors.filter((f) => !sent.includes(`token-${f}`) || server.spent.has(`token-${f}`));
    if (missing.length) {
      return json(401, { error: "Every second factor has to confirm this", stepUp: true, all: true, scope: `wallet-change:${body.solanaAddress}`, factors: server.factors, missing });
    }
    server.factors.forEach((f) => server.spent.add(`token-${f}`));
    server.attached.push({ address: body.solanaAddress, session });
    return json(200, {});
  }
  throw new Error(`unexpected fetch ${url}`);
}));

const local = new Map<string, string>();
const storage = (m: Map<string, string>) => new Proxy({}, {
  get: (_, k: string) => ({
    getItem: (key: string) => m.get(key) ?? null,
    setItem: (key: string, v: string) => void m.set(key, v),
    removeItem: (key: string) => void m.delete(key),
  } as Record<string, unknown>)[k] ?? m.get(k),
  ownKeys: () => [...m.keys()],
  getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
});
vi.stubGlobal("window", new EventTarget());
vi.stubGlobal("localStorage", storage(local));
const session = new Map<string, string>();
vi.stubGlobal("sessionStorage", storage(session));

import { CdpWalletBridge } from "@/components/CdpWalletBridge";
import {
  CDP_ADDRESS_EVENT, CDP_SIGN_REQUEST, ensureCdpWallet, getCdpSolanaAddress, getCdpEvmAddress,
  rememberedCdpAddress, requestCdpSign, setExportIframeContainer, getExportIframeContainer, setCdpSolanaAddress,
} from "../cdp-bridge";

const A = "AccountA1111111111111111111111111111111111";
const B = "AccountB1111111111111111111111111111111111";
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0)); };
const published: (string | null)[] = [];
window.addEventListener(CDP_ADDRESS_EVENT, () => published.push(getCdpSolanaAddress()));
window.addEventListener(CDP_SIGN_REQUEST, () => events.push("sign-request"));

beforeEach(async () => {
  rt.unmount();
  await settle();
  cdp.user = null;
  cdp.walletOf = { "jwt-session-of-a": wallet(A), "jwt-session-of-b": wallet(B) };
  cdp.secret = null;
  cdp.signIns = 0;
  cdp.initialized = true;
  cdp.gate = null;
  cdp.signGate = null;
  cdp.signFails = 0;
  cdp.authLost = 0;
  cdp.onSignFail = null;
  cdp.signed = [];
  cdp.proofGate = null;
  cdp.evmProofFails = false;
  cdp.solanaProofFails = false;
  asked.length = 0;
  answerFactor = (factor) => `token-${factor}`;
  factorGate = null;
  Object.assign(server, { jwt: "open", downOnce: 0, lostOnce: 0, banned: false, attached: [], newAddress: false, spent: new Set<string>(), enroll: false, wait: false, factors: [], attachCalls: [] });
  dialog.answer = "confirm";
  dialog.release = () => {};
  tokenFor.mockClear();
  events.length = 0;
  published.length = 0;
  local.clear();
  session.clear();
  local.set("enki_session_token", "session-of-b");
  setExportIframeContainer(null); // module-level bridge state, shared across tests
});

const mountFor = async (email: string) => {
  rt.mount(() => CdpWalletBridge({ email }));
  await settle();
};

describe("a second tab, after another account's login", () => {
  it("never publishes, remembers or attaches the account CDP still holds, nor signs with its secret", async () => {
    cdp.user = wallet(A); // left in memory by the first account's runtime,
    cdp.secret = A;       // with the wallet secret it signed with
    await mountFor("b@example.com");
    expect(published).not.toContain(A);
    expect(server.attached).toEqual([{ address: B, session: "session-of-b" }]);
    await expect(requestCdpSign("tx")).resolves.toBe(`tx signed by ${B}`);
    expect(rememberedCdpAddress("b@example.com")).toBe(B);
    expect(getCdpSolanaAddress()).toBe(B);
    expect(cdp.signIns).toBe(1);
  });

  it("signs out a previous user whose wallet setup stopped halfway, with its secret", async () => {
    cdp.user = { solanaAccountObjects: [], evmAccountObjects: [{ address: `0x${"0".repeat(39)}2` }] };
    cdp.secret = A; // registered for A before its Solana account could be created
    await mountFor("b@example.com");
    await expect(requestCdpSign("tx")).resolves.toBe(`tx signed by ${B}`);
  });

  it("shows nothing of it either while the new account's wallet is locked", async () => {
    cdp.user = wallet(A);
    cdp.secret = A;
    server.jwt = "locked";
    await mountFor("b@example.com");
    expect(published).not.toContain(A);
    expect(server.attached).toEqual([]);
    expect(rememberedCdpAddress("b@example.com")).toBeNull();
    // Unlocked later, it signs as the new account, never as the one in memory.
    await expect(requestCdpSign("tx")).resolves.toBe(`tx signed by ${B}`);
    expect(published).not.toContain(A);
  });

  it("stops a wallet action the previous account left waiting, so its wallet never reaches the new session", async () => {
    local.set("enki_session_token", "session-of-a");
    await mountFor("a@example.com");
    server.jwt = "locked"; // A's wallet relocked; a payment waits on A's dialog
    dialog.answer = "hold";
    const paying = ensureCdpWallet({ attached: true });
    await settle();
    rt.unmount(); // another tab logs out and in as B: this tab remounts for B
    local.set("enki_session_token", "session-of-b");
    await mountFor("b@example.com");
    dialog.release(); // confirmed, now with B's factor
    await expect(paying).rejects.toThrow(/account changed/);
    await settle();
    expect(server.attached.filter((a) => a.session === "session-of-b").map((a) => a.address)).not.toContain(A);
    expect(rememberedCdpAddress("a@example.com")).toBe(A);
    expect(rememberedCdpAddress("b@example.com")).not.toBe(A);
  });

  it("fails a payment the previous account left waiting, even before the new runtime is up", async () => {
    local.set("enki_session_token", "session-of-a");
    await mountFor("a@example.com");
    server.jwt = "locked";
    dialog.answer = "hold";
    const paying = requestCdpSign("tx");
    await settle();
    rt.unmount();
    local.set("enki_session_token", "session-of-b");
    cdp.initialized = false; // B's runtime has not signed anyone out yet: CDP still holds A
    await mountFor("b@example.com");
    dialog.release();
    await expect(paying).rejects.toThrow(/account changed/);
    expect(events).not.toContain("sign");
  });

  it("remembers nothing for the previous email from a sign-in that outlived its mount", async () => {
    local.set("enki_session_token", "session-of-a");
    let release!: () => void;
    cdp.gate = new Promise<void>((r) => { release = r; }); // A's sign-in is slow to start
    await mountFor("a@example.com");
    rt.unmount();
    local.set("enki_session_token", "session-of-b"); // so it signs in with B's session
    cdp.gate = null;
    release();
    await settle();
    expect(rememberedCdpAddress("a@example.com")).toBeNull();
  });

  it("signs with the new account's own wallet even before its runtime finished starting", async () => {
    cdp.user = wallet(A);
    cdp.secret = A;
    cdp.initialized = false;
    await mountFor("b@example.com");
    await expect(requestCdpSign("tx")).resolves.toBe(`tx signed by ${B}`);
  });

  it("keeps its own sign-in when its runtime finishes starting in the middle of a payment", async () => {
    cdp.initialized = false;
    await mountFor("b@example.com");
    let release!: () => void;
    cdp.signGate = new Promise<void>((r) => { release = r; });
    const paying = requestCdpSign("tx"); // signs B in and starts signing
    await settle();
    cdp.initialized = true; // the SDK is up: the silent sign-in runs now
    rt.update();
    await settle();
    release();
    await expect(paying).resolves.toBe(`tx signed by ${B}`);
  });

  it("never takes a late answer for the previous account as its own", async () => {
    await mountFor("b@example.com");
    cdp.user = wallet(A); // the old mount's sign-in, still on the wire, lands in CDP now
    rt.update();
    await settle();
    expect(published).not.toContain(A);
    expect(getCdpSolanaAddress()).toBe(B);
    expect(server.attached.map((a) => a.address)).not.toContain(A);
    await expect(requestCdpSign("tx")).resolves.toBe(`tx signed by ${B}`);
    expect(server.attached.map((a) => a.address)).not.toContain(A);
    cdp.user = wallet(A); // and once more, right before an ensure
    await expect(ensureCdpWallet({ attached: true })).resolves.toBeUndefined();
    expect(server.attached.map((a) => a.address)).not.toContain(A);
    expect(getCdpEvmAddress()).not.toBe(wallet(A).evmAccountObjects[0].address);
  });

  it("is one runtime per account: another account's login remounts it", () => {
    const providers = readSource(join(__dirname, "..", "..", "providers", "index.tsx"));
    expect(providers).toMatch(/<CdpRuntime key=\{account\} email=\{email\} \/>/);
    // the account is the email, or the session of a Google or X account without one
    const hook = readSource(join(__dirname, "..", "..", "hooks", "useEmailAuth.ts"));
    expect(hook).toContain("const account = token ? email ?? token : null;");
  });

  it("turns the SDK's telemetry off: its unawaited post to Coinbase failed unhandled where trackers are blocked", () => {
    expect(readSource(join(__dirname, "..", "..", "providers", "CdpProvider.tsx"))).toContain("disableAnalytics: true,");
  });
});

describe("before a wallet action, the server decides", () => {
  it("asks nothing once the session is open again: an export step-up, another tab, or no factor left", async () => {
    server.jwt = "locked";
    await mountFor("b@example.com"); // the silent sign-in met the lock
    server.jwt = "open";
    // requestCdpKeyExport is gone (CDP-1, export moved to the secure iframe);
    // ensureCdpWallet is what every wallet action (export included) awaits
    // first, and its gating is unchanged — this re-asserts it directly.
    await expect(ensureCdpWallet()).resolves.toBeUndefined();
    expect(tokenFor).not.toHaveBeenCalled();
  });

  it("asks once while it is locked, then signs in", async () => {
    server.jwt = "locked";
    await mountFor("b@example.com");
    await expect(requestCdpSign("tx")).resolves.toBe(`tx signed by ${B}`);
    expect(tokenFor).toHaveBeenCalledTimes(1);
    expect(tokenFor).toHaveBeenCalledWith("wallet");
  });

  it("asks before the action, not inside its timer, when the server locked a wallet CDP still holds", async () => {
    await mountFor("b@example.com");
    server.jwt = "locked"; // 15 min idle
    await expect(requestCdpSign("tx")).resolves.toBe(`tx signed by ${B}`);
    expect(events).toEqual(["dialog:wallet", "sign-request", "sign"]);
  });

  it("signs nothing when the dialog is cancelled", async () => {
    server.jwt = "locked";
    dialog.answer = "cancel";
    await mountFor("b@example.com");
    await expect(requestCdpSign("tx")).rejects.toThrow(/Not confirmed/);
    expect(events).toEqual(["dialog:wallet"]);
  });

  it("says why when the email must be confirmed first, and shows no dialog", async () => {
    server.jwt = "unconfirmed";
    await mountFor("b@example.com");
    await expect(requestCdpSign("tx")).rejects.toThrow(/Confirm your email to open your wallet/);
    expect(tokenFor).not.toHaveBeenCalled();
  });

  it("says why a wallet-made account signed in by Google or X cannot pay here, and shows no dialog", async () => {
    server.jwt = "walletAccount";
    await mountFor("b@example.com");
    await expect(requestCdpSign("tx")).rejects.toThrow(/pays with its own wallet: sign in with that wallet/);
    expect(tokenFor).not.toHaveBeenCalled();
  });

  it("never shows the dialog when the server is only unreachable", async () => {
    server.jwt = "down";
    await mountFor("b@example.com");
    await expect(requestCdpSign("tx")).rejects.toThrow(/isn't available/);
    expect(tokenFor).not.toHaveBeenCalled();
  });
});

describe("a signing the wallet answers with an error (Kev, 2026-10-21: DEC-257, one retry)", () => {
  it("is asked once more, and a second error stands", async () => {
    await mountFor("b@example.com");
    events.length = 0;
    cdp.signFails = 1;
    await expect(requestCdpSign("tx")).resolves.toBe(`tx signed by ${B}`);
    expect(events.filter((e) => e === "sign-request")).toHaveLength(2);
    events.length = 0;
    cdp.signFails = 2;
    await expect(requestCdpSign("tx")).rejects.toThrow(/CDP is down/);
    expect(events.filter((e) => e === "sign-request")).toHaveLength(2);
  });

  it("asks the readiness check once more when our wallet token route answered 503 once, without a dialog (round 26)", async () => {
    await mountFor("b@example.com");
    events.length = 0;
    server.downOnce = 1;
    await expect(requestCdpSign("tx")).resolves.toBe(`tx signed by ${B}`);
    expect(events.filter((e) => e === "sign-request")).toHaveLength(1);
    expect(tokenFor).not.toHaveBeenCalled();
  });

  it("signs CDP back in when it dropped its sign-in inside the signing (round 26)", async () => {
    await mountFor("b@example.com");
    const signIns = cdp.signIns;
    events.length = 0;
    cdp.authLost = 1;
    await expect(requestCdpSign("tx")).resolves.toBe(`tx signed by ${B}`);
    expect(events.filter((e) => e === "sign-request")).toHaveLength(2);
    expect(cdp.signIns).toBe(signIns + 1);
  });

  it("is not asked again for a wallet the server keeps closed (round 26)", async () => {
    server.jwt = "unconfirmed";
    await mountFor("b@example.com");
    const calls = server.jwtCalls;
    await expect(requestCdpSign("tx")).rejects.toThrow(/Confirm your email/);
    expect(server.jwtCalls - calls).toBe(1);
  });

  it("asks once more when a token read gets no answer after a confirmed unlock: the old lock is no answer (round 27)", async () => {
    await mountFor("b@example.com");
    // Idle past the server's lock while CDP still holds its sign-in: confirmed at the paid generation's check.
    server.jwt = "locked";
    await ensureCdpWallet({ attached: true });
    events.length = 0;
    server.lostOnce = 1;
    await expect(requestCdpSign("tx")).resolves.toBe(`tx signed by ${B}`);
    expect(events).toEqual(["sign-request", "sign"]);
  });

  it("asks once more when a token read gets no answer after the server kept the wallet closed (round 27)", async () => {
    server.jwt = "unconfirmed";
    await mountFor("b@example.com");
    await expect(requestCdpSign("tx")).rejects.toThrow(/Confirm your email/);
    // The email is confirmed elsewhere; the next read gets no answer.
    server.jwt = "open";
    server.lostOnce = 1;
    await expect(requestCdpSign("tx")).resolves.toBe(`tx signed by ${B}`);
  });

  it("is not asked again once another account's wallet took its place (round 26)", async () => {
    await mountFor("b@example.com");
    events.length = 0;
    const before = getCdpSolanaAddress();
    cdp.signFails = 1;
    cdp.onSignFail = () => setCdpSolanaAddress(A);
    await expect(requestCdpSign("tx")).rejects.toThrow(/CDP is down/);
    expect(events.filter((e) => e === "sign-request")).toHaveLength(1);
    setCdpSolanaAddress(before);
  });

  it("is not asked again when the wallet did not answer", async () => {
    await mountFor("b@example.com");
    events.length = 0;
    let release = () => {};
    cdp.signGate = new Promise<void>((r) => { release = r; });
    await expect(requestCdpSign("tx", 20)).rejects.toThrow(/didn't answer/);
    expect(events.filter((e) => e === "sign-request")).toHaveLength(1);
    release();
    await settle();
  });
});

describe("attaching a new address (Kev, 2026-11-05: a wallet changes only with all MFAs)", () => {
  it("signs every message the server sent, in CDP's encoding, and posts them with the address and nonce it got", async () => {
    server.newAddress = true;
    await mountFor("b@example.com");
    expect(cdp.signed).toEqual([
      { family: "solana", account: B, message: Buffer.from("the Solana text").toString("base64") },
      { family: "evm", account: `0xevm-${B}`, message: "the EVM text" },
    ]);
    expect(server.attachCalls).toHaveLength(2);
    expect(server.attachCalls[0].body.proof).toBeUndefined();
    expect(server.attachCalls[1].body.proof).toEqual([
      { address: B, nonce: "n-sol", signature: "solana-signature-1" },
      { address: `0xevm-${B}`, nonce: "n-evm", signature: "0xevm-signature-2" },
    ]);
    expect(server.attached).toEqual([{ address: B, session: "session-of-b" }]);
  });

  it("the silent attach stops quietly at the factors: no dialog, nothing attached", async () => {
    server.newAddress = true;
    server.factors = ["passkey", "totp"];
    await mountFor("b@example.com");
    expect(asked).toEqual([]);
    expect(tokenFor).not.toHaveBeenCalled();
    expect(server.attached).toEqual([]);
    expect(server.attachCalls).toHaveLength(2);
  });

  it("the silent attach stops quietly at 'set up a factor' too", async () => {
    server.newAddress = true;
    server.enroll = true;
    await mountFor("b@example.com");
    expect(asked).toEqual([]);
    expect(server.attached).toEqual([]);
    expect(getCdpSolanaAddress()).toBe(B); // the wallet itself still works
  });

  it("the way to a paid generation asks each missing factor in turn and posts every token with the proof", async () => {
    server.newAddress = true;
    server.factors = ["passkey", "totp"];
    await mountFor("b@example.com");
    server.attachCalls = [];
    await expect(ensureCdpWallet({ attached: true })).resolves.toBeUndefined();
    expect(asked).toEqual([
      { scope: `wallet-change:${B}`, factors: ["passkey"] },
      { scope: `wallet-change:${B}`, factors: ["totp"] },
    ]);
    const last = server.attachCalls.at(-1)!;
    expect(last.tokens).toBe("token-passkey,token-totp");
    expect(last.body.proof).toEqual([
      { address: B, nonce: "n-sol", signature: expect.stringMatching(/^solana-signature/) },
      { address: `0xevm-${B}`, nonce: "n-evm", signature: expect.stringMatching(/^0xevm-signature/) },
    ]);
    expect(server.attached).toEqual([{ address: B, session: "session-of-b" }]);
  });

  it("a cancel stops there, says nothing changed and posts nothing more", async () => {
    server.newAddress = true;
    server.factors = ["passkey", "totp"];
    await mountFor("b@example.com");
    answerFactor = (factor) => (factor === "totp" ? null : `token-${factor}`);
    const calls = () => server.attachCalls.filter((c) => c.tokens).length;
    await expect(ensureCdpWallet({ attached: true })).rejects.toThrow("Not confirmed, nothing was changed.");
    expect(calls()).toBe(0);
    expect(server.attached).toEqual([]);
  });

  it("surfaces 'set up a second factor first' on the way to a paid generation, with no dialog", async () => {
    server.enroll = true;
    await mountFor("b@example.com");
    await expect(ensureCdpWallet({ attached: true })).rejects.toThrow("Set up a second factor first");
    expect(asked).toEqual([]);
  });

  it("the silent attach stops quietly at the 24 hour wait, with no dialog, and the wallet itself still works", async () => {
    server.newAddress = true;
    server.wait = true;
    await mountFor("b@example.com");
    expect(asked).toEqual([]);
    expect(server.attachCalls).toHaveLength(2); // the proof's question and its answer, and no third post
    expect(server.attached).toEqual([]);
    expect(getCdpSolanaAddress()).toBe(B);
  });

  it("surfaces the wait's sentence on the way to a paid generation, with no dialog", async () => {
    server.newAddress = true;
    server.wait = true;
    await mountFor("b@example.com");
    await expect(ensureCdpWallet({ attached: true })).rejects.toThrow("less than 24 hours ago");
    expect(asked).toEqual([]);
    expect(server.attached).toEqual([]);
  });

  it("stays on the session it started with while the wallet signs", async () => {
    server.newAddress = true;
    let release!: () => void;
    cdp.proofGate = new Promise<void>((r) => { release = r; });
    await mountFor("b@example.com");
    local.set("enki_session_token", "session-of-c");
    release();
    await settle();
    expect(server.attachCalls.map((c) => c.session)).toEqual(["session-of-b", "session-of-b"]);
  });

  it("stops when the account changed while the wallet signed", async () => {
    server.newAddress = true;
    let release!: () => void;
    cdp.proofGate = new Promise<void>((r) => { release = r; });
    await mountFor("b@example.com");
    rt.unmount();
    release();
    await settle();
    expect(server.attachCalls).toHaveLength(1);
    expect(server.attached).toEqual([]);
  });

  it("stops when the account changed while a factor's dialog was open", async () => {
    server.factors = ["totp"];
    await mountFor("b@example.com");
    let release!: () => void;
    factorGate = new Promise<void>((r) => { release = r; });
    const paying = ensureCdpWallet({ attached: true });
    await settle();
    expect(asked).toHaveLength(1);
    rt.unmount();
    release();
    await expect(paying).rejects.toThrow(/account changed/);
    expect(server.attachCalls.filter((c) => c.tokens)).toEqual([]);
  });

  it("a failed EVM signature leaves the EVM address out: the Solana attach goes through", async () => {
    server.newAddress = true;
    cdp.evmProofFails = true;
    await mountFor("b@example.com");
    const last = server.attachCalls.at(-1)!;
    expect(last.body.evmAddress).toBeNull();
    expect(last.body.proof).toEqual([{ address: B, nonce: "n-sol", signature: expect.stringMatching(/^solana-signature/) }]);
    expect(server.attached).toEqual([{ address: B, session: "session-of-b" }]);
    await expect(ensureCdpWallet({ attached: true })).resolves.toBeUndefined();
  });

  it("a live Solana row is one request: the server asks no proof for the EVM address it drops, and nothing is signed", async () => {
    await mountFor("b@example.com");
    expect(server.attachCalls).toHaveLength(1);
    expect(server.attachCalls[0].body).toMatchObject({ solanaAddress: B, evmAddress: `0xevm-${B}` });
    expect(cdp.signed).toEqual([]);
    expect(server.attached).toEqual([{ address: B, session: "session-of-b" }]);
  });

  it("a failed Solana signature still stops the attach and says so: that one is the wallet", async () => {
    server.newAddress = true;
    cdp.solanaProofFails = true;
    await mountFor("b@example.com");
    expect(server.attached).toEqual([]);
    await expect(ensureCdpWallet({ attached: true })).rejects.toThrow("cdp solana 500");
  });

  it("parallel paid jobs share one attach: one dialog per factor, and neither fails on a spent token", async () => {
    server.newAddress = true;
    server.factors = ["passkey", "totp"];
    await mountFor("b@example.com");
    server.attachCalls = [];
    const jobs = [ensureCdpWallet({ attached: true }), ensureCdpWallet({ attached: true }), ensureCdpWallet({ attached: true })];
    await expect(Promise.all(jobs)).resolves.toEqual([undefined, undefined, undefined]);
    expect(asked).toHaveLength(2);
    expect(server.attachCalls).toHaveLength(3); // the 428, the proof, the tokens
    expect(server.attached).toEqual([{ address: B, session: "session-of-b" }]);
  });

  it("a job that fails with the shared attach tells every job, and a later one tries anew", async () => {
    server.newAddress = true;
    server.factors = ["totp"];
    await mountFor("b@example.com");
    answerFactor = () => null;
    const jobs = [ensureCdpWallet({ attached: true }), ensureCdpWallet({ attached: true })];
    await expect(Promise.all(jobs.map((j) => j.catch((e: Error) => e.message)))).resolves.toEqual(["Not confirmed, nothing was changed.", "Not confirmed, nothing was changed."]);
    answerFactor = (factor) => `token-${factor}`;
    await expect(ensureCdpWallet({ attached: true })).resolves.toBeUndefined();
    expect(server.attached).toEqual([{ address: B, session: "session-of-b" }]);
  });

  it("a paid job that arrives during the silent attach waits for it, then asks", async () => {
    server.newAddress = true;
    server.factors = ["totp"];
    let release!: () => void;
    cdp.proofGate = new Promise<void>((r) => { release = r; });
    await mountFor("b@example.com");
    const paying = ensureCdpWallet({ attached: true });
    await settle();
    expect(asked).toEqual([]);
    cdp.proofGate = null;
    release();
    await expect(paying).resolves.toBeUndefined();
    expect(asked).toHaveLength(1);
    expect(server.attached).toEqual([{ address: B, session: "session-of-b" }]);
  });

  it("the silent attach that arrives during an asking one joins it and asks nothing of its own", async () => {
    server.newAddress = true;
    server.factors = ["totp"];
    cdp.initialized = false; // no silent sign-in: the paid job signs in, and its sign-in starts the silent attach
    await mountFor("b@example.com");
    let release!: () => void;
    factorGate = new Promise<void>((r) => { release = r; }); // the paid job's dialog stays open meanwhile
    const paying = ensureCdpWallet({ attached: true });
    await settle();
    expect(asked).toHaveLength(1);
    expect(server.attachCalls).toHaveLength(2);
    release();
    await expect(paying).resolves.toBeUndefined();
    await settle();
    expect(asked).toHaveLength(1);
    expect(server.attachCalls).toHaveLength(3);
  });

  it("a queued paid job posts with the session its caller had, not a later one", async () => {
    server.newAddress = true;
    server.factors = ["totp"];
    let release!: () => void;
    cdp.proofGate = new Promise<void>((r) => { release = r; });
    await mountFor("b@example.com");
    const paying = ensureCdpWallet({ attached: true });
    await settle();
    local.set("enki_session_token", "session-of-c");
    cdp.proofGate = null;
    release();
    await expect(paying).resolves.toBeUndefined();
    expect(new Set(server.attachCalls.map((c) => c.session))).toEqual(new Set(["session-of-b"]));
  });

  it("the silent attach ending does not make a later job forget the paid one it queued", async () => {
    server.newAddress = true;
    server.factors = ["totp"];
    let release!: () => void;
    cdp.proofGate = new Promise<void>((r) => { release = r; });
    await mountFor("b@example.com");
    const first = ensureCdpWallet({ attached: true });
    await settle();
    let close!: () => void;
    factorGate = new Promise<void>((r) => { close = r; });
    cdp.proofGate = null;
    release();
    await settle();
    expect(asked).toHaveLength(1); // the paid job's dialog is open, the silent one is over
    const second = ensureCdpWallet({ attached: true });
    await settle();
    close();
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    expect(asked).toHaveLength(1);
    expect(server.attached).toEqual([{ address: B, session: "session-of-b" }]);
  });

  it("a queued paid job stops when the account changed while it waited", async () => {
    server.newAddress = true;
    let release!: () => void;
    cdp.proofGate = new Promise<void>((r) => { release = r; });
    await mountFor("b@example.com");
    const paying = ensureCdpWallet({ attached: true });
    await settle();
    rt.unmount();
    release();
    await expect(paying).rejects.toThrow(/account changed/);
    expect(server.attachCalls).toHaveLength(1);
  });

  it("tells the person what the second and third ask are for", () => {
    expect(readSource(join(__dirname, "..", "..", "components", "StepUpProvider.tsx")))
      .toContain("Changing your wallet takes every factor you set up, one at a time.");
  });
});

describe("a banned account", () => {
  it("still signs; only a paid generation needs the attach, and says why", async () => {
    server.banned = true;
    await mountFor("b@example.com");
    await expect(requestCdpSign("tx")).resolves.toBe(`tx signed by ${B}`);
    await expect(ensureCdpWallet({ attached: true })).rejects.toThrow("This account is suspended.");
  });

  it("still publishes its EVM address — a ban never closes the wallet", async () => {
    server.banned = true;
    await mountFor("b@example.com");
    expect(getCdpEvmAddress()).toBe(wallet(B).evmAccountObjects[0].address);
  });
});

// Not nested under a mounted CdpWalletBridge: setExportIframeContainer has no
// ban (or sign-in) awareness at all — it is a plain DOM-node store, and that
// is the point. Asserted standalone rather than via mountFor so this never
// flows into CdpWalletBridge's createPortal return path, which this
// hand-rolled runtime (no real reconciler) isn't built to exercise — see
// cdp-export-iframe-migration.test.ts for the static checks that cover it.
describe("the export container registration (CDP-1)", () => {
  it("accepts a container unconditionally — no ban, no session, nothing", () => {
    const fakeContainer = { nodeType: 1 } as unknown as HTMLElement;
    setExportIframeContainer(fakeContainer);
    expect(getExportIframeContainer()).toBe(fakeContainer);
    setExportIframeContainer(null);
    expect(getExportIframeContainer()).toBeNull();
  });
});

describe("the EVM address (CDP-1, multichain starting point)", () => {
  it("publishes this mount's own EVM address once signed in, and clears it on unmount", async () => {
    expect(getCdpEvmAddress()).toBeNull();
    await mountFor("b@example.com");
    expect(getCdpEvmAddress()).toBe(wallet(B).evmAccountObjects[0].address);
    rt.unmount();
    await settle();
    expect(getCdpEvmAddress()).toBeNull();
  });

  it("is never set before this mount has signed in", async () => {
    server.jwt = "locked";
    await mountFor("b@example.com"); // the silent sign-in met the lock, never signed in
    expect(getCdpEvmAddress()).toBeNull();
  });
});

describe("while the wallet is locked", () => {
  it("offers the address this email had last, so the screens can offer the unlock", async () => {
    local.set("enki-cdp-address:b@example.com", B);
    server.jwt = "locked";
    await mountFor("b@example.com");
    expect(cdp.user).toBeNull();
    expect(getCdpSolanaAddress()).toBe(B);
  });
});

describe("right after an email login", () => {
  it("asks for the unlock at once, once", async () => {
    session.set("enki:wallet-ask", "1");
    server.jwt = "locked";
    await mountFor("b@example.com");
    expect(tokenFor).toHaveBeenCalledTimes(1);
    expect(getCdpSolanaAddress()).toBe(B);
    expect(session.has("enki:wallet-ask")).toBe(false);
  });
});
