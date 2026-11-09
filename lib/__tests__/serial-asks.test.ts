import { describe, it, expect, vi } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";
import { serialAsks } from "@/lib/ui/kit/serial-asks";

/**
 * One step-up dialog at a time (review, 2026-10-17): a render's ask used to
 * close another job's open wallet unlock. Now another scope waits its turn,
 * and the same scope shares the dialog that is open or waiting.
 */

/** A dialog the test answers by hand. */
function dialogs() {
  const open: { scope: string; answer: (t: string | null) => void }[] = [];
  const show = vi.fn((scope: string) => new Promise<string | null>((answer) => { open.push({ scope, answer }); }));
  return { open, show };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("serialAsks", () => {
  it("lets an ask for another scope wait until the open one is answered, and closes neither", async () => {
    const { open, show } = dialogs();
    const ask = serialAsks<string>(show);
    const wallet = ask("wallet", ["passkey"]);
    const render = ask("render", ["passkey"]);
    await tick();
    expect(open.map((d) => d.scope)).toEqual(["wallet"]);
    open[0].answer("w-token");
    expect(await wallet).toBe("w-token");
    await tick();
    expect(open.map((d) => d.scope)).toEqual(["wallet", "render"]);
    open[1].answer("r-token");
    expect(await render).toBe("r-token");
  });

  it("opens a new dialog for the same scope the moment the last one was answered", async () => {
    // A wallet change asks one scope once per factor, right after the last answer: sharing it would hand back the old token.
    const { open, show } = dialogs();
    const ask = serialAsks<string>(show);
    const first = ask("wallet-change:x", ["passkey"]);
    await tick();
    open[0].answer("token-1");
    expect(await first).toBe("token-1");
    const second = ask("wallet-change:x", ["totp"]);
    await tick();
    expect(open).toHaveLength(2);
    open[1].answer("token-2");
    expect(await second).toBe("token-2");
  });

  it("shares one dialog between asks for the same scope", async () => {
    const { open, show } = dialogs();
    const ask = serialAsks<string>(show);
    const a = ask("render", []);
    const b = ask("render", []);
    await tick();
    expect(show).toHaveBeenCalledOnce();
    open[0].answer("tok");
    expect([await a, await b]).toEqual(["tok", "tok"]);
    // Answered: the next ask for it opens a new dialog.
    void ask("render", []);
    await tick();
    expect(show).toHaveBeenCalledTimes(2);
  });

  it("moves on after a cancel or a failing dialog", async () => {
    const { open, show } = dialogs();
    const ask = serialAsks<string>(show);
    const first = ask("wallet", []);
    const second = ask("export", []);
    await tick();
    open[0].answer(null);
    expect(await first).toBeNull();
    await tick();
    open[1].answer("e-token");
    expect(await second).toBe("e-token");

    // A dialog that fails hands its error to its own caller; the next one still opens.
    const flaky = vi.fn<(scope: string) => Promise<string | null>>()
      .mockRejectedValueOnce(new Error("dialog gone"))
      .mockResolvedValueOnce("x-token");
    const failing = serialAsks<string>(flaky);
    const broken = failing("wallet", []);
    const next = failing("export", []);
    await expect(broken).rejects.toThrow("dialog gone");
    expect(await next).toBe("x-token");
  });

  it("is what the step-up dialog asks with", () => {
    const provider = readSource(join(__dirname, "..", "..", "components", "StepUpProvider.tsx"));
    expect(provider).toContain("const ask = useMemo(() => serialAsks(show), [show]);");
    expect(provider).toContain("setPending({ scope, factors, resolve });");
    expect(provider).not.toContain("prev?.resolve(null)");
  });
});
