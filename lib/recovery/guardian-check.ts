import crypto from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sendMail } from "@/lib/mailer";
import { everyAddress, mailEach } from "@/lib/security-notice";
import { guardianCheckMessage } from "@/lib/guardian-message";
import { RecoveryNotReady, guardianOrigin, maskGuardian, sameHash, sha256, stampReachable, walletSigned, type Guardian } from "@/lib/mfa-recovery";

/**
 * The yearly check of each guardian (Kev, 2026-11-07, on a guardian who lost their own access: "jährlichen check dann
 * einbauen"). Once a year each confirmed guardian by email or wallet gets a "still reachable?" ask: an email guardian a link
 * with its own token (only its hash is stored), a wallet guardian a link its owner sends, where that wallet signs. An answer,
 * or a yes to a request (lib/mfa-recovery.ts stampReachable), stamps checked_at. No answer within 14 days marks the guardian
 * not reachable, and every address of the owner hears, to replace them. A guardian not reachable is still asked and still
 * counts toward the threshold (DEC-2026-11-07-26); Settings counts them out of the ways back in. SQL 75 adds the columns; before
 * it ran the daily cron does nothing and says so. The cron: app/api/cron/guardian-check.
 */

export const CHECK_EVERY_MS = 365 * 24 * 3600_000;
export const ANSWER_WITHIN_MS = 14 * 24 * 3600_000;
/** Mails per run are bounded (the mail provider's daily quota); the rest are due again the next day. */
export const ASKS_PER_RUN = 25;
export const CHECK_NOT_READY = "The yearly guardian check is not available yet: SQL 75 (75-guardian-check.sql) has not run.";

const columnMissing = (error: { code?: string } | null) => error?.code === "PGRST204" || error?.code === "42703";
const CHECK_COLUMNS = "id, user_id, guardian_type, value, status, confirmed_at, created_at, checked_at, check_sent_at, check_token_hash, unreachable_at";
type CheckRow = Guardian & {
  user_id: string; status: string; confirmed_at: string | null; created_at: string | null;
  checked_at: string | null; check_sent_at: string | null; check_token_hash: string | null; unreachable_at: string | null;
};

export type CheckRun = { ready: false } | { ready: true; asked: number; failed: number; unreachable: number };

/**
 * One daily run. Due: a confirmed guardian with no check open whose last answer (or confirmation, or invite) is a year old or
 * more. Overdue: a check open for 14 days or more, not marked yet. Each ask and each mark is a conditional write, so two runs at
 * once ask and tell once. An email ask that could not be sent closes again and is due the next day. A deleted owner's guardians
 * are left alone. One mail per owner, to every address: the wallet guardians' links to send, and who could not be reached.
 */
export async function runGuardianChecks(supabase: SupabaseClient, now = Date.now()): Promise<CheckRun> {
  const { data, error } = await supabase.from("recovery_guardians").select(CHECK_COLUMNS).eq("status", "confirmed").in("guardian_type", ["email", "wallet"]);
  if (columnMissing(error)) return { ready: false };
  if (error) throw error;
  const rows = ((data ?? []) as CheckRow[]).filter((g) => g.value);
  const dueAll = rows.filter((g) => !g.check_sent_at && Date.parse(g.checked_at ?? g.confirmed_at ?? g.created_at ?? "") <= now - CHECK_EVERY_MS);
  const overdue = rows.filter((g) => g.check_sent_at && !g.unreachable_at && Date.parse(g.check_sent_at) <= now - ANSWER_WITHIN_MS);
  const ownerIds = [...new Set([...dueAll, ...overdue].map((g) => g.user_id))];
  if (!ownerIds.length) return { ready: true, asked: 0, failed: 0, unreachable: 0 };
  const { data: owners, error: ownersErr } = await supabase.from("users").select("id, handle, deleted_at").in("id", ownerIds);
  if (ownersErr) throw ownersErr;
  const live = new Map(((owners ?? []) as { id: string; handle: string | null; deleted_at: string | null }[]).filter((u) => !u.deleted_at).map((u) => [u.id, u.handle]));
  // A deleted owner's guardians are never asked, so they stay due for good: they leave before the cap, or they would take
  // every slot and no live owner's guardian would be asked again (DEC-2026-11-07-35).
  const due = dueAll.filter((g) => live.has(g.user_id)).slice(0, ASKS_PER_RUN);

  const told = new Map<string, { wallets: string[]; gone: string[]; goneWallets: string[] }>();
  const of = (userId: string) => told.get(userId) ?? told.set(userId, { wallets: [], gone: [], goneWallets: [] }).get(userId)!;
  const stamp = new Date(now).toISOString();
  let asked = 0, failed = 0, unreachable = 0;
  for (const g of due) {
    const token = g.guardian_type === "email" ? crypto.randomBytes(24).toString("hex") : null;
    const { data: claimed, error: e } = await supabase.from("recovery_guardians")
      .update({ check_sent_at: stamp, check_token_hash: token ? sha256(token) : null })
      .eq("id", g.id).eq("status", "confirmed").is("check_sent_at", null).select("id").maybeSingle();
    if (e) throw e;
    if (!claimed) continue;
    const link = `${guardianOrigin()}/guardian?check=${g.id}${token ? `&t=${token}` : ""}`;
    if (!token) {
      of(g.user_id).wallets.push(`${maskGuardian(g)}: ${link}`);
      asked++;
      continue;
    }
    const handle = live.get(g.user_id);
    const who = handle ? `@${handle}` : "your friend";
    const sent = await sendMail({
      to: g.value,
      subject: `Still there? A yearly check for ${who}'s recovery guardians`,
      text: `${handle ? `@${handle}` : "Your friend"} named you as a recovery guardian on Enki Art. Once a year we check that every guardian can still be reached. One click tells us you can:\n\n${link}\n\n` +
        `It moves no money and approves nothing. If you do not answer within 14 days, ${who} is told you could not be reached and can pick someone else.`,
    }).then((m) => m.ok, () => false);
    if (sent) { asked++; continue; }
    failed++;
    const { error: back } = await supabase.from("recovery_guardians").update({ check_sent_at: null, check_token_hash: null }).eq("id", g.id).eq("check_sent_at", stamp);
    if (back) console.error("[guardian-check] an unsent check stays open:", back.message);
  }
  for (const g of overdue) {
    if (!live.has(g.user_id)) continue;
    const { data: marked, error: e } = await supabase.from("recovery_guardians")
      .update({ unreachable_at: stamp }).eq("id", g.id).eq("check_sent_at", g.check_sent_at!).is("unreachable_at", null).select("id").maybeSingle();
    if (e) throw e;
    if (!marked) continue;
    of(g.user_id).gone.push(maskGuardian(g));
    if (g.guardian_type === "wallet") of(g.user_id).goneWallets.push(maskGuardian(g));
    unreachable++;
  }

  for (const [userId, { wallets, gone, goneWallets }] of told) {
    const to = await everyAddress(supabase, userId).catch((e) => {
      console.error("[guardian-check] the owner's addresses could not be read:", e instanceof Error ? e.message : e);
      return [] as string[];
    });
    if (wallets.length) {
      await mailEach(to, "Send your wallet guardians their yearly check",
        `Once a year we check that your guardians on Enki Art can still be reached. We cannot write to a wallet, so send each wallet guardian their link yourself. They open it and sign with that wallet:\n\n${wallets.join("\n")}\n\n` +
        `No answer within 14 days and Settings, Recovery, Guardians shows them as not reachable. Each link is there too: Copy check link.`);
    }
    if (gone.length) {
      await mailEach(to, "A guardian of your Enki account could not be reached",
        `${gone.join(", ")} did not answer the yearly check within 14 days, so Settings, Recovery, Guardians shows ${gone.length === 1 ? "this guardian" : "these guardians"} as not reachable. ` +
        // A wallet guardian sees the check only through the owner (DEC-2026-11-07-33): the step that fixes it comes first.
        (goneWallets.length
          ? `We cannot write to a wallet, so ${goneWallets.join(", ")} saw the check only if you sent its link: send it now (Settings, Recovery, Guardians, Copy check link), or replace them as below. `
          : "") +
        `If you lose a security factor, guardians you cannot reach may leave you without a way back. They are still asked and their yes still counts, but replace them: add another guardian in Settings (that asks for every factor you have), then remove the one not reachable. If they answer later, they count as reachable again.`);
    }
  }
  return { ready: true, asked, failed, unreachable };
}

async function checkRow(supabase: SupabaseClient, guardianId: string): Promise<CheckRow | null> {
  const { data, error } = await supabase.from("recovery_guardians").select(CHECK_COLUMNS).eq("id", guardianId).maybeSingle();
  if (columnMissing(error)) throw new RecoveryNotReady();
  if (error) throw error;
  const row = data as CheckRow | null;
  return row && row.status === "confirmed" && row.check_sent_at && row.value && (row.guardian_type === "email" || row.guardian_type === "wallet") ? row : null;
}
const tokenFits = (row: CheckRow, token?: string) => !!token && !!row.check_token_hash && sameHash(sha256(token), row.check_token_hash);

/** What /guardian shows a guardian with an open check. An email guardian's link must carry its token; a wallet's signs `sentAt`. */
export async function guardianCheckInfo(supabase: SupabaseClient, guardianId: string, token?: string) {
  const row = await checkRow(supabase, guardianId);
  if (!row || (row.guardian_type === "email" && !tokenFits(row, token))) return null;
  const { data: owner, error } = await supabase.from("users").select("handle").eq("id", row.user_id).maybeSingle();
  if (error) throw error;
  return { requesterHandle: (owner?.handle as string | null) ?? null, guardianType: row.guardian_type, maskedValue: maskGuardian(row), sentAt: row.check_sent_at };
}

/** The answer: the email link's token, or the wallet's signature over this guardian's open check. It stamps the guardian reachable. */
export async function answerGuardianCheck(supabase: SupabaseClient, guardianId: string, proof: { token?: string; signature?: string }): Promise<"ok" | "not_found" | "unsigned"> {
  const row = await checkRow(supabase, guardianId);
  if (!row) return "not_found";
  if (row.guardian_type === "wallet") {
    if (!proof.signature || !walletSigned(row.value, guardianCheckMessage(row.id, row.check_sent_at!), proof.signature)) return "unsigned";
  } else if (!tokenFits(row, proof.token)) return "not_found";
  await stampReachable(supabase, row.id);
  return "ok";
}

/**
 * Settings' guardian list: per guardian, whether a check is open and whether they were marked not reachable. Empty before SQL 75
 * ran, and when the read fails: the list itself still shows (the ways back in read the mark on their own, and fail loudly).
 */
export async function checkStates(supabase: SupabaseClient, userId: string): Promise<Map<string, { checkOpen: boolean; unreachable: boolean }>> {
  const { data, error } = await supabase.from("recovery_guardians").select("id, check_sent_at, unreachable_at").eq("user_id", userId);
  if (error) {
    if (!columnMissing(error)) console.error("[guardian-check] check states not read:", error.message);
    return new Map();
  }
  return new Map(((data ?? []) as { id: string; check_sent_at: string | null; unreachable_at: string | null }[])
    .map((r) => [r.id, { checkOpen: !!r.check_sent_at, unreachable: !!r.unreachable_at }]));
}
