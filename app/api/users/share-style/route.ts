import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { resolveSessionUserId } from "@/lib/session-user";
import { checkRequestRateLimit, rateLimitKey, rateLimitResponse } from "@/lib/rate-limit";
import { dbUnavailableResponse, isDbUnreachable } from "@/lib/db-error";
import { columnMissing } from "@/lib/prompt-references";
import { MAX_STYLE_BYTES, parseStyle } from "@/lib/share/style";

// The signed-in creator's share style (lib/share/style.ts, SQL 71), only ever their own row.
// GET                          → { style }: null when none is kept; { style: null, run } before SQL 71
// PUT { image?, video?, set? } → { ok: true }: those parts kept, the others as they were; 503 { run } before SQL 71
const RUN = "71-share-style.sql";
const UNREADABLE = "That style could not be read.";
const NOT_SAVED = "Could not save your share style";

const failure = (error: { code?: string }, sentence: string) =>
  isDbUnreachable(error) ? dbUnavailableResponse()
  : columnMissing(error) ? NextResponse.json({ error: "Your share style cannot be saved yet.", run: RUN }, { status: 503 })
  : NextResponse.json({ error: sentence }, { status: 500 });

/** The body as JSON, read no further than a style can be long; null for anything longer or unreadable. */
async function styleBody(req: NextRequest): Promise<unknown> {
  if (Number(req.headers.get("content-length")) > MAX_STYLE_BYTES) return null;
  const reader = req.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = (await reader?.read()) ?? { done: true, value: undefined };
      if (done) break;
      size += value.length;
      if (size > MAX_STYLE_BYTES) {
        await reader?.cancel();
        return null;
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  try {
    const supabase = getSupabaseServerClient();
    const me = await resolveSessionUserId(supabase, req.headers.get("X-Session-Token"));
    if (!me) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

    const limit = checkRequestRateLimit(rateLimitKey(req, "share-style:read", me), 120, 60_000);
    if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds);

    const { data, error } = await supabase.from("users").select("id, share_style").eq("id", me).maybeSingle();
    if (columnMissing(error)) return NextResponse.json({ style: null, run: RUN });
    if (error) return failure(error, "Could not read your share style");
    return NextResponse.json({ style: parseStyle(data?.share_style) });
  } catch (e) {
    if (isDbUnreachable(e)) return dbUnavailableResponse();
    throw e;
  }
}

export async function PUT(req: NextRequest) {
  try {
    const supabase = getSupabaseServerClient();
    const me = await resolveSessionUserId(supabase, req.headers.get("X-Session-Token"));
    if (!me) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

    const limit = checkRequestRateLimit(rateLimitKey(req, "share-style", me), 30, 60_000);
    if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds);

    const part = parseStyle(await styleBody(req));
    if (!part) return NextResponse.json({ error: UNREADABLE }, { status: 400 });

    // A press of Done carries the part it edited: a popup that could not read the rest must not wipe it.
    const { data: kept, error: readError } = await supabase.from("users").select("id, share_style").eq("id", me).maybeSingle();
    if (readError) return failure(readError, NOT_SAVED);
    const next = parseStyle({ ...parseStyle(kept?.share_style), ...part });
    if (!next) return NextResponse.json({ error: UNREADABLE }, { status: 400 });

    const { data, error } = await supabase.from("users").update({ share_style: next }).eq("id", me).select("id").maybeSingle();
    if (error) return failure(error, NOT_SAVED);
    return data ? NextResponse.json({ ok: true }) : NextResponse.json({ error: NOT_SAVED }, { status: 500 });
  } catch (e) {
    if (isDbUnreachable(e)) return dbUnavailableResponse();
    throw e;
  }
}
