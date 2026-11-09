import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { resolveSessionUserWithBan } from "@/lib/session-user";
import { checkRequestRateLimit, rateLimitKey, rateLimitResponse } from "@/lib/rate-limit";
import { parseReferralLink } from "@/lib/referral-link";
import { importPost, KNOWN_GENERATORS } from "@/lib/editor/post-import";
import { ALREADY, NOT_X, asEnki, judgeImport } from "@/lib/referral/judge-post";
import { sealPreview } from "@/lib/referral/preview-token";

/**
 * Refer a prompt, step one (Kev, 2026-10-14: "input prompt, loading screen,
 * verify, press checkmark, loaded"): the post on X is read here, its prompt
 * and pictures judged as a release is, named and filed by the model
 * (lib/referral/judge-post, the Prompt Hunter's judge too), and handed back
 * sealed. Nothing is stored; POST /api/prompt with the token publishes it
 * (step two). Only X: FxTwitter reads it without a key.
 *
 *   POST { url } → 200 { token, preview }
 *   400 not a post on X · 401 sign in · 409 already referred · 422 refused
 *   (no prompt found, a reply holds it, 18-, explicit) · 503 a check could not run
 */
export async function POST(req: NextRequest) {
  try {
    const supabase = getSupabaseServerClient();
    const { userId, ban } = await resolveSessionUserWithBan(supabase, req.headers.get("X-Session-Token"));
    if (!userId || ban) return NextResponse.json({ error: "Sign in to refer a prompt." }, { status: 401 });
    const limit = checkRequestRateLimit(rateLimitKey(req, "referrals:preview", userId), 10, 10 * 60_000);
    if (!limit.allowed) return rateLimitResponse(limit.retryAfterSeconds);

    const body = (await req.json().catch(() => null)) as { url?: unknown } | null;
    const link = parseReferralLink(body?.url);
    if (!link) return NextResponse.json({ error: "Enter the full link to the post, starting with https://" }, { status: 400 });
    if (link.platform !== "x") return NextResponse.json({ error: NOT_X }, { status: 400 });

    // One prompt per post, whoever referred it first (the Prompt Hunter counts).
    const { data: known } = await supabase.from("hunt_submissions").select("id").eq("normalized_source_url", link.normalized).limit(1);
    if (known?.length) return NextResponse.json({ error: ALREADY }, { status: 409 });

    const read = await importPost(link.url, KNOWN_GENERATORS, asEnki);
    if (!read.ok) return NextResponse.json({ error: read.said }, { status: 422 });

    const judged = await judgeImport(supabase, { plan: read.plan, link, userId, request: req });
    if (!judged.ok) return NextResponse.json({ error: judged.error }, { status: judged.status });
    return NextResponse.json({ token: sealPreview(judged.preview), preview: judged.shown });
  } catch (e) {
    console.error("[referrals/preview]", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "The post could not be read. Try again." }, { status: 500 });
  }
}
