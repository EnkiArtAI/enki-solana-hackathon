import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { readSource } from "./_read-source";
import { isValidElement, type ReactElement, type ReactNode } from "react";

/**
 * A name Enki picked (SQL 46, users.handle_auto) is not the owner's choice: the gate's own check carries it, and the
 * shell opens the first-login name picker for it as for no name at all, until the owner saves another one. The gate
 * and the shell are called as React would render them, with their state kept between calls; the shell reads what
 * the gate provides.
 */
const ui = vi.hoisted(() => ({
  gate: [] as unknown[], state: [] as unknown[], s: 0, effects: [] as (() => unknown)[],
  ctx: null as unknown, headers: {} as Record<string, string>, answer: {} as Record<string, unknown>,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: <T>(start: T | (() => T)) => {
    const i = ui.s++;
    const st = ui.state;
    if (!(i in st)) st[i] = typeof start === "function" ? (start as () => T)() : start;
    return [st[i], (next: unknown) => { st[i] = typeof next === "function" ? (next as (p: unknown) => unknown)(st[i]) : next; }];
  },
  useEffect: (fn: () => unknown) => { ui.effects.push(fn); },
  useLayoutEffect: () => {}, useEffectEvent: <T>(f: T) => f,
  useSyncExternalStore: (_subscribe: unknown, _read: unknown, server: () => unknown) => server(),
  useRef: <T>(current: T) => ({ current }),
  useContext: () => ui.ctx,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/home", useSearchParams: () => new URLSearchParams() }));
vi.mock("@/components/enki/CreateView", () => ({ default: () => null }));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ resetQueries: vi.fn(), removeQueries: vi.fn(), invalidateQueries: vi.fn() }),
  // Studio's projects in the shell's menu (useStudioProjects): none.
  useQuery: () => ({ data: undefined, error: null }),
}));
vi.mock("@/lib/session-headers", async (original) => ({
  ...(await original<typeof import("@/lib/session-headers")>()),
  sessionAuthHeaders: () => ui.headers,
}));
vi.mock("@/lib/cdp-bridge", () => ({ CDP_ADDRESS_EVENT: "enki-cdp-address" }));
vi.mock("@/hooks/useEmailAuth", () => ({ forgetSession: vi.fn(), useEmailAuth: () => ({ isAuthed: false }) }));
vi.mock("thirdweb/react", () => ({ useActiveAccount: () => null }));
vi.mock("@solana/wallet-adapter-react", () => ({ useWallet: () => ({ connected: false, disconnect: vi.fn() }) }));
vi.mock("@/providers/ThemeProvider", () => ({ useTheme: () => ({ theme: "light", setTheme: vi.fn() }) }));
vi.mock("@/hooks/useHoldings", () => ({ useHoldings: () => ({ ready: false, balance: 0 }) }));
vi.mock("@/hooks/useMediaQuery", () => ({ useMediaQuery: () => false }));
vi.mock("@/hooks/useViewerWallets", () => ({ useViewerWallets: () => ({ payer: null }) }));
vi.mock("@/hooks/useCdpAddress", () => ({ useCdpAddress: () => ({ address: null }) }));
vi.mock("@/hooks/useSolanaAuth", () => ({ useSolanaAuth: () => ({ isAuthenticated: false }) }));
vi.mock("@/hooks/useRecoveryStatus", () => ({ useRecoveryStatus: () => null }));
vi.mock("@/hooks/useSecondFactor", () => ({ useNeeds2fa: () => false }));
vi.mock("@/hooks/useNotifications", () => ({ useNotifications: () => ({ unseen: 0 }) }));
vi.mock("@/hooks/useMessages", () => ({ useMessages: () => ({ unreadTotal: 0 }) }));
vi.mock("@/components/enki-shell/UsernameOnboard", () => ({ default: function UsernameOnboard() { return null; } }));
vi.mock("@/components/enki-shell/AnalyticsPanel", () => ({ default: () => null }));
vi.mock("@/components/enki-shell/NotificationsPanel", () => ({ default: () => null }));
vi.mock("@/components/enki-shell/MessagesPanel", () => ({ default: () => null }));
vi.mock("@/components/enki/EnkiFeedPage", () => ({ default: () => null }));
vi.mock("@/components/enki-shell/EnkiSidebar", () => ({ default: () => null }));
vi.mock("@/components/enki-shell/BookmarksPanel", () => ({ default: () => null }));
vi.mock("@/components/enki-shell/FeedbackModal", () => ({ default: () => null }));
vi.mock("@/components/enki-shell/EnkiPanel", () => ({ default: () => null }));
vi.mock("@/components/LoginModal", () => ({ default: () => null }));
vi.mock("@/components/settings/SettingsView", () => ({ default: () => null }));
vi.mock("@/components/profile/ProfileView", () => ({ default: () => null }));
vi.mock("../../app/leaderboard/page", () => ({ default: () => null }));

import BetaGate from "@/components/BetaGate";
import EnkiHome from "@/components/enki-shell/EnkiHome";
import UsernameOnboard from "@/components/enki-shell/UsernameOnboard";

type Access = { handle: string | null | undefined; handleAuto: boolean; setHandle: (h: string | null) => void };
function* walk(node: ReactNode): Generator<ReactElement<Record<string, unknown>>> {
  if (Array.isArray(node)) for (const n of node) yield* walk(n);
  else if (isValidElement<Record<string, unknown>>(node)) { yield node; yield* walk(node.props.children as ReactNode); }
}
/** The gate as rendered now: what it provides. */
const gate = (): Access => {
  ui.s = 0; ui.state = ui.gate; ui.effects = [];
  return (BetaGate({ children: null }) as ReactElement<{ value: Access }>).props.value;
};
/** The gate's session check, as a new session (or none) runs it. */
const check = async () => {
  gate();
  for (const run of ui.effects) run();
  await new Promise((r) => setTimeout(r, 0));
  return gate();
};
/** Whether the shell, reading what the gate provides, shows the name picker. */
const picker = () => {
  ui.ctx = gate();
  ui.s = 0; ui.state = []; ui.effects = [];
  return [...walk(EnkiHome({ children: null }))].some((el) => el.type === UsernameOnboard);
};

beforeEach(() => {
  ui.gate = []; ui.ctx = null;
  ui.headers = { "X-Session-Token": "tok" };
  ui.answer = { id: "user-1", handle: "velvet_muse_0427", handleAuto: true, role: "beta" };
  vi.stubGlobal("window", {
    addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: () => true, scrollTo: vi.fn(),
    location: { pathname: "/home" },
  });
  vi.stubGlobal("CustomEvent", class extends Event {});
  vi.stubGlobal("fetch", async () => ({ ok: true, status: 200, json: async () => ui.answer, clone() { return this; } }));
});
afterEach(() => vi.unstubAllGlobals());

describe("a name Enki picked", () => {
  it("is carried by the gate, and the shell asks for a name over it", async () => {
    expect(await check()).toMatchObject({ handle: "velvet_muse_0427", handleAuto: true });
    expect(picker()).toBe(true);
  });

  it("is the owner's once they save another name: the picker closes", async () => {
    (await check()).setHandle("kev_art");
    expect(gate()).toMatchObject({ handle: "kev_art", handleAuto: false });
    expect(picker()).toBe(false);
  });

  it("is the owner's when the picker saves it unchanged: the name is kept, the picker closes", async () => {
    await check();
    ui.ctx = gate();
    ui.s = 0; ui.state = []; ui.effects = [];
    const onboard = [...walk(EnkiHome({ children: null }))].find((el) => el.type === UsernameOnboard);
    (onboard!.props.onDone as (h: string) => void)("velvet_muse_0427");
    expect(gate()).toMatchObject({ handle: "velvet_muse_0427", handleAuto: false });
    expect(picker()).toBe(false);
  });

  it("asks with the session, so one's own name reads as free", () => {
    const src = readSource(join(__dirname, "..", "..", "components", "enki-shell", "UsernameOnboard.tsx"));
    expect(src).toContain("fetch(`/api/users/handle?name=${encodeURIComponent(name)}`, { headers: sessionAuthHeaders() })");
  });

  it("stays Enki's when the same name is saved again (a profile save without a rename)", async () => {
    (await check()).setHandle("velvet_muse_0427");
    expect(gate().handleAuto).toBe(true);
    expect(picker()).toBe(true);
  });

  it("goes with the session: signed out, nothing is Enki's and no picker opens", async () => {
    await check();
    ui.headers = {};
    expect(await check()).toMatchObject({ handle: undefined, handleAuto: false });
    expect(picker()).toBe(false);
  });
});

describe("the names as before", () => {
  it("a chosen name, or one read before SQL 46, opens no picker", async () => {
    ui.answer = { ...ui.answer, handleAuto: false };
    expect((await check()).handleAuto).toBe(false);
    expect(picker()).toBe(false);
    ui.gate = [];
    ui.answer = { id: "user-1", handle: "kev", role: "beta" };
    expect((await check()).handleAuto).toBe(false);
    expect(picker()).toBe(false);
  });

  it("no name yet opens it, and a name still loading does not", async () => {
    expect(gate().handle).toBeUndefined();
    expect(picker()).toBe(false);
    ui.answer = { id: "user-1", handle: null, role: "beta" };
    expect((await check()).handle).toBeNull();
    expect(picker()).toBe(true);
  });
});
