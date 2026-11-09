"use client";

/* Analytics — the "Enki Analytics" design on real data: period stat cards
   with trends, an earnings/prints line chart, top prompts with conversion,
   and a live activity feed (paid renders, renders, ratings). Everything comes from
   /api/analytics/me; missing tracking (views) shows as "—", never as fakes.
   "Enki" beside "Mine" shows Enki as a whole from /api/analytics/enki, as hup.social/leaderboard does (Kev,
   2026-10-29): every figure with its last 24 hours, and the creators ranked by the column clicked. */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "./icons";
import PanelHead from "./PanelHead";
import Seal from "@/components/kit/Seal";
import { openCreator } from "@/lib/openCreator";
import { sessionAuthHeaders } from "@/lib/session-headers";
import { promptPage } from "@/lib/ui/image-view/open-link";
import { LABEL, TABLE_HEAD, TITLE } from "@/components/enki-window";

type Series = { labels: string[]; earningsCents: number[]; prints: number[] };
type PeriodStats = {
  earningsCents: number; earningsTrend: number | null;
  prints: number; printsTrend: number | null;
  unlocks: number; unlocksTrend: number | null;
  /** Images this person rendered themselves, private ones included (Kev, 2026-10-29). */
  created: number; createdTrend: number | null;
};
type Payload = {
  charts?: { week: Series; month: Series; all: Series };
  stats?: { week: PeriodStats; month: PeriodStats; all: PeriodStats };
  conversionPct?: number | null;
  topPrompts?: { id: string; title: string; image: string | null; revenueCents: number; prints: number; conversionPct: number | null }[];
  activity?: { type: "sale" | "print" | "rating"; prompt: string; amountCents: number | null; rating: number | null; at: string }[];
};

type PeriodKey = "week" | "month" | "all";
const PERIODS: { label: string; key: PeriodKey }[] = [
  { label: "This week", key: "week" },
  { label: "This month", key: "month" },
  { label: "All time", key: "all" },
];

const MONO = "var(--font-mono), monospace";
const SERIF = "var(--font-serif), Georgia, serif";
const GREEN = "var(--enki-green)", RED = "var(--enki-danger)";
// pastel identity chips (same family as the editor's variable chips)
const PASTEL = {
  blue: { bg: "#E8F4FD", ink: "#1E4A6E" },
  green: { bg: "#E8F8EE", ink: "#1F5C38" },
  purple: { bg: "#F3E8FD", ink: "#4A2E6E" },
  gold: { bg: "#FDF6E8", ink: "#6E4A1E" },
};

const dollars = (cents: number) =>
  "$" + (cents / 100).toLocaleString("en-US", { minimumFractionDigits: cents % 100 === 0 ? 0 : 2, maximumFractionDigits: cents % 100 === 0 ? 0 : 2 });
const timeAgo = (iso: string) => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

const card: React.CSSProperties = {
  border: "1px solid var(--enki-rule-2, var(--enki-rule))", borderRadius: 14,
  background: "var(--enki-paper)", padding: "14px 14px 8px",
};

function StatCard({ label, value, trendPct, icon, chip, noTrend, day }: {
  label: string; value: string; trendPct: number | null;
  icon: string; chip: { bg: string; ink: string }; noTrend?: boolean;
  /** The Enki view's last 24 hours ("+4", "0") in place of the trend; null when the figure has no time. */
  day?: string | null;
}) {
  const up = (trendPct ?? 0) >= 0;
  return (
    <div style={{ ...card, padding: "12px 14px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
        <span style={{ width: 22, height: 22, borderRadius: 7, background: chip.bg, color: chip.ink, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <Icon name={icon} size={12} stroke={2} />
        </span>
        <span style={LABEL}>{label}</span>
      </div>
      <span style={{ display: "block", fontFamily: SERIF, fontSize: 27, fontWeight: 400, lineHeight: 1, color: "var(--enki-ink)" }}>{value}</span>
      {day !== undefined ? (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 3, marginTop: 6, fontFamily: MONO, fontSize: 9.5, fontWeight: 700, color: day?.startsWith("+") ? GREEN : "var(--enki-ink-3)" }}>
          {day === null ? "—" : day.startsWith("+") ? `↗ ${day}` : day}
          {day !== null && <span style={{ fontWeight: 400, color: "var(--enki-ink-3)" }}> in 24h</span>}
        </span>
      ) : (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 3, marginTop: 6, fontFamily: MONO, fontSize: 9.5, fontWeight: 700, color: trendPct === null ? "var(--enki-ink-3)" : up ? GREEN : RED }}>
          {noTrend || trendPct === null ? "—" : `${up ? "↗" : "↘"} ${trendPct > 0 ? "+" : ""}${trendPct}%`}
          {!noTrend && trendPct !== null && <span style={{ fontWeight: 400, color: "var(--enki-ink-3)" }}> vs last period</span>}
        </span>
      )}
    </div>
  );
}

type EnkiFigure = { value: number | null; day: number | null };
type EnkiRow = {
  rank: number; handle: string | null; prompts: number; posts: number;
  revenueCents: number; views: number | null; likes: number; comments: number; followers: number;
};
type Watched = { id: string; title?: string; thumb?: string | null; handle: string | null; views: number };
type EnkiPayload = { totals?: Record<string, EnkiFigure>; board?: EnkiRow[]; sort?: string; period?: string; watched?: { prompts?: Watched[]; images?: Watched[] } };

// Kev's list first (users, posted and generated images, what artists earn, views), then the rest of Hup's row.
const ENKI_FIGURES: { key: string; label: string; icon: string; chip: { bg: string; ink: string } }[] = [
  { key: "users", label: "Users", icon: "user", chip: PASTEL.blue },
  { key: "posts", label: "Posted images", icon: "image", chip: PASTEL.purple },
  { key: "images", label: "Generated images", icon: "sparkles", chip: PASTEL.blue },
  { key: "revenue", label: "Artist revenue", icon: "dollar", chip: { bg: "rgba(var(--ember-rgb), 0.12)", ink: "var(--enki-ember)" } },
  { key: "views", label: "Views", icon: "eye", chip: PASTEL.gold },
  { key: "prompts", label: "Prompts", icon: "filetext", chip: PASTEL.green },
  { key: "likes", label: "Likes", icon: "heart", chip: PASTEL.purple },
  { key: "comments", label: "Comments", icon: "message", chip: PASTEL.gold },
];
const ENKI_COLUMNS: { key: string; label: string; get: (r: EnkiRow) => number | null }[] = [
  { key: "prompts", label: "Prompts", get: (r) => r.prompts },
  { key: "posts", label: "Posts", get: (r) => r.posts },
  { key: "revenue", label: "Revenue", get: (r) => r.revenueCents },
  { key: "views", label: "Views", get: (r) => r.views },
  { key: "likes", label: "Likes", get: (r) => r.likes },
  { key: "comments", label: "Comments", get: (r) => r.comments },
  { key: "followers", label: "Followers", get: (r) => r.followers },
];
const ENKI_GRID = "36px minmax(140px, 1.6fr) repeat(7, minmax(64px, 1fr))";
const enkiFigure = (key: string, v: number | null) =>
  v === null ? "—" : key === "revenue" ? dollars(v) : v.toLocaleString("en-US");

/** Enki as a whole: every figure in the period with its last 24 hours, and the creators ranked by the column clicked. */
function EnkiView({ period }: { period: PeriodKey }) {
  const router = useRouter();
  const [sort, setSort] = useState("revenue");
  const [data, setData] = useState<EnkiPayload | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const res = await fetch(`/api/analytics/enki?period=${period}&sort=${sort}`, { headers: sessionAuthHeaders() });
        if (!res.ok) throw new Error();
        const d = (await res.json()) as EnkiPayload;
        if (!dead) { setData(d); setFailed(false); }
      } catch {
        if (!dead) setFailed(true);
      }
    })();
    return () => { dead = true; };
  }, [period, sort]);

  if (failed) return <div style={{ padding: "60px 0", textAlign: "center", color: "var(--enki-ink-3)", fontSize: 13 }}>Could not load Enki&apos;s numbers — try again in a moment.</div>;
  // Another period's numbers never sit under this period's labels.
  if (!data || data.period !== period) return <div style={{ padding: "60px 0", textAlign: "center", color: "var(--enki-ink-3)", fontSize: 13 }}>Loading…</div>;
  // The server's column, when it had to fall back.
  const ranked = data.sort ?? sort;
  const watched = data.watched ?? {};
  return (
    <>
      {/* Four across at most (two rows of four, as on Hup), two on a phone. */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(max(150px, calc((100% - 30px) / 4)), 1fr))", gap: 10, marginBottom: 12 }}>
        {ENKI_FIGURES.map((f) => {
          const t = data.totals?.[f.key] ?? { value: 0, day: 0 };
          return (
            <StatCard key={f.key} label={f.key === "users" && period !== "all" ? "New users" : f.label}
              value={enkiFigure(f.key, t.value)} trendPct={null} icon={f.icon} chip={f.chip}
              day={t.day === null ? null : t.day > 0 ? `+${enkiFigure(f.key, t.day)}` : enkiFigure(f.key, 0)} />
          );
        })}
      </div>

      {/* What got the most attention: the prompts and images opened most in the period (Kev, 2026-10-29). */}
      {((watched.prompts?.length ?? 0) > 0 || (watched.images?.length ?? 0) > 0) && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12, marginBottom: 12 }}>
          {([["Most watched prompts", watched.prompts ?? [], (w: Watched) => router.push(promptPage(w.id))],
             ["Most watched images", watched.images ?? [], (w: Watched) => router.push(`/i/${w.id}`)]] as const).map(([title, rows, open]) => rows.length > 0 && (
            <div key={title} style={card} data-watched={title.includes("prompts") ? "prompts" : "images"}>
              <span style={{ ...TITLE, fontSize: 17, display: "block", marginBottom: 10 }}>{title}</span>
              {rows.map((w, i) => (
                <button key={w.id} type="button" onClick={() => open(w)} title={w.title ? `Open “${w.title}”` : "Open this image"} style={{
                  display: "flex", alignItems: "center", gap: 10, padding: "7px 4px", width: "100%",
                  border: "none", borderTop: "1px dashed var(--enki-rule-2, var(--enki-rule))", background: "none", textAlign: "left", cursor: "pointer",
                }}>
                  <span style={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, color: i === 0 ? "var(--enki-ember)" : "var(--enki-ink-3)", width: 16, flexShrink: 0, textAlign: "center" }}>{i + 1}</span>
                  {w.thumb !== undefined && (
                    <span style={{ width: 44, height: 44, borderRadius: 8, overflow: "hidden", flexShrink: 0, background: "var(--enki-paper-3)" }}>
                      {w.thumb && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={w.thumb} alt="" loading="lazy" style={{ display: "block", width: "100%", height: "100%", objectFit: "cover" }} />
                      )}
                    </span>
                  )}
                  <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                    <span style={{ fontFamily: SERIF, fontSize: 14, color: "var(--enki-ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{w.title ?? (w.handle ? `by @${w.handle}` : "unnamed")}</span>
                    {w.title && <span style={{ fontSize: 10, color: "var(--enki-ink-3)" }}>{w.handle ? `@${w.handle}` : "unnamed"}</span>}
                  </span>
                  <span style={{ fontFamily: MONO, fontSize: 12, fontWeight: 700, color: "var(--enki-ink-2)", flexShrink: 0 }}>{w.views.toLocaleString("en-US")} <span style={{ fontWeight: 400, color: "var(--enki-ink-3)" }}>opens</span></span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}

      <div style={{ ...card, padding: 0, overflow: "hidden" }}>
        <span style={{ ...TITLE, fontSize: 17, display: "block", padding: "14px 14px 10px" }}>Creators</span>
        {/* Wider than a phone: the columns scroll sideways, as on Hup. */}
        <div style={{ overflowX: "auto" }}>
          <div style={{ minWidth: 700 }}>
            <div style={{ display: "grid", gridTemplateColumns: ENKI_GRID, gap: 6, alignItems: "center", padding: "6px 14px", borderTop: "1px solid var(--enki-rule-2, var(--enki-rule))" }}>
              <span style={TABLE_HEAD}>#</span>
              <span style={TABLE_HEAD}>Creator</span>
              {ENKI_COLUMNS.map((c) => {
                const on = ranked === c.key;
                return (
                  <button key={c.key} type="button" aria-pressed={on} onClick={() => setSort(c.key)} title={`Rank by ${c.label.toLowerCase()}`}
                    style={{ ...TABLE_HEAD, textAlign: "right", border: "none", background: "none", padding: 0, cursor: "pointer", fontWeight: on ? 700 : 400, color: on ? "var(--enki-ember)" : TABLE_HEAD.color }}>
                    {c.label}{on ? " ↓" : ""}
                  </button>
                );
              })}
            </div>
            {(data.board ?? []).length === 0 && (
              <div style={{ padding: "14px", fontSize: 12, color: "var(--enki-ink-3)", borderTop: "1px dashed var(--enki-rule-2, var(--enki-rule))" }}>No creators in this period yet.</div>
            )}
            {(data.board ?? []).map((r) => (
              <div key={r.rank} style={{ display: "grid", gridTemplateColumns: ENKI_GRID, gap: 6, alignItems: "center", padding: "7px 14px", borderTop: "1px dashed var(--enki-rule-2, var(--enki-rule))" }}>
                <span style={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, color: r.rank === 1 ? "var(--enki-ember)" : "var(--enki-ink-3)" }}>{r.rank}</span>
                {r.handle ? (
                  <button type="button" onClick={() => openCreator(r.handle!, router)} title={`Open @${r.handle}`}
                    style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, border: "none", background: "none", padding: 0, cursor: "pointer", textAlign: "left" }}>
                    <span style={{ width: 26, height: 26, borderRadius: "50%", flexShrink: 0, overflow: "hidden" }}><Seal handle={r.handle} /></span>
                    <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--enki-ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>@{r.handle}</span>
                  </button>
                ) : (
                  // No handle, no profile to open.
                  <span style={{ fontSize: 12.5, fontStyle: "italic", color: "var(--enki-ink-3)" }}>unnamed</span>
                )}
                {ENKI_COLUMNS.map((c) => (
                  <span key={c.key} style={{ fontFamily: MONO, fontSize: 12, textAlign: "right", fontWeight: ranked === c.key ? 700 : 400, color: ranked === c.key ? "var(--enki-ink)" : "var(--enki-ink-2)" }}>
                    {enkiFigure(c.key, c.get(r))}
                  </span>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

export default function AnalyticsPanel() {
  const router = useRouter();
  const [data, setData] = useState<Payload | null>(null);
  const [failed, setFailed] = useState(false);
  const [period, setPeriod] = useState<PeriodKey>("month");
  const [metric, setMetric] = useState<"earnings" | "prints">("earnings");
  const [view, setView] = useState<"mine" | "enki">("mine");

  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const res = await fetch("/api/analytics/me", { headers: sessionAuthHeaders() });
        if (!res.ok) throw new Error();
        const d = (await res.json()) as Payload;
        if (!dead) setData(d);
      } catch {
        if (!dead) setFailed(true);
      }
    })();
    return () => { dead = true; };
  }, []);

  const ser = data?.charts?.[period];
  const st = data?.stats?.[period];
  const vals = ser ? (metric === "earnings" ? ser.earningsCents : ser.prints) : [];

  // chart geometry (design: 720×200, baseline 160, top 14)
  const W = 720, top = 14, base = 160;
  const max = Math.max(...vals, 1) * 1.15;
  const pts = vals.map((v, i) => ({
    x: vals.length > 1 ? (i / (vals.length - 1)) * (W - 24) + 12 : W / 2,
    y: base - (v / max) * (base - top),
  }));
  const line = pts.map((p, i) => (i ? "L" : "M") + p.x.toFixed(1) + " " + p.y.toFixed(1)).join(" ");
  const area = pts.length ? `${line} L ${pts[pts.length - 1].x.toFixed(1)} ${base} L ${pts[0].x.toFixed(1)} ${base} Z` : "";

  return (
    <div className="ek-page">
      <PanelHead title="Analytics." sub={view === "enki" ? "Everything happening on Enki." : "How your prompts earn, print, and convert."}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8 }}>
          <div className="ek-msg-box" role="tablist" aria-label="Whose numbers" style={{ width: 170, marginBottom: 0 }}>
            {(["mine", "enki"] as const).map((v) => (
              <button key={v} type="button" role="tab" aria-selected={view === v} className={"ek-msg-box-btn" + (view === v ? " on" : "")} onClick={() => setView(v)}>
                {v === "mine" ? "Mine" : "Enki"}
              </button>
            ))}
          </div>
          <div style={{ display: "inline-flex", gap: 4, flexWrap: "wrap" }}>
            {PERIODS.map((p) => (
              <button key={p.key} className={"ek-page-pill" + (period === p.key ? " on" : "")} onClick={() => setPeriod(p.key)}>
                {p.label}
              </button>
            ))}
          </div>
        </div>
      </PanelHead>

      {view === "enki" ? (
        <EnkiView period={period} />
      ) : failed ? (
        <div style={{ padding: "60px 0", textAlign: "center", color: "var(--enki-ink-3)", fontSize: 13 }}>Could not load your analytics — try again in a moment.</div>
      ) : !data ? (
        <div style={{ padding: "60px 0", textAlign: "center", color: "var(--enki-ink-3)", fontSize: 13 }}>Loading…</div>
      ) : (
        /* Without a print yet the page is the same, with every figure at 0 (Kev, 2026-10-13), never a placeholder. */
        <>
          {/* ── stat cards ── */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 10, marginBottom: 12 }}>
            <StatCard label="Earnings" value={dollars(st?.earningsCents ?? 0)} trendPct={st?.earningsTrend ?? null}
              icon="dollar" chip={{ bg: "rgba(var(--ember-rgb), 0.12)", ink: "var(--enki-ember)" }} />
            <StatCard label="Prints" value={(st?.prints ?? 0).toLocaleString("en-US")} trendPct={st?.printsTrend ?? null}
              icon="sparkles" chip={PASTEL.blue} />
            <StatCard label="Paid renders" value={(st?.unlocks ?? 0).toLocaleString("en-US")} trendPct={st?.unlocksTrend ?? null}
              icon="generate" chip={PASTEL.green} />
            <StatCard label="Created" value={(st?.created ?? 0).toLocaleString("en-US")} trendPct={st?.createdTrend ?? null}
              icon="image" chip={PASTEL.gold} />
            <StatCard label="Conversion" value={data.conversionPct === null || data.conversionPct === undefined ? "—" : `${data.conversionPct}%`}
              trendPct={null} noTrend icon="target" chip={PASTEL.purple} />
          </div>

          {/* ── chart ── */}
          <div style={{ ...card, padding: "14px 16px 8px", marginBottom: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
              <span style={{ ...TITLE, fontSize: 17 }}>
                {metric === "earnings" ? "Earnings over time" : "Prints over time"}
              </span>
              <div style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
                {(["earnings", "prints"] as const).map((m) => (
                  <button key={m} type="button" className={"ek-page-pill" + (metric === m ? " on" : "")} onClick={() => setMetric(m)}>
                    {m === "earnings" ? "Earnings" : "Prints"}
                  </button>
                ))}
              </div>
            </div>
            <svg viewBox="0 0 720 200" style={{ width: "100%", height: "auto", display: "block" }} preserveAspectRatio="none">
              <line x1={0} y1={160} x2={720} y2={160} stroke="var(--enki-rule-2, var(--enki-rule))" strokeWidth={1} />
              <line x1={0} y1={110} x2={720} y2={110} stroke="var(--enki-rule-2, var(--enki-rule))" strokeWidth={1} strokeDasharray="4 4" />
              <line x1={0} y1={60} x2={720} y2={60} stroke="var(--enki-rule-2, var(--enki-rule))" strokeWidth={1} strokeDasharray="4 4" />
              {area && <path d={area} fill="rgba(var(--ember-rgb), 0.12)" />}
              {line && <path d={line} fill="none" stroke="var(--enki-ember)" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />}
              {pts.map((p, i) => (
                <circle key={i} cx={p.x.toFixed(1)} cy={p.y.toFixed(1)} r={3.2} fill="var(--enki-paper)" stroke="var(--enki-ember)" strokeWidth={2} />
              ))}
            </svg>
            <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 2px 6px" }}>
              {(ser?.labels ?? []).map((t, i) => (
                <span key={i} style={{ fontFamily: MONO, fontSize: 8.5, color: "var(--enki-ink-3)" }}>{t}</span>
              ))}
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1.35fr 1fr", gap: 12, alignItems: "start" }}>
            {/* ── top prompts ── */}
            <div style={card}>
              <span style={{ ...TITLE, fontSize: 17, display: "block", marginBottom: 10 }}>Top prompts</span>
              {(data.topPrompts ?? []).length === 0 && (
                <div style={{ padding: "14px 4px", fontSize: 12, color: "var(--enki-ink-3)" }}>No prompt activity yet.</div>
              )}
              {(data.topPrompts ?? []).map((r, i) => (
                <button key={r.id} onClick={() => router.push(promptPage(r.id))} title={`Open “${r.title}”`} style={{
                  display: "flex", alignItems: "center", gap: 11, padding: "8px 4px", width: "100%",
                  border: "none", borderTop: "1px dashed var(--enki-rule-2, var(--enki-rule))",
                  background: "none", textAlign: "left", cursor: "pointer",
                }}>
                  <span style={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, color: i === 0 ? "var(--enki-ember)" : "var(--enki-ink-3)", width: 16, flexShrink: 0, textAlign: "center" }}>{i + 1}</span>
                  <span style={{ width: 58, height: 40, borderRadius: 8, overflow: "hidden", flexShrink: 0, background: "var(--enki-paper-3)" }}>
                    {r.image && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={r.image} alt="" loading="lazy" style={{ display: "block", width: "100%", height: "100%", objectFit: "cover" }} />
                    )}
                  </span>
                  <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
                    <span style={{ fontFamily: SERIF, fontSize: 14, color: "var(--enki-ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.title}</span>
                    {r.conversionPct !== null && (
                      <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ flex: 1, maxWidth: 150, height: 4, borderRadius: 2, background: "var(--enki-paper-3)", overflow: "hidden" }}>
                          <span style={{ display: "block", height: "100%", width: `${Math.min(100, r.conversionPct)}%`, background: "var(--enki-ember)", borderRadius: 2 }} />
                        </span>
                        <span style={{ fontFamily: MONO, fontSize: 9, color: "var(--enki-ink-3)", whiteSpace: "nowrap" }}>{r.conversionPct}% conversion</span>
                      </span>
                    )}
                  </span>
                  <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 1, flexShrink: 0 }}>
                    <span style={{ fontFamily: MONO, fontSize: 13, fontWeight: 700, color: "var(--enki-ember)" }}>{dollars(r.revenueCents)}</span>
                    <span style={{ fontFamily: MONO, fontSize: 9, color: "var(--enki-ink-3)" }}>{r.prints.toLocaleString("en-US")} prints</span>
                  </span>
                </button>
              ))}
            </div>

            {/* ── recent activity ── */}
            <div style={card}>
              <span style={{ ...TITLE, fontSize: 17, display: "block", marginBottom: 10 }}>Recent activity</span>
              {(data.activity ?? []).length === 0 && (
                <div style={{ padding: "14px 4px", fontSize: 12, color: "var(--enki-ink-3)" }}>Quiet so far — earnings, renders and ratings land here.</div>
              )}
              {(data.activity ?? []).map((a, i) => {
                const chip = a.type === "sale" ? PASTEL.green : a.type === "print" ? PASTEL.blue : PASTEL.gold;
                return (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 9, padding: "7px 2px", borderTop: "1px dashed var(--enki-rule-2, var(--enki-rule))" }}>
                    <span style={{ width: 24, height: 24, borderRadius: "50%", background: chip.bg, color: chip.ink, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                      <Icon name={a.type === "sale" ? "dollar" : a.type === "print" ? "sparkles" : "star"} size={11} stroke={2} fill={a.type === "rating" ? "currentColor" : "none"} />
                    </span>
                    <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
                      <span style={{ fontSize: 11.5, fontWeight: 600, color: "var(--enki-ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {a.type === "sale" ? "Paid render" : a.type === "print" ? "Image generated" : `New ${a.rating ?? "?"}★ rating`}
                      </span>
                      <span style={{ fontSize: 10, color: "var(--enki-ink-3)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{a.prompt}</span>
                    </span>
                    <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", flexShrink: 0 }}>
                      <span style={{ fontFamily: MONO, fontSize: 10.5, fontWeight: 700, color: a.type === "rating" ? PASTEL.gold.ink : GREEN }}>
                        {a.type === "sale" && a.amountCents !== null ? `+${dollars(a.amountCents)}` : a.type === "rating" && a.rating !== null ? a.rating.toFixed(1) : ""}
                      </span>
                      <span style={{ fontFamily: MONO, fontSize: 8.5, color: "var(--enki-ink-3)" }}>{timeAgo(a.at)}</span>
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
