import { HANDLE_RE, type CommunityCard } from "@/lib/communities/types";

/**
 * Where a community is in the address, and how it is named on a card (Kev, 2026-10-30: "wo sehe ich denn die
 * communities, in welcher menüleiste oder wo kann ich nach denen suchen"; "i want at one point to filter for a community
 * and then see all images and videos with it created"). A community's page is the shell's panel
 * (?panel=communities&c=<handle>, lib/ui/kit/shell-nav); /c/<handle> is its door from outside; Explore's filter is
 * ?community=<handle>.
 */

/** Raised by a community chip anywhere: the shell opens its page and takes the event (EnkiHome), as enki:open-creator. */
export const OPEN_COMMUNITY_EVENT = "enki:open-community";
/** Explore's Community filter. */
export const COMMUNITY_PARAM = "community";

/** A handle as the address may carry it: lower-cased, and only in a handle's shape; anything else is none. */
export function handleParam(v: string | null | undefined): string | null {
  const h = v?.trim().toLowerCase();
  return h && HANDLE_RE.test(h) ? h : null;
}

/** The community Explore is filtered to, or none. */
export const communityFilterOf = (search: { get(name: string): string | null }) => handleParam(search.get(COMMUNITY_PARAM));

/** `href` filtered to `handle`, or not filtered; every other part of the address stays. */
export function communityFilterLink(href: string, handle: string | null): string {
  const url = new URL(href, "http://x");
  if (handle) url.searchParams.set(COMMUNITY_PARAM, handle);
  else url.searchParams.delete(COMMUNITY_PARAM);
  return url.pathname + url.search + url.hash;
}

/** A community's door from outside the shell (app/c/[handle]): a link to share. */
export const communityHref = (handle: string) => `/c/${encodeURIComponent(handle)}`;

/** Opens a community's page: the shell takes the event; outside it (no listener) the door does it. */
export function openCommunity(handle: string, router?: { push: (url: string) => void }): void {
  const free = window.dispatchEvent(new CustomEvent(OPEN_COMMUNITY_EVENT, { cancelable: true, detail: { handle } }));
  if (!free) return;
  if (router) router.push(communityHref(handle));
  else window.location.assign(communityHref(handle));
}

const COMPACT = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
/** A count as a card says it: 340, 1.2k, 3.4m. */
export const compact = (n: number) => COMPACT.format(n).toLowerCase();

const plural = (n: number, one: string) => `${compact(n)} ${one}${n === 1 ? "" : "s"}`;
/** "1.2k members · 340 works". */
export const countsLine = (c: Pick<CommunityCard, "members" | "works">) => `${plural(c.members, "member")} · ${plural(c.works, "work")}`;

/** A card's whole name for a screen reader: "c/gundam, Gundam, 1,204 members, 340 works". */
export const cardLabel = (c: Pick<CommunityCard, "handle" | "name" | "members" | "works">) =>
  `c/${c.handle}, ${c.name}, ${c.members.toLocaleString("en")} member${c.members === 1 ? "" : "s"}, ${c.works.toLocaleString("en")} work${c.works === 1 ? "" : "s"}`;
