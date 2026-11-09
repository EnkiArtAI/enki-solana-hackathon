/**
 * The actions an account chooses to confirm with its second factor (Kev,
 * 2026-10-17: one table of switches in Settings, not a switch per screen).
 * On by default except rendering, which would ask on every image; what an
 * account never set keeps its default. Using the wallet, exporting its key,
 * withdrawing, changing factors or guardians and ending the account always
 * ask and are not in here. Shared by the server gates and the Settings table.
 */
export const STEPUP_DEFAULTS = { upload: true, publish: true, render: false, delete: true } as const;

export type StepUpAction = keyof typeof STEPUP_DEFAULTS;
export type StepUpActions = Record<StepUpAction, boolean>;

export const STEPUP_ACTIONS = Object.keys(STEPUP_DEFAULTS) as StepUpAction[];

export function isStepUpAction(a: unknown): a is StepUpAction {
  return typeof a === "string" && Object.hasOwn(STEPUP_DEFAULTS, a);
}

/** An account's stored choices over the defaults; anything else in the value is ignored. */
export function withDefaults(own: unknown): StepUpActions {
  const set = own && typeof own === "object" && !Array.isArray(own) ? (own as Record<string, unknown>) : {};
  return Object.fromEntries(STEPUP_ACTIONS.map((a) => [a, typeof set[a] === "boolean" ? set[a] : STEPUP_DEFAULTS[a]])) as StepUpActions;
}
