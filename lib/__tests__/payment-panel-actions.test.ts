import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { readSource } from "@/lib/__tests__/_read-source";

/**
 * Three money actions stacked beside the balance (Kev, 2026-10-14): Add money,
 * Pay out, Deposit, labels only (the balance stands beside them). The picked one unfolds under the balance:
 * the provider chooser for the first two, the wallet address for Deposit. The
 * old "Move money" and "Deposit Crypto" sections are gone.
 */
const ROOT = join(__dirname, "..", "..");
const PANEL = readSource(join(ROOT, "components", "settings", "PaymentPanel.tsx"));
// Whose money it is: Settings' wallet hook (DEC-2026-11-08-41).
const WALLET = readSource(join(ROOT, "components", "settings", "use-wallet-address.ts"));
const DEPOSIT = readSource(join(ROOT, "components", "settings", "BillingPanel.tsx"));
const CSS = readFileSync(join(ROOT, "components", "settings", "settings.css"), "utf8");
const hero = () => PANEL.slice(PANEL.indexOf("set-hero-actions"), PANEL.indexOf("{mode && ("));

describe("the money actions beside the balance", () => {
  it("are Add money, Pay out, Deposit, in that order, stacked", () => {
    const hero = PANEL.slice(PANEL.indexOf('className="set-holdings-hero"'), PANEL.indexOf('{mode && ('));
    expect(hero).toContain('["buy", <ArrowDownToLine key="i" size={15} />, "Add money"],');
    expect(hero).toContain('["sell", <ArrowUpFromLine key="i" size={15} />, "Pay out"],');
    expect(hero).toContain('["deposit", <Wallet key="i" size={15} />, "Deposit"],');
    expect(hero.indexOf('"buy"')).toBeLessThan(hero.indexOf('"sell"'));
    expect(hero.indexOf('"sell"')).toBeLessThan(hero.indexOf('"deposit"'));
    expect(CSS).toMatch(/\.set-hero-actions \{[^}]*flex-direction: column/);
  });

  it("carries no amount, and marks the picked action", () => {
    expect(PANEL).not.toContain("set-act-amount");
    expect(hero()).not.toContain("balance");
    expect(PANEL).toContain('className={"set-act" + (mode === m ? " set-act--on" : "")}');
    expect(PANEL).toContain("aria-expanded={mode === m}");
  });

  it("unfolds the provider chooser for buy and sell, the wallet address for deposit, nothing otherwise", () => {
    const pane = PANEL.slice(PANEL.indexOf("{mode && ("), PANEL.indexOf("What&apos;s a wallet?"));
    expect(pane).toContain('{mode === "deposit" ? (\n              <BillingPanel />\n            ) : (');
    expect(pane).toContain("Pick a provider to {mode === \"buy\" ? \"top up\" : \"pay out\"}");
    expect(pane).toContain("onClick={() => { if (on) void launchRamp(mode, r.id); }}");
    expect(PANEL).not.toContain('title="Move money"');
  });

  it("has no separate deposit section any more; the deposit body stands on its own", () => {
    expect(PANEL.match(/<BillingPanel \/>/g)).toHaveLength(1);
    expect(PANEL).toContain('<SettingsSection num="02" title="Send USDC">');
    expect(PANEL).toContain('style={{ marginRight: 12 }}>03</span>Networks');
    expect(DEPOSIT).not.toContain("SettingsSection");
    expect(DEPOSIT).toContain('<div className="set-section-desc">Sign in to see your deposit address.</div>');
  });
});

describe("signed in without an open wallet (Kev, 2026-10-26: \"Sign in to see ... even tho i am connected with my GOOGLE ACCOUNT\")", () => {
  it("asks the session, not the wallet, whether someone is signed in, and whether there is an embedded wallet to open", () => {
    expect(WALLET).toContain("const { access, role } = useBetaAccess();\n  const signedIn = access === \"ok\" && role !== \"team\";");
    expect(WALLET).toContain("const walletCanOpen = signedIn && cdpRuntimeExpected();");
    expect(PANEL).toContain("const { address, walletCanOpen } = useWalletAddress();");
  });

  it("takes the address from the wallet in use first, then the signed session, then the adapter, then the embedded wallet", () => {
    expect(WALLET).toMatch(/const address =\n\s+account\?\.address \?\?\n\s+\(solanaSessionActive \? solanaSessionAddress : null\) \?\?\n\s+solanaPublicKey\?\.toBase58\(\) \?\?\n\s+cdpAddress \?\?\n\s+null;/);
  });

  it("says the wallet is not open instead of asking to sign in, only where one can open", () => {
    expect(PANEL).toContain("{!walletCanOpen && !address ? <span>Sign in to see it.</span>\n                : !address ? <span>Wallet not open yet.</span>");
    // The server's reason is read when a tap fails, not at render, where it went stale (review fix).
    expect(PANEL).toMatch(/!walletCanOpen && !address\n\s+\? "Your balance shows up here\."\n\s+: !address\n(\s+\/\/[^\n]*\n)?\s+\? "Tap Add money to open it\."/);
    expect(PANEL).toContain('{walletCanOpen ? "Open your wallet (Add money) to send USDC." : "Sign in to send USDC from your wallet."}');
  });

  it("an action opens the wallet for them, and says why when it cannot; a wallet login is asked to sign in", () => {
    const pick = PANEL.slice(PANEL.indexOf("const pickMode = (side: Mode) => {"), PANEL.indexOf("const copyAddress"));
    expect(pick.indexOf("if (!address && walletCanOpen) {")).toBeGreaterThan(-1);
    expect(pick.indexOf("if (!address && walletCanOpen) {")).toBeLessThan(pick.indexOf('title: "Sign in first"'));
    expect(pick).toContain("void ensureCdpWallet().catch((e) => toast({");
    expect(pick).toContain("description: cdpClosedReason() ?? (e instanceof Error ? e.message : \"Please try again.\"),");
  });

  it("does not grey the actions it asks them to tap", () => {
    expect(PANEL).toContain("style={!address && !walletCanOpen ? { opacity: 0.55 } : undefined}");
  });
});

describe("cdpRuntimeExpected", () => {
  it("is true while a runtime is expected or registered, false for a wallet login or a deployment without CDP", async () => {
    const bridge = await import("@/lib/cdp-bridge");
    expect(bridge.cdpRuntimeExpected()).toBe(false);
    bridge.expectCdpRuntime(true);
    expect(bridge.cdpRuntimeExpected()).toBe(true);
    bridge.expectCdpRuntime(false);
    bridge.registerCdpEnsure(async () => {});
    expect(bridge.cdpRuntimeExpected()).toBe(true);
    bridge.registerCdpEnsure(null);
    expect(bridge.cdpRuntimeExpected()).toBe(false);
  });
});
