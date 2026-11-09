"use client";

import { useEffect, useMemo, useState, useRef, useCallback } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import EnkiFilters from "@/components/enki/EnkiFilters";
import FeedCard from "@/components/enki/FeedCard";
import MasonryGrid from "@/components/enki/MasonryGrid";
import GenerateLauncher from "@/components/GenerateLauncher";
import EnkiDetailPanel from "@/components/enki/EnkiDetailPanel";
import Segmented from "@/components/kit/Segmented";
import { MEDIA, mediaLink, mediaOf, type Media } from "@/lib/ui/feed/world";
import { communityFilterLink, communityFilterOf } from "@/lib/ui/communities/links";
import { seedFromFeedCard, toFeedCard, type FeedCard as Card } from "@/lib/ui/feed/card";
import { linkedPrompt, showing } from "@/lib/ui/image-view/open-link";
import { useModelCatalogue } from "@/hooks/useModelLimits";
import { useBookmarkIndex } from "@/hooks/useBookmarkIndex";
import { useIgnores } from "@/hooks/useIgnores";
import { generatorAliases, generatorGroups as groupGenerators } from "@/lib/ui/feed/generators";
import { useBetaAccess } from "@/components/BetaGate";
import { sessionHeadersWith } from "@/lib/session-headers";
import { openCreator } from "@/lib/openCreator";
import { SEARCH_DEBOUNCE_MS, failureSentence, type SearchCreator } from "@/lib/search/client";
import Seal from "@/components/kit/Seal";
import "./feed.css";

/* The value a debounce later: the field writes ?q= on every keystroke, the
   server is asked once the typing pauses. */
function useDebounced(value: string, ms: number) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

export default function EnkiFeedPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [tags, setTags] = useState<string[]>([]);
  /* The shell search: ?q= is written by SearchChip on every keystroke. A
     non empty query, debounced, swaps the feed's source for /api/search;
     clearing it restores the normal feed at once. */
  const searchParams = useSearchParams();
  const typed = searchParams.get("q")?.trim() || "";
  const settled = useDebounced(typed, SEARCH_DEBOUNCE_MS);
  const query = typed ? settled : "";
  /* All | Images | Videos above the categories (Kev, 2026-10-30: Explore shows them; Remix went to Create), in the
     address as ?media=. Each pick is its own history entry, so Back goes to the one before instead of off /home (as the
     image view's, Kev, 2026-10-16). All mixes both (Kev, 2026-11-03: "roll dann videos bei explore aus"). */
  const pathname = usePathname();
  const media = mediaOf(searchParams);
  const videos = media === "videos";
  const pickMedia = (next: Media) => {
    if (next === media) return;
    router.push(mediaLink(pathname, searchParams, next), { scroll: false });
    window.scrollTo({ top: 0 });
  };
  /* The Community filter (Kev, 2026-10-30: "i want at one point to filter for a community"), in the address as
     ?community=<handle>, each pick a page of its own as ?media= is; the shell's Home leaves it (it pushes /home). */
  const community = communityFilterOf(searchParams);
  const pickCommunity = (handle: string | null) => {
    if (handle === community) return;
    router.push(communityFilterLink(`${pathname}?${searchParams.toString()}`, handle), { scroll: false });
    window.scrollTo({ top: 0 });
  };
  /* Which generators feed the wall — ids from the model catalogue, grouped
     Image/Video for the filter chip (Kev, 2026-08-24), only the world's own
     branch in Images and Videos. A pick of the other branch does not filter
     here: its chip is not on screen to take it off. */
  const [genPicks, setGenFilter] = useState<string[]>([]);
  const catalogue = useModelCatalogue();
  const generatorGroups = useMemo(() => groupGenerators(catalogue, media), [catalogue, media]);
  const genFilter = useMemo(() => genPicks.filter((id) => generatorGroups.some((g) => g.entries.some((e) => e.id === id))), [genPicks, generatorGroups]);
  const [open, setOpen] = useState<Card | null>(null);
  /* ?prompt=<id> opens that prompt's view: on arrival (a reload on an open
     image, a prompt's link) and whenever the shell pushes one (Hall of Fame,
     notifications, analytics), so the view always opens here, beside the
     menu (Kev, 2026-10-13). The view reads the prompt itself. While one is
     open the address is its own (EnkiDetailPanel writes it, and takes it
     away on close), whoever opened the view. */
  const [linked, setLinked] = useState<string | null>(() => linkedPrompt(searchParams));
  // Follows the address as it changes, adjusted during render (no effect, no extra commit).
  const [seenParams, setSeenParams] = useState(searchParams);
  if (searchParams !== seenParams) {
    setSeenParams(searchParams);
    const id = linkedPrompt(searchParams);
    // A prompt pushed later (a render notice, Hall of Fame, a notification) wins over a card opened before it; one a
    // view already shows (a profile's, which wrote it here) gets no copy (DEC-461).
    if (id) { if (!showing(id)) { setLinked(id); if (open && open.id !== id) setOpen(null); } }
    // The address lost its prompt (the browser's Back): the view closes with it (Kev, 2026-10-16).
    else if (open || linked) { setOpen(null); setLinked(null); }
  }
  /* Cards whose prompt the server refused on open: gone for the visit
     (the feed lists rows the detail route no longer serves). */
  const [gone, setGone] = useState<ReadonlySet<string>>(() => new Set());
  /* 18+ pill (Kev, 2026-10-03): only a user who confirmed in Settings that
     they are 18 or older sees it, off until they turn it on, and it belongs
     to their account (BetaGate). The page asks for exactly what it shows, and
     the server checks the confirmation again behind the header. */
  const { access, role, adultConfirmed, adultPill, setAdultPill } = useBetaAccess();
  const authed = access === "ok" && role !== "team";
  const showAdult = adultConfirmed && adultPill;
  /* Show ignored (Kev, 2026-10-29: "show in the filters that also ignored ppl
     shall be visible just in case i want to catch up"): only while I ignore
     someone, off on every visit; the server leaves them out without it. */
  const ignoring = (useIgnores(authed).data?.length ?? 0) > 0;
  const [ignoredPill, setIgnoredPill] = useState(false);
  const showIgnored = ignoring && ignoredPill;

  /* The shell's Home with nothing open: back to All at the top. */
  useEffect(() => {
    const onHome = () => setTags([]);
    window.addEventListener("enki:home", onHome);
    return () => window.removeEventListener("enki:home", onHome);
  }, []);

  // VIEW counter (timeline impressions): one IntersectionObserver watches every
  // card; ids that became at least half visible are buffered and flushed as ONE
  // batched call every 3s. A session-level set makes sure each prompt is sent
  // at most once per visit (the server dedupes again on top).
  const impressionSeen = useRef<Set<string>>(new Set());
  const impressionBuffer = useRef<Set<string>>(new Set());
  const impressionObserver = useRef<IntersectionObserver | null>(null);
  useEffect(() => {
    impressionObserver.current = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const pid = (e.target as HTMLElement).dataset.pid;
          if (e.isIntersecting && pid && !impressionSeen.current.has(pid)) {
            impressionSeen.current.add(pid);
            impressionBuffer.current.add(pid);
          }
        }
      },
      { threshold: 0.5 },
    );
    const flush = setInterval(() => {
      if (impressionBuffer.current.size === 0) return;
      const ids = [...impressionBuffer.current];
      impressionBuffer.current.clear();
      fetch("/api/prompts/views-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      }).catch(() => {});
    }, 3000);
    return () => { impressionObserver.current?.disconnect(); clearInterval(flush); };
  }, []);
  const observeCard = useCallback((el: HTMLElement | null) => {
    if (el) impressionObserver.current?.observe(el);
  }, []);

  type Page = { prompts: unknown[]; creators?: SearchCreator[]; hasMore: boolean; nextCursor?: string };

  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isPending,
    error,
    refetch,
  } = useInfiniteQuery<Page, Error, { pages: Page[]; pageParams: number[] }, string[], number>({
    queryKey: ["/api/marketplace/prompts", "home", showIgnored ? "ignored" : "", genFilter.join(","), showAdult ? "18+" : "safe", query, community ?? "", media],
    queryFn: async ({ pageParam }) => {
      // Search narrows by the same filter as the feed.
      const models = generatorAliases(genFilter, catalogue);
      if (query) {
        const params = new URLSearchParams({ q: query, type: "all", limit: "24", cursor: String(pageParam) });
        for (const m of models) params.append("models", m);
        if (media !== "all") params.set("media", media);
        if (community) params.set("community", community);
        if (showIgnored) params.set("ignored", "1");
        const res = await fetch(`/api/search?${params.toString()}`, { headers: sessionHeadersWith(showAdult), credentials: "include" });
        if (!res.ok) throw new Error(await failureSentence(res, "Search failed"));
        return (await res.json()) as Page;
      }
      const params = new URLSearchParams({
        limit: "24",
        sortBy: "trending",
        cursor: String(pageParam),
      });
      for (const m of models) params.append("models", m);
      if (media !== "all") params.set("media", media);
      if (community) params.set("community", community);
      if (showIgnored) params.set("ignored", "1");
      const res = await fetch(`/api/marketplace/prompts?${params.toString()}`, { headers: sessionHeadersWith(showAdult), credentials: "include" });
      // The server's own sentence (e.g. "database unreachable") beats a
      // generic one, and a failure must never look like an empty feed.
      if (!res.ok) throw new Error(await failureSentence(res, "Couldn't load prompts"));
      return (await res.json()) as Page;
    },
    getNextPageParam: (lastPage) => {
      const next = lastPage.nextCursor ? parseInt(lastPage.nextCursor, 10) : undefined;
      return Number.isNaN(next) ? undefined : next;
    },
    initialPageParam: 0,
    staleTime: 60_000,
  });

  const index = useBookmarkIndex(authed && data !== undefined);

  /* IntersectionObserver for infinite scroll: 800 px ahead, so the next
     page is asked for before the reader reaches the end. */
  const observerRef = useRef<IntersectionObserver | null>(null);
  const sentinelCallback = useCallback(
    (node: HTMLDivElement | null) => {
      if (observerRef.current) observerRef.current.disconnect();
      observerRef.current = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting && hasNextPage && !isFetchingNextPage) {
          fetchNextPage();
        }
      }, { rootMargin: "800px 0px" });
      if (node) observerRef.current.observe(node);
    },
    [fetchNextPage, hasNextPage, isFetchingNextPage]
  );

  /* Each prompt once: an offset page can repeat the last row of the one
     before when a prompt was listed in between. */
  const allPrompts = useMemo<Card[]>(() => {
    const seen = new Set<string>(gone);
    const cards: Card[] = [];
    for (const raw of (data?.pages ?? []).flatMap((page) => (Array.isArray(page.prompts) ? page.prompts : []))) {
      const card = toFeedCard(raw);
      if (card && !seen.has(card.id)) { seen.add(card.id); cards.push(card); }
    }
    return cards;
  }, [data, gone]);

  const creators = query ? data?.pages[0]?.creators ?? [] : [];

  const visible = useMemo<Card[]>(() => {
    if (!tags.length) return allPrompts;
    // The chips are categories: a prompt has one, and any picked chip shows it.
    return allPrompts.filter((prompt) => tags.includes(prompt.category));
  }, [allPrompts, tags]);

  const pick = (key: string | null) => {
    setTags(key ? [key] : []);
    window.scrollTo({ top: 0 });
  };

  // The open is counted by the prompt view itself, however it was opened (DEC-518).
  const openCard = (card: Card) => { setOpen(card); };
  const closeCard = () => {
    // The view's own read of the prompt answered 404: drop the card for the visit.
    const id = open?.id ?? linked;
    const read = id ? queryClient.getQueryState([`/api/prompts/${id}`]) : undefined;
    if (id && read?.status === "error" && /^404\b/.test(read.error?.message ?? "")) setGone((g) => new Set(g).add(id));
    setOpen(null);
    setLinked(null);
  };
  const seed = open ? seedFromFeedCard(open) : linked ? { promptId: linked } : null;

  const renderCard = (card: Card) => (
    <FeedCard ref={observeCard} card={card} onOpen={openCard} canBookmark={authed} saved={index?.get(card.id)} />
  );

  const showEmpty = !isPending && visible.length === 0 && !isFetchingNextPage;

  return (
    <>
      <div className="feed kit-focus" data-menu-autohide>
        <div className="feed-world">
          <Segmented slide role="tablist" ariaLabel="All, images or videos" value={media} onChange={pickMedia} options={[...MEDIA]} />
        </div>
        <EnkiFilters active={tags} onPick={pick}
          generators={generatorGroups} generatorFilter={genFilter} onGeneratorFilter={setGenFilter}
          showAdult={showAdult} onShowAdult={adultConfirmed ? setAdultPill : undefined}
          community={community} onCommunity={pickCommunity}
          showIgnored={showIgnored} onShowIgnored={ignoring ? setIgnoredPill : undefined} />
        {creators.length > 0 && (
          <div className="feed-creators" aria-label="Creators">
            {creators.map((c) => (
              <button key={c.id} type="button" className="feed-creator" onClick={() => openCreator(c.handle, router)}>
                <span className="feed-creator-initial"><Seal handle={c.handle} /></span>
                <span>{c.displayName}</span>
                <small>@{c.handle}</small>
              </button>
            ))}
          </div>
        )}
        {visible.length > 0 ? (
          <>
            <MasonryGrid items={visible} skeletons={isFetchingNextPage ? 6 : 0} renderItem={renderCard} />
            <div ref={sentinelCallback} className="feed-sentinel" />
          </>
        ) : isPending ? (
          <MasonryGrid items={[]} skeletons={12} renderItem={renderCard} />
        ) : error ? (
          <section className="feed-note" role="alert">
            <h2 className="kit-title">{query ? "Search failed." : "Couldn't load the feed."}</h2>
            <p>{error.message}</p>
            <button type="button" className="ek-btn" onClick={() => void refetch()}>Try again</button>
          </section>
        ) : hasNextPage ? (
          // Nothing to show yet, more to read (a page of hidden creators'
          // cards, or none in the picked category): the sentinel stays on
          // screen and asks for the next page.
          <>
            <div ref={sentinelCallback} className="feed-sentinel" />
            <MasonryGrid items={[]} skeletons={6} renderItem={renderCard} />
          </>
        ) : showEmpty ? (
          <section className="feed-note">
            <h2 className="kit-title">
              {query ? `No ${creators.length ? "prompts" : "results"} for “${query}”.` : videos ? "No video prompts yet." : "No prompts here yet."}
            </h2>
            {(query || !videos) && <p>{query ? "Try another word." : "Adjust your filters to widen the results."}</p>}
          </section>
        ) : null}
      </div>

      {/* The floating "Generate" button, and only that. It used to be handed
          the clicked card as a seed, which opened the quick-create modal
          over the feed — Kev, 2026-08-13: "wenn ich ein image anclicke SOLL
          NICHT quick create oder sowas aufgehen". In All and Images only:
          Quick Create makes pictures. */}
      {!videos && <GenerateLauncher />}

      {/* Clicking a card opens the canonical image view — the same one the
          /generator route and the profile grid open. EnkiDetailPanel is the
          frame that already knows to start where the shell's menu ends. */}
      {seed && (
        <EnkiDetailPanel seed={seed} onClose={closeCard} />
      )}
    </>
  );
}
