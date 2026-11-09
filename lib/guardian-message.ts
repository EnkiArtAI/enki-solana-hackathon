/** Canonical message a wallet guardian signs to confirm their role.
 *  Shared by the /guardian page (signing) and the confirm route (verifying). */
export function guardianMessage(token: string) {
  return `Enki Art guardian confirmation\nI agree to act as a recovery guardian.\nToken: ${token}`;
}

/** What a wallet guardian signs to say yes to removing a friend's lost factor: one request, by its id
 *  (lib/mfa-recovery.ts approveGuardianAsk verifies it, the /guardian page signs it). */
export function guardianFactorMessage(requestId: string) {
  return `Enki Art guardian approval\nI say yes to removing a lost security factor from my friend's account.\nRequest: ${requestId}`;
}

/** What a wallet guardian signs to answer the yearly check: one guardian, one check by the time it went out
 *  (lib/recovery/guardian-check.ts answerGuardianCheck verifies it, the /guardian page signs it). */
export function guardianCheckMessage(guardianId: string, sentAt: string) {
  return `Enki Art guardian check\nI can still be reached as a recovery guardian.\nGuardian: ${guardianId}\nSent: ${sentAt}`;
}
