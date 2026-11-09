import { beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { readSource } from "./_read-source";

/**
 * DEC-512 (Kev, 2026-10-29: "with a new post (prompt creation or post of an image) i want to be notified with the
 * preview image visible in the notification and with the notification saying what was being done there"): the writer
 * names the maker and what they did, and the first release of a prompt calls it. The image route's call is
 * image-visibility.test.ts's, the fan-out the migration test's, the panel notifications-panel-post.test.ts's.
 */
import { notifyFollowers } from "@/lib/notifications";

const MAKER = "0b5f2c1e-1111-4222-8333-444455556666";
let maker: Record<string, unknown> | null;
let rpcs: { fn: string; args: Record<string, unknown> }[];
let rpcError: { message: string } | null;
const supabase = {
  from: () => {
    const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: maker, error: null }) };
    return q;
  },
  rpc: async (fn: string, args: Record<string, unknown>) => { rpcs.push({ fn, args }); return { error: rpcError }; },
} as never;

beforeEach(() => { maker = { handle: "mira", display_name: "Mira" }; rpcs = []; rpcError = null; });

describe("the new-post writer", () => {
  it("names the maker and what they did, with the post and its picture", async () => {
    await notifyFollowers(supabase, { actorUserId: MAKER, kind: "new_prompt", targetId: "p-1", body: "Dune", thumb: "https://blob.test/t.webp" });
    await notifyFollowers(supabase, { actorUserId: MAKER, kind: "new_image", targetId: "i-1" });
    expect(rpcs).toEqual([
      { fn: "notify_followers", args: { p_actor: MAKER, p_kind: "new_prompt", p_title: "Mira released a new prompt", p_body: "Dune", p_target_type: "prompt", p_target: "p-1", p_meta: { thumb: "https://blob.test/t.webp" } } },
      { fn: "notify_followers", args: { p_actor: MAKER, p_kind: "new_image", p_title: "Mira posted a new image", p_body: null, p_target_type: "image", p_target: "i-1", p_meta: {} } },
    ]);
  });

  it("falls back to the handle, then to someone you follow", async () => {
    maker = { handle: "mira", display_name: null };
    await notifyFollowers(supabase, { actorUserId: MAKER, kind: "new_image", targetId: "i-1" });
    maker = null;
    await notifyFollowers(supabase, { actorUserId: MAKER, kind: "new_image", targetId: "i-1" });
    expect(rpcs.map((r) => r.args.p_title)).toEqual(["@mira posted a new image", "Someone you follow posted a new image"]);
  });

  it("never throws into the flow that called it", async () => {
    rpcError = { message: "function notify_followers does not exist" };
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(notifyFollowers(supabase, { actorUserId: MAKER, kind: "new_image", targetId: "i-1" })).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith("[notify] followers dropped:", "new_image", "function notify_followers does not exist");
    log.mockRestore();
  });
});

describe("a prompt's first release", () => {
  it("tells the creator's followers once it is listed, not on a re-save of a listed prompt, an 18+ one without its picture", () => {
    const route = readSource(join(__dirname, "..", "..", "app", "api", "prompt", "route.ts"));
    const listed = route.slice(route.indexOf("if (live) {\n      const { error: listError"), route.indexOf("if (imported) {\n      // The referral itself"));
    expect(listed).toMatch(/if \(nowListed === 0\) \{[\s\S]+?\n {6}\}\n[\s\S]*?if \(!wasListed\) \{\n\s+after\(notifyFollowers\(supabase, \{ actorUserId: payee, kind: "new_prompt", targetId: promptId, body: body\.title, thumb: adult \? null : \(importedShowcase \?\? showcase\)\?\.\[0\] \}\)\);\n\s+\}\n {4}\}/);
  });
});
