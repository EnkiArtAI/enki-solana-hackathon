import { VideoRefused, type VideoAdapter, type VideoPoll, type VideoSubmit } from "./types";

/**
 * Seedance 2.5 and 2.0 on BytePlus ModelArk (Kev's standing order, Seedance first; the only operator with a documented per-user
 * safety field). THIS FILE HAS NEVER MET A REAL API (Kev, 2026-11-03: "noch keinen bezahlten test"): every shape here is the
 * docs' as read 2026-11-03, the first 100,000 of 125,487 chars, and the first paid call is what tells. REPORTED, not read on
 * the official page: the GET path (a search snippet and Bifrost's docs). From memory, the pages answering only their navigation
 * on a second read the same day: an image item's `{ type, image_url: { url }, role }`, and the PrivacyInformation code. NOT
 * DETERMINED: how long video_url lives, so the cron fetches it the minute it is told. No key or answer's words are logged.
 */
const TASKS = "https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks";
/** A task call that hangs must not hold the cron, or a buyer's press. */
const CALL_MS = 30_000;

const headers = () => ({ Authorization: `Bearer ${process.env.ARK_API_KEY}`, "Content-Type": "application/json" });
const image = (url: string, role: "first_frame" | "last_frame" | "reference_image") => ({ type: "image_url", image_url: { url }, role });

/** What a provider's code says of the buyer's input; anything else is no one's finding. */
const kindOf = (code: string | null): "real_person" | "moderation" | "other" =>
  /PrivacyInformation/i.test(code ?? "") ? "real_person" : /SensitiveContent/i.test(code ?? "") ? "moderation" : "other";

const codeOf = (body: unknown): string | null => {
  const code = (body as { error?: { code?: unknown } } | null)?.error?.code;
  return typeof code === "string" ? code : null;
};

export const byteplus: VideoAdapter = {
  configured: () => Boolean(process.env.ARK_API_KEY),

  async submit({ providerModel, words, frames, refs, settings, endUserHash }: VideoSubmit) {
    const res = await fetch(TASKS, {
      method: "POST",
      headers: headers(),
      signal: AbortSignal.timeout(CALL_MS),
      body: JSON.stringify({
        model: providerModel,
        content: [
          { type: "text", text: words },
          ...(frames.start ? [image(frames.start, "first_frame")] : []),
          ...(frames.end ? [image(frames.end, "last_frame")] : []),
          ...refs.map((url) => image(url, "reference_image")),
        ],
        resolution: settings.resolution,
        // "adaptive": its word for what the composer calls auto (lib/video/models AUTO).
        ratio: settings.aspect === "auto" ? "adaptive" : settings.aspect,
        duration: settings.seconds,
        generate_audio: settings.audio,
        watermark: false,
        safety_identifier: endUserHash,
      }),
    });
    const body = (await res.json().catch(() => null)) as { id?: unknown } | null;
    if (!res.ok || typeof body?.id !== "string") {
      const code = codeOf(body);
      const kind = kindOf(code);
      if (kind !== "other") throw new VideoRefused(kind, code);
      throw new Error(`[video] submit answered ${res.status}, code ${code ?? "none"}`);
    }
    return { taskId: body.id };
  },

  async poll(taskId: string): Promise<VideoPoll> {
    const res = await fetch(`${TASKS}/${encodeURIComponent(taskId)}`, { headers: headers(), signal: AbortSignal.timeout(CALL_MS) });
    const body = (await res.json().catch(() => null)) as { status?: unknown; content?: { video_url?: unknown }; usage?: unknown } | null;
    // No answer is no finding: the job stays as it is, and the cron asks again until its deadline.
    if (!res.ok) throw new Error(`[video] poll answered ${res.status}, code ${codeOf(body) ?? "none"}`);
    const url = body?.content?.video_url;
    if (body?.status === "succeeded" && typeof url === "string") return { state: "done", url, usage: body.usage ?? null };
    // Only an end state ends a job: a word this file has not heard fails no buyer at a first poll, with the bill running. Its deadline ends it. The list is from memory, the docs' page answering only its navigation.
    if (body?.status !== "failed" && body?.status !== "expired" && body?.status !== "cancelled") return { state: "running" };
    const code = codeOf(body);
    return { state: "failed", kind: kindOf(code), code: code ?? body.status };
  },
};
