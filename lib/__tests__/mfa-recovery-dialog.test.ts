import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Fragment, isValidElement, type ReactElement, type ReactNode } from "react";
import { join } from "node:path";
import { readSource } from "./_read-source";

/**
 * What a person sees of the recovery codes and the Lost a factor area. The components are called as React would render them,
 * with state kept between calls and effects run when asked, and their real handlers driven: the factors and the status are
 * what the two queries would answer. Blind spot: no browser, so layout and focus are not seen here; the agents' browser pane
 * stops at the access gate (docs/change_management.md).
 */
const ui = vi.hoisted(() => ({
  state: [] as unknown[], s: 0, effects: [] as Array<() => unknown>,
  factors: [] as string[], data: undefined as unknown, options: null as null | Record<string, unknown>,
  refetch: vi.fn(), invalidate: vi.fn(), refresh: vi.fn(), toast: vi.fn(), guarded: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: <T>(start: T | (() => T)) => {
    const i = ui.s++;
    if (!(i in ui.state)) ui.state[i] = typeof start === "function" ? (start as () => T)() : start;
    return [ui.state[i], (next: unknown) => { ui.state[i] = typeof next === "function" ? (next as (p: unknown) => unknown)(ui.state[i]) : next; }];
  },
  useEffect: (fn: () => unknown) => { ui.effects.push(fn); },
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (o: Record<string, unknown>) => { ui.options = o; return { data: ui.data, refetch: ui.refetch }; },
  useQueryClient: () => ({ invalidateQueries: ui.invalidate }),
}));
vi.mock("@/hooks/useSecondFactor", () => ({ STEPUP_FACTORS_KEY: ["stepup-factors"], useStepUpFactors: () => ({ data: { factors: ui.factors } }) }));
vi.mock("@/hooks/useRecoveryStatus", async (real) => ({ ...(await real<typeof import("@/hooks/useRecoveryStatus")>()), refreshRecoveryStatus: ui.refresh }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: ui.toast }) }));
vi.mock("@/lib/session-headers", () => ({ sessionAuthHeaders: () => ({}) }));
vi.mock("@/components/StepUpProvider", () => ({ useStepUp: () => ({ guarded: ui.guarded }) }));

import RecoveryCodes, { RECOVERY_STATUS_KEY, RecoveryCodesDialog } from "@/components/settings/RecoveryCodes";
import EnkiPanel from "@/components/enki-shell/EnkiPanel";

type El = ReactElement<Record<string, unknown>>;
type Portal = { containerInfo: unknown; children: ReactNode };

/** The host elements a node draws, in order, through function components, fragments and portals. */
function flat(node: unknown, out: (El | string)[] = []): (El | string)[] {
  if (node === null || node === undefined || typeof node === "boolean") return out;
  if (typeof node === "string" || typeof node === "number") { out.push(String(node)); return out; }
  if (Array.isArray(node)) { node.forEach((n) => flat(n, out)); return out; }
  if ((node as Portal).containerInfo) return flat((node as Portal).children, out);
  if (!isValidElement(node)) return out;
  const el = node as El;
  if (typeof el.type === "function") return flat((el.type as (p: unknown) => unknown)(el.props), out);
  if ((el.type as unknown) !== Fragment) out.push(el);
  return flat(el.props.children, out);
}
const render = () => { ui.s = 0; ui.effects.length = 0; return flat(RecoveryCodes({})); };
const words = (tree: (El | string)[]) => tree.filter((n) => typeof n === "string").join(" ");
const hosts = (tree: (El | string)[]) => tree.filter((n): n is El => typeof n !== "string");
const textOf = (el: El) => words(flat(el.props.children));
const button = (tree: (El | string)[], name: string) => {
  const found = hosts(tree).find((e) => e.type === "button" && textOf(e) === name);
  if (!found) throw new Error(`no button "${name}" in: ${words(tree)}`);
  return found.props as { onClick: () => unknown; disabled?: boolean };
};
const byLabel = (tree: (El | string)[], label: string) => hosts(tree).find((e) => e.props["aria-label"] === label);
const pick = (tree: (El | string)[], factor: string) => (byLabel(tree, "The factor you lost")!.props as { onChange: (e: unknown) => void }).onChange({ target: { value: factor } });
const type = (tree: (El | string)[], label: string, value: string) => (byLabel(tree, label)!.props as { onChange: (e: unknown) => void }).onChange({ target: { value } });
const answer = (status: number, body: unknown) => vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));

/** Types back the code the dialog names, as the owner would from their copy; answers its number. */
const typeBack = (tree: (El | string)[], codes: string[], as = (c: string) => c) => {
  const box = hosts(tree).find((e) => /^Code \d+$/.test(String(e.props["aria-label"] ?? "")))!;
  const n = Number(String(box.props["aria-label"]).slice(5));
  (box.props as { onChange: (e: unknown) => void }).onChange({ target: { value: as(codes[n - 1]) } });
  return n;
};

const STATUS = { available: true, codesLeft: 3 };
const NEW_CODE = "AAAA-BBBB-CCCC-DDDD";
const SAY = "Save these recovery codes.";

beforeEach(() => {
  ui.state.length = 0;
  ui.factors = ["totp"];
  ui.data = STATUS;
  ui.options = null;
  for (const f of [ui.refetch, ui.invalidate, ui.refresh, ui.toast, ui.guarded]) f.mockReset();
});
afterEach(() => { vi.unstubAllGlobals(); });

async function redeemed() {
  answer(200, { removed: true, recoveryCodes: [NEW_CODE], codesLeft: 3 });
  pick(render(), "totp");
  type(render(), "Recovery code", "ZZZZ-ZZZZ-ZZZZ-ZZZZ");
  await button(render(), "Remove it").onClick();
}

describe("the replacement code, shown once", () => {
  it("stays on screen when the code removed the account's only factor, until I saved them", async () => {
    await redeemed();
    expect(ui.invalidate).toHaveBeenCalledWith({ queryKey: ["stepup-factors"] });
    ui.factors = []; // what the factors query answers once it has read again
    const after = render();
    expect(words(after)).toContain(NEW_CODE);
    expect(words(after)).toContain(SAY);
    expect(words(after)).not.toContain("Lost a factor");
    expect(typeBack(after, [NEW_CODE])).toBe(1);
    button(render(), "I saved them").onClick();
    expect(render()).toEqual([]);
  });

  it("stays on screen while the status for the new factor list has no answer yet, and if it never gets one", async () => {
    ui.factors = ["totp", "passkey"];
    await redeemed();
    ui.factors = ["passkey"];
    ui.data = undefined;
    expect(words(render())).toContain(NEW_CODE);
  });

  it("shows beside the area when a factor is left", async () => {
    ui.factors = ["totp", "passkey"];
    await redeemed();
    ui.factors = ["passkey"];
    const after = render();
    expect(words(after)).toContain(NEW_CODE);
    expect(words(after)).toContain("Lost a factor");
  });

  it("with nothing to show, the area hides before SQL 74 ran and with no factor", () => {
    ui.data = { available: false, codesLeft: 0 };
    expect(render()).toEqual([]);
    ui.data = STATUS;
    ui.factors = [];
    expect(render()).toEqual([]);
    ui.factors = ["totp"];
    ui.data = undefined;
    expect(render()).toEqual([]);
  });
});

describe("the dialog keeps the codes", () => {
  const draw = () => RecoveryCodesDialog({ codes: [NEW_CODE], onClose: vi.fn() }) as unknown;
  const stubPage = () => {
    const page = { body: { nodeType: 1 }, listeners: [] as { f: (e: unknown) => void; capture: boolean }[], win: [] as Array<(e: unknown) => void> };
    vi.stubGlobal("document", {
      body: page.body,
      addEventListener: (_: string, f: (e: unknown) => void, capture = false) => { page.listeners.push({ f, capture }); },
      removeEventListener: (_: string, f: (e: unknown) => void, capture = false) => { page.listeners = page.listeners.filter((l) => l.f !== f || l.capture !== capture); },
    });
    vi.stubGlobal("window", {
      addEventListener: (_: string, f: (e: unknown) => void) => { page.win.push(f); },
      removeEventListener: (_: string, f: (e: unknown) => void) => { page.win = page.win.filter((l) => l !== f); },
    });
    return page;
  };
  const press = (page: ReturnType<typeof stubPage>, key: string) => {
    const e = { key, defaultPrevented: false, stopped: false, stopPropagation() { this.stopped = true; } };
    for (const l of page.listeners.filter((x) => x.capture)) l.f(e); // the document's capture comes before the window's bubble
    if (!e.stopped) for (const l of page.win) l(e);
    return e;
  };

  it("is drawn on the page itself: .set-tabpane's will-change must not hold it inside the tab", () => {
    const page = stubPage();
    ui.effects.length = 0;
    const out = draw() as Portal;
    expect(out.containerInfo).toBe(page.body);
    expect(words(flat(out))).toContain(NEW_CODE);
  });

  it("without a page it draws in place", () => {
    ui.effects.length = 0;
    const out = draw() as El;
    expect(out.props.className).toBe("set-pay-overlay");
  });

  it("Esc does not close the panel behind it; once it is gone Esc closes the panel again", () => {
    const page = stubPage();
    ui.effects.length = 0;
    const onClose = vi.fn();
    flat(EnkiPanel({ title: "Settings", onClose, children: null }));
    draw();
    const cleanups = ui.effects.map((fn) => fn() as () => void);
    expect(press(page, "Escape").stopped).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    expect(press(page, "a").stopped).toBe(false);
    cleanups[1]();
    expect(press(page, "Escape").stopped).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("a card taller than a low screen scrolls, or its buttons would be cut off with no way to reach them", () => {
    ui.effects.length = 0;
    const card = hosts(flat(draw())).find((e) => e.props.role === "dialog")!;
    expect((card.props.style as Record<string, unknown>).overflowY).toBe("auto");
  });
});

describe("one code typed back before the dialog closes (Kev: \"recovery codes werden meist vergessen\")", () => {
  const TEN = ["0123-4567-89AB-CDEF", "GHJK-MNPQ-RSTV-WXYZ", "1111-2222-3333-4444", "5555-6666-7777-8888", "9999-AAAA-BBBB-CCCC",
    "DDDD-EEEE-FFFF-GGGG", "HHHH-JJJJ-KKKK-MMMM", "NNNN-PPPP-QQQQ-RRRR", "SSSS-TTTT-VVVV-WWWW", "XXXX-YYYY-ZZZZ-0000"];
  const draw = (onClose: () => void, codes = TEN) => { ui.s = 0; ui.effects.length = 0; return flat(RecoveryCodesDialog({ codes, onClose })); };
  const alert = (tree: (El | string)[]) => hosts(tree).filter((e) => e.props.role === "alert").map(textOf);

  it("numbers the codes, names one, and closes only once that one is typed back; a wrong one says so", () => {
    const onClose = vi.fn();
    const tree = draw(onClose);
    expect(words(tree)).toContain(TEN.map((c, i) => `${i + 1}. ${c}`).join("\n"));
    const box = hosts(tree).find((e) => /^Code \d+$/.test(String(e.props["aria-label"] ?? "")))!;
    const n = Number(String(box.props["aria-label"]).slice(5));
    expect(words(tree)).toContain(`To make sure you saved them, type code ${n} from where you keep them.`);
    expect(button(tree, "I saved them").disabled).toBe(true);
    (box.props as { onChange: (e: unknown) => void }).onChange({ target: { value: TEN[n % 10] } }); // the next code on the list
    expect(button(draw(onClose), "I saved them").disabled).toBe(false);
    button(draw(onClose), "I saved them").onClick();
    expect(onClose).not.toHaveBeenCalled();
    expect(alert(draw(onClose))).toEqual([`That is not code ${n}. Check it against the list above.`]);
    typeBack(draw(onClose), TEN);
    expect(alert(draw(onClose))).toEqual([]); // typing again clears it
    button(draw(onClose), "I saved them").onClick();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("reads the code as the server does: case, dashes and spaces aside, O as 0, I and L as 1", () => {
    const onClose = vi.fn();
    vi.spyOn(Math, "random").mockReturnValue(0.95); // the tenth: XXXX-YYYY-ZZZZ-0000
    ui.state.length = 0;
    expect(typeBack(draw(onClose), TEN, () => " xxxx yyyy-zzzz OOOO ")).toBe(10);
    button(draw(onClose), "I saved them").onClick();
    expect(onClose).toHaveBeenCalledTimes(1);
    vi.spyOn(Math, "random").mockReturnValue(0.05); // the first: 0123-4567-89AB-CDEF
    ui.state.length = 0;
    expect(typeBack(draw(onClose), TEN, () => "o123-4567-89ab-cdef")).toBe(1);
    button(draw(onClose), "I saved them").onClick();
    expect(onClose).toHaveBeenCalledTimes(2);
    vi.spyOn(Math, "random").mockReturnValue(0.25); // the third: 1111-2222-3333-4444
    ui.state.length = 0;
    expect(typeBack(draw(onClose), TEN, () => "IlLi 2222 3333 4444")).toBe(3);
    button(draw(onClose), "I saved them").onClick();
    expect(onClose).toHaveBeenCalledTimes(3);
    vi.spyOn(Math, "random").mockReturnValue(0.15); // the second, one character short: GHJK-MNPQ-RSTV-WXYZ
    ui.state.length = 0;
    expect(typeBack(draw(onClose), TEN, () => "GHJK-MNPQ-RSTV-WXY")).toBe(2);
    button(draw(onClose), "I saved them").onClick();
    expect(onClose).toHaveBeenCalledTimes(3);
    vi.restoreAllMocks();
  });

  // The block is userSelect "all": a copy made by selecting it keeps the numbers (DEC-2026-11-07-29).
  it("a line copied from the numbered block, '<n>. <code>' or '<n>) <code>', closes it too; another code behind the right number does not", () => {
    const onClose = vi.fn();
    vi.spyOn(Math, "random").mockReturnValue(0.25); // the third: 1111-2222-3333-4444
    ui.state.length = 0;
    expect(typeBack(draw(onClose), TEN, (c) => `3. ${c}`)).toBe(3);
    button(draw(onClose), "I saved them").onClick();
    expect(onClose).toHaveBeenCalledTimes(1);
    vi.spyOn(Math, "random").mockReturnValue(0.95); // the tenth: XXXX-YYYY-ZZZZ-0000
    ui.state.length = 0;
    expect(typeBack(draw(onClose), TEN, (c) => ` 10) ${c}`)).toBe(10);
    button(draw(onClose), "I saved them").onClick();
    expect(onClose).toHaveBeenCalledTimes(2);
    ui.state.length = 0;
    typeBack(draw(onClose), TEN, () => `10. ${TEN[2]}`);
    button(draw(onClose), "I saved them").onClick();
    expect(onClose).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
  });

  it("Enter with the right code closes it, with a wrong one it does not", () => {
    const onClose = vi.fn();
    vi.spyOn(Math, "random").mockReturnValue(0.35); // the fourth
    ui.state.length = 0;
    const key = () => (hosts(draw(onClose)).find((e) => e.props["aria-label"] === "Code 4")!.props as { onKeyDown: (e: unknown) => void }).onKeyDown({ key: "Enter" });
    typeBack(draw(onClose), TEN, () => TEN[2]);
    key();
    expect(onClose).not.toHaveBeenCalled();
    typeBack(draw(onClose), TEN);
    key();
    expect(onClose).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });

  it("the first factor's codes, New codes and a replacement code all open this one dialog", () => {
    const panel = readSource(join(__dirname, "..", "..", "components", "settings", "RecoveryPanel.tsx"));
    expect(panel).toContain("{firstCodes && <RecoveryCodesDialog codes={firstCodes} onClose={() => setFirstCodes(null)} />}");
    const area = readSource(join(__dirname, "..", "..", "components", "settings", "RecoveryCodes.tsx"));
    expect(area).toContain("const dialog = shown && <RecoveryCodesDialog codes={shown} onClose={() => setShown(null)} />;");
    expect(area.match(/<RecoveryCodesDialog /g)).toHaveLength(1);
  });
});

describe("the area reads again", () => {
  it("whenever the tab comes back, as the factors do: a guardian's yes changes it with the same factors", () => {
    render();
    expect(ui.options!.refetchOnWindowFocus).toBe("always");
    expect((ui.options!.queryKey as unknown[])[0]).toBe(RECOVERY_STATUS_KEY);
  });

  it("the panel tells it and the red banner when a factor is added or removed, also with the same factor list", () => {
    const panel = readSource(join(__dirname, "..", "..", "components", "settings", "RecoveryPanel.tsx"));
    expect(panel).toContain("<CodeFactors onChange={recoveryChanged} onCodes={setFirstCodes} />");
    const changed = /const recoveryChanged = \(\) => \{([\s\S]*?)\n  \};/.exec(panel)![1];
    expect(changed).toContain("queryClient.invalidateQueries({ queryKey: [RECOVERY_STATUS_KEY] })");
    expect(changed).toContain("refreshRecoveryStatus();");
    const adding = /const handleAddPasskey = async \(\) => \{([\s\S]*?)\n  \};/.exec(panel)![1];
    expect(adding).toContain("recoveryChanged();");
    const removing = /const removePasskey = async \(id: string\) => \{([\s\S]*?)\n  \};/.exec(panel)![1];
    expect(removing).toContain("recoveryChanged();");
  });

  it("the code factors call it on both a confirm and a remove", () => {
    const factors = readSource(join(__dirname, "..", "..", "components", "settings", "CodeFactors.tsx"));
    expect(factors.match(/onChange\?\.\(\);/g)).toHaveLength(2);
  });
});

describe("the mail path: one code to each address, entered together", () => {
  const TO = ["go…@example.test", "ow…@example.test"];
  const calls = () => (fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls;
  const sent = async () => {
    answer(200, { sent: true, to: TO });
    pick(render(), "totp");
    await button(render(), "No code left").onClick();
  };

  it("No code left sends them, then one box per address in the order named, and the codes go back in that order", async () => {
    await sent();
    expect(calls()[0][0]).toBe("/api/auth/mfa/recovery/mail");
    expect(JSON.parse(String(calls()[0][1].body))).toEqual({ factor: "totp" });
    expect(ui.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Codes sent" }));
    const boxes = hosts(render()).filter((e) => String(e.props["aria-label"] ?? "").startsWith("Code sent to "));
    expect(boxes.map((b) => b.props["aria-label"])).toEqual(TO.map((t) => `Code sent to ${t}`));
    expect(button(render(), "Remove it with these codes").disabled).toBe(true);
    type(render(), `Code sent to ${TO[0]}`, "11 11-11");
    expect(button(render(), "Remove it with these codes").disabled).toBe(true);
    type(render(), `Code sent to ${TO[1]}`, "222222");
    answer(200, { removed: true });
    await button(render(), "Remove it with these codes").onClick();
    expect(calls()[0][0]).toBe("/api/auth/mfa/recovery/mail/confirm");
    expect(JSON.parse(String(calls()[0][1].body))).toEqual({ codes: ["111111", "222222"] });
    expect(ui.invalidate).toHaveBeenCalledWith({ queryKey: ["stepup-factors"] });
    expect(ui.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Removed" }));
    expect(byLabel(render(), `Code sent to ${TO[0]}`)).toBeUndefined();
  });

  it("each box shows its address in view, also once a code is typed in it", async () => {
    await sent();
    type(render(), `Code sent to ${TO[0]}`, "111111");
    const tree = render();
    for (const to of TO) {
      const box = byLabel(tree, `Code sent to ${to}`)!;
      expect(box.props.placeholder).not.toBe(to);
      expect(tree.filter((n) => n === `Code sent to ${to}`)).toHaveLength(1);
    }
  });

  it("a refused code keeps the boxes and says what the server said", async () => {
    await sent();
    type(render(), `Code sent to ${TO[0]}`, "111111");
    type(render(), `Code sent to ${TO[1]}`, "222222");
    answer(400, { error: "Wrong code" });
    await button(render(), "Remove it with these codes").onClick();
    expect(ui.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Wrong code", variant: "destructive" }));
    expect(ui.invalidate).not.toHaveBeenCalled();
    expect(byLabel(render(), `Code sent to ${TO[1]}`)).toBeTruthy();
  });

  it("closes when the picked factor changes, or the codes would remove the earlier one under the new name", async () => {
    await sent();
    type(render(), `Code sent to ${TO[0]}`, "123456");
    pick(render(), "passkey");
    const after = render();
    expect(byLabel(after, `Code sent to ${TO[0]}`)).toBeUndefined();
    pick(after, "totp");
    await button(render(), "No code left").onClick();
    expect(byLabel(render(), `Code sent to ${TO[0]}`)!.props.value).toBe("");
  });

  it("the words and the labels, as the owner reads them", () => {
    const area = readSource(join(__dirname, "..", "..", "components", "settings", "RecoveryCodes.tsx"));
    expect(area).toContain('post("mail", { factor: lost })');
    expect(area).toContain('post("mail/confirm", { codes: mailCodes })');
    expect(area).toContain(">No code left</button>");
    expect(area).toContain("We email a code to each of your email addresses. Entered together, they remove it at once, and every address hears about it.");
    expect(area).toContain("aria-label={`Code sent to ${to}`}");
    expect(area).toContain(">Remove it with these codes</button>");
    expect(area).not.toContain("5 day");
  });
});

describe("the ways back in", () => {
  const status = (codesLeft: number, addresses: number, askable: number, total: number, needed = 2) =>
    ({ available: true, codesLeft, addresses, guardians: { askable, total, needed, ask: null } });
  const badge = (tree: (El | string)[]) => {
    const title = hosts(tree).find((e) => e.props.className === "set-item-title" && textOf(e).startsWith("Ways back in"))!;
    const span = hosts(flat(title.props.children)).find((e) => e.type === "span")!;
    return { text: textOf(span), cls: span.props.className };
  };
  const notes = (tree: (El | string)[]) => hosts(tree).filter((e) => e.props.role === "note").map(textOf);

  it("counts each way: codes left, guardians who can be asked and reached of all on the list, and every address; three ways warn of nothing", () => {
    ui.data = status(3, 2, 3, 4);
    const tree = render();
    expect(words(tree)).toContain("Recovery codes: 3 left · Guardians: 3 of 4 can be asked and reached · Email addresses: 2");
    expect(badge(tree)).toEqual({ text: "3 of 3", cls: "set-badge-good" });
    expect(notes(tree)).toEqual([]);
    expect(words(tree)).not.toContain("must say yes, so one");
  });

  it("two ways warn of nothing; one way left says what losing it means and what to add", () => {
    ui.data = status(3, 2, 1, 1);
    expect(badge(render())).toEqual({ text: "2 of 3", cls: "set-badge-good" });
    expect(notes(render())).toEqual([]);
    ui.data = status(3, 1, 1, 1);
    expect(badge(render())).toEqual({ text: "1 of 3", cls: "set-badge-warn" });
    expect(notes(render())).toEqual(["Only one way back is left: a recovery code. Lose it together with a factor and your wallet stays locked. Add guardians (three is best) or a second email address (Lost a factor below says how)."]);
    expect(words(render())).not.toContain("must say yes, so one"); // one guardian is no way at all
    ui.data = status(0, 1, 2, 2);
    expect(notes(render())).toEqual(["Only one way back is left: your guardians. Lose it together with a factor and your wallet stays locked. Add new recovery codes or a second email address (Lost a factor below says how)."]);
    ui.data = status(0, 2, 0, 0);
    expect(notes(render())).toEqual(["Only one way back is left: a code to each of your email addresses. Lose it together with a factor and your wallet stays locked. Add new recovery codes or guardians (three is best)."]);
  });

  it("no way left says so, with all three to add", () => {
    ui.data = status(0, 1, 1, 3);
    const tree = render();
    expect(badge(tree)).toEqual({ text: "None", cls: "set-badge-warn" });
    expect(notes(tree)).toEqual(["No way back is left: lose a factor and your wallet stays locked. Add new recovery codes, guardians (three is best) or a second email address (Lost a factor below says how)."]);
  });

  it("when every guardian who can be asked must say yes, one out of reach blocks the way: at two it asks for a third", () => {
    ui.data = status(3, 2, 2, 2);
    expect(words(render())).toContain("All 2 of your guardians must say yes, so one you cannot reach blocks that way. Add a third: three guardians is best.");
    ui.data = status(3, 2, 3, 3, 3);
    expect(words(render())).toContain("All 3 of your guardians must say yes, so one you cannot reach blocks that way. Add another guardian, or lower how many must approve.");
    ui.data = status(3, 2, 3, 3, 2);
    expect(words(render())).not.toContain("must say yes, so one");
  });

  it("a guardian not reachable (the yearly check) counts out of the way: fewer reachable than must say yes and the way is gone", () => {
    const reach = (askable: number, reachable: number, total: number, needed: number, codesLeft = 3, addresses = 1) =>
      ({ available: true, codesLeft, addresses, guardians: { askable, reachable, total, needed, ask: null } });
    ui.data = reach(3, 2, 4, 2);
    expect(words(render())).toContain("Recovery codes: 3 left · Guardians: 2 of 4 can be asked and reached · Email addresses: 1");
    expect(badge(render())).toEqual({ text: "2 of 3", cls: "set-badge-good" });
    // Two must say yes at the least (lib/mfa-recovery.ts yesNeeded): lowering the number cannot help, replacing can (DEC-2026-11-07-31).
    expect(words(render())).toContain("All 2 of your guardians who can be reached must say yes, so one you cannot reach blocks that way. Add another guardian, or replace one who is not reachable.");
    expect(words(render())).not.toContain("lower how many must approve");
    ui.data = reach(4, 3, 4, 3);
    expect(words(render())).toContain("All 3 of your guardians who can be reached must say yes, so one you cannot reach blocks that way. Add another guardian, or lower how many must approve.");
    ui.data = reach(2, 1, 2, 2);
    expect(badge(render())).toEqual({ text: "1 of 3", cls: "set-badge-warn" });
    expect(notes(render())).toEqual(["Only one way back is left: a recovery code. Lose it together with a factor and your wallet stays locked. Add a guardian in place of one not reachable or a second email address (Lost a factor below says how)."]);
    expect(words(render())).not.toContain("must say yes, so one");
    ui.data = reach(3, 3, 3, 2);
    expect(words(render())).not.toContain("must say yes, so one");
  });

  it("an authenticator guardian is confirmed and never asked: two email guardians and it read 2 of 3, not as if one were unconfirmed", () => {
    ui.data = status(3, 1, 2, 3);
    expect(words(render())).toContain("Guardians: 2 of 3 can be asked and reached");
    expect(words(render())).not.toContain("confirmed and reachable");
  });
});

describe("fewer than two addresses", () => {
  const SENTENCE = "Emailing codes needs two email addresses or more, one code to each, and this account has one. Use a recovery code.";

  it("the area says why where No code left would send the codes, and a recovery code still works", () => {
    ui.data = { ...STATUS, mailRefused: SENTENCE };
    const tree = render();
    expect(words(tree)).toContain(SENTENCE);
    expect(hosts(tree).some((e) => e.type === "button" && textOf(e) === "No code left")).toBe(false);
    expect(button(tree, "Remove it")).toBeTruthy();
    ui.data = { ...STATUS, mailRefused: null };
    expect(words(render())).not.toContain(SENTENCE);
    expect(button(render(), "No code left")).toBeTruthy();
  });
});

describe("asking the guardians from the area", () => {
  const calls = () => (fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls;
  const ADD = "Asking your guardians needs two confirmed guardians or more, by email or wallet. Add them under Guardians.";

  it("with two or more, Ask my guardians posts the picked factor, and the area and the banner read again", async () => {
    ui.data = { ...STATUS, guardians: { askable: 2, needed: 2, ask: null } };
    expect(button(render(), "Ask my guardians").disabled).toBe(true);
    expect(words(render())).toContain("They get a message. The moment 2 say yes, it is removed, and every address hears about it.");
    answer(200, { asked: true, needed: 2, emailed: 2, wallets: [] });
    pick(render(), "totp");
    await button(render(), "Ask my guardians").onClick();
    expect(calls()[0][0]).toBe("/api/auth/mfa/recovery/guardians");
    expect(JSON.parse(String(calls()[0][1].body))).toEqual({ factor: "totp" });
    expect(ui.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Your guardians were asked", description: "2 by email." }));
    expect(ui.refetch).toHaveBeenCalledTimes(1);
    expect(ui.refresh).toHaveBeenCalledTimes(1);
    expect(words(render())).not.toContain(ADD);
  });

  it("names the guardians whose mail did not go out, and how to try them again (DEC-2026-11-07-32)", async () => {
    ui.data = { ...STATUS, guardians: { askable: 3, needed: 2, ask: null } };
    answer(200, { asked: true, needed: 2, emailed: 2, notReached: ["g3…@friends.test"], wallets: [] });
    pick(render(), "totp");
    await button(render(), "Ask my guardians").onClick();
    expect(ui.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Your guardians were asked", description: "2 by email. Not reached: g3…@friends.test. Withdraw and ask again to try them again." }));
  });

  it("with fewer than two it says to add them, and offers no button", () => {
    ui.data = { ...STATUS, guardians: { askable: 1, needed: 2, ask: null } };
    const tree = render();
    expect(words(tree)).toContain(ADD);
    expect(hosts(tree).some((e) => e.type === "button" && textOf(e) === "Ask my guardians")).toBe(false);
  });

  it("a running ask says how many said yes and when it ends, copies each wallet link, and Withdraw takes it back", async () => {
    const expiresAt = "2030-06-15T12:00:00.000Z";
    const link = "https://enki.test/guardian?factor=r&g=w";
    ui.data = { ...STATUS, guardians: { askable: 2, needed: 2, ask: { factor: "totp", approved: 1, needed: 2, expiresAt, wallets: [{ guardian: "AbCdEf…123456", link }] } } };
    expect(words(render())).toContain(`Authenticator app: your guardians were asked. 1 of 2 said yes. It ends on ${new Date(expiresAt).toLocaleDateString()}.`);
    expect(hosts(render()).some((e) => e.type === "button" && textOf(e) === "Ask my guardians")).toBe(false);
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await button(render(), "Copy the link for AbCdEf…123456").onClick();
    expect(writeText).toHaveBeenCalledWith(link);
    answer(200, { withdrawn: true });
    await button(render(), "Withdraw").onClick();
    expect(calls()[0][0]).toBe("/api/auth/mfa/recovery/guardians");
    expect(calls()[0][1].method).toBe("DELETE");
    expect(ui.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Withdrawn" }));
    expect(ui.refetch).toHaveBeenCalledTimes(1);
  });

  it("the guardian's page: who asks, what a yes does, and to say yes only when asked by phone or in person", () => {
    const page = readSource(join(__dirname, "..", "..", "app", "guardian", "page.tsx"));
    expect(page).toContain('const factorRequest = params.get("factor");');
    expect(page).toContain("Your yes helps remove {who}&apos;s lost security factor so they can get into their money again.");
    expect(page).toContain("Only say yes if {who} asked you themselves, by phone or in person, not only by a message.");
    expect(page).toContain('"Yes, remove the lost factor"');
    expect(page).toContain('"Sign and say yes"');
    expect(page).toContain("signMessage(new TextEncoder().encode(guardianFactorMessage(requestId)))");
    expect(page).toContain("If they did not ask you themselves, do nothing: without your yes nothing changes.");
  });
});
