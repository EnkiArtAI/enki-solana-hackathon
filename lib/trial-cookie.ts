/**
 * The signed access cookies, none of which can be made up: the two trial
 * cookies (Kev, 2026-10-26: trial codes), the pass a redeemed code gives until
 * the tester signs in and the trial itself, which opens the app until its end;
 * and the member cookie (enki_team, lib/allowlist), which a login gives an
 * admitted account until its session ends (DEC-434). Synchronous, so the proxy
 * (always Node.js in Next 16) reads them as the routes write them. Value:
 * "<subject>.<expires ms>.<HMAC-SHA256, base64url>"; the subject is a code id
 * (pass), a user id (trial, member) or a wallet address (member), so it holds
 * no dot. The kind is signed too: one kind never opens as another.
 */
import { createHmac, timingSafeEqual } from "crypto";

export const TRIAL_COOKIE = "enki_trial";
export const TRIAL_PASS_COOKIE = "enki_trial_pass";
export type TrialKind = "pass" | "trial" | "member";

const mac = (kind: TrialKind, subject: string, expiresAtMs: number, secret: string) =>
  createHmac("sha256", `enki-trial:${secret}`).update(`${kind}.${subject}.${expiresAtMs}`).digest();

export function signTrial(kind: TrialKind, subject: string, expiresAtMs: number, secret: string): string {
  return `${subject}.${expiresAtMs}.${mac(kind, subject, expiresAtMs, secret).toString("base64url")}`;
}

/** The subject of a cookie this server signed for this kind, while it lasts; null for anything else. */
export function readTrial(kind: TrialKind, value: string | undefined, secret: string, now = Date.now()): { subject: string; expiresAtMs: number } | null {
  const parts = value?.split(".");
  if (!parts || parts.length !== 3 || !secret) return null;
  const [subject, exp, sig] = parts;
  const expiresAtMs = Number(exp);
  if (!subject || !/^\d+$/.test(exp) || !Number.isSafeInteger(expiresAtMs) || expiresAtMs <= now) return null;
  const given = Buffer.from(sig, "base64url");
  const want = mac(kind, subject, expiresAtMs, secret);
  return given.length === want.length && timingSafeEqual(given, want) ? { subject, expiresAtMs } : null;
}
