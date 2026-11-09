/**
 * Admin panel API — the ONLY door to moderation data.
 *
 *   GET  → one payload for every tab (imports, reports, feedback,
 *          hunters, strikes+bans+appeals, recovery). Small beta-scale lists.
 *   POST → { resource, action, ... } mutations, each scoped + audited via
 *          decided_by/issued_by columns.
 *
 * Server-side gate on EVERY request: session → users.role ∈ {admin, mod}.
 * (The client gate in /admin is cosmetic — this check is the real wall.)
 * All tables verified live 2026-07-20 via PostgREST OpenAPI probe; check
 * constraints verified live 2026-07-21 via probe inserts:
 *   strikes.severity ∈ {1,2,3} · bans.scope ∈ {full} · appeals.status ∈
 *   {pending,approved,denied,withdrawn} · appeals.target_type ∈ {strike,ban} ·
 *   reports.status ∈ {pending,actioned,dismissed,duplicate} · reports.reason ∈
 *   {spam,copyright,hate,impersonation,other} · feedback_submissions.status ∈
 *   {pending,reviewed,accepted,rejected,paid,duplicate,spam} (2026-10-08)
 */
import { NextRequest, NextResponse } from "next/server";
import bs58 from "bs58";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { resolveSessionUserId } from "@/lib/session-user";
import { decryptString, encryptString, type EncryptedPayload } from "@/lib/crypto";
import { notifyAdmins } from "@/lib/admin-notify";
import { CHILD_SAFETY, hasChildSafetyCase, inWarningOrBanList, listPeople, parsePersonKey, personDetail } from "@/lib/admin/people";
import { readEvidence, withheldEvidence } from "@/lib/moderation/evidence";
import { loadPromptText } from "@/lib/generation/prompt-text";
import { banUntil } from "@/lib/moderation/bans";
import { AccessError, accessFor, approveRequest, inviteEmail, inviteWallet, inviteX, rejectRequest } from "@/lib/access-invite";
import { IN_CHUNK, inChunks } from "@/lib/in-chunks";
import { explorerTxUrl } from "@/lib/send-usdc";
import { readImageEvidence } from "@/lib/moderation/image-case";
import { clearImageCase, isImageCase, takeBackClearance } from "@/lib/moderation/image-clearance";
import { FEEDBACK_BUCKET, FEEDBACK_STATUS, feedbackDecision, type FeedbackDecision } from "@/lib/feedback";
import { publishImported } from "@/lib/hunter/publish";
import { imageGenerators, promptHash, type HunterAccount, type HunterConfig } from "@/lib/hunter/run";
import { openPreview, sealPreview } from "@/lib/referral/preview-token";
import { ENKI_CATEGORIES } from "@/lib/categories";
import { onEnki } from "@/lib/hunter/creator-profile";
import type { ImportShown } from "@/lib/referral/judge-post";
import { LOCK_MS, loadCreators, normalizeXHandle, restartCreator, saveCreator, saveMode } from "@/lib/hunter/creators";
import { defaultCreatorDeps, playCreator } from "@/lib/hunter/creator-run";
import { addLinkManually, linkSettled, queueLink, type KnownLink } from "@/lib/hunter/manual-link";
import { describeMany } from "@/lib/referral/describe-prompt";
import { extractTags, storedTags } from "@/lib/search/tags";
import { postIdOf } from "@/lib/editor/post-import";
import { snowflakeDate } from "@/lib/hunter/x-api";
import { outcomeWords, parkedMissing, parkedSaid, type HuntFacts, type ParkedKind, type ParkedRow } from "@/lib/hunter/creator-types";
import { recordAdminAction } from "@/lib/admin/audit";
import { hashTrialCode, newTrialCode } from "@/lib/trial";
import { decidePause, isPaused, pausedPrompts } from "@/lib/moderation/prompt-pause";
import { slotVariables } from "@/lib/hunter/variables";

/** A Prompt Hunter round reads and judges posts for up to four minutes (lib/hunter/run TIME_CAP_MS). */
export const maxDuration = 300;

/** A ban counts while it is not lifted and has not run out, as activeBanFor reads it. */
const unexpired = () => `expires_at.is.null,expires_at.gt.${new Date().toISOString()}`;

type Supabase = ReturnType<typeof getSupabaseServerClient>;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FEEDBACK_SIGN_TTL = 600; // seconds
const FEEDBACK_COLUMNS = "id, user_id, submitter_name, submitter_email_ct, submitter_email_iv, submitter_email_tag, submitter_email_kid, description, category, severity, status, payout_cents, payout_tx_hash, payout_chain_key, paid_at, created_at";

/** A Solana transaction signature: 64 bytes in base58. Its shape only; nothing asks the chain. */
function isTxSignature(s: string): boolean {
  try { return bs58.decode(s).length === 64; } catch { return false; }
}
/** Kev pays the $100 by hand, real USDC from his own wallet: on Solana mainnet,
    whatever chain this deployment settles on (chains.key, a foreign key, verified live 2026-10-08). */
const PAYOUT_CHAIN = "solana";

/** A whole number from lo to hi, else null. */
const int = (v: unknown, lo: number, hi: number) => (Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi ? (v as number) : null);

// The role comes back too: mods and admins share this panel, but not every
// control in it. Throttling generation is an admin decision — a mod moderates
// content, and must not be able to slow the product down for everyone.
async function requireAdmin(
  supabase: Supabase,
  req: NextRequest,
): Promise<{ userId: string; role: string } | NextResponse> {
  const userId = await resolveSessionUserId(supabase, req.headers.get("X-Session-Token"));
  if (!userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const { data } = await supabase.from("users").select("role").eq("id", userId).maybeSingle();
  const role = (data?.role as string) ?? "user";
  if (role !== "admin" && role !== "mod") {
    return NextResponse.json({ error: "Admins only" }, { status: 403 });
  }
  return { userId, role };
}

/** Tolerant field decrypt: encrypted columns may use no AAD or an id AAD. */
function tryDecrypt(ct: unknown, iv: unknown, tag: unknown, kid: unknown, aads: (string | undefined)[]): string | null {
  if (typeof ct !== "string" || typeof iv !== "string" || typeof tag !== "string" || !ct) return null;
  const payload: EncryptedPayload = { encrypted: ct, iv, authTag: tag, kid: typeof kid === "string" ? kid : undefined };
  for (const aad of aads) {
    try { return decryptString(payload, aad); } catch { /* try next */ }
  }
  return null;
}

/** The most urgent report first; reports.severity is set from the reason (lib/report-reasons). */
const SEVERITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const severityRank = (s: unknown) => SEVERITY_RANK[String(s)] ?? 4;

/** Open reports: the urgent ones, critical before high (up to PostgREST's 1000-row page), and the 100 newest, each once. */
async function pendingReports(supabase: Supabase) {
  const read = (urgent: boolean) => {
    const q = supabase.from("reports")
      .select("id, reporter_user_id, target_type, target_uuid, reason, details, severity, status, created_at")
      .eq("status", "pending");
    // "critical" sorts before "high", so no pile of high reports pushes a critical one out.
    return (urgent ? q.in("severity", ["critical", "high"]).order("severity", { ascending: true }) : q).order("created_at", { ascending: false }).limit(urgent ? 1000 : 100);
  };
  const [urgent, newest] = await Promise.all([read(true), read(false)]);
  const seen = new Set<string>();
  return {
    data: [...(urgent.data ?? []), ...(newest.data ?? [])].filter((r) => !seen.has(String(r.id)) && !!seen.add(String(r.id))),
  };
}

const handleMap = async (supabase: Supabase, ids: string[]): Promise<Map<string, string>> => {
  const uniq = [...new Set(ids.filter(Boolean))];
  if (!uniq.length) return new Map();
  const data = await inChunks(uniq, (chunk) => supabase.from("users").select("id, handle").in("id", chunk));
  return new Map(data.map((u) => [String(u.id), (u.handle as string) ?? "unnamed"]));
};

/* ── moderation council (tables from migrations/2026-07-21-moderation-council.sql;
      every read tolerates the migration not having run yet) ── */

type ProposalRow = Record<string, unknown>;
type CouncilPayload = {
  ready: boolean; isOwner: boolean; enabled: boolean; quorum: number; ttlDays: number;
  members: { handle: string; role: string; hasEmail: boolean }[];
  myEmail: string | null;
  proposals: {
    id: string; kind: string; target: string; targetUserId: string | null; days: number | null;
    violation: string; proposer: string; status: string; confirms: number; denies: number;
    myVote: string | null; quorum: number; at: string; expiresAt: string;
  }[];
};

async function buildCouncil(supabase: Supabase, userId: string): Promise<CouncilPayload> {
  const off: CouncilPayload = { ready: false, isOwner: false, enabled: false, quorum: 3, ttlDays: 7, members: [], myEmail: null, proposals: [] };
  const { data: policy, error } = await supabase.from("moderation_policy")
    .select("owner_user_id, council_enabled, quorum, proposal_ttl_days").eq("id", 1).maybeSingle();
  if (error || !policy) return off;

  const nowIso = new Date().toISOString();
  await supabase.from("mod_proposals").update({ status: "expired", decided_at: nowIso })
    .eq("status", "pending").lt("expires_at", nowIso);

  const [membersQ, prefsQ, propsQ] = await Promise.all([
    supabase.from("users").select("id, handle, role").in("role", ["admin", "mod"]).is("deleted_at", null),
    supabase.from("admin_prefs").select("user_id, notify_email_ct, notify_email_iv, notify_email_tag, notify_email_kid"),
    supabase.from("mod_proposals").select("*").order("created_at", { ascending: false }).limit(60),
  ]);
  const prefs = new Map((prefsQ.data ?? []).map((p) => [String(p.user_id), p]));
  const props = (propsQ.data ?? []) as ProposalRow[];
  const ids = props.map((p) => String(p.id));
  const votes = ids.length
    ? ((await supabase.from("mod_proposal_votes").select("proposal_id, voter_user_id, vote").in("proposal_id", ids)).data ?? [])
    : [];
  const tally = new Map<string, { c: number; d: number; mine: string | null }>();
  for (const v of votes) {
    const k = String(v.proposal_id);
    const t = tally.get(k) ?? { c: 0, d: 0, mine: null };
    if (v.vote === "confirm") t.c++; else t.d++;
    if (String(v.voter_user_id) === userId) t.mine = String(v.vote);
    tally.set(k, t);
  }
  const handles = await handleMap(supabase, [
    ...props.map((p) => (p.target_user_id ? String(p.target_user_id) : "")),
    ...props.map((p) => String(p.proposed_by)),
  ]);
  const my = prefs.get(userId);
  return {
    ready: true,
    isOwner: String(policy.owner_user_id) === userId,
    enabled: policy.council_enabled === true,
    quorum: Number(policy.quorum) || 3,
    ttlDays: Number(policy.proposal_ttl_days) || 7,
    members: (membersQ.data ?? []).map((m) => ({
      handle: (m.handle as string) ?? "unnamed",
      role: String(m.role),
      hasEmail: !!prefs.get(String(m.id))?.notify_email_ct,
    })),
    myEmail: my ? tryDecrypt(my.notify_email_ct, my.notify_email_iv, my.notify_email_tag, my.notify_email_kid, [userId, undefined]) : null,
    proposals: props.map((p) => {
      const t = tally.get(String(p.id)) ?? { c: 0, d: 0, mine: null };
      return {
        id: String(p.id), kind: String(p.kind),
        target: p.target_user_id ? "@" + (handles.get(String(p.target_user_id)) ?? "unknown") : "IP " + String(p.target_ip_hash).slice(0, 10) + "…",
        targetUserId: p.target_user_id ? String(p.target_user_id) : null,
        days: (p.days as number | null) ?? null,
        violation: String(p.violation ?? ""),
        proposer: handles.get(String(p.proposed_by)) ?? "unknown",
        status: String(p.status), confirms: t.c, denies: t.d, myVote: t.mine,
        quorum: Number(p.quorum), at: String(p.created_at), expiresAt: String(p.expires_at),
      };
    }),
  };
}

/* ── trial codes (Kev, 2026-10-26; lib/trial.ts): the owner's alone, and
      absent until migrations/2026-10-26-trial-codes.sql ran ── */

type TrialTester = { userId: string; handle: string | null; email: string | null; startedAt: string; endsAt: string; spentMicro: number };
type TrialsPayload = {
  ready: boolean;
  codes: {
    id: string; note: string | null; maxUses: number | null; uses: number; accessMinutes: number; expiresAt: string | null;
    budgetMicro: number; createdAt: string; revokedAt: string | null; testers: TrialTester[];
  }[];
};

/** The newest hundred codes with who redeemed each. Never code_hash: it is what a guessed code is checked against. */
async function buildTrials(supabase: Supabase): Promise<TrialsPayload> {
  const { data: codes, error } = await supabase.from("trial_codes")
    .select("id, note, max_uses, uses, access_minutes, expires_at, budget_micro, created_at, revoked_at")
    .order("created_at", { ascending: false }).limit(100);
  if (error) {
    if (error.code === "PGRST205" || error.code === "42P01") return { ready: false, codes: [] };
    throw error;
  }
  const runs = await inChunks((codes ?? []).map((c) => String(c.id)), (chunk) => supabase.from("trial_redemptions")
    .select("code_id, user_id, started_at, ends_at, spent_micro").in("code_id", chunk).order("started_at", { ascending: false }));
  const users = runs.map((r) => String(r.user_id));
  const [people, passwords, logins] = await Promise.all([
    inChunks(users, (chunk) => supabase.from("users").select("id, handle").in("id", chunk)),
    inChunks(users, (chunk) => supabase.from("password_credentials").select("user_id, email").in("user_id", chunk)),
    inChunks(users, (chunk) => supabase.from("auth_identities").select("user_id, email").in("user_id", chunk)),
  ]);
  const handles = new Map(people.map((u) => [String(u.id), (u.handle as string | null) ?? null]));
  // How to reach a tester: the email of their password, else of any login they signed in with.
  const emails = new Map<string, string>();
  for (const r of [...passwords, ...logins]) if (r.email && !emails.has(String(r.user_id))) emails.set(String(r.user_id), String(r.email));
  const testers = new Map<string, TrialTester[]>();
  for (const r of runs) {
    const k = String(r.code_id);
    (testers.get(k) ?? testers.set(k, []).get(k)!).push({
      userId: String(r.user_id), handle: handles.get(String(r.user_id)) ?? null, email: emails.get(String(r.user_id)) ?? null,
      startedAt: String(r.started_at), endsAt: String(r.ends_at), spentMicro: Number(r.spent_micro ?? 0),
    });
  }
  return {
    ready: true,
    codes: (codes ?? []).map((c) => ({
      id: String(c.id), note: (c.note as string | null) ?? null,
      maxUses: c.max_uses == null ? null : Number(c.max_uses), uses: Number(c.uses ?? 0), accessMinutes: Number(c.access_minutes),
      expiresAt: (c.expires_at as string | null) ?? null, budgetMicro: Number(c.budget_micro), createdAt: String(c.created_at),
      revokedAt: (c.revoked_at as string | null) ?? null, testers: testers.get(String(c.id)) ?? [],
    })),
  };
}

/** Newest hashed login IP for a user (sessions are keyed by user id or wallet). */
async function lastKnownIpHash(supabase: Supabase, targetUserId: string): Promise<string | null> {
  const { data: wallets } = await supabase.from("user_wallets").select("address").eq("user_id", targetUserId);
  const keys = [targetUserId, ...(wallets ?? []).map((w) => String(w.address))];
  const { data } = await supabase.from("auth_sessions")
    .select("ip_hash").in("wallet_address", keys).not("ip_hash", "is", null)
    .order("created_at", { ascending: false }).limit(1);
  return (data?.[0]?.ip_hash as string) ?? null;
}

/** Quorum reached → the proposal's action lands in bans/ip_bans. */
async function executeProposal(supabase: Supabase, p: ProposalRow, now: string): Promise<{ message?: string } | null> {
  const reason = `Council: ${String(p.violation)}`.slice(0, 200);
  if (p.kind === "ip_ban") {
    const { error } = await supabase.from("ip_bans").upsert({
      ip_hash: String(p.target_ip_hash), reason, issued_by: String(p.proposed_by), proposal_id: String(p.id),
    }, { onConflict: "ip_hash", ignoreDuplicates: true });
    if (error) return error;
  } else {
    const until = p.kind === "ban_perm" ? null : new Date(Date.now() + Number(p.days ?? 7) * 86400_000).toISOString();
    // Its own row beside any running ban (lib/moderation/bans.ts), so each
    // keeps its reason and appeal; nothing new if this same ban already runs as long.
    const issued = await banUntil(supabase, {
      userId: String(p.target_user_id), issuedBy: String(p.proposed_by), reason, expiresAt: until,
    }).catch(() => null);
    if (!issued) return { message: "the ban could not be issued" };
  }
  const { error } = await supabase.from("mod_proposals")
    .update({ status: "approved", decided_at: now, executed_at: now }).eq("id", String(p.id));
  return error ?? null;
}

/** Email every council member with a saved notify address (except the proposer). */
async function notifyCouncil(supabase: Supabase, proposerId: string, p: { kind: string; days: number | null; violation: string; targetHandle: string; quorum: number }) {
  const { data: proposer } = await supabase.from("users").select("handle").eq("id", proposerId).maybeSingle();
  const label = p.kind === "ip_ban" ? "indefinite IP ban" : p.kind === "ban_perm" ? "permanent ban" : `${p.days ?? 7}-day ban`;
  const origin = process.env.NEXT_PUBLIC_APP_URL || process.env.NEXT_PUBLIC_SITE_ORIGIN || "";
  await notifyAdmins(supabase, {
    exceptUserId: proposerId,
    subject: `[Enki Admin] Council vote: ${label} for @${p.targetHandle}`,
    text: [
      `@${(proposer?.handle as string) ?? "an admin"} proposes a ${label} against @${p.targetHandle}.`,
      "",
      `Violation: ${p.violation}`,
      "",
      `Confirm or deny in the admin panel (Council tab)${origin ? `: ${origin}/admin` : "."}`,
      `The action executes at ${p.quorum} confirmations.`,
    ].join("\n"),
  });
}

// Pending imports in pages of 50, newest first (Kev, 2026-10-31: "unlimited scroll feature that always loads the next 50");
// the id breaks ties, so pages neither overlap nor skip.
const IMPORTS_PAGE = 50;
const pendingImports = (supabase: Supabase, from: number, n: number) => supabase.from("hunt_submissions")
  .select("id, hunter_user_id, source_url, suggested_title, suggested_tags, submitted_at, preview", { count: "exact" })
  .eq("status", "pending").order("submitted_at", { ascending: false }).order("id", { ascending: true }).range(from, from + n - 1);
const importRow = (handles: Map<string, string>) => (r: Record<string, unknown>) => ({
  id: String(r.id),
  name: (r.suggested_title as string) || "Untitled",
  url: (r.source_url as string) ?? null,
  hunter: handles.get(String(r.hunter_user_id)) ?? "unknown",
  tags: Array.isArray(r.suggested_tags) ? (r.suggested_tags as string[]) : [],
  at: r.submitted_at,
  // What the Prompt Hunter judged, for the row; a person's referral is published already and has none.
  preview: importPreview(r.preview),
});

export async function GET(req: NextRequest) {
  const supabase = getSupabaseServerClient();
  const gate = await requireAdmin(supabase, req);
  if (gate instanceof NextResponse) return gate;
  const { userId, role } = gate;

  // One hunted account's read posts, as a file: what was read, and what became of each post.
  // What a running Play has done so far, from its checkpoints (Kev, 2026-10-31: "zeige mir bitte ganz unten am frame stets
  // was so passiert"): the latest Play of the creator, its usage and spend.
  const hunterLive = req.nextUrl.searchParams.get("hunterLive");
  if (hunterLive !== null) {
    const handle = hunterLive.replace(/^@/, "").trim().toLowerCase();
    if (!/^[a-z0-9_]{1,15}$/.test(handle)) return NextResponse.json({ error: "Bad handle" }, { status: 400 });
    const { data, error } = await supabase.from("hunter_runs").select("started_at, usage, est_usd").eq("handle", handle).order("started_at", { ascending: false }).limit(1).maybeSingle();
    return error ? NextResponse.json({ error: "Could not read the Play" }, { status: 500 }) : NextResponse.json({ live: data ?? null });
  }
  // The hunter's log: every post read, newest first, with what became of it (Kev, 2026-10-31: "im log auch sehen bei
  // welchem link es welche fehler gab und welche easy peasy durchgegangen sind. suchbar nach link oder username").
  // The next page of Pending imports, as the list scrolls.
  const importsFrom = req.nextUrl.searchParams.get("importsFrom");
  if (importsFrom !== null) {
    const from = int(Number(importsFrom), 0, 1_000_000);
    if (from === null) return NextResponse.json({ error: "Bad page" }, { status: 400 });
    const { data, error, count } = await pendingImports(supabase, from, IMPORTS_PAGE);
    if (error) return NextResponse.json({ error: "Could not read the imports" }, { status: 500 });
    const handles = await handleMap(supabase, (data ?? []).map((r) => String(r.hunter_user_id)));
    return NextResponse.json({ imports: (data ?? []).map(importRow(handles)), importsTotal: count ?? 0 });
  }
  // A page of the Videos or the No media tab, newest first (lib/hunter/creator-run park), read only when that tab opens: the
  // page's own read leaves this table alone, so the rest of the admin page works before SQL 64 runs.
  const parked = req.nextUrl.searchParams.get("parked");
  if (parked !== null) {
    const from = int(Number(req.nextUrl.searchParams.get("from") ?? 0), 0, 1_000_000);
    if ((parked !== "video" && parked !== "no_media") || from === null) return NextResponse.json({ error: "Bad page" }, { status: 400 });
    const { data, error, count } = await supabase.from("hunter_parked").select("post_id, handle, post_text, replies, videos, why, read_at", { count: "exact" })
      .eq("kind", parked satisfies ParkedKind).order("read_at", { ascending: false }).order("post_id", { ascending: true }).range(from, from + IMPORTS_PAGE - 1);
    if (error) return parkedMissing(error) ? NextResponse.json({ ready: false, rows: [], total: 0 }) : NextResponse.json({ error: "Could not read the saved posts" }, { status: 500 });
    const { data: finds } = await supabase.from("hunt_submissions").select("normalized_source_url, status").in("normalized_source_url", (data ?? []).map((r) => `x.com/status/${r.post_id}`));
    const findOf = new Map((finds ?? []).map((f) => [String(f.normalized_source_url), String(f.status)]));
    const rows: ParkedRow[] = (data ?? []).map((r) => {
      const status = findOf.get(`x.com/status/${r.post_id}`);
      return {
        postId: String(r.post_id), handle: String(r.handle), link: `https://x.com/${r.handle}/status/${r.post_id}`, at: String(r.read_at),
        posted: snowflakeDate(String(r.post_id))?.toISOString() ?? null, text: String(r.post_text ?? ""), why: (r.why as string | null) ?? null,
        replies: ((r.replies ?? []) as { id?: unknown; text?: unknown }[]).map((x) => ({ id: String(x.id), text: String(x.text ?? "") })),
        videos: ((r.videos ?? []) as Record<string, unknown>[]).map((v) => ({
          poster: typeof v.thumbnail_url === "string" && v.thumbnail_url.startsWith("https://pbs.twimg.com/") ? v.thumbnail_url : null,
          duration: typeof v.duration === "number" ? v.duration : null, gif: v.type === "gif", inReply: typeof v.reply_id === "string",
        })),
        find: status === "pending" ? "pending" : status === "approved" ? "published" : null,
      };
    });
    return NextResponse.json({ ready: true, rows, total: count ?? 0 });
  }
  // The links waiting under one creator for "Play links", oldest first.
  const hunterWaiting = req.nextUrl.searchParams.get("hunterWaiting");
  if (hunterWaiting !== null) {
    const handle = normalizeXHandle(hunterWaiting);
    const { data, error } = await supabase.from("hunter_posts").select("post_id").eq("handle", handle).eq("outcome", "waiting").order("read_at", { ascending: true });
    return error ? NextResponse.json({ error: "Could not read the waiting links" }, { status: 500 }) : NextResponse.json({ links: (data ?? []).map((r) => String(r.post_id)) });
  }
  if (req.nextUrl.searchParams.get("hunterLog") !== null) {
    const [posts, known] = await Promise.all([
      supabase.from("hunter_posts").select("post_id, handle, outcome, read_at").order("read_at", { ascending: false }).limit(1000),
      // A link Enki knew already (Kev, 2026-11-02): a line of its own, from the admin log; a post's row keeps its real outcome.
      supabase.from("admin_actions").select("target, detail, created_at").eq("action", "hunter.knownLink").order("created_at", { ascending: false }).limit(1000),
    ]);
    if (posts.error || known.error) return NextResponse.json({ error: "Could not read the log" }, { status: 500 });
    const lines = (known.data ?? []).map((r) => {
      const said = (r.detail as { outcome?: { status?: string; handle?: string | null } } | null)?.outcome;
      return { post_id: String(r.target), handle: said?.handle || "i", outcome: said?.status === "waiting" ? "already_waiting" : "already_in_enki", read_at: String(r.created_at) };
    });
    return NextResponse.json({ log: [...(posts.data ?? []), ...lines].sort((a, b) => Date.parse(b.read_at) - Date.parse(a.read_at)).slice(0, 1000) });
  }
  const hunterPosts = req.nextUrl.searchParams.get("hunterPosts");
  if (hunterPosts !== null) {
    const handle = hunterPosts.replace(/^@/, "").trim().toLowerCase();
    if (!/^[a-z0-9_]{1,15}$/.test(handle)) return NextResponse.json({ error: "Bad handle" }, { status: 400 });
    const { data: rows, error } = await supabase.from("hunter_posts").select("post_id, likes, outcome, read_at").eq("handle", handle).order("read_at", { ascending: false }).limit(10000);
    if (error) return NextResponse.json({ error: "Could not read the posts" }, { status: 500 });
    // The outcome as the admin reads it; an unknown one reads as its name, whatever it holds, so it is quoted when it must be.
    const cell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const lines = ["post_id,url,likes,outcome,read_at", ...(rows ?? []).map((r) => `${r.post_id},https://x.com/${handle}/status/${r.post_id},${r.likes ?? 0},${cell(outcomeWords(String(r.outcome)))},${r.read_at}`)];
    return new NextResponse(lines.join("\n") + "\n", {
      headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="hunter-${handle}.csv"` },
    });
  }

  // One person, expanded in the person list: every event with its prompt and settings.
  const person = req.nextUrl.searchParams.get("person");
  if (person !== null) {
    const who = parsePersonKey(person);
    if (!who) return NextResponse.json({ error: "Bad person id" }, { status: 400 });
    return NextResponse.json(await personDetail(supabase, who, (ct, iv, tag, kid) => tryDecrypt(ct, iv, tag, kid, [undefined])));
  }

  // One report's attachments, signed as its row opens (Kev, 2026-10-08). The
  // bucket is private: a link that lives for minutes cannot outlive the look.
  const feedbackId = req.nextUrl.searchParams.get("feedback");
  if (feedbackId !== null) {
    if (!UUID_RE.test(feedbackId)) return NextResponse.json({ error: "Bad feedback id" }, { status: 400 });
    const { data: att } = await supabase.from("feedback_attachments")
      .select("storage_key, mime_type").eq("feedback_id", feedbackId).order("sort_order", { ascending: true });
    const rows = (att ?? []).filter((a) => a.storage_key);
    const signed = rows.length
      ? (await supabase.storage.from(FEEDBACK_BUCKET).createSignedUrls(rows.map((a) => String(a.storage_key)), FEEDBACK_SIGN_TTL)).data ?? []
      : [];
    const url = new Map(signed.map((f) => [f.path, f.signedUrl]));
    return NextResponse.json({ files: rows.map((a) => ({ url: url.get(String(a.storage_key)) ?? null, mime: String(a.mime_type ?? "") })) });
  }

  const missed = await supabase.from("hunt_submissions").select("id", { count: "exact", head: true }).eq("status", "pending").not("preview->hunt->>recipeMiss", "is", null);
  const [imp, rep, fb, hu, st, ba, ap, rec, council, genPolicy, automod, people, access, fbDue, hunterCfg, hunterRuns, hunterAccounts, adminLog] = await Promise.all([
    pendingImports(supabase, 0, Math.min(1000, Math.max(IMPORTS_PAGE, Math.trunc(Number(req.nextUrl.searchParams.get("imports"))) || 0))),
    pendingReports(supabase),
    supabase.from("feedback_submissions").select(FEEDBACK_COLUMNS).order("created_at", { ascending: false }).limit(100),
    supabase.from("hunter_stats")
      .select("user_id, total_submissions, approved_count, rejected_count, duplicate_count, earnings_cents")
      .order("approved_count", { ascending: false }).limit(50),
    supabase.from("strikes")
      .select("id, user_id, reason, severity, created_at")
      .is("revoked_at", null).order("created_at", { ascending: false }).limit(200),
    supabase.from("bans")
      .select("id, user_id, reason, scope, expires_at, created_at")
      // In activeBanFor's order: the ban that holds comes first per user and
      // survives the limit; ties go to the newest.
      .is("lifted_at", null).or(unexpired())
      .order("expires_at", { ascending: false, nullsFirst: true }).order("created_at", { ascending: false }).limit(100),
    supabase.from("appeals")
      .select("id, user_id, user_statement, status, target_uuid, created_at")
      .eq("status", "pending").order("created_at", { ascending: false }).limit(100),
    supabase.from("recovery_requests")
      .select("id, user_id, claimed_handle, claimed_wallet, contact_email_ct, contact_email_iv, contact_email_tag, contact_email_kid, explanation_ct, explanation_iv, explanation_tag, explanation_kid, layer, status, rejection_reason, created_at")
      .order("created_at", { ascending: false }).limit(50),
    buildCouncil(supabase, userId),
    supabase.from("generation_policy").select("max_concurrent_per_user").eq("id", 1).maybeSingle(),
    // Blocks only. Passes are recorded too (they are the control group for
    // tuning thresholds) but there is nothing for a moderator to do with
    // them, and at generation volume they would bury the real cases.
    supabase.from("automod_events")
      .select("id, user_id, surface, severity, tier, category, matched_rules, scores, prompt_hash, evidence_ct, evidence_iv, evidence_tag, evidence_kid, review_state, created_at")
      .eq("decision", "block")
      .order("created_at", { ascending: false }).limit(150),
    listPeople(supabase),
    accessFor(supabase, role),
    // Every report staff still owe a decision or the $100, however old: the
    // newest hundred alone let a done report fall out of view, unpaid.
    supabase.from("feedback_submissions").select(FEEDBACK_COLUMNS).is("paid_at", null).neq("status", FEEDBACK_STATUS.rejected)
      .order("created_at", { ascending: true }).limit(300),
    supabase.from("hunter_config").select("*").eq("id", 1).maybeSingle(),
    supabase.from("hunter_runs").select("id, started_at, finished_at, posts_read, found, queued, published, skipped, error").order("started_at", { ascending: false }).limit(10),
    supabase.from("hunter_accounts").select("*").order("added_at", { ascending: true }),
    // The admin log, admins only, newest first (Kev, 2026-10-17); absent until its migration ran.
    role === "admin"
      ? supabase.from("admin_actions").select("id, actor_id, actor_role, action, target, detail, created_at").neq("action", "hunter.knownLink").order("created_at", { ascending: false }).limit(200)
      : Promise.resolve({ data: null, error: null }),
  ]);
  const fbRows = [...new Map([...(fb.data ?? []), ...(fbDue.data ?? [])].map((r) => [String(r.id), r])).values()]
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));

  // attachments per feedback + evidence per recovery request
  const fbIds = fbRows.map((r) => String(r.id));
  const recIds = (rec.data ?? []).map((r) => String(r.id));
  // Where a report's $100 goes: the account's live Solana wallet, as artist payouts read it.
  const fbUsers = fbRows.filter((r) => r.user_id).map((r) => String(r.user_id));
  const [att, evi, wallets] = await Promise.all([
    fbIds.length ? supabase.from("feedback_attachments").select("feedback_id").in("feedback_id", fbIds) : Promise.resolve({ data: [] }),
    recIds.length ? supabase.from("recovery_request_evidence").select("request_id, kind, matched, value_url").in("request_id", recIds) : Promise.resolve({ data: [] }),
    inChunks(fbUsers, (chunk) => supabase.from("user_wallets").select("user_id, address").in("user_id", chunk).eq("chain_family", "solana").is("removed_at", null)),
  ]);
  const payTo = new Map<string, string>();
  for (const w of wallets) {
    const address = String(w.address);
    // All lowercase is a legacy row that decodes to a key nobody holds: it must
    // be re-linked before anything is sent to it (artistPayoutWallet).
    if (address !== address.toLowerCase()) payTo.set(String(w.user_id), address);
  }
  const attCount = new Map<string, number>();
  for (const a of (att.data ?? []) as { feedback_id: string }[]) {
    attCount.set(String(a.feedback_id), (attCount.get(String(a.feedback_id)) ?? 0) + 1);
  }
  const eviByReq = new Map<string, { kind: string; matched: boolean | null }[]>();
  for (const e of (evi.data ?? []) as { request_id: string; kind: string; matched: boolean | null }[]) {
    const k = String(e.request_id);
    (eviByReq.get(k) ?? eviByReq.set(k, []).get(k)!).push({ kind: e.kind, matched: e.matched });
  }

  // handles for hunters, strikes/bans/appeals users, reporters + report targets
  const strikeUsers = (st.data ?? []).map((r) => String(r.user_id));
  const banUsers = (ba.data ?? []).map((r) => String(r.user_id));
  const appealUsers = (ap.data ?? []).map((r) => String(r.user_id));
  // An image report names the image's owner and links the image itself.
  const images = new Map<string, { owner: string; url: string | null }>();
  const imageTargets = (rep.data ?? []).filter((r) => r.target_type === "generation").map((r) => String(r.target_uuid));
  if (imageTargets.length) {
    const data = await inChunks(imageTargets, (chunk) => supabase.from("generated_images").select("id, user_id, preview_url, storage_url").in("id", chunk));
    for (const g of data) {
      images.set(String(g.id), { owner: String(g.user_id), url: (g.preview_url as string) ?? (g.storage_url as string) ?? null });
    }
  }
  const hunter = (hunterCfg.data as HunterConfig | null) ?? null;
  const handles = await handleMap(supabase, [
    ...(imp.data ?? []).map((r) => String(r.hunter_user_id)),
    ...(hunter?.publisher_user_id ? [hunter.publisher_user_id] : []),
    ...(hu.data ?? []).map((r) => String(r.user_id)),
    ...(rep.data ?? []).map((r) => String(r.reporter_user_id)),
    ...(rep.data ?? []).filter((r) => r.target_type === "user").map((r) => String(r.target_uuid)),
    ...[...images.values()].map((g) => g.owner),
    ...strikeUsers, ...banUsers, ...appealUsers,
    // automod events carry a user only when the request had a session;
    // /api/generate-free has none, so those rows stay attributed by IP hash.
    ...(automod.data ?? []).filter((r) => r.user_id).map((r) => String(r.user_id)),
    ...(adminLog.data ?? []).map((r) => String(r.actor_id)),
  ]);
  const promptTargets = (rep.data ?? []).filter((r) => r.target_type === "prompt").map((r) => String(r.target_uuid));
  const promptTitles = new Map<string, string>();
  if (promptTargets.length) {
    const data = await inChunks(promptTargets, (chunk) => supabase.from("prompts").select("id, title").in("id", chunk));
    for (const p of data) promptTitles.set(String(p.id), (p.title as string) ?? "Untitled");
  }

  // strikes tab: one row per user with active strikes, ban state and appeal
  // A user can hold several bans (each sanction is its own row); the one that
  // lasts longest holds, and is the one shown.
  const banByUser = new Map<string, { id: string; reason: string | null; permanent: boolean }>();
  const banById = new Map<string, { reason: string | null; until: string | null }>();
  for (const b of (ba.data ?? []) as { id: string; user_id: string; reason: string | null; expires_at: string | null }[]) {
    banById.set(String(b.id), { reason: b.reason, until: b.expires_at });
    if (!banByUser.has(String(b.user_id))) banByUser.set(String(b.user_id), { id: String(b.id), reason: b.reason, permanent: !b.expires_at });
  }
  // Of several pending appeals, the one against the ban that holds; else the
  // newest. Each carries the ban it is against, so the admin approves knowing
  // which one it lifts.
  const appealByUser = new Map<string, { id: string; note: string | null; target: string | null; against: { reason: string | null; until: string | null } | null }>();
  for (const a of (ap.data ?? []) as { id: string; user_id: string; user_statement: string | null; target_uuid: string | null }[]) {
    const k = String(a.user_id);
    const holding = banByUser.get(k)?.id;
    const cur = appealByUser.get(k);
    if (!cur || (a.target_uuid === holding && cur.target !== holding)) {
      appealByUser.set(k, {
        id: String(a.id), note: a.user_statement, target: a.target_uuid ?? null,
        against: a.target_uuid ? banById.get(a.target_uuid) ?? null : null,
      });
    }
  }
  const strikeRows = new Map<string, { userId: string; strikes: { id: string; reason: string | null }[] }>();
  for (const s of (st.data ?? []) as { id: string; user_id: string; reason: string | null }[]) {
    const k = String(s.user_id);
    (strikeRows.get(k) ?? strikeRows.set(k, { userId: k, strikes: [] }).get(k)!).strikes.push({ id: String(s.id), reason: s.reason });
  }
  for (const k of [...banByUser.keys(), ...appealByUser.keys()]) {
    if (!strikeRows.has(k)) strikeRows.set(k, { userId: k, strikes: [] });
  }
  // The owner as the council reads it (moderation_policy.owner_user_id); null for everyone else.
  const trials = council.isOwner ? await buildTrials(supabase) : null;
  // Prompts off sale after a render was refused for their own text, waiting for staff (DEC-441); with their artists' names.
  const pausedRows = await pausedPrompts(supabase);
  const artistIds = [...new Set(pausedRows.flatMap((p) => (p.creatorId ? [p.creatorId] : [])))];
  const { data: artists } = artistIds.length ? await supabase.from("users").select("id, handle").in("id", artistIds) : { data: [] };
  const artistHandle = new Map((artists ?? []).map((u) => [String(u.id), (u.handle as string | null) ?? "unknown"]));
  // The Creator Hunter's list (SQL 56; not ready before it ran) and the generators a creator may prefer.
  const [creatorList, catalogue] = hunter ? await Promise.all([loadCreators(supabase), imageGenerators(supabase)]) : [{ ready: false, creators: [] }, []];

  return NextResponse.json({
    people,
    imports: (imp.data ?? []).map(importRow(handles)),
    importsTotal: imp.count ?? 0,
    // Over every waiting find, not the loaded pages (review 2026-11-01).
    importsMissed: missed.count ?? 0,
    reports: (rep.data ?? []).map((r) => {
      const id = String(r.target_uuid);
      const image = images.get(id);
      return {
        id: String(r.id),
        ...(r.target_type === "prompt"
          ? { type: "prompt", target: promptTitles.get(id) ?? "Deleted prompt", href: `/generator/${id}` }
          : r.target_type === "generation"
            ? { type: "image", target: image ? `Image by @${handles.get(image.owner) ?? "unknown"}` : "Deleted image", href: image?.url ?? null }
            : { type: "profile", target: "@" + (handles.get(id) ?? "unknown"), href: `/creators/${id}` }),
        reason: (r.reason as string) ?? "—",
        details: (r.details as string) ?? null,
        reporter: handles.get(String(r.reporter_user_id)) ?? "anon",
        severity: (r.severity as string | null) ?? null,
        at: r.created_at,
      };
    }).sort((a, b) => severityRank(a.severity) - severityRank(b.severity)),
    feedback: fbRows.map((r) => ({
      id: String(r.id),
      name: (r.submitter_name as string) || "Anonymous",
      // The sender's email is an admin's to see, not a mod's (Kev, 2026-10-08).
      email: role === "admin"
        ? tryDecrypt(r.submitter_email_ct, r.submitter_email_iv, r.submitter_email_tag, r.submitter_email_kid,
          [undefined, String(r.id), r.user_id ? String(r.user_id) : undefined])
        : null,
      desc: (r.description as string) ?? "",
      images: attCount.get(String(r.id)) ?? 0,
      paid: r.paid_at !== null,
      state: feedbackDecision(r.status),
      wallet: r.user_id ? (payTo.get(String(r.user_id)) ?? null) : null,
      txUrl: r.payout_tx_hash ? explorerTxUrl(r.payout_chain_key, String(r.payout_tx_hash)) : null,
      payoutCents: (r.payout_cents as number | null) ?? null,
      at: r.created_at,
    })),
    hunters: (hu.data ?? []).map((r) => ({
      handle: handles.get(String(r.user_id)) ?? "unknown",
      total: (r.total_submissions as number) ?? 0,
      approved: (r.approved_count as number) ?? 0,
      denied: ((r.rejected_count as number) ?? 0) + ((r.duplicate_count as number) ?? 0),
      earningsCents: (r.earnings_cents as number) ?? 0,
    })),
    strikes: [...strikeRows.values()].map((row) => ({
      userId: row.userId,
      handle: handles.get(row.userId) ?? "unknown",
      strikes: row.strikes,
      banned: banByUser.has(row.userId),
      permanent: banByUser.get(row.userId)?.permanent ?? false,
      note: row.strikes[0]?.reason ?? banByUser.get(row.userId)?.reason ?? null,
      appeal: appealByUser.get(row.userId) ?? null,
    })),
    generation: {
      // Null is unlimited, and the UI must say so rather than showing a 0.
      maxConcurrentPerUser: (genPolicy.data?.max_concurrent_per_user as number | null) ?? null,
      // Mods see the number; only an admin may change it.
      canEdit: role === "admin",
    },
    automod: (automod.data ?? []).map((r) => {
      const scores = (r.scores as Record<string, number> | null) ?? null;
      const evidence = readEvidence(r);
      // The single number a moderator needs: what the classifier was most
      // sure about. Everything else is in `scores` if they open the row. A
      // warning's weight is no score, and its confidence stands in only when
      // no classifier score came with it: jsonb returns keys shortest first,
      // so a tie must not decide which one shows.
      const ranked = Object.entries(scores ?? {}).filter(([k]) => k !== "weight");
      const classifier = ranked.filter(([k]) => k !== "confidence");
      const worst = (classifier.length ? classifier : ranked).sort((a, b) => b[1] - a[1])[0] ?? null;
      return {
        id: String(r.id),
        handle: r.user_id ? (handles.get(String(r.user_id)) ?? "unknown") : null,
        surface: (r.surface as string) ?? "?",
        severity: (r.severity as string) ?? "log",
        tier: (r.tier as number | null) ?? null,
        category: (r.category as string) ?? null,
        rules: Array.isArray(r.matched_rules) ? (r.matched_rules as string[]) : [],
        topScore: worst ? { name: worst[0], value: worst[1] } : null,
        // What was blocked, as far as a moderator may read it: a user's own
        // text and a buyer's values, never an artist's words.
        prompt: evidence.text,
        withheld: evidence.withheld,
        draft: evidence.draft,
        state: (r.review_state as string) ?? "none",
        at: r.created_at,
      };
    }),
    recovery: (rec.data ?? []).map((r) => ({
      id: String(r.id),
      handle: (r.claimed_handle as string) ?? "unknown",
      wallet: (r.claimed_wallet as string) ?? null,
      contact: tryDecrypt(r.contact_email_ct, r.contact_email_iv, r.contact_email_tag, r.contact_email_kid,
        [undefined, String(r.id), r.user_id ? String(r.user_id) : undefined]),
      explanation: tryDecrypt(r.explanation_ct, r.explanation_iv, r.explanation_tag, r.explanation_kid,
        [undefined, String(r.id), r.user_id ? String(r.user_id) : undefined]),
      evidence: eviByReq.get(String(r.id)) ?? [],
      layer: (r.layer as string | number | null) ?? null,
      status: (r.status as string) ?? "pending",
      at: r.created_at,
    })),
    council,
    access,
    trials,
    paused: pausedRows.map((p) => ({ ...p, artist: p.creatorId ? artistHandle.get(p.creatorId) ?? "unknown" : "unknown" })),
    // null for a mod; ready false until the migration ran.
    adminLog: role !== "admin" ? null : {
      ready: !adminLog.error,
      rows: (adminLog.data ?? []).map((r) => ({
        id: String(r.id), at: r.created_at, action: String(r.action), target: (r.target as string | null) ?? null,
        actor: handles.get(String(r.actor_id)) ?? String(r.actor_id), role: String(r.actor_role), detail: r.detail ?? {},
      })),
    },
    // The Prompt Hunter's switches, its accounts and how far each was read, its last runs; absent until its migration ran.
    hunter: hunter ? {
      ready: true,
      canEdit: role === "admin",
      config: {
        mode: hunter.mode, postsPerRun: hunter.posts_per_run, minLikes: hunter.min_likes, perAuthorDaily: hunter.per_author_daily, dryAfter: hunter.dry_after,
        publisher: hunter.publisher_user_id ? (handles.get(hunter.publisher_user_id) ?? null) : null,
      },
      accounts: ((hunterAccounts.data ?? []) as HunterAccount[]).map((a) => ({
        handle: a.handle, newestId: a.newest_id, oldestId: a.oldest_id, exhausted: a.exhausted, dry: a.dry, postsRead: a.posts_read, found: a.found,
        error: a.error, lastRunAt: a.last_run_at, addedAt: a.added_at,
      })),
      runs: (hunterRuns.data ?? []).map((r) => ({
        id: String(r.id), at: r.started_at, done: r.finished_at ?? null, postsRead: r.posts_read ?? 0, found: r.found ?? 0,
        queued: r.queued ?? 0, published: r.published ?? 0, skipped: (r.skipped as Record<string, number>) ?? {}, error: (r.error as string | null) ?? null,
      })),
      // The creators (Kev, 2026-10-30): each with its search, generator, caps, Enki account and last Plays (lib/hunter/creators).
      creatorsReady: creatorList.ready, creators: creatorList.creators, catalogue, modesReady: creatorList.modesReady === true,
    } : { ready: false, canEdit: role === "admin", config: null, accounts: [], runs: [] },
  });
}

/** The queue row's preview as the hunter stored it (lib/referral/judge-post shownOf), with how a creator's Play found it, or null. */
function importPreview(raw: unknown): (ImportShown & { hunt: HuntFacts | null }) | null {
  const p = raw as (Partial<ImportShown> & { hunt?: unknown }) | null;
  if (!p || typeof p.prompt !== "string" || !Array.isArray(p.photos)) return null;
  return {
    prompt: p.prompt, title: String(p.title ?? ""), category: String(p.category ?? ""), tags: Array.isArray(p.tags) ? p.tags : [],
    adult: p.adult === true, generators: Array.isArray(p.generators) ? p.generators : [],
    photos: p.photos.filter((x): x is string => typeof x === "string"), source: { url: String(p.source?.url ?? ""), handle: String(p.source?.handle ?? "") },
    // Where the prompt sat, how it was cut, which generator and why (lib/hunter/creator-run); null for the legacy run and a person's referral.
    hunt: p.hunt && typeof p.hunt === "object" && typeof (p.hunt as HuntFacts).from === "string" ? (p.hunt as HuntFacts) : null,
  };
}

/**
 * Publishes the hunter's approved rows: each from its sealed preview, as the
 * publisher account, through POST /api/prompt (lib/hunter/publish). A row
 * that fails goes back to pending with the reason, so the queue keeps it.
 */
async function publishApproved(
  supabase: Supabase, ids: string[],
): Promise<{ published: number; failed: { id: string; error: string }[]; refused: string[] }> {
  const { data: rows } = await supabase.from("hunt_submissions")
    .select("id, hunter_user_id, preview_token, preview")
    .in("id", ids).eq("status", "approved").not("preview_token", "is", null).is("minted_prompt_id", null);
  const failed: { id: string; error: string }[] = [];
  const refused: string[] = [];
  let published = 0;
  let names: string[] | null = null;
  for (const r of rows ?? []) {
    const shown = importPreview(r.preview);
    if (!shown) { failed.push({ id: String(r.id), error: "no preview" }); continue; }
    // A creator who joined Enki and connected X publishes their own posts (Kev, 2026-10-30: "gefund freigabe ablehnen
    // sobald autor auf enki, ja passt soweit!"): the find is rejected, never published on the imported account.
    const held = shown.hunt ? await onEnki(supabase, shown.hunt.creator.xUserId) : null;
    if (held && shown.hunt) {
      refused.push(`@${shown.hunt.creator.handle} is on Enki as @${held} now: theirs to publish.`);
      await supabase.from("hunt_submissions").delete().eq("id", r.id);
      continue;
    }
    // A prompt always has media (Kev, 2026-11-03): nothing waiting without a picture goes live, whichever Play queued it.
    if (!shown.photos.length) {
      failed.push({ id: String(r.id), error: "This find has no picture: a prompt on Enki always has media. Reject it, or open its post and add a link that has one." });
      await supabase.from("hunt_submissions").update({ status: "pending", decided_at: null, decided_by: null }).eq("id", r.id);
      continue;
    }
    names ??= await imageGenerators(supabase);
    const generators = shown.generators.length ? shown.generators : names;
    const done = await publishImported(supabase, {
      publisherId: String(r.hunter_user_id), token: String(r.preview_token), title: shown.title, category: shown.category,
      aiModel: generators[0] ?? "", aiModels: generators, photoCount: shown.photos.length,
      // Its variables, those whose [slot] the prompt (perhaps edited by hand) still holds; one a find kept blank from
      // before slots took their own name (lib/hunter/variables) takes it now, as a release refuses an empty one.
      variables: slotVariables(shown.prompt, shown.hunt?.variables ?? []),
    });
    if (done.ok) {
      published += 1;
      // Its reach on X, kept with the prompt (SQL 58's source_reach; before it runs this write fails alone).
      if (shown.hunt?.reach) {
        const { error: reachError } = await supabase.from("prompts").update({ source_reach: shown.hunt.reach }).eq("id", done.promptId);
        if (reachError) console.warn("[admin] the find's reach was not recorded:", reachError.message);
      }
      continue;
    }
    failed.push({ id: String(r.id), error: done.error });
    await supabase.from("hunt_submissions").update({ status: "pending", decided_at: null, decided_by: null }).eq("id", r.id);
  }
  return { published, failed, refused };
}

/** What an admin action sends. */
export type AdminBody = {
  resource?: string; action?: string; id?: string; ids?: string[];
  reason?: string; address?: string; xId?: string; status?: string;
  userId?: string; severity?: number; days?: number; permanent?: boolean;
  maxConcurrentPerUser?: number | null;
  handle?: string; kind?: string; violation?: string; vote?: string;
  email?: string; enabled?: boolean; quorum?: number; ttlDays?: number;
  what?: string; signature?: string; note?: string;
  config?: Record<string, unknown>; handles?: unknown[];
  // A creator's mode and recipe (saveMode).
  mode?: unknown; recipe?: unknown;
  /** "Add link manually": a post on X (lib/hunter/manual-link). */
  url?: string;
  /** A find's fields set by hand (imports edit). */
  edit?: Record<string, unknown>;
  /** A creator's Play: its hunter_runs row, sent back with every next round (lib/hunter/creator-run). */
  runId?: string;
};

export async function POST(req: NextRequest) {
  const supabase = getSupabaseServerClient();
  const gate = await requireAdmin(supabase, req);
  if (gate instanceof NextResponse) return gate;

  let body: AdminBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  const res = await act(supabase, req, gate, body);
  // The admin log (Kev, 2026-10-17): every action that went through, and an
  // import batch that published in part (409), in one place for all actions.
  if (res.ok || (res.status === 409 && body.resource === "imports" && body.action === "approve")) {
    await recordAdminAction(supabase, req, gate, body as Record<string, unknown>, res);
  }
  return res;
}

/** Every admin action: one branch per resource and action. */
async function act(supabase: Supabase, req: NextRequest, gate: { userId: string; role: string }, body: AdminBody): Promise<NextResponse> {
  const { userId, role } = gate;
  const now = new Date().toISOString();
  const fail = (e: { message?: string } | null, what: string) =>
    NextResponse.json({ error: `Could not ${what}${e?.message ? ": " + e.message : ""}` }, { status: 500 });

  // ── pending imports ──
  if (body.resource === "imports") {
    const ids = Array.isArray(body.ids) ? body.ids : body.id ? [body.id] : [];
    // Naming may take every waiting find, none marked; every other action is about the finds it names.
    if (!ids.length && body.action !== "describe") return NextResponse.json({ error: "id required" }, { status: 400 });
    // The admin alone edits, approves and names finds: a find's publish is not checked again (Kev, 2026-11-01: "aktuell
    // mache ich das und kein mod"); a moderator may still reject one.
    if (role !== "admin" && body.action !== "reject") return NextResponse.json({ error: "Admins only" }, { status: 403 });
    if (body.action === "approve") {
      const { data: moved, error } = await supabase.from("hunt_submissions")
        .update({ status: "approved", decided_at: now, decided_by: userId })
        .in("id", ids).eq("status", "pending").select("id");
      if (error) return fail(error, "approve");
      // The hunter's finds are published here and now; a person's referral was published when it was made. Only the rows
      // this click moved from pending: a second click while the first still publishes found the row approved and not yet
      // minted, and published it again (live 2026-10-31: three "Black and white character" prompts, 4 s apart).
      const { published, failed, refused } = await publishApproved(supabase, (moved ?? []).map((r) => String(r.id)));
      if (failed.length || refused.length) {
        const why = [
          failed.length ? `${failed.length} could not be and stay in the queue: ${failed[0].error}` : "",
          refused.length ? `${refused.length} rejected: ${refused[0]}` : "",
        ].filter(Boolean).join("; ");
        return NextResponse.json({ error: `${published} published, ${why}` }, { status: 409 });
      }
      return NextResponse.json({ ok: true, published });
    }
    if (body.action === "edit" && body.id) {
      // A find's prompt, category, tags and generator, set by hand before approving (Kev, 2026-10-31: "i want these things
      // to be editable ... tags, category, prompt"): the sealed preview is sealed again with them, so the publish takes
      // them, and the publish checks the prompt once more as it checks every prompt.
      const e = (body.edit ?? {}) as { title?: unknown; prompt?: unknown; category?: unknown; tags?: unknown; generators?: unknown; adult?: unknown };
      const { data: row, error: rowError } = await supabase.from("hunt_submissions").select("preview_token, preview, status").eq("id", body.id).maybeSingle();
      if (rowError) return fail(rowError, "read the find");
      if (!row || row.status !== "pending") return NextResponse.json({ error: "No such find waiting." }, { status: 404 });
      const sealed = openPreview(row.preview_token);
      if (!sealed) return NextResponse.json({ error: "This find's check ran out: reject it and add its link again." }, { status: 409 });
      const prompt = typeof e.prompt === "string" ? e.prompt.trim() : sealed.prompt;
      if (prompt.length < 40 || prompt.length > 20_000) return NextResponse.json({ error: "A prompt is 40 to 20,000 characters." }, { status: 400 });
      const category = typeof e.category === "string" ? e.category : sealed.category;
      if (!(ENKI_CATEGORIES as readonly string[]).includes(category)) return NextResponse.json({ error: `Not a category: ${category}` }, { status: 400 });
      const tags = Array.isArray(e.tags)
        ? [...new Set(e.tags.filter((t): t is string => typeof t === "string").map((t) => t.trim().toLowerCase()).filter((t) => t && t.length <= 32))]
        : sealed.tags;
      const catalogue = Array.isArray(e.generators) ? await imageGenerators(supabase) : [];
      const generators = Array.isArray(e.generators) ? e.generators.filter((g): g is string => typeof g === "string" && catalogue.includes(g)) : sealed.generators;
      // The title too (Kev, 2026-10-31: "ich will title ja auch ändern").
      const title = typeof e.title === "string" ? e.title.trim() : sealed.title;
      if (!title || title.length > 80) return NextResponse.json({ error: "A title is 1 to 80 characters." }, { status: 400 });
      // 18+ by the admin's tick too (Kev, 2026-11-01: "ein checkmark ... für +18, dass ich einchecken oder auschecken kann").
      const adult = typeof e.adult === "boolean" ? e.adult : sealed.adult;
      const next = { ...sealed, title, prompt, category, tags, generators, adult };
      const { error } = await supabase.from("hunt_submissions").update({
        preview_token: sealPreview(next), preview: { ...(row.preview as Record<string, unknown>), title, prompt, category, tags, generators, adult },
        suggested_title: title, suggested_tags: tags, prompt_hash: promptHash(prompt),
      }).eq("id", body.id).eq("status", "pending");
      return error ? fail(error, "save the find") : NextResponse.json({ ok: true, preview: { prompt, category, tags, generators, adult } });
    }
    if (body.action === "describe") {
      // Title, shelf and tags of gpt-6-luna for the finds, in batches, on the admin's click (Kev, 2026-11-01: "after the
      // prompt is set up and i click \"generate title, category & tags\""): the marked ones, else every waiting one, each
      // sealed again with them; a find the model gave no answer for keeps what it had.
      const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === "string") : [];
      const read = supabase.from("hunt_submissions").select("id, preview_token, preview").eq("status", "pending");
      const { data: rows, error: rowsError } = ids.length ? await read.in("id", ids) : await read;
      if (rowsError) return fail(rowsError, "read the finds");
      const open = (rows ?? []).flatMap((r) => { const sealed = openPreview(r.preview_token); return sealed ? [{ r, sealed }] : []; });
      const said = await describeMany(open.map((x) => x.sealed.prompt));
      let described = 0;
      for (const [i, s] of said) {
        // The find as it is now: an 18+ tick or a prompt edit made while the model answered is kept (review 2026-11-01).
        const { data: now } = await supabase.from("hunt_submissions").select("preview_token, preview").eq("id", open[i].r.id).eq("status", "pending").maybeSingle();
        const sealed = now ? openPreview(now.preview_token) : null;
        if (!now || !sealed) continue;
        const tags = storedTags(extractTags(sealed.prompt, { body: true }), extractTags(s.tags.join("\n"), { body: true }), extractTags(s.title));
        const { error } = await supabase.from("hunt_submissions").update({
          preview_token: sealPreview({ ...sealed, title: s.title, category: s.category, tags }),
          preview: { ...(now.preview as Record<string, unknown>), title: s.title, category: s.category, tags },
          suggested_title: s.title, suggested_tags: tags,
        }).eq("id", open[i].r.id).eq("status", "pending");
        if (!error) described += 1;
      }
      return NextResponse.json({ ok: true, described, asked: open.length });
    }
    if (body.action === "reject") {
      // A rejected find is deleted (Kev, 2026-10-31: "after rejecting a prompt, that prompt must be deleted"): it leaves the
      // queue, its link can be added again, and the live table's rejection_reason CHECK is never met (it refused "Other").
      // The admin log keeps who rejected what, with the reason.
      // Its post forgets the find too, so a Play from the start reads it again (Kev, 2026-10-31). A find that came through
      // a chain keeps a "rejected" mark: its core is read at any next post that forwards it, with no Start over, and came back.
      const { data: gone, error } = await supabase.from("hunt_submissions").delete().in("id", ids).eq("status", "pending").select("id, preview");
      if (error) return fail(error, "reject");
      const chained = (r: { preview: unknown }) => ((r.preview as { hunt?: HuntFacts } | null)?.hunt?.reach?.chain.posts ?? 1) > 1;
      const idsOf = (rows: { id: unknown }[]) => rows.map((r) => String(r.id));
      const alone = idsOf((gone ?? []).filter((r) => !chained(r)));
      const through = idsOf((gone ?? []).filter(chained));
      if (alone.length) await supabase.from("hunter_posts").delete().in("submission_id", alone);
      if (through.length) await supabase.from("hunter_posts").update({ outcome: "rejected", submission_id: null }).in("submission_id", through);
      return NextResponse.json({ ok: true });
    }
  }

  // ── the prompt hunter ──
  if (body.resource === "hunter") {
    if (role !== "admin") return NextResponse.json({ error: "Admins only" }, { status: 403 });
    /** A link Enki knows already: refused, and a line in the hunter's log (GET hunterLog), so a .txt list can be read back line by line. */
    const knownLink = async (k: KnownLink, error: string) => {
      const res = NextResponse.json({ error, status: k.waiting ? "waiting" : "in_enki", handle: k.handle }, { status: 409 });
      await recordAdminAction(supabase, req, gate, { resource: "hunter", action: "knownLink", id: k.postId }, res);
      return res;
    };
    if (body.action === "save") {
      const c = body.config ?? {};
      const mode = c.mode === "publish" ? "publish" : c.mode === "queue" ? "queue" : null;
      const postsPerRun = int(c.postsPerRun, 0, 10_000);
      const minLikes = int(c.minLikes, 0, 1_000_000);
      const perAuthorDaily = int(c.perAuthorDaily, 0, 1_000);
      const dryAfter = int(c.dryAfter, 0, 1_000);
      if (!mode || postsPerRun === null || minLikes === null || perAuthorDaily === null || dryAfter === null) {
        return NextResponse.json({ error: "Bad request" }, { status: 400 });
      }
      let publisherId: string | null = null;
      const publisher = String(c.publisher ?? "").replace(/^@/, "").trim();
      if (publisher) {
        const { data: who } = await supabase.from("users").select("id").eq("handle", publisher).is("deleted_at", null).maybeSingle();
        if (!who) return NextResponse.json({ error: `No account @${publisher}` }, { status: 400 });
        publisherId = String(who.id);
      }
      const { error } = await supabase.from("hunter_config").update({
        mode, posts_per_run: postsPerRun, min_likes: minLikes, per_author_daily: perAuthorDaily, dry_after: dryAfter, publisher_user_id: publisherId, updated_at: now, updated_by: userId,
      }).eq("id", 1);
      return error ? fail(error, "save the hunter settings") : NextResponse.json({ ok: true });
    }
    if (body.action === "addAccounts") {
      // Dropped in as typed: with or without the @, in any case; one row each, the ones already listed untouched.
      const handles = [...new Set((Array.isArray(body.handles) ? body.handles : []).map((h) => String(h).replace(/^@/, "").trim().toLowerCase()).filter(Boolean))];
      if (!handles.length) return NextResponse.json({ error: "No account given" }, { status: 400 });
      const bad = handles.find((h) => !/^[a-z0-9_]{1,15}$/.test(h));
      if (bad) return NextResponse.json({ error: `Not an X handle: ${bad}` }, { status: 400 });
      // A creator added again keeps what its earlier Plays cost against its cap: its Plays (hunter_runs) outlive Remove.
      // Before SQL 56 hunter_runs has no handle, and nothing is counted.
      const { data: plays, error: playsError } = await supabase.from("hunter_runs").select("handle, est_usd").in("handle", handles);
      const spent = new Map<string, number>();
      for (const r of plays ?? []) spent.set(String(r.handle), (spent.get(String(r.handle)) ?? 0) + Number(r.est_usd ?? 0));
      const { error } = await supabase.from("hunter_accounts").upsert(
        handles.map((handle) => ({ handle, added_by: userId, ...(playsError ? {} : { spent_usd: Math.round((spent.get(handle) ?? 0) * 10_000) / 10_000 }) })),
        { onConflict: "handle", ignoreDuplicates: true },
      );
      return error ? fail(error, "add the accounts") : NextResponse.json({ ok: true, added: handles.length });
    }
    if (body.action === "restart" && body.handle) {
      const done = await restartCreator(supabase, body.handle);
      return done.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: done.error }, { status: done.status });
    }
    if (body.action === "removeAccount" && body.handle) {
      // Forgets the account and every post read from it (the table cascades); its Plays stay, and their cost counts again
      // when it is added back (addAccounts). Never while a Play holds it: that round's reads would be billed to no row.
      const handle = normalizeXHandle(body.handle);
      const { data: gone, error } = await supabase.from("hunter_accounts").delete().eq("handle", handle)
        .or(`playing_since.is.null,playing_since.lt.${new Date(Date.now() - LOCK_MS).toISOString()}`).select("handle");
      if (error) return fail(error, "remove the account");
      if (!gone?.length) {
        const { data: held } = await supabase.from("hunter_accounts").select("handle").eq("handle", handle).maybeSingle();
        if (held) return NextResponse.json({ error: `@${handle} is playing: stop its Play first.` }, { status: 409 });
      }
      return NextResponse.json({ ok: true });
    }
    if (body.action === "run") {
      // The list run is retired (Kev, 2026-10-30: "a schalte ab den listen-run"): it read every listed creator's whole
      // timeline, with no estimate, no spend cap and no hold, from a stale tab or a direct request. Creators are played.
      return NextResponse.json({ error: "The list run is retired: Play a creator in the Prompt Hunter tab." }, { status: 410 });
    }
    if (body.action === "saveCreator") {
      // A listed creator's settings saved (addAccounts adds one); a changed search starts its reading over (lib/hunter/creators).
      const saved = await saveCreator(supabase, { handle: body.handle, config: body.config, catalogue: await imageGenerators(supabase) });
      return saved.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: saved.error }, { status: saved.status });
    }
    if (body.action === "play") {
      // One round of a creator's Play: X's search and the model, within its posts and spend caps (lib/hunter/creator-run);
      // the panel sends the runId back and presses again only after stopped "time".
      const played = await playCreator(supabase, body.handle, body.runId, defaultCreatorDeps(supabase, req));
      if (played.status === 200) return NextResponse.json({ ok: true, summary: played.summary });
      return NextResponse.json({ error: played.error, ...("summary" in played ? { summary: played.summary } : {}) }, { status: played.status });
    }
    if (body.action === "queueLink") {
      // A link put in line under its creator, played later by "Play links" in the creator's mode (Kev, 2026-11-01).
      const queued = await queueLink(supabase, body.url, userId);
      if (queued.status === 200) return NextResponse.json({ ok: true, handle: queued.handle });
      return queued.known ? knownLink(queued.known, queued.error) : NextResponse.json({ error: queued.error }, { status: queued.status });
    }
    if (body.action === "saveMode") {
      // How a creator's finds are cut: auto, recipe or manual, and the recipe (lib/hunter/recipe; SQL 59).
      const saved = await saveMode(supabase, { handle: body.handle, mode: body.mode, recipe: body.recipe });
      return saved.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: saved.error }, { status: saved.status });
    }
    if (body.action === "addLink") {
      // One post by its link (Kev, 2026-10-31: "Add link manually"): read for free, its author listed, always queued.
      const added = await addLinkManually(supabase, body.url, userId, defaultCreatorDeps(supabase, req), undefined, body.handle);
      // A link that waited for it leaves the line once it is settled (lib/hunter/manual-link linkSettled).
      const waited = typeof body.url === "string" ? postIdOf(body.url) : null;
      if (waited && linkSettled(added)) await supabase.from("hunter_posts").delete().eq("post_id", waited).eq("outcome", "waiting");
      if (added.status === 200) return NextResponse.json({ ok: true, summary: added.summary, handle: added.handle, said: parkedSaid(added.summary.skipped) });
      return added.known ? knownLink(added.known, added.error) : NextResponse.json({ error: added.error }, { status: added.status });
    }
  }

  // ── a paused prompt's own words, for the admin who decides it (Kev, 2026-10-28, "5 yes"; DEC-476): admins only, only
  //    while it waits for a decision. The read is in the admin log; the words never are (lib/admin/audit keeps no text). ──
  if (body.resource === "prompts" && body.id && body.action === "text") {
    if (role !== "admin") return NextResponse.json({ error: "Admins only" }, { status: 403 });
    if (!(await isPaused(supabase, body.id))) return NextResponse.json({ error: "Only a paused prompt's text can be read here." }, { status: 404 });
    const text = await loadPromptText(supabase, body.id);
    return text.ok ? NextResponse.json({ text: text.text }) : NextResponse.json({ error: "The prompt's text could not be read." }, { status: 500 });
  }

  // ── a prompt deleted by an admin, as an exception (Kev, 2026-10-31: "bitte erstelle mir AUSNAHMSWEISE eine
  // möglichkeit, wie ich images löschen kann ... damit wir das nicht vollständig löschen können"): soft, deleted_at set
  // and unlisted, so every list leaves it out and nothing is gone for good; the admin log records who and when ──
  if (body.resource === "prompts" && body.id && body.action === "delete") {
    if (role !== "admin") return NextResponse.json({ error: "Admins only" }, { status: 403 });
    const { data, error } = await supabase.from("prompts").update({ deleted_at: now, is_listed: false }).eq("id", body.id).is("deleted_at", null).select("id");
    if (error) return fail(error, "delete the prompt");
    return data?.length ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "No such prompt, or it is deleted already." }, { status: 404 });
  }

  // ── prompts paused after a refused render (DEC-441): back on sale, or taken down for good ──
  if (body.resource === "prompts" && body.id && (body.action === "release" || body.action === "delist")) {
    const decided = await decidePause(supabase, body.id, body.action === "release" ? "released" : "delisted", userId);
    return decided.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: decided.error }, { status: decided.status });
  }

  // ── reports ──
  if (body.resource === "reports" && body.id) {
    if (body.action === "resolve" || body.action === "dismiss") {
      const { error } = await supabase.from("reports")
        .update({ status: body.action === "resolve" ? "actioned" : "dismissed", decided_by: userId, decided_at: now })
        .eq("id", body.id);
      return error ? fail(error, body.action) : NextResponse.json({ ok: true });
    }
    if (body.action === "strike" || body.action === "delist" || body.action === "hide") {
      const { data: rep } = await supabase.from("reports")
        .select("target_type, target_uuid, reason, status").eq("id", body.id).maybeSingle();
      if (!rep || rep.status !== "pending") {
        return NextResponse.json({ error: "Report not found or already decided" }, { status: 400 });
      }
      if (body.action === "delist") {
        if (rep.target_type !== "prompt") return NextResponse.json({ error: "Only prompt reports can be delisted" }, { status: 400 });
        const { error } = await supabase.from("prompts")
          .update({ is_listed: false, delisted_at: now }).eq("id", rep.target_uuid);
        if (error) return fail(error, "delist the prompt");
      } else if (body.action === "hide") {
        // Private: gone from every public read, still the owner's.
        if (rep.target_type !== "generation") return NextResponse.json({ error: "Only image reports can be hidden" }, { status: 400 });
        const { error } = await supabase.from("generated_images").update({ visibility: "private" }).eq("id", rep.target_uuid);
        if (error) return fail(error, "hide the image");
      } else {
        // strike goes to the reported user; for prompt reports that's the creator
        let targetUserId = String(rep.target_uuid);
        if (rep.target_type === "prompt") {
          const { data: p } = await supabase.from("prompts").select("creator_id").eq("id", rep.target_uuid).maybeSingle();
          if (!p) return NextResponse.json({ error: "Prompt no longer exists — dismiss the report instead" }, { status: 400 });
          targetUserId = String(p.creator_id);
        }
        if (rep.target_type === "generation") {
          const { data: g } = await supabase.from("generated_images").select("user_id").eq("id", rep.target_uuid).maybeSingle();
          if (!g) return NextResponse.json({ error: "Image no longer exists — dismiss the report instead" }, { status: 400 });
          targetUserId = String(g.user_id);
        }
        const severity = [1, 2, 3].includes(Number(body.severity)) ? Number(body.severity) : 1;
        const { error } = await supabase.from("strikes").insert({
          user_id: targetUserId, issued_by: userId, severity,
          reason: `Report: ${rep.reason}`,
          related_report_id: body.id, related_target_type: rep.target_type, related_target_uuid: rep.target_uuid,
        });
        if (error) return fail(error, "issue the strike");
      }
      const { error } = await supabase.from("reports")
        .update({ status: "actioned", decided_by: userId, decided_at: now })
        .eq("id", body.id).eq("status", "pending");
      return error ? fail(error, "close the report") : NextResponse.json({ ok: true });
    }
  }

  // ── feedback ($100 program): staff decide; a paid report stays as it is ──
  if (body.resource === "feedback" && body.action === "setStatus" && body.id) {
    const to = body.status ?? "";
    if (!Object.hasOwn(FEEDBACK_STATUS, to)) return NextResponse.json({ error: "Unknown status" }, { status: 400 });
    // Done promises the $100: an admin's word, given and taken back by admins alone.
    // A mod rejects an open report or reopens a rejected one.
    if (to === "done" && role !== "admin") return NextResponse.json({ error: "Only admins mark a report done" }, { status: 403 });
    const { data: cur } = await supabase.from("feedback_submissions").select("status, paid_at").eq("id", body.id).maybeSingle();
    if (!cur) return NextResponse.json({ error: "Feedback not found" }, { status: 404 });
    if (cur.status === FEEDBACK_STATUS.done && role !== "admin") return NextResponse.json({ error: "Only admins change a report marked done" }, { status: 403 });
    if (cur.paid_at) return NextResponse.json({ error: "This report is paid already" }, { status: 409 });
    const { error } = await supabase.from("feedback_submissions")
      .update({ status: FEEDBACK_STATUS[to as FeedbackDecision], reviewer_id: userId, reviewed_at: now })
      .eq("id", body.id).is("paid_at", null);
    return error ? fail(error, "decide the report") : NextResponse.json({ ok: true });
  }

  // The $100 moves by hand from Kev's wallet; this records it (Kev, 2026-10-08).
  // Admins only: a mod decides on reports, never on money.
  if (body.resource === "feedback" && body.action === "markPaid" && body.id) {
    if (role !== "admin") return NextResponse.json({ error: "Only admins record a payout" }, { status: 403 });
    const signature = String(body.signature ?? "").trim();
    if (!isTxSignature(signature)) return NextResponse.json({ error: "Paste the payment's Solana transaction signature" }, { status: 400 });
    const { data: cur } = await supabase.from("feedback_submissions").select("status, paid_at").eq("id", body.id).maybeSingle();
    if (!cur) return NextResponse.json({ error: "Feedback not found" }, { status: 404 });
    if (cur.paid_at) return NextResponse.json({ error: "This report is paid already" }, { status: 409 });
    if (cur.status === FEEDBACK_STATUS.rejected) return NextResponse.json({ error: "This report was rejected: reopen it before paying" }, { status: 409 });
    // One transfer pays one report: the same signature on another report is a paste gone wrong.
    const { data: twice } = await supabase.from("feedback_submissions").select("id").eq("payout_tx_hash", signature).neq("id", body.id).limit(1);
    if (twice?.length) return NextResponse.json({ error: "That transaction is recorded for another report already" }, { status: 409 });
    const { error } = await supabase.from("feedback_submissions").update({
      status: FEEDBACK_STATUS.done, paid_at: now, payout_tx_hash: signature, payout_chain_key: PAYOUT_CHAIN,
      reviewer_id: userId, reviewed_at: now,
    }).eq("id", body.id).is("paid_at", null);
    return error ? fail(error, "record the payout") : NextResponse.json({ ok: true });
  }

  // ── private-beta access (Kev, 2026-10-07): approve or reject a request,
  // invite an email (account + mailed one-time password), a wallet or an X id. Admins only. ──
  if (body.resource === "access") {
    if (role !== "admin") return NextResponse.json({ error: "Only admins grant access" }, { status: 403 });
    try {
      if (body.action === "approve" && body.id) return NextResponse.json(await approveRequest(supabase, body.id));
      if (body.action === "reject" && body.id) return NextResponse.json(await rejectRequest(supabase, body.id));
      if (body.action === "inviteEmail" && body.email) return NextResponse.json(await inviteEmail(supabase, body.email));
      if (body.action === "inviteWallet" && body.address) return NextResponse.json(await inviteWallet(supabase, body.address));
      if (body.action === "inviteX" && body.xId) return NextResponse.json(await inviteX(supabase, body.xId));
    } catch (e) {
      if (e instanceof AccessError) return NextResponse.json({ error: e.message }, { status: e.status });
      throw e;
    }
  }

  // ── moderation events: review from the person list (Kev, 2026-10-03) ──
  // Overturning takes a warning or hit out of every count; the event itself
  // stays, append-only. A child-safety case is an admin's call, never a mod's.
  if (body.resource === "automod" && body.id && (body.action === "overturn" || body.action === "uphold")) {
    const { data: ev } = await supabase.from("automod_events")
      .select("category, matched_rules, prompt_hash").eq("id", body.id).eq("decision", "block").maybeSingle();
    if (!ev) return NextResponse.json({ error: "Event not found" }, { status: 404 });
    if (CHILD_SAFETY.includes(String(ev.category)) && role !== "admin") {
      return NextResponse.json({ error: "Only an admin can review a child-safety case" }, { status: 403 });
    }
    const notes = body.reason?.slice(0, 500) ?? null;
    // An image case's overturn is the owner's clearance of its image, which writes the case's review with it in one
    // transaction; an uphold takes a clearance back (lib/moderation/image-clearance).
    const image = !isImageCase(ev) ? null
      : body.action === "overturn" ? await clearImageCase(supabase, body.id, ev, userId, notes) : await takeBackClearance(supabase, ev, userId);
    if (image && "error" in image) return NextResponse.json({ error: image.error }, { status: image.status });
    if (!image || body.action === "uphold") {
      const { error } = await supabase.from("automod_events").update({
        review_state: body.action === "overturn" ? "overturned" : "upheld",
        reviewed_by: userId, reviewed_at: now, review_notes: notes,
      }).eq("id", body.id);
      if (error) return fail(error, "review the event");
    }
    return NextResponse.json({ ok: true, ...image?.answer });
  }

  // An artist's withheld words, for the moderation owner alone, one record
  // of the warning and ban list at a time (Kev, 2026-10-03: only the most
  // important admins, in hard cases, and only there). The reason is logged
  // before anything shows: no log, no text.
  if (body.resource === "automod" && body.action === "reveal" && body.id) {
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (reason.length < 10 || reason.length > 500) {
      return NextResponse.json({ error: "Say why, in 10 to 500 characters." }, { status: 400 });
    }
    const { data: policy } = await supabase.from("moderation_policy").select("owner_user_id").eq("id", 1).maybeSingle();
    if (role !== "admin" || !policy?.owner_user_id || String(policy.owner_user_id) !== userId) {
      return NextResponse.json({ error: "Only the moderation owner can reveal an artist's text." }, { status: 403 });
    }
    const { data: ev } = await supabase.from("automod_events")
      .select("id, surface, category, scores, ban_id, matched_rules, evidence_ct, evidence_iv, evidence_tag, evidence_kid").eq("id", body.id).maybeSingle();
    if (!ev) return NextResponse.json({ error: "Event not found" }, { status: 404 });
    if (!inWarningOrBanList(ev)) {
      return NextResponse.json({ error: "Only a warning, an extraction hit, a child-safety case or a record behind a ban can be opened." }, { status: 403 });
    }
    // One thing per reveal, the one asked for: the text (the record's own
    // copy, or else the named prompt's text as it stands now), or the image a
    // child-safety image case keeps, encrypted (lib/moderation/image-case).
    const what = body.what === "image" ? "image" : "text";
    const part = withheldEvidence(ev);
    const fromPrompt = what === "text" && part.text === null && part.promptId !== null;
    const loaded = fromPrompt ? await loadPromptText(supabase, String(part.promptId)) : null;
    // A text that could not be read right now (a database error, an outage, a key) is not a prompt without text
    // (round 11, 2026-10-20: a failed variables read the reveal never uses answered "no artist text").
    if (loaded && !loaded.ok && loaded.status !== 422) {
      return NextResponse.json({ error: "The prompt's text could not be read right now. Try again." }, { status: 503 });
    }
    const text = what === "image" ? null : fromPrompt ? (loaded?.ok ? loaded.text : null) : part.text;
    const image = what === "image" && Array.isArray(ev.matched_rules) && ev.matched_rules.includes("image-check")
      ? await readImageEvidence(supabase, String(ev.id))
      : null;
    if (text === null && image === null) return NextResponse.json({ error: `This record holds no ${what === "image" ? "image" : "artist text"} that can be read.` }, { status: 404 });
    // prompt_id names the prompt whose text was shown, and only that: an
    // image case's reveal without one was a reveal of its image.
    const { error } = await supabase.from("artist_text_reveals").insert({ event_id: ev.id, prompt_id: fromPrompt ? part.promptId : null, revealed_by: userId, reason });
    if (error) return NextResponse.json({ error: "The reveal could not be logged, so nothing is shown." }, { status: 503 });
    const { data: me } = await supabase.from("users").select("handle").eq("id", userId).maybeSingle();
    await notifyAdmins(supabase, {
      exceptUserId: userId,
      subject: `[Enki Admin] Withheld moderation ${what} was revealed`,
      text: [
        `@${(me?.handle as string) ?? "the moderation owner"} revealed the withheld ${what} of moderation record ${ev.id}${part.promptId ? ` (prompt ${part.promptId})` : ""}.`,
        "",
        `Reason: ${reason}`,
      ].join("\n"),
    }).catch(() => {});
    return NextResponse.json({ text, source: fromPrompt ? "prompt" : "record", image });
  }

  // ── strikes ──

  // Generation throttle — ADMIN ONLY. A mod moderates content; slowing the
  // whole product down for every user is not a moderation decision, and the
  // client-side hiding of this control is cosmetic. This is the real wall.
  if (body.resource === "generation" && body.action === "setConcurrency") {
    if (role !== "admin") {
      return NextResponse.json({ error: "Admins only" }, { status: 403 });
    }
    const raw = body.maxConcurrentPerUser;
    // null is unlimited and must stay expressible — it is the default, and a
    // huge number would look like a limit while behaving like none.
    const value = raw === null || raw === undefined ? null : Number(raw);
    if (value !== null && (!Number.isInteger(value) || value < 1 || value > 100)) {
      return NextResponse.json({ error: "Use a whole number from 1 to 100, or leave it empty for unlimited" }, { status: 400 });
    }
    const { error } = await supabase
      .from("generation_policy")
      .upsert({ id: 1, max_concurrent_per_user: value, updated_at: now, updated_by: userId });
    return error ? fail(error, "save the generation limit") : NextResponse.json({ ok: true, maxConcurrentPerUser: value });
  }

  if (body.resource === "strikes" && body.action === "revoke" && body.id) {
    const { error } = await supabase.from("strikes")
      .update({ revoked_at: now, revoked_by: userId, revoke_reason: "Revoked from the admin panel" })
      .eq("id", body.id).is("revoked_at", null);
    return error ? fail(error, "revoke the strike") : NextResponse.json({ ok: true });
  }

  // ── bans (scope 'full' is the only live-allowed value) ──
  if (body.resource === "bans" && (body.userId || body.handle)) {
    let targetId = body.userId ?? null;
    if (!targetId) {
      const { data } = await supabase.from("users")
        .select("id").eq("handle", String(body.handle).replace(/^@/, "").trim()).maybeSingle();
      if (!data) return NextResponse.json({ error: "User not found" }, { status: 400 });
      targetId = String(data.id);
    }
    if (body.action === "ban") {
      // council mode routes every ban through a proposal instead
      const { data: pol } = await supabase.from("moderation_policy")
        .select("council_enabled").eq("id", 1).maybeSingle();
      if (pol?.council_enabled === true) {
        return NextResponse.json({ error: "Council mode is on — propose the ban in the Council tab instead" }, { status: 409 });
      }
      const permanent = body.permanent === true;
      const days = Number.isInteger(body.days) && body.days! >= 1 && body.days! <= 365 ? body.days! : null;
      if (!permanent && !days) return NextResponse.json({ error: "days (1–365) or permanent required" }, { status: 400 });
      const until = permanent ? null : new Date(Date.now() + days! * 86400_000).toISOString();
      // Its own row beside any running ban, so each keeps its reason and
      // appeal; refused when this same ban already runs as long.
      const issued = await banUntil(supabase, {
        userId: targetId, issuedBy: userId, reason: (body.reason ?? "Banned from the admin panel").slice(0, 200), expiresAt: until,
      }).catch(() => null);
      if (!issued) return fail(null, "ban the user");
      if (!issued.issued) {
        return NextResponse.json({ error: issued.until ? `Already banned until ${issued.until.slice(0, 10)}` : "Already banned for good" }, { status: 400 });
      }
      return NextResponse.json({ ok: true });
    }
    if (body.action === "lift") {
      // A ban that follows a child-safety case is an admin's to lift, like the case itself.
      if (role !== "admin" && (await hasChildSafetyCase(supabase, targetId))) {
        return NextResponse.json({ error: "Only an admin can lift a ban after a child-safety case" }, { status: 403 });
      }
      const { error } = await supabase.from("bans")
        .update({ lifted_at: now, lifted_by: userId, lifted_reason: "Reinstated from the admin panel" })
        .eq("user_id", targetId).is("lifted_at", null);
      return error ? fail(error, "reinstate the user") : NextResponse.json({ ok: true });
    }
  }

  // ── appeals ──
  if (body.resource === "appeals" && body.id && (body.action === "approve" || body.action === "deny")) {
    const { data: ap } = await supabase.from("appeals")
      .select("target_type, target_uuid, status").eq("id", body.id).maybeSingle();
    if (!ap || ap.status !== "pending") {
      return NextResponse.json({ error: "Appeal not found or already decided" }, { status: 400 });
    }
    const approve = body.action === "approve";
    if (approve && ap.target_type !== "strike" && role !== "admin") {
      const { data: ban, error: banErr } = await supabase.from("bans").select("user_id").eq("id", ap.target_uuid).maybeSingle();
      if (banErr) return fail(banErr, "check the appealed ban");
      if (ban && (await hasChildSafetyCase(supabase, String(ban.user_id)))) {
        return NextResponse.json({ error: "Only an admin can lift a ban after a child-safety case" }, { status: 403 });
      }
    }
    const { error } = await supabase.from("appeals")
      .update({ status: approve ? "approved" : "denied", decided_by: userId, decided_at: now })
      .eq("id", body.id).eq("status", "pending");
    if (error) return fail(error, "decide the appeal");
    if (approve) {
      // approving undoes the appealed strike/ban
      const { error: undo } = ap.target_type === "strike"
        ? await supabase.from("strikes")
            .update({ revoked_at: now, revoked_by: userId, revoke_reason: "Appeal approved" })
            .eq("id", ap.target_uuid).is("revoked_at", null)
        : await supabase.from("bans")
            .update({ lifted_at: now, lifted_by: userId, lifted_reason: "Appeal approved" })
            .eq("id", ap.target_uuid).is("lifted_at", null);
      if (undo) return fail(undo, `undo the appealed ${ap.target_type}`);
    }
    return NextResponse.json({ ok: true });
  }

  // ── my admin prefs: council notification email ──
  if (body.resource === "prefs" && body.action === "setEmail") {
    const email = (body.email ?? "").trim().toLowerCase();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      return NextResponse.json({ error: "That doesn't look like an email address" }, { status: 400 });
    }
    if (!email) {
      const { error } = await supabase.from("admin_prefs").delete().eq("user_id", userId);
      return error ? fail(error, "clear the email") : NextResponse.json({ ok: true });
    }
    const enc = encryptString(email, userId);
    const { error } = await supabase.from("admin_prefs").upsert({
      user_id: userId, notify_email_ct: enc.encrypted, notify_email_iv: enc.iv,
      notify_email_tag: enc.authTag, notify_email_kid: enc.kid ?? null, updated_at: now,
    }, { onConflict: "user_id" });
    return error ? fail(error, "save the email") : NextResponse.json({ ok: true });
  }

  // ── moderation policy (owner only) ──
  if (body.resource === "policy" && body.action === "set") {
    const { data: pol } = await supabase.from("moderation_policy").select("owner_user_id").eq("id", 1).maybeSingle();
    if (!pol) return NextResponse.json({ error: "Council isn't set up yet — run the moderation-council migration first" }, { status: 400 });
    if (String(pol.owner_user_id) !== userId) return NextResponse.json({ error: "Owner only" }, { status: 403 });
    const quorum = Number(body.quorum), ttl = Number(body.ttlDays);
    if (!Number.isInteger(quorum) || quorum < 1 || quorum > 20) return NextResponse.json({ error: "Quorum must be 1–20" }, { status: 400 });
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > 30) return NextResponse.json({ error: "Expiry must be 1–30 days" }, { status: 400 });
    const { error } = await supabase.from("moderation_policy")
      .update({ council_enabled: body.enabled === true, quorum, proposal_ttl_days: ttl, updated_at: now })
      .eq("id", 1);
    return error ? fail(error, "save the policy") : NextResponse.json({ ok: true });
  }

  // ── trial codes (Kev, 2026-10-26; lib/trial.ts): the owner's alone ──
  if (body.resource === "trial") {
    const { data: pol } = await supabase.from("moderation_policy").select("owner_user_id").eq("id", 1).maybeSingle();
    if (!pol?.owner_user_id || String(pol.owner_user_id) !== userId) return NextResponse.json({ error: "Owner only" }, { status: 403 });
    if (body.action === "create") {
      // The settings go in config, which the admin log keeps; the note is free text beside it, which the log
      // never keeps (lib/admin/audit.ts keeps every scalar of config, and only whitelisted keys of the body).
      const c = body.config ?? {};
      // Unlimited must be said with null: a count left out is a bad request, not a code for everyone.
      const maxUses = int(c.maxUses, 1, 100_000);
      if (c.maxUses !== null && maxUses === null) return NextResponse.json({ error: "Uses: a whole number from 1 to 100,000, or unlimited" }, { status: 400 });
      const accessMinutes = int(c.accessMinutes, 5, 43_200);
      if (accessMinutes === null) return NextResponse.json({ error: "Minutes of access: a whole number from 5 to 43,200 (30 days)" }, { status: 400 });
      const budgetUsd = typeof c.budgetUsd === "number" && c.budgetUsd >= 0 && c.budgetUsd <= 1000 && Math.abs(c.budgetUsd * 100 - Math.round(c.budgetUsd * 100)) < 1e-6 ? c.budgetUsd : null;
      if (budgetUsd === null) return NextResponse.json({ error: "Budget per tester: $0 to $1,000, in whole cents" }, { status: 400 });
      const expiresMs = c.expiresAt === null ? null : typeof c.expiresAt === "string" ? Date.parse(c.expiresAt) : NaN;
      if (expiresMs !== null && !(expiresMs > Date.now())) return NextResponse.json({ error: "The expiry must be a date in the future" }, { status: 400 });
      const code = newTrialCode();
      const codeHash = hashTrialCode(code);
      if (!codeHash) return NextResponse.json({ error: "Trial codes need AUTH_PEPPER" }, { status: 503 });
      const { data: row, error } = await supabase.from("trial_codes").insert({
        code_hash: codeHash, note: typeof body.note === "string" ? body.note.trim().slice(0, 120) : "", // NOT NULL: no note is the empty one
        max_uses: maxUses, access_minutes: accessMinutes, expires_at: expiresMs === null ? null : new Date(expiresMs).toISOString(),
        budget_micro: Math.round(budgetUsd * 1e6), created_by: userId,
      }).select("id").single();
      if (error || !row) return fail(error, "create the code");
      // The code itself, this once: the table keeps only its hash, and the admin log neither (its OUTCOME has no "code").
      return NextResponse.json({ ok: true, code, id: String(row.id) });
    }
    if (body.action === "revoke" && body.id) {
      if (!UUID_RE.test(body.id)) return NextResponse.json({ error: "Bad code id" }, { status: 400 });
      const { data: found } = await supabase.from("trial_codes").select("id").eq("id", body.id).maybeSingle();
      if (!found) return NextResponse.json({ error: "Code not found" }, { status: 404 });
      const { error } = await supabase.from("trial_codes").update({ revoked_at: now }).eq("id", body.id).is("revoked_at", null);
      if (error) return fail(error, "revoke the code");
      // Its running trials end now, and their testers are signed out; one who is on the access list as well
      // (beta, mod, admin) keeps the session, which the list gave them and not the code.
      const { data: ended, error: endErr } = await supabase.from("trial_redemptions").update({ ends_at: now }).eq("code_id", body.id).gt("ends_at", now).select("user_id");
      if (endErr) return fail(endErr, "end the code's trials");
      const testers = [...new Set((ended ?? []).map((r) => String(r.user_id)))];
      for (let i = 0; i < testers.length; i += IN_CHUNK) {
        const chunk = testers.slice(i, i + IN_CHUNK);
        const { data: members, error: roleErr } = await supabase.from("users").select("id, role").in("id", chunk);
        if (roleErr) return fail(roleErr, "read the testers' roles");
        const keep = new Set((members ?? []).filter((u) => ["beta", "mod", "admin"].includes(String(u.role))).map((u) => String(u.id)));
        const out = chunk.filter((t) => !keep.has(t));
        if (!out.length) continue;
        // Sessions key on the user id until a wallet is attached and on the wallet address after: both go, as a
        // password reset evicts them (lib/password-reset.ts; review 2026-10-26).
        const { data: wallets, error: walletErr } = await supabase.from("user_wallets").select("address").in("user_id", out).is("removed_at", null);
        if (walletErr) return fail(walletErr, "read the testers' wallets");
        const { error: outErr } = await supabase.from("auth_sessions").delete().in("wallet_address", [...out, ...(wallets ?? []).map((w) => String(w.address))]);
        if (outErr) return fail(outErr, "sign the testers out");
      }
      return NextResponse.json({ ok: true });
    }
  }

  // ── council proposals ──
  if (body.resource === "council" && body.action === "propose") {
    const kind = String(body.kind ?? "");
    if (!["ban_temp", "ban_perm", "ip_ban"].includes(kind)) return NextResponse.json({ error: "Unknown action kind" }, { status: 400 });
    const violation = (body.violation ?? "").trim().slice(0, 300);
    if (!violation) return NextResponse.json({ error: "Name the violation — the council votes on it" }, { status: 400 });
    const { data: pol } = await supabase.from("moderation_policy")
      .select("council_enabled, quorum, proposal_ttl_days").eq("id", 1).maybeSingle();
    if (!pol) return NextResponse.json({ error: "Council isn't set up yet — run the moderation-council migration first" }, { status: 400 });

    let target: { id: string; handle: string } | null = null;
    const lookup = body.userId
      ? supabase.from("users").select("id, handle").eq("id", body.userId).maybeSingle()
      : supabase.from("users").select("id, handle").eq("handle", String(body.handle ?? "").replace(/^@/, "").trim()).maybeSingle();
    const { data: u } = await lookup;
    if (u) target = { id: String(u.id), handle: (u.handle as string) ?? "unnamed" };
    if (!target) return NextResponse.json({ error: "User not found" }, { status: 400 });

    let ipHash: string | null = null;
    if (kind === "ip_ban") {
      ipHash = await lastKnownIpHash(supabase, target.id);
      if (!ipHash) return NextResponse.json({ error: "No login IP on record for this user yet" }, { status: 400 });
    }
    const days = kind === "ban_temp"
      ? (Number.isInteger(body.days) && body.days! >= 1 && body.days! <= 365 ? body.days! : 7)
      : null;
    // council off → quorum 1: the proposer's own confirm executes immediately
    const quorum = pol.council_enabled === true ? Number(pol.quorum) : 1;
    const { data: prop, error } = await supabase.from("mod_proposals").insert({
      kind, target_user_id: target.id, target_ip_hash: ipHash, days, violation,
      proposed_by: userId, quorum,
      expires_at: new Date(Date.now() + Number(pol.proposal_ttl_days) * 86400_000).toISOString(),
    }).select("*").single();
    if (error || !prop) return fail(error, "create the proposal");
    await supabase.from("mod_proposal_votes").insert({ proposal_id: prop.id, voter_user_id: userId, vote: "confirm" });
    if (quorum <= 1) {
      const execErr = await executeProposal(supabase, prop as ProposalRow, now);
      return execErr ? fail(execErr, "execute the action") : NextResponse.json({ ok: true, executed: true });
    }
    await notifyCouncil(supabase, userId, { kind, days, violation, targetHandle: target.handle, quorum });
    return NextResponse.json({ ok: true, executed: false });
  }

  if (body.resource === "council" && body.action === "vote" && body.id) {
    const vote = body.vote === "confirm" ? "confirm" : body.vote === "deny" ? "deny" : null;
    if (!vote) return NextResponse.json({ error: "vote must be confirm or deny" }, { status: 400 });
    const { data: prop } = await supabase.from("mod_proposals").select("*").eq("id", body.id).maybeSingle();
    if (!prop || prop.status !== "pending") return NextResponse.json({ error: "Proposal not found or already decided" }, { status: 400 });
    if (new Date(String(prop.expires_at)).getTime() < Date.now()) {
      await supabase.from("mod_proposals").update({ status: "expired", decided_at: now }).eq("id", body.id);
      return NextResponse.json({ error: "Proposal expired" }, { status: 400 });
    }
    const { error: vErr } = await supabase.from("mod_proposal_votes").upsert({
      proposal_id: body.id, voter_user_id: userId, vote, voted_at: now,
    }, { onConflict: "proposal_id,voter_user_id" });
    if (vErr) return fail(vErr, "record the vote");
    const [{ data: votes }, { count: memberCount }] = await Promise.all([
      supabase.from("mod_proposal_votes").select("vote").eq("proposal_id", body.id),
      supabase.from("users").select("id", { count: "exact", head: true }).in("role", ["admin", "mod"]).is("deleted_at", null),
    ]);
    const confirms = (votes ?? []).filter((v) => v.vote === "confirm").length;
    const denies = (votes ?? []).length - confirms;
    const quorum = Number(prop.quorum);
    if (confirms >= quorum) {
      const execErr = await executeProposal(supabase, prop as ProposalRow, now);
      return execErr ? fail(execErr, "execute the approved action") : NextResponse.json({ ok: true, status: "approved", confirms, denies });
    }
    // denied once quorum is mathematically out of reach
    if (denies >= Math.max(1, (memberCount ?? 0) - quorum + 1)) {
      const { error } = await supabase.from("mod_proposals").update({ status: "denied", decided_at: now }).eq("id", body.id);
      return error ? fail(error, "deny the proposal") : NextResponse.json({ ok: true, status: "denied", confirms, denies });
    }
    return NextResponse.json({ ok: true, status: "pending", confirms, denies });
  }

  // ── recovery requests ──
  if (body.resource === "recovery" && body.action === "setStatus" && body.id) {
    const status = body.status ?? "";
    if (!["pending", "needs_info", "approved", "rejected"].includes(status)) {
      return NextResponse.json({ error: "Unknown status" }, { status: 400 });
    }
    const patch: Record<string, unknown> = { status };
    if (status === "approved" || status === "rejected") { patch.decided_by = userId; patch.decided_at = now; }
    if (status === "rejected") patch.rejection_reason = (body.reason ?? "Rejected from the admin panel").slice(0, 200);
    const { error } = await supabase.from("recovery_requests").update(patch).eq("id", body.id);
    return error ? fail(error, "update the request") : NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Bad request" }, { status: 400 });
}
