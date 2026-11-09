import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Fragment, isValidElement, type ReactElement, type ReactNode } from "react";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { readSource } from "./_read-source";
import { fakePostgrest } from "./_fake-postgrest";

/**
 * "Private beta" (Kev, 2026-11-07: "nicht in der beta, ja. die sollen sich ruhig drauf bewerben"): the window a signed-in
 * account without beta access meets, and a provider login refused as not on the access list. The component is called as React
 * would render it, with state kept between calls, and its real handlers driven; the dialog's parts stand in for Radix. The
 * application goes to the real /api/access-request on a fake database, another applicant's row first and unchanged.
 * Blind spot: no browser, so layout, focus and the look are not seen here; the agents' pane stops at the access gate.
 */
const ui = vi.hoisted(() => ({
  state: [] as unknown[], s: 0, email: "me@example.test" as string | null, push: [] as string[],
  dialog: null as null | { open: boolean; onOpenChange: (open: boolean) => void },
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: <T>(start: T | (() => T)) => {
    const i = ui.s++;
    if (!(i in ui.state)) ui.state[i] = typeof start === "function" ? (start as () => T)() : start;
    return [ui.state[i], (next: unknown) => { ui.state[i] = typeof next === "function" ? (next as (p: unknown) => unknown)(ui.state[i]) : next; }];
  },
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: (to: string) => ui.push.push(to), replace: () => {} }), usePathname: () => "/home" }));
vi.mock("@/hooks/useEmailAuth", () => ({ useEmailAuth: () => ({ email: ui.email }) }));
vi.mock("@/components/ui/dialog", async () => {
  const { createElement: h } = await import("react");
  return {
    Dialog: (p: { open: boolean; onOpenChange: (open: boolean) => void; children: ReactNode }) => { ui.dialog = p; return p.open ? p.children : null; },
    DialogContent: (p: { children: ReactNode }) => p.children,
    DialogTitle: (p: { children: ReactNode }) => h("h2", null, p.children),
    DialogDescription: (p: { children: ReactNode }) => h("p", null, p.children),
  };
});
const db = fakePostgrest();
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => db.client }));

import PrivateBetaWindow from "@/components/PrivateBetaWindow";
import { POST as accessRequest } from "../../app/api/access-request/route";

type El = ReactElement<Record<string, unknown>>;
function flat(node: unknown, out: (El | string)[] = []): (El | string)[] {
  if (node === null || node === undefined || typeof node === "boolean") return out;
  if (typeof node === "string" || typeof node === "number") { out.push(String(node)); return out; }
  if (Array.isArray(node)) { node.forEach((n) => flat(n, out)); return out; }
  if (!isValidElement(node)) return out;
  const el = node as El;
  if (typeof el.type === "function") return flat((el.type as (p: unknown) => unknown)(el.props), out);
  if ((el.type as unknown) !== Fragment) out.push(el);
  return flat(el.props.children, out);
}
let props: { next?: string } = {};
const render = () => { ui.s = 0; return flat(PrivateBetaWindow(props)); };
const words = (tree: (El | string)[]) => tree.filter((n) => typeof n === "string").join(" ");
const hosts = (tree: (El | string)[]) => tree.filter((n): n is El => typeof n !== "string");
const textOf = (el: El) => words(flat(el.props.children));
const buttons = (tree: (El | string)[]) => hosts(tree).filter((e) => e.type === "button").map((e) => textOf(e) || String(e.props["aria-label"]));
const button = (tree: (El | string)[], name: string) => {
  const found = hosts(tree).find((e) => e.type === "button" && (textOf(e) === name || e.props["aria-label"] === name));
  if (!found) throw new Error(`no button "${name}" in: ${words(tree)}`);
  return found.props as { onClick: () => unknown; disabled?: boolean };
};
const field = (label: string) => hosts(render()).find((e) => e.props["aria-label"] === label)!;
const type = (label: string, value: string) => (field(label).props as { onChange: (e: unknown) => void }).onChange({ target: { value } });
const submit = async () => {
  (hosts(render()).find((e) => e.type === "form")!.props as { onSubmit: (e: unknown) => void }).onSubmit({ preventDefault: () => {} });
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
const title = (tree: (El | string)[]) => textOf(hosts(tree).find((e) => e.type === "h2")!);
const line = (tree: (El | string)[]) => textOf(hosts(tree).find((e) => e.type === "p")!);
const alert = (tree: (El | string)[]) => hosts(tree).filter((e) => e.props.role === "alert").map(textOf);

let posts: { url: string; body: unknown }[];
let answers: Array<{ status: number; body: unknown } | "offline" | "real">;
const OTHER = { id: "00000000-0000-4000-8000-000000000001", email: "someone@else.test", about: "theirs", socials: null, status: "pending" };

beforeEach(() => {
  ui.state.length = 0;
  ui.email = "me@example.test";
  ui.push = [];
  ui.dialog = null;
  props = {};
  posts = [];
  answers = [];
  for (const k of Object.keys(db.tables)) delete db.tables[k];
  db.tables.access_requests = [{ ...OTHER }];
  db.state.failNext = null;
  vi.stubGlobal("window", { location: { pathname: "/home", search: "?tab=feed" } });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    posts.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
    const a = answers.shift() ?? "real";
    if (a === "offline") throw new TypeError("Failed to fetch");
    if (a === "real") return accessRequest(new NextRequest(`http://enki.test${url}`, { method: "POST", headers: { "x-real-ip": randomUUID() }, body: init?.body }));
    return new Response(JSON.stringify(a.body), { status: a.status });
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  expect(db.tables.access_requests[0]).toEqual(OTHER);
});

describe("the window", () => {
  it("as Kev's screenshot: the logo, Private beta, one grey line, two stacked pills in this order", () => {
    const tree = render();
    expect(ui.dialog!.open).toBe(true);
    expect(hosts(tree).find((e) => e.type === "img")!.props.src).toBe("/favicon.svg");
    expect(title(tree)).toBe("Private beta");
    expect(line(tree)).toBe("You'll need an access code to get in.");
    expect(buttons(tree)).toEqual(["Enter access code", "Request access code"]);
    expect(hosts(tree).find((e) => e.type === "div" && e.props.className === "mt-6 grid gap-3")).toBeTruthy();
  });

  it("Enter access code opens the code entry with this page as its next", () => {
    button(render(), "Enter access code").onClick();
    expect(ui.push).toEqual(["/gate?next=%2Fhome%3Ftab%3Dfeed"]);
    props = { next: "/home" };
    button(render(), "Enter access code").onClick();
    expect(ui.push.at(-1)).toBe("/gate?next=%2Fhome");
  });

  it("× leaves for the landing, Back returns from the application to the two pills", () => {
    button(render(), "Request access code").onClick();
    expect(title(render())).toBe("Request access code");
    button(render(), "Back").onClick();
    expect(buttons(render())).toEqual(["Enter access code", "Request access code"]);
    ui.dialog!.onOpenChange(false);
    expect(ui.push).toEqual(["/"]);
  });
});

describe("the application", () => {
  const open = () => button(render(), "Request access code").onClick();

  it("takes the session's email, a few words about you, and socials if you like; it is stored and says what happens next", async () => {
    open();
    const tree = render();
    expect(line(tree)).toBe("Tell us a little about you. We read every request.");
    expect((field("Your email").props as { value: string }).value).toBe("me@example.test");
    expect(hosts(tree).filter((e) => e.props["aria-label"]).map((e) => e.props["aria-label"])).toEqual(["Back", "Your email", "A few words about you", "Socials (optional)"]);
    expect(button(render(), "Send request").disabled).toBe(true);
    type("A few words about you", "  I paint with prompts  ");
    expect(button(render(), "Send request").disabled).toBe(false);
    type("Socials (optional)", "x.com/me");
    await submit();
    expect(posts).toEqual([{ url: "/api/access-request", body: { email: "me@example.test", about: "I paint with prompts", socials: "x.com/me" } }]);
    expect(db.tables.access_requests.slice(1)).toEqual([expect.objectContaining({ email: "me@example.test", about: "I paint with prompts", socials: "x.com/me" })]);
    const done = render();
    expect(title(done)).toBe("Request sent");
    expect(line(done)).toBe("Thanks. We read every request. If we let you in, an email to me@example.test tells you how to sign in.");
    expect(buttons(done)).toEqual([]);
  });

  // hooks/useEmailAuth answers null on its first render and reads the session in an effect (DEC-2026-11-07-34).
  it("the session's email that arrives after the first render fills the field; a typed one wins, an emptied one stays empty", () => {
    ui.email = null;
    render();
    ui.email = "me@example.test";
    open();
    expect((field("Your email").props as { value: string }).value).toBe("me@example.test");
    type("Your email", "other@example.test");
    expect((field("Your email").props as { value: string }).value).toBe("other@example.test");
    type("Your email", "");
    expect((field("Your email").props as { value: string }).value).toBe("");
  });

  it("with no email in the session it starts empty and waits for one", async () => {
    ui.email = null;
    open();
    expect((field("Your email").props as { value: string }).value).toBe("");
    type("A few words about you", "hello");
    expect(button(render(), "Send request").disabled).toBe(true);
    type("Your email", "New@Example.test ");
    await submit();
    expect(db.tables.access_requests.slice(1)).toEqual([expect.objectContaining({ email: "new@example.test", about: "hello", socials: null })]);
  });

  it("a refusal shows the server's words and keeps the form; no answer says to try again", async () => {
    open();
    type("Your email", "not-an-email");
    type("A few words about you", "hello");
    await submit();
    expect(alert(render())).toEqual(["Please enter a valid email address."]);
    expect(title(render())).toBe("Request access code");
    expect(db.tables.access_requests).toHaveLength(1);
    answers.push("offline");
    await submit();
    expect(alert(render())).toEqual(["Your request could not be sent. Try again."]);
    answers.push({ status: 200, body: {} });
    await submit();
    expect(title(render())).toBe("Request access code"); // a 200 without ok is no success
  });

  it("× while sending does nothing", async () => {
    open();
    type("A few words about you", "hello");
    let release!: (r: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((r) => { release = r; })));
    (hosts(render()).find((e) => e.type === "form")!.props as { onSubmit: (e: unknown) => void }).onSubmit({ preventDefault: () => {} });
    render();
    ui.dialog!.onOpenChange(false);
    expect(ui.push).toEqual([]);
    release(new Response(JSON.stringify({ ok: true })));
  });
});

describe("pinned in the source", () => {
  const ROOT = join(__dirname, "..", "..");
  const source = readSource(join(ROOT, "components", "PrivateBetaWindow.tsx"));

  it("the confirm window's look, the app's dialog and backdrop, only the theme's tokens, and no mail link", () => {
    expect(source).toContain('import { CARD, CORNER, CTA, FIELD, PILL, ROUND, TEXT, TITLE } from "@/components/enki-window";');
    // The windows' field lives with the rest of the look (DEC-2026-11-08-12): the app's one field, by its class alone (DEC-2026-11-08-19).
    expect(source).not.toMatch(/const FIELD\b|FIELD_LOOK/);
    expect(source).toContain('from "@/components/ui/dialog"');
    expect(source).toContain('overlayClassName="z-[10028] bg-black/50 backdrop-blur-[6px]" style={CARD}');
    expect(source).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
    expect(source).not.toContain("mailto:");
  });

  it("the closed beta shows it to a signed-in account without access, and a provider login off the access list gets it too", () => {
    const gate = readSource(join(ROOT, "components", "BetaGate.tsx"));
    expect(gate).toContain('import PrivateBetaWindow from "@/components/PrivateBetaWindow";');
    expect(gate).toMatch(/access === "denied" \? \(\n\s+<PrivateBetaWindow \/>/);
    const complete = readSource(join(ROOT, "app", "auth", "complete", "page.tsx"));
    expect(complete).toContain('{fragmentCode === "not_whitelisted" && <PrivateBetaWindow next="/home" />}');
  });
});
