import { describe, it, expect, beforeEach, vi } from "vitest";
// Banned or deleted owners are hidden-owners.test.ts's subject; here nobody is.
vi.mock("@/lib/hidden-owners", () => ({ hiddenOwners: async () => new Set<string>() }));

/**
 * A user's gallery (GET /api/generations): other people's 18+ only for a
 * confirmed adult with the pill on, and uploads — images nothing has checked
 * yet — only for their owner until the image check exists (2026-10-03).
 * Images are recorded private: a visitor sees only published ones (ENG-02).
 */

type Row = Record<string, unknown>;
let tables: Record<string, Row[]>;

const query = (table: string) => {
  const filters: ((r: Row) => boolean)[] = [];
  let one = false;
  const q = {
    select: () => q,
    eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return q; },
    in: (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return q; },
    is:(c: string, v: null) => { filters.push((r) => (r[c] ?? null) === v); return q; },
    ilike: (c: string, v: string) => { filters.push((r) => String(r[c]).toLowerCase() === v.toLowerCase()); return q; },
    order: () => q,
    range: () => q,
    maybeSingle: () => { one = true; return q; },
    then: (ok: (v: unknown) => unknown) => {
      const rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
      return Promise.resolve(one ? { data: rows[0] ?? null, error: null } : { data: rows, error: null, count: rows.length }).then(ok);
    },
  };
  return q;
};
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => ({ from: query }) }));
vi.mock("@/lib/session-user", () => ({
  resolveSessionUserId: async (_s: unknown, t: string | null) => ({ "owner-tok": OWNER, "adult-tok": "adult" } as Record<string, string>)[t ?? ""] ?? null,
}));

const OWNER = "0b5f2c1e-1111-4222-8333-444455556666";
import { GET } from "../../app/api/generations/route";

const gallery = async (headers: Record<string, string> = {}) => {
  const res = await GET(new Request(`http://enki.test/api/generations?userId=${OWNER}`, { headers }));
  const body = await res.json();
  return ((body.data?.generations ?? body.generations) as Row[]).map((g) => g.id);
};

beforeEach(() => {
  tables = {
    users: [{ id: "adult", adult_confirmed_at: "2026-10-03T10:00:00Z" }, { id: OWNER, adult_confirmed_at: null }],
    generated_images: [
      { id: "plain", user_id: OWNER, is_adult: false, is_uploaded: false, visibility: "public", deleted_at: null },
      { id: "adult-render", user_id: OWNER, is_adult: true, is_uploaded: false, visibility: "public", deleted_at: null },
      { id: "upload", user_id: OWNER, is_adult: false, is_uploaded: true, visibility: "public", deleted_at: null },
      { id: "private", user_id: OWNER, is_adult: false, is_uploaded: false, visibility: "private", deleted_at: null },
    ],
  };
});

// ENC review (2026-10-27): the prompt id opens id-keyed routes, so a visitor learns it only while the prompt is on sale.
describe("which prompt an image was made with", () => {
  const LIVE = { is_listed: true, listing_status: "active", deleted_at: null, creator_id: "artist" };
  beforeEach(() => {
    tables.prompts = [
      { id: "p-live", ...LIVE },
      { id: "p-draft", ...LIVE, is_listed: false },
      { id: "p-delisted", ...LIVE, listing_status: "delisted" },
      { id: "p-deleted", ...LIVE, deleted_at: "2026-10-01T00:00:00Z" },
    ];
    tables.generated_images = ["p-live", "p-draft", "p-delisted", "p-deleted"].map((p) => (
      { id: `img-${p}`, user_id: OWNER, prompt_id: p, is_adult: false, is_uploaded: false, visibility: "public", deleted_at: null }
    ));
  });
  const promptIds = async (headers: Record<string, string> = {}) => {
    const res = await GET(new Request(`http://enki.test/api/generations?userId=${OWNER}`, { headers }));
    return Object.fromEntries(((await res.json()).generations as Row[]).map((g) => [g.id, g.prompt_id]));
  };

  it("is told to a visitor for a prompt on sale only", async () => {
    expect(await promptIds()).toEqual({ "img-p-live": "p-live", "img-p-draft": null, "img-p-delisted": null, "img-p-deleted": null });
  });

  it("is told to the images' owner always", async () => {
    expect(await promptIds({ "X-Session-Token": "owner-tok" })).toEqual({ "img-p-live": "p-live", "img-p-draft": "p-draft", "img-p-delisted": "p-delisted", "img-p-deleted": "p-deleted" });
  });
});

describe("a gallery", () => {
  it("shows a visitor only checked, ordinary images", async () => {
    expect(await gallery()).toEqual(["plain"]);
  });

  it("shows a confirmed adult with the pill on the 18+ renders, not the uploads", async () => {
    expect(await gallery({ "X-Session-Token": "adult-tok", "X-Show-Adult": "1" })).toEqual(["plain", "adult-render"]);
  });

  it("tells its owner which images are published", async () => {
    const res = await GET(new Request(`http://enki.test/api/generations?userId=${OWNER}`, { headers: { "X-Session-Token": "owner-tok" } }));
    const rows = ((await res.json()).generations as Row[]).map((g) => [g.id, g.visibility]);
    expect(rows).toContainEqual(["plain", "public"]);
    expect(rows).toContainEqual(["private", "private"]);
  });

  it("shows its owner everything", async () => {
    expect(await gallery({ "X-Session-Token": "owner-tok" })).toEqual(["plain", "adult-render", "upload", "private"]);
  });
});
