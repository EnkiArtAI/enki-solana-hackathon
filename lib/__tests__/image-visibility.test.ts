import { describe, it, expect, beforeEach, vi } from "vitest";
// Banned or deleted owners are hidden-owners.test.ts's subject; here nobody is.
const hiding = vi.hoisted(() => ({ ids: new Set<string>() }));
vi.mock("@/lib/hidden-owners", () => ({ hiddenOwners: async (_s: unknown, ids: string[]) => new Set(ids.filter((i) => hiding.ids.has(i))) }));
// What a publish leaves to run after the answer (DEC-512): the followers' notification.
const later = vi.hoisted(() => ({ jobs: [] as Promise<unknown>[], notify: vi.fn(async (..._a: unknown[]) => {}) }));
vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  after: (job: () => Promise<unknown>) => { later.jobs.push(job()); },
}));
vi.mock("@/lib/notifications", () => ({ notifyFollowers: later.notify }));
import type { NextRequest } from "next/server";

/**
 * SHR-1. Images are recorded private. Their owner publishes or unpublishes
 * one at a time; GET /api/images/[id] serves only what is published, never
 * an upload before the image check exists, and 18+ only to a confirmed adult
 * with the pill on.
 */

type Row = Record<string, unknown>;
let tables: Record<string, Row[]>;
// A column the database does not have yet: PostgREST refuses an update naming it.
let missingColumn: string | null = null;

const query = (table: string) => {
  const filters: ((r: Row) => boolean)[] = [];
  let patch: Row | null = null;
  let one = false;
  const q = {
    select: () => q,
    update: (values: Row) => { patch = values; return q; },
    eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return q; },
    is: (c: string, v: null) => { filters.push((r) => (r[c] ?? null) === v); return q; },
    maybeSingle: () => { one = true; return q; },
    then: (ok: (v: unknown) => unknown) => {
      if (patch && missingColumn && missingColumn in patch) return Promise.resolve({ data: null, error: { code: "PGRST204", message: "no column" }, count: null }).then(ok);
      const rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
      if (patch) rows.forEach((r) => Object.assign(r, patch));
      return Promise.resolve(one ? { data: rows[0] ?? null, error: null } : { data: rows, error: null, count: rows.length }).then(ok);
    },
  };
  return q;
};
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => ({ from: query }) }));
vi.mock("@/lib/session-user", () => ({
  resolveSessionUserId: async (_s: unknown, t: string | null) => ({ "owner-tok": OWNER, "other-tok": OTHER, "adult-tok": ADULT } as Record<string, string>)[t ?? ""] ?? null,
}));

const OWNER = "0b5f2c1e-1111-4222-8333-444455556666";
const OTHER = "9c1d2e3f-1111-4222-8333-444455556666";
const ADULT = "7a7a7a7a-1111-4222-8333-444455556666";
const id = (n: number) => `${n}a2b3c4d-1111-4222-8333-444455556666`;
const [PUB, PRIV, UPLOAD, GONE, ADULT_IMG] = [1, 2, 3, 4, 5].map(id);

import { GET, PATCH } from "../../app/api/images/[id]/route";

const ctx = (i: string) => ({ params: Promise.resolve({ id: i }) });
const read = (i: string, headers: Record<string, string> = {}) =>
  GET(new Request(`http://enki.test/api/images/${i}`, { headers }) as unknown as NextRequest, ctx(i));
const publish = (i: string, visibility: unknown, headers: Record<string, string> = {}) =>
  PATCH(new Request(`http://enki.test/api/images/${i}`, { method: "PATCH", headers, body: JSON.stringify({ visibility }) }) as unknown as NextRequest, ctx(i));
const visibilityOf = (i: string) => tables.generated_images.find((r) => r.id === i)?.visibility;

beforeEach(() => {
  hiding.ids = new Set();
  missingColumn = null;
  const img = (i: string, extra: Row) => ({ id: i, user_id: OWNER, storage_url: `https://blob.test/${i}.png`, visibility: "public", is_uploaded: false, is_adult: false, deleted_at: null, ...extra });
  tables = {
    users: [{ id: ADULT, adult_confirmed_at: "2026-10-03T10:00:00Z" }],
    generated_images: [
      img(PUB, {}),
      img(PRIV, { visibility: "private" }),
      img(UPLOAD, { is_uploaded: true }),
      img(GONE, { deleted_at: "2026-10-07T00:00:00Z" }),
      img(ADULT_IMG, { is_adult: true }),
    ],
  };
});

describe("reading one image", () => {
  it("serves a published image to anyone", async () => {
    const res = await read(PUB);
    expect(res.status).toBe(200);
    expect((await res.json()).imageUrl).toBe(`https://blob.test/${PUB}.png`);
  });

  it("serves nothing private, uploaded or deleted", async () => {
    for (const i of [PRIV, UPLOAD, GONE]) expect((await read(i, { "X-Session-Token": "owner-tok" })).status, i).toBe(404);
  });

  it("serves 18+ only to a confirmed adult who asked for it", async () => {
    expect((await read(ADULT_IMG)).status).toBe(404);
    expect((await read(ADULT_IMG, { "X-Session-Token": "adult-tok" })).status).toBe(404);
    expect((await read(ADULT_IMG, { "X-Session-Token": "adult-tok", "X-Show-Adult": "1" })).status).toBe(200);
  });
});

// ENC review (2026-10-27): the prompt id opens id-keyed routes, so it is named only while the prompt is on sale.
describe("the prompt a published image names", () => {
  const LIVE = { is_listed: true, listing_status: "active", deleted_at: null, creator_id: "artist" };
  const madeWith = async (prompt: Row | null) => {
    tables.prompts = prompt ? [{ id: "p1", ...prompt }] : [];
    tables.generated_images.find((r) => r.id === PUB)!.prompt_id = "p1";
    return (await (await read(PUB)).json()).promptId;
  };

  it("is the prompt on sale", async () => {
    expect(await madeWith(LIVE)).toBe("p1");
  });

  it("is none for a draft, a delisted or deleted prompt, a hidden creator's or a missing one", async () => {
    for (const p of [{ ...LIVE, is_listed: false }, { ...LIVE, listing_status: "delisted" }, { ...LIVE, deleted_at: "2026-10-01T00:00:00Z" }, null]) {
      expect(await madeWith(p), JSON.stringify(p)).toBeNull();
    }
    hiding.ids = new Set(["artist"]);
    expect(await madeWith(LIVE)).toBeNull();
  });
});

describe("publishing", () => {
  it("lets the owner publish and unpublish", async () => {
    expect((await publish(PRIV, "public", { "X-Session-Token": "owner-tok" })).status).toBe(200);
    expect((await read(PRIV)).status).toBe(200);
    expect((await publish(PRIV, "private", { "X-Session-Token": "owner-tok" })).status).toBe(200);
    expect((await read(PRIV)).status).toBe(404);
  });

  it("answers someone else's image like a missing one and leaves it", async () => {
    expect((await publish(PRIV, "public", { "X-Session-Token": "other-tok" })).status).toBe(404);
    expect((await publish(PRIV, "public")).status).toBe(401);
    expect(visibilityOf(PRIV)).toBe("private");
  });

  it("takes only the two values the database allows", async () => {
    for (const v of ["unlisted", "PUBLIC", "", null, 1]) {
      expect((await publish(PRIV, v, { "X-Session-Token": "owner-tok" })).status, String(v)).toBe(400);
    }
    expect(visibilityOf(PRIV)).toBe("private");
  });

  it("does not touch a deleted image", async () => {
    tables.generated_images.find((r) => r.id === GONE)!.visibility = "private";
    expect((await publish(GONE, "public", { "X-Session-Token": "owner-tok" })).status).toBe(404);
    expect(visibilityOf(GONE)).toBe("private");
  });

  it("does not publish an upload before the image check exists, but lets it be made private", async () => {
    expect((await publish(UPLOAD, "private", { "X-Session-Token": "owner-tok" })).status).toBe(200);
    expect((await publish(UPLOAD, "public", { "X-Session-Token": "owner-tok" })).status).toBe(404);
    expect(visibilityOf(UPLOAD)).toBe("private");
  });

  // DEC-512 (Kev, 2026-10-29: "with a new post (prompt creation or post of an image) i want to be notified").
  it("tells the owner's followers once it is published, with its picture unless 18+; never on unpublish", async () => {
    later.jobs = []; later.notify.mockClear();
    tables.generated_images.find((r) => r.id === PRIV)!.thumbnail_url = "https://blob.test/thumb.webp";
    await publish(PRIV, "public", { "X-Session-Token": "owner-tok" });
    await publish(PRIV, "private", { "X-Session-Token": "owner-tok" });
    tables.generated_images.find((r) => r.id === ADULT_IMG)!.visibility = "private";
    await publish(ADULT_IMG, "public", { "X-Session-Token": "owner-tok" });
    await publish(PRIV, "public", { "X-Session-Token": "other-tok" });
    await Promise.all(later.jobs);
    expect(later.notify.mock.calls.map((c) => c[1])).toEqual([
      { actorUserId: OWNER, kind: "new_image", targetId: PRIV, thumb: "https://blob.test/thumb.webp" },
      { actorUserId: OWNER, kind: "new_image", targetId: ADULT_IMG, thumb: null },
    ]);
  });
});

// DEC-514 (Kev, 2026-10-29: "check if the reference images used to render shall also made public").
describe("showing an image's references", () => {
  const share = (i: string, references: unknown, headers: Record<string, string> = { "X-Session-Token": "owner-tok" }) =>
    PATCH(new Request(`http://enki.test/api/images/${i}`, { method: "PATCH", headers, body: JSON.stringify({ references }) }) as unknown as NextRequest, ctx(i));
  const shownOf = (i: string) => tables.generated_images.find((r) => r.id === i)?.references_public;

  it("is the owner's switch, on and off, and leaves the image's visibility alone", async () => {
    const res = await share(PUB, true);
    expect([res.status, await res.json()]).toEqual([200, { id: PUB, references: true }]);
    expect([shownOf(PUB), visibilityOf(PUB)]).toEqual([true, "public"]);
    await share(PUB, false);
    expect(shownOf(PUB)).toBe(false);
  });

  it("answers someone else's or a deleted image like a missing one, a guest with a login, and only takes yes or no", async () => {
    expect((await share(PUB, true, { "X-Session-Token": "other-tok" })).status).toBe(404);
    expect((await share(GONE, true)).status).toBe(404);
    expect((await share(PUB, true, {})).status).toBe(401);
    expect((await share(PUB, "yes")).status).toBe(400);
    expect([shownOf(PUB), shownOf(GONE)]).toEqual([undefined, undefined]);
  });

  it("says it is not there yet before SQL 43", async () => {
    missingColumn = "references_public";
    const res = await share(PUB, true);
    expect([res.status, await res.json()]).toEqual([503, { error: "Showing references is not available yet" }]);
  });
});
