import { NextResponse } from "next/server";
import { affixes, checkHandle, closest, coreWord, handleKey, rankMatches, slugify } from "@/lib/communities/handle";
import {
  CLOSE_MATCHES, CLOSEST_LIMIT, COMMUNITY_TEXT, DIRECTORY_PAGE, DIRECTORY_SORTS, HANDLE_MIN, HANDLE_TAKEN, NOT_READ, NOT_SAVED,
  TYPEAHEAD_LIMIT, type CommunityCardRow, type DirectorySort,
} from "@/lib/communities/types";
import {
  COLS, badRequest, communityFailure, communityHandler, detailOf, offsetOf, overLimit, readBody, readText, say, screened, toCard,
  type Supabase,
} from "@/lib/communities/server";

// The directory and creating a community (Kev, 2026-10-30: "es sollte permissionless erstellt werden und dann brauchen wir
// auch eine auflistung aller communities"; "es wäre schon sinnvoll, wenn man nach der community suchen könnte, wobei einem
// diese vorgeschlagen wird und man eine aufmachen kann, wenn es keine dazu gibt"; lib/communities/types.ts, SQL 54).
// GET ?sort=trending|new|az&cursor= → { communities, next }: listed cards, DIRECTORY_PAGE a page
// GET ?q=&limit=                    → { communities, next: null }: listed and unlisted, ranked (lib/communities/handle.ts
//                                     rankMatches): by handle, search word, a handle merged into it, or name
// POST CommunityInput               → 201 { community }, its creator joined; 409 HANDLE_TAKEN { existing }; 409
//                                     CLOSE_MATCHES { closest } unless confirmed

const ORDER: Record<DirectorySort, [string, boolean][]> = {
  trending: [["works_7d", false], ["members", false], ["created_at", false], ["id", true]],
  new: [["created_at", false], ["id", true]],
  az: [["handle", true]],
};
// A prefix read's rows before ranking: the biggest first, so the best of a long prefix are in.
const SOURCE_ROWS = 100;
// Typed text as a like pattern of itself: PostgREST reads * as a wildcard too, so it goes; % and _ are taken as themselves.
const literal = (text: string) => text.replace(/\*/g, "").replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * What a new community is asked about before it is made (Kev, 2026-10-30: "that cant be duplicated"; "duplikate wie
 * gundam 1, gundam 2, und gundam iwas"; "there are vamps"): cards named exactly like it, then closest() over the cards
 * near its handle and near its name's slug (a name taken under another handle is a duplicate too): the same core, the
 * same first 3 key characters, a core its key starts or ends with, a key that starts or ends with its core.
 */
async function closeTo(supabase: Supabase, handle: string, name: string): Promise<CommunityCardRow[] | Response> {
  const cards = () => supabase.from("community_cards").select(COLS.card).limit(200);
  const probes = [...new Set([handle, slugify(name)])].filter((h) => h.length >= HANDLE_MIN);
  const reads = await Promise.all([
    cards().ilike("name", literal(name)),
    ...probes.flatMap((h) => {
      const [key, core] = [handleKey(h), coreWord(h)];
      return [cards().eq("core", core), cards().like("handle_key", `${key.slice(0, 3)}%`), cards().in("core", affixes(key)),
        cards().like("handle_key", `${core}%`), cards().like("handle_key", `%${core}`)];
    }),
  ]);
  const failed = reads.find((r) => r.error)?.error;
  if (failed) return communityFailure(failed, NOT_READ);
  const [named, ...near] = reads.map((r) => r.data as CommunityCardRow[]);
  const candidates = [...new Map(near.flat().map((c) => [c.id, c])).values()];
  const close = [...named.filter((c) => c.name.toLowerCase() === name.toLowerCase()), ...probes.flatMap((h) => closest(h, candidates))];
  return [...new Map(close.map((c) => [c.id, c])).values()].slice(0, CLOSEST_LIMIT);
}

export const GET = communityHandler(async ({ req, supabase }) => {
  const limited = overLimit(req, null, "read");
  if (limited) return limited;
  const params = new URL(req.url).searchParams;
  const q = (params.get("q") ?? "").trim();
  if (!q) {
    const sort = (params.get("sort") ?? "trending") as DirectorySort;
    if (!DIRECTORY_SORTS.includes(sort)) return badRequest();
    const offset = offsetOf(params.get("cursor"));
    let read = supabase.from("community_cards").select(COLS.card).eq("listed", true);
    for (const [column, ascending] of ORDER[sort]) read = read.order(column, { ascending });
    const { data, error } = await read.range(offset, offset + DIRECTORY_PAGE);
    if (error) return communityFailure(error, NOT_READ);
    const rows = data as CommunityCardRow[];
    return NextResponse.json({ communities: rows.slice(0, DIRECTORY_PAGE).map(toCard), next: rows.length > DIRECTORY_PAGE ? String(offset + DIRECTORY_PAGE) : null });
  }
  if (q.length > COMMUNITY_TEXT.query) return badRequest();
  const limit = Math.min(DIRECTORY_PAGE, Math.max(1, Number.parseInt(params.get("limit") ?? "", 10) || TYPEAHEAD_LIMIT));
  const key = handleKey(slugify(q));
  const name = `%${literal(q)}%`;
  const cards = () => supabase.from("community_cards").select(COLS.card).order("works", { ascending: false }).order("members", { ascending: false }).limit(SOURCE_ROWS);
  const none = Promise.resolve({ data: [], error: null });
  // The exact key apart: a hundred bigger ones that start with it never push it out.
  const [exact, byHandle, byName, byWord, byMerged] = await Promise.all([
    key ? supabase.from("community_cards").select(COLS.card).eq("handle_key", key) : none,
    key ? cards().like("handle_key", `${key}%`) : none,
    cards().ilike("name", name),
    key ? supabase.from("community_aliases").select("community_id, alias_key").like("alias_key", `${key}%`).limit(SOURCE_ROWS) : none,
    key ? supabase.from("communities").select("merged_into, handle_key").like("handle_key", `${key}%`).not("merged_into", "is", null).limit(SOURCE_ROWS) : none,
  ]);
  const failed = exact.error ?? byHandle.error ?? byName.error ?? byWord.error ?? byMerged.error;
  if (failed) return communityFailure(failed, NOT_READ);
  // A search word is its community's, and stays on a merged one's row: that one's target's, as a merged handle is.
  const aliases = byWord.data as { community_id: string; alias_key: string }[];
  const owners = aliases.length ? await supabase.from("communities").select("id, merged_into").in("id", [...new Set(aliases.map((a) => a.community_id))]) : { data: [], error: null };
  if (owners.error) return communityFailure(owners.error, NOT_READ);
  const to = new Map((owners.data as { id: string; merged_into: string | null }[]).map((o) => [o.id, o.merged_into ?? o.id]));
  const words = [
    ...aliases.flatMap((a) => (to.has(a.community_id) ? [[to.get(a.community_id)!, a.alias_key]] : [])),
    ...(byMerged.data as { merged_into: string; handle_key: string }[]).map((m) => [m.merged_into, m.handle_key]),
  ];
  const found = new Map([...(exact.data as CommunityCardRow[]), ...(byHandle.data as CommunityCardRow[]), ...(byName.data as CommunityCardRow[])].map((c) => [c.id, c]));
  const missing = [...new Set(words.map(([id]) => id))].filter((id) => !found.has(id));
  const more = missing.length ? await supabase.from("community_cards").select(COLS.card).in("id", missing) : { data: [], error: null };
  if (more.error) return communityFailure(more.error, NOT_READ);
  for (const c of more.data as CommunityCardRow[]) found.set(c.id, c);
  const ranked = rankMatches(q, [...found.values()].map((c) => ({ ...c, words: words.filter(([id]) => id === c.id).map(([, k]) => k) })));
  return NextResponse.json({ communities: ranked.slice(0, limit).map(toCard), next: null });
}, { session: "optional" });

export const POST = communityHandler(async ({ req, supabase, me }) => {
  const limited = overLimit(req, me, "write");
  if (limited) return limited;
  const body = await readBody(req);
  if (!body) return badRequest();
  const text = readText(body, ["name", "description"], true);
  if ("error" in text) return say(text.error, 400);
  if (body.handle != null && typeof body.handle !== "string") return badRequest();
  const handle = typeof body.handle === "string" ? body.handle.trim().toLowerCase() : slugify(text.values.name!);
  const wrong = checkHandle(handle);
  if (wrong) return say(wrong, 400);
  const refused = screened({ ...text.values, handle: handle.replaceAll("_", " ") });
  if (refused) return refused;

  // Taken by its key (a merged one's included): the one that is there, or the one it was merged into.
  const key = handleKey(handle);
  const taken = await supabase.from("communities").select("id, merged_into").eq("handle_key", key).maybeSingle();
  if (taken.error) return communityFailure(taken.error, NOT_READ);
  if (taken.data) return existing(taken.data.merged_into ?? taken.data.id);
  // Close ones first (agreed 2026-10-30: "Es gibt schon c/gundam (1.2k) - trotzdem neu?"), unless made anyway.
  if (body.confirmed !== true) {
    const close = await closeTo(supabase, handle, text.values.name!);
    if (close instanceof Response) return close;
    if (close.length) return say(CLOSE_MATCHES, 409, { closest: close.map(toCard) });
  }

  const made = await supabase.from("communities")
    .insert({ handle, core: coreWord(handle), name: text.values.name, description: text.values.description ?? null, created_by: me })
    .select("id").single();
  // 23505: the same key made meanwhile; 23514: the day's or the account's cap.
  if (made.error) {
    if (made.error.code !== "23505") return communityFailure(made.error, NOT_SAVED);
    const now = await supabase.from("communities").select("id, merged_into").eq("handle_key", key).maybeSingle();
    return now.data ? existing(now.data.merged_into ?? now.data.id) : communityFailure(made.error, NOT_SAVED, HANDLE_TAKEN);
  }
  // Its creator joins; a join that fails leaves the community made and says so in `joined`.
  await supabase.from("community_members").insert({ community_id: made.data.id, user_id: me });
  const detail = await detailOf(supabase, made.data.id, me);
  if (detail instanceof Response) return detail;
  return detail ? NextResponse.json({ community: detail }, { status: 201 }) : say(NOT_SAVED, 500);

  async function existing(id: string) {
    const card = await supabase.from("community_cards").select(COLS.card).eq("id", id).maybeSingle();
    if (card.error) return communityFailure(card.error, NOT_READ);
    return say(HANDLE_TAKEN, 409, card.data ? { existing: toCard(card.data as CommunityCardRow) } : undefined);
  }
}, { session: "required" });
