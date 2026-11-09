"use client";

/* Admin panel — the "Enki Admin" design on REAL moderation data.
   Gate: BetaGate role (admin/mod) client-side for the UI states; every API
   call re-checks the role server-side (app/api/admin — the actual wall).
   The content area follows the app theme (--enki-* vars); the sidebar is the
   deliberately inverted warm-dark "admin mode" identity in every theme. */

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/enki-shell/icons";
/* The page below is styled with `.ek-app` + --enki-* — but this route never
   pulled in the stylesheet that defines them (only /home imports it, via
   EnkiHome). The tokens then fell back to the stale globals.css copy, which
   has no `.dark.theme-purple` block at all: the panel stayed neutral black
   with an orange accent while the rest of the app went violet. */
import "@/components/enki-shell/enki-shell.css";
import { useBetaAccess } from "@/components/BetaGate";
import { useTheme } from "../../providers/ThemeProvider";
import { sessionAuthHeaders } from "@/lib/session-headers";
import { REPORT_REASONS } from "@/lib/report-reasons";
import Seal from "@/components/kit/Seal";
import { type FeedbackDecision } from "@/lib/feedback";
import { pauseSummary } from "@/lib/moderation/prompt-pause";
import MergeQueue from "@/components/communities/MergeQueue";
import ParkedPosts from "@/components/admin/ParkedPosts";
import { CREATOR_DEFAULTS, HUNT_PRICES, outcomeWords, parkedSaid, type CreatorConfig, type CreatorMedia, type CreatorRow, type CreatorRunSummary, type HuntFacts, type PlayStop } from "@/lib/hunter/creator-types";
import { estimatePlay, parseCreatorConfig, searchChanged, searchQuery } from "@/lib/hunter/creator-config";
import { RECIPE_DEFAULT, type HuntMode, type Recipe } from "@/lib/hunter/recipe";
import { ENKI_CATEGORIES } from "@/lib/categories";

/* ── data shapes (from /api/admin) ── */
// hunt: where a creator Play found the prompt and which generator it offers (lib/hunter/creator-types HuntFacts).
type ImpPreview = { prompt: string; title: string; category: string; tags: string[]; adult: boolean; generators: string[]; photos: string[]; source: { url: string; handle: string }; hunt?: HuntFacts | null };
// preview: what the Prompt Hunter judged, shown in the row; a person's referral is published already and has none.
type Imp = { id: string; name: string; url: string | null; hunter: string; tags: string[]; at: string; preview: ImpPreview | null };
type HunterConfig = { mode: "queue" | "publish"; postsPerRun: number; minLikes: number; perAuthorDaily: number; dryAfter: number; publisher: string | null };
// creatorsReady false (or absent) until SQL 56 ran; creators and the image catalogue come with it (lib/hunter/creators).
// The API's legacy accounts and runs are not read here any more.
type HunterPanel = { ready: boolean; canEdit: boolean; config: HunterConfig | null; creatorsReady?: boolean; creators?: CreatorRow[]; catalogue?: string[]; modesReady?: boolean };
type Rep = { id: string; target: string; type: "prompt" | "image" | "profile"; href: string | null; reason: string; details: string | null; reporter: string; severity: string | null; at: string };
type Fb = { id: string; name: string; email: string | null; desc: string; images: number; paid: boolean; payoutCents: number | null; at: string; state: FeedbackDecision; wallet: string | null; txUrl: string | null };
type FbFile = { url: string | null; mime: string };
type Hunter = { handle: string; total: number; approved: number; denied: number; earningsCents: number };
type StrikeRow = { userId: string; handle: string; strikes: { id: string; reason: string | null }[]; banned: boolean; permanent: boolean; note: string | null; appeal: { id: string; note: string | null; against: { reason: string | null; until: string | null } | null } | null };
type Rec = { id: string; handle: string; wallet: string | null; contact: string | null; explanation: string | null; evidence: { kind: string; matched: boolean | null }[]; status: string; at: string };
type Proposal = { id: string; kind: string; target: string; targetUserId: string | null; days: number | null; violation: string; proposer: string; status: string; confirms: number; denies: number; myVote: string | null; quorum: number; at: string; expiresAt: string };
type Council = { ready: boolean; isOwner: boolean; enabled: boolean; quorum: number; ttlDays: number; members: { handle: string; role: string; hasEmail: boolean }[]; myEmail: string | null; proposals: Proposal[] };
type Automod = { id: string; handle: string | null; surface: string; severity: string; tier: number | null; category: string | null; rules: string[]; topScore: { name: string; value: number } | null; prompt: string | null; withheld: boolean; draft: boolean; state: string; at: string };
type GenPolicy = { maxConcurrentPerUser: number | null; canEdit: boolean };
type Person = { key: string; userId: string | null; ipHash: string | null; handle: string | null; displayName: string | null; warnings: number; extractionHits: number; childSafety: boolean; pending: number; suspension: { until: string | null } | null; failed7d: number; lastActive: string | null };
type PersonDetail = {
  events: { id: string; category: string | null; severity: string; surface: string; rules: string[]; weight: number; confidence: number | null; prompt: string | null; withheld: boolean; draft: boolean; revealable: boolean; state: string; imageCase: boolean; cleared: boolean; at: string }[];
  failures: { id: string; surface: string; model: string | null; resolution: string | null; quality: string | null; boost: boolean; aspectRatio: string | null; referenceImageCount: number; error: string; prompt: string | null; draft: boolean; imageUrl: string | null; txSignature: string | null; at: string }[];
  bans: { id: string; reason: string | null; expiresAt: string | null; liftedAt: string | null; at: string }[];
};
type AccessRequest = { id: string; email: string; about: string; socials: string | null; created_at: string };
type Allowed = { id: string; kind: string; value: string; note: string | null; created_at: string };
// Who may enter: admins only (null for a mod).
type Access = { requests: AccessRequest[]; allowlist: Allowed[] } | null;
type TrialCode = {
  id: string; note: string | null; maxUses: number | null; uses: number; accessMinutes: number; expiresAt: string | null; budgetMicro: number; createdAt: string; revokedAt: string | null;
  testers: { userId: string; handle: string | null; email: string | null; startedAt: string; endsAt: string; spentMicro: number }[];
};
/** Trial codes (Kev, 2026-10-26): the owner's alone (null for everyone else); ready false until their SQL ran. */
type Trials = { ready: boolean; codes: TrialCode[] };
/** A prompt off sale after a render was refused for its own text (DEC-441), with its open refusals. */
type Paused = { promptId: string; title: string; artist: string; refusals: { cause: "moderation" | "provider"; detail: string; at: string }[] };
/** Pending imports per page, as the server hands them (GET /api/admin?importsFrom). */
const IMPORTS_PAGE = 50;
type AdminData = { generation: GenPolicy; imports: Imp[]; importsTotal: number; importsMissed?: number; reports: Rep[]; feedback: Fb[]; hunters: Hunter[]; strikes: StrikeRow[]; recovery: Rec[]; council: Council; automod: Automod[]; people: Person[]; access: Access; hunter: HunterPanel; adminLog: AdminLog | null; trials: Trials | null; paused: Paused[] };
/** The admin log (admins only); ready false until its migration ran. */
type AdminLog = { ready: boolean; rows: { id: string; at: string; action: string; target: string | null; actor: string; role: string; detail: Record<string, unknown> }[] };
const COUNCIL_OFF: Council = { ready: false, isOwner: false, enabled: false, quorum: 3, ttlDays: 7, members: [], myEmail: null, proposals: [] };
const HUNTER_OFF: HunterPanel = { ready: false, canEdit: false, config: null };
const HUNTER_DEFAULTS: HunterConfig = { mode: "queue", postsPerRun: 500, minLikes: 20, perAuthorDaily: 0, dryAfter: 30, publisher: null };
/* A creator Play's find in the queue row: where its prompt sat, and why these generators. */
const HUNT_FROM: Record<HuntFacts["from"], string> = { text: "post text", alt: "image alt", reply: "reply" };
const GEN_FROM: Record<HuntFacts["generatorFrom"], string> = { post: "named in the post", preferred: "creator's preferred", all: "every generator" };

/* ── the creator hunter (Kev, 2026-10-30: "da will ich iwann einen creator reinpacken, such kriterien einstellen, und go") ── */
const CR_SINCE = [{ days: 30, label: "30 days" }, { days: 90, label: "90 days" }, { days: 365, label: "1 year" }, { days: 730, label: "2 years" }, { days: 0, label: "All of X's archive" }];
const CR_MEDIA: { id: CreatorMedia; label: string }[] = [
  { id: "images", label: "Images only" }, { id: "media", label: "Images or videos (videos saved for later)" }, { id: "any", label: "Everything" },
];
/** Why a Play ended, as its row and the toast say it ("time" never ends one: the panel presses again). */
const CR_STOPPED: Record<PlayStop, string> = {
  done: "nothing left to read", time: "time, pressed again", posts_cap: "posts per Play reached", spend_cap: "spend cap reached",
  dry: "too many posts in a row without a prompt", on_enki: "on Enki, not hunted", error: "error",
};
/** Estimated dollars, to the cent. */
const usd2 = (x: number) => "$" + x.toFixed(2);
/** Videos are saved in the Videos tab and not imported until video prompts exist (Kev's step 3). */
const videosSaved = (n: number) => `${n} ${n === 1 ? "video" : "videos"} saved`;
/** The search fields typed as a comma list: one word or phrase each. */
const wordsOf = (text: string) => text.split(",").map((w) => w.trim()).filter(Boolean);
/** A creator's settings as the form holds them: the words as typed. */
type CreatorForm = CreatorConfig & { wordsText: string };
const formOf = (c: CreatorConfig): CreatorForm => ({ ...c, wordsText: c.words.join(", ") });
/* Sized by the space the tab has, as TRIAL_CSS: a creator's row is three columns (who, where it stands, buttons), one
   below 760 px; the settings three columns, two, then one. */
const CR_CSS = `
  .crh{container-type:inline-size;container-name:crh}
  .crh-item{padding:10px 0;border-bottom:1px dashed var(--enki-rule-2,var(--enki-rule))}
  .crh-item:last-child{border-bottom:none}
  .crh-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.3fr) auto;gap:8px 14px;align-items:center}
  .crh-who{display:flex;align-items:center;gap:9px;min-width:0}
  .crh-meta{display:flex;flex-direction:column;gap:2px;min-width:0;font-family:var(--font-mono),monospace;font-size:10.5px;overflow-wrap:anywhere}
  .crh-acts{display:flex;flex-wrap:wrap;gap:5px;justify-content:flex-end}
  .crh-ask{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;margin-top:8px;padding:10px 12px;border:1px solid var(--enki-ember);border-radius:11px;background:rgba(var(--ember-rgb),0.08);font-size:11.5px;line-height:1.5;color:var(--enki-ink);overflow-wrap:anywhere}
  .crh-panel{margin-top:8px;padding:12px;border:1px solid var(--enki-rule-2,var(--enki-rule));border-radius:11px;background:var(--enki-paper-2)}
  .crh-form{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px 12px}
  .crh-wide{grid-column:1/-1}
  .crh-run{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;padding:6px 0;border-bottom:1px dashed var(--enki-rule-2,var(--enki-rule))}
  @container crh (max-width: 760px){
    .crh-row{grid-template-columns:minmax(0,1fr)}
    .crh-acts{justify-content:flex-start}
    .crh-form{grid-template-columns:repeat(2,minmax(0,1fr))}
  }
  @container crh (max-width: 420px){
    .crh-form{grid-template-columns:minmax(0,1fr)}
    .crh-panel,.crh-ask{margin-left:-8px;margin-right:-8px;padding:10px 8px}
  }
`;

/** A link as a moderator should read it before clicking: its whole host, then the start of its path. */
function linkLabel(url: string): string {
  try {
    const u = new URL(url);
    const rest = u.pathname + u.search;
    return u.hostname + (rest.length > 24 ? rest.slice(0, 24) + "…" : rest);
  } catch {
    return url.slice(0, 40);
  }
}

type Tab = "people" | "access" | "trials" | "imports" | "videos" | "nomedia" | "hunter" | "reports" | "feedback" | "hunters" | "strikes" | "automod" | "adminlog" | "council" | "recovery" | "communities" | "settings";
const REJECT_REASONS = ["Duplicate", "Low quality", "Not a prompt", "Spam", "Policy violation", "Other"];

/* ── the admin sidebar's own palette: inverted warm dark, theme-independent ── */
const SB = {
  bg: "#1a1715", ink: "#f0ece3", muted: "#8a8377", nav: "#b9b2a4", navOn: "#faf8f4",
  ember: "#c96838", emberText: "#f0b799", emberHover: "#ffd9c2",
};
const MONO = "var(--font-mono), monospace";
/* An artist's words never show in this panel (Kev, 2026-10-03); a record that holds or names them says so. */
const WITHHELD_NOTE = "An artist's prompt text belongs to this record and is not shown.";
const DRAFT_NOTE = "The requester marked this as their own editor draft, so its text is not shown.";
const SERIF = "var(--font-serif), Georgia, serif";
/* status pill palettes (literal pastels, same family as the rest of the app) */
const PILL = {
  green: { bg: "#E8F8EE", ink: "#1F5C38", border: "#9AD4B0" },
  red: { bg: "#FDE8E8", ink: "#8B2E2E", border: "#E8A0A0" },
  amber: { bg: "#FDF6E8", ink: "#6E4A1E", border: "#E8C89A" },
  purple: { bg: "#F3E8FD", ink: "#4A2E6E", border: "#C4A0E8" },
  blue: { bg: "#E8F4FD", ink: "#1E4A6E", border: "#9CCAE8" },
};
/* A report's decision: open to decide, done (the $100 follows) or rejected. */
const FB_STATE = { open: { label: "Open", pal: PILL.amber }, done: { label: "Done", pal: PILL.blue }, rejected: { label: "Rejected", pal: PILL.red } } as const;
const THEME_OPTS = [
  { id: "light" as const, name: "Bright", sw: "linear-gradient(135deg,#faf8f4,#e8e2d6)" },
  { id: "dark" as const, name: "Dark", sw: "linear-gradient(135deg,#0a1825,#16303f)" },
  { id: "purple" as const, name: "Purple", sw: "linear-gradient(135deg,#1a1228,#6d28d9)" },
];

const timeAgo = (iso: string) => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};
const dollars = (cents: number) => "$" + Math.round(cents / 100).toLocaleString("en-US");

/* ── trial codes (Kev, 2026-10-26) ── */
/** The create form as typed; "custom" opens a number field for the minutes or the budget. */
type TrialForm = { note: string; uses: string; unlimited: boolean; minutes: string; customMinutes: string; expires: boolean; expiry: string; budget: string; customBudget: string };
const TRIAL_FORM: TrialForm = { note: "", uses: "10", unlimited: false, minutes: "60", customMinutes: "", expires: false, expiry: "", budget: "1", customBudget: "" };
const TRIAL_MINUTES = [15, 30, 60, 120, 240, 1440];
const TRIAL_BUDGETS = ["0.50", "1", "2", "5", "10"];
const minutesLabel = (m: number) => (m % 1440 === 0 ? `${m / 1440} d` : m % 60 === 0 ? `${m / 60} h` : `${m} min`);
/** Budgets and spend are counted in micro-USDC: 1 USD = 1,000,000. */
const usd = (micro: number) => "$" + (micro / 1e6).toFixed(2);
const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
/** What a code can still do: revoked and expired end it for everyone; used up takes no new tester. */
function trialStatus(t: TrialCode, now = Date.now()): "active" | "revoked" | "expired" | "used up" {
  if (t.revokedAt) return "revoked";
  if (t.expiresAt && Date.parse(t.expiresAt) <= now) return "expired";
  return t.maxUses !== null && t.uses >= t.maxUses ? "used up" : "active";
}
const TRIAL_PAL = { active: PILL.green, revoked: PILL.red, expired: PILL.amber, "used up": PILL.blue };
/** A tester's trial ends at its own end or the code's expiry, whichever comes first. */
const trialEnd = (t: TrialCode, x: TrialCode["testers"][number]) => Math.min(Date.parse(x.endsAt), t.expiresAt ? Date.parse(t.expiresAt) : Infinity);
const trialOver = (endMs: number) => endMs <= Date.now();
const runningTrials = (t: TrialCode) => t.testers.filter((x) => !trialOver(trialEnd(t, x))).length;
/* Sized by the space the tab has, not the window: the admin sidebar takes 208 px of it. Below 640 px the form is
   one column and each code a card (its cells labelled from data-label); below 360 px each label sits above its value. */
const TRIAL_CSS = `
  .trl{container-type:inline-size;container-name:trl}
  .trl-form{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px 12px}
  .trl-wide{grid-column:1/-1}
  .trl-table{width:100%;border-collapse:collapse}
  .trl-table th{text-align:left;font-family:var(--font-mono),monospace;font-size:8.5px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:var(--enki-ink-3);padding:10px 8px 7px;border-bottom:1px solid var(--enki-rule-2,var(--enki-rule))}
  .trl-table td{padding:9px 8px;font-size:11.5px;color:var(--enki-ink-2);vertical-align:top;overflow-wrap:anywhere}
  .trl-table tbody{border-bottom:1px dashed var(--enki-rule-2,var(--enki-rule))}
  .trl-table tr.trl-testers td{padding-top:0}
  @container trl (max-width: 640px){
    .trl-form{grid-template-columns:minmax(0,1fr)}
    .trl-table thead{display:none}
    .trl-table,.trl-table tbody,.trl-table tr,.trl-table td{display:block;width:100%;box-sizing:border-box}
    .trl-table tbody{border:1px solid var(--enki-rule-2,var(--enki-rule));border-radius:11px;padding:6px 12px;margin:10px 0}
    .trl-table td{display:flex;justify-content:space-between;gap:10px;padding:4px 0;text-align:right}
    .trl-table td::before{content:attr(data-label);flex-shrink:0;text-align:left;font-family:var(--font-mono),monospace;font-size:8.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--enki-ink-3);padding-top:2px}
    .trl-table tr.trl-testers td{display:block;text-align:left;padding-top:6px}
  }
  @container trl (max-width: 360px){
    .trl-table td{display:block;text-align:left}
    .trl-table td::before{display:block}
  }
`;

const microLabel: React.CSSProperties = { fontFamily: MONO, fontSize: 7.5, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--enki-ink-3)" };
const cardStyle: React.CSSProperties = { border: "1px solid var(--enki-rule-2, var(--enki-rule))", borderRadius: 13, background: "var(--enki-paper)", padding: "4px 14px 6px" };
/** X's picture at its original size: pbs.twimg.com serves it with name=orig. */
const origOf = (src: string): string => (src.includes("pbs.twimg.com/") ? `${src.split("?")[0]}?name=orig` : src);
/** A field edited right in an import row (category, generator, tags). */
const impField: React.CSSProperties = { fontFamily: MONO, fontSize: 9, height: 20, border: "1px solid var(--enki-rule)", borderRadius: 5, background: "var(--enki-paper)", color: "var(--enki-ink-2)", padding: "0 4px" };
const rowStyle: React.CSSProperties = { display: "flex", alignItems: "center", gap: 10, padding: "9px 0", borderBottom: "1px dashed var(--enki-rule-2, var(--enki-rule))" };
const huInput: React.CSSProperties = { height: 30, border: "1px solid var(--enki-rule)", borderRadius: 8, background: "var(--enki-paper-2)", color: "var(--enki-ink)", fontSize: 11.5, padding: "0 9px", width: "100%", boxSizing: "border-box" };
const huLabel: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: "var(--enki-ink-3)" };

function Pill({ kind, label, onClick, title }: { kind: keyof typeof PILL | "plain"; label: string; onClick?: () => void; title?: string }) {
  const c = kind === "plain"
    ? { bg: "var(--enki-paper-2)", ink: "var(--enki-ink-2)", border: "var(--enki-rule-2)" }
    : PILL[kind];
  return (
    <button onClick={onClick} title={title} style={{
      padding: "4px 11px", borderRadius: 999, fontSize: 10, fontWeight: 600, whiteSpace: "nowrap",
      background: c.bg, color: c.ink, border: `1px solid ${c.border}`, cursor: onClick ? "pointer" : "default",
    }}>
      {label}
    </button>
  );
}
function Badge({ pal, label }: { pal: { bg: string; ink: string }; label: string }) {
  return (
    <span style={{ fontFamily: MONO, fontSize: 8.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", borderRadius: 4, padding: "2px 7px", background: pal.bg, color: pal.ink, whiteSpace: "nowrap" }}>
      {label}
    </span>
  );
}

const TABS: { id: Tab; label: string; icon: string; sub: string; search: boolean }[] = [
  { id: "people", label: "People", icon: "user", sub: "Everyone who was warned, blocked, suspended or whose generations failed this week. Click a row for every event with its prompt and settings.", search: true },
  { id: "access", label: "Access", icon: "userPlus", sub: "Requests to join the beta, and who may enter. Approving or inviting an email creates the account and mails a one-time password; a wallet goes on the list. Rejecting removes a request and mails nothing.", search: false },
  { id: "trials", label: "Trials", icon: "key", sub: "Codes that let someone try Enki on their own account: for how many people, how long, until when, and how much each may spend on renders. Owner only.", search: false },
  { id: "imports", label: "Pending imports", icon: "inbox", sub: "Hunt submissions waiting for review before they hit the marketplace.", search: true },
  { id: "videos", label: "Videos", icon: "film", sub: "Posts with a video the Prompt Hunter saved until video prompts can be imported, the ones with a find too. Only addresses are kept: a post deleted on X can take its video with it.", search: true },
  { id: "nomedia", label: "No media", icon: "image", sub: "Posts whose words may hold a prompt, with no picture or video, or none that could be read. They never reach Pending imports.", search: true },
  { id: "hunter", label: "Prompt Hunter", icon: "search", sub: "Creators on X, each with its own search, preferred generator, Play and spend cap. Their finds land in Pending imports as prompts of the creator's own Enki account.", search: false },
  { id: "reports", label: "Reports", icon: "flag", sub: "User-flagged prompts and profiles, grouped by target.", search: false },
  { id: "feedback", label: "Feedback", icon: "message", sub: "Submissions from the “Earn $100 for feedback” program. Click a row to read it all.", search: true },
  { id: "hunters", label: "Hunter trust", icon: "target", sub: "Importers ranked by how often their finds get approved.", search: false },
  { id: "strikes", label: "Strikes & bans", icon: "zap", sub: "Users with active strikes, bans, and open appeals.", search: false },
  { id: "automod", label: "Auto-filter log", icon: "filetext", sub: "Every prompt the filter blocked, with the reason and the score. Review and overturn them per person in People.", search: true },
  { id: "adminlog", label: "Admin log", icon: "filetext", sub: "Every admin and mod action: who, what, on what, when. Nothing here can be changed or deleted.", search: false },
  { id: "council", label: "Council", icon: "hand", sub: "Ban decisions the admin council votes on — quorum executes automatically.", search: false },
  { id: "recovery", label: "Recovery requests", icon: "lifebuoy", sub: "People who lost every sign-in method. Click a row to check their evidence.", search: true },
  // The merge queue (Kev, 2026-10-30: "ich hab kb, dass es aber auch duplikate gibt wie gundam 1, gundam 2"); admins only.
  { id: "communities", label: "Communities", icon: "users", sub: "Communities that may be the same one, by their core word. Merge one into another (its works, prompts, posts and members move; its old c/ handle sends people to the other) or keep them apart.", search: false },
  { id: "settings", label: "Admin settings", icon: "settings", sub: "Your notification email — and, for the owner, the council policy.", search: false },
];

export default function AdminPage() {
  const router = useRouter();
  const { access, role, handle, profile } = useBetaAccess();
  const { theme, setTheme } = useTheme();
  const isAdmin = role === "admin" || role === "mod";

  const [data, setData] = useState<AdminData | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [tab, setTab] = useState<Tab>("imports");
  const [query, setQuery] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  // A paused prompt's words, read on an admin's tap (DEC-476), by prompt id; a second tap hides them again.
  const [pausedText, setPausedText] = useState<Record<string, string>>({});
  const toastT = useRef<number | null>(null);
  const say = (m: string) => {
    setToast(m);
    if (toastT.current) window.clearTimeout(toastT.current);
    // Long enough to read: a refusal's sentence ran about 25 words.
    toastT.current = window.setTimeout(() => setToast(null), Math.max(2600, m.length * 60));
  };

  // per-tab interaction state
  const [impSel, setImpSel] = useState<Set<string>>(new Set());
  const [impRejectId, setImpRejectId] = useState<string | null>(null);
  const [impOpen, setImpOpen] = useState<string | null>(null);
  // An open find's fields as edited, and its post's own words when asked for (Kev, 2026-10-31: "show full post text").
  const [impEdit, setImpEdit] = useState<{ id: string; prompt: string; category: string; tags: string; generators: string[] } | null>(null);
  const [impPost, setImpPost] = useState<{ id: string; text: string } | null>(null);
  // A find's picture shown large, a second click back to its thumbnail (Kev, 2026-10-31).
  const [impZoom, setImpZoom] = useState<string | null>(null);
  useEffect(() => {
    if (!impZoom) return;
    const close = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setImpZoom(null); } };
    window.addEventListener("keydown", close, true);
    return () => window.removeEventListener("keydown", close, true);
  }, [impZoom]);
  const openImp = (r: Imp) => {
    if (impOpen === r.id) { setImpOpen(null); return; }
    setImpOpen(r.id);
    setImpPost(null);
    if (r.preview) setImpEdit({ id: r.id, prompt: impUnsaved.current.get(r.id) ?? r.preview.prompt, category: r.preview.category, tags: r.preview.tags.join(", "), generators: r.preview.generators });
  };
  /**
   * Manual mode's whole text in place of its cut, on screen and saved. A save that failed or was refused puts the cut back:
   * no button and no blur would ever save it again, and Approve would publish what the screen no longer shows.
   */
  const takeWhole = (r: Imp, raw: string) => {
    setImpEdit((cur) => (cur?.id === r.id ? { ...cur, prompt: raw } : cur));
    void saveImpFields(r, { prompt: raw })?.then((ok) => {
      if (ok || !r.preview) return;
      impUnsaved.current.delete(r.id);
      const cut = r.preview.prompt;
      setImpEdit((cur) => (cur?.id === r.id && cur.prompt === raw ? { ...cur, prompt: cut } : cur));
      setData((cur) => (cur ? { ...cur, imports: cur.imports.map((x) => (x.id === r.id && x.preview ? { ...x, preview: { ...x.preview, prompt: cut } } : x)) } : cur));
    });
  };
  /** The post's text, and the author's reply when the prompt came from it, read from FxTwitter (free). */
  const showPostText = async (r: Imp) => {
    if (impPost?.id === r.id) { setImpPost(null); return; }
    // Manual mode kept it with the find: no read, and a post deleted since still shows.
    if (r.preview?.hunt?.raw) { setImpPost({ id: r.id, text: r.preview.hunt.rawWords ?? r.preview.hunt.raw }); return; }
    const ids = [r.url, r.preview?.hunt?.replyUrl].map((u) => u?.match(/status\/(\d+)/)?.[1]).filter((x): x is string => !!x);
    const texts = await Promise.all(ids.map((id) => fetch(`https://api.fxtwitter.com/status/${id}`).then((res) => res.json()).then((j: { tweet?: { text?: string } }) => j.tweet?.text ?? "").catch(() => "")));
    setImpPost({ id: r.id, text: texts.filter(Boolean).join("\n\n— reply —\n\n") || "The post could not be read right now." });
  };
  /**
   * A find's changed fields saved at once, the rest as they are (imports edit seals the preview again), on screen at once.
   * Only what changed, one save after the other (real keys in Edge, DEC-2026-11-02-19): the next field's save sent the row
   * as it was drawn, the prompt from before the answer in it, and a row opened again before that answer saved it back.
   * A prompt that did not save goes back in the row, as the server holds it, and its words wait in impUnsaved: a blur sends
   * them again, a read cannot take them, and Approve refuses until they are saved or put back (review of DEC-2026-11-03-50).
   */
  const saveImpFields = (r: Imp, patch: { title?: string; prompt?: string; category?: string; tags?: string[]; generators?: string[]; adult?: boolean }) => {
    if (!r.preview) return;
    const held = r.preview.prompt;
    const tags = patch.tags?.map((t) => t.trim().toLowerCase()).filter(Boolean);
    const edit = tags ? { ...patch, tags } : patch;
    const show = (cur: AdminData): AdminData => ({ ...cur, imports: cur.imports.map((x) => {
      if (x.id !== r.id || !x.preview) return x;
      const title = patch.title?.trim() ?? x.name;
      return { ...x, name: title, tags: tags ?? x.tags, preview: { ...x.preview, ...edit, title, prompt: patch.prompt?.trim() ?? x.preview.prompt } };
    }) });
    dataEpoch.current += 1;
    setData((cur) => (cur ? show(cur) : cur));
    const saved = impSaves.current.then(() => post({ resource: "imports", action: "edit", id: r.id, edit }, "Saved.", show)).then((ok) => {
      if (patch.prompt !== undefined && ok) impUnsaved.current.delete(r.id);
      if (patch.prompt !== undefined && !ok) {
        impUnsaved.current.set(r.id, patch.prompt);
        setData((cur) => (cur ? { ...cur, imports: cur.imports.map((x) => (x.id === r.id && x.preview ? { ...x, preview: { ...x.preview, prompt: held } } : x)) } : cur));
      }
      if (!ok) void reload();
      return ok;
    });
    impSaves.current = saved;
    return saved;
  };
  /**
   * Approve after the saves on their way: clicking it from the prompt field blurs the field, whose save raced the publish,
   * which took the old prompt while the edit, no longer pending, changed nothing and still said "Saved." (review 2026-11-02).
   * Refused while the prompt field differs from the row: the save that failed may be the one this very click's blur sent,
   * so it is asked after the saves. Nothing is lost: the field keeps the words (DEC-2026-11-03-59).
   */
  const approveFinds = (payload: { id?: string; ids?: string[] }, okMsg: string, apply: (d: AdminData) => AdminData) => {
    const ids = payload.ids ?? [payload.id ?? ""];
    const open = impOpen ? data?.imports.find((x) => x.id === impOpen) : null;
    if (open?.preview && impEdit?.id === open.id && impEdit.prompt.trim() !== open.preview.prompt) impUnsaved.current.set(open.id, impEdit.prompt);
    return impSaves.current.then(() => {
      const stuck = ids.find((id) => impUnsaved.current.has(id));
      if (!stuck) return post({ resource: "imports", action: "approve", ...payload }, okMsg, apply);
      say(`Nothing was published: the prompt typed for “${data?.imports.find((x) => x.id === stuck)?.name ?? "this find"}” is not saved, so click into its field and out again to save it first.`);
      return null;
    });
  };
  const [impReason, setImpReason] = useState(REJECT_REASONS[0]);
  const [fbOpen, setFbOpen] = useState<string | null>(null);
  const [fbFiles, setFbFiles] = useState<Record<string, FbFile[]>>({});
  const [fbPayId, setFbPayId] = useState<string | null>(null);
  const [fbSig, setFbSig] = useState("");
  // One record at a time: a double click must not post twice and end on a false error.
  const [fbPaying, setFbPaying] = useState(false);
  const [invEmail, setInvEmail] = useState("");
  const [invWallet, setInvWallet] = useState("");
  const [invX, setInvX] = useState("");
  const [granting, setGranting] = useState(false);
  const [appealOpen, setAppealOpen] = useState<string | null>(null);
  const [repStrikeId, setRepStrikeId] = useState<string | null>(null);
  const [amOpen, setAmOpen] = useState<string | null>(null);
  const [pplOpen, setPplOpen] = useState<string | null>(null);
  const [pplDetail, setPplDetail] = useState<Record<string, PersonDetail>>({});
  const [revealed, setRevealed] = useState<Record<string, { text: string | null; source: string; image: string | null }>>({});
  // Empty string IS unlimited here, mirroring the null in the database.
  const [genLimit, setGenLimit] = useState<string>("");
  const [repSev, setRepSev] = useState("1");
  const [cpHandle, setCpHandle] = useState(""); const [cpKind, setCpKind] = useState("ban_temp:7");
  const [cpViolation, setCpViolation] = useState("");
  const [seEmail, setSeEmail] = useState("");
  const [polEnabled, setPolEnabled] = useState(false);
  const [polQuorum, setPolQuorum] = useState("3"); const [polTtl, setPolTtl] = useState("7");
  const [recOpen, setRecOpen] = useState<string | null>(null);
  const [kebabOpen, setKebabOpen] = useState(false);
  // The hunter's switches as the admin left them, else as the server holds them (no mirroring effect).
  const [huForm, setHuForm] = useState<HunterConfig | null>(null);
  // The creator hunter: the handle being added, the creator whose settings are open (and its form), whose results are
  // open, whose Play waits for its confirm, the one playing (one at a time) and its live line.
  const [crNew, setCrNew] = useState("");
  const [crLink, setCrLink] = useState("");
  // The hunter's log (GET ?hunterLog), and what it is searched by: a link or a username.
  const [huLog, setHuLog] = useState<{ post_id: string; handle: string; outcome: string; read_at: string }[] | null>(null);
  const [huLogQ, setHuLogQ] = useState("");
  // The line of links "Add link manually" adds in turn (drainLinks): with the other hooks, above every early return.
  const linkQueue = useRef<string[]>([]);
  const draining = useRef(false);
  const [crListing, setCrListing] = useState<string | null>(null);
  const listInput = useRef<HTMLInputElement>(null);
  // Approve's work in flight (Kev, 2026-10-31: "wenn ich auf approve clicke, so soll mir iwas zeigen, dass das
  // aufgenommen wurde"): the rows being published, and the prompt link or id to delete.
  const [impBusy, setImpBusy] = useState<Set<string>>(new Set());
  const [delPrompt, setDelPrompt] = useState("");
  const [crEdit, setCrEdit] = useState<string | null>(null);
  const [crForm, setCrForm] = useState<CreatorForm>(formOf(CREATOR_DEFAULTS));
  // The open creator's mode and recipe (lib/hunter/recipe), saved with its settings (Kev, 2026-11-01).
  const [crMode, setCrMode] = useState<{ mode: HuntMode; recipe: Recipe }>({ mode: "auto", recipe: RECIPE_DEFAULT });
  // Only the finds the recipe did not cut (Kev, 2026-11-01: "show as well those wo das nicht ganz geklappt hat").
  const [impMissed, setImpMissed] = useState(false);
  const setCr = (patch: Partial<CreatorForm>) => setCrForm((cur) => ({ ...cur, ...patch }));
  const [crOpen, setCrOpen] = useState<string | null>(null);
  const [crAsk, setCrAsk] = useState<string | null>(null);
  const [crAskAll, setCrAskAll] = useState(false);
  const [crPlaying, setCrPlaying] = useState<string | null>(null);
  const [crLive, setCrLive] = useState<{ handle: string; text: string } | null>(null);
  // The foot bar's line from the running Play's checkpoints, every 3 s while it plays (Kev, 2026-10-31).
  const [crNow, setCrNow] = useState<string | null>(null);
  useEffect(() => {
    // No Play, no bar (it shows only while crPlaying): the next Play's first tick replaces the old line at once.
    if (!crPlaying) return;
    const handle = crPlaying;
    const started = Date.now();
    const tick = async () => {
      const res = await fetch(`/api/admin?hunterLive=${encodeURIComponent(handle)}`, { headers: sessionAuthHeaders() }).catch(() => null);
      const body = (await res?.json().catch(() => null)) as { live?: { usage?: Partial<Record<string, number>>; est_usd?: number } | null } | null;
      const u = body?.live?.usage ?? {};
      const secs = Math.round((Date.now() - started) / 1000);
      setCrNow(`@${handle} · ${secs}s · ${u.posts ?? 0} posts read · ${u.replies ?? 0} replies · ${u.distills ?? 0} cut by model · ${u.checks ?? 0} checked · ${u.photos ?? 0} pictures · $${Number(body?.live?.est_usd ?? 0).toFixed(4)}`);
    };
    void tick();
    const t = window.setInterval(() => void tick(), 3000);
    return () => window.clearInterval(t);
  }, [crPlaying]);
  const crStop = useRef(false);
  // "Show its finds": Pending imports narrowed to one creator's X handle exactly (a search would also match @art in
  // @artbyhex and in titles); typing a search or changing tabs lets it go.
  const [crFinds, setCrFinds] = useState<string | null>(null);
  const [tr, setTrForm] = useState<TrialForm>(TRIAL_FORM);
  const setTr = (patch: Partial<TrialForm>) => setTrForm((cur) => ({ ...cur, ...patch }));
  // The new code lives only here: the server keeps its hash, so it is shown this once and gone on a reload.
  const [trCode, setTrCode] = useState<string | null>(null);
  const [trBusy, setTrBusy] = useState(false);
  const kebabRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!kebabOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (kebabRef.current && !kebabRef.current.contains(e.target as Node)) setKebabOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [kebabOpen]);

  useEffect(() => {
    if (access !== "ok" || !isAdmin) return;
    let dead = false;
    (async () => {
      try {
        const res = await fetch("/api/admin", { headers: sessionAuthHeaders() });
        if (!res.ok) throw new Error();
        const d = (await res.json()) as AdminData;
        if (!dead) setData(d);
      } catch {
        if (!dead) setLoadFailed(true);
      }
    })();
    return () => { dead = true; };
  }, [access, isAdmin]);

  // Pending imports come 50 at a time, the next 50 as the list nears its end (Kev, 2026-10-31: "unlimited scroll feature
  // that always loads the next 50 images the moment i almost reach the lower side of the frame"); a reload keeps as many.
  const impShown = useRef(IMPORTS_PAGE);
  // Counts the saves: a read that was on its way during one holds what stood before it, and is not shown.
  const dataEpoch = useRef(0);
  // A find's saves on their way: an Approve clicked straight from its prompt field waits for them.
  const impSaves = useRef<Promise<unknown>>(Promise.resolve());
  // A prompt typed for a find whose save failed, by find: the server does not hold it, and opening the find again shows it.
  const impUnsaved = useRef(new Map<string, string>());
  const impLoading = useRef(false);
  const impEnd = useRef<HTMLDivElement>(null);
  const loadMoreImports = async () => {
    const have = data?.imports.length ?? 0;
    if (impLoading.current || !data || have >= data.importsTotal) return;
    impLoading.current = true;
    try {
      const res = await fetch(`/api/admin?importsFrom=${have}`, { headers: sessionAuthHeaders() });
      const page = res.ok ? ((await res.json()) as { imports: Imp[]; importsTotal: number }) : null;
      if (page) setData((cur) => {
        if (!cur) return cur;
        const known = new Set(cur.imports.map((r) => r.id));
        const imports = [...cur.imports, ...page.imports.filter((r) => !known.has(r.id))];
        impShown.current = Math.max(IMPORTS_PAGE, imports.length);
        return { ...cur, imports, importsTotal: page.importsTotal };
      });
    } catch { /* the next scroll asks again */ } finally { impLoading.current = false; }
  };
  useEffect(() => {
    const el = impEnd.current;
    if (!el) return;
    const io = new IntersectionObserver((seen) => { if (seen[0]?.isIntersecting) void loadMoreImports(); }, { rootMargin: "0px 0px 800px 0px" });
    io.observe(el);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a new page or tab re-arms it, with the fresh list
  }, [tab, data?.imports.length, data?.importsTotal]);

  /** The fresh view, also returned (null when it could not be read: the current view stays). */
  const reload = async (): Promise<AdminData | null> => {
    const asked = dataEpoch.current;
    try {
      const res = await fetch(`/api/admin?imports=${impShown.current}`, { headers: sessionAuthHeaders() });
      if (!res.ok) return null;
      const next = (await res.json()) as AdminData;
      // Its answer came late for a save made meanwhile, which sprang back on screen (Kev, 2026-11-01: "kann ich diese
      // brackets da nicht löschen"; a line of links reloads after every link).
      if (asked === dataEpoch.current) setData(next);
      return next;
    } catch { return null; }
  };

  // council settings mirror the freshest server state
  useEffect(() => {
    const c = data?.council;
    if (!c) return;
    setSeEmail(c.myEmail ?? "");
    setPolEnabled(c.enabled);
    setPolQuorum(String(c.quorum));
    setPolTtl(String(c.ttlDays));
  }, [data?.council]);

  // null (unlimited) becomes an empty field, which is what the input means.
  useEffect(() => {
    const g = data?.generation;
    if (!g) return;
    setGenLimit(g.maxConcurrentPerUser === null ? "" : String(g.maxConcurrentPerUser));
  }, [data?.generation]);

  /* A report's attachments are signed each time its row opens: the links
     expire within minutes, so none outlives the look. */
  const openFeedback = async (r: Fb) => {
    if (fbOpen === r.id) { setFbOpen(null); return; }
    setFbOpen(r.id);
    if (!r.images) return;
    try {
      const res = await fetch(`/api/admin?feedback=${encodeURIComponent(r.id)}`, { headers: sessionAuthHeaders() });
      if (res.ok) {
        const { files } = (await res.json()) as { files: FbFile[] };
        setFbFiles((cur) => ({ ...cur, [r.id]: files }));
      }
    } catch { /* the text still shows */ }
  };

  /** The server's answer when the action went through (a new trial code is in it), else null. */
  const post = async (payload: Record<string, unknown>, okMsg: string, apply: (d: AdminData) => AdminData): Promise<Record<string, unknown> | null> => {
    try {
      const res = await fetch("/api/admin", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...sessionAuthHeaders() },
        body: JSON.stringify(payload),
      });
      const d = (await res.json().catch(() => ({}))) as { error?: string } & Record<string, unknown>;
      if (!res.ok) { say(d.error || "That didn't work."); return null; }
      dataEpoch.current += 1;
      setData((cur) => (cur ? apply(cur) : cur));
      if (okMsg) say(okMsg);
      return d;
    } catch {
      say("Network hiccup — nothing was changed.");
      return null;
    }
  };

  const decideFb = (r: Fb, state: FeedbackDecision) => void post(
    { resource: "feedback", action: "setStatus", id: r.id, status: state },
    state === "open" ? "Reopened." : `${state === "done" ? "Marked done" : "Rejected"}: ${r.name} sees it.`,
    (cur) => ({ ...cur, feedback: cur.feedback.map((x) => (x.id === r.id ? { ...x, state } : x)) }),
  );

  /* Kev sends the $100 from his own wallet, then records the transfer here:
     its signature is what the sender's link opens. */
  const recordPayout = async (r: Fb) => {
    if (fbPaying) return;
    setFbPaying(true);
    try {
      if (await post({ resource: "feedback", action: "markPaid", id: r.id, signature: fbSig.trim() }, `Payout to ${r.name} recorded.`, (cur) => cur)) {
        setFbPayId(null);
        setFbSig("");
        await reload();
      }
    } finally {
      setFbPaying(false);
    }
  };

  /** Grants access (approve, invite an email, a wallet or an X id) and says what
      happened to whom. One at a time: a double click must not mail twice. */
  const grant = async (payload: Record<string, unknown>, who: string) => {
    if (granting) { say("Still on the last one, one moment."); return false; }
    setGranting(true);
    try {
      const res = await fetch("/api/admin", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...sessionAuthHeaders() },
        body: JSON.stringify({ resource: "access", ...payload }),
      });
      const r = (await res.json().catch(() => ({}))) as { error?: string; outcome?: string; mailed?: boolean; listed?: boolean; rejected?: boolean };
      if (!res.ok) { say(r.error || "That didn't work."); return false; }
      say(r.rejected ? `Rejected the request of ${who}.`
        : r.listed === true ? `${who} is on the access list now.`
        : r.listed === false ? `${who} is on the access list already.`
        : r.outcome === "has-password" ? `${who} has an account with its own password already; it is on the access list.`
        : !r.mailed ? `${r.outcome === "reinvited" ? `The earlier password of ${who} no longer works, and the new` : `Account ready for ${who}, but the`} mail did not go out. Invite the email again to resend.`
        : r.outcome === "reinvited" ? `Invited ${who} again: a fresh one-time password is on its way, the earlier one no longer works.`
        : `Invited ${who}: the one-time password is on its way.`);
      await reload();
      return true;
    } catch {
      say("Network hiccup — nothing was changed.");
      return false;
    } finally {
      setGranting(false);
    }
  };

  /** One person's events and failures, fetched when the row opens. */
  const loadPerson = async (id: string) => {
    try {
      const res = await fetch(`/api/admin?person=${encodeURIComponent(id)}`, { headers: sessionAuthHeaders() });
      if (res.ok) {
        const detail = (await res.json()) as PersonDetail;
        setPplDetail((cur) => ({ ...cur, [id]: detail }));
      }
    } catch { /* keep the current view */ }
  };
  const openPerson = async (id: string) => {
    if (pplOpen === id) { setPplOpen(null); return; }
    setPplOpen(id);
    if (!pplDetail[id]) await loadPerson(id);
  };
  /** An action changes counts on the server: refresh the list and the open person. */
  const act = async (payload: Record<string, unknown>, okMsg: string, personId: string) => {
    if (await post(payload, okMsg, (cur) => cur)) {
      await reload();
      await loadPerson(personId);
    }
  };

  /** A trial code from the form; the server answers with the code itself, this once. One at a time. */
  const createTrial = async () => {
    if (trBusy) return;
    // datetime-local is the owner's local time: sent as an instant, so the server reads the moment that was meant.
    const expiryMs = Date.parse(tr.expiry);
    const config = {
      // A count that is no number goes as 0, which the server refuses: as NaN it would go as null, which is unlimited.
      maxUses: tr.unlimited ? null : Number(tr.uses) || 0,
      accessMinutes: Number(tr.minutes === "custom" ? tr.customMinutes : tr.minutes),
      expiresAt: !tr.expires ? null : Number.isNaN(expiryMs) ? "" : new Date(expiryMs).toISOString(),
      // An empty custom budget goes as NaN (null in JSON), which the server refuses: as Number("") it was a $0 code.
      budgetUsd: tr.budget !== "custom" ? Number(tr.budget) : tr.customBudget.trim() === "" ? NaN : Number(tr.customBudget),
    };
    setTrBusy(true);
    try {
      const r = await post({ resource: "trial", action: "create", note: tr.note.trim(), config }, "", (cur) => cur);
      if (typeof r?.code === "string") {
        setTrCode(r.code);
        await reload();
      }
    } finally {
      setTrBusy(false);
    }
  };
  const copyCode = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      say("Copied.");
    } catch {
      say("Could not copy: select the code and copy it by hand.");
    }
  };

  /* The moderation owner's reveal of an artist's withheld text: the reason is
     asked here and logged on the server before anything is shown. */
  const reveal = async (id: string, what: "text" | "image" = "text") => {
    const reason = window.prompt(what === "image"
      ? "Why must you see this image? It is logged and every admin is told (10 to 500 characters)."
      : "Why must you read this artist's text? It is logged and every admin is told (10 to 500 characters).")?.trim();
    if (!reason) return;
    try {
      const res = await fetch("/api/admin", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...sessionAuthHeaders() },
        body: JSON.stringify({ resource: "automod", action: "reveal", id, reason, what }),
      });
      const d = await res.json().catch(() => ({} as { error?: string; text?: string | null; source?: string; image?: string | null }));
      const text = typeof d.text === "string" ? d.text : null;
      const image = typeof d.image === "string" && d.image.startsWith("data:image/") ? d.image : null;
      if (!res.ok || (what === "image" ? image : text) === null) { say(d.error || "That didn't work."); return; }
      setRevealed((cur) => ({ ...cur, [id]: { ...(cur[id] ?? { text: null, source: "record", image: null }), ...(what === "image" ? { image } : { text, source: String(d.source) }) } }));
    } catch {
      say("Network hiccup — nothing was revealed.");
    }
  };
  const withheldBlock = (id: string, draft: boolean, revealable: boolean) => (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 11, fontStyle: "italic", color: "var(--enki-ink-3)" }}>
        {draft ? DRAFT_NOTE : WITHHELD_NOTE}
        {revealable && data?.council.isOwner && revealed[id]?.text == null && (
          <Pill kind="plain" label="Reveal (logged)" title="Only for a hard case: your reason is logged and every admin is told" onClick={() => void reveal(id)} />
        )}
      </span>
      {revealed[id]?.text != null && (
        <p style={{ margin: 0, fontFamily: MONO, fontSize: 11, color: "var(--enki-ink-2)", whiteSpace: "pre-wrap", wordBreak: "break-word", maxWidth: 760 }}>
          {revealed[id].source === "prompt" ? "The prompt's text as it stands now:\n" : ""}{revealed[id].text}
        </p>
      )}
    </div>
  );
  /* A child-safety image case keeps the image, encrypted: the moderation
     owner alone opens it, by the same logged reveal. */
  const imageBlock = (id: string) => (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 11, fontStyle: "italic", color: "var(--enki-ink-3)" }}>
        The image is held as evidence, encrypted, and shown only by a logged reveal.
        {data?.council.isOwner && !revealed[id]?.image && (
          <Pill kind="plain" label="Reveal image (logged)" title="Only to decide the case: your reason is logged and every admin is told" onClick={() => void reveal(id, "image")} />
        )}
      </span>
      {/* eslint-disable-next-line @next/next/no-img-element -- the case's own evidence, a data: URL shown once on a logged reveal */}
      {revealed[id]?.image && <img src={revealed[id].image!} alt="Evidence held with the case, as the judges saw it (a transparent image on black and on white)" style={{ maxWidth: "min(100%, 680px)", maxHeight: 360, objectFit: "contain", borderRadius: 6 }} />}
    </div>
  );

  const q = query.trim().toLowerCase();
  const tabDef = TABS.find((t) => t.id === tab)!;
  const counts = useMemo(() => ({
    // Needs attention: open cases only. A reviewed child-safety case keeps its flag on the row.
    people: data?.people.filter((p) => p.pending > 0).length ?? 0,
    access: data?.access?.requests.length ?? 0,
    trials: data?.trials?.codes.filter((t) => trialStatus(t) === "active").length ?? 0,
    imports: data?.importsTotal ?? 0,
    // Reports and prompts paused after a refused render: both wait on staff.
    reports: (data?.reports.length ?? 0) + (data?.paused.length ?? 0),
    // Open reports to decide and done ones to pay: both wait on staff.
    feedback: data?.feedback.filter((f) => f.state === "open" || (f.state === "done" && !f.paid)).length ?? 0,
    hunters: 0,
    hunter: 0,
    // A record, not a task: each tab counts its own (ParkedPosts).
    videos: 0,
    nomedia: 0,
    strikes: data?.strikes.filter((s) => s.appeal).length ?? 0,
    // Only the never-looked-at ones nag. A block that has been judged is
    // history, not a task.
    automod: data?.automod.filter((a) => a.state === "pending").length ?? 0,
    council: data?.council?.proposals.filter((p) => p.status === "pending").length ?? 0,
    recovery: data?.recovery.filter((r) => r.status === "pending").length ?? 0,
    // The merge queue reads its own route (MergeQueue); /api/admin does not count it.
    communities: 0,
    settings: 0,
    // A record, not a task.
    adminlog: 0,
  }), [data]);

  /* ── gate states ── */
  if (access === "checking" || (access === "ok" && isAdmin && !data && !loadFailed)) {
    return (
      <div className="ek-app" style={{ height: "calc(100vh - var(--ek-banner-h, 0px))", minHeight: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, background: "var(--enki-paper)", color: "var(--enki-ink)" }}>
        <span style={{ color: "var(--enki-ember)", animation: "adm-pulse 1.1s infinite" }}>
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" /></svg>
        </span>
        <span style={{ fontFamily: MONO, fontSize: 10, letterSpacing: "0.16em", textTransform: "uppercase", color: "var(--enki-ink-3)" }}>Verifying admin access…</span>
        <style>{"@keyframes adm-pulse{0%,100%{opacity:.35}50%{opacity:1}}"}</style>
      </div>
    );
  }
  if (!isAdmin) {
    return (
      <div className="ek-app" style={{ height: "calc(100vh - var(--ek-banner-h, 0px))", minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center", padding: 20, background: "var(--enki-paper)" }}>
        <div style={{ maxWidth: 380, textAlign: "center", border: "1px solid var(--enki-rule-2, var(--enki-rule))", borderRadius: 16, background: "var(--enki-paper)", padding: "34px 30px" }}>
          <span style={{ color: "var(--enki-danger)", display: "inline-block", marginBottom: 10 }}>
            <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" /><path d="m14.5 9.5-5 5" /><path d="m9.5 9.5 5 5" /></svg>
          </span>
          <h1 style={{ fontFamily: SERIF, fontStyle: "italic", fontSize: 26, fontWeight: 400, margin: "0 0 8px", color: "var(--enki-ink)" }}>Admins only.</h1>
          <p style={{ fontSize: 12.5, color: "var(--enki-ink-3)", lineHeight: 1.6, margin: "0 0 18px" }}>
            This area is for database admins. Your account doesn&apos;t have admin rights, so there&apos;s nothing for you here.
          </p>
          <button onClick={() => router.push("/home")} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "9px 18px", borderRadius: 999, border: "none", background: "var(--enki-ink)", color: "var(--enki-paper)", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
            ← Back to Enki Art
          </button>
        </div>
      </div>
    );
  }

  const d: AdminData = data ?? { imports: [], importsTotal: 0, reports: [], feedback: [], hunters: [], strikes: [], recovery: [], council: COUNCIL_OFF, automod: [], people: [], generation: { maxConcurrentPerUser: null, canEdit: false }, access: null, hunter: HUNTER_OFF, adminLog: null, trials: null, paused: [] };
  const c = d.council ?? COUNCIL_OFF;
  // A referred link has no title yet ("Untitled"), so the link itself is what a moderator searches for.
  const hu: HunterConfig = huForm ?? d.hunter.config ?? HUNTER_DEFAULTS;
  const setHu = (patch: Partial<HunterConfig>) => setHuForm({ ...hu, ...patch });
  /** The date inside a post id (X ids are snowflakes), for "read back to". */
  const readBackTo = (id: string | null) => {
    if (!id || !/^[0-9]{1,20}$/.test(id)) return "—";
    const ms = Number((BigInt(id) >> BigInt(22)) + BigInt("1288834974657"));
    return new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  };
  const downloadPosts = async (handle: string) => {
    try {
      const res = await fetch(`/api/admin?hunterPosts=${encodeURIComponent(handle)}`, { headers: sessionAuthHeaders() });
      if (!res.ok) { say("Could not read the posts."); return; }
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url; a.download = `hunter-${handle}.csv`; a.click();
      URL.revokeObjectURL(url);
    } catch {
      say("Could not read the posts.");
    }
  };
  const creators = d.hunter.creators ?? [];
  // What "Play all" plays: every creator its own caps and the on-Enki rule let start, and what that may cost at most.
  // Play reads through FxTwitter, free (Kev, 2026-10-31): estimates count the model work alone (estimatePlay freeReads).
  const crPlayable = creators.filter((c) => !estimatePlay(c, true).blocked && !c.state.playing);
  const crAllUsd = crPlayable.reduce((n, c) => n + estimatePlay(c, true).totalUsd, 0);
  /**
   * Adds a creator without a call to X (its first Play looks it up) and opens its settings. addAccounts only inserts
   * (ON CONFLICT DO NOTHING; SQL 56's column defaults are CREATOR_DEFAULTS), so a creator this view does not show yet,
   * added in another tab, keeps its search, cap and cursors; the settings that open are the server's.
   */
  const addCreator = async () => {
    const handle = crNew.trim().replace(/^@/, "").toLowerCase();
    if (!handle) return;
    const known = creators.find((c) => c.handle === handle);
    if (known) { say(`@${handle} is on the list already.`); setCrEdit(handle); setCrForm(formOf(known.config)); setCrMode({ mode: known.mode, recipe: known.recipe }); return; }
    if (!(await post({ resource: "hunter", action: "addAccounts", handles: [handle] }, "", (cur) => cur))) return;
    setCrNew("");
    const row = (await reload())?.hunter.creators?.find((c) => c.handle === handle);
    if (!row) { say(`@${handle} added: reload the page to set its search.`); return; }
    say(`@${handle} is on the list: set its search, then Play.`);
    setCrEdit(handle);
    setCrForm(formOf(row.config));
    setCrMode({ mode: row.mode, recipe: row.recipe });
  };
  /** The open settings as the server will check them (lib/hunter/creator-config), so a bad value shows before Save. */
  const crChecked = (handle: string) => {
    const { wordsText, ...rest } = crForm;
    return parseCreatorConfig({ ...rest, words: wordsOf(wordsText) }, d.hunter.catalogue ?? [], handle);
  };
  const saveCreator = async (row: CreatorRow) => {
    const checked = crChecked(row.handle);
    if (!checked.ok) { say(checked.error); return; }
    const { config } = checked;
    const msg = searchChanged(row.config, config) ? `@${row.handle} saved: its next Play reads from the start.` : `@${row.handle} saved.`;
    if (await post({ resource: "hunter", action: "saveCreator", handle: row.handle, config }, msg, (cur) => cur)) {
      if (crMode.mode !== row.mode || JSON.stringify(crMode.recipe) !== JSON.stringify(row.recipe)) {
        await post({ resource: "hunter", action: "saveMode", handle: row.handle, mode: crMode.mode, recipe: crMode.recipe }, `@${row.handle} saved, in ${crMode.mode} mode.`, (cur) => cur);
      }
      setCrEdit(null);
      void reload();
    }
  };
  /** One Play: round after round (one POST each, at most four minutes) while the server answers more, or until Stop. */
  /** One creator's Play, round after round; true when it ran to its end (not stopped by hand, not failed). */
  const playCreator = async (row: CreatorRow): Promise<boolean> => {
    if (crPlaying) { crStop.current = true; return false; }
    setCrAsk(null);
    crStop.current = false;
    setCrPlaying(row.handle);
    setCrLive({ handle: row.handle, text: "Round 1 · starting" });
    let runId: string | undefined;
    let found = 0;
    let followed = 0;
    let bareInAll = 0;
    let unreadInAll = 0;
    let finished = false;
    try {
      for (let round = 1; ; round++) {
        const res = await fetch("/api/admin", {
          method: "POST", headers: { "Content-Type": "application/json", ...sessionAuthHeaders() },
          body: JSON.stringify({ resource: "hunter", action: "play", handle: row.handle, ...(runId ? { runId } : {}) }),
        });
        const body = (await res.json().catch(() => ({}))) as { error?: string; summary?: CreatorRunSummary };
        const s = body.summary;
        if (s) {
          runId = s.runId;
          found += s.found;
          followed += s.followedUsd ?? 0;
          bareInAll += s.skipped.no_media ?? 0;
          unreadInAll += s.skipped.pictures_failed ?? 0;
          setCrLive({ handle: row.handle, text: `Round ${round} · ${s.usage.posts + s.usage.replies} read · ${found} found · ${usd2(s.estUsd)}${followed ? ` + $${followed.toFixed(4)} on the creators its forwards lead to` : ""}` });
        }
        await reload();
        if (!res.ok || !s) { say(body.error || "The Play failed."); break; }
        if (!s.more || crStop.current) {
          finished = !s.more && !crStop.current;
          const videos = s.usage.videos ? ` ${videosSaved(s.usage.videos)} in the Videos tab.` : "";
          const bare = bareInAll ? ` ${bareInAll} without media in the No media tab.` : "";
          const unread = unreadInAll ? ` ${unreadInAll} whose pictures could not be read: Start over tries them again.` : "";
          say((s.more ? "Stopped: press Play to go on." : `@${row.handle}: ${CR_STOPPED[s.stopped]}.`) + videos + bare + unread);
          break;
        }
      }
    } catch {
      // The round may have run and billed on the server: its spend shows in the row, and so in the next Play's confirm.
      say("Network hiccup: press Play to go on.");
      void reload();
    } finally {
      setCrPlaying(null);
    }
    return finished;
  };
  // One post by its link (Kev, 2026-10-31: "Add link manually"), put in line under its creator, not played (Kev, 2026-11-01:
  // "importiere dann nicht jeden link direkt ... sondern lasse mich erst das einstellen und dann play drücken"): its
  // creator's mode is set, then "Play links" plays them.
  // Links wait in a line and are added one after another in the background, the field free at once for the next (Kev,
  // 2026-10-31: "adding the link takes too long. just append it so i can quickly input a new link").
  const addLink = () => {
    const url = crLink.trim();
    if (!url) return;
    setCrLink("");
    linkQueue.current.push(url);
    setCrListing(`Adding ${linkQueue.current.length + (draining.current ? 1 : 0)} link${linkQueue.current.length + (draining.current ? 1 : 0) === 1 ? "" : "s"}…`);
    if (!draining.current) void drainLinks();
  };
  const drainLinks = async () => {
    draining.current = true;
    for (let url = linkQueue.current.shift(); url; url = linkQueue.current.shift()) {
      const left = linkQueue.current.length + 1;
      setCrListing(`Adding ${left} link${left === 1 ? "" : "s"}…`);
      const res = await fetch("/api/admin", {
        method: "POST", headers: { "Content-Type": "application/json", ...sessionAuthHeaders() },
        body: JSON.stringify({ resource: "hunter", action: "queueLink", url }),
      }).catch(() => null);
      const body = (await res?.json().catch(() => ({})) ?? {}) as { error?: string; handle?: string };
      void reload();
      say(res?.ok && body.handle ? `In line under @${body.handle}: set its mode, then Play links.` : body.error || "The link could not be added.");
    }
    draining.current = false;
    setCrListing(null);
  };
  // A .txt list, one post link a line (Kev, 2026-10-31: "import .txt list wobei jede zeile einen link beinhalten wird
  // der dann nacheinander importiert werden soll"), each added as "Add link manually" adds one; the tally comes at the end.
  const importList = async (file: { text: () => Promise<string> }) => {
    const links = (await file.text()).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    if (!links.length) return say("The list has no links.");
    let queued = 0;
    const not: string[] = [];
    for (const [i, url] of links.entries()) {
      setCrListing(`Importing ${i + 1} of ${links.length}…`);
      const res = await fetch("/api/admin", {
        method: "POST", headers: { "Content-Type": "application/json", ...sessionAuthHeaders() },
        body: JSON.stringify({ resource: "hunter", action: "queueLink", url }),
      }).catch(() => null);
      const body = (await res?.json().catch(() => ({})) ?? {}) as { error?: string };
      if (res?.ok) queued += 1;
      else not.push(`${url}: ${body.error ?? "not read"}`);
    }
    setCrListing(null);
    await reload();
    say(`${queued} of ${links.length} links in line: set each creator's mode, then Play links.${not.length ? ` Not: ${not.slice(0, 3).join("; ")}${not.length > 3 ? ` and ${not.length - 3} more` : ""}.` : ""}`);
  };
  /** "Generate title, category & tags": the marked finds, else every waiting one, named by gpt-6-luna in batches. */
  const describeImports = async () => {
    const ids = [...impSel];
    const n = ids.length || d.importsTotal;
    if (!n) return say("No finds to name.");
    if (!window.confirm(`Ask gpt-6-luna for the title, category and tags of ${n} find${n === 1 ? "" : "s"}? About $${(n * HUNT_PRICES.describe).toFixed(4)}.`)) return;
    setCrListing(`Naming ${n} finds…`);
    const res = await fetch("/api/admin", {
      method: "POST", headers: { "Content-Type": "application/json", ...sessionAuthHeaders() },
      body: JSON.stringify({ resource: "imports", action: "describe", ids }),
    }).catch(() => null);
    const body = (await res?.json().catch(() => ({})) ?? {}) as { error?: string; described?: number; asked?: number };
    setCrListing(null);
    await reload();
    say(res?.ok ? `${body.described ?? 0} of ${body.asked ?? 0} finds named.` : body.error || "The finds could not be named.");
  };
  /** "Play links": the links waiting for one creator, one after another, cut in its mode (Kev, 2026-11-01). */
  const playLinks = async (row: CreatorRow) => {
    if (crListing) return say("Links are being added: wait for them first.");
    const res = await fetch(`/api/admin?hunterWaiting=${encodeURIComponent(row.handle)}`, { headers: sessionAuthHeaders() }).catch(() => null);
    const body = (await res?.json().catch(() => null)) as { links?: string[]; error?: string } | null;
    if (!res?.ok || !body?.links) return say(body?.error || "The waiting links could not be read.");
    let queued = 0;
    const not: string[] = [];
    const went = new Map<string, number>();
    for (const [i, id] of body.links.entries()) {
      setCrListing(`Playing ${i + 1} of ${body.links.length} for @${row.handle}…`);
      const r = await fetch("/api/admin", {
        method: "POST", headers: { "Content-Type": "application/json", ...sessionAuthHeaders() },
        body: JSON.stringify({ resource: "hunter", action: "addLink", url: `https://x.com/i/status/${id}`, handle: row.handle }),
      }).catch(() => null);
      const b = (await r?.json().catch(() => ({})) ?? {}) as { error?: string; summary?: CreatorRunSummary; said?: string | null };
      if (r?.ok && b.summary?.queued) queued += 1;
      else if (r?.ok && b.said) went.set(b.said, (went.get(b.said) ?? 0) + 1);
      else {
        const skip = Object.keys(b.summary?.skipped ?? {})[0];
        not.push(`${id}: ${b.error ?? (skip ? outcomeWords(skip) : "not read")}`);
      }
    }
    setCrListing(null);
    await reload();
    const saved = [...went].map(([s, n]) => ` ${n > 1 ? `${n} links: ` : ""}${s}`).join("");
    say(`${queued} of ${body.links.length} links of @${row.handle} in Pending imports.${saved}${not.length ? ` Not: ${not.slice(0, 3).join("; ")}${not.length > 3 ? ` and ${not.length - 3} more` : ""}.` : ""}`);
  };
  const loadHuLog = async () => {
    const res = await fetch("/api/admin?hunterLog=1", { headers: sessionAuthHeaders() }).catch(() => null);
    const body = (await res?.json().catch(() => null)) as { log?: { post_id: string; handle: string; outcome: string; read_at: string }[]; error?: string } | null;
    if (!res?.ok || !body?.log) return say(body?.error || "The log could not be read.");
    setHuLog(body.log);
  };
  /** The log's rows a search keeps: by the post's link or id, or the creator's handle (with or without @). */
  const huLogShown = (huLog ?? []).filter((r) => {
    const q = huLogQ.trim().toLowerCase().replace(/^@/, "");
    if (!q) return true;
    const id = q.match(/status\/(\d+)/)?.[1] ?? q;
    return r.post_id.includes(id) || r.handle.toLowerCase().includes(q);
  });
  // Every creator in turn, each within its own caps and stops (Kev, 2026-10-31: "ja bau den alle spielen"), after one
  // confirm with the total; a Stop or a failed Play ends the chain.
  const playAll = async () => {
    setCrAskAll(false);
    for (const c of crPlayable) if (!(await playCreator(c))) break;
  };
  // One creator's finds exactly ("Show its finds"); a search also finds them by the X handle.
  const isFindOf = (r: Imp, handle: string) => (r.preview?.hunt?.creator.handle ?? "").toLowerCase() === handle;
  const missedImports = d.importsMissed ?? d.imports.filter((r) => !!r.preview?.hunt?.recipeMiss).length;
  const filteredImports = d.imports.filter((r) => !crFinds || isFindOf(r, crFinds)).filter((r) => !impMissed || !!r.preview?.hunt?.recipeMiss).filter((r) => !q || r.name.toLowerCase().includes(q) || r.hunter.toLowerCase().includes(q) || (r.preview?.hunt?.creator.handle ?? "").toLowerCase().includes(q) || (r.url ?? "").toLowerCase().includes(q));
  const filteredFeedback = d.feedback.filter((r) => !q || r.name.toLowerCase().includes(q) || (r.email ?? "").toLowerCase().includes(q) || r.desc.toLowerCase().includes(q));
  // Searching the prompt text matters most here: it is how you find every
  // block by one offender, or every block that shares a phrasing.
  const filteredAutomod = d.automod.filter((r) => !q
    || (r.category ?? "").toLowerCase().includes(q)
    || (r.handle ?? "").toLowerCase().includes(q)
    || r.surface.toLowerCase().includes(q)
    || r.rules.some((x) => x.toLowerCase().includes(q))
    || (r.prompt ?? "").toLowerCase().includes(q));
  const filteredPeople = d.people.filter((p) => !q || (p.handle ?? "").toLowerCase().includes(q) || (p.displayName ?? "").toLowerCase().includes(q) || p.key.includes(q));
  const filteredRecovery = d.recovery.filter((r) => !q || r.handle.toLowerCase().includes(q) || (r.contact ?? "").toLowerCase().includes(q));

  const stats: { label: string; value: number; dot: string; go: Tab }[] = [
    { label: "Pending imports", value: d.importsTotal, dot: "var(--enki-ember)", go: "imports" },
    { label: "Open reports", value: d.reports.length + d.paused.length, dot: "var(--enki-danger)", go: "reports" },
    { label: "Feedback to act on", value: counts.feedback, dot: "var(--enki-ember)", go: "feedback" },
    { label: "Active strikes", value: d.strikes.reduce((n, s) => n + s.strikes.length, 0), dot: "var(--enki-danger)", go: "strikes" },
    { label: "Open appeals", value: d.strikes.filter((s) => s.appeal).length, dot: "var(--enki-turq)", go: "strikes" },
    { label: "Recovery pending", value: d.recovery.filter((r) => r.status === "pending").length, dot: "var(--enki-turq)", go: "recovery" },
  ];

  return (
    <div className="ek-app" style={{ display: "flex", height: "calc(100vh - var(--ek-banner-h, 0px))", minHeight: 0, overflow: "hidden", background: "var(--enki-paper-2)", color: "var(--enki-ink)", animation: "adm-fade .25s ease" }}>
      <style>{`
        @keyframes adm-fade{from{opacity:0}to{opacity:1}}
        @keyframes adm-pop{from{opacity:0;transform:scale(.97)}to{opacity:1;transform:scale(1)}}
        @keyframes adm-toast{from{opacity:0;transform:translateX(-50%) translateY(12px)}to{opacity:1;transform:translateX(-50%) translateY(0)}}
        @keyframes adm-pulse{0%,100%{opacity:.35}50%{opacity:1}}
        .adm-nav{display:flex;align-items:center;gap:10px;height:37px;padding:0 12px;border:none;border-radius:999px;background:transparent;color:${SB.nav};font-size:13px;width:100%;text-align:left;cursor:pointer;}
        .adm-nav:hover{background:rgba(255,255,255,.09);color:${SB.navOn};}
        .adm-nav.on{background:rgba(255,255,255,.12);color:${SB.navOn};font-weight:600;}
        .adm-off{display:flex;align-items:center;justify-content:center;gap:7px;height:36px;margin:0 2px 8px;border:1px solid rgba(201,104,56,.55);border-radius:999px;background:rgba(201,104,56,.14);color:${SB.emberText};font-size:12px;font-weight:600;cursor:pointer;width:calc(100% - 4px);}
        .adm-off:hover{background:rgba(201,104,56,.28);color:${SB.emberHover};}
        .adm-stat{border:1px solid var(--enki-rule-2,var(--enki-rule));border-radius:11px;background:var(--enki-paper);padding:9px 11px;text-align:left;cursor:pointer;}
        .adm-stat:hover,.adm-stat.on{border-color:var(--enki-ember);}
        .adm-kebab{opacity:0;transition:opacity .15s;width:24px;height:24px;border:none;border-radius:6px;background:none;color:${SB.muted};display:flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0;}
        .adm-account:hover .adm-kebab{opacity:1;}
        .adm-kebab:hover{background:rgba(255,255,255,.1);color:${SB.navOn};}
      `}</style>

      {/* ── inverted admin sidebar (theme-independent by design) ── */}
      <aside style={{ width: 208, flexShrink: 0, display: "flex", flexDirection: "column", padding: "12px 10px 14px", background: SB.bg, color: SB.ink, overflowY: "auto" }}>
        <div style={{ padding: "4px 8px 10px" }}>
          <div style={{ fontFamily: MONO, fontSize: 8, letterSpacing: "0.22em", textTransform: "uppercase", color: SB.muted }}>Enki Art</div>
          <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <span style={{ fontFamily: SERIF, fontStyle: "italic", fontSize: 22, color: SB.navOn }}>Admin.</span>
            <span style={{ fontFamily: MONO, fontSize: 7.5, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: SB.emberText, border: "1px solid rgba(201,104,56,0.55)", background: "rgba(201,104,56,0.16)", borderRadius: 4, padding: "2px 6px" }}>
              {role === "admin" ? "DB admin" : "Moderator"}
            </span>
          </div>
        </div>
        <nav style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {TABS.filter((t) => (t.id !== "access" || d.access) && (t.id !== "adminlog" || d.adminLog) && (t.id !== "trials" || d.trials) && (t.id !== "communities" || role === "admin")).map((t) => (
            <button key={t.id} className={"adm-nav" + (tab === t.id ? " on" : "")} onClick={() => { setTab(t.id); setQuery(""); setCrFinds(null); }}>
              <Icon name={t.icon} size={16} stroke={1.9} />
              <span style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t.label}</span>
              {/* The count badge keeps the sidebar's own ember. --enki-ember now
                  follows the theme (gold / violet) and would clash with the fixed
                  warm accents right beside it. */}
              {counts[t.id] > 0 && (
                <span style={{ minWidth: 17, height: 17, padding: "0 5px", borderRadius: 999, background: SB.ember, color: SB.navOn, fontFamily: MONO, fontSize: 9, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center" }}>
                  {counts[t.id]}
                </span>
              )}
            </button>
          ))}
        </nav>
        <div style={{ flex: 1 }} />
        <button className="adm-off" onClick={() => router.push("/home")}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18.36 6.64A9 9 0 0 1 20.77 15" /><path d="M6.16 6.16a9 9 0 1 0 12.68 12.68" /><path d="M12 2v4" /></svg>
          Turn off admin mode
        </button>
        <div className="adm-account" ref={kebabRef} style={{ position: "relative", display: "flex", alignItems: "center", gap: 9, padding: "8px 8px 2px", borderTop: "1px solid rgba(255,255,255,0.1)" }}>
          <span style={{ width: 32, height: 32, borderRadius: "50%", background: SB.navOn, color: SB.bg, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: MONO, fontSize: 11, fontWeight: 600, overflow: "hidden", flexShrink: 0 }}>
            <Seal handle={profile?.handle || handle || ""} />
          </span>
          <span style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1 }}>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: SB.navOn, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{handle || "you"}</span>
            <span style={{ fontSize: 11, color: SB.muted, fontFamily: MONO }}>@{handle || "—"}</span>
          </span>
          {/* 3-dot menu: theme mode lives here (hover to reveal) */}
          <button className="adm-kebab" title="Options" onClick={() => setKebabOpen((o) => !o)}>
            <Icon name="dots" size={15} stroke={2.2} />
          </button>
          {kebabOpen && (
            <div style={{ position: "absolute", bottom: "calc(100% + 6px)", right: 4, zIndex: 40, minWidth: 168, background: SB.bg, border: "1px solid rgba(255,255,255,0.14)", borderRadius: 12, padding: 6, boxShadow: "0 14px 34px rgba(0,0,0,0.4)", animation: "adm-pop .15s ease" }}>
              <div style={{ fontFamily: MONO, fontSize: 8, letterSpacing: "0.14em", textTransform: "uppercase", color: SB.muted, padding: "4px 8px 6px" }}>Color theme</div>
              {THEME_OPTS.map((t) => (
                <button key={t.id} onClick={() => setTheme(t.id)} style={{ display: "flex", alignItems: "center", gap: 9, width: "100%", padding: "7px 8px", border: "none", borderRadius: 8, background: theme === t.id ? "rgba(255,255,255,0.1)" : "none", color: theme === t.id ? SB.navOn : SB.nav, fontSize: 12.5, fontWeight: theme === t.id ? 600 : 400, cursor: "pointer", textAlign: "left" }}>
                  <span style={{ width: 16, height: 16, borderRadius: 5, background: t.sw, boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.25)", flexShrink: 0 }} />
                  <span style={{ flex: 1 }}>{t.name}</span>
                  {theme === t.id && <Icon name="check" size={13} stroke={2.6} />}
                </button>
              ))}
            </div>
          )}
        </div>
      </aside>

      {/* ── content ── */}
      <div style={{ flex: 1, minWidth: 0, overflowY: "auto" }}>
        <div style={{ maxWidth: 1080, margin: "0 auto", padding: "24px 26px 40px" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
            <h1 style={{ fontFamily: SERIF, fontStyle: "italic", fontSize: 30, fontWeight: 400, margin: 0, lineHeight: 1, color: "var(--enki-ink)" }}>
              {tabDef.label.charAt(0).toUpperCase() + tabDef.label.slice(1)}.
            </h1>
            <p style={{ margin: 0, fontSize: 12, color: "var(--enki-ink-3)" }}>{tabDef.sub}</p>
            {tabDef.search && (
              <span className="kit-ring" style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6, height: 30, borderWidth: 1, borderStyle: "solid", borderRadius: 999, background: "var(--enki-paper)", padding: "0 11px", width: 200 }}>
                <Icon name="search" size={12} stroke={2} style={{ color: "var(--enki-ink-3)" }} />
                <input value={query} onChange={(e) => { setQuery(e.target.value); setCrFinds(null); }} placeholder="Search…" style={{ flex: 1, minWidth: 0, border: "none", background: "transparent", outline: "none", fontSize: 12, color: "var(--enki-ink)" }} />
              </span>
            )}
          </div>

          {loadFailed ? (
            <div style={{ padding: "50px 0", textAlign: "center", color: "var(--enki-ink-3)", fontSize: 13 }}>Could not load the moderation queues — refresh to retry.</div>
          ) : (
            <>
              {/* stat cards */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(138px, 100%), 1fr))", gap: 8, marginBottom: 14 }}>
                {stats.map((s) => (
                  <button key={s.label} className={"adm-stat" + (tab === s.go ? " on" : "")} onClick={() => { setTab(s.go); setQuery(""); setCrFinds(null); }}>
                    <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
                      <span style={{ width: 6, height: 6, borderRadius: "50%", background: s.dot, flexShrink: 0 }} />
                      <span style={{ ...microLabel, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.label}</span>
                    </span>
                    <span style={{ display: "block", fontFamily: SERIF, fontSize: 23, fontWeight: 400, color: "var(--enki-ink)" }}>{s.value}</span>
                  </button>
                ))}
              </div>

              {/* ── PENDING IMPORTS ── */}
              {tab === "imports" && (
                <>
                  {crFinds && (
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                      <span style={{ fontFamily: MONO, fontSize: 10, color: "var(--enki-ink-3)", overflowWrap: "anywhere" }}>Finds of @{crFinds} on X · {filteredImports.length}</span>
                      <Pill kind="plain" label="Show all" onClick={() => setCrFinds(null)} />
                    </div>
                  )}
                  {role === "admin" && (
                    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, marginBottom: 8 }}>
                      <input value={delPrompt} onChange={(e) => setDelPrompt(e.target.value)} placeholder="Prompt link or id" aria-label="Prompt link or id to delete"
                        style={{ ...huInput, fontFamily: MONO, width: "auto", flex: "1 1 220px", minWidth: 0, maxWidth: 420 }} />
                      <Pill kind="red" label="Delete prompt" title="Takes the prompt off Enki (soft: kept in the database, every list leaves it out)" onClick={() => {
                        const id = delPrompt.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0];
                        if (!id) return say("Paste a prompt's link or id.");
                        if (!window.confirm(`Delete the prompt ${id}? Every list leaves it out; it stays in the database.`)) return;
                        void post({ resource: "prompts", action: "delete", id }, "Prompt deleted.", (cur) => cur).then((ok) => { if (ok) setDelPrompt(""); });
                      }} />
                    </div>
                  )}
                  {/* Outside the Mark all label (a button in it took its clicks), and shown while the filter is on (review 2026-11-01). */}
                  {(d.importsTotal > 0 || impMissed) && (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
                      {/* gpt-6-luna names the marked finds, else every waiting one, in batches (Kev, 2026-11-01). */}
                      <Pill kind="plain" label="Generate title, category & tags" title="Asks gpt-6-luna for the marked finds' title, category and tags (every waiting find when none is marked)" onClick={() => void describeImports()} />
                      {(missedImports > 0 || impMissed) && <Pill kind={impMissed ? "green" : "plain"} label={`Cut missed (${missedImports})`} title="Only the finds their recipe or manual mode's cut did not cut: their whole text is the prompt" onClick={() => setImpMissed(!impMissed)} />}
                    </div>
                  )}
                  {filteredImports.length > 0 && (
                    <label style={{ display: "inline-flex", alignItems: "center", gap: 6, marginBottom: 8, fontFamily: MONO, fontSize: 10, color: "var(--enki-ink-3)", cursor: "pointer" }}>
                      <input type="checkbox" aria-label="Mark all" checked={filteredImports.every((r) => impSel.has(r.id))}
                        onChange={(e) => setImpSel(e.target.checked ? new Set(filteredImports.map((r) => r.id)) : new Set())} style={{ accentColor: "var(--enki-ember, #c96838)" }} />
                      Mark all
                    </label>
                  )}
                  {impSel.size > 0 && (
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                      <span style={{ fontFamily: MONO, fontSize: 10, color: "var(--enki-ink-3)" }}>{impSel.size} selected</span>
                      <Pill kind="green" label="Approve all" onClick={() => {
                        const ids = [...impSel];
                        setImpBusy((b) => new Set([...b, ...ids]));
                        say(`Publishing ${ids.length}…`);
                        void approveFinds({ ids }, `${ids.length} imports approved.`, (cur) => ({ ...cur, imports: cur.imports.filter((r) => !ids.includes(r.id)) }))
                          // Refused or failed: the selection comes back, or the admin selects them all again after fixing the field.
                          .then((ok) => { if (!ok) { setImpSel(new Set(ids)); void reload(); } })
                          .finally(() => setImpBusy((b) => new Set([...b].filter((x) => !ids.includes(x)))));
                        setImpSel(new Set());
                      }} />
                      <Pill kind="red" label="Reject all" onClick={() => {
                        const ids = [...impSel];
                        void post({ resource: "imports", action: "reject", ids, reason: "Other" }, `${ids.length} imports rejected.`, (cur) => ({ ...cur, imports: cur.imports.filter((r) => !impSel.has(r.id)) }));
                        setImpSel(new Set());
                      }} />
                    </div>
                  )}
                  <div style={cardStyle}>
                    {filteredImports.length === 0 && <div style={{ padding: 30, textAlign: "center", fontSize: 12, color: "var(--enki-ink-3)" }}>Queue empty — all caught up ✓</div>}
                    {filteredImports.map((r) => (
                      // Opens downward with its top where it was, the check box too (Kev, 2026-10-31).
                      // A click anywhere opens or closes it, but not on its fields, links or buttons (Kev, 2026-10-31).
                      <div key={r.id} onClick={(e) => { if (!(e.target as HTMLElement).closest("input, textarea, select, button, a, label, [data-edit]")) openImp(r); }}
                        style={{ ...rowStyle, alignItems: "flex-start", cursor: "pointer", background: impSel.has(r.id) ? "rgba(var(--ember-rgb), 0.05)" : "transparent" }}>
                        <input type="checkbox" checked={impSel.has(r.id)} onChange={() => setImpSel((s) => { const n = new Set(s); if (n.has(r.id)) n.delete(r.id); else n.add(r.id); return n; })} style={{ accentColor: "var(--enki-ember, #c96838)" }} />
                        <span style={{ flex: 1.2, minWidth: 0 }}>
                          {r.preview ? (
                            <input data-edit key={r.name} defaultValue={r.name} aria-label="Title" maxLength={80}
                              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                              onBlur={(e) => { const title = e.target.value.trim(); if (title && title !== r.name) saveImpFields(r, { title }); }}
                              style={{ display: "block", width: "100%", fontFamily: SERIF, fontSize: 14, color: "var(--enki-ink)", background: "transparent", border: "1px solid transparent", borderRadius: 5, padding: "1px 3px", margin: "-2px -4px" }} />
                          ) : <span style={{ display: "block", fontFamily: SERIF, fontSize: 14, color: "var(--enki-ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.name}</span>}
                          {r.url && (
                            <a href={r.url} target="_blank" rel="noreferrer" style={{ fontFamily: MONO, fontSize: 9, color: "var(--enki-ember)" }}>
                              {linkLabel(r.url)}
                            </a>
                          )}
                          {r.preview && (
                            <span style={{ display: "block", marginTop: 4 }}>
                              <span style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 3 }}>
                                <Badge pal={PILL.green} label="Hunted" />
                                {r.preview.adult && <Badge pal={PILL.red} label="18+" />}
                                <select data-edit value={r.preview.category} aria-label="Category" onChange={(e) => saveImpFields(r, { category: e.target.value })} style={impField}>
                                  {!(ENKI_CATEGORIES as readonly string[]).includes(r.preview.category) && <option value={r.preview.category}>{r.preview.category || "—"}</option>}
                                  {ENKI_CATEGORIES.map((c) => <option key={c}>{c}</option>)}
                                </select>
                                {!r.preview.hunt && <span style={{ fontFamily: MONO, fontSize: 8.5, color: "var(--enki-ink-3)" }}>{r.preview.generators.length ? r.preview.generators.join(", ") : "all generators"}</span>}
                              </span>
                              {r.preview.hunt && (
                                <span style={{ display: "flex", flexWrap: "wrap", gap: "3px 8px", alignItems: "center", fontFamily: MONO, fontSize: 8.5, color: "var(--enki-ink-3)", marginBottom: 3 }}>
                                  <a href={`https://x.com/${r.preview.hunt.creator.handle}`} target="_blank" rel="noreferrer" style={{ color: "var(--enki-ember)" }}>@{r.preview.hunt.creator.handle} on X</a>
                                  <span>
                                    Found in {r.preview.hunt.from === "reply" && r.preview.hunt.replyUrl
                                      ? <a href={r.preview.hunt.replyUrl} target="_blank" rel="noreferrer" style={{ color: "var(--enki-ember)" }}>@{r.preview.hunt.creator.handle}&apos;s reply ↗</a>
                                      : HUNT_FROM[r.preview.hunt.from]}
                                    {r.preview.hunt.how !== "model" && ` · ${r.preview.hunt.how}`}
                                  </span>
                                  {r.preview.hunt.how === "model" && <Badge pal={PILL.purple} label="Cut by model" />}
                                  {r.preview.hunt.recipeMiss && <Badge pal={PILL.amber} label={`Cut missed: ${r.preview.hunt.recipeMiss}`} />}
                                  <span>Generator:{" "}
                                    <select data-edit value={r.preview.generators[0] ?? ""} aria-label="Generator" onChange={(e) => saveImpFields(r, { generators: e.target.value ? [e.target.value] : [] })} style={impField}>
                                      <option value="">every generator</option>
                                      {r.preview.generators[0] && !(d.hunter.catalogue ?? []).includes(r.preview.generators[0]) && <option>{r.preview.generators[0]}</option>}
                                      {(d.hunter.catalogue ?? []).map((g) => <option key={g}>{g}</option>)}
                                    </select>
                                    {r.preview.generators.length > 0 && ` (${GEN_FROM[r.preview.hunt.generatorFrom]})`}
                                  </span>
                                  {r.preview.hunt.foreignGenerator && <Badge pal={PILL.amber} label={`The post names ${r.preview.hunt.foreignGenerator}, not offered here`} />}
                                  <span>{r.preview.photos.length} {r.preview.photos.length === 1 ? "image" : "images"}{r.preview.hunt.videosSkipped > 0 && ` · ${videosSaved(r.preview.hunt.videosSkipped)}`}</span>
                                  {/* How far it spread on X: the core post, and summed over the forwards it came through (Kev, 2026-10-31). */}
                                  {r.preview.hunt.reach && (
                                    <span title="On X: the core post's likes, reposts and quotes, then their sums over the posts it was forwarded through">
                                      ♥ {r.preview.hunt.reach.core.likes} · ↻ {r.preview.hunt.reach.core.reposts} · ❝ {r.preview.hunt.reach.core.quotes}
                                      {r.preview.hunt.reach.chain.posts > 1 && ` · chain of ${r.preview.hunt.reach.chain.posts}: ♥ ${r.preview.hunt.reach.chain.likes} ↻ ${r.preview.hunt.reach.chain.reposts} ❝ ${r.preview.hunt.reach.chain.quotes}`}
                                    </span>
                                  )}
                                </span>
                              )}
                              {impOpen === r.id && impEdit?.id === r.id ? (
                                <span style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                                  {/* As tall as the whole prompt, as it opened before; a copy button at its top right (Kev, 2026-10-31). */}
                                  <span style={{ position: "relative", display: "block" }}>
                                  <button type="button" data-edit aria-label="Copy the prompt" title="Copy the prompt"
                                    onClick={() => { void navigator.clipboard.writeText(impEdit.prompt).then(() => say("Prompt copied."), () => say("Copy failed: select the text instead.")); }}
                                    style={{ position: "absolute", top: 6, right: 6, zIndex: 1, width: 26, height: 26, borderRadius: 6, border: "1px solid var(--enki-rule)", background: "var(--enki-paper)", color: "var(--enki-ink-2)", cursor: "pointer", fontSize: 13, lineHeight: 1 }}>⧉</button>
                                  <textarea data-edit autoFocus value={impEdit.prompt} aria-label="Prompt"
                                    ref={(el) => { if (el) { el.style.height = "auto"; el.style.height = `${el.scrollHeight + 2}px`; } }}
                                    onChange={(e) => setImpEdit({ ...impEdit, prompt: e.target.value })}
                                    onBlur={() => { if (r.preview && impEdit.prompt.trim() !== r.preview.prompt) saveImpFields(r, { prompt: impEdit.prompt }); else impUnsaved.current.delete(r.id); }}
                                    style={{ ...huInput, width: "100%", fontSize: 11, lineHeight: 1.45, resize: "vertical", fontFamily: "inherit", overflow: "hidden", paddingRight: 38 }} />
                                  </span>
                                  <span style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                                    <Pill kind="plain" label={impPost?.id === r.id ? "Hide post text" : "Show full post text"} onClick={() => void showPostText(r)} />
                                    {/* A wrong cut costs one click (Kev, 2026-11-03). */}
                                    {r.preview.hunt?.raw && r.preview.hunt.raw !== impEdit.prompt && <Pill kind="plain" label="Take the whole text instead" title="Replaces the prompt with the post's whole text and the author's replies" onClick={() => takeWhole(r, r.preview!.hunt!.raw!)} />}
                                  </span>
                                  {impPost?.id === r.id && <span data-edit style={{ display: "block", whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 11, lineHeight: 1.45, padding: 8, borderRadius: 7, background: "var(--enki-paper-2)", color: "var(--enki-ink-2)", userSelect: "text", cursor: "text" }}>{impPost.text}</span>}
                                </span>
                              ) : (
                                <span title="Click to open the prompt" style={{ display: "block", fontSize: 11, color: "var(--enki-ink-2)", whiteSpace: "pre-wrap", lineHeight: 1.45, maxHeight: 32, overflow: "hidden" }}>{r.preview.prompt}</span>
                              )}
                              {r.preview.photos.length > 0 && (
                                <span style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 4 }}>
                                  {r.preview.photos.map((src) => (
                                    // eslint-disable-next-line @next/next/no-img-element -- X's picture, shown as it is
                                    <img key={src} data-edit src={src} alt="" title="Click to see it full screen" onClick={() => setImpZoom(src)}
                                      style={{ width: 44, height: 44, objectFit: "cover", borderRadius: 5, border: "1px solid var(--enki-rule)", cursor: "zoom-in" }} />
                                  ))}
                                </span>
                              )}
                            </span>
                          )}
                        </span>
                        <span style={{ width: 88, fontFamily: MONO, fontSize: 10.5, color: "var(--enki-ink-3)", overflow: "hidden", textOverflow: "ellipsis" }}>@{r.hunter}</span>
                        <span style={{ flex: 0.9, display: "flex", gap: 4, flexWrap: "wrap" }}>
                          {r.preview ? (
                            <input data-edit key={r.preview.tags.join(",")} defaultValue={r.preview.tags.join(", ")} aria-label="Tags, comma separated" placeholder="tags, comma separated"
                              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                              onBlur={(e) => { const tags = e.target.value.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean); if (r.preview && tags.join(",") !== r.preview.tags.join(",")) saveImpFields(r, { tags }); }}
                              style={{ ...impField, width: "100%", minWidth: 0 }} />
                          ) : r.tags.map((t) => <span key={t} style={{ fontFamily: MONO, fontSize: 8.5, color: "var(--enki-ink-2)", background: "var(--enki-paper-2)", borderRadius: 4, padding: "2px 6px" }}>{t}</span>)}
                        </span>
                        {r.preview && (
                          <label data-edit title="18+: shown only to those who opted in" style={{ display: "flex", alignItems: "center", gap: 4, fontFamily: MONO, fontSize: 9.5, color: r.preview.adult ? "var(--enki-danger, #b3261e)" : "var(--enki-ink-3)", cursor: "pointer" }}>
                            <input type="checkbox" checked={r.preview.adult} aria-label="18+" onChange={(e) => saveImpFields(r, { adult: e.target.checked })} style={{ accentColor: "var(--enki-ember, #c96838)" }} />18+
                          </label>
                        )}
                        <span style={{ width: 52, textAlign: "right", fontFamily: MONO, fontSize: 9, color: "var(--enki-ink-3)" }}>{timeAgo(r.at)}</span>
                        {impRejectId === r.id ? (
                          <span style={{ display: "flex", gap: 5, alignItems: "center" }}>
                            <select value={impReason} onChange={(e) => setImpReason(e.target.value)} style={{ height: 26, border: "1px solid var(--enki-rule)", borderRadius: 7, background: "var(--enki-paper)", color: "var(--enki-ink)", fontSize: 10.5 }}>
                              {REJECT_REASONS.map((x) => <option key={x}>{x}</option>)}
                            </select>
                            <Pill kind="red" label="Confirm" onClick={() => {
                              void post({ resource: "imports", action: "reject", id: r.id, reason: impReason }, `Rejected: ${impReason}.`, (cur) => ({ ...cur, imports: cur.imports.filter((x) => x.id !== r.id) }));
                              setImpRejectId(null);
                            }} />
                            <Pill kind="plain" label="Cancel" onClick={() => setImpRejectId(null)} />
                          </span>
                        ) : (
                          <span style={{ display: "flex", gap: 5 }}>
                            {impBusy.has(r.id) ? <Pill kind="plain" label="Publishing…" title="Checking and publishing: a few seconds" />
                              : <Pill kind="green" label="Approve" onClick={() => {
                                setImpBusy((b) => new Set(b).add(r.id));
                                void approveFinds({ id: r.id }, `“${r.name}” approved — it's live.`, (cur) => ({ ...cur, imports: cur.imports.filter((x) => x.id !== r.id) }))
                                  .then((ok) => { if (!ok) void reload(); })
                                  .finally(() => setImpBusy((b) => { const n = new Set(b); n.delete(r.id); return n; }));
                              }} />}
                            <Pill kind="red" label="Reject" onClick={() => setImpRejectId(r.id)} />
                          </span>
                        )}
                      </div>
                    ))}
                    {d.imports.length < d.importsTotal && (
                      <div ref={impEnd} style={{ padding: 14, textAlign: "center", fontFamily: MONO, fontSize: 10, color: "var(--enki-ink-3)" }}>
                        {d.imports.length} of {d.importsTotal} · the next {Math.min(50, d.importsTotal - d.imports.length)} load as you scroll
                      </div>
                    )}
                  </div>
                </>
              )}

              {tab === "videos" && <ParkedPosts key="video" kind="video" query={query} />}
              {tab === "nomedia" && <ParkedPosts key="no_media" kind="no_media" query={query} />}

              {/* ── PROMPT HUNTER: one row per creator, each with its own search, generator, Play and caps (Kev, 2026-10-30) ── */}
              {tab === "hunter" && (!d.hunter.ready ? (
                <div style={{ ...cardStyle, padding: "26px 18px", textAlign: "center", fontSize: 12.5, color: "var(--enki-ink-3)" }}>
                  The Prompt Hunter needs its tables — run <span style={{ fontFamily: MONO }}>migrations/2026-10-14-prompt-hunter.sql</span> in Supabase, then refresh.
                </div>
              ) : !d.hunter.creatorsReady ? (
                <div style={{ ...cardStyle, padding: "26px 18px", textAlign: "center", fontSize: 12.5, color: "var(--enki-ink-3)" }}>
                  The creator hunter needs SQL 56 (<span style={{ fontFamily: MONO }}>sql-to-run/56-creator-hunter.sql</span>).
                </div>
              ) : (
                <div className="crh">
                  <style>{CR_CSS}</style>
                  <div style={{ ...cardStyle, padding: "14px 16px", marginBottom: 10 }}>
                    <div style={{ fontFamily: SERIF, fontStyle: "italic", fontSize: 17, color: "var(--enki-ink)", marginBottom: 4 }}>Creators.</div>
                    <p style={{ margin: "0 0 10px", fontSize: 11.5, color: "var(--enki-ink-3)", lineHeight: 1.55 }}>
                      Add a creator on X by handle, set what to look for, press Play. A Play searches their posts for the words, takes the prompt from the post, an image&apos;s alt text or their own reply, and puts each find into Pending imports as a prompt of the creator&apos;s own Enki account (made at their first Play; what their renders earn follows their X account). Posts are read for free through FxTwitter (unofficial: it can be slow or down); only the checks of a post with a prompt cost, at most about $0.0016 each, and every Play shows that before it starts.
                    </p>
                    {d.hunter.canEdit && (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                        <input value={crNew} onChange={(e) => setCrNew(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void addCreator(); }} placeholder="@handle" aria-label="X handle of the creator" maxLength={16}
                          style={{ ...huInput, fontFamily: MONO, width: "auto", flex: "1 1 150px", minWidth: 0, maxWidth: 280 }} />
                        <Pill kind="green" label="Add creator" onClick={() => void addCreator()} />
                        {crPlayable.length > 1 && !crPlaying && (
                          <Pill kind="green" label="Play all" title="Plays every creator in turn; shows what it may cost first" onClick={() => setCrAskAll(!crAskAll)} />
                        )}
                      </div>
                    )}
                    {d.hunter.canEdit && (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginTop: 8 }}>
                        <input value={crLink} onChange={(e) => setCrLink(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addLink(); }} placeholder="https://x.com/…/status/…" aria-label="Link to a post on X"
                          style={{ ...huInput, fontFamily: MONO, width: "auto", flex: "1 1 220px", minWidth: 0, maxWidth: 420 }} />
                        <Pill kind="green" label="Add link manually" title="Reads the post for free and puts what the hunter makes of it into Pending imports; the field is free at once for the next link" onClick={addLink} />
                        {crListing ? <Pill kind="plain" label={crListing} title="The list's links, one after another" />
                          : <Pill kind="plain" label="Import .txt list" title="A text file with one post link a line, added one after another" onClick={() => listInput.current?.click()} />}
                        <input ref={listInput} type="file" accept=".txt,text/plain" hidden onChange={(e) => {
                          const f = e.target.files?.[0];
                          e.target.value = "";
                          if (f) void importList(f);
                        }} />
                      </div>
                    )}
                    <div style={{ marginTop: 12 }}>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                        <span style={{ fontFamily: MONO, fontSize: 10, color: "var(--enki-ink-3)" }}>Log</span>
                        <Pill kind="plain" label={huLog ? "Refresh log" : "Show log"} onClick={() => void loadHuLog()} />
                        {huLog && <input value={huLogQ} onChange={(e) => setHuLogQ(e.target.value)} placeholder="Search a link or @username" aria-label="Search the log by link or username"
                          style={{ ...huInput, fontFamily: MONO, width: "auto", flex: "1 1 200px", minWidth: 0, maxWidth: 360 }} />}
                      </div>
                      {huLog && (
                        <div style={{ marginTop: 6, maxHeight: 320, overflowY: "auto", fontFamily: MONO, fontSize: 10 }}>
                          {huLogShown.length === 0 && <div style={{ padding: 8, color: "var(--enki-ink-3)" }}>Nothing in the log matches.</div>}
                          {huLogShown.length > 300 && <div style={{ padding: "4px 0", color: "var(--enki-ink-3)" }}>{`The newest 300 of ${huLogShown.length}: search to see the rest.`}</div>}
                          {huLogShown.slice(0, 300).map((r) => {
                            const ok = r.outcome === "queued" || r.outcome === "published" || r.outcome === "forwarded";
                            return (
                              <div key={`${r.post_id}:${r.outcome}:${r.read_at}`} style={{ display: "flex", flexWrap: "wrap", gap: "2px 10px", padding: "4px 0", borderBottom: "1px dashed var(--enki-rule)" }}>
                                <span style={{ color: "var(--enki-ink-3)", width: 64 }}>{timeAgo(r.read_at)}</span>
                                <span style={{ width: 120, overflow: "hidden", textOverflow: "ellipsis" }}>@{r.handle}</span>
                                <a href={`https://x.com/${r.handle}/status/${r.post_id}`} target="_blank" rel="noreferrer" style={{ color: "var(--enki-ember)", flex: "1 1 180px", minWidth: 0, overflowWrap: "anywhere" }}>x.com/{r.handle}/status/{r.post_id}</a>
                                <span style={{ color: ok ? "var(--enki-ok, #2e7d32)" : "var(--enki-danger, #b3261e)" }}>{ok ? `✓ ${r.outcome}` : `✗ ${outcomeWords(r.outcome)}`}</span>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                    {d.hunter.canEdit && crAskAll && !crPlaying && (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginTop: 8, fontSize: 12, color: "var(--enki-ink-3)" }}>
                        <span style={{ flex: "1 1 220px", minWidth: 0, overflowWrap: "anywhere" }}>{`Play all ${crPlayable.length} creators, one after another? At most ${usd2(crAllUsd)} in all, each within its own spend cap.`}</span>
                        <Pill kind="green" label="Play all" onClick={() => void playAll()} />
                        <Pill kind="plain" label="Cancel" onClick={() => setCrAskAll(false)} />
                      </div>
                    )}
                  </div>
                  <div style={{ ...cardStyle, marginBottom: 10 }}>
                    {creators.length === 0 && <div style={{ padding: 30, textAlign: "center", fontSize: 12, color: "var(--enki-ink-3)" }}>No creators yet.</div>}
                    {creators.map((c) => {
                      const est = estimatePlay(c, true);
                      const playing = crPlaying === c.handle;
                      const published = c.runs.reduce((n, r) => n + r.published, 0);
                      const state = c.onEnki ? `on Enki as @${c.onEnki}, not hunted` : c.state.error ? c.state.error
                        : c.state.catchingUp ? "catching up on new posts"
                        : c.state.dry ? `stopped: ${c.config.dryAfter} posts in a row without a prompt` : c.state.backDone ? "up to date"
                        : c.state.oldestId ? `reading back to ${readBackTo(c.state.oldestId)}` : "new";
                      const checked = crEdit === c.handle ? crChecked(c.handle) : null;
                      const catalogue = d.hunter.catalogue ?? [];
                      return (
                        <div key={c.handle} className="crh-item">
                          <div className="crh-row">
                            <span className="crh-who">
                              {/* Its seal, as everywhere on Enki (Kev, 2026-10-26: "i dont want no profile images on enki"). */}
                              <span style={{ width: 30, height: 30, borderRadius: "50%", flexShrink: 0, overflow: "hidden", border: "1px solid var(--enki-rule)" }}>
                                <Seal handle={c.profile?.handle || c.handle} />
                              </span>
                              <span style={{ minWidth: 0 }}>
                                <span style={{ display: "block", fontFamily: SERIF, fontSize: 14, color: "var(--enki-ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.profile?.name || `@${c.handle}`}</span>
                                <span style={{ display: "flex", flexWrap: "wrap", gap: "0 8px", fontFamily: MONO, fontSize: 9.5 }}>
                                  <a href={`https://x.com/${c.handle}`} target="_blank" rel="noreferrer" style={{ color: "var(--enki-ember)", overflowWrap: "anywhere" }}>@{c.handle} ↗</a>
                                  {c.profile && <a href={`/creators/${c.profile.userId}`} target="_blank" rel="noreferrer" style={{ color: "var(--enki-ink-2)" }}>Enki profile</a>}
                                </span>
                              </span>
                            </span>
                            <span className="crh-meta">
                              <span style={{ color: c.state.error ? "var(--enki-danger)" : "var(--enki-ink-3)" }}>{state}</span>
                              <span style={{ color: "var(--enki-ink-2)" }}>{c.state.postsRead} read · {c.state.found} found · {c.pending} waiting · {published} published{c.links ? ` · ${c.links} link${c.links === 1 ? "" : "s"} in line` : ""} · {c.mode}</span>
                              <span style={{ color: "var(--enki-ink-3)" }}>{usd2(c.state.spentUsd)} of {usd2(c.config.spendCapUsd)} · last Play {c.state.lastRunAt ? `${timeAgo(c.state.lastRunAt)} ago` : "never"}</span>
                            </span>
                            <span className="crh-acts">
                              {d.hunter.canEdit && c.links > 0 && !playing && !c.state.playing && (
                                <Pill kind="green" label={`Play ${c.links} link${c.links === 1 ? "" : "s"}`} title={`Plays the links in line for @${c.handle}, in ${c.mode} mode`} onClick={() => void playLinks(c)} />
                              )}
                              {d.hunter.canEdit && (playing ? <Pill kind="red" label="Stop" title="Finishes this round, then stops" onClick={() => void playCreator(c)} />
                                : est.blocked === "on_enki" ? <Pill kind="plain" label="On Enki" title={`@${c.handle} is on Enki as @${c.onEnki}: their posts are theirs to publish`} />
                                : est.blocked === "spend_cap" ? <Pill kind="plain" label="Cap reached" title={`Spend cap reached: ${usd2(est.spentUsd)} of ${usd2(est.capUsd)} spent, room for fewer than 10 posts. Raise the cap in Settings.`} />
                                : crPlaying || c.state.playing ? <Pill kind="plain" label="Play" title={c.state.playing ? "A Play is running for this creator already" : `@${crPlaying} is playing`} />
                                : <Pill kind="green" label="Play" title="Shows what it may cost first" onClick={() => setCrAsk(crAsk === c.handle ? null : c.handle)} />)}
                              {d.hunter.canEdit && !playing && !c.state.playing && <Pill kind="plain" label="Start over" title={`Reads every post again from the newest (free); found ones are skipped as duplicates. Posts marked distill failed, reply missing, forward could not be followed or leads to someone not on your list are tried again at the next Play: ${c.mode === "auto" ? "about $0.0007 each" : "free"}; Start over itself spends nothing`} onClick={() => {
                                if (window.confirm(`Read @${c.handle} from the start again? Posts already found are skipped; a rejected one is read again. Posts marked distill failed, reply missing, forward could not be followed or leads to someone not on your list are tried again at its next Play: ${c.mode === "auto" ? "about $0.0007 each" : "free"}.`)) void post({ resource: "hunter", action: "restart", handle: c.handle }, `@${c.handle} starts over at its next Play.`, (cur) => cur).then(() => reload());
                              }} />}
                              {d.hunter.canEdit && <Pill kind="plain" label="Settings" onClick={() => { if (crEdit === c.handle) { setCrEdit(null); return; } setCrEdit(c.handle); setCrForm(formOf(c.config)); setCrMode({ mode: c.mode, recipe: c.recipe }); }} />}
                              <Pill kind="plain" label={crOpen === c.handle ? "Hide results" : "Results"} onClick={() => setCrOpen(crOpen === c.handle ? null : c.handle)} />
                              <Pill kind="plain" label="Posts" title="The posts read from this creator, as a CSV" onClick={() => void downloadPosts(c.handle)} />
                              {/* Not mid-Play: the round would write its reads and spend to no row. Removing forgets the spend
                                  (the cap counts from $0 again when it is added back), so the confirm says so. */}
                              {d.hunter.canEdit && (playing || c.state.playing ? <Pill kind="plain" label="Remove" title="Stop its Play first" />
                                : <Pill kind="red" label="Remove" title="Forgets the creator, its spend and the posts read from it" onClick={() => {
                                  if (!window.confirm(`Remove @${c.handle}? The ${c.state.postsRead} posts read from it are forgotten: added again, X bills those posts again. Its spend so far (${usd2(c.state.spentUsd)}) still counts against its cap, and its Enki profile, its prompts and its past Plays stay.`)) return;
                                  void post({ resource: "hunter", action: "removeAccount", handle: c.handle }, `@${c.handle} removed.`, (cur) => ({ ...cur, hunter: { ...cur.hunter, creators: (cur.hunter.creators ?? []).filter((x) => x.handle !== c.handle) } }));
                                }} />)}
                            </span>
                          </div>
                          {crLive?.handle === c.handle && (
                            <div style={{ marginTop: 6, fontFamily: MONO, fontSize: 10, color: playing ? "var(--enki-ink)" : "var(--enki-ink-3)" }}>{playing ? "Playing · " : "Last Play · "}{crLive.text}</div>
                          )}
                          {crAsk === c.handle && !playing && !est.blocked && (
                            <div className="crh-ask">
                              <span style={{ flex: "1 1 240px", minWidth: 0 }}>
                                Play @{c.handle}? At most {est.posts} posts, read for free{c.mode === "auto" ? `, and the checks (${usd2(est.modelUsd)}): at most ${usd2(est.totalUsd)}` : `, in ${c.mode} mode with no model: $0`}. Spent so far {usd2(est.spentUsd)} of {usd2(est.capUsd)}.
                              </span>
                              <span style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                                <Pill kind="green" label="Play" onClick={() => void playCreator(c)} />
                                <Pill kind="plain" label="Cancel" onClick={() => setCrAsk(null)} />
                              </span>
                            </div>
                          )}
                          {checked && (
                            <div className="crh-panel">
                              <div className="crh-form">
                                {/* How its finds are cut (Kev, 2026-11-01): the model, the admin's markers, or the whole text. */}
                                <label style={huLabel}>Mode
                                  <select value={crMode.mode} disabled={!d.hunter.modesReady} onChange={(e) => setCrMode({ ...crMode, mode: e.target.value as HuntMode })} style={huInput}>
                                    <option value="auto">Auto: AI cuts and names, checks judge</option>
                                    <option value="recipe">Recipe: your markers cut, no AI, no checks</option>
                                    <option value="manual">Manual: the whole text, no AI, no checks</option>
                                  </select>
                                </label>
                                {!d.hunter.modesReady && <span style={{ ...huLabel, color: "var(--enki-ink-3)" }}>Modes need SQL 59 (sql-to-run/59-hunter-modes.sql).</span>}
                                {crMode.mode === "recipe" && (
                                  <>
                                    <label style={huLabel}>The prompt is in
                                      <select value={crMode.recipe.from} onChange={(e) => setCrMode({ ...crMode, recipe: { ...crMode.recipe, from: e.target.value === "text" ? "text" : "reply" } })} style={huInput}>
                                        <option value="reply">the author&apos;s reply</option>
                                        <option value="text">the post&apos;s text</option>
                                      </select>
                                    </label>
                                    <label style={huLabel}>Starts after the line with (empty: from the top)
                                      <input value={crMode.recipe.after} maxLength={80} placeholder="(access" onChange={(e) => setCrMode({ ...crMode, recipe: { ...crMode.recipe, after: e.target.value } })} style={{ ...huInput, fontFamily: MONO }} />
                                    </label>
                                    <label style={huLabel}>Ends before the line with (empty: to the end)
                                      <input value={crMode.recipe.before} maxLength={80} placeholder="Grab more" onChange={(e) => setCrMode({ ...crMode, recipe: { ...crMode.recipe, before: e.target.value } })} style={{ ...huInput, fontFamily: MONO }} />
                                    </label>
                                    <label style={huLabel}>Title: line of the post (0: none, the prompt&apos;s first words)
                                      <input type="number" inputMode="numeric" min={0} max={10} value={crMode.recipe.titleLine} onChange={(e) => setCrMode({ ...crMode, recipe: { ...crMode.recipe, titleLine: Number(e.target.value) } })} style={huInput} />
                                    </label>
                                  </>
                                )}
                                <label className="crh-wide" style={huLabel}>Search words, a comma between them (any of them in the post&apos;s text; empty: every post)
                                  <input value={crForm.wordsText} onChange={(e) => setCr({ wordsText: e.target.value })} placeholder="prompt, free prompt, prompt below" style={{ ...huInput, fontFamily: MONO }} />
                                  <span style={{ fontFamily: MONO, fontSize: 10, color: "var(--enki-ink-2)", overflowWrap: "anywhere" }}>{searchQuery(c.handle, checked.ok ? checked.config : { ...crForm, words: wordsOf(crForm.wordsText) })}</span>
                                </label>
                                <label style={huLabel}>Media
                                  <select value={crForm.media} onChange={(e) => setCr({ media: e.target.value as CreatorMedia })} style={huInput}>
                                    {CR_MEDIA.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                                  </select>
                                </label>
                                <label style={huLabel}>Min likes<input type="number" inputMode="numeric" min={0} max={1000000} value={crForm.minLikes} onChange={(e) => setCr({ minLikes: Number(e.target.value) })} style={huInput} /></label>
                                <label style={huLabel}>How far back
                                  <select value={String(crForm.sinceDays)} onChange={(e) => setCr({ sinceDays: Number(e.target.value) })} style={huInput}>
                                    {CR_SINCE.map((o) => <option key={o.days} value={String(o.days)}>{o.label}</option>)}
                                    {!CR_SINCE.some((o) => o.days === crForm.sinceDays) && <option value={String(crForm.sinceDays)}>{crForm.sinceDays} days</option>}
                                  </select>
                                </label>
                                <label style={huLabel}>Preferred generator
                                  <select value={crForm.preferredGenerator ?? ""} onChange={(e) => setCr({ preferredGenerator: e.target.value || null })} style={huInput}>
                                    <option value="">None: every generator</option>
                                    {catalogue.map((g) => <option key={g} value={g}>{g}</option>)}
                                    {crForm.preferredGenerator && !catalogue.includes(crForm.preferredGenerator) && <option value={crForm.preferredGenerator}>{crForm.preferredGenerator} (not active)</option>}
                                  </select>
                                  <span style={{ fontSize: 10, color: "var(--enki-ink-3)" }}>Used when a post names no generator</span>
                                </label>
                                <label style={huLabel}>Posts per Play<input type="number" inputMode="numeric" min={20} max={1000} value={crForm.postsPerPlay} onChange={(e) => setCr({ postsPerPlay: Number(e.target.value) })} style={huInput} /></label>
                                <label style={huLabel}>Spend cap, all Plays ($)<input type="number" inputMode="decimal" min={0} max={1000} step={0.01} value={crForm.spendCapUsd} onChange={(e) => setCr({ spendCapUsd: Number(e.target.value) })} style={huInput} /></label>
                                <label style={huLabel}>Stop after N posts without a prompt (0 = never)<input type="number" inputMode="numeric" min={0} max={1000} value={crForm.dryAfter} onChange={(e) => setCr({ dryAfter: Number(e.target.value) })} style={huInput} /></label>
                              </div>
                              {!checked.ok && <p style={{ margin: "10px 0 0", fontSize: 11.5, color: "var(--enki-danger)" }}>{checked.error}</p>}
                              {checked.ok && searchChanged(c.config, checked.config) && (
                                <p style={{ margin: "10px 0 0", fontSize: 11.5, color: "var(--enki-ink-2)" }}>Changing the search starts over: posts already taken are skipped, X bills the re-read.</p>
                              )}
                              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
                                <Pill kind="green" label="Save" onClick={() => void saveCreator(c)} />
                                <Pill kind="plain" label="Cancel" onClick={() => setCrEdit(null)} />
                              </div>
                            </div>
                          )}
                          {crOpen === c.handle && (
                            <div className="crh-panel">
                              {c.runs.length === 0 && <div style={{ fontSize: 11.5, color: "var(--enki-ink-3)", paddingBottom: 8 }}>No Plays yet.</div>}
                              {c.runs.map((r, i) => (
                                <div key={r.id} className="crh-run">
                                  <span style={{ width: 60, fontFamily: MONO, fontSize: 9, color: "var(--enki-ink-3)" }}>{timeAgo(r.at)} ago</span>
                                  <span style={{ flex: "1 1 220px", minWidth: 0, fontFamily: MONO, fontSize: 10.5, color: "var(--enki-ink-2)", overflowWrap: "anywhere" }}>
                                    {r.usage.posts + r.usage.replies} read · {r.found} found · {r.queued} queued · {r.published} published
                                    {Object.entries(r.skipped).some(([, v]) => v > 0) && <span style={{ color: "var(--enki-ink-3)" }}> · skipped {Object.entries(r.skipped).filter(([, v]) => v > 0).map(([k, v]) => `${outcomeWords(k)} ${v}`).join(", ")}</span>}
                                    {r.usage.videos > 0 && <span style={{ color: "var(--enki-ink-3)" }}> · {videosSaved(r.usage.videos)}</span>}
                                    {" · "}{usd2(r.estUsd)}
                                  </span>
                                  <span style={{ fontFamily: MONO, fontSize: 9.5, color: "var(--enki-ink-3)", overflowWrap: "anywhere" }}>{r.done ? `stopped: ${CR_STOPPED[r.stopped ?? "done"]}` : i === 0 && (playing || c.state.playing) ? "running" : "unfinished"}</span>
                                  {r.error && <span style={{ flexBasis: "100%", fontFamily: MONO, fontSize: 9.5, color: "var(--enki-danger)" }}>{r.error}</span>}
                                </div>
                              ))}
                              <div style={{ marginTop: 8 }}>
                                <Pill kind="plain" label="Show its finds" title="Pending imports: this creator's finds only" onClick={() => { setTab("imports"); setQuery(""); setCrFinds(c.handle); }} />
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <div style={{ ...cardStyle, padding: "14px 16px", maxWidth: 640 }}>
                    <div style={{ fontFamily: SERIF, fontStyle: "italic", fontSize: 17, color: "var(--enki-ink)", marginBottom: 4 }}>Mode.</div>
                    <p style={{ margin: "0 0 10px", fontSize: 11.5, color: "var(--enki-ink-3)", lineHeight: 1.55 }}>
                      For every creator. Queue for review: each find waits in Pending imports. Publish at once: a find goes live as the creator&apos;s prompt, except one whose post names a generator Enki does not offer and none that it does, which always waits. {d.hunter.canEdit ? "Takes effect at the next round." : "Admins only — you can see it, but not change it."}
                    </p>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                      <select value={hu.mode} disabled={!d.hunter.canEdit} aria-label="Mode" onChange={(e) => setHu({ mode: e.target.value === "publish" ? "publish" : "queue" })} style={{ ...huInput, width: "auto", flex: "1 1 160px", minWidth: 0, maxWidth: 260 }}>
                        <option value="queue">queue for review</option>
                        <option value="publish">publish at once</option>
                      </select>
                      {d.hunter.canEdit && (
                        <Pill kind="green" label="Save" onClick={() => {
                          const config: HunterConfig = { ...hu, publisher: (hu.publisher ?? "").trim() || null };
                          void post({ resource: "hunter", action: "save", config }, "Mode saved.", (cur) => ({ ...cur, hunter: { ...cur.hunter, config } })).then((ok) => { if (ok) setHuForm(null); });
                        }} />
                      )}
                    </div>
                  </div>
                </div>
              ))}

              {/* ── REPORTS ── */}
              {tab === "reports" && (
                <div style={cardStyle}>
                  {/* Paused after a render was refused for the artist's own text (DEC-441): the cause, and for an admin the
                      text on a tap (DEC-476). */}
                  {d.paused.map((p) => (
                    <Fragment key={p.promptId}>
                    <div style={rowStyle}>
                      <span style={{ width: 30, textAlign: "center", fontFamily: MONO, fontSize: 15, fontWeight: 700, color: "var(--enki-danger)" }} title="Off sale until decided">‖</span>
                      <span style={{ flex: 1, minWidth: 0, fontFamily: SERIF, fontSize: 14, color: "var(--enki-ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {p.title}
                        <span style={{ fontSize: 11, color: "var(--enki-ink-3)" }}> · paused: {pauseSummary(p.refusals)}</span>
                      </span>
                      <Badge pal={PILL.blue} label="prompt" />
                      <span style={{ width: 76, fontFamily: MONO, fontSize: 9.5, color: "var(--enki-ink-3)", overflow: "hidden", textOverflow: "ellipsis" }}>@{p.artist}</span>
                      <span style={{ width: 40, textAlign: "right", fontFamily: MONO, fontSize: 9, color: "var(--enki-ink-3)" }}>{timeAgo(p.refusals[0]?.at ?? "")}</span>
                      <span style={{ display: "flex", gap: 5 }}>
                        {role === "admin" && <Pill kind="plain" label={pausedText[p.promptId] !== undefined ? "Hide" : "Text"} title="The prompt's own words (logged)" onClick={() => {
                          if (pausedText[p.promptId] !== undefined) return setPausedText(({ [p.promptId]: _gone, ...rest }) => rest);
                          void post({ resource: "prompts", action: "text", id: p.promptId }, "", (cur) => cur).then((r) => {
                            if (typeof r?.text === "string") setPausedText((cur) => ({ ...cur, [p.promptId]: r.text as string }));
                          });
                        }} />}
                        <Pill kind="green" label="Release" title="Back on sale" onClick={() => void post({ resource: "prompts", action: "release", id: p.promptId }, "Prompt back on sale.", (cur) => ({ ...cur, paused: cur.paused.filter((x) => x.promptId !== p.promptId) }))} />
                        <Pill kind="amber" label="Delist" title="Take it down for good" onClick={() => void post({ resource: "prompts", action: "delist", id: p.promptId }, "Prompt delisted.", (cur) => ({ ...cur, paused: cur.paused.filter((x) => x.promptId !== p.promptId) }))} />
                      </span>
                    </div>
                    {pausedText[p.promptId] !== undefined && (
                      <pre className="pause-text" style={{ margin: "0 0 8px 30px", padding: "10px 12px", maxHeight: 220, overflow: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontFamily: MONO, fontSize: 11.5, lineHeight: 1.5, color: "var(--enki-ink-2)", background: "var(--enki-paper-2)", border: "1px solid var(--enki-rule)", borderRadius: 8 }}>
                        {pausedText[p.promptId]}
                      </pre>
                    )}
                    </Fragment>
                  ))}
                  {d.reports.length === 0 && d.paused.length === 0 && <div style={{ padding: 30, textAlign: "center", fontSize: 12, color: "var(--enki-ink-3)" }}>No open reports ✓</div>}
                  {d.reports.map((r) => (
                    <div key={r.id} style={rowStyle}>
                      <span style={{ width: 30, textAlign: "center", fontFamily: MONO, fontSize: 15, fontWeight: 700, color: r.severity === "critical" || r.severity === "high" ? "var(--enki-danger)" : "var(--enki-ink)" }} title={r.severity ?? undefined}>!</span>
                      <span style={{ flex: 1, minWidth: 0, fontFamily: SERIF, fontSize: 14, color: "var(--enki-ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={r.details ?? undefined}>
                        {r.href ? <a href={r.href} target="_blank" rel="noopener noreferrer" style={{ color: "inherit" }}>{r.target}</a> : r.target}
                        {r.details && <span style={{ fontSize: 11, color: "var(--enki-ink-3)" }}> · {r.details}</span>}
                      </span>
                      <Badge pal={r.type === "prompt" ? PILL.blue : r.type === "image" ? PILL.purple : PILL.amber} label={r.type} />
                      <span style={{ width: 90, fontSize: 11, color: "var(--enki-ink-2)", overflow: "hidden", textOverflow: "ellipsis" }}>{REPORT_REASONS.find((x) => x.value === r.reason)?.label ?? r.reason}</span>
                      <span style={{ width: 76, fontFamily: MONO, fontSize: 9.5, color: "var(--enki-ink-3)", overflow: "hidden", textOverflow: "ellipsis" }}>@{r.reporter}</span>
                      <span style={{ width: 40, textAlign: "right", fontFamily: MONO, fontSize: 9, color: "var(--enki-ink-3)" }}>{timeAgo(r.at)}</span>
                      {repStrikeId === r.id ? (
                        <span style={{ display: "flex", gap: 5, alignItems: "center" }}>
                          <select value={repSev} onChange={(e) => setRepSev(e.target.value)} style={{ height: 26, border: "1px solid var(--enki-rule)", borderRadius: 7, background: "var(--enki-paper)", color: "var(--enki-ink)", fontSize: 10.5 }}>
                            {["1", "2", "3"].map((s) => <option key={s} value={s}>Severity {s}</option>)}
                          </select>
                          <Pill kind="red" label="Confirm" onClick={() => {
                            void post({ resource: "reports", action: "strike", id: r.id, severity: Number(repSev) }, "Strike issued — report closed.", (cur) => ({ ...cur, reports: cur.reports.filter((x) => x.id !== r.id) }));
                            setRepStrikeId(null);
                          }} />
                          <Pill kind="plain" label="Cancel" onClick={() => setRepStrikeId(null)} />
                        </span>
                      ) : (
                        <span style={{ display: "flex", gap: 5 }}>
                          {r.type === "prompt" && <Pill kind="amber" label="Delist" onClick={() => void post({ resource: "reports", action: "delist", id: r.id }, "Prompt delisted — report closed.", (cur) => ({ ...cur, reports: cur.reports.filter((x) => x.id !== r.id) }))} />}
                          {r.type === "image" && <Pill kind="amber" label="Hide" title="Make the image private: only its owner sees it" onClick={() => void post({ resource: "reports", action: "hide", id: r.id }, "Image hidden — report closed.", (cur) => ({ ...cur, reports: cur.reports.filter((x) => x.id !== r.id) }))} />}
                          <Pill kind="red" label="Strike" title="Strike the reported user and close the report" onClick={() => { setRepSev("1"); setRepStrikeId(r.id); }} />
                          <Pill kind="green" label="Resolve" onClick={() => void post({ resource: "reports", action: "resolve", id: r.id }, "Report resolved.", (cur) => ({ ...cur, reports: cur.reports.filter((x) => x.id !== r.id) }))} />
                          <Pill kind="plain" label="Dismiss" onClick={() => void post({ resource: "reports", action: "dismiss", id: r.id }, "Report dismissed.", (cur) => ({ ...cur, reports: cur.reports.filter((x) => x.id !== r.id) }))} />
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* ── FEEDBACK ── */}
              {tab === "feedback" && (
                <div style={cardStyle}>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", padding: "9px 0 7px" }}>
                    <Badge pal={PILL.amber} label={`Open ${d.feedback.filter((f) => f.state === "open").length}`} />
                    <Badge pal={PILL.blue} label={`Done, unpaid ${d.feedback.filter((f) => f.state === "done" && !f.paid).length}`} />
                    <Badge pal={PILL.green} label={`Paid ${d.feedback.filter((f) => f.paid).length}`} />
                    <Badge pal={PILL.red} label={`Rejected ${d.feedback.filter((f) => f.state === "rejected").length}`} />
                  </div>
                  {filteredFeedback.length === 0 && <div style={{ padding: 30, textAlign: "center", fontSize: 12, color: "var(--enki-ink-3)" }}>No feedback yet.</div>}
                  {filteredFeedback.map((r) => (
                    <div key={r.id}>
                      <div style={{ ...rowStyle, cursor: "pointer" }} onClick={() => void openFeedback(r)}>
                        <span style={{ width: 116, fontSize: 12, fontWeight: 600, color: "var(--enki-ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</span>
                        <span style={{ width: 132, fontFamily: MONO, fontSize: 9.5, color: "var(--enki-ink-3)", overflow: "hidden", textOverflow: "ellipsis" }}>{r.email ?? "—"}</span>
                        <span style={{ flex: 1, minWidth: 0, fontSize: 11.5, color: "var(--enki-ink-3)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.desc}</span>
                        <span style={{ width: 34, textAlign: "center", fontFamily: MONO, fontSize: 9, color: "var(--enki-ink-3)" }}>{r.images > 0 ? `${r.images} img` : "—"}</span>
                        <span style={{ width: 42, fontFamily: MONO, fontSize: 9, color: "var(--enki-ink-3)" }}>{timeAgo(r.at)}</span>
                        <Badge pal={r.paid ? PILL.green : FB_STATE[r.state].pal} label={r.paid ? "Paid" : FB_STATE[r.state].label} />
                        <span style={{ display: "flex", gap: 5, alignItems: "center" }} onClick={(e) => e.stopPropagation()}>
                          {fbPayId === r.id ? <>
                            <input className="kit-ring" autoFocus placeholder="Transaction signature" value={fbSig} onChange={(e) => setFbSig(e.target.value)} style={{ width: 210, height: 26, borderWidth: 1, borderStyle: "solid", borderRadius: 7, background: "var(--enki-paper)", color: "var(--enki-ink)", fontSize: 10.5, fontFamily: MONO, padding: "0 7px", outline: "none" }} />
                            <Pill kind="green" label={fbPaying ? "Saving…" : "Confirm"} onClick={fbPaying ? undefined : () => void recordPayout(r)} />
                            <Pill kind="plain" label="Cancel" onClick={() => setFbPayId(null)} />
                          </> : <>
                            {/* Done promises the $100: an admin's word, given and taken back by admins alone. */}
                            {r.state === "open" && <>
                              {role === "admin" && <Pill kind="green" label="Done" title="We build it: the $100 follows" onClick={() => decideFb(r, "done")} />}
                              <Pill kind="red" label="Reject" onClick={() => decideFb(r, "rejected")} />
                            </>}
                            {r.state !== "open" && !r.paid && (r.state === "rejected" || role === "admin") && <Pill kind="plain" label="Reopen" onClick={() => decideFb(r, "open")} />}
                            {r.state === "done" && !r.paid && role === "admin" && <Pill kind="green" label="Mark paid" title="After sending the $100: paste the transaction" onClick={() => { setFbSig(""); setFbPayId(r.id); }} />}
                            {r.paid && r.txUrl && <a href={r.txUrl} target="_blank" rel="noopener noreferrer" style={{ fontFamily: MONO, fontSize: 9.5, color: "var(--enki-ember)" }}>Payment ↗</a>}
                          </>}
                        </span>
                      </div>
                      {fbOpen === r.id && (
                        <div style={{ padding: "2px 0 12px 10px", borderLeft: `3px solid ${PILL.amber.border}`, margin: "0 0 8px 4px" }}>
                          <p style={{ margin: 0, fontSize: 12, color: "var(--enki-ink-2)", lineHeight: 1.65, maxWidth: 640 }}>{r.desc}</p>
                          <p style={{ margin: "8px 0 0", fontSize: 11, color: "var(--enki-ink-3)" }}>
                            Pay to <span style={{ fontFamily: MONO, color: "var(--enki-ink-2)", userSelect: "all" }}>{r.wallet ?? "no payable Solana wallet (must re-link)"}</span>
                          </p>
                          {(fbFiles[r.id] ?? []).length > 0 && (
                            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
                              {fbFiles[r.id].map((f, i) => f.url && (f.mime.startsWith("video/")
                                ? <video key={i} src={f.url} controls preload="metadata" style={{ maxWidth: 320, maxHeight: 220, borderRadius: 6, background: "#000" }} />
                                : (
                                  <a key={i} href={f.url} target="_blank" rel="noopener noreferrer">
                                    {/* eslint-disable-next-line @next/next/no-img-element -- a private attachment by a link that expires in minutes; next/image would fetch and cache it on our server */}
                                    <img src={f.url} alt={`Attachment ${i + 1} of the report`} style={{ display: "block", maxWidth: 220, maxHeight: 160, objectFit: "contain", borderRadius: 6, border: "1px solid var(--enki-rule)" }} />
                                  </a>
                                )))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* ── ACCESS: approve requests, invite an email, a wallet or an X id (admins) ── */}
              {tab === "access" && d.access && (
                <>
                  <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 7, border: "1px solid var(--enki-rule-2, var(--enki-rule))", borderRadius: 11, background: "var(--enki-paper)", padding: "10px 12px", marginBottom: 8 }}>
                    <input className="kit-ring" placeholder="Invite an email" value={invEmail} onChange={(e) => setInvEmail(e.target.value)} style={{ flex: 1, minWidth: 180, height: 28, borderWidth: 1, borderStyle: "solid", borderRadius: 8, background: "var(--enki-paper-2)", color: "var(--enki-ink)", fontSize: 11.5, padding: "0 9px", outline: "none" }} />
                    <Pill kind="green" label="Invite email" onClick={() => { if (invEmail.trim()) void grant({ action: "inviteEmail", email: invEmail }, invEmail.trim()).then((ok) => { if (ok) setInvEmail(""); }); }} />
                    <input className="kit-ring" placeholder="Invite a wallet (Solana or EVM)" value={invWallet} onChange={(e) => setInvWallet(e.target.value)} style={{ flex: 1.4, minWidth: 220, height: 28, borderWidth: 1, borderStyle: "solid", borderRadius: 8, background: "var(--enki-paper-2)", color: "var(--enki-ink)", fontSize: 11.5, padding: "0 9px", fontFamily: MONO, outline: "none" }} />
                    <Pill kind="green" label="Invite wallet" onClick={() => { if (invWallet.trim()) void grant({ action: "inviteWallet", address: invWallet }, invWallet.trim()).then((ok) => { if (ok) setInvWallet(""); }); }} />
                    <input className="kit-ring" placeholder="Invite an X account (numeric id)" value={invX} onChange={(e) => setInvX(e.target.value)} style={{ flex: 1, minWidth: 180, height: 28, borderWidth: 1, borderStyle: "solid", borderRadius: 8, background: "var(--enki-paper-2)", color: "var(--enki-ink)", fontSize: 11.5, padding: "0 9px", fontFamily: MONO, outline: "none" }} />
                    <Pill kind="green" label="Invite X" onClick={() => { if (invX.trim()) void grant({ action: "inviteX", xId: invX }, `X account ${invX.trim()}`).then((ok) => { if (ok) setInvX(""); }); }} />
                  </div>
                  <div style={cardStyle}>
                    {d.access.requests.length === 0 && <div style={{ padding: 30, textAlign: "center", fontSize: 12, color: "var(--enki-ink-3)" }}>No pending requests.</div>}
                    {d.access.requests.map((r) => (
                      <div key={r.id} style={rowStyle}>
                        <span style={{ width: 210, fontSize: 12.5, fontWeight: 600, color: "var(--enki-ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.email}</span>
                        <span title={r.about} style={{ flex: 1, minWidth: 0, fontSize: 11.5, color: "var(--enki-ink-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.about}</span>
                        <span style={{ width: 160, fontSize: 11, color: "var(--enki-ink-3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.socials ?? "—"}</span>
                        <Pill kind="green" label="Approve" onClick={() => void grant({ action: "approve", id: r.id }, r.email)} />
                        <Pill kind="red" label="Reject" onClick={() => void grant({ action: "reject", id: r.id }, r.email)} />
                      </div>
                    ))}
                  </div>
                  <div style={{ fontSize: 11, fontWeight: 600, color: "var(--enki-ink-3)", margin: "16px 2px 6px" }}>On the access list</div>
                  <div style={cardStyle}>
                    {d.access.allowlist.length === 0 && <div style={{ padding: 30, textAlign: "center", fontSize: 12, color: "var(--enki-ink-3)" }}>Nobody yet.</div>}
                    {d.access.allowlist.map((r) => (
                      <div key={r.id} style={rowStyle}>
                        <Badge pal={r.kind === "email" ? PILL.blue : PILL.purple} label={r.kind} />
                        <span style={{ flex: 1, minWidth: 0, fontFamily: MONO, fontSize: 10.5, color: "var(--enki-ink-2)", overflow: "hidden", textOverflow: "ellipsis" }}>{r.value}</span>
                        <span style={{ width: 120, fontSize: 11, color: "var(--enki-ink-3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.note ?? "—"}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {/* ── TRIALS: the owner's trial codes (Kev, 2026-10-26) ── */}
              {tab === "trials" && d.trials && (!d.trials.ready ? (
                <div style={{ ...cardStyle, padding: "26px 18px", textAlign: "center", fontSize: 12.5, color: "var(--enki-ink-3)" }}>
                  Run <span style={{ fontFamily: MONO }}>sql-to-run/38-trial-codes.sql</span> first.
                </div>
              ) : (
                <div className="trl">
                  <style>{TRIAL_CSS}</style>
                  <div style={{ ...cardStyle, padding: "14px 16px", marginBottom: 12 }}>
                    <div style={{ fontFamily: SERIF, fontStyle: "italic", fontSize: 17, color: "var(--enki-ink)", marginBottom: 4 }}>New code.</div>
                    <p style={{ margin: "0 0 10px", fontSize: 11.5, color: "var(--enki-ink-3)", lineHeight: 1.55 }}>
                      A tester types the code at /gate and signs in with their own account; an account redeems a code once. The trial ends when its minutes pass or the code expires, whichever comes first, and every render spends the budget at the full price the tester sees.
                    </p>
                    <div className="trl-form">
                      <label className="trl-wide" style={huLabel}>Note
                        <input value={tr.note} maxLength={120} placeholder="Who it is for" onChange={(e) => setTr({ note: e.target.value })} style={huInput} />
                      </label>
                      <div style={huLabel}>
                        <span>Uses</span>
                        <span style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
                          <input type="number" inputMode="numeric" min={1} max={100000} aria-label="Uses" value={tr.uses} disabled={tr.unlimited} onChange={(e) => setTr({ uses: e.target.value })} style={{ ...huInput, flex: "1 1 60px", minWidth: 0, opacity: tr.unlimited ? 0.5 : 1 }} />
                          <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, color: "var(--enki-ink)", cursor: "pointer", whiteSpace: "nowrap" }}>
                            <input type="checkbox" checked={tr.unlimited} onChange={(e) => setTr({ unlimited: e.target.checked })} style={{ accentColor: "var(--enki-ember, #c96838)" }} />
                            Unlimited
                          </label>
                        </span>
                      </div>
                      <div style={huLabel}>
                        <span>Minutes of access</span>
                        <select aria-label="Minutes of access" value={tr.minutes} onChange={(e) => setTr({ minutes: e.target.value })} style={huInput}>
                          {TRIAL_MINUTES.map((m) => <option key={m} value={String(m)}>{minutesLabel(m)}</option>)}
                          <option value="custom">Custom</option>
                        </select>
                        {tr.minutes === "custom" && (
                          <input type="number" inputMode="numeric" min={5} max={43200} placeholder="5 to 43,200 minutes" aria-label="Custom minutes of access" value={tr.customMinutes} onChange={(e) => setTr({ customMinutes: e.target.value })} style={huInput} />
                        )}
                      </div>
                      <div style={huLabel}>
                        <span>Budget per tester</span>
                        <select aria-label="Budget per tester" value={tr.budget} onChange={(e) => setTr({ budget: e.target.value })} style={huInput}>
                          {TRIAL_BUDGETS.map((b) => <option key={b} value={b}>${b}</option>)}
                          <option value="custom">Custom</option>
                        </select>
                        {tr.budget === "custom" && (
                          <input type="number" inputMode="decimal" min={0} max={1000} step={0.01} placeholder="USD, 0 to 1,000" aria-label="Custom budget per tester in USD" value={tr.customBudget} onChange={(e) => setTr({ customBudget: e.target.value })} style={huInput} />
                        )}
                      </div>
                      <div className="trl-wide" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
                        <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, color: "var(--enki-ink)", cursor: "pointer" }}>
                          <input type="checkbox" checked={tr.expires} onChange={(e) => setTr({ expires: e.target.checked })} style={{ accentColor: "var(--enki-ember, #c96838)" }} />
                          Expires
                        </label>
                        {tr.expires && (
                          <input type="datetime-local" aria-label="Expires at" value={tr.expiry} onChange={(e) => setTr({ expiry: e.target.value })} style={{ ...huInput, width: "auto", flex: "1 1 200px", minWidth: 0, maxWidth: 260 }} />
                        )}
                        <span style={{ marginLeft: "auto" }}>
                          <Pill kind="green" label={trBusy ? "Creating…" : "Create code"} onClick={() => void createTrial()} />
                        </span>
                      </div>
                    </div>
                  </div>
                  {trCode && (
                    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px 12px", border: "1px solid var(--enki-ember)", background: "rgba(var(--ember-rgb), 0.08)", borderRadius: 12, padding: "12px 14px", marginBottom: 12 }}>
                      <span style={{ fontFamily: MONO, fontSize: 18, fontWeight: 700, letterSpacing: "0.06em", color: "var(--enki-ink)", overflowWrap: "anywhere", userSelect: "all" }}>{trCode}</span>
                      <Pill kind="green" label="Copy" onClick={() => void copyCode(trCode)} />
                      <span style={{ flexBasis: "100%", fontSize: 11.5, color: "var(--enki-ink-2)" }}>Shown once. Copy it now.</span>
                    </div>
                  )}
                  <div style={{ ...cardStyle, padding: "2px 14px 6px" }}>
                    {d.trials.codes.length === 0 ? (
                      <div style={{ padding: 30, textAlign: "center", fontSize: 12, color: "var(--enki-ink-3)" }}>No codes yet.</div>
                    ) : (
                      <table className="trl-table">
                        <thead>
                          <tr><th>Note</th><th>Uses</th><th>Access</th><th>Expiry</th><th>Budget</th><th>Created</th><th>Status</th><th /></tr>
                        </thead>
                        {d.trials.codes.map((t) => {
                          const status = trialStatus(t);
                          const running = runningTrials(t);
                          return (
                            <tbody key={t.id}>
                              <tr>
                                <td data-label="Note" style={{ color: "var(--enki-ink)", fontWeight: 600 }}>{t.note ?? "—"}</td>
                                <td data-label="Uses" style={{ fontFamily: MONO, whiteSpace: "nowrap" }}>{t.uses} / {t.maxUses ?? "∞"}</td>
                                <td data-label="Access" style={{ whiteSpace: "nowrap" }}>{minutesLabel(t.accessMinutes)}</td>
                                <td data-label="Expiry">{t.expiresAt ? when(t.expiresAt) : "never"}</td>
                                <td data-label="Budget" style={{ fontFamily: MONO }}>{usd(t.budgetMicro)}</td>
                                <td data-label="Created" style={{ whiteSpace: "nowrap" }}>{timeAgo(t.createdAt)} ago</td>
                                <td data-label="Status"><Badge pal={TRIAL_PAL[status]} label={status} /></td>
                                <td>
                                  {/* Used up takes no new tester, but its running trials can still be ended. */}
                                  {(status === "active" || status === "used up") && (
                                    <Pill kind="red" label="Revoke" onClick={() => {
                                      if (!window.confirm(`Revoke this code? Nobody can redeem it any more${running ? `, and ${running === 1 ? "its running trial ends" : `its ${running} running trials end`} now` : ""}.`)) return;
                                      void post({ resource: "trial", action: "revoke", id: t.id }, "Code revoked.", (cur) => cur).then((ok) => { if (ok) void reload(); });
                                    }} />
                                  )}
                                </td>
                              </tr>
                              {t.testers.length > 0 && (
                                <tr className="trl-testers">
                                  <td colSpan={8}>
                                    {t.testers.map((x) => {
                                      const end = trialEnd(t, x);
                                      return (
                                        <div key={x.userId} style={{ display: "flex", flexWrap: "wrap", gap: "2px 10px", fontSize: 11, color: "var(--enki-ink-3)", padding: "3px 0 3px 10px", borderLeft: `2px solid ${PILL.blue.border}` }}>
                                          <span style={{ fontFamily: MONO, color: "var(--enki-ink)", overflowWrap: "anywhere" }}>{x.handle ? `@${x.handle}` : x.email ?? x.userId.slice(0, 8)}</span>
                                          {x.handle && x.email && <span style={{ fontFamily: MONO, overflowWrap: "anywhere" }}>{x.email}</span>}
                                          <span>started {when(x.startedAt)}</span>
                                          <span>{trialOver(end) ? "ended" : "ends"} {when(new Date(end).toISOString())}</span>
                                          <span style={{ fontFamily: MONO, color: "var(--enki-ink-2)" }}>{usd(x.spentMicro)} of {usd(t.budgetMicro)}</span>
                                        </div>
                                      );
                                    })}
                                  </td>
                                </tr>
                              )}
                            </tbody>
                          );
                        })}
                      </table>
                    )}
                  </div>
                </div>
              ))}

              {/* ── HUNTER TRUST ── */}
              {tab === "hunters" && (
                <div style={cardStyle}>
                  {d.hunters.length === 0 && <div style={{ padding: 30, textAlign: "center", fontSize: 12, color: "var(--enki-ink-3)" }}>No hunter activity yet.</div>}
                  {d.hunters.map((r) => {
                    const score = r.total > 0 ? Math.round((r.approved / r.total) * 100) : 0;
                    const col = score >= 80 ? "var(--enki-turq)" : score >= 50 ? "var(--enki-ember)" : "var(--enki-danger)";
                    return (
                      <div key={r.handle} style={{ ...rowStyle, gap: 12, padding: "10px 0" }}>
                        <span style={{ width: 110, fontFamily: MONO, fontSize: 11.5, fontWeight: 700, color: "var(--enki-ink)" }}>@{r.handle}</span>
                        <span style={{ width: 66, fontSize: 11, color: "var(--enki-ink-3)" }}>{r.total} total</span>
                        <Badge pal={PILL.green} label={`${r.approved} ✓`} />
                        <Badge pal={PILL.red} label={`${r.denied} ✗`} />
                        <span style={{ flex: 1, minWidth: 60, height: 5, borderRadius: 3, background: "var(--enki-rule-2, var(--enki-rule))", overflow: "hidden" }}>
                          <span style={{ display: "block", height: "100%", width: `${score}%`, background: col, borderRadius: 3 }} />
                        </span>
                        <span style={{ fontFamily: MONO, fontSize: 10, fontWeight: 700, color: col }}>{score}%</span>
                        <span style={{ width: 56, textAlign: "right", fontFamily: MONO, fontSize: 12, fontWeight: 700, color: "var(--enki-ember)" }}>{dollars(r.earningsCents)}</span>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* ── STRIKES & BANS ── */}
              {tab === "strikes" && (
                <div style={cardStyle}>
                  {d.strikes.length === 0 && <div style={{ padding: 30, textAlign: "center", fontSize: 12, color: "var(--enki-ink-3)" }}>No active strikes, bans or appeals ✓</div>}
                  {d.strikes.map((r) => {
                    const n = r.strikes.length;
                    return (
                      <div key={r.userId}>
                        <div style={rowStyle}>
                          <span style={{ width: 116, fontFamily: MONO, fontSize: 11.5, fontWeight: 700, color: "var(--enki-ink)", overflow: "hidden", textOverflow: "ellipsis" }}>@{r.handle}</span>
                          <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                            {[0, 1, 2].map((i) => <span key={i} style={{ width: 9, height: 9, borderRadius: "50%", background: i < Math.min(n, 3) ? "var(--enki-danger)" : "var(--enki-rule-2, var(--enki-rule))" }} />)}
                            <span style={{ fontFamily: MONO, fontSize: 9, color: "var(--enki-ink-3)", marginLeft: 2 }}>{n}/3</span>
                          </span>
                          <Badge pal={r.banned ? PILL.red : { bg: "var(--enki-paper-2)", ink: "var(--enki-ink-2)" } as { bg: string; ink: string }} label={r.permanent ? "permbanned" : r.banned ? "banned" : "active"} />
                          <span style={{ flex: 1, minWidth: 0, fontSize: 11, color: "var(--enki-ink-3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.note ?? "—"}</span>
                          {r.appeal && (
                            <button onClick={() => setAppealOpen((v) => (v === r.userId ? null : r.userId))} style={{ padding: "3px 9px", borderRadius: 999, border: `1px solid ${PILL.purple.border}`, background: PILL.purple.bg, color: PILL.purple.ink, fontSize: 9.5, fontWeight: 600, cursor: "pointer" }}>
                              Appeal filed
                            </button>
                          )}
                          {n > 0 && (
                            <Pill kind="plain" label="Revoke" title="Revoke the newest active strike"
                              onClick={() => void post({ resource: "strikes", action: "revoke", id: r.strikes[0].id }, `Strike revoked for @${r.handle}.`, (cur) => ({
                                ...cur,
                                strikes: cur.strikes
                                  .map((x) => (x.userId === r.userId ? { ...x, strikes: x.strikes.slice(1) } : x))
                                  .filter((x) => x.strikes.length > 0 || x.banned || x.appeal),
                              }))} />
                          )}
                          {!r.banned && (
                            <Pill kind="red" label={c.enabled ? "Propose ban" : "Ban 7d"} title={c.enabled ? "Propose a 7-day ban to the council" : "Full ban, expires in 7 days"}
                              onClick={() => c.enabled
                                ? void post({ resource: "council", action: "propose", kind: "ban_temp", days: 7, userId: r.userId, violation: r.note ?? "Repeated strikes" }, "Proposal sent — council notified.", (cur) => cur)
                                : void post({ resource: "bans", action: "ban", userId: r.userId, days: 7 }, `@${r.handle} banned for 7 days.`, (cur) => ({
                                    ...cur, strikes: cur.strikes.map((x) => (x.userId === r.userId ? { ...x, banned: true, permanent: false } : x)),
                                  }))} />
                          )}
                          {!r.permanent && (
                            <Pill kind="red" label={c.enabled ? "Propose permban" : "Permban"} title={c.enabled ? "Propose a permanent ban to the council" : "Full ban, no expiry"}
                              onClick={() => c.enabled
                                ? void post({ resource: "council", action: "propose", kind: "ban_perm", userId: r.userId, violation: r.note ?? "Repeated strikes" }, "Proposal sent — council notified.", (cur) => cur)
                                : void post({ resource: "bans", action: "ban", userId: r.userId, permanent: true }, `@${r.handle} permanently banned.`, (cur) => ({
                                    ...cur, strikes: cur.strikes.map((x) => (x.userId === r.userId ? { ...x, banned: true, permanent: true } : x)),
                                  }))} />
                          )}
                          {r.banned && (
                            <Pill kind="green" label="Reinstate" title="Lift the active ban"
                              onClick={() => void post({ resource: "bans", action: "lift", userId: r.userId }, `@${r.handle} reinstated.`, (cur) => ({
                                ...cur,
                                strikes: cur.strikes
                                  .map((x) => (x.userId === r.userId ? { ...x, banned: false, permanent: false } : x))
                                  .filter((x) => x.strikes.length > 0 || x.banned || x.appeal),
                              }))} />
                          )}
                        </div>
                        {appealOpen === r.userId && r.appeal && (
                          <div style={{ padding: "2px 0 12px 10px", borderLeft: `3px solid ${PILL.purple.border}`, margin: "0 0 8px 4px" }}>
                            {r.appeal.against && (
                              <span style={{ display: "block", marginBottom: 6, fontFamily: MONO, fontSize: 10, color: "var(--enki-ink-3)" }}>
                                Against: {r.appeal.against.reason ?? "no reason"} · {r.appeal.against.until ? `until ${r.appeal.against.until.slice(0, 10)}` : "for good"}
                              </span>
                            )}
                            <span style={{ ...microLabel, display: "block", marginBottom: 4 }}>Appeal note</span>
                            <p style={{ margin: 0, fontSize: 12, fontStyle: "italic", color: "var(--enki-ink-2)", lineHeight: 1.6, maxWidth: 640 }}>
                              “{r.appeal.note ?? "No statement provided."}”
                            </p>
                            <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                              <Pill kind="green" label="Approve" title="Approve the appeal — the appealed strike/ban is undone" onClick={() => {
                                const apId = r.appeal!.id;
                                setAppealOpen(null);
                                void (async () => {
                                  const ok = await post({ resource: "appeals", action: "approve", id: apId }, "Appeal approved — the strike/ban was undone.", (cur) => cur);
                                  // the server revoked/lifted the target — re-fetch so the row reflects it
                                  if (ok) await reload();
                                })();
                              }} />
                              <Pill kind="red" label="Deny" onClick={() => {
                                const apId = r.appeal!.id;
                                setAppealOpen(null);
                                void post({ resource: "appeals", action: "deny", id: apId }, "Appeal denied.", (cur) => ({
                                  ...cur,
                                  strikes: cur.strikes
                                    .map((x) => (x.userId === r.userId ? { ...x, appeal: null } : x))
                                    .filter((x) => x.strikes.length > 0 || x.banned || x.appeal),
                                }));
                              }} />
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* ── PEOPLE: one row per person, every warning and failure on expanding ── */}
              {tab === "people" && (
                <div style={cardStyle}>
                  {filteredPeople.length === 0 && (
                    <div style={{ padding: 30, textAlign: "center", fontSize: 12, color: "var(--enki-ink-3)" }}>
                      {d.people.length === 0 ? "Nobody was warned, blocked or failed this week ✓" : "Nothing matches that search."}
                    </div>
                  )}
                  {filteredPeople.map((p) => {
                    const detail = pplDetail[p.key];
                    const name = p.handle ? `@${p.handle}` : p.displayName ?? (p.userId ? p.userId.slice(0, 8) : `no account · ${p.ipHash?.slice(0, 8)}`);
                    return (
                      <div key={p.key}>
                        <div style={{ ...rowStyle, cursor: "pointer" }} onClick={() => void openPerson(p.key)}>
                          <span style={{ width: 130, fontFamily: MONO, fontSize: 11.5, fontWeight: 700, color: "var(--enki-ink)", overflow: "hidden", textOverflow: "ellipsis" }}>{name}</span>
                          {p.childSafety && <Badge pal={PILL.red} label="child safety" />}
                          <span style={{ fontFamily: MONO, fontSize: 10, color: p.warnings > 0 ? "var(--enki-danger)" : "var(--enki-ink-3)" }}>{p.warnings} warnings</span>
                          {p.extractionHits > 0 && <span style={{ fontFamily: MONO, fontSize: 10, color: "var(--enki-ember)" }}>{p.extractionHits} extraction</span>}
                          {p.failed7d > 0 && <span style={{ fontFamily: MONO, fontSize: 10, color: "var(--enki-ink-2)" }}>{p.failed7d} failed (7d)</span>}
                          {p.pending > 0 && <Badge pal={PILL.purple} label={`${p.pending} to review`} />}
                          {p.suspension && <Badge pal={PILL.red} label={p.suspension.until ? `suspended until ${p.suspension.until.slice(0, 10)}` : "suspended for good"} />}
                          <span style={{ flex: 1 }} />
                          {p.suspension && p.userId && (
                            <span onClick={(e) => e.stopPropagation()}>
                              <Pill kind="green" label="Lift" title="Lift the running suspension"
                                onClick={() => void act({ resource: "bans", action: "lift", userId: p.userId }, `${name} reinstated.`, p.key)} />
                            </span>
                          )}
                          <span style={{ width: 52, textAlign: "right", fontFamily: MONO, fontSize: 9, color: "var(--enki-ink-3)" }}>{p.lastActive ? timeAgo(p.lastActive) : "—"}</span>
                        </div>
                        {pplOpen === p.key && (
                          <div style={{ padding: "4px 0 14px 10px", borderLeft: "3px solid var(--enki-rule)", margin: "0 0 8px 4px", display: "flex", flexDirection: "column", gap: 10 }}>
                            {!detail && <span style={{ fontSize: 11, color: "var(--enki-ink-3)" }}>Loading…</span>}
                            {detail && detail.events.length === 0 && detail.failures.length === 0 && <span style={{ fontSize: 11, color: "var(--enki-ink-3)" }}>No events.</span>}
                            {detail?.events.map((e) => (
                              <div key={e.id} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                                  <Badge pal={e.category && ["minor_sexual", "sexual/minors", "csam"].includes(e.category) ? PILL.red : PILL.purple} label={e.category ?? e.severity} />
                                  <span style={{ fontFamily: MONO, fontSize: 9.5, color: "var(--enki-ink-3)" }}>
                                    {e.surface}{e.weight ? ` · weight ${e.weight}` : ""}{e.confidence !== null ? ` · ${e.confidence.toFixed(2)}` : ""}{e.rules.length ? ` · ${e.rules.join(", ")}` : ""} · {e.state} · {timeAgo(e.at)}
                                  </span>
                                  {e.state !== "overturned" && e.state !== "upheld" && (
                                    <>
                                      {!e.imageCase && (
                                        <Pill kind="plain" label="Overturn" title="Wrongly caught: take it out of every count"
                                          onClick={() => void act({ resource: "automod", action: "overturn", id: e.id }, "Overturned.", p.key)} />
                                      )}
                                      <Pill kind="plain" label="Mark reviewed" title="Correctly caught"
                                        onClick={() => void act({ resource: "automod", action: "uphold", id: e.id }, "Marked reviewed.", p.key)} />
                                    </>
                                  )}
                                  {/* In any state: an image case overturned before clearances existed cleared nothing, and one upheld may be cleared later. */}
                                  {e.imageCase && e.cleared && (
                                    <Pill kind="plain" label="Take back clearance" title="This image counts as unreviewed again, and a prompt it was published to is taken down"
                                      onClick={() => void act({ resource: "automod", action: "uphold", id: e.id }, "Clearance taken back.", p.key)} />
                                  )}
                                  {e.imageCase && !e.cleared && data?.council.isOwner && (
                                    <>
                                      <Pill kind="plain" label="Overturn: false alarm" title="Wrongly caught: clear exactly this image"
                                        onClick={() => void act({ resource: "automod", action: "overturn", id: e.id }, "Cleared.", p.key)} />
                                      <span style={{ fontSize: 11, fontStyle: "italic", color: "var(--enki-ink-3)" }}>Look at the image first. Clearing lets exactly this image through on import.</span>
                                    </>
                                  )}
                                </div>
                                {(e.prompt !== null || !e.withheld) && <p style={{ margin: 0, fontFamily: MONO, fontSize: 11, color: "var(--enki-ink-2)", whiteSpace: "pre-wrap", wordBreak: "break-word", maxWidth: 760 }}>{e.prompt ?? "Not readable."}</p>}
                                {e.withheld && withheldBlock(e.id, e.draft, e.revealable)}
                                {e.rules.includes("image-check") && imageBlock(e.id)}
                              </div>
                            ))}
                            {detail?.failures.map((x) => (
                              <div key={x.id} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                                {/* eslint-disable-next-line @next/next/no-img-element -- admin-only thumbnail of a stored image */}
                                {x.imageUrl && <img src={x.imageUrl} alt="" style={{ width: 64, height: 64, objectFit: "cover", borderRadius: 6 }} />}
                                <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
                                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                                    <Badge pal={PILL.red} label="failed" />
                                    <span style={{ fontFamily: MONO, fontSize: 9.5, color: "var(--enki-ink-3)" }}>
                                      {x.surface} · {x.model ?? "?"} · {x.resolution ?? "?"}{x.quality ? ` · ${x.quality}` : ""}{x.boost ? " · boost" : ""}{x.aspectRatio ? ` · ${x.aspectRatio}` : ""}{x.referenceImageCount ? ` · ${x.referenceImageCount} refs` : ""} · {timeAgo(x.at)}
                                    </span>
                                  </div>
                                  <span style={{ fontSize: 11, color: "var(--enki-danger)", wordBreak: "break-word" }}>{x.error}</span>
                                  <p style={{ margin: 0, fontFamily: MONO, fontSize: 11, color: "var(--enki-ink-2)", whiteSpace: "pre-wrap", wordBreak: "break-word", maxWidth: 760 }}>{x.prompt ?? (x.draft ? "Marked by the requester as their own editor draft; its text is not stored." : "Not readable.")}</p>
                                  {x.txSignature && <span style={{ fontFamily: MONO, fontSize: 9, color: "var(--enki-ink-3)" }}>paid: {x.txSignature}</span>}
                                </div>
                              </div>
                            ))}
                            {detail && detail.bans.length > 0 && (
                              <span style={{ fontFamily: MONO, fontSize: 9.5, color: "var(--enki-ink-3)" }}>
                                Bans: {detail.bans.map((b) => `${b.at.slice(0, 10)} ${b.liftedAt ? "lifted" : b.expiresAt ? `until ${b.expiresAt.slice(0, 10)}` : "for good"}`).join(" · ")}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* ── ADMIN LOG (admins only) ── */}
              {tab === "adminlog" && d.adminLog && (
                <div style={cardStyle}>
                  {!d.adminLog.ready && (
                    <div style={{ padding: 30, textAlign: "center", fontSize: 12, color: "var(--enki-ink-3)" }}>
                      The admin log starts once its migration ran (sql-to-run/31).
                    </div>
                  )}
                  {d.adminLog.ready && d.adminLog.rows.length === 0 && (
                    <div style={{ padding: 30, textAlign: "center", fontSize: 12, color: "var(--enki-ink-3)" }}>Nothing recorded yet.</div>
                  )}
                  {d.adminLog.rows.map((r) => (
                    <div key={r.id} style={rowStyle}>
                      <span style={{ width: 150, fontFamily: MONO, fontSize: 11, color: "var(--enki-ink)" }}>{r.action}</span>
                      <span style={{ flex: 1, minWidth: 0, fontFamily: MONO, fontSize: 10, color: "var(--enki-ink-2)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {r.target ?? "—"}{Object.keys(r.detail).length ? ` · ${JSON.stringify(r.detail)}` : ""}
                      </span>
                      <span style={{ width: 110, fontFamily: MONO, fontSize: 9.5, color: "var(--enki-ink-3)", overflow: "hidden", textOverflow: "ellipsis" }}>@{r.actor} · {r.role}</span>
                      <span style={{ width: 40, textAlign: "right", fontFamily: MONO, fontSize: 9, color: "var(--enki-ink-3)" }}>{timeAgo(r.at)}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* ── AUTO-FILTER LOG ── */}
              {tab === "automod" && (
                <div style={cardStyle}>
                  {filteredAutomod.length === 0 && (
                    <div style={{ padding: 30, textAlign: "center", fontSize: 12, color: "var(--enki-ink-3)" }}>
                      {d.automod.length === 0 ? "The filter hasn't blocked anything ✓" : "Nothing matches that search."}
                    </div>
                  )}
                  {filteredAutomod.map((r) => (
                    <div key={r.id}>
                      <div
                        style={{ ...rowStyle, cursor: "pointer" }}
                        onClick={() => setAmOpen(amOpen === r.id ? null : r.id)}
                      >
                        <span style={{ width: 30, textAlign: "center", fontFamily: MONO, fontSize: 15, fontWeight: 700, color: r.severity === "review" ? "var(--enki-danger)" : "var(--enki-ink-3)" }}>
                          {r.tier === 1 ? "1" : r.tier === 2 ? "2" : "—"}
                        </span>
                        <span style={{ flex: 1, minWidth: 0, fontFamily: SERIF, fontSize: 14, color: "var(--enki-ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {r.category ?? "blocked"}
                        </span>
                        <Badge pal={r.severity === "review" ? PILL.red : PILL.amber} label={r.severity} />
                        <span style={{ width: 96, fontFamily: MONO, fontSize: 10, color: "var(--enki-ink-2)", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {r.topScore ? `${r.topScore.name.split("/").pop()} ${r.topScore.value.toFixed(2)}` : r.rules[0] ?? "—"}
                        </span>
                        <span style={{ width: 76, fontFamily: MONO, fontSize: 9.5, color: "var(--enki-ink-3)", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {r.handle ? "@" + r.handle : "anon"}
                        </span>
                        <span style={{ width: 58, fontFamily: MONO, fontSize: 9, color: "var(--enki-ink-3)", overflow: "hidden" }}>{r.surface.replace("generate-", "")}</span>
                        <span style={{ width: 40, textAlign: "right", fontFamily: MONO, fontSize: 9, color: "var(--enki-ink-3)" }}>{timeAgo(r.at)}</span>
                        {r.state === "pending" && <Badge pal={PILL.amber} label="unreviewed" />}
                      </div>
                      {amOpen === r.id && (
                        <div style={{ padding: "12px 18px 16px", borderBottom: "1px solid var(--enki-rule)", background: "var(--enki-paper-2)" }}>
                          <div style={{ fontFamily: MONO, fontSize: 9.5, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--enki-ink-3)", marginBottom: 6 }}>
                            Blocked prompt
                          </div>
                          <div style={{ fontFamily: SERIF, fontSize: 13.5, lineHeight: 1.5, color: "var(--enki-ink)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                            {r.prompt ?? (r.withheld ? null : <em style={{ color: "var(--enki-ink-3)" }}>Not readable — encrypted with a key this server no longer holds.</em>)}
                          </div>
                          {/* Opened only from the warning and ban list (People), never from this log. */}
                          {r.withheld && <div style={{ marginTop: 6 }}>{withheldBlock(r.id, r.draft, false)}</div>}
                          {r.rules.length > 0 && (
                            <div style={{ marginTop: 10, fontFamily: MONO, fontSize: 10, color: "var(--enki-ink-2)" }}>
                              rules: {r.rules.join(", ")}
                            </div>
                          )}
                          <div style={{ marginTop: 10, fontSize: 11, color: "var(--enki-ink-3)" }}>
                            This row is evidence and is never deleted. Overturn or confirm it per person in People.
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* ── COUNCIL ── */}
              {tab === "council" && (!c.ready ? (
                <div style={{ ...cardStyle, padding: "26px 18px", textAlign: "center", fontSize: 12.5, color: "var(--enki-ink-3)" }}>
                  The council isn&apos;t set up yet — run <span style={{ fontFamily: MONO }}>migrations/2026-07-21-moderation-council.sql</span> in Supabase, then refresh.
                </div>
              ) : (
                <>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, fontFamily: MONO, fontSize: 10, color: "var(--enki-ink-3)" }}>
                    <Badge pal={c.enabled ? PILL.green : PILL.amber} label={c.enabled ? "Council mode ON" : "Council mode OFF"} />
                    <span>quorum {c.quorum} of {c.members.length} · proposals expire after {c.ttlDays}d{c.enabled ? "" : " · while off, proposals execute immediately"}</span>
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 7, border: "1px solid var(--enki-rule-2, var(--enki-rule))", borderRadius: 11, background: "var(--enki-paper)", padding: "10px 12px", marginBottom: 8 }}>
                    <input className="kit-ring" placeholder="@handle" value={cpHandle} onChange={(e) => setCpHandle(e.target.value)} style={{ width: 130, height: 28, borderWidth: 1, borderStyle: "solid", borderRadius: 8, background: "var(--enki-paper-2)", color: "var(--enki-ink)", fontSize: 11.5, padding: "0 9px", fontFamily: MONO, outline: "none" }} />
                    <select value={cpKind} onChange={(e) => setCpKind(e.target.value)} style={{ height: 28, border: "1px solid var(--enki-rule)", borderRadius: 8, background: "var(--enki-paper-2)", color: "var(--enki-ink)", fontSize: 11.5 }}>
                      <option value="ban_temp:7">Ban 7 days</option>
                      <option value="ban_temp:30">Ban 30 days</option>
                      <option value="ban_perm">Permanent ban</option>
                      <option value="ip_ban">IP ban (indefinite)</option>
                    </select>
                    <input className="kit-ring" placeholder="Violation — what rule did they break?" value={cpViolation} onChange={(e) => setCpViolation(e.target.value)} style={{ flex: 1, minWidth: 160, height: 28, borderWidth: 1, borderStyle: "solid", borderRadius: 8, background: "var(--enki-paper-2)", color: "var(--enki-ink)", fontSize: 11.5, padding: "0 9px", outline: "none" }} />
                    <Pill kind="red" label={c.enabled ? "Propose to council" : "Execute now"} onClick={() => {
                      if (!cpHandle.trim() || !cpViolation.trim()) { say("Handle and violation are required."); return; }
                      const [kind, days] = cpKind.split(":");
                      void (async () => {
                        const ok = await post(
                          { resource: "council", action: "propose", kind, days: days ? Number(days) : undefined, handle: cpHandle.trim(), violation: cpViolation.trim() },
                          c.enabled ? "Proposal sent — council notified by email." : "Executed.",
                          (cur) => cur,
                        );
                        if (ok) { setCpHandle(""); setCpViolation(""); await reload(); }
                      })();
                    }} />
                  </div>
                  <div style={cardStyle}>
                    {c.proposals.length === 0 && <div style={{ padding: 30, textAlign: "center", fontSize: 12, color: "var(--enki-ink-3)" }}>No proposals yet.</div>}
                    {c.proposals.map((p) => {
                      const kindLabel = p.kind === "ip_ban" ? "IP ban" : p.kind === "ban_perm" ? "Permban" : `Ban ${p.days ?? 7}d`;
                      const statusPal =
                        p.status === "approved" ? PILL.green
                        : p.status === "denied" ? PILL.red
                        : { bg: "var(--enki-paper-2)", ink: "var(--enki-ink-2)" } as { bg: string; ink: string };
                      return (
                        <div key={p.id} style={rowStyle}>
                          <Badge pal={p.kind === "ban_temp" ? PILL.amber : PILL.red} label={kindLabel} />
                          <span style={{ width: 106, fontFamily: MONO, fontSize: 11.5, fontWeight: 700, color: "var(--enki-ink)", overflow: "hidden", textOverflow: "ellipsis" }}>{p.target}</span>
                          <span style={{ flex: 1, minWidth: 0, fontSize: 11, color: "var(--enki-ink-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={p.violation}>{p.violation}</span>
                          <span style={{ width: 78, fontFamily: MONO, fontSize: 9.5, color: "var(--enki-ink-3)", overflow: "hidden", textOverflow: "ellipsis" }}>by @{p.proposer}</span>
                          <span style={{ fontFamily: MONO, fontSize: 10, color: "var(--enki-ink-2)", whiteSpace: "nowrap" }}>
                            {p.confirms}✓ {p.denies}✗ <span style={{ color: "var(--enki-ink-3)" }}>/ {p.quorum}</span>
                          </span>
                          {p.status === "pending" ? (
                            <span style={{ display: "flex", gap: 5, alignItems: "center" }}>
                              <span style={{ fontFamily: MONO, fontSize: 9, color: "var(--enki-ink-3)" }}>{timeAgo(p.at)}</span>
                              <Pill kind="green" label={p.myVote === "confirm" ? "Confirmed ✓" : "Confirm"}
                                onClick={p.myVote === "confirm" ? undefined : () => void (async () => {
                                  const ok = await post({ resource: "council", action: "vote", id: p.id, vote: "confirm" }, "Vote recorded.", (cur) => cur);
                                  if (ok) await reload();
                                })()} />
                              <Pill kind="red" label={p.myVote === "deny" ? "Denied ✗" : "Deny"}
                                onClick={p.myVote === "deny" ? undefined : () => void (async () => {
                                  const ok = await post({ resource: "council", action: "vote", id: p.id, vote: "deny" }, "Vote recorded.", (cur) => cur);
                                  if (ok) await reload();
                                })()} />
                            </span>
                          ) : (
                            <Badge pal={statusPal} label={p.status} />
                          )}
                        </div>
                      );
                    })}
                  </div>
                </>
              ))}

              {/* ── RECOVERY REQUESTS ── */}
              {tab === "recovery" && (
                <div style={cardStyle}>
                  {filteredRecovery.length === 0 && <div style={{ padding: 30, textAlign: "center", fontSize: 12, color: "var(--enki-ink-3)" }}>No recovery requests.</div>}
                  {filteredRecovery.map((r) => {
                    const statusPal =
                      r.status === "approved" ? PILL.green
                      : r.status === "rejected" ? PILL.red
                      : r.status === "needs_info" ? PILL.amber
                      : { bg: "var(--enki-paper-2)", ink: "var(--enki-ink-2)" } as { bg: string; ink: string };
                    return (
                      <div key={r.id}>
                        <div style={{ ...rowStyle, cursor: "pointer" }} onClick={() => setRecOpen((v) => (v === r.id ? null : r.id))}>
                          <span style={{ width: 112, fontFamily: MONO, fontSize: 11.5, fontWeight: 700, color: "var(--enki-ink)", overflow: "hidden", textOverflow: "ellipsis" }}>@{r.handle}</span>
                          <span style={{ width: 168, fontFamily: MONO, fontSize: 9.5, color: "var(--enki-ink-3)", overflow: "hidden", textOverflow: "ellipsis" }}>{r.contact ?? "—"}</span>
                          <span style={{ flex: 1, display: "flex", gap: 4, flexWrap: "wrap" }}>
                            {r.evidence.length === 0
                              ? <Badge pal={PILL.red} label="minimal evidence" />
                              : r.evidence.map((e, i) => (
                                  <Badge key={i}
                                    pal={e.kind.toLowerCase().includes("zkp") ? PILL.purple : { bg: "var(--enki-paper-2)", ink: "var(--enki-ink-2)" } as { bg: string; ink: string }}
                                    label={e.kind + (e.matched ? " ✓" : "")} />
                                ))}
                          </span>
                          <span style={{ width: 42, textAlign: "right", fontFamily: MONO, fontSize: 9, color: "var(--enki-ink-3)" }}>{timeAgo(r.at)}</span>
                          <Badge pal={statusPal} label={r.status === "needs_info" ? "Needs info" : r.status.charAt(0).toUpperCase() + r.status.slice(1)} />
                          <span style={{ display: "flex", gap: 5 }} onClick={(e) => e.stopPropagation()}>
                            {r.status === "pending" && <>
                              <Pill kind="green" label="Approve" onClick={() => void post({ resource: "recovery", action: "setStatus", id: r.id, status: "approved" }, `Access restored for @${r.handle}.`, (cur) => ({ ...cur, recovery: cur.recovery.map((x) => (x.id === r.id ? { ...x, status: "approved" } : x)) }))} />
                              <Pill kind="plain" label="Need more" onClick={() => void post({ resource: "recovery", action: "setStatus", id: r.id, status: "needs_info" }, "", (cur) => ({ ...cur, recovery: cur.recovery.map((x) => (x.id === r.id ? { ...x, status: "needs_info" } : x)) }))} />
                              <Pill kind="red" label="Reject" onClick={() => void post({ resource: "recovery", action: "setStatus", id: r.id, status: "rejected" }, "", (cur) => ({ ...cur, recovery: cur.recovery.map((x) => (x.id === r.id ? { ...x, status: "rejected" } : x)) }))} />
                            </>}
                            {r.status === "needs_info" && (
                              <Pill kind="plain" label="Re-review" onClick={() => void post({ resource: "recovery", action: "setStatus", id: r.id, status: "pending" }, "", (cur) => ({ ...cur, recovery: cur.recovery.map((x) => (x.id === r.id ? { ...x, status: "pending" } : x)) }))} />
                            )}
                          </span>
                        </div>
                        {recOpen === r.id && (
                          <div style={{ padding: "4px 0 12px 10px", borderLeft: `3px solid ${PILL.blue.border}`, margin: "0 0 8px 4px", display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px 26px", maxWidth: 720 }}>
                            <span><span style={{ ...microLabel, display: "block" }}>Wallet address</span><span style={{ fontSize: 11.5, fontFamily: MONO, color: "var(--enki-ink-2)" }}>{r.wallet ?? "Not submitted"}</span></span>
                            <span><span style={{ ...microLabel, display: "block" }}>Contact</span><span style={{ fontSize: 11.5, fontFamily: MONO, color: "var(--enki-ink-2)" }}>{r.contact ?? "Not submitted"}</span></span>
                            <span style={{ gridColumn: "1 / -1" }}>
                              <span style={{ ...microLabel, display: "block" }}>Explanation</span>
                              <span style={{ fontSize: 12, color: "var(--enki-ink-2)", lineHeight: 1.65, display: "block", maxWidth: 640 }}>{r.explanation ?? "—"}</span>
                            </span>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
              {/* ── COMMUNITIES: the merge queue, read by itself (GET /api/communities/merges) ── */}
              {tab === "communities" && role === "admin" && <MergeQueue />}
              {/* ── ADMIN SETTINGS ── */}
              {tab === "settings" && (!c.ready ? (
                <div style={{ ...cardStyle, padding: "26px 18px", textAlign: "center", fontSize: 12.5, color: "var(--enki-ink-3)" }}>
                  Admin settings need the council tables — run <span style={{ fontFamily: MONO }}>migrations/2026-07-21-moderation-council.sql</span> in Supabase, then refresh.
                </div>
              ) : (
                <>
                  {/* Generation throttle — visible to mods, editable by admins.
                      Slowing the product for everyone is not a moderation call. */}
                  <div style={{ ...cardStyle, padding: "14px 16px", marginBottom: 10, maxWidth: 560 }}>
                    <div style={{ fontFamily: SERIF, fontStyle: "italic", fontSize: 17, color: "var(--enki-ink)", marginBottom: 4 }}>Generation limit.</div>
                    <p style={{ margin: "0 0 10px", fontSize: 11.5, color: "var(--enki-ink-3)", lineHeight: 1.55 }}>
                      How many generations one user may have running at the same time. Empty means
                      unlimited, which is how it ships. {d.generation.canEdit
                        ? "Takes effect immediately — no deploy."
                        : "Admins only — you can see it, but not change it."}
                    </p>
                    <div style={{ display: "flex", gap: 7, alignItems: "center" }}>
                      <input
                        className="kit-ring"
                        type="number" min={1} max={100} placeholder="unlimited"
                        value={genLimit}
                        disabled={!d.generation.canEdit}
                        onChange={(e) => setGenLimit(e.target.value)}
                        style={{ width: 120, height: 30, borderWidth: 1, borderStyle: "solid", borderRadius: 8, background: "var(--enki-paper-2)", color: "var(--enki-ink)", fontSize: 11.5, padding: "0 9px", fontFamily: MONO, outline: "none", opacity: d.generation.canEdit ? 1 : 0.5 }}
                      />
                      {d.generation.canEdit && (
                        <Pill kind="green" label="Save" onClick={() => {
                          const raw = genLimit.trim();
                          const value = raw === "" ? null : Number(raw);
                          void post(
                            { resource: "generation", action: "setConcurrency", maxConcurrentPerUser: value },
                            value === null ? "Generation limit removed — unlimited." : `Limit set to ${value} at a time.`,
                            (cur) => ({ ...cur, generation: { ...cur.generation, maxConcurrentPerUser: value } }),
                          );
                        }} />
                      )}
                    </div>
                  </div>

                  <div style={{ ...cardStyle, padding: "14px 16px", marginBottom: 10, maxWidth: 560 }}>
                    <div style={{ fontFamily: SERIF, fontStyle: "italic", fontSize: 17, color: "var(--enki-ink)", marginBottom: 4 }}>Council notifications.</div>
                    <p style={{ margin: "0 0 10px", fontSize: 11.5, color: "var(--enki-ink-3)", lineHeight: 1.55 }}>
                      Council vote requests and new feedback are mailed here. Stored encrypted — leave empty to opt out of emails (you still vote in this panel).
                    </p>
                    <div style={{ display: "flex", gap: 7 }}>
                      <input className="kit-ring" placeholder="you@example.com" value={seEmail} onChange={(e) => setSeEmail(e.target.value)} style={{ flex: 1, height: 30, borderWidth: 1, borderStyle: "solid", borderRadius: 8, background: "var(--enki-paper-2)", color: "var(--enki-ink)", fontSize: 11.5, padding: "0 9px", fontFamily: MONO, outline: "none" }} />
                      <Pill kind="green" label="Save" onClick={() => {
                        const email = seEmail.trim();
                        void post({ resource: "prefs", action: "setEmail", email }, email ? "Notification email saved." : "Notification email cleared.",
                          (cur) => ({ ...cur, council: { ...cur.council, myEmail: email || null } }));
                      }} />
                    </div>
                  </div>
                  {c.isOwner && (
                    <div style={{ ...cardStyle, padding: "14px 16px", maxWidth: 560 }}>
                      <div style={{ fontFamily: SERIF, fontStyle: "italic", fontSize: 17, color: "var(--enki-ink)", marginBottom: 4 }}>Moderation policy.</div>
                      <p style={{ margin: "0 0 10px", fontSize: 11.5, color: "var(--enki-ink-3)", lineHeight: 1.55 }}>
                        Owner only. With council mode on, no single admin can ban — every ban executes only after the quorum confirms it.
                      </p>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", marginBottom: 10 }}>
                        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--enki-ink)", cursor: "pointer" }}>
                          <input type="checkbox" checked={polEnabled} onChange={(e) => setPolEnabled(e.target.checked)} style={{ accentColor: "var(--enki-ember, #c96838)" }} />
                          Council mode
                        </label>
                        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--enki-ink-2)" }}>
                          Quorum
                          <input type="number" min={1} max={20} value={polQuorum} onChange={(e) => setPolQuorum(e.target.value)} style={{ width: 54, height: 28, border: "1px solid var(--enki-rule)", borderRadius: 8, background: "var(--enki-paper-2)", color: "var(--enki-ink)", fontSize: 11.5, padding: "0 7px" }} />
                        </label>
                        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--enki-ink-2)" }}>
                          Expiry (days)
                          <input type="number" min={1} max={30} value={polTtl} onChange={(e) => setPolTtl(e.target.value)} style={{ width: 54, height: 28, border: "1px solid var(--enki-rule)", borderRadius: 8, background: "var(--enki-paper-2)", color: "var(--enki-ink)", fontSize: 11.5, padding: "0 7px" }} />
                        </label>
                        <Pill kind="green" label="Save policy" onClick={() => void (async () => {
                          const ok = await post({ resource: "policy", action: "set", enabled: polEnabled, quorum: Number(polQuorum), ttlDays: Number(polTtl) }, "Policy saved.", (cur) => cur);
                          if (ok) await reload();
                        })()} />
                      </div>
                      {Number(polQuorum) > c.members.length && (
                        <p style={{ margin: "0 0 8px", fontSize: 11, color: "var(--enki-danger)" }}>
                          Quorum is larger than the council ({c.members.length} member{c.members.length === 1 ? "" : "s"}) — no proposal can pass until more admins exist.
                        </p>
                      )}
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                        {c.members.map((m) => (
                          <span key={m.handle} style={{ display: "inline-flex", alignItems: "center", gap: 5, border: "1px solid var(--enki-rule)", borderRadius: 999, padding: "3px 9px", fontSize: 10.5, fontFamily: MONO, color: "var(--enki-ink-2)" }}>
                            @{m.handle} · {m.role}{m.hasEmail ? " · ✉ ok" : " · no email"}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              ))}
            </>
          )}
        </div>
      </div>

      {/* A find's picture full screen at X's original size; a click or Escape closes it (Kev, 2026-10-31: "MAXIMIZES SO THAT I CAN SEE IT IN MAX RESOLUTION"). */}
      {impZoom && (
        <div role="dialog" aria-label="Picture, full screen" onClick={() => setImpZoom(null)}
          style={{ position: "fixed", inset: 0, zIndex: 90, background: "rgb(0 0 0 / 0.92)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "zoom-out" }}>
          {/* eslint-disable-next-line @next/next/no-img-element -- X's picture at its original size */}
          <img src={origOf(impZoom)} alt="" style={{ maxWidth: "100vw", maxHeight: "100vh", objectFit: "contain" }} />
        </div>
      )}
      {(crPlaying || crListing) && (
        <div role="status" aria-live="polite" style={{ position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 60, padding: "8px 16px", background: "var(--enki-ink)", color: "var(--enki-paper)", fontFamily: MONO, fontSize: 11, display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
          <span>●</span>
          <span style={{ flex: "1 1 260px", minWidth: 0, overflowWrap: "anywhere" }}>{crListing ?? crNow ?? `Starting @${crPlaying}…`}</span>
          {crLive && crPlaying === crLive.handle && <span style={{ opacity: 0.7 }}>{crLive.text}</span>}
        </div>
      )}
      {toast && (
        <div style={{ position: "fixed", bottom: 22, left: "50%", transform: "translateX(-50%)", zIndex: 400, background: "var(--enki-ink)", color: "var(--enki-paper)", fontSize: 12.5, padding: "9px 16px", borderRadius: 999, boxShadow: "0 10px 30px rgba(0,0,0,0.3)", animation: "adm-toast .2s ease", whiteSpace: "nowrap" }}>
          {toast}
        </div>
      )}
    </div>
  );
}
