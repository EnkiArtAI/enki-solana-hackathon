import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { join } from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { fakePostgrest } from "./_fake-postgrest";
import { readSource } from "./_read-source";

/**
 * app/api/references (Kev, 2026-10-29: "the images uploaded via ref image uploading must remain in that image upload UI
 * until i delete them, this must be the database of uploaded referenced images"). A signed-in account saves a picture as
 * the picker reads it, lists its own newest first and deletes one. A saved picture is checked only at the render that
 * sends it, so it is kept in a private bucket and reached through addresses signed for its owner (DEC-525). Before SQL 51
 * runs, every request says so in one sentence and nothing is stored.
 */
const db = vi.hoisted(() => ({ current: null as ReturnType<typeof import("./_fake-postgrest").fakePostgrest> | null, reads: [] as string[] }));
// The storage bucket: what is kept where, and each call; `failUpload` refuses the paths it matches.
const store = vi.hoisted(() => ({
  files: new Map<string, { bytes: Buffer; contentType: string }>(),
  calls: [] as string[],
  failUpload: null as RegExp | null, failSign: false, failRemove: false,
}));
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => ({
  from: (t: string) => { db.reads.push(t); return (db.current!.client as { from: (t: string) => unknown }).from(t); },
  storage: { from: (bucket: string) => ({
    upload: async (path: string, bytes: Buffer, o: { contentType: string; upsert: boolean }) => {
      store.calls.push(`upload ${bucket} ${path} ${o.contentType} upsert=${o.upsert}`);
      if (store.failUpload?.test(path)) return { data: null, error: { message: "down" } };
      store.files.set(path, { bytes, contentType: o.contentType });
      return { data: { path }, error: null };
    },
    createSignedUrls: async (paths: string[], ttl: number) => {
      store.calls.push(`sign ${bucket} ${ttl}`);
      if (store.failSign) return { data: null, error: { message: "down" } };
      return { data: paths.map((p) => ({ path: p, signedUrl: store.files.has(p) ? `https://db.test/storage/v1/object/sign/${bucket}/${p}?token=t` : null })), error: null };
    },
    remove: async (paths: string[]) => {
      store.calls.push(`remove ${bucket} ${paths.join(" ")}`);
      if (store.failRemove) throw new TypeError("network");
      paths.forEach((p) => store.files.delete(p));
      return { data: [], error: null };
    },
  }) },
}) }));
const ME = "0b5f2c1e-1111-4222-8333-444455556666";
const HER = "9c1d2e3f-1111-4222-8333-444455556666";
vi.mock("@/lib/session-user", async () => {
  const { DbUnreachableError } = await import("@/lib/db-error");
  return { resolveSessionUserId: async (_s: unknown, t: string | null) => {
    if (t === "down") throw new DbUnreachableError();
    return ({ me: ME, her: HER } as Record<string, string>)[t ?? ""] ?? null;
  } };
});

import { GET, POST } from "../../app/api/references/route";
import { DELETE } from "../../app/api/references/[id]/route";
import { MAX_REFERENCES, REFERENCE_BUCKET, REFERENCE_SIGN_TTL, readUpload } from "@/lib/reference-library";
import { REQUEST_MAX_BYTES } from "@/lib/request-size";

const as =(token: string | null) => (token ? { "X-Session-Token": token } : {}) as Record<string, string>;
const json = async (res: Response) => [res.status, await res.json()];
const list = async (token: string | null = "me") => json(await GET(new NextRequest("http://enki.test/api/references", { headers: as(token) })));
const post = async (body: unknown, token: string | null = "me") => json(await POST(new NextRequest("http://enki.test/api/references", {
  method: "POST", headers: { "Content-Type": "application/json", ...as(token) }, body: JSON.stringify(body),
})));
const remove = async (id: string, token: string | null = "me") =>
  json(await DELETE(new NextRequest(`http://enki.test/api/references/${id}`, { method: "DELETE", headers: as(token) }), { params: Promise.resolve({ id }) }));
const rows = () => db.current!.tables.reference_uploads ?? [];

const picture = (background: string, format: "webp" | "png" | "jpeg" = "webp", width = 600, height = 300) =>
  sharp({ create: { width, height, channels: 3, background } })[format]().toBuffer();
const dataUrl = (type: string, bytes: Buffer) => `data:${type};base64,${bytes.toString("base64")}`;
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const signed = (path: string) => `https://db.test/storage/v1/object/sign/reference-uploads/${path}?token=t`;
const NOT_A_REFERENCE = { error: "Only a PNG, JPEG or WebP image under 4 MB can be saved." };
const FULL = { error: "You can keep up to 50 references. Delete some first." };
const NOT_YET = { error: "Saving references is not available yet." };
const NOT_STORED = { error: "Could not save that reference right now." };
const seed = (who: string, n: number, from = 0, deleted_at: string | null = null) => {
  for (let i = from; i < from + n; i++) rows().push({ id: crypto.randomUUID(), user_id: who, path: `${who}/x${i}.webp`, thumb_path: null, content_hash: String(i).padStart(64, "0"), created_at: "2026-10-01T00:00:00Z", deleted_at });
};

let RED: Buffer, BLUE: Buffer;
let clock = Date.now();
beforeEach(async () => {
  // A fresh minute for each test: the rate limit is the one under test only where it says so.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime((clock += 120_000));
  db.current = fakePostgrest();
  db.reads = [];
  db.current.tables.reference_uploads = [];
  store.files.clear(); store.calls = []; store.failUpload = null; store.failSign = false; store.failRemove = false;
  RED ??= await picture("#c00");
  BLUE ??= await picture("#00c");
});
afterAll(() => { vi.useRealTimers(); });

describe("saving a reference", () => {
  it("keeps the picture and a 256 px tile in the private bucket under its hash, and one row; answers them signed for its owner", async () => {
    const [status, body] = await post({ image: dataUrl("image/webp", RED) });
    expect(status).toBe(200);
    const [path, tilePath] = [`${ME}/${sha(RED)}.webp`, `${ME}/${sha(RED)}.tile.webp`];
    expect(REFERENCE_BUCKET).toBe("reference-uploads");
    expect(store.calls).toEqual([
      `upload reference-uploads ${path} image/webp upsert=true`,
      `upload reference-uploads ${tilePath} image/webp upsert=true`,
      `sign reference-uploads ${REFERENCE_SIGN_TTL}`,
    ]);
    // An hour, and the client reads the list anew before it lapses (hooks/useReferenceLibrary).
    expect(REFERENCE_SIGN_TTL).toBe(3_600);
    expect(store.files.get(path)!.bytes.equals(RED)).toBe(true);
    const meta = await sharp(store.files.get(tilePath)!.bytes).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["webp", 256, 128]);
    expect(body).toEqual({ id: expect.stringMatching(/^[0-9a-f-]{36}$/), url: signed(path), thumb: signed(tilePath), hash: sha(RED) });
    expect(rows()).toEqual([{ id: body.id, user_id: ME, path, thumb_path: tilePath, content_hash: sha(RED), created_at: expect.any(String), deleted_at: null }]);
    // A small picture's tile is never larger than it; a PNG keeps its type and its name says so.
    const small = await picture("#0c0", "png", 40, 20);
    await post({ image: dataUrl("image/png", small) });
    expect(store.files.get(`${ME}/${sha(small)}.png`)?.contentType).toBe("image/png");
    expect((await sharp(store.files.get(`${ME}/${sha(small)}.tile.webp`)!.bytes).metadata()).width).toBe(40);
  });

  it("the same picture again is the same row and the same files, moved to the top; another picture is a second row", async () => {
    const [, first] = await post({ image: dataUrl("image/webp", RED) });
    const at = rows()[0].created_at;
    vi.setSystemTime((clock += 1_000));
    const [status, again] = await post({ image: dataUrl("image/webp", RED) });
    expect([status, again]).toEqual([200, first]);
    expect(rows()).toHaveLength(1);
    expect(String(rows()[0].created_at) > String(at)).toBe(true);
    expect(store.files.size).toBe(2);
    await post({ image: dataUrl("image/webp", BLUE) });
    expect(rows().map((r) => r.content_hash)).toEqual([sha(RED), sha(BLUE)]);
  });

  it("takes a JPEG as well, and refuses anything else, storing nothing and reading nothing", async () => {
    const jpeg = await picture("#c00", "jpeg");
    expect((await post({ image: dataUrl("image/jpeg", jpeg) }))[1].url).toBe(signed(`${ME}/${sha(jpeg)}.jpeg`));
    store.calls = []; db.reads = []; db.current!.tables.reference_uploads = [];
    const gif = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#c00" } }).gif().toBuffer();
    const webp64 = RED.toString("base64");
    for (const body of [
      null, {}, { image: 7 }, { image: "https://elsewhere.example/a.webp" }, { image: webp64 },
      { image: dataUrl("image/gif", gif) },
      { image: dataUrl("image/png", RED) }, // a WebP that says PNG
      { image: dataUrl("text/html", RED) }, { image: dataUrl("image/svg+xml", Buffer.from("<svg/>")) },
      { image: `data:image/webp,${encodeURIComponent(RED.toString("latin1"))}` },
      { image: `data:image/webp;base64,${webp64.slice(0, 40)}\n${webp64.slice(40)}` },
      { image: ` ${dataUrl("image/webp", RED)}` },
      // Whole up to a character base64 has not: the stored file would be other bytes than the row's hash.
      { image: `${dataUrl("image/webp", RED)}#x` },
    ]) {
      expect(await post(body), JSON.stringify(body)?.slice(0, 60)).toEqual([400, NOT_A_REFERENCE]);
    }
    expect([store.calls, db.reads]).toEqual([[], []]);
    // A WebP's first bytes and nothing behind them: no picture decodes from it, so none is kept.
    const cut = Buffer.concat([RED.subarray(0, 16), Buffer.alloc(64)]);
    expect(await post({ image: dataUrl("image/webp", cut) })).toEqual([400, NOT_A_REFERENCE]);
    expect([store.calls, rows()]).toEqual([[], []]);
  });

  it("holds 50 kept per account before anything is stored; a deleted one, the picture saved again and other accounts' do not count", async () => {
    seed(ME, MAX_REFERENCES - 1);
    seed(ME, 5, 2000, "2026-10-02T00:00:00Z");
    seed(HER, 3, 1000);
    expect((await post({ image: dataUrl("image/webp", RED) }))[0]).toBe(200);
    const calls = store.calls.length;
    expect(await post({ image: dataUrl("image/webp", BLUE) })).toEqual([409, FULL]);
    // Nothing was stored for the refused one.
    expect(store.calls).toHaveLength(calls);
    // At the cap, a picture already kept moves to the top: a yes.
    vi.setSystemTime((clock += 1_000));
    expect((await post({ image: dataUrl("image/webp", RED) }))[0]).toBe(200);
    expect(rows().filter((r) => r.user_id === ME && !r.deleted_at)).toHaveLength(MAX_REFERENCES);
    expect((await post({ image: dataUrl("image/webp", BLUE) }, "her"))[0]).toBe(200);
  });

  it("answers SQL 51's cap (23514), met by a save beside this one, in the same sentence", async () => {
    db.current!.state.failNext = { table: "reference_uploads", op: "upsert", code: "23514" };
    expect(await post({ image: dataUrl("image/webp", RED) })).toEqual([409, FULL]);
    expect(rows()).toEqual([]);
  });

  it("keeps no row when the picture could not be stored, and the picture as its own tile when only the tile failed", async () => {
    store.failUpload = new RegExp(`${sha(RED)}\\.webp$`);
    expect(await post({ image: dataUrl("image/webp", RED) })).toEqual([503, NOT_STORED]);
    expect(rows()).toEqual([]);
    store.failUpload = /\.tile\.webp$/;
    const [status, body] = await post({ image: dataUrl("image/webp", RED) });
    expect([status, body.thumb, rows()[0].thumb_path]).toEqual([200, signed(`${ME}/${sha(RED)}.webp`), null]);
    expect(await list()).toEqual([200, { references: [{ id: body.id, url: body.url, thumb: body.url, hash: sha(RED) }], deleted: [] }]);
    // Saved, but no address could be signed for it: not answered as saved (the next read lists it).
    store.failSign = true;
    expect(await post({ image: dataUrl("image/webp", BLUE) })).toEqual([503, NOT_STORED]);
    expect(await list()).toEqual([500, { error: "Could not read your references" }]);
  });

  it("is rate limited per account: 30 saves a minute; deleting counts apart", async () => {
    const image = dataUrl("image/webp", RED);
    for (let i = 0; i < 30; i++) expect((await post({ image }))[0]).toBe(200);
    expect(await post({ image })).toEqual([429, { error: "Too many requests" }]);
    expect((await post({ image }, "her"))[0]).toBe(200);
    const mine = String(rows()[0].id);
    expect((await remove(mine))[0]).toBe(200);
    for (let i = 0; i < 29; i++) expect((await remove(mine))[0]).toBe(404);
    expect(await remove(mine)).toEqual([429, { error: "Too many requests" }]);
  });
});

describe("what can be saved", () => {
  it("is a base64 data URL of a PNG, JPEG or WebP whose bytes are that type, at most the size a request carries", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const padded = (chars: number) => {
      const bytes = Buffer.concat([png, Buffer.alloc(((chars - 22) / 4) * 3 - png.length)]);
      return dataUrl("image/png", bytes);
    };
    expect(padded(REQUEST_MAX_BYTES - 2)).toHaveLength(REQUEST_MAX_BYTES - 2);
    expect(readUpload(padded(REQUEST_MAX_BYTES - 2))?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(readUpload(padded(REQUEST_MAX_BYTES + 2))).toBeNull();
    const up = readUpload(dataUrl("image/png", png));
    expect(up && [up.type, up.bytes.equals(png), up.hash]).toEqual(["image/png", true, sha(png)]);
  });
});

describe("listing and deleting", () => {
  const keep = (id: string, who: string, name: string, at: string, thumb: boolean, deleted_at: string | null = null) => {
    store.files.set(`${who}/${name}.webp`, { bytes: Buffer.from(name), contentType: "image/webp" });
    if (thumb) store.files.set(`${who}/${name}.tile.webp`, { bytes: Buffer.from(name), contentType: "image/webp" });
    rows().push({ id, user_id: who, path: `${who}/${name}.webp`, thumb_path: thumb ? `${who}/${name}.tile.webp` : null, content_hash: name, created_at: at, deleted_at });
  };

  it("lists my own kept ones, newest first, signed, each with its tile or its picture where it has none, and the hashes I deleted", async () => {
    keep("a1", ME, "a", "2026-10-02T00:00:00Z", true);
    keep("h1", HER, "h", "2026-10-03T00:00:00Z", false);
    keep("b1", ME, "b", "2026-10-01T00:00:00Z", false);
    keep("d1", ME, "d", "2026-10-01T00:00:00Z", false, "2026-10-04T00:00:00Z");
    keep("e1", HER, "e", "2026-10-01T00:00:00Z", false, "2026-10-04T00:00:00Z");
    // A row whose picture has no file (a delete that met a save) is left out.
    rows().push({ id: "g1", user_id: ME, path: `${ME}/gone.webp`, thumb_path: null, content_hash: "g", created_at: "2026-10-01T00:00:00Z", deleted_at: null });
    store.calls = [];
    expect(await list()).toEqual([200, { references: [
      { id: "a1", url: signed(`${ME}/a.webp`), thumb: signed(`${ME}/a.tile.webp`), hash: "a" },
      { id: "b1", url: signed(`${ME}/b.webp`), thumb: signed(`${ME}/b.webp`), hash: "b" },
    ], deleted: ["d"] }]);
    expect(store.calls).toEqual([`sign reference-uploads ${REFERENCE_SIGN_TTL}`]);
    // The fake answers in insertion order; the route asks the database for newest first.
    const ROUTE = readSource(join(__dirname, "..", "..", "app", "api", "references", "route.ts"));
    expect(ROUTE).toMatch(/\.select\("id, path, thumb_path, content_hash"\)\s*\.eq\("user_id", me\)\s*\.is\("deleted_at", null\)\s*\.order\("created_at", \{ ascending: false \}\)\s*\.limit\(MAX_REFERENCES\)/);
    expect(ROUTE).toMatch(/\.select\("content_hash"\)\s*\.eq\("user_id", me\)\s*\.not\("deleted_at", "is", null\)\s*\.order\("deleted_at", \{ ascending: false \}\)\s*\.limit\(MAX_REFERENCES\)/);
    // Nothing kept: no address to sign.
    db.current!.tables.reference_uploads = [];
    store.calls = [];
    expect(await list()).toEqual([200, { references: [], deleted: [] }]);
    expect(store.calls).toEqual([]);
  });

  it("lists at most 50 kept and 50 deleted", async () => {
    seed(ME, MAX_REFERENCES + 1);
    seed(ME, MAX_REFERENCES + 1, 5000, "2026-10-02T00:00:00Z");
    for (const r of rows()) store.files.set(String(r.path), { bytes: Buffer.from("x"), contentType: "image/webp" });
    const [, body] = await list();
    expect([body.references.length, body.deleted.length]).toEqual([MAX_REFERENCES, MAX_REFERENCES]);
  });

  it("deletes my own and nobody else's, its files with it; the row stays marked, and saving the picture again brings it back", async () => {
    const [, mine] = await post({ image: dataUrl("image/webp", RED) });
    const [, hers] = await post({ image: dataUrl("image/webp", BLUE) }, "her");
    expect(await remove(hers.id)).toEqual([404, { error: "Not found" }]);
    expect(await remove(crypto.randomUUID())).toEqual([404, { error: "Not found" }]);
    store.calls = [];
    expect(await remove(mine.id)).toEqual([200, { deleted: true }]);
    expect(store.calls).toEqual([`remove reference-uploads ${ME}/${sha(RED)}.webp ${ME}/${sha(RED)}.tile.webp`]);
    expect([...store.files.keys()].every((p) => p.startsWith(HER))).toBe(true);
    expect(rows().map((r) => [r.id, Boolean(r.deleted_at)])).toEqual([[mine.id, true], [hers.id, false]]);
    expect(await list()).toEqual([200, { references: [], deleted: [sha(RED)] }]);
    // Once deleted, it is not there to delete again.
    expect(await remove(mine.id)).toEqual([404, { error: "Not found" }]);
    const [, back] = await post({ image: dataUrl("image/webp", RED) });
    expect(back.id).toBe(mine.id);
    expect(await list()).toEqual([200, { references: [back], deleted: [] }]);
    // A file left behind is no failure: the row is deleted either way.
    store.failRemove = true;
    expect(await remove(mine.id)).toEqual([200, { deleted: true }]);
    db.reads = [];
    expect(await remove("nope")).toEqual([404, { error: "Not found" }]);
    expect(db.reads).toEqual([]);
  });

  it("answers a guest 401 and reads nothing", async () => {
    expect(await list(null)).toEqual([401, { error: "Not signed in" }]);
    expect(await post({ image: dataUrl("image/webp", RED) }, null)).toEqual([401, { error: "Not signed in" }]);
    expect(await remove(crypto.randomUUID(), null)).toEqual([401, { error: "Not signed in" }]);
    expect([db.reads, store.calls]).toEqual([[], []]);
  });
});

describe("before SQL 51 runs, and when the database fails", () => {
  it("every request says so in one sentence (503), and nothing is stored", async () => {
    // As the live database answers today: a head count of the missing table is no error and no count (review 2026-10-29).
    db.current!.state.missing = "reference_uploads";
    expect(await post({ image: dataUrl("image/webp", RED) })).toEqual([503, NOT_YET]);
    expect(await list()).toEqual([503, NOT_YET]);
    expect(await remove(crypto.randomUUID())).toEqual([503, NOT_YET]);
    expect(store.calls).toEqual([]);
    db.current!.state.missing = null;
    for (const code of ["PGRST205", "42P01"]) {
      db.current!.state.failing = { table: "reference_uploads", code };
      expect(await post({ image: dataUrl("image/webp", RED) })).toEqual([503, NOT_YET]);
      expect(await list()).toEqual([503, NOT_YET]);
      expect(await remove(crypto.randomUUID())).toEqual([503, NOT_YET]);
    }
    expect(store.calls).toEqual([]);
  });

  it("an unreachable database is the outage 503; any other failure is a 500 with its sentence", async () => {
    db.current!.state.failing = { table: "reference_uploads", code: "ECONNREFUSED" };
    for (const [status, body] of [await list(), await post({ image: dataUrl("image/webp", RED) }), await remove(crypto.randomUUID())]) {
      expect([status, body.code]).toEqual([503, "DB_UNAVAILABLE"]);
    }
    db.current!.state.failing = { table: "reference_uploads", code: "XX000" };
    expect(await list()).toEqual([500, { error: "Could not read your references" }]);
    expect(await post({ image: dataUrl("image/webp", RED) })).toEqual([500, { error: "Could not save that reference" }]);
    expect(await remove(crypto.randomUUID())).toEqual([500, { error: "Could not delete that reference" }]);
    db.current!.state.failing = null;
    db.current!.state.failNext = { table: "reference_uploads", op: "upsert", code: "XX000" };
    expect(await post({ image: dataUrl("image/webp", RED) })).toEqual([500, { error: "Could not save that reference" }]);
    expect(rows()).toEqual([]);
    // Either list read failing fails the list, with its own answer.
    for (const skip of [0, 1]) {
      db.current!.state.failNext = { table: "reference_uploads", op: "select", code: "PGRST205", skip };
      expect(await list(), `read ${skip + 1}`).toEqual([503, NOT_YET]);
    }
  });

  it("a session that cannot be looked up is the outage 503, never a guest", async () => {
    for (const [status, body] of [await list("down"), await post({ image: dataUrl("image/webp", RED) }, "down"), await remove(crypto.randomUUID(), "down")]) {
      expect([status, body.code]).toEqual([503, "DB_UNAVAILABLE"]);
    }
  });
});
