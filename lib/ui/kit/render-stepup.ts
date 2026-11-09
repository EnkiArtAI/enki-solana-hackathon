"use client";

import { askStepUp, withStepUp, type Factor } from "@/components/StepUpProvider";

/**
 * The render switch of the Settings table (Kev, 2026-10-17). The server asks
 * at a render's first request (the paid intent, the free render) when the
 * account has it on; this answers for every render while one confirmation
 * lasts. The token is good for five minutes (not a money scope), held here
 * for four, and parallel jobs share one dialog (StepUpProvider runs one ask
 * at a time, lib/ui/kit/serial-asks.ts).
 */
const HOLD_MS = 4 * 60_000;
let held: { token: string; until: number } | null = null;
let asking: Promise<string | null> | null = null;

const fresh = () => (held && held.until > Date.now() ? held.token : null);

function shared(scope: string, factors: Factor[]): Promise<string | null> {
  const token = fresh();
  if (token) return Promise.resolve(token);
  asking ??= askStepUp(scope, factors)
    .then((t) => {
      if (t) held = { token: t, until: Date.now() + HOLD_MS };
      return t;
    })
    .finally(() => { asking = null; });
  return asking;
}

/** Runs a render's first request with the held confirmation, asking once when the server wants one. */
export function withRenderStepUp(run: (headers: Record<string, string>) => Promise<Response>): Promise<Response> {
  let sent: string | null = null;
  return withStepUp(
    "render",
    (h) => {
      sent = h["X-StepUp-Token"] ?? fresh();
      return run(sent ? { "X-StepUp-Token": sent } : {});
    },
    (scope, factors) => {
      // Refused although we sent the held one: it is spent, ask anew.
      if (sent && held?.token === sent) held = null;
      return shared(scope, factors);
    },
  );
}

/** Whether a render's answer is a refused or cancelled confirmation. */
export async function cancelledStepUp(res: Response): Promise<boolean> {
  if (res.status !== 401) return false;
  const body = (await res.clone().json().catch(() => null)) as { stepUp?: boolean } | null;
  return body?.stepUp === true;
}
