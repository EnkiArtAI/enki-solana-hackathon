import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { resolveSessionUserId } from "@/lib/session-user";
import { checkRequestRateLimit, rateLimitKey, rateLimitResponse } from "@/lib/rate-limit";
import { dbUnavailableResponse, isDbUnreachable } from "@/lib/db-error";
import { MAX_REFERENCES, NOT_A_REFERENCE, REFERENCE_BUCKET, REFERENCES_FULL, REFERENCES_NOT_READY, readUpload, referenceFailure, signed, thumbOf } from "@/lib/reference-library";

// Saved reference images (Kev, 2026-10-29; lib/reference-library.ts, migrations/2026-10-29-reference-uploads.sql).
// GET            → { references: [{ id, url, thumb, hash }], deleted: [hash] }: the signed-in account's own, newest
//                  first, at addresses signed for its owner, and the pictures it deleted (the picker hides an earlier
//                  render's copy of one)
// POST { image } → the picture saved (a data URL, as the picker reads it) → { id, url, thumb, hash }; the same picture
//                  again is the same row and the same files, moved to the top

const NOT_STORED = "Could not save that reference right now.";

export async function GET(req: NextRequest) {
  try {
    const supabase = getSupabaseServerClient();
    const me = await resolveSessionUserId(supabase, req.headers.get("X-Session-Token"));
    if (!me) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    const [kept, deleted] = await Promise.all([
      supabase
        .from("reference_uploads")
        .select("id, path, thumb_path, content_hash")
        .eq("user_id", me)
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .limit(MAX_REFERENCES),
      supabase
        .from("reference_uploads")
        .select("content_hash")
        .eq("user_id", me)
        .not("deleted_at", "is", null)
        .order("deleted_at", { ascending: false })
        .limit(MAX_REFERENCES),
    ]);
    if (kept.error || deleted.error) return referenceFailure(kept.error ?? deleted.error, "Could not read your references");
    const references = await signed(supabase, kept.data);
    if (!references) return NextResponse.json({ error: "Could not read your references" }, { status: 500 });
    return NextResponse.json({ references, deleted: deleted.data.map((r) => r.content_hash) });
  } catch (e) {
    if (isDbUnreachable(e)) return dbUnavailableResponse();
    throw e;
  }
}

export async function POST(req: NextRequest) {
  try {
    const supabase = getSupabaseServerClient();
    const me = await resolveSessionUserId(supabase, req.headers.get("X-Session-Token"));
    if (!me) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

    const limit = checkRequestRateLimit(rateLimitKey(req, "reference", me), 30, 60_000);
    if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds);

    const body = (await req.json().catch(() => null)) as { image?: unknown } | null;
    const upload = readUpload(body?.image);
    if (!upload) return NextResponse.json({ error: NOT_A_REFERENCE }, { status: 400 });

    // Before anything is stored: before SQL 51 every save stops here, and so does a full account, so neither leaves a
    // file behind. Neither a deleted one nor the picture itself counts (saving it again at the cap is a yes). SQL 51's
    // trigger holds the cap against two saves at once.
    const { count, error: countError } = await supabase
      .from("reference_uploads")
      .select("id", { count: "exact", head: true })
      .eq("user_id", me)
      .is("deleted_at", null)
      .neq("content_hash", upload.hash);
    if (countError) return referenceFailure(countError, "Could not save that reference");
    // A head read of a table SQL 51 has not made answers no error and no count: postgrest-js 2.103.3 turns PostgREST's
    // empty 404 into a 204 (dist/index.cjs:384-386; VERIFIED live 2026-10-29).
    if (count === null) return NextResponse.json({ error: REFERENCES_NOT_READY }, { status: 503 });
    if (count >= MAX_REFERENCES) return NextResponse.json({ error: REFERENCES_FULL }, { status: 409 });

    const tile = await thumbOf(upload.bytes);
    if (!tile) return NextResponse.json({ error: NOT_A_REFERENCE }, { status: 400 });
    // Named by the picture's hash, so the same picture again overwrites its own files.
    const path = `${me}/${upload.hash}.${upload.type.slice("image/".length)}`;
    const tilePath = `${me}/${upload.hash}.tile.webp`;
    const bucket = supabase.storage.from(REFERENCE_BUCKET);
    const [stored, tiled] = await Promise.all([
      bucket.upload(path, upload.bytes, { contentType: upload.type, upsert: true }),
      bucket.upload(tilePath, tile, { contentType: "image/webp", upsert: true }),
    ]);
    if (stored.error) return NextResponse.json({ error: NOT_STORED }, { status: 503 });

    const { data, error } = await supabase
      .from("reference_uploads")
      .upsert(
        { user_id: me, path, thumb_path: tiled.error ? null : tilePath, content_hash: upload.hash, created_at: new Date().toISOString(), deleted_at: null },
        { onConflict: "user_id,content_hash" },
      )
      .select("id, path, thumb_path, content_hash")
      .single();
    // 23514: SQL 51's cap, met by a save that ran beside this one.
    if (error?.code === "23514") return NextResponse.json({ error: REFERENCES_FULL }, { status: 409 });
    if (error) return referenceFailure(error, "Could not save that reference");
    const [saved] = (await signed(supabase, [data])) ?? [];
    return saved ? NextResponse.json(saved) : NextResponse.json({ error: NOT_STORED }, { status: 503 });
  } catch (e) {
    if (isDbUnreachable(e)) return dbUnavailableResponse();
    throw e;
  }
}
