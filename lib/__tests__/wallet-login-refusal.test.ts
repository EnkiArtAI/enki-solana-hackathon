import { describe, it, expect, vi, afterEach } from "vitest";
import { join } from "node:path";
import { readSource } from "./_read-source";

/**
 * What the wallet picker makes of a refused login. Only the server's own flag
 * means "not on the access list": a deleted account or a blocked network also
 * answers 403, and telling them to request access sends them to a door that
 * cannot open. The real client function runs; fetch is stubbed.
 */

vi.mock("@solana/wallet-adapter-react", () => ({ useWallet: () => ({}) }));

import { createSolanaAuthSession } from "@/hooks/useSolanaAuth";

const WALLET = "7Yk3r9dQmPvZx1aBcDeFgHiJkLmNoPqRsTuVwXyZ1234";

const refused = async (status: number, body: unknown) => {
  vi.stubGlobal("fetch", async (url: string) =>
    url === "/api/auth/nonce"
      ? new Response(JSON.stringify({ nonce: "n1" }), { status: 200 })
      : new Response(JSON.stringify(body), { status }));
  return (await createSolanaAuthSession(WALLET, async (m) => m).catch((e) => e)) as Error & { notWhitelisted?: boolean };
};

afterEach(() => vi.unstubAllGlobals());

describe("a refused wallet login", () => {
  it("off the access list carries the flag the picker reads", async () => {
    const e = await refused(403, { error: "This wallet isn't on the access list yet. Request access to join.", notWhitelisted: true });
    expect(e.notWhitelisted).toBe(true);
  });

  it("for a deleted account shows its own sentence, not the access list", async () => {
    const e = await refused(403, { error: "This account was deleted." });
    expect(e.notWhitelisted).toBeUndefined();
    expect(e.message).toBe("This account was deleted.");
  });

  it("from a blocked network shows its own sentence, not the access list", async () => {
    const e = await refused(403, { error: "Access from this network is blocked." });
    expect(e.notWhitelisted).toBeUndefined();
    expect(e.message).toBe("Access from this network is blocked.");
  });

  it("the picker shows that sentence with one full stop", () => {
    const picker = readSource(join(__dirname, "..", "..", "components", "WalletPickerModal.tsx"));
    expect(picker).toContain('${(raw || "unknown error").replace(/\.$/, "")}.${hint}');
    expect(picker).toContain("(e as { notWhitelisted?: boolean })?.notWhitelisted");
  });
});
