import type { SupabaseClient } from "@supabase/supabase-js";
import { mintUserSession } from "@/lib/user-session";
import { mintStepUpToken } from "@/lib/webauthn";
import type { HuntVariable } from "@/lib/hunter/creator-types";

/**
 * Publishes a judged post as the hunter account, through POST /api/prompt
 * with the sealed preview, the one path every referred prompt takes (the
 * dialog's check mark uses it too). The account gets a session for the
 * call and loses it right after; the route is called in process, so the
 * checks, the showcase, the listing and the referral record are its.
 */
export interface PublishInput {
  publisherId: string;
  token: string;
  title: string;
  category: string;
  /** The cover's generator, by catalogue name. */
  aiModel: string;
  /** The generators offered, by catalogue name; empty = the route's default. */
  aiModels: string[];
  photoCount: number;
  /** The prompt's variables (lib/hunter/variables). */
  variables?: HuntVariable[];
}

export type PublishResult = { ok: true; promptId: string } | { ok: false; error: string };

type PromptRoute = { POST: (req: Request) => Promise<Response> };

export async function publishImported(
  supabase: SupabaseClient,
  p: PublishInput,
  route: () => Promise<PromptRoute> = () => import("../../app/api/prompt/route"),
): Promise<PublishResult> {
  const session = await mintUserSession(p.publisherId);
  try {
    const { POST } = await route();
    const res = await POST(new Request("http://enki.internal/api/prompt", {
      method: "POST",
      headers: {
        "content-type": "application/json", "X-Session-Token": session.token,
        // A new prompt asks for the second factor once the account has one
        // (MFA-4); no human is here to give it, so the server vouches for
        // its own call, as the session above does.
        "X-StepUp-Token": await mintStepUpToken(p.publisherId, "add-prompt"),
      },
      body: JSON.stringify({
        imported: p.token, title: p.title, category: p.category, aiModel: p.aiModel, aiModels: p.aiModels,
        promptType: "free-prompt", price: 0, release: true, content: "", photoCount: p.photoCount, variables: p.variables ?? [],
        uploadedPhotos: [], referenceImages: [],
      }),
    }));
    const body = (await res.json().catch(() => null)) as { id?: unknown; error?: unknown } | null;
    if (!res.ok || typeof body?.id !== "string") {
      return { ok: false, error: typeof body?.error === "string" && body.error ? body.error : `publish failed (${res.status})` };
    }
    return { ok: true, promptId: body.id };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "publish failed" };
  } finally {
    await supabase.from("auth_sessions").delete().eq("token", session.token);
  }
}
