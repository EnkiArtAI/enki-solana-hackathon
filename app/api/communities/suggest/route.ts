import { NextResponse } from "next/server";
import { textKeys } from "@/lib/communities/handle";
import { COMMUNITY_TEXT, NOT_READ, SUGGEST_LIMIT, type CommunityChip } from "@/lib/communities/types";
import { badRequest, communityFailure, communityHandler, isUuid, overLimit, readBody, toChip } from "@/lib/communities/server";

// The soft suggestion (Kev, 2026-10-30: "der server wird gewiss den community namen im text nicht exakt erraten. vllt ein
// bisschen, ja und auch beim generieren"): communities the words of a surface name, one press each to add; nothing is
// ever added by itself. The text comes in the body, is cut at COMMUNITY_TEXT.suggestText, never logged or stored; its keys
// go to SQL 54's community_suggest in a POST body, never in an address.
// POST SuggestInput → { suggestions }: up to SUGGEST_LIMIT, the biggest first, none already picked

export const POST = communityHandler(async ({ req, supabase, me }) => {
  const limited = overLimit(req, me, "suggest");
  if (limited) return limited;
  const body = await readBody(req);
  if (!body || typeof body.text !== "string" || (body.exclude !== undefined && !(Array.isArray(body.exclude) && body.exclude.every(isUuid)))) return badRequest();
  const keys = textKeys(body.text.slice(0, COMMUNITY_TEXT.suggestText));
  if (!keys.length) return NextResponse.json({ suggestions: [] });
  const { data, error } = await supabase.rpc("community_suggest", { p_keys: keys });
  if (error) return communityFailure(error, NOT_READ);
  const picked = new Set((body.exclude as string[] | undefined) ?? []);
  const suggestions: CommunityChip[] = (data as CommunityChip[]).filter((c) => !picked.has(c.id)).slice(0, SUGGEST_LIMIT).map(toChip);
  return NextResponse.json({ suggestions });
}, { session: "required" });
