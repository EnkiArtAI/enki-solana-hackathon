import { describe, expect, it, vi } from "vitest";
import { createElement, type ComponentType, type CSSProperties, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { WalletReadyState } from "@solana/wallet-adapter-base";
import { readSource } from "./_read-source";

/**
 * Kev, 2026-11-08, on the app's windows: "die sollen die font struktur von unserem layout haben, was wir u.a. auch bei settings
 * haben" (DEC-2026-11-08-01). The layout's type lives once, in components/enki-window.ts (TITLE, LABEL, TEXT), held here to
 * Settings' and the shell's own rules, and every window renders it: each is called as React renders it, the state of a screen
 * set by call order, the dialog's parts standing in for Radix and passing on the class and the style. The login popup's reset
 * steps (/reset-password?embed=1) and the login's wallet step keep the landing's type (DEC-2026-11-07-41..45): their markup is
 * held to what it was at de0e8719. Blind spot: no browser, so computed style and the loaded font files are not seen here.
 */
const ui = vi.hoisted(() => ({ i: 0, state: {} as Record<number, unknown>, query: "", wallets: [] as unknown[] }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (start: unknown) => { const i = ui.i++; return [i in ui.state ? ui.state[i] : start, () => {}]; },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {} }),
  useSearchParams: () => new URLSearchParams(ui.query),
  usePathname: () => "/home",
}));
vi.mock("@/hooks/useEmailAuth", () => ({ useEmailAuth: () => ({ account: "me@example.test", email: "me@example.test" }) }));
vi.mock("@solana/wallet-adapter-react", () => ({ useWallet: () => ({ wallets: ui.wallets, wallet: null, select: () => {}, connected: false }) }));
vi.mock("@/hooks/useSolanaAuth", () => ({ createSolanaAuthSession: () => {}, createSolanaAuthSessionWithSignIn: () => {} }));
vi.mock("@/components/ui/dialog", async () => {
  const { createElement: h } = await import("react");
  type Part = { className?: string; style?: CSSProperties; children?: ReactNode };
  return {
    Dialog: (p: { open: boolean; children: ReactNode }) => (p.open ? p.children : null),
    // The close button stands in only when a window gives it a look (closeStyle), so the landing picker renders as before.
    DialogContent: (p: Part & { overlayClassName?: string; closeStyle?: CSSProperties }) =>
      h("div", { className: p.className, style: p.style, "data-overlay": p.overlayClassName }, p.children, p.closeStyle ? h("button", { "data-close": "", style: p.closeStyle }) : null),
    DialogHeader: (p: Part) => h("div", { className: p.className }, p.children),
    DialogTitle: (p: Part) => h("h2", { className: p.className, style: p.style }, p.children),
    DialogDescription: (p: Part) => h("p", { className: p.className, style: p.style }, p.children),
  };
});

import { CARD, CODE, CTA, FIELD, LABEL, PILL, ROUND, TEXT, TITLE } from "@/components/enki-window";
import EnkiCardPage, { EnkiCardButton, EnkiCardInput } from "@/components/EnkiCardPage";
import ConfirmEmailWindow from "@/components/ConfirmEmailWindow";
import PrivateBetaWindow from "@/components/PrivateBetaWindow";
import UsernameOnboard from "@/components/enki-shell/UsernameOnboard";
import { WalletPickerModal } from "@/components/WalletPickerModal";
import SettingsLayout from "@/components/settings/SettingsLayout";
import GuardianPage from "../../app/guardian/page";
import ResetPasswordPage from "../../app/reset-password/page";
import ReferModal, { type ImportShown } from "@/components/enki-shell/ReferModal";
import FeedbackModal from "@/components/enki-shell/FeedbackModal";
import { ReportButton } from "@/components/ReportButton";
import { MessageButton } from "@/components/profile/MessageButton";
import { StepUpProvider } from "@/components/StepUpProvider";

const ROOT = join(__dirname, "..", "..");
const read = (file: string) => readFileSync(join(ROOT, file), "utf8").split("\r\n").join("\n").replace(/\/\*[^]*?\*\//g, "");
const SHELL = read("components/enki-shell/enki-shell.css");
const SETTINGS = read("components/settings/settings.css");
const GLOBALS = read("app/globals.css");
/** A top-level rule's declarations, as the stylesheet writes them (its first rule of that selector at a line's start). */
const rule = (css: string, selector: string): Record<string, string> => {
  const body = css.match(new RegExp(`\\n${selector.replace(/[.()]/g, "\\$&")} \\{([^}]*)\\}`))?.[1];
  if (body === undefined) throw new Error(`no rule ${selector}`);
  return Object.fromEntries(body.split(";").map((d) => d.trim()).filter(Boolean).map((d) => [d.slice(0, d.indexOf(":")).trim(), d.slice(d.indexOf(":") + 1).trim()]));
};
/** A style object as React writes it into the markup. */
const css = (style: CSSProperties) => renderToStaticMarkup(createElement("i", { style })).slice('<i style="'.length, -'"></i>'.length);
/** One screen of a component: its state by useState's call order, the page's query. */
function render<P extends object>(type: ComponentType<P>, props: P, state: Record<number, unknown> = {}, query = "") {
  ui.i = 0; ui.state = state; ui.query = query;
  try {
    return renderToStaticMarkup(createElement(type, props)).replace(/&#x27;/g, "'");
  } finally {
    ui.state = {};
  }
}
/** The text of every element whose own style sets a serif face or an italic: only the titles may. */
const serifs = (html: string) =>
  [...html.matchAll(/<[a-z0-9]+\b[^>]*\bstyle="([^"]*)"[^>]*>([^<]*)/g)].filter(([, s]) => /(?<!sans-)serif|italic/i.test(s)).map(([, , text]) => text);
/** The text of every heading that does not carry TITLE: the global h1-h6 rule (globals.css) would set its type. */
const bareHeadings = (html: string) =>
  [...html.matchAll(/<h[1-6]\b([^>]*)>([^<]*)/g)].filter(([, attrs]) => !attrs.includes(css({ ...TITLE, color: undefined })) && !/class="sr-only"/.test(attrs)).map(([, , text]) => text);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

// The reset page's useState order: mode 0, email 1, busy 2, error 3, done 4, codeSent 5, code 6, pw 7, pw2 8, request 9,
// progress 10, approved 11 (as lib/__tests__/old-card-tokens.test.ts drives it).
const RESET: Record<string, { state: Record<number, unknown>; title: string; eyebrow: string }> = {
  choice: { state: {}, title: "Get back into your account.", eyebrow: "Enki Art · Account" },
  email: { state: { 0: "email" }, title: "Reset via email.", eyebrow: "Enki Art · Account" },
  emailReady: { state: { 0: "email", 1: "a@b.co" }, title: "Reset via email.", eyebrow: "Enki Art · Account" },
  code: { state: { 0: "email", 1: "a@b.co", 3: "Boom", 5: true, 6: "1234567", 7: "abcdefgh", 8: "abcdefgx" }, title: "Check your inbox.", eyebrow: "Enki Art · Account" },
  codeReady: { state: { 0: "email", 1: "a@b.co", 5: true, 6: "1234567", 7: "abcdefgh", 8: "abcdefgh" }, title: "Check your inbox.", eyebrow: "Enki Art · Account" },
  guardian: { state: { 0: "guardian", 1: "a@b.co", 3: "Boom" }, title: "Reset via guardians.", eyebrow: "Enki Art · Recovery" },
  waiting: { state: { 0: "guardian", 3: "Boom", 9: { id: "i", key: "k" }, 10: { approved: 1, threshold: 3 } }, title: "Waiting for your guardians.", eyebrow: "Enki Art · Recovery" },
  approved: { state: { 0: "guardian", 3: "Boom", 7: "abcdefgh", 8: "abcdefgh", 9: { id: "i", key: "k" }, 11: true }, title: "You're approved.", eyebrow: "Enki Art · Recovery" },
  done: { state: { 4: true }, title: "You're back in.", eyebrow: "Enki Art · Account" },
};
// The wallet picker's useState order: connecting 0, solanaPhase 1, solanaError 2, result 3, readyToSign 4.
const WALLETS = [
  { adapter: { name: "Phantom", icon: "data:image/svg+xml,p", url: "https://phantom.app" }, readyState: WalletReadyState.Installed },
  { adapter: { name: "Solflare", icon: "", url: "https://solflare.com" }, readyState: WalletReadyState.NotDetected },
];
// Every screen of the guardian page. useState order: the page's own invite 0, error 1, busy 2, done 3, declined 4, mode 5; a
// sub-flow's states follow from 6 (recovery: code 6, busy 7, error 8, result 9; factor, check, delete: info 6, error 7,
// busy 8, result or done 9).
const INVITE = { guardianType: "email", maskedValue: "fr***@example.test", status: "pending", inviterHandle: "@kev" };
const WINVITE = { ...INVITE, guardianType: "wallet", maskedValue: "AbC123…xYz789" };
const FACTOR = { requesterHandle: "kev", factor: "passkey", guardianType: "email", maskedValue: "fr***@example.test", alreadyApproved: false, open: true };
const CHECK = { requesterHandle: "kev", guardianType: "email", maskedValue: "fr***@example.test", sentAt: "2026-11-01T00:00:00.000Z" };
const RECOVERY = "Enki Art · Recovery", ACCOUNT = "Enki Art · Account";
const GUARDIAN: Record<string, { query?: string; state: Record<number, unknown>; wallets?: unknown[]; title: string; eyebrow?: string }> = {
  error: { state: { 1: "This link isn't valid." }, title: "Hm, that didn't work." },
  loading: { state: {}, title: "One moment…" },
  accept: { state: { 0: INVITE, 1: "Could not confirm." }, title: "Become a guardian for @kev" },
  "accept, wallet": { state: { 0: WINVITE }, wallets: WALLETS, title: "Become a guardian for @kev" },
  "accept, no wallet installed": { state: { 0: WINVITE }, title: "Become a guardian for @kev" },
  decline: { state: { 0: INVITE, 5: "decline" }, title: "Decline the guardian role?" },
  declined: { state: { 0: INVITE, 4: true }, title: "No problem." },
  done: { state: { 0: INVITE, 3: true }, title: "You're a guardian now." },
  "recovery, code": { query: "recovery=r&g=g", state: { 8: "Wrong code." }, title: "Help your friend get back in." },
  "recovery, counted": { query: "recovery=r&g=g", state: { 9: { approved: 1, threshold: 2 } }, title: "Thank you — approval counted." },
  "factor, loading": { query: "factor=f&g=g&t=t", state: {}, title: "One moment…" },
  "factor, error": { query: "factor=f&g=g&t=t", state: { 7: "This link isn't valid." }, title: "Hm, that didn't work." },
  "factor, closed": { query: "factor=f&g=g&t=t", state: { 6: { ...FACTOR, open: false } }, title: "This request is closed." },
  "factor, already counted": { query: "factor=f&g=g&t=t", state: { 6: { ...FACTOR, alreadyApproved: true } }, title: "Your yes is already counted." },
  "factor, ask": { query: "factor=f&g=g&t=t", state: { 6: FACTOR, 7: "Could not count your yes." }, title: "@kev asks for your help" },
  "factor, ask a wallet": { query: "factor=f&g=g&t=t", state: { 6: { ...FACTOR, guardianType: "wallet", maskedValue: "AbC123…xYz789" } }, wallets: WALLETS, title: "@kev asks for your help" },
  "factor, counted": { query: "factor=f&g=g&t=t", state: { 6: FACTOR, 9: { approved: 1, needed: 2, done: false } }, title: "Thank you, your yes counts." },
  "check, loading": { query: "check=c&t=t", state: {}, title: "One moment…" },
  "check, error": { query: "check=c&t=t", state: { 7: "This link isn't valid." }, title: "Hm, that didn't work." },
  "check, ask": { query: "check=c&t=t", state: { 6: CHECK, 7: "Could not save your answer." }, title: "Still there for @kev?" },
  "check, ask a wallet": { query: "check=c&t=t", state: { 6: { ...CHECK, guardianType: "wallet", maskedValue: "AbC123…xYz789" } }, wallets: WALLETS, title: "Still there for @kev?" },
  "check, done": { query: "check=c&t=t", state: { 9: true }, title: "Thank you, you're still on the list." },
  "delete, loading": { query: "delete=d", state: {}, title: "One moment…", eyebrow: ACCOUNT },
  "delete, error": { query: "delete=d", state: { 7: "This link isn't valid." }, title: "Hm, that didn't work.", eyebrow: ACCOUNT },
  "delete, ask": { query: "delete=d", state: { 6: { requesterHandle: "kev", alreadyApproved: false }, 7: "Could not approve." }, title: "Approve deleting kev's account?", eyebrow: ACCOUNT },
  "delete, done": { query: "delete=d", state: { 6: { requesterHandle: "kev", alreadyApproved: false }, 9: true }, title: "Approved.", eyebrow: ACCOUNT },
};
const PICKER: Record<string, { state: Record<number, unknown>; wallets: unknown[] }> = {
  list: { state: {}, wallets: WALLETS },
  empty: { state: {}, wallets: [] },
  connecting: { state: { 0: "Phantom", 1: "signing", 2: "Couldn't connect (Phantom): no." }, wallets: WALLETS },
  readyToSign: { state: { 4: "Phantom" }, wallets: WALLETS },
  success: { state: { 3: "success" }, wallets: WALLETS },
  denied: { state: { 3: "denied" }, wallets: WALLETS },
};
const picker = (name: string, inApp: boolean) => {
  ui.wallets = PICKER[name].wallets;
  return render(WalletPickerModal, { open: true, onClose: () => {}, inApp }, PICKER[name].state);
};
const embedCard = () => render(EnkiCardPage, {
  embed: true, title: "Get back in.", eyebrow: "Enki Art · Recovery", onBack: () => {},
  children: [createElement(EnkiCardInput, { key: "i", placeholder: "you@example.com" }), createElement(EnkiCardButton, { key: "b" }, "Send code")],
});

/** What the popup's reset steps and the login's wallet step rendered at de0e8719, before the windows took the layout's type
 *  (sha256 of the markup, taken by this file's first run on that tree). A change here is a change to the landing's look. */
const AT_DE0E8719: Record<string, string> = {
  "card": "c72fc28654715a3573b6de233af7adddeab8b4b2141d60b992bc4eb6c818aa29",
  "embed approved": "43b47134f87c2e4797bfecc4420ea9e6d93725055fd9c85de2dd0fd83d9ad5a2",
  "embed choice": "b4bac7ea0a92cc9f83749b96699ec2a257b88081c74c9c20742f16f4748c4f9a",
  "embed code": "d13fbe38216e30982196d454a7ee69c50b328a0099b127bf20881e91e26358b8",
  "embed codeReady": "c065ac3d3ef4b41fc8f15d4598bfb021cdd9c1507e5c24fecab5361a948037ba",
  "embed done": "51414af28a7823739aa86c780513c17a67589a1f1498010252283ae490e599bb",
  "embed email": "e33c54fd5c6b9b373c380ce7ac2f4fb1a1f9a99bec6c51be29d681f555ca5cf9",
  "embed emailReady": "9f8bc9724dc39268206b0f6b56f4d6c5f6107176be76363efa76e91e899363df",
  "embed guardian": "d4f54e4628a4471e82154a0ab0778e44f96c6f7ac0683ed9ba45e45e7150b93f",
  "embed waiting": "d47bc7cf5bc2acfc18521d1293087a7d18c9a7f9e3e2f9e1f8f60586681f8b16",
  "landing picker connecting": "6faa10ba5dd80bb2f574dfa67bc75acf83f6b301e0c6cd32e4c7d6388b9c1f5f",
  "landing picker denied": "30fcc71b4e0aa4c505463b786563e0198163f7465e576b3ad8c61319665a255b",
  "landing picker empty": "c34eee206888ba9f1ef5707460bb99216efb8a58ebda2d5bd480fa092f7cf612",
  "landing picker list": "71bea896f2051303b53c1fc08cf253340972c776b90326fb6424f1c4d56370c2",
  "landing picker readyToSign": "a7952865f8fb76003f024c3c99bb82995cde5dc4615d53522d7e8a2256cc348b",
  "landing picker success": "d5ef8d2f174adb24eafd1939406a952fc6e0ff663963353dc47342bbd090d939",
};

describe("the layout's type, in one place (components/enki-window.ts)", () => {
  it("TITLE is the panels' page title, Settings.'s (.ek-page-title): the shell's serif, italic, 400, in the ink", () => {
    const page = rule(SHELL, ".ek-page-title");
    expect(render(SettingsLayout, { title: "Settings.", onBack: () => {}, children: null })).toContain('<h1 class="ek-page-title">Settings.</h1>');
    expect(TITLE).toMatchObject({ fontFamily: page["font-family"], fontStyle: page["font-style"], fontWeight: Number(page["font-weight"]), color: page.color });
    expect(page).toMatchObject({ "font-family": "var(--font-serif), Georgia, serif", "font-style": "italic", "font-weight": "400", color: "var(--enki-ink)" });
    // The face of Settings' section titles too: --font-serif is Instrument Serif.
    const section = rule(SETTINGS, ".set-section-title");
    expect(section["font-style"]).toBe("italic");
    expect(GLOBALS).toContain(`\n  --font-serif: ${section["font-family"].split(",")[0]}, `);
  });

  it("TITLE is sized for a window: under the page title's 30px on a phone, over Settings' 20px section titles", () => {
    const phone = Number(SHELL.match(/\n\s+\.ek-page-title \{ font-size: (\d+)px; \}/)?.[1]);
    expect(phone).toBe(30);
    expect(TITLE.fontSize).toBe(28);
    expect(TITLE.fontSize).toBeLessThan(phone);
    expect(TITLE.fontSize).toBeGreaterThan(parseFloat(rule(SETTINGS, ".set-section-title")["font-size"]));
    expect(TITLE.lineHeight).toBe(1.1);
    // Settings’ page title ("Settings.", h1.ek-page-title) sets no tracking of its own and renders the heading rule’s;
    // a window title plays that role, so it takes the same (DEC-2026-11-08-03).
    expect(rule(SHELL, ".ek-page-title")["letter-spacing"]).toBeUndefined();
    const heading = GLOBALS.match(/\nh1,\nh2,\nh3,\nh4,\nh5,\nh6 \{([^}]*)\}/)?.[1] ?? "";
    expect(TITLE.letterSpacing).toBe(heading.match(/letter-spacing:\s*([^;]+);/)?.[1].trim());
  });

  it("TITLE sets every property of the global h1-h6 rule, so the heading rule cannot reach a window's title", () => {
    const heading = GLOBALS.match(/\nh1,\nh2,\nh3,\nh4,\nh5,\nh6 \{([^}]*)\}/)?.[1] ?? "";
    const props = [...heading.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1].replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()));
    expect(props).toEqual(["fontFamily", "color", "fontWeight", "lineHeight", "letterSpacing"]);
    expect(heading).not.toContain("!important");
    for (const p of props) expect(TITLE, p).toHaveProperty(p);
  });

  it("LABEL is Settings' small label (.set-holdings-label) in the quiet label tone", () => {
    const label = rule(SETTINGS, ".set-holdings-label");
    expect(LABEL).toEqual({
      fontFamily: label["font-family"], fontSize: parseFloat(label["font-size"]), letterSpacing: label["letter-spacing"],
      textTransform: label["text-transform"], color: "var(--enki-label-quiet)",
    });
    expect(label).toMatchObject({ "font-family": "var(--font-jetbrains-mono), ui-monospace, monospace", "font-size": "10px", "letter-spacing": "2px", "text-transform": "uppercase" });
  });

  it("TEXT is Settings' text: the page's sans (.set-page) at a section description's size and leading (.set-section-desc)", () => {
    const desc = rule(SETTINGS, ".set-section-desc");
    expect(TEXT).toEqual({ fontFamily: rule(SETTINGS, ".set-page")["font-family"], fontSize: parseFloat(desc["font-size"]), lineHeight: Number(desc["line-height"]) });
    expect(TEXT).toEqual({ fontFamily: "var(--font-geist-sans), system-ui, sans-serif", fontSize: 13.5, lineHeight: 1.6 });
  });
});

describe("every window in scope renders it", () => {
  it.each([
    ["ask", { 0: true, 1: "a@b.co", 2: "ask" }, "Confirm your email"],
    ["code", { 0: true, 1: "a@b.co", 2: "code", 3: "once", 6: "That did not work. Try again." }, "Confirm your email"],
    ["done", { 0: true, 1: "a@b.co", 2: "done" }, "Email confirmed"],
  ])("Confirm your email, %s", (_name, state, title) => {
    const out = render(ConfirmEmailWindow, {}, state);
    expect(out).toContain(`<h2 class="text-center" style="${css(TITLE)}">${title}</h2>`);
    expect(out).toContain(`<p class="mt-2 text-center" style="${css({ ...TEXT, color: "var(--enki-ink-2)" })}">`);
    expect(serifs(out)).toEqual([title]);
    expect(bareHeadings(out)).toEqual([]);
  });

  it.each([
    ["ask", {}, "Private beta"],
    ["form", { 0: "form", 5: "Your request could not be sent. Try again." }, "Request access code"],
    ["done", { 0: "done" }, "Request sent"],
  ])("Private beta, %s", (_name, state, title) => {
    const out = render(PrivateBetaWindow, {}, state);
    expect(out).toContain(`<h2 class="text-center" style="${css(TITLE)}">${title}</h2>`);
    expect(out).toContain(`<p class="mt-2 text-center" style="${css({ ...TEXT, color: "var(--enki-ink-2)" })}">`);
    expect(serifs(out)).toEqual([title]);
    expect(bareHeadings(out)).toEqual([]);
  });

  it("the username picker: its eyebrow and its 'Free right now' as LABEL, its title, its line as TEXT", () => {
    // useState order: value 0, status 1, suggestions 2, saving 3, saveError 4.
    const out = render(UsernameOnboard, { email: null, wallet: null, onDone: () => {} }, { 0: "velvet_muse", 1: "free", 2: ["velvet_muse", "quiet_brush"], 4: "Could not save" });
    expect(out).toContain(`<span style="${css(LABEL)}">One last thing</span>`);
    expect(out).toContain(`<h1 style="${css({ ...TITLE, margin: "0 0 10px" })}">Pick your name.</h1>`);
    expect(out).toContain(`<p style="${css({ ...TEXT, color: "var(--enki-ink-2)", margin: "0 0 24px" })}">This is how other people`);
    expect(out).toContain(`<p style="${css({ ...LABEL, margin: "0 0 8px" })}">Free right now</p>`);
    expect(serifs(out)).toEqual(["Pick your name."]);
    expect(bareHeadings(out)).toEqual([]);
  });

  it.each(Object.keys(RESET))("the reset page on its own page, %s: the title, the eyebrow as LABEL, its lines as TEXT", (name) => {
    const { state, title, eyebrow } = RESET[name];
    const out = render(ResetPasswordPage, {}, state);
    expect(out).toContain(`<h1 style="${css({ ...TITLE, margin: "0 0 12px", color: "var(--card-ink)" })}">${title}</h1>`);
    expect(out).toContain(`<span style="${css({ ...LABEL, color: "var(--card-quiet)" })}">${eyebrow}</span>`);
    expect(out).toContain(`<p style="${css({ ...TEXT, color: "var(--card-ink-2)" })}`);
    expect(out).not.toContain("font-size:14px;line-height:1.6;color:var(--card-ink-2)");
    expect(serifs(out)).toEqual([title]);
    expect(bareHeadings(out)).toEqual([]);
  });

  it.each(Object.keys(GUARDIAN))("the guardian page, %s: the invite and its four sub-flows, error and done states included", (name) => {
    const { query = "", state, wallets = [], title, eyebrow = RECOVERY } = GUARDIAN[name];
    ui.wallets = wallets;
    const out = render(GuardianPage, {}, state, query);
    expect(out).toContain(`<h1 style="${css({ ...TITLE, margin: "0 0 12px", color: "var(--card-ink)" })}">${title}</h1>`);
    expect(out).toContain(`<span style="${css({ ...LABEL, color: "var(--card-quiet)" })}">${eyebrow}</span>`);
    if (title !== "One moment…") expect(out).toContain(`<p style="${css({ ...TEXT, color: "var(--card-ink-2)" })}`);
    expect(serifs(out)).toEqual([title]);
    expect(bareHeadings(out)).toEqual([]);
  });

  it("the card pages set masked wallets and the 7-digit code in the layout's mono (Settings' numbers), not the browser's (DEC-2026-11-08-02)", () => {
    expect(rule(SETTINGS, ".set-earn-num")["font-family"]).toBe(LABEL.fontFamily);
    const MONO = css({ fontFamily: LABEL.fontFamily });
    const guardian = (name: string) => {
      const { query = "", state, wallets = [] } = GUARDIAN[name];
      ui.wallets = wallets;
      return render(GuardianPage, {}, state, query);
    };
    for (const name of ["accept, wallet", "accept, no wallet installed", "factor, ask a wallet", "check, ask a wallet"]) {
      expect(guardian(name), name).toContain(`<span style="${MONO}">AbC123…xYz789</span>`);
    }
    // The field is the one field's class with CODE alone as its style (DEC-2026-11-08-19), so CODE renders in its own order.
    const code = `class="st-input"`;
    expect(css(CODE)).toBe(`text-align:center;font-size:26px;letter-spacing:0.45em;${MONO};font-weight:700`);
    expect(guardian("recovery, code").match(/<input [^>]*placeholder="1234567"[^>]*>/)?.[0]).toContain(` style="${css(CODE)}"`);
    expect(guardian("recovery, code").match(/<input [^>]*placeholder="1234567"[^>]*>/)?.[0]).toContain(code);
    expect(render(ResetPasswordPage, {}, RESET.code.state).match(/<input [^>]*placeholder="1234567"[^>]*>/)?.[0]).toContain(code);
    for (const name of Object.keys(GUARDIAN)) expect(guardian(name), name).not.toMatch(/font-family:(ui-)?monospace/);
    for (const name of Object.keys(RESET)) expect(render(ResetPasswordPage, {}, RESET[name].state), name).not.toMatch(/font-family:(ui-)?monospace/);
    for (const file of ["components/ConfirmEmailWindow.tsx", "components/PrivateBetaWindow.tsx", "components/EnkiCardPage.tsx", "components/enki-shell/UsernameOnboard.tsx", "components/WalletPickerModal.tsx", "app/guardian/page.tsx", "app/reset-password/page.tsx"]) {
      expect(readSource(join(ROOT, file)), file).not.toMatch(/fontFamily: "(ui-)?monospace"|font-mono\b/);
    }
  });

  it.each([
    ["list", "h2", "wp-title", "Connect a wallet", "p", "wp-sub"],
    ["empty", "h2", "wp-title", "Connect a wallet", "p", "wp-sub"],
    ["success", "div", "wp-result-title", "You’re in", "div", "wp-result-sub"],
    ["denied", "div", "wp-result-title", "Not allowed yet", "div", "wp-result-sub"],
  ])("the wallet picker in the app (the editor), %s", (name, tag, cls, title, subTag, subCls) => {
    const out = picker(name, true);
    expect(out).toContain(`<${tag} class="${cls}" style="${css(TITLE)}">${title}</${tag}>`);
    expect(out).toContain(`<${subTag} class="${subCls}" style="${css(TEXT)}">`);
    expect(serifs(out)).toEqual([title]);
    expect(bareHeadings(out)).toEqual([]);
  });

  it("no window in scope keeps the old title classes", () => {
    for (const file of ["components/ConfirmEmailWindow.tsx", "components/PrivateBetaWindow.tsx", "components/EnkiCardPage.tsx", "components/enki-shell/UsernameOnboard.tsx", "components/WalletPickerModal.tsx", "app/guardian/page.tsx", "app/reset-password/page.tsx"]) {
      expect(readSource(join(ROOT, file)), file).not.toMatch(/text-2xl|font-bold/);
    }
  });
});

/** A style attribute's declarations, as React writes them. */
const decls = (style: string) => Object.fromEntries(style.split(";").filter(Boolean).map((d) => [d.slice(0, d.indexOf(":")), d.slice(d.indexOf(":") + 1)]));
/** The declarations of the first element with a style of its own whose own text starts with `text`. */
const declsOf = (html: string, text: string) => {
  const hit = [...html.matchAll(/<[a-z0-9]+\b[^>]*\bstyle="([^"]*)"[^>]*>([^<]*)/g)].find(([, , own]) => own.startsWith(text));
  if (!hit) throw new Error(`no styled element reading ${text}`);
  return decls(hit[1]);
};
// Refer a prompt's useState order: url 0, step 1, error 2, title 3, category 4, generator 5, generators 6, opened 7.
const SHOWN: ImportShown = {
  prompt: "A neon city at dusk", title: "Neon city", category: "Portrait", tags: [], adult: true, generators: ["Nano Banana Pro"],
  photos: ["https://pbs.twimg.com/media/a.jpg"], source: { url: "https://x.com/a/status/1", handle: "a" },
};
const VERIFY = { 3: "Neon city", 4: "Portrait", 5: "Nano Banana Pro", 6: ["Nano Banana Pro", "Seedream"] };
const REFER: Record<string, Record<number, unknown>> = {
  link: {},
  "link, a post on X": { 0: "https://x.com/a/status/1", 2: "The post could not be read. Try again." },
  reading: { 1: { at: "reading" } },
  sent: { 1: { at: "sent" } },
  verify: { 1: { at: "verify", token: "t", shown: SHOWN }, 2: "The prompt could not be published. Try again.", ...VERIFY },
  publishing: { 1: { at: "publishing", token: "t", shown: SHOWN }, ...VERIFY },
};
// Feedback's useState order: sev 0, text 1, files 2, busy 3, attaching 4, done 5, mine 6.
const MINE = [{ id: "f1", at: "2026-11-01T00:00:00.000Z", preview: "The menu jumps", state: "open", paid: false, payoutCents: 0, txUrl: null }];
const refer = (name: string) => render(ReferModal, { onClose: () => {}, onPublished: () => {} }, REFER[name]);
const feedback = (state: Record<number, unknown>) => render(FeedbackModal, { onClose: () => {}, onToast: () => {} }, state);
/** Every stylesheet the app imports sits under components/ or app/ (the wallet adapter's aside). */
const STYLESHEETS = ["components", "app"].flatMap((dir) =>
  (readdirSync(join(ROOT, dir), { recursive: true }) as string[]).filter((f) => f.endsWith(".css")).map((f) => `${dir}/${f.split("\\").join("/")}`));
/** The stylesheet of each place a class is named in a selector, comments out: one entry means one rule, so the first rule
 *  rule() reads is the only one, and no later or more specific rule (a media query included) restyles the class. */
const namedIn = (cls: string) => STYLESHEETS.flatMap((f) => (read(f).match(new RegExp(`\\${cls}(?![\\w-])`, "g")) ?? []).map(() => f));
/** Every object literal, nested ones too, that names a serif face (SERIF, TITLE's spread, a serif family) and sets a weight,
 *  in any order. Innermost first; each is folded to 0 before its parent is read. */
const serifWeights = (src: string) => {
  const hits: string[] = [];
  for (let s = src, was = ""; s !== was; ) {
    was = s;
    s = s.replace(/\{[^{}]*\}/g, (o) => {
      if (/\bfontWeight\b/.test(o) && /\bSERIF\b|\.\.\.TITLE\b|(?<!sans-)serif|Instrument Serif/.test(o)) hits.push(o);
      return "0";
    });
  }
  return hits;
};

/**
 * The shell's own windows (Kev, 2026-11-08, on "Log off?", Refer and the rest: "it gotta also be the same style approach as
 * in the settings. if it looks severely different, then fix it"; DEC-2026-11-08-04): one title class in Settings' title type
 * at a header's 22px ("Feedback in!", a centred card with no header, takes TITLE: DEC-2026-11-08-05), the small labels as
 * LABEL, no synthesised bold on the serif (Instrument Serif ships 400 alone).
 * "Log off?" lives inside the shell (EnkiHome), so its markup is read as source; Refer and Feedback are rendered.
 */
describe("the shell's own windows take Settings' approach (DEC-2026-11-08-04)", () => {
  it(".ek-modal-title is TITLE's face, style, weight, tracking and ink, at a header's 22px, and nothing else", () => {
    const title = rule(SHELL, ".ek-modal-title");
    expect(title).toEqual({
      "font-family": TITLE.fontFamily, "font-style": TITLE.fontStyle, "font-weight": String(TITLE.fontWeight), "font-size": "22px",
      "letter-spacing": TITLE.letterSpacing, color: TITLE.color,
    });
    // Over Settings' 20px section titles, under a centred window's 28px.
    expect(parseFloat(title["font-size"])).toBeGreaterThan(parseFloat(rule(SETTINGS, ".set-section-title")["font-size"]));
    expect(parseFloat(title["font-size"])).toBeLessThan(Number(TITLE.fontSize));
    expect(STYLESHEETS).toEqual(expect.arrayContaining(["app/globals.css", "components/settings/settings.css", "components/studio/studio.css"]));
    expect(namedIn(".ek-modal-title")).toEqual(["components/enki-shell/enki-shell.css"]);
  });

  it(".ek-ed-lab, the windows' small label, is LABEL (Settings' .set-holdings-label)", () => {
    expect(rule(SHELL, ".ek-ed-lab")).toEqual({
      "font-family": LABEL.fontFamily, "font-size": `${LABEL.fontSize}px`, "letter-spacing": LABEL.letterSpacing,
      "text-transform": LABEL.textTransform, color: LABEL.color, margin: "0 0 6px", display: "block",
    });
    expect(namedIn(".ek-ed-lab")).toEqual(["components/enki-shell/enki-shell.css"]);
  });

  it("Log off? sets its title with the class, in its header bar", () => {
    const home = readSource(join(ROOT, "components/enki-shell/EnkiHome.tsx"));
    expect(home).toMatch(/<div className="ek-modal-head">\n\s+<span className="ek-sheet-bolt">[^\n]*\n\s+<span className="ek-modal-title">Log off\?<\/span>/);
  });

  it.each(Object.keys(REFER))("Refer a prompt, %s: the title by the class, no serif of its own", (name) => {
    const out = refer(name);
    expect(out).toContain('<span class="ek-modal-title" style="flex:1">Refer a prompt</span>');
    expect(serifs(out)).toEqual([]);
  });

  it("Refer a prompt's labels are .ek-ed-lab, with no face or size of their own", () => {
    const out = refer("verify");
    expect(out).toContain('<span class="ek-ed-lab">Prompt<span style="margin-left:8px;color:var(--enki-ember)">18+</span></span>');
    for (const label of ["Name", "Category", "Primary generator"]) expect(out).toContain(`<span class="ek-ed-lab" style="margin:0">${label}</span>`);
  });

  it("Feedback: the title by the class, its four labels as LABEL, the $100 upright serif without a synthesised bold", () => {
    const out = feedback({ 6: MINE });
    expect(out).toContain('<span class="ek-modal-title" style="flex:1">Feedback</span>');
    for (const label of ["How bad is it?", "What should change?", "Attachments · up to ", "Your feedback"]) {
      expect(declsOf(out, label), label).toMatchObject({ display: "block", ...decls(css(LABEL)) });
    }
    expect(serifs(out)).toEqual(["$100"]);
    expect(declsOf(out, "$100")).toEqual({ "font-family": "var(--font-serif), Georgia, serif", "font-size": "30px", color: "var(--enki-ember)", "line-height": "1", "flex-shrink": "0" });
  });

  it("Feedback, sent: 'Feedback in!' heads a centred card with no header bar, so it is TITLE at 28px (DEC-2026-11-08-05)", () => {
    const out = feedback({ 5: true });
    expect(out).not.toContain("ek-modal-head");
    expect(out).toContain(`<span style="${css({ ...TITLE, marginBottom: 3 })}">Feedback in!</span>`);
    expect(serifs(out)).toEqual(["Feedback in!"]);
  });

  it("the windows' small figures (a file's size, a report's date, the link's platform) are in the layout's mono, LABEL's face, as Settings' numbers (DEC-2026-11-08-06)", () => {
    const fb = feedback({ 2: [new File(["x"], "a.png", { type: "image/png" })], 6: MINE });
    expect(declsOf(fb, "Image")["font-family"]).toBe(LABEL.fontFamily);
    expect(declsOf(fb, new Date(MINE[0].at).toLocaleDateString(undefined, { month: "short", day: "numeric" }))["font-family"]).toBe(LABEL.fontFamily);
    const ref = refer("link, a post on X");
    expect(decls(ref.match(/<span style="([^"]*)">X<\/span>/)?.[1] ?? "")["font-family"]).toBe(LABEL.fontFamily);
    for (const out of [fb, feedback({ 5: true }), ...Object.keys(REFER).map(refer)]) expect(out).not.toMatch(/var\(--font-mono\)|font-family:(ui-)?monospace/);
    for (const file of ["components/enki-shell/ReferModal.tsx", "components/enki-shell/FeedbackModal.tsx"]) {
      expect(readSource(join(ROOT, file)), file).not.toMatch(/--font-mono|font-mono\b|"(ui-)?monospace"/);
    }
  });

  it("no shell window sets a weight on the serif, in any order", () => {
    expect(serifWeights("{ fontWeight: 700, ...(a ? { margin: 0 } : {}), fontFamily: SERIF }")).toHaveLength(1);
    for (const file of ["components/enki-shell/EnkiHome.tsx", "components/enki-shell/ReferModal.tsx", "components/enki-shell/FeedbackModal.tsx"]) {
      expect(serifWeights(readSource(join(ROOT, file))), file).toEqual([]);
    }
  });
});

describe("what keeps the landing's type", () => {
  it("the login popup's reset steps (/reset-password?embed=1) render as they did at de0e8719, the popup's DM Sans title included", () => {
    const now: Record<string, string> = { card: sha(embedCard()) };
    for (const [name, { state }] of Object.entries(RESET)) now[`embed ${name}`] = sha(render(ResetPasswordPage, {}, state, "embed=1"));
    expect(embedCard()).toContain('<h1 style="font-family:var(--font-dm-sans), \'DM Sans\', system-ui, sans-serif;font-weight:800;font-size:1.25rem;line-height:1.3;letter-spacing:normal;margin:0 0 12px;color:var(--card-ink)">Get back in.</h1>');
    expect(now).toEqual(Object.fromEntries(Object.keys(now).map((k) => [k, AT_DE0E8719[k]])));
  });

  it("the login's wallet step (the landing, LoginModal) renders as it did at de0e8719", () => {
    const now = Object.fromEntries(Object.keys(PICKER).map((name) => [`landing picker ${name}`, sha(picker(name, false))]));
    expect(picker("list", false)).toContain('<h2 class="wp-title">Connect a wallet</h2>');
    expect(now).toEqual(Object.fromEntries(Object.keys(now).map((k) => [k, AT_DE0E8719[k]])));
  });
});

// The shadcn windows: Report, Message and the step-up dialog (DEC-2026-11-08-10). useState order: Report open 0, reason 1,
// details 2, state 3; Message open 0, text 1, state 2; StepUp pending 0, mode 1, code 2, emailSent 3, busy 4, error 5.
const STEP = { scope: "delete-work:x", factors: ["passkey", "totp", "email"], resolve: () => {} };
const SHADCN: Record<string, () => string> = {
  "Report, ask": () => render(ReportButton, { targetType: "prompt", targetId: "p", children: "Report" }, { 0: true, 3: { error: "Boom" } }),
  "Report, sent": () => render(ReportButton, { targetType: "prompt", targetId: "p", children: "Report" }, { 0: true, 3: { sent: true } }),
  "Message, ask": () => render(MessageButton, { to: "u", name: "kev", signedIn: true, children: "Message" }, { 0: true, 2: { error: "Boom" } }),
  "Message, sent": () => render(MessageButton, { to: "u", name: "kev", signedIn: true, children: "Message" }, { 0: true, 2: { sent: true } }),
  "Step-up, choose": () => render(StepUpProvider, { children: null }, { 0: STEP }),
  "Step-up, email": () => render(StepUpProvider, { children: null }, { 0: STEP, 1: "email" }),
  "Step-up, code": () => render(StepUpProvider, { children: null }, { 0: STEP, 1: "totp", 5: "That did not work" }),
};
describe("the shadcn windows take the windows' title (DEC-2026-11-08-10)", () => {
  it.each(Object.keys(SHADCN))("%s: its one title is TITLE", (name) => {
    const titles = [...SHADCN[name]().matchAll(/<h2\b([^>]*)>/g)].map((m) => m[1]);
    expect(titles).toEqual([` style="${css(TITLE)}"`]);
  });
});

// Kev, 2026-11-08: "fixe alles uneinheitliche". "Confirm your email" and the step-up dialog asked for their code in Geist 18px
// (0.3em), the card pages in JetBrains Mono 26px (0.45em). One code field: the card pages' look (DEC-2026-11-08-11).
describe("one code field: CODE, the card pages' look, in every window that asks for a code (DEC-2026-11-08-11)", () => {
  const field = (html: string, placeholder: string) => html.match(new RegExp(`<input [^>]*placeholder="${placeholder}"[^>]*>`))?.[0] ?? "";
  const styleOf = (tag: string) => tag.match(/ style="([^"]*)"/)?.[1] ?? "";

  it("CODE is LABEL's face at 26px, 700, tracked 0.45em, centred, in the key order the popup's pinned field renders", () => {
    expect(Object.entries(CODE)).toEqual([["textAlign", "center"], ["fontSize", 26], ["letterSpacing", "0.45em"], ["fontFamily", LABEL.fontFamily], ["fontWeight", 700]]);
  });

  it("the guardian page, the reset page, Confirm your email and the step-up dialog render CODE in their code field", () => {
    // The card pages' field merges CODE into its own style (EnkiCardInput), so its declarations are compared as a map.
    const decls = (style: string) => Object.fromEntries(style.split(";").filter(Boolean).map((d) => [d.slice(0, d.indexOf(":")), d.slice(d.indexOf(":") + 1)]));
    const code = decls(css(CODE));
    expect(Object.keys(code).length).toBe(5);
    ui.wallets = [];
    expect(decls(styleOf(field(render(GuardianPage, {}, GUARDIAN["recovery, code"].state, GUARDIAN["recovery, code"].query), "1234567")))).toMatchObject(code);
    expect(decls(styleOf(field(render(ResetPasswordPage, {}, RESET.code.state), "1234567")))).toMatchObject(code);
    expect(styleOf(field(render(ConfirmEmailWindow, {}, { 0: true, 1: "a@b.co", 2: "code", 3: "once" }), "0000000")).startsWith(css(CODE))).toBe(true);
    expect(styleOf(field(render(StepUpProvider, { children: null }, { 0: STEP, 1: "totp" }), "000000")).startsWith(css(CODE))).toBe(true);
  });

  it("no code field keeps the sans size or tracking of its own", () => {
    for (const out of [render(ConfirmEmailWindow, {}, { 0: true, 1: "a@b.co", 2: "code", 3: "once" }), render(StepUpProvider, { children: null }, { 0: STEP, 1: "email", 3: true })]) {
      const tag = field(out, "0{6,7}");
      expect(tag).not.toBe("");
      expect(tag).not.toMatch(/tracking-|text-lg|text-center/);
    }
    for (const file of ["components/ConfirmEmailWindow.tsx", "components/StepUpProvider.tsx", "app/guardian/page.tsx", "app/reset-password/page.tsx"]) {
      expect(readSource(join(ROOT, file)), file).not.toMatch(/tracking-\[0\.3em\]|letterSpacing: "0\.45em"/);
    }
  });
});

// Kev, 2026-11-08: "fixe alles uneinheitliche". Report, Message and the step-up dialog wore shadcn's own frame (radius 8, a
// black 80% veil without blur), its buttons (radius 6, weight 500) and its fields, and their lines took no colour of the
// windows': they take the windows' look, as "Confirm your email" and "Private beta" do (DEC-2026-11-08-13).
describe("the shadcn windows take the windows' look: frame, veil, lines, buttons, fields (DEC-2026-11-08-13)", () => {
  /** The window alone: the dialog's content and what is in it (the trigger before it belongs to the page). */
  const windowOf = (html: string) => {
    const at = html.search(/<div [^>]*data-overlay="/);
    if (at < 0) throw new Error("no dialog content");
    return html.slice(at);
  };
  const styleOf = (attrs: string) => attrs.match(/ style="([^"]*)"/)?.[1] ?? "";

  it.each(Object.keys(SHADCN))("%s: CARD's frame over the windows' veil, the line as TEXT, every button a pill or the CTA", (name) => {
    const win = windowOf(SHADCN[name]());
    const [, cls, style, overlay] = win.match(/^<div class="([^"]*)" style="([^"]*)" data-overlay="([^"]*)">/) ?? [];
    expect(style).toBe(css(CARD));
    expect(cls).not.toMatch(/\brounded-/);
    expect(overlay.split(" ")).toEqual(expect.arrayContaining(["bg-black/50", "backdrop-blur-[6px]"]));
    expect(win).toContain(`<p style="${css({ ...TEXT, color: "var(--enki-ink-2)" })}">`);
    const buttons = [...win.matchAll(/<button\b([^>]*)>/g)].map((m) => m[1]).filter((b) => !/class="text-xs underline|data-close/.test(b));
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) expect([css(PILL), css(CTA)], b).toContain(styleOf(b));
    expect(win).not.toMatch(/text-red-600|border-input|bg-background|font-medium/);
  });

  it("the actions: Send the CTA, Close a pill; the step-up's factors pills and its confirm the CTA", () => {
    const button = (html: string, text: string) => styleOf(windowOf(html).match(new RegExp(`<button\\b([^>]*)>${text}</button>`))?.[1] ?? "");
    expect(button(SHADCN["Report, ask"](), "Send report")).toBe(css(CTA));
    expect(button(SHADCN["Report, sent"](), "Close")).toBe(css(PILL));
    expect(button(SHADCN["Message, ask"](), "Send")).toBe(css(CTA));
    expect(button(SHADCN["Message, sent"](), "Close")).toBe(css(PILL));
    for (const f of ["Use your passkey", "Use your authenticator app", "Get a code by email"]) expect(button(SHADCN["Step-up, choose"](), f), f).toBe(css(PILL));
    expect(button(SHADCN["Step-up, email"](), "Email me a code")).toBe(css(PILL));
    expect(button(SHADCN["Step-up, code"](), "Confirm with the app's code")).toBe(css(CTA));
  });

  it("every field is the app's one field: FIELD's class and no frame of its own, the step-up's code too (DEC-2026-11-08-19)", () => {
    const fields = ["Report, ask", "Message, ask", "Step-up, code"].flatMap((n) => [...windowOf(SHADCN[n]()).matchAll(/<(input|select|textarea)\b([^>]*)>/g)].map((m) => [n, m[1], m[2]] as const));
    expect(fields.map(([n, tag]) => `${n} ${tag}`)).toEqual(["Report, ask select", "Report, ask textarea", "Message, ask textarea", "Step-up, code input"]);
    expect(FIELD).toBe("st-input");
    for (const [n, tag, attrs] of fields) {
      expect(attrs, `${n} ${tag}`).toContain(`class="${FIELD}"`);
      // An inline frame or colour would beat the class, its focus border included, so a field carries none.
      expect(Object.keys(decls(styleOf(attrs))).filter((k) => /^(background|border|border-color|border-radius|color|padding)$/.test(k)), `${n} ${tag}`).toEqual([]);
    }
  });

  it("the step-up's error is in the theme's danger, not Tailwind's red", () => {
    expect(windowOf(SHADCN["Step-up, code"]())).toContain('<p class="text-sm" style="color:var(--enki-danger)">That did not work</p>');
    expect(readSource(join(ROOT, "components/StepUpProvider.tsx"))).not.toMatch(/text-red-\d/);
  });
});

// Kev, 2026-11-08: "fixe alles uneinheitliche". The windows closed and went back by five corners: shadcn's bare X at 70%
// opacity, the same classes for the backs, an 8px box with "←" on the card pages, a 26px square in the NFT picker, a 30px
// filled square in the reviews. One corner: the shell's (.ek-modal-x), as ROUND (DEC-2026-11-08-14).
describe("one window corner: ROUND, the shell's close, for every close and back (DEC-2026-11-08-14)", () => {
  const CLOSE = `<button data-close="" style="${css(ROUND)}"></button>`;

  it("ROUND is .ek-modal-x without its header-row margin, and opaque", () => {
    const { "margin-left": margin, ...x } = rule(SHELL, ".ek-modal-x");
    expect(margin).toBe("auto");
    expect(decls(css(ROUND))).toEqual({ ...x, opacity: "1" });
  });

  it.each([
    ["Confirm your email", () => render(ConfirmEmailWindow, {}, { 0: true, 1: "a@b.co", 2: "ask" })],
    ["Private beta", () => render(PrivateBetaWindow, {}, {})],
    ["the wallet picker in the app", () => picker("list", true)],
    ["Report", SHADCN["Report, ask"]],
    ["Message", SHADCN["Message, ask"]],
    ["the step-up dialog", SHADCN["Step-up, choose"]],
  ])("%s closes by ROUND", (_name, out) => {
    expect(out()).toContain(CLOSE);
  });

  it("the landing's wallet picker keeps shadcn's X (its markup is pinned above)", () => {
    for (const name of Object.keys(PICKER)) expect(picker(name, false), name).not.toContain("data-close");
  });

  it("the windows' backs are ROUND: Confirm your email's code step, Private beta's form, the card pages", () => {
    const back = (html: string) => html.match(/<button\b([^>]*)aria-label="Back"[^>]*>/)?.[0] ?? "";
    expect(back(render(ConfirmEmailWindow, {}, { 0: true, 1: "a@b.co", 2: "code" }))).toContain(` style="${css(ROUND)}"`);
    expect(back(render(PrivateBetaWindow, {}, { 0: "form" }))).toContain(` style="${css(ROUND)}"`);
    const card = render(EnkiCardPage, { title: "Get back in.", eyebrow: "Enki Art · Recovery", onBack: () => {}, children: null });
    expect(back(card)).toContain(` style="${css({ ...ROUND, cursor: "pointer", marginRight: 4 })}"`);
    expect(card).toMatch(/aria-label="Back"[^>]*><svg[^>]*lucide-chevron-left/);
    expect(card).not.toContain("←");
    // In the login popup the back stays the popup's own (its markup is pinned above).
    expect(embedCard()).toContain('<button aria-label="Back" class="auth-close">←</button>');
  });
});
