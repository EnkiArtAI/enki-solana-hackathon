// app/api/generations/route.ts
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { hideAdult, viewer } from "@/lib/adult-content";
import { hiddenOwners } from "@/lib/hidden-owners";
import { dbUnavailableResponse, isDbUnreachable } from "@/lib/db-error";
import { isListed } from "@/lib/prompt-visibility";
import { openEnvelope, ownerView, renderedFree, valuesOf, type PromptRef } from "@/lib/generation/owner-view";
import { likedAmong } from "@/lib/likes";
import { publicReferences } from "@/lib/public-references";
import {
  getGenerationsQuerySchema,
  validateQuery,
  createErrorResponse,
  createSuccessResponse
} from "../../middleware/validation";

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);

    // Validate query parameters
    const queryValidation = validateQuery(getGenerationsQuerySchema, searchParams);
    if (!queryValidation.success) {
      const errorMessages = queryValidation.errors.map((err: any) => `${err.path.join('.')}: ${err.message}`);
      return createErrorResponse('Invalid query parameters', 400, errorMessages);
    }

    const { limit = 50, offset = 0 } = queryValidation.data;
    // Support both userKey (legacy) and userId
    const userId = searchParams.get("userId") || searchParams.get("userKey");

    if (!userId) {
      return createErrorResponse('userId or userKey is required', 400);
    }

    const supabase = getSupabaseServerClient();

    // Galleries pass a WALLET ADDRESS, the tables key on a user uuid. This used
    // to give up and return an empty list for every wallet caller — which is
    // why the gallery looked empty even when images existed. Resolve it.
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId);
    // Only letters and digits are looked up, so no pattern such as % or * ever
    // reaches the ilike below (it would match many wallets and read as a
    // failure). Not stricter base58: a legacy row lowercased a Solana address,
    // turning L into l, and a foreign profile's gallery asks with that row.
    const isWallet = /^(0x[0-9a-fA-F]{40}|[0-9A-Za-z]{32,44})$/.test(userId);
    // Lower case, as the database answers ids: an upper-case id must not
    // slip past the hidden-owner check below while .eq() still matches it.
    let ownerId = isUuid ? userId.toLowerCase() : null;
    if (!ownerId && isWallet) {
      const { data: walletRow, error: walletError } = await supabase
        .from("user_wallets")
        .select("user_id")
        // addresses are stored lowercased; base58 is case-sensitive, so compare
        // case-insensitively rather than missing every Solana wallet.
        .ilike("address", userId)
        .is("removed_at", null)
        .maybeSingle();
      // A failed lookup is no empty gallery: the catch answers it (503 for an outage).
      if (walletError) throw walletError;
      ownerId = (walletRow?.user_id as string) ?? null;
    }
    if (!ownerId) {
      return createSuccessResponse({ generations: [], total: 0, limit, offset });
    }

    // Images live in generated_images, not generations: the latter holds the
    // generation record (encrypted prompt, prompt_id NOT NULL) and has no image
    // column at all. Reading `generations` here is what made uploads invisible.
    const v = await viewer(supabase, req);
    // A banned or deleted account's gallery is empty to everyone but itself.
    if (v.userId !== ownerId) {
      const hidden = await hiddenOwners(supabase, [ownerId]);
      if (!hidden) return createErrorResponse("Gallery unavailable", 500);
      if (hidden.has(ownerId)) return createSuccessResponse({ generations: [], total: 0, limit, offset });
    }
    let gallery = supabase
      .from("generated_images")
      .select("id, prompt_id, generation_id, storage_url, preview_url, thumbnail_url, description, is_uploaded, is_adult, visibility, created_at", { count: 'exact' })
      .eq("user_id", ownerId)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);
    // Uploads are images nothing has checked yet: no 18+ mark, no child-safety
    // check (the image check is stage 2). Their owner sees them; nobody else
    // does until that check exists.
    // Images are recorded private; a visitor sees only what its owner published.
    if (v.userId !== ownerId) gallery = gallery.eq("is_uploaded", false).eq("visibility", "public");
    const { data, error, count } = await hideAdult(gallery, v, ownerId);

    if (error) {
      console.error('Database error:', error);
      return createErrorResponse('Failed to fetch generations', 500, error.message);
    }

    // The settings each render was made with (Kev, 2026-10-13: a click on a
    // history image loads them into the composer): the generation row's
    // model, ratio, size and boost, and the reference images it was sent
    // (Kev, 2026-10-14), read once for the page. Uploads have none.
    const rows = Array.isArray(data) ? data : [];
    const generationIds = [...new Set(rows.flatMap((r) => (typeof r.generation_id === "string" ? [r.generation_id] : [])))];
    const settingsById = new Map<string, { model_id: string | null; aspect_ratio: string | null; resolution: string | null; boost: boolean | null } & Record<string, unknown>>();
    const referencesById = new Map<string, string[]>();
    // The owner's view of how a render was made (Kev, 2026-10-15): the text and
    // values are encrypted at rest; opened for the owner only, in owner-view.ts.
    const own = v.userId === ownerId;
    // A plain string: the typed select parser cannot read a column list chosen at runtime.
    const genColumns: string = "id, model_id, aspect_ratio, resolution, boost"
      + (own ? ", rail, created_at, final_prompt_ct, final_prompt_iv, final_prompt_tag, final_prompt_kid, variable_values_ct, variable_values_iv, variable_values_tag, variable_values_kid" : "");
    if (generationIds.length) {
      const { data: gens, error: gensError } = await supabase
        .from("generations")
        .select(genColumns as "id, model_id, aspect_ratio, resolution, boost")
        .in("id", generationIds);
      if (gensError) throw gensError;
      for (const g of (gens ?? []) as Array<{ id: string; model_id: string | null; aspect_ratio: string | null; resolution: string | null; boost: boolean | null } & Record<string, unknown>>) settingsById.set(g.id, g);
      // In the order they were sent: "Reference image n" in the text names the n-th. The owner's only: a reference
      // can be a private photo (ENC review, 2026-10-17).
      if (own) {
        const { data: refs, error: refsError } = await supabase
          .from("generation_reference_images")
          .select("generation_id, sequence_index, storage_url")
          .in("generation_id", generationIds)
          .order("sequence_index", { ascending: true });
        if (refsError) throw refsError;
        for (const r of refs ?? []) {
          if (typeof r.storage_url !== "string") continue;
          referencesById.set(r.generation_id, [...(referencesById.get(r.generation_id) ?? []), r.storage_url]);
        }
      }
    }
    // Which of the owner's images show their references once public, for the image UI's switch (DEC-514); none before SQL 43.
    const refsShown = new Set<string>();
    if (own && rows.length) {
      const { data: shown, error: shownError } = await supabase
        .from("generated_images").select("id").in("id", rows.map((r) => String(r.id))).eq("references_public", true);
      if (!shownError) for (const r of shown ?? []) refsShown.add(String(r.id));
    }
    // A visitor gets, per image, only the references its owner shows with it (DEC-514), never the owner's read above;
    // a failed read shows none.
    const shownRefs = own ? null : await publicReferences(supabase, rows.map((r) => String(r.id)));
    const settingsOf = (row: { id: unknown; generation_id?: unknown }) => {
      const id = typeof row.generation_id === "string" ? row.generation_id : null;
      const s = id ? settingsById.get(id) : undefined;
      return s && id
        ? { modelId: s.model_id ?? null, aspectRatio: s.aspect_ratio ?? null, resolution: s.resolution ?? null, boost: s.boost === true, references: (shownRefs ? shownRefs.get(String(row.id)) : referencesById.get(id)) ?? [] }
        : null;
    };
    // The generators' names and the prompts' kind and title, read once for the page.
    const modelIds = [...new Set([...settingsById.values()].flatMap((s) => (typeof s.model_id === "string" ? [s.model_id] : [])))];
    const modelNames = new Map<string, string>();
    if (modelIds.length) {
      const { data: models } = await supabase.from("models").select("id, name").in("id", modelIds);
      for (const m of models ?? []) if (typeof m.name === "string") modelNames.set(String(m.id), m.name);
    }
    const promptIds = [...new Set(rows.flatMap((r) => (typeof r.prompt_id === "string" ? [r.prompt_id] : [])))];
    const promptsById = new Map<string, PromptRef>();
    if (promptIds.length) {
      // The whole visibility record: who may read the text is isPublicText's question, never the price alone, and a
      // failed read answers 503 instead of opening every text (ENC review, 2026-10-17).
      const { data: prompts, error: promptsError } = await supabase
        .from("prompts")
        .select("id, creator_id, is_listed, listing_status, deleted_at, prompt_type, is_free_showcase, price_usd_cents, title")
        .in("id", promptIds);
      if (promptsError) throw promptsError;
      for (const p of prompts ?? []) promptsById.set(String(p.id), p as PromptRef);
    }
    // The prompts' artists, for the link above the text (Kev, 2026-10-15).
    const creatorIds = [...new Set([...promptsById.values()].flatMap((p) => (typeof p.creator_id === "string" ? [p.creator_id] : [])))];
    const artists = new Map<string, { handle: string | null; name: string | null }>();
    if (creatorIds.length) {
      const { data: users } = await supabase.from("users").select("id, handle, display_name").in("id", creatorIds);
      for (const u of users ?? []) artists.set(String(u.id), { handle: typeof u.handle === "string" ? u.handle : null, name: typeof u.display_name === "string" ? u.display_name : null });
    }
    // A visitor sees nothing of a prompt whose creator is banned or deleted, like the share page; unknown = hidden.
    const hiddenCreators = own ? new Set<string>() : await hiddenOwners(supabase, creatorIds);
    const creatorHidden = (id: string) => !hiddenCreators || hiddenCreators.has(id);
    // The viewer's hearts on this page's images, in one read (Kev, 2026-10-15).
    const liked = v.userId ? await likedAmong(supabase, v.userId, "generated_image", rows.map((r) => String(r.id))) : new Set<string>();
    const visiblePromptId = (id: unknown) => {
      const p = typeof id === "string" ? promptsById.get(id) : undefined;
      return p && isListed(p) && !(p.creator_id && creatorHidden(p.creator_id)) ? String(p.id) : null;
    };
    const madeOf = (row: { prompt_id?: unknown; generation_id?: unknown }) => {
      const g = typeof row.generation_id === "string" ? settingsById.get(row.generation_id) : undefined;
      const prompt = typeof row.prompt_id === "string" ? promptsById.get(row.prompt_id) : undefined;
      return {
        model_name: g && typeof g.model_id === "string" ? modelNames.get(g.model_id) ?? null : null,
        // A visitor learns the artist of a listed prompt only, like its title.
        prompt_artist: prompt?.creator_id && (own || (isListed(prompt) && !creatorHidden(prompt.creator_id))) ? artists.get(prompt.creator_id) ?? null : null,
        ...ownerView({
          viewerId: v.userId, ownerId, prompt, hadPrompt: typeof row.prompt_id === "string",
          freeRail: renderedFree(g), creatorHidden: !own && !!prompt?.creator_id && creatorHidden(prompt.creator_id),
          text: own && g ? openEnvelope(g, "final_prompt") : null,
          values: own && g ? valuesOf(openEnvelope(g, "variable_values")) : null,
        }),
      };
    };

    // Keep the shape the galleries already consume (image_url / prompt /
    // isUploaded) so this is a server-side fix with no client changes.
    const generations = rows.map((row) => ({
      id: row.id,
      // image_url stays the ORIGINAL (downloads); image_urls is what the
      // galleries DISPLAY, so the WebP preview leads when one exists.
      image_url: row.storage_url,
      image_urls: (row.preview_url ?? row.storage_url) ? [row.preview_url ?? row.storage_url] : [],
      thumbnail_url: row.thumbnail_url ?? null,
      prompt: row.description ?? "",
      isUploaded: row.is_uploaded === true,
      // An 18+ image has no share page (SHR): the gallery shares the file instead.
      isAdult: row.is_adult === true,
      // The owner's gallery shows it beside the publish switch (SHR-1).
      visibility: row.visibility === "public" ? "public" : "private",
      // Which prompt it was made with: the image UI says where a public one shows. A visitor learns it only while that
      // prompt is on sale, as its share page says (ENC review, 2026-10-27: the id opened id-keyed routes to a draft).
      prompt_id: own ? row.prompt_id ?? null : visiblePromptId(row.prompt_id),
      // What it was made with, for the image UI's composer; null for an upload.
      settings: settingsOf(row),
      referencesPublic: refsShown.has(String(row.id)),
      // How it was made, for the owner: the text or the values, the prompt's kind and title, the generator's name.
      ...madeOf(row),
      liked: liked.has(String(row.id)),
      created_at: row.created_at,
    }));

    return createSuccessResponse({
      generations,
      total: count || 0,
      limit,
      offset
    });
  } catch (e: unknown) {
    if (isDbUnreachable(e)) return dbUnavailableResponse();
    const message = e instanceof Error ? e.message : (e as { message?: string })?.message ?? String(e);
    console.error('Error fetching generations:', message);
    return createErrorResponse('Internal server error', 500);
  }
}
