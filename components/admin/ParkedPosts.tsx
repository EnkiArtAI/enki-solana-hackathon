"use client";

import { useEffect, useRef, useState } from "react";
import { sessionAuthHeaders } from "@/lib/session-headers";
import { PARKED_SQL, type ParkedKind, type ParkedPage, type ParkedRow } from "@/lib/hunter/creator-types";

const MONO = "var(--font-mono), monospace";
const SAID: Record<ParkedKind, { one: string; many: string; none: string }> = {
  video: { one: "video post saved", many: "video posts saved", none: "No video post saved yet." },
  no_media: { one: "post without media", many: "posts without media", none: "No post without media yet." },
};
const quiet: React.CSSProperties = { fontFamily: MONO, fontSize: 10, color: "var(--enki-ink-3)" };
const words: React.CSSProperties = { margin: 0, fontSize: 12, lineHeight: 1.5, color: "var(--enki-ink)", whiteSpace: "pre-wrap", overflowWrap: "anywhere" };
const link: React.CSSProperties = { color: "var(--enki-ember)" };
const note: React.CSSProperties = { padding: "26px 18px", textAlign: "center", fontSize: 12.5, color: "var(--enki-ink-3)" };
const card: React.CSSProperties = { border: "1px solid var(--enki-rule-2, var(--enki-rule))", borderRadius: 13, background: "var(--enki-paper)", padding: "4px 14px 6px" };

const minutes = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** A video's poster, its length on it; a poster X no longer serves leaves the frame and the length. */
function Poster({ video }: { video: ParkedRow["videos"][number] }) {
  const [gone, setGone] = useState(false);
  return (
    <span style={{ position: "relative", display: "block", width: 96, height: 96, flexShrink: 0, borderRadius: 7, overflow: "hidden", border: "1px solid var(--enki-rule)", background: "var(--enki-paper-2)" }}>
      {video.poster && !gone && (
        // eslint-disable-next-line @next/next/no-img-element -- X's poster, shown as it is
        <img src={video.poster} alt="" loading="lazy" onError={() => setGone(true)} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
      )}
      <span style={{ position: "absolute", left: 4, bottom: 4, fontFamily: MONO, fontSize: 9, padding: "1px 4px", borderRadius: 4, background: "rgba(0,0,0,.72)", color: "#fff" }}>
        {video.gif ? "GIF" : video.duration ? minutes(video.duration) : "video"}{video.inReply ? " · reply" : ""}
      </span>
    </span>
  );
}

function Row({ r, kind }: { r: ParkedRow; kind: ParkedKind }) {
  return (
    <article style={{ display: "flex", flexDirection: "column", gap: 8, padding: "12px 0", borderBottom: "1px dashed var(--enki-rule-2, var(--enki-rule))", minWidth: 0 }}>
      <header style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "3px 10px", ...quiet }}>
        <a href={`https://x.com/${r.handle}`} target="_blank" rel="noreferrer" style={{ ...link, fontSize: 11.5 }}>@{r.handle}</a>
        <span>{r.posted ? `posted ${r.posted.slice(0, 10)} · ` : ""}read {r.at.slice(0, 10)}</span>
        <a href={r.link} target="_blank" rel="noreferrer" style={link}>Open the post ↗</a>
        {r.find && <span style={{ fontWeight: 700, color: "var(--enki-ink-2)" }}>{r.find === "pending" ? "Its find waits in Pending imports" : "Its find is published"}</span>}
        {kind === "no_media" && r.why && <span>{r.why}</span>}
      </header>
      {kind === "video" && (
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
          {r.videos.map((v, i) => <Poster key={i} video={v} />)}
          <span style={quiet}>{r.videos.length} {r.videos.length === 1 ? "video" : "videos"}</span>
        </div>
      )}
      <p style={words}>{r.text}</p>
      {r.replies.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, paddingLeft: 10, borderLeft: "2px solid var(--enki-rule)" }}>
          <span style={quiet}>{r.replies.length === 1 ? "The author's reply" : `The author's ${r.replies.length} replies`}</span>
          {r.replies.map((x) => <p key={x.id} style={words}>{x.text}</p>)}
        </div>
      )}
    </article>
  );
}

/**
 * The Videos or the No media tab (Kev, 2026-11-03: "in nem reiter, damit ich mir das so angucken kann"): what the Prompt
 * Hunter kept in hunter_parked, newest first, 50 at a time as Pending imports are. Nothing to do here but read and open the
 * link. The page's search looks through what is loaded, and as a search leaves the end in view the next pages load too, so
 * it reaches every row. Its own read, so a table that is not there yet touches no other tab.
 */
export default function ParkedPosts({ kind, query }: { kind: ParkedKind; query: string }) {
  const [rows, setRows] = useState<ParkedRow[]>([]);
  const [total, setTotal] = useState(0);
  const [state, setState] = useState<"loading" | "ready" | "missing" | "failed">("loading");
  const asking = useRef(false);
  const end = useRef<HTMLDivElement>(null);

  const load = async (from: number) => {
    if (asking.current) return;
    asking.current = true;
    let back: number | null = null;
    try {
      const res = await fetch(`/api/admin?parked=${kind}&from=${from}`, { headers: sessionAuthHeaders() });
      if (!res.ok) throw new Error();
      const page = (await res.json()) as ParkedPage;
      if (!page.ready) { setState("missing"); return; }
      // A post saved or read again meanwhile moves the rows under the offset, so a page can bring only rows held: the rest
      // lies further up, and the tail would wait for it for good. Each post once, its newest read, newest first as the server has them.
      if (from > 0 && page.rows.every((r) => rows.some((x) => x.postId === r.postId))) back = Math.max(0, from - 50);
      setRows((cur) => [...new Map([...cur, ...page.rows].map((r) => [r.postId, r])).values()].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)));
      setTotal(page.total);
      setState("ready");
    } catch {
      setState("failed");
    } finally {
      asking.current = false;
    }
    if (back !== null) void load(back);
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- once, for the tab it was opened on (the page keys it by tab)
  useEffect(() => { void load(0); }, []);

  const more = state === "ready" && rows.length < total;
  useEffect(() => {
    const el = end.current;
    if (!el || !more) return;
    const io = new IntersectionObserver((seen) => { if (seen[0]?.isIntersecting) void load(rows.length); }, { rootMargin: "0px 0px 800px 0px" });
    io.observe(el);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a new page or a new search re-arms it, with the fresh list
  }, [more, rows.length, query]);

  if (state === "missing") return <div style={{ ...card, ...note }}>This tab needs {PARKED_SQL}: run it in Supabase, then refresh.</div>;

  const q = query.trim().toLowerCase().replace(/^@/, "");
  const shown = rows.filter((r) => !q || r.link.toLowerCase().includes(q) || r.text.toLowerCase().includes(q) || r.replies.some((x) => x.text.toLowerCase().includes(q)));
  const said = SAID[kind];
  return (
    <>
      {state !== "loading" && state !== "failed" && (
        <div style={{ ...quiet, marginBottom: 8 }}>{total} {total === 1 ? said.one : said.many}{q ? ` · ${shown.length} match in the ${rows.length} read so far` : ""}</div>
      )}
      <div style={card}>
        {state === "loading" && <div style={note}>Loading…</div>}
        {state === "ready" && !rows.length && <div style={note}>{said.none}</div>}
        {state === "ready" && rows.length > 0 && !shown.length && !more && <div style={note}>Nothing matches.</div>}
        {shown.map((r) => <Row key={r.postId} r={r} kind={kind} />)}
        {state === "failed" && (
          <div style={note}>
            These posts could not be read right now.{" "}
            <button type="button" onClick={() => { setState(rows.length ? "ready" : "loading"); void load(rows.length); }} style={{ ...link, background: "none", border: "none", cursor: "pointer", font: "inherit", textDecoration: "underline", padding: 0 }}>Try again</button>
          </div>
        )}
        {more && <div ref={end} style={{ padding: 14, textAlign: "center", ...quiet }}>{rows.length} of {total} · the next {Math.min(50, total - rows.length)} load as you scroll</div>}
      </div>
    </>
  );
}
