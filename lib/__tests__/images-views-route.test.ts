import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * POST /api/images/views (Kev, 2026-10-29: views by day for posts): well-formed ids reach count_image_opens with the
 * viewer, the same viewer's repeat within a day does not, a guest counts as nobody, and the client never sees an error.
 */
const db = vi.hoisted(() => ({ rpc: [] as { name: string; args: Record<string, unknown> }[], error: null as { code?: string; message: string } | null }));
vi.mock("@/lib/supabaseServer", () => ({
  getSupabaseServerClient: () => ({ rpc: async (name: string, args: Record<string, unknown>) => { db.rpc.push({ name, args }); return { data: 1, error: db.error }; } }),
}));
const session = vi.hoisted(() => ({ user: "u1" as string | null }));
vi.mock("@/lib/session-user", () => ({ resolveSessionUserId: async () => session.user }));
import { POST } from "../../app/api/images/views/route";

const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222";
let ip = 0;
const post = (body: unknown, who = `10.0.0.${ip}`) => POST(new NextRequest("http://localhost/api/images/views", {
  method: "POST", body: typeof body === "string" ? body : JSON.stringify(body),
  headers: { "Content-Type": "application/json", "x-forwarded-for": who, "X-Session-Token": "t" },
}));

describe("POST /api/images/views", () => {
  beforeEach(() => { db.rpc = []; db.error = null; session.user = "u1"; ip += 1; });

  it("counts well-formed ids once per viewer and day, for the signed-in viewer", async () => {
    const res = await post({ ids: [A, A, B, "not-an-id", 7] });
    expect(res.status).toBe(204);
    expect(db.rpc).toEqual([{ name: "count_image_opens", args: { p_images: [A, B], p_viewer: "u1" } }]);
    await post({ ids: [A] });
    expect(db.rpc).toHaveLength(1);
  });

  it("counts a guest as nobody, and caps a batch at 50", async () => {
    session.user = null;
    const many = Array.from({ length: 60 }, (_, i) => `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`);
    await post({ ids: many });
    expect(db.rpc[0].args.p_viewer).toBeNull();
    expect((db.rpc[0].args.p_images as string[]).length).toBe(50);
  });

  it("never errors the client: a bad body, nothing new, or a database that lacks the function", async () => {
    expect((await post("{not json")).status).toBe(204);
    expect((await post({ ids: "x" })).status).toBe(204);
    expect((await post({ ids: ["nope"] })).status).toBe(204);
    expect(db.rpc).toEqual([]);
    db.error = { code: "PGRST202", message: "Could not find the function" };
    expect((await post({ ids: [A] })).status).toBe(204);
  });
});
