/**
 * What the top bar says to a trial tester (Kev, 2026-10-26: "ja das mit
 * ablaufdatum anzeigen ist super"): when the trial ends, and what is left of
 * its budget, the full price of every render counted (lib/trial).
 */
export type TrialLine = { endsAt: string; budgetMicro: number; spentMicro: number };

const clock = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

export function trialLine(t: TrialLine, now = new Date()): string {
  const end = new Date(t.endsAt);
  // Today: the hour; later: the day too.
  const sameDay = end.toDateString() === now.toDateString();
  const when = sameDay ? clock(end) : `${end.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}, ${clock(end)}`;
  const left = Math.max(0, t.budgetMicro - t.spentMicro) / 1_000_000;
  return `Trial · ends ${when} · $${left.toFixed(2)} left`;
}
