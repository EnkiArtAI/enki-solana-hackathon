import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { reachTitle } from "@/components/image-view/useImageViewModel";

/** An imported prompt's social performance beside its rating (Kev, 2026-10-31: "direkt neben der bewertung als social performance"). */
const ROOT = join(__dirname, "..", "..");
const read = (f: string) => readFileSync(join(ROOT, f), "utf8");

describe("the reach beside the rating", () => {
  it("says the original post's numbers, and the chain's sums when it came through forwards", () => {
    expect(reachTitle({ core: { likes: 31, reposts: 5, quotes: 10 }, chain: { posts: 1, likes: 31, reposts: 5, quotes: 10 } }))
      .toBe("On X: 31 likes, 5 reposts, 10 quotes on the original post");
    expect(reachTitle({ core: { likes: 31, reposts: 5, quotes: 10 }, chain: { posts: 2, likes: 49, reposts: 7, quotes: 12 } }))
      .toBe("On X: 31 likes, 5 reposts, 10 quotes on the original post; across 2 posts it was shared through: 49 likes, 7 reposts, 12 quotes");
  });

  it("is read on its own by the prompt API and shown in both views", () => {
    const api = read("app/api/prompts/[id]/route.ts");
    expect(api).toContain('const { data: reachRow } = await supabase.from("prompts").select("source_reach").eq("id", id).maybeSingle();');
    expect(api).toContain("sourceReach: (reachRow as { source_reach?: unknown } | null)?.source_reach ?? null,");
    expect(read("components/image-view/useImageViewModel.ts")).toContain("reach: prompt?.sourceReach ?? null,");
    expect(read("components/image-view/ImageViewDesktop.tsx")).toContain("𝕏 ♥ {m.reach.core.likes} · ↻ {m.reach.core.reposts} · ❝ {m.reach.core.quotes}");
    expect(read("components/image-view/ImageViewMobile.tsx")).toContain("𝕏 ♥ {m.reach.core.likes} ↻ {m.reach.core.reposts} ❝ {m.reach.core.quotes}");
  });
});
