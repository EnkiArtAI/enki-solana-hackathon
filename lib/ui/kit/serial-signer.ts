/**
 * Wallet prompts one at a time (plan R7). An external wallet holds a single
 * sign request, so a second one sent while the first is open gets lost. Only
 * the signature waits its turn: the generations themselves still overlap.
 * What runs at the turn is handed over per call, so it is decided then, not
 * when the turn was taken.
 */
import type { PaymentSigner } from "@/lib/generation-checkout";

export type SerialTurn = <T>(sign: () => Promise<T>) => Promise<T>;

export function serialSigner(): SerialTurn {
  let turn: Promise<unknown> = Promise.resolve();
  return <T,>(sign: () => Promise<T>): Promise<T> => {
    const mine = turn.then(sign);
    // The next request waits until this one settles, signed or refused.
    turn = mine.catch(() => undefined);
    return mine;
  };
}

/** What one job's signer did: never asked (free route, or failed before signing), signed, or threw. */
export type SignState = "none" | "signed" | "threw";

/** One job's view of the signer: `sign` passes through, `state()` says what happened. */
export function trackSigner(sign: PaymentSigner): { sign: PaymentSigner; state: () => SignState } {
  let state: SignState = "none";
  const threw = (e: unknown): never => {
    state = "threw";
    throw e;
  };
  const tracked = (transactions: string[]) =>
    sign(transactions).then((signed) => {
      state = "signed";
      return signed;
    }, threw);
  // The connect before an order is opened is the signer's too.
  const prepare = sign.prepare;
  return { sign: Object.assign(tracked, prepare ? { prepare: () => prepare().catch(threw) } : {}), state: () => state };
}
