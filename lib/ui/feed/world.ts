/**
 * Explore's top row and Create's switch (Kev, 2026-10-30, on an icon rail with Explore, Create, Studio and Inbox: "ok
 * build ... explore und create links ist super"). Explore shows All | Images | Videos above the categories, in the
 * address as ?media= (All, the default, leaves it out); Create switches Image | Video | Remix in that row's place, as
 * ?create=, its own address. Before (DEC-538) the row was Image | Video | Remix over the feed, as ?world=; nothing was
 * deployed with it, so no old link is mapped.
 */
export const MEDIA = [
  { key: "all", label: "All" },
  { key: "images", label: "Images" },
  { key: "videos", label: "Videos" },
] as const;
export type Media = (typeof MEDIA)[number]["key"];

export const TOOLS = [
  { key: "image", label: "Image" },
  { key: "video", label: "Video" },
  { key: "remix", label: "Remix" },
] as const;
export type Tool = (typeof TOOLS)[number]["key"];

type Search = { get(name: string): string | null };

/** What Explore shows for an address: All for none or anything unknown. */
export function mediaOf(search: Search): Media {
  const asked = search.get("media");
  return MEDIA.find((m) => m.key === asked)?.key ?? "all";
}

/** The address on `pathname` with Explore showing `media`; every other part of the query stays. */
export function mediaLink(pathname: string, search: { toString(): string }, media: Media): string {
  const next = new URLSearchParams(search.toString());
  if (media === "all") next.delete("media");
  else next.set("media", media);
  const query = next.toString();
  return query ? `${pathname}?${query}` : pathname;
}

/** The Create tool an address opens: none (Explore) without ?create=, Image for an unknown one. */
export function toolOf(search: Search): Tool | null {
  const asked = search.get("create");
  return asked === null ? null : TOOLS.find((t) => t.key === asked)?.key ?? "image";
}

/** Create's address, open on `tool`. */
export const toolLink = (tool: Tool) => `/home?create=${tool}`;
