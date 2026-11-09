"use client";

import { useEffect, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { viewerHeaders } from "@/lib/session-headers";
import {
  COMMUNITIES_NOT_READY, DIRECTORY_PAGE, NOT_READ, NOT_SAVED,
  type CommunityInput, type CommunityPatch, type CommunityResponses, type DirectorySort, type HideInput,
  type ItemKind, type LinksInput, type MergeInput, type PostInput, type SuggestInput, type WorkSort,
} from "@/lib/communities/types";

/**
 * Communities' reads and writes (app/api/communities/**; Kev, 2026-10-30: "propose me something, that cant be duplicated
 * and will work as a harbour AND gallery for people interested in a community"), after hooks/useStudio. Every failure
 * is thrown as the route's own sentence with what came with it (a 409's `existing`, `closest`, `postId`); every write
 * reads Communities anew. Until SQL 54 has run every answer is 503 COMMUNITIES_NOT_READY: `notReady` says so.
 */
export const COMMUNITIES_KEY = ["communities"];
/** The feed's key: a prompt's communities change what Explore's filter and a community's Prompts show. */
const FEED_KEY = ["/api/marketplace/prompts"];

export class CommunityError extends Error {
  constructor(message: string, readonly status: number, readonly extra: Record<string, unknown> = {}) { super(message); }
}
export const isNotReady = (e: unknown) => e instanceof CommunityError && e.status === 503 && e.message === COMMUNITIES_NOT_READY;

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/communities${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...viewerHeaders() },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch(() => null);
  const out = (await res?.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res?.ok) {
    const { error, ...extra } = (out ?? {}) as { error?: string };
    throw new CommunityError(error ?? (method === "GET" ? NOT_READ : NOT_SAVED), res?.status ?? 0, extra);
  }
  return out as T;
}
const at = (s: string) => encodeURIComponent(s);
const query = (o: Record<string, string | number | null | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== null && v !== undefined && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};

/** A read's state as the pages show it: the data, the 503 before SQL 54, else the failure's sentence. */
function stateOf<T>(q: { data: T | undefined; error: Error | null; refetch: () => unknown }) {
  return { data: q.data, notReady: isNotReady(q.error), error: q.error && !isNotReady(q.error) ? q.error.message : null, retry: () => void q.refetch() };
}

function useRead<T>(key: unknown[], path: string, enabled = true) {
  return stateOf(useQuery({ queryKey: [...COMMUNITIES_KEY, ...key], queryFn: () => call<T>("GET", path), enabled, retry: false, staleTime: 30_000 }));
}

type Paged<K extends string, V> = { [P in K]: V[] } & { next: string | null };
/** A list read page by page (`next`), flattened in order. */
function usePaged<K extends string, V>(key: unknown[], path: (cursor: string | null) => string, field: K, enabled = true) {
  const q = useInfiniteQuery({
    queryKey: [...COMMUNITIES_KEY, ...key],
    queryFn: ({ pageParam }) => call<Paged<K, V>>("GET", path(pageParam)),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next,
    enabled, retry: false, staleTime: 30_000,
  });
  const items = q.data?.pages.flatMap((p) => p[field]) ?? [];
  return {
    ...stateOf({ data: q.data, error: q.error, refetch: q.refetch }),
    items, loading: q.isPending && enabled, more: q.hasNextPage, loadingMore: q.isFetchingNextPage, loadMore: () => void q.fetchNextPage(),
  };
}

/** The directory, listed communities in `sort`'s order, page by page. */
export const useCommunityDirectory = (sort: DirectorySort) =>
  usePaged<"communities", CommunityResponses["GET /"]["communities"][number]>(["directory", sort], (cursor) => query({ sort, cursor }), "communities");

/** Typeahead and the directory's search: listed and unlisted, ranked by the server, one page. Nothing for no words. */
export function useCommunityTypeahead(q: string, limit?: number) {
  const words = q.trim();
  return useRead<CommunityResponses["GET /"]>(["search", words, limit ?? null], query({ q: words, limit }), words.length > 0);
}

/** One community, or where its handle redirects (merged, or a look-alike's canonical spelling). */
export const useCommunity = (handle: string) => useRead<CommunityResponses["GET /[handle]"]>(["community", handle], `/${at(handle)}`);

export function useCommunityWorks(handle: string, sort: WorkSort) {
  return usePaged<"works", CommunityResponses["GET /[handle]/works"]["works"][number]>(["list", handle, "works", sort], (cursor) => `/${at(handle)}/works${query({ sort, cursor })}`, "works");
}
export function useCommunityShowroom(handle: string) {
  return usePaged<"posts", CommunityResponses["GET /[handle]/showroom"]["posts"][number]>(["list", handle, "showroom"], (cursor) => `/${at(handle)}/showroom${query({ cursor })}`, "posts");
}
export function useCommunityMembers(handle: string) {
  return usePaged<"members", CommunityResponses["GET /[handle]/members"]["members"][number]>(["list", handle, "members"], (cursor) => `/${at(handle)}/members${query({ cursor })}`, "members");
}
/** A post with its answers ("See all"). */
export const useShowroomPost = (id: string | null) =>
  useRead<CommunityResponses["GET /posts/[id]"]>(["post", id], `/posts/${at(id ?? "")}`, !!id);

/** The communities one item is in (the editor's prompt, a render's ⋯ and viewer). */
export const useItemCommunities = (kind: ItemKind, id: string | null) =>
  useRead<CommunityResponses["GET /links"]>(["links", kind, id], `/links${query({ kind, id })}`, !!id);

/** The merge queue (admins). */
export const useMergeQueue = (enabled: boolean) => useRead<CommunityResponses["GET /merges"]>(["merges"], "/merges", enabled);

/** A community's prompts: the feed's cards, filtered (GET /api/marketplace/prompts?community=). */
export function useCommunityPrompts(handle: string) {
  const q = useInfiniteQuery({
    queryKey: [...FEED_KEY, "community", handle],
    queryFn: async ({ pageParam }) => {
      const res = await fetch(`/api/marketplace/prompts${query({ community: handle, limit: DIRECTORY_PAGE, sortBy: "trending", cursor: pageParam })}`, { headers: viewerHeaders(), credentials: "include" }).catch(() => null);
      if (!res?.ok) throw new Error(NOT_READ);
      return (await res.json()) as { prompts: unknown[]; hasMore: boolean; nextCursor?: string };
    },
    initialPageParam: 0,
    getNextPageParam: (last) => (last.hasMore && last.nextCursor ? Number(last.nextCursor) : undefined),
    retry: false, staleTime: 30_000,
  });
  return { ...stateOf({ data: q.data, error: q.error, refetch: q.refetch }), items: q.data?.pages.flatMap((p) => p.prompts) ?? [], loading: q.isPending, more: q.hasNextPage, loadMore: () => void q.fetchNextPage() };
}

/** The writes; each answers once Communities is read anew (a prompt's links: the feed too). */
export function useCommunitiesApi() {
  const queryClient = useQueryClient();
  const write = <T>(method: string, path: string, body?: unknown, feed = false) =>
    call<T>(method, path, body).then(async (out) => {
      await Promise.all([queryClient.invalidateQueries({ queryKey: COMMUNITIES_KEY }), feed && queryClient.invalidateQueries({ queryKey: FEED_KEY })]);
      return out;
    });
  return {
    create: (input: CommunityInput) => write<CommunityResponses["POST /"]>("POST", "", input),
    patch: (handle: string, input: CommunityPatch) => write<CommunityResponses["PATCH /[handle]"]>("PATCH", `/${at(handle)}`, input),
    remove: (handle: string) => write<CommunityResponses["DELETE /[handle]"]>("DELETE", `/${at(handle)}`),
    join: (handle: string) => write<CommunityResponses["PUT /[handle]/membership"]>("PUT", `/${at(handle)}/membership`),
    leave: (handle: string) => write<CommunityResponses["DELETE /[handle]/membership"]>("DELETE", `/${at(handle)}/membership`),
    setLinks: (input: LinksInput) => write<CommunityResponses["PUT /links"]>("PUT", "/links", input, input.kind === "prompt"),
    /** One more community for one item (a community just started from its picker): its list as the server has it, plus
     *  this one. */
    addLink: async (kind: ItemKind, id: string, communityId: string) => {
      const now = await call<CommunityResponses["GET /links"]>("GET", `/links${query({ kind, id })}`);
      const ids = [...new Set([...now.communities.map((c) => c.id), communityId])];
      return write<CommunityResponses["PUT /links"]>("PUT", "/links", { kind, ids: [id], communityIds: ids }, kind === "prompt");
    },
    /** A read sent as a POST, so the words never travel in an address; it changes nothing. */
    suggest: (input: SuggestInput) => call<CommunityResponses["POST /suggest"]>("POST", "/suggest", input),
    post: (input: PostInput) => write<CommunityResponses["POST /posts"]>("POST", "/posts", input),
    deletePost: (id: string) => write<CommunityResponses["DELETE /posts/[id]"]>("DELETE", `/posts/${at(id)}`),
    hide: (handle: string, input: HideInput) => write<CommunityResponses["POST /[handle]/hide"]>("POST", `/${at(handle)}/hide`, input),
    merge: (input: Extract<MergeInput, { from: string }>) => write<CommunityResponses["POST /merges"]>("POST", "/merges", input),
    keep: (ids: string[]) => write<CommunityResponses["POST /merges"]>("POST", "/merges", { keep: ids }),
  };
}
export type CommunitiesApi = ReturnType<typeof useCommunitiesApi>;

/** `value` once it has held still for `ms` (a field's typing, before it is asked). */
export function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}
