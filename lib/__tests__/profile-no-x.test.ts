import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { readSource } from "./_read-source";

/**
 * DEC-459 (Kev, 2026-10-27: "remove the X bei einem profile oben rechts, das back button links reicht vollständig"):
 * the own profile and a creator's page open without the panel's floating X; their Back, Esc and the scrim close them.
 * DEC-468 (Kev, 2026-10-27: "statt X auf der rechten seite, pack doch einfach nen pfeil oben links rein"): every other
 * panel's way out is an arrow at its top left, on its own line above the headline.
 */
vi.mock("react", async (orig) => ({ ...(await orig<typeof import("react")>()), useEffect: () => {} }));
import EnkiPanel from "@/components/enki-shell/EnkiPanel";

function* walk(node: ReactNode): Generator<ReactElement<Record<string, unknown>>> {
  if (Array.isArray(node)) for (const n of node) yield* walk(n);
  else if (isValidElement<Record<string, unknown>>(node)) { yield node; yield* walk(node.props.children as ReactNode); }
}
const xs = (tree: ReactNode) => [...walk(tree)].filter((el) => String(el.props.className ?? "").startsWith("ek-panel-back"));
const body = (tree: ReactNode) => [...walk(tree)].find((el) => el.props.className === "ek-panel-body")!;

describe("the panel's way out", () => {
  it("is an arrow first in the panel's body, before its content, that closes it; none with hideClose", () => {
    const onClose = vi.fn();
    const content = createElement("p", null, "Hall of Fame.");
    const kids = ([body(EnkiPanel({ title: "Hall of Fame", onClose, children: content, full: true })).props.children].flat() as ReactNode[]).filter(isValidElement) as ReactElement<Record<string, unknown>>[];
    expect(kids.map((k) => k.props.className ?? k.type)).toEqual(["ek-panel-back kit-hit ek-tuck-hide", "p"]);
    expect(kids[0].props).toMatchObject({ type: "button", "aria-label": "Close Hall of Fame", onClick: onClose });
    expect(xs(EnkiPanel({ title: "Profile", onClose, children: null, full: true, hideClose: true }))).toHaveLength(0);
    expect([...walk(EnkiPanel({ title: "Hall of Fame", onClose, children: null, full: true }))].some((el) => String(el.props.className ?? "").includes("ek-panel-x"))).toBe(false);
  });

  // DEC-497 (Kev, 2026-10-29: "remove the back button from hall of fame, messages, analytics, notifications").
  // Messages, Analytics and Notifications sit in Inbox since 2026-10-30; the Hall of Fame is its own item again (Kev,
  // 2026-10-30: "Hall of Fame must be listed not INSIDE studio"); Studio draws its own Back on its inner pages.
  it("is left out where the panel has its own Back (a signed-in profile, a creator's page, Settings, Payment) and on Studio, Hall of Fame and Inbox", () => {
    const home = readSource(join(__dirname, "..", "..", "components", "enki-shell", "EnkiHome.tsx"));
    expect(home).toContain('hideClose={(panel === "profile" && authed) || ["creator", "settings", "billing", "studio", "communities", "fame", "inbox"].includes(panel)}>');
    expect(home).toContain('billing: "Payment", settings: "Settings", profile: "My Profile", creator: "Creator", studio: "Studio", fame: "Hall of Fame", inbox: "Inbox",');
    expect(home).toContain('case "billing": return <SettingsView initialTab="payment" focusRamp={payFocus} onBack={closePanel} />;');
    expect(readSource(join(__dirname, "..", "..", "components", "settings", "SettingsLayout.tsx"))).toContain('<button type="button" className="set-back ek-tuck-hide" onClick={onBack}>');
  });

  // DEC-469 (review wf_e68176b7-d81): Messages filled 100 % of the body, so under the arrow it ran 40 px past the panel.
  it("leaves Messages what is under it, and its thread head no room for the old X", () => {
    const css = readSource(join(__dirname, "..", "..", "components", "enki-shell", "enki-shell.css"));
    expect(css).toContain(".ek-panel-body:has(.ek-msg-root) { display: flex; flex-direction: column; }");
    expect(css).toContain(".ek-panel-body .ek-msg-root { flex: 1; height: auto; }");
    expect(css).toContain(".ek-msg-thead { display: flex; align-items: center; gap: 10px; padding: 10px 16px;");
  });

  it("sits at the top left on its own line, quiet", () => {
    const css = readSource(join(__dirname, "..", "..", "components", "enki-shell", "enki-shell.css"));
    expect(css).toContain(".ek-panel-back {\n  display: flex; align-items: center; justify-content: center; width: 36px; height: 36px; margin: 10px 0 -6px 10px; padding: 0;\n  border: 0; border-radius: 50%; background: none;");
  });

  // DEC-464 (review wf_cb05c8c6-2aa): signed out, the own profile is a login door without a Back; it keeps the X.
  it("stays on the own profile's login door, which has no Back, by the same verdict the door uses", () => {
    const home = readSource(join(__dirname, "..", "..", "components", "enki-shell", "EnkiHome.tsx"));
    const profile = readSource(join(__dirname, "..", "..", "components", "profile", "ProfileView.tsx"));
    expect(home).toContain('const authed = access === "ok" && role !== "team";');
    expect(profile).toContain('const isAuthed = access === "ok" && role !== "team";');
    const door = profile.slice(profile.indexOf("if (own && !isAuthed) {"), profile.indexOf("return (", profile.indexOf("if (own && !isAuthed) {") + 40));
    expect(door).not.toContain('aria-label="Back"');
  });

  it("leaves the profile its own Back", () => {
    const profile = readSource(join(__dirname, "..", "..", "components", "profile", "ProfileView.tsx"));
    expect(profile).toMatch(/onClick=\{\(\) => \(onBack \? onBack\(\) : window\.history\.back\(\)\)\}\n\s+aria-label="Back"/);
  });

  // DEC-463 (review wf_cb05c8c6-2aa): the own profile's Back closed it past closePanel, so an image the profile had
  // covered stayed hidden, and the page under it locked; the removed X had brought it back.
  it("closes both profiles through closePanel, which brings back the image they covered", () => {
    const home = readSource(join(__dirname, "..", "..", "components", "enki-shell", "EnkiHome.tsx"));
    expect(home).toContain('case "profile": return <ProfileView onBack={closePanel} />;');
    expect(home).toContain("<ProfileView key={creatorHandle} handle={creatorHandle} isOwnProfile={false} onBack={closePanel} />");
    // However the panel goes (its Back is the browser's since 2026-10-30), the image comes back once it is gone.
    expect(home).toMatch(/useEffect\(\(\) => \{\n\s+window\.dispatchEvent\(new CustomEvent\(panel \? "enki:hide-detail" : "enki:show-detail"\)\);\n\s+\}, \[panel, creatorHandle\]\);/);
  });
});
