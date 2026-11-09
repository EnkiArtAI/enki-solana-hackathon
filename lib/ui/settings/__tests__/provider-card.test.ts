import { describe, expect, it, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { siApplepay, siGooglepay, siPaypal, siVisa } from "simple-icons";

/**
 * Settings' payment provider card (the mock v64's Provider part, Provider.dc.html:21-49; DEC-2026-11-08-43): the brand's
 * own wordmark, what it takes and how fast, the ways to pay there, a check when it is the one picked. From today's
 * chooser it keeps "Last used" and "Coming soon" for a provider the server has no keys for (PaymentPanel.tsx RAMPS).
 */
vi.mock("react", async (original) => ({ ...(await original<typeof import("react")>()), useId: () => "prov-sub" }));
import ProviderCard from "@/components/settings/ProviderCard";

type Props = Parameters<typeof ProviderCard>[0];
const card = (p: Partial<Props> = {}) => ({ id: "coinbase", side: "buy", picked: true, ready: true, last: false, onPick: vi.fn(), ...p }) as Props;
const html = (p: Partial<Props> = {}) => renderToStaticMarkup(createElement(ProviderCard, card(p)));
const titles = (out: string) => [...out.matchAll(/<span title="([^"]+)" class="sa-prov-badge"/g)].map((m) => m[1]);

describe("what the card says", () => {
  it("names the provider, says what it takes and how fast, as the mock writes it, for adding and for cashing out", () => {
    expect(html()).toContain('<span id="prov-sub" class="sa-prov-sub">Card and Apple Pay · from $5 · minutes</span>');
    expect(html({ side: "sell" })).toContain(">To your bank · usually the same day</span>");
    expect(html({ id: "moonpay" })).toContain(">Card, PayPal, Google Pay and more · from $20</span>");
    expect(html({ id: "moonpay", side: "sell" })).toContain(">To your bank, card or PayPal</span>");
    expect(html()).toMatch(/^<button type="button" class="sa-prov" aria-pressed="true" aria-label="Coinbase" aria-describedby="prov-sub">/);
    expect(html({ id: "moonpay" })).toContain('aria-label="MoonPay"');
  });

  it("shows the ways to pay there, in the mock's order", () => {
    expect(titles(html())).toEqual(["Apple Pay", "Visa", "Mastercard"]);
    expect(titles(html({ id: "moonpay" }))).toEqual(["Visa", "Mastercard", "PayPal", "Google Pay", "Apple Pay"]);
    expect(titles(html({ side: "sell" }))).toEqual(["Apple Pay", "Visa", "Mastercard"]);
  });

  it("checks the picked one, and leaves the other's circle empty", () => {
    expect(html()).toContain('<span aria-hidden="true" class="sa-prov-check">✓</span>');
    const other = html({ picked: false });
    expect(other).toContain('aria-pressed="false"');
    expect(other).toContain('<span aria-hidden="true" class="sa-prov-check"></span>');
  });
});

describe("today's chooser, kept", () => {
  it("greys a provider the server has no keys for, says it is coming, and cannot be picked, nor shown as picked", () => {
    const out = html({ ready: false, last: true });
    expect(out).toMatch(/^<button type="button" class="sa-prov" aria-pressed="false" aria-label="Coinbase" aria-describedby="prov-sub" disabled="" title="Coming soon">/);
    expect(out).toContain('<span aria-hidden="true" class="sa-prov-check"></span>');
    expect(out).toContain('<span class="kit-label sa-prov-chip">Coming soon</span>');
    expect(out).not.toContain("Last used");
    const onPick = vi.fn();
    const el = ProviderCard(card({ ready: false, onPick })) as ReactElement<{ onClick: () => void; disabled: boolean }>;
    expect(el.props.disabled).toBe(true);
    el.props.onClick();
    expect(onPick).not.toHaveBeenCalled();
  });

  it("marks the one used last", () => {
    expect(html({ last: true })).toContain('<span class="kit-label sa-prov-chip">Last used</span>');
    expect(html()).not.toContain("sa-prov-chip");
  });

  it("hands its id to the chooser when pressed", () => {
    const onPick = vi.fn();
    (ProviderCard(card({ id: "moonpay", onPick })) as ReactElement<{ onClick: () => void }>).props.onClick();
    expect(onPick).toHaveBeenCalledWith("moonpay");
  });
});

describe("the brands' own marks", () => {
  it("draws Coinbase's wordmark in its blue and MoonPay's lockup in its purple, the word in the text's colour", () => {
    const cb = html();
    expect(cb).toMatch(/<svg viewBox="0 0 1101\.64 196\.79" height="18" role="img" aria-label="Coinbase"[^>]*><path fill="#0052FF" d="M222\.34,54\.94/);
    const mp = html({ id: "moonpay" });
    expect(mp).toMatch(/<svg viewBox="0 0 194\.203 41" height="21" role="img" aria-label="MoonPay"[^>]*><path fill="#7D00FF" d="M0\.0469228 21\.8975/);
    expect(mp).toMatch(/<path fill="currentColor" d="M56\.9069 27\.809/);
  });

  it("takes the card brands' marks from simple-icons, in the mock's colours", () => {
    const mp = html({ id: "moonpay" });
    for (const [si, fill] of [[siApplepay, "#000000"], [siGooglepay, "#5F6368"], [siPaypal, "#002991"], [siVisa, "#1A1F71"]] as const) {
      expect(mp).toContain(`<path fill="${fill}" d="${si.path}"></path>`);
    }
    for (const fill of ["#EB001B", "#F79E1B", "#FF5F00"]) expect(mp).toContain(`<path fill="${fill}" d="`);
  });

  it("names no colour but the brands'", () => {
    const src = readFileSync("components/settings/ProviderCard.tsx", "utf8");
    const hex = [...new Set([...src.matchAll(/#[0-9a-f]{3,8}\b/gi)].map((m) => m[0].toUpperCase()))].sort();
    expect(hex).toEqual(["#000000", "#002991", "#0052FF", "#1A1F71", "#5F6368", "#7D00FF", "#EB001B", "#F79E1B", "#FF5F00"]);
  });
});

describe("its stylesheet", () => {
  const css = readFileSync("components/settings/areas.css", "utf8").replace(/\/\*[^]*?\*\//g, "");
  const rule = (selector: string) => {
    const body = css.match(new RegExp(`\\n${selector.replace(/[.()[\]*+?:="]/g, "\\$&")} \\{([^}]*)\\}`))?.[1];
    if (body === undefined) throw new Error(`no rule ${selector}`);
    return body;
  };

  it("is the mock's card in the theme's tokens: the rule's border, the ember and its soft tint when picked", () => {
    expect(rule(".sa-prov")).toContain("border: 1.5px solid var(--enki-rule);");
    expect(rule(".sa-prov")).toContain("border-radius: 20px;");
    expect(rule(".sa-prov")).toContain("padding: 16px 18px 14px;");
    expect(rule(".sa-prov")).toContain("background: var(--enki-paper);");
    expect(rule('.sa-prov[aria-pressed="true"]')).toBe(" border-color: var(--enki-ember); background: var(--enki-accent-soft); ");
    expect(rule('.sa-prov[aria-pressed="true"] .sa-prov-check')).toBe(" background: var(--cta-solid); color: var(--cta-ink); ");
    expect(rule(".sa-prov:disabled")).toContain("opacity: 0.45;");
  });

  it("goes compact on a phone, in the Settings panel and in a sheet alike", () => {
    const compact = ".sa-prov { padding: 10px; gap: 6px; }";
    expect(css).toMatch(new RegExp(`@container settings \\(max-width: 700px\\) \\{\\n\\s+${compact.replace(/[.{}()]/g, "\\$&")}`));
    expect(css).toMatch(new RegExp(`@media \\(max-width: 700px\\) \\{\\n\\s+\\.sa-sheet ${compact.replace(/[.{}()]/g, "\\$&")}`));
  });
});
