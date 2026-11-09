/**
 * One step-up dialog at a time (review, 2026-10-17). A second ask used to
 * close the open one, so a render queue's job could cancel another job's
 * wallet unlock. Now an ask for another scope waits its turn, and an ask
 * for a scope already open or waiting shares that one dialog.
 */
export type Ask<F> = (scope: string, factors: F[]) => Promise<string | null>;

export function serialAsks<F>(show: Ask<F>): Ask<F> {
  let tail: Promise<unknown> = Promise.resolve();
  const waiting = new Map<string, Promise<string | null>>();
  return (scope, factors) => {
    const same = waiting.get(scope);
    if (same) return same;
    // Forgotten before it settles: whoever awaited this answer may ask the same scope again at once, and that is a new dialog.
    const turn: Promise<string | null> = tail.then(() => show(scope, factors)).finally(() => { if (waiting.get(scope) === turn) waiting.delete(scope); });
    waiting.set(scope, turn);
    tail = turn.catch(() => null);
    return turn;
  };
}
