"use client";

import { useCallback, useRef, useState } from "react";
import { useBetaAccess } from "@/components/BetaGate";
import Segmented from "@/components/kit/Segmented";
import PanelHead from "@/components/enki-shell/PanelHead";
import { Icon } from "@/components/enki-shell/icons";
import { useCommunityDirectory, useCommunityTypeahead, useDebounced } from "@/hooks/useCommunities";
import { COMMUNITIES_NOT_READY, COMMUNITY_TEXT, DIRECTORY_PAGE, LISTED_MIN_MEMBERS, LISTED_MIN_WORKS, type DirectorySort } from "@/lib/communities/types";
import { openLogin } from "@/lib/openLogin";
import { createOffer } from "@/lib/ui/communities/picker";
import { DIRECTORY_SORT_TABS } from "@/lib/ui/kit/shell-nav";
import CommunityCard from "./CommunityCard";
import CommunityDialog from "./CommunityDialog";
import "@/components/studio/studio.css";
import "./communities.css";

/** The search asks once typing has held still this long. */
const TYPE_MS = 250;

/** A dashed card first in the grid: "+ Create community", or "+ Create c/<typed>" while searching. */
const AddCard = ({ handle, onClick }: { handle?: string; onClick: () => void }) => (
  <button type="button" className="cm-add" onClick={onClick}>
    <Icon name="plus" size={20} stroke={1.8} />
    <span>{handle ? "Create" : "Create community"}</span>
    {handle && <span className="cm-add-handle">c/{handle}</span>}
  </button>
);

/** Asks for the next page once the end of the grid comes near (as the feed's sentinel, 800 px ahead). */
function useSentinel(more: boolean, busy: boolean, load: () => void) {
  const seen = useRef<IntersectionObserver | null>(null);
  return useCallback((node: HTMLDivElement | null) => {
    seen.current?.disconnect();
    if (!node || !more) return;
    seen.current = new IntersectionObserver((e) => { if (e[0].isIntersecting && !busy) load(); }, { rootMargin: "800px 0px" });
    seen.current.observe(node);
  }, [more, busy, load]);
}

/**
 * Every community (Kev, 2026-10-30: "wo sehe ich denn die communities ... oder wo kann ich nach denen suchen sodass sie
 * mir vorgeschlagen werden?"; "wir brauchen auch eine auflistung aller communities"): a search on top whose results
 * take the grid's place as it is typed, the new and unlisted ones among them, and "+ Create c/<typed>" first when none
 * has that handle; without words, the listed ones by Trending, New or A–Z, "+ Create community" first. Equal portrait
 * cards (Kev: "alle communities gleich große senkrechte karten").
 */
export default function Directory({ sort, onSort, onOpen }: {
  sort: DirectorySort;
  onSort: (sort: DirectorySort) => void;
  onOpen: (handle: string) => void;
}) {
  const { access, role } = useBetaAccess();
  const signedIn = access === "ok" && role !== "team";
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState<string | null>(null);
  const typed = q.trim();
  const words = useDebounced(typed, TYPE_MS);
  const search = useCommunityTypeahead(words, DIRECTORY_PAGE);
  const list = useCommunityDirectory(sort);
  const sentinel = useSentinel(!!list.more, list.loadingMore, list.loadMore);
  const found = typed ? search.data?.communities ?? [] : [];
  const offer = typed && words === typed && search.data ? createOffer(typed, found) : null;
  const create = (name: string) => (signedIn ? setCreating(name) : openLogin());
  const notReady = list.notReady || search.notReady;
  const error = typed ? search.error : list.error;

  return (
    <div className="ek-page cm-page kit-focus">
      <PanelHead title="Communities." sub="Gather around a coin, a character, a style. Anyone can start one." />
      <label className="cm-search">
        <Icon name="search" size={16} stroke={2} />
        <input type="search" value={q} placeholder="Search communities" aria-label="Search communities" spellCheck={false} autoCapitalize="none" maxLength={COMMUNITY_TEXT.query}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Escape" && q) { e.stopPropagation(); setQ(""); } }} />
        {q && <button type="button" className="cm-search-x kit-hit" aria-label="Clear the search" onClick={() => setQ("")}><Icon name="x" size={14} stroke={2.2} /></button>}
      </label>

      {notReady ? (
        <div className="st-empty"><Icon name="users" size={28} stroke={1.5} /><h2 className="kit-title">{COMMUNITIES_NOT_READY}</h2></div>
      ) : error ? (
        <div className="st-empty" role="alert">
          <h2 className="kit-title">{error}</h2>
          <button type="button" className="st-btn" onClick={typed ? search.retry : list.retry}>Try again</button>
        </div>
      ) : typed ? (
        <>
          <p className="kit-label cm-bar" role="status">
            {words !== typed || !search.data ? "Searching…" : found.length ? `${found.length} ${found.length === 1 ? "community" : "communities"}` : "None by that name yet"}
          </p>
          <div className="cm-grid">
            {offer && <AddCard handle={offer} onClick={() => create(typed)} />}
            {found.map((c) => <CommunityCard key={c.id} card={c} onOpen={onOpen} />)}
          </div>
        </>
      ) : (
        <>
          <div className="cm-bar">
            <Segmented role="radiogroup" ariaLabel="Order of the communities" value={sort} onChange={onSort} options={[...DIRECTORY_SORT_TABS]} />
          </div>
          <div className="cm-grid">
            <AddCard onClick={() => create("")} />
            {list.items.map((c) => <CommunityCard key={c.id} card={c} onOpen={onOpen} />)}
          </div>
          {!list.loading && !list.items.length && (
            <p className="cm-note cm-more">No community is listed yet. Start one, or search: a new one shows here at {LISTED_MIN_MEMBERS} members or {LISTED_MIN_WORKS} works.</p>
          )}
          <div ref={sentinel} className="cm-sentinel" />
        </>
      )}
      {creating !== null && (
        <CommunityDialog name={creating} onClose={() => setCreating(null)} onDone={(c) => { setCreating(null); onOpen(c.handle); }} />
      )}
    </div>
  );
}
