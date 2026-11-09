import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { fakePostgrest } from "./_fake-postgrest";
import * as T from "@/lib/studio/types";

/**
 * app/api/studio/** (Kev, 2026-10-30: "At the end i want basically within studio a collection of projects containing
 * different content pieces that all access the same reference images, characters, styles and master prompts"). A
 * signed-in account makes projects, adds pictures, characters, styles, master prompts and content pieces to them, and
 * files its renders in a piece. Someone else's row reads as none at all (404) on every verb; every cap and field rule
 * answers its sentence; a picture is stored only once it may be kept; before SQL 53 runs, every request says so in one
 * sentence and nothing is stored.
 */
type Row = Record<string, unknown>;
type Fake = ReturnType<typeof fakePostgrest>;
const db = vi.hoisted(() => ({ from: null as null | ((t: string) => unknown), reads: [] as string[] }));
// The storage bucket: what is kept where, and each call; `failUpload` refuses the paths it matches.
const store = vi.hoisted(() => ({
  files: new Map<string, { bytes: Buffer; contentType: string }>(),
  calls: [] as string[],
  failUpload: null as RegExp | null, failSign: false, failRemove: false,
}));
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => ({
  from: (t: string) => { db.reads.push(t); return db.from!(t); },
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

import { GET as listProjects, POST as createProject } from "../../app/api/studio/projects/route";
import { GET as readProject, PATCH as patchProject, DELETE as deleteProject } from "../../app/api/studio/projects/[id]/route";
import { POST as addToProject } from "../../app/api/studio/projects/[id]/[kind]/route";
import { PATCH as patchItem, DELETE as deleteItem } from "../../app/api/studio/[kind]/[id]/route";
import { GET as readContent, PATCH as patchContent, DELETE as deleteContent } from "../../app/api/studio/contents/[id]/route";
import { POST as fileImages, DELETE as unfileImage } from "../../app/api/studio/contents/[id]/images/route";
import { REFERENCE_SIGN_TTL } from "@/lib/reference-library";

/* ── SQL 53 as the routes meet it, in the double: ids, uuid columns as Postgres reads them, defaults, the caps' trigger
   (in the order Postgres fires them, by name, with its message), the unique keys, the sheet's key and the key that keeps
   a used asset. Proven against the real SQL in studio-migration.test.ts. ── */
const CAPS: Record<string, [string, number][]> = {
  studio_projects: [["user_id", T.MAX_PROJECTS]],
  studio_assets: [["user_id", T.MAX_STUDIO_ASSETS], ["project_id", T.MAX_PROJECT_ASSETS]],
  studio_characters: [["project_id", T.MAX_CHARACTERS]],
  studio_styles: [["project_id", T.MAX_STYLES]],
  studio_master_prompts: [["project_id", T.MAX_MASTER_PROMPTS]],
  studio_contents: [["project_id", T.MAX_CONTENTS]],
  studio_content_images: [["content_id", T.MAX_CONTENT_IMAGES]],
};
const named = (r: Row) => String(r.name).trim().toLowerCase();
const UNIQUE: Record<string, (r: Row) => string> = {
  studio_projects: (r) => `${r.user_id} ${named(r)}`,
  studio_assets: (r) => `${r.project_id} ${r.content_hash}`,
  studio_contents: (r) => `${r.project_id} ${named(r)}`,
  studio_content_images: (r) => `${r.content_id} ${r.image_id}`,
};
// The uuid columns the routes filter and write: Postgres reads a value as a uuid first, refusing one that is none (22P02)
// and comparing and keeping any other in lower case.
const UUID_COLUMNS = new Set(["id", "user_id", "project_id", "content_id", "image_id", "asset_id", "style_id", "master_prompt_id", "sheet_prompt_id"]);
const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const now = () => new Date().toISOString();
let fake: Fake;
let notReady = false;
const rows = (t: string) => (fake.tables[t] ??= []);

function refuse(t: string, added: Row[]) {
  const seen = [...rows(t)];
  for (const r of added) {
    for (const [column, cap] of CAPS[t] ?? []) {
      if (seen.filter((x) => x[column] === r[column]).length >= cap) return { code: "23514", message: `studio cap ${t} ${column}` };
    }
    if (UNIQUE[t] && seen.some((x) => UNIQUE[t](x) === UNIQUE[t](r))) return { code: "23505", message: "duplicate key value violates unique constraint" };
    if (t === "studio_characters" && r.sheet_prompt_id && !rows("prompts").some((p) => p.id === r.sheet_prompt_id)) {
      return { code: "23503", message: `insert or update on table "studio_characters" violates foreign key constraint "studio_characters_sheet_prompt_id_fkey"` };
    }
    seen.push(r);
  }
  return null;
}

function table(t: string) {
  // Before SQL 53: every studio table answers as a missing one does (PGRST205; a head read no error and no count).
  if (notReady && t.startsWith("studio_")) {
    const gone = fakePostgrest();
    gone.state.missing = t;
    return (gone.client as { from: (t: string) => unknown }).from(t);
  }
  const q = (fake.client as { from: (t: string) => Record<string, (...a: never[]) => unknown> }).from(t);
  const { insert, eq, in: among, delete: del, then } = q as unknown as Record<string, (...a: unknown[]) => unknown>;
  let added: Row[] | null = null;
  let deleting = false;
  let notUuid = false;
  let order: [string, boolean] | null = null;
  const eqs: Row = {};
  const uuid = (c: string, v: unknown) => {
    if (!UUID_COLUMNS.has(c) || v == null) return v;
    if (typeof v === "string" && UUID_TEXT.test(v)) return v.toLowerCase();
    notUuid = true;
    return v;
  };
  Object.assign(q, {
    insert: (v: Row | Row[]) => {
      added = [v].flat().map((r) => Object.fromEntries(Object.entries({ ...(t === "studio_content_images" ? { added_at: now() } : { id: crypto.randomUUID(), updated_at: now() }), ...(t === "studio_styles" && { words: "", palette: [] }), ...r }).map(([c, x]) => [c, uuid(c, x)])));
      return insert(added);
    },
    eq: (c: string, v: unknown) => { v = uuid(c, v); eqs[c] = v; return eq(c, v); },
    in: (c: string, vs: unknown[]) => among(c, vs.map((v) => uuid(c, v))),
    delete: () => { deleting = true; return del(); },
    order: (c: string, o?: { ascending?: boolean }) => { order = [c, o?.ascending !== false]; return q; },
    // Checked when the statement runs (a held query is checked when released), as the trigger and the keys are; a value
    // that is no uuid first, as Postgres parses it before anything runs.
    then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => {
      const error = notUuid ? { code: "22P02", message: "invalid input syntax for type uuid" }
        : added ? refuse(t, added)
        : deleting && t === "studio_assets" && rows(t).some((a) => Object.entries(eqs).every(([c, v]) => a[c] === v) && rows("studio_characters").some((c) => c.asset_id === a.id))
          ? { code: "23503", message: `update or delete on table "studio_assets" violates foreign key constraint "studio_characters_asset"` } : null;
      if (error) return Promise.resolve({ data: null, error, count: null }).then(ok, ko);
      return then.call(q, (res: { data: unknown }) => {
        if (order && Array.isArray(res.data)) {
          const [c, up] = order;
          res = { ...res, data: [...res.data].sort((a, b) => (String(a[c]) < String(b[c]) ? -1 : String(a[c]) > String(b[c]) ? 1 : 0) * (up ? 1 : -1)) };
        }
        return ok(res);
      }, ko);
    },
  });
  return q;
}

/* ── Calling the routes. ── */
type Handler = (req: NextRequest, ctx: { params: Promise<never> }) => Promise<Response>;
const call = async (handler: Handler, method: string, path: string, params: Row, body?: unknown, token: string | null = "me") => {
  const res = await handler(new NextRequest(`http://enki.test/api/studio/${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { "X-Session-Token": token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), { params: Promise.resolve(params as never) });
  return [res.status, await res.json()] as [number, Row & { error?: string; code?: string }];
};
const api = {
  list: (t?: string | null) => call(listProjects as Handler, "GET", "projects", {}, undefined, t),
  create: (body: unknown, t?: string | null) => call(createProject as Handler, "POST", "projects", {}, body, t),
  project: (id: string, t?: string | null) => call(readProject as Handler, "GET", `projects/${id}`, { id }, undefined, t),
  patchProject: (id: string, body: unknown, t?: string | null) => call(patchProject as Handler, "PATCH", `projects/${id}`, { id }, body, t),
  deleteProject: (id: string, t?: string | null) => call(deleteProject as Handler, "DELETE", `projects/${id}`, { id }, undefined, t),
  add: (id: string, kind: string, body: unknown, t?: string | null) => call(addToProject as Handler, "POST", `projects/${id}/${kind}`, { id, kind }, body, t),
  patch: (kind: string, id: string, body: unknown, t?: string | null) => call(patchItem as Handler, "PATCH", `${kind}/${id}`, { kind, id }, body, t),
  remove: (kind: string, id: string, t?: string | null) => call(deleteItem as Handler, "DELETE", `${kind}/${id}`, { kind, id }, undefined, t),
  content: (id: string, t?: string | null) => call(readContent as Handler, "GET", `contents/${id}`, { id }, undefined, t),
  patchContent: (id: string, body: unknown, t?: string | null) => call(patchContent as Handler, "PATCH", `contents/${id}`, { id }, body, t),
  deleteContent: (id: string, t?: string | null) => call(deleteContent as Handler, "DELETE", `contents/${id}`, { id }, undefined, t),
  file: (id: string, imageIds: unknown, t?: string | null) => call(fileImages as Handler, "POST", `contents/${id}/images`, { id }, { imageIds }, t),
  unfile: (id: string, imageId: string, t?: string | null) => call(unfileImage as Handler, "DELETE", `contents/${id}/images?imageId=${imageId}`, { id }, undefined, t),
};

/* ── Fixtures. ── */
const picture = (background: string) => sharp({ create: { width: 600, height: 300, channels: 3, background } }).webp().toBuffer();
const dataUrl = (bytes: Buffer) => `data:image/webp;base64,${bytes.toString("base64")}`;
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const signed = (path: string) => `https://db.test/storage/v1/object/sign/reference-uploads/${path}?token=t`;
const err = (error: string) => ({ error });
const NOT_FOUND = err("Not found");
const UUID = expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
// One of an account's renders in its gallery (generated_images), or an upload, or one it deleted.
const render = (who = ME, extra: Row = {}) => {
  const id = crypto.randomUUID();
  rows("generated_images").push({ id, user_id: who, is_uploaded: false, deleted_at: null, prompt_id: null, storage_url: `https://cdn.test/${id}.png`, preview_url: `https://cdn.test/${id}.webp`, thumbnail_url: `https://cdn.test/${id}.t.webp`, ...extra });
  return id;
};
const pictureOfRender = (id: string) => ({ url: `https://cdn.test/${id}.webp`, thumb: `https://cdn.test/${id}.t.webp` });
const made = async (name = "Moonlight", t = "me") => {
  const [status, body] = await api.create({ name }, t);
  expect(status).toBe(201);
  return (body.project as Row).id as string;
};
const madeIn = async (project: string, kind: string, body: Row, t = "me") => {
  const [status, res] = await api.add(project, kind, body, t);
  expect([status, res.error]).toEqual([201, undefined]);
  return (Object.values(res)[0] as Row).id as string;
};
let clock = Date.now();
const tick = () => vi.setSystemTime((clock += 1_000));
// A new minute: the write limit starts again (seeding past 60 writes).
const nextMinute = () => vi.setSystemTime((clock += 120_000));

let RED: Buffer, BLUE: Buffer, GREEN: Buffer;
beforeEach(async () => {
  // A fresh minute for each test: the rate limits are under test only where it says so.
  vi.useFakeTimers({ toFake: ["Date"] });
  nextMinute();
  fake = fakePostgrest();
  notReady = false;
  db.from = table;
  db.reads = [];
  store.files.clear(); store.calls = []; store.failUpload = null; store.failSign = false; store.failRemove = false;
  RED ??= await picture("#c00");
  BLUE ??= await picture("#00c");
  GREEN ??= await picture("#0c0");
});
afterAll(() => { vi.useRealTimers(); });

describe("projects", () => {
  it("makes one with its fields trimmed and blank ones none, and lists the account's own newest first, with their counts and 4 newest tiles signed in one call", async () => {
    // None yet: none listed, no address to sign.
    expect(await api.list()).toEqual([200, { projects: [] }]);
    expect(store.calls).toEqual([]);
    const [status, body] = await api.create({ name: "  Moonlight ", description: "  A brand. ", link: " https://enki.art/m " });
    expect([status, body]).toEqual([201, { project: { id: UUID, name: "Moonlight", description: "A brand.", link: "https://enki.art/m", createdAt: expect.any(String), updatedAt: expect.any(String) } }]);
    const moon = (body.project as Row).id as string;
    expect(rows("studio_projects")[0]).toMatchObject({ user_id: ME, name: "Moonlight" });
    tick();
    const [, spring] = await api.create({ name: "Spring", description: "  ", link: "" });
    expect(spring.project).toMatchObject({ description: null, link: null });
    for (const colour of ["#100", "#200", "#300", "#400", "#500"]) {
      tick();
      await api.add(moon, "assets", { image: dataUrl(await picture(colour)) });
    }
    await madeIn(moon, "characters", { name: "Rex", imageId: render() });
    await madeIn(moon, "characters", { name: "Mira", imageId: render() });
    await madeIn(moon, "contents", { name: "Launch" });
    await made("Hers", "her");
    store.calls = [];
    const [s, list] = await api.list();
    expect(s).toBe(200);
    const projects = list.projects as Row[];
    expect(projects.map((p) => p.name)).toEqual(["Spring", "Moonlight"]);
    expect(projects[0]).toMatchObject({ counts: { assets: 0, characters: 0, contents: 0 }, cover: [] });
    const newest = rows("studio_assets").slice(-4).reverse().map((a) => signed(String(a.thumb_path)));
    expect(projects[1]).toEqual({ id: moon, name: "Moonlight", description: "A brand.", link: "https://enki.art/m", createdAt: expect.any(String), updatedAt: expect.any(String), counts: { assets: 5, characters: 2, contents: 1 }, cover: newest });
    expect(store.calls).toEqual([`sign reference-uploads ${REFERENCE_SIGN_TTL}`]);
    expect((await api.list("her"))[1].projects).toEqual([expect.objectContaining({ name: "Hers" })]);
  });

  it("refuses a missing or blank name, a field past its length, a link that is not http(s), and anything but text, writing nothing", async () => {
    const at = (n: number) => "x".repeat(n);
    for (const [body, sentence] of [
      [{}, T.NAME_NEEDED], [{ name: "   " }, T.NAME_NEEDED], [{ name: null }, T.NAME_NEEDED],
      [{ name: at(T.STUDIO_TEXT.name + 1) }, T.TOO_LONG.name],
      [{ name: "a", description: at(T.STUDIO_TEXT.description + 1) }, T.TOO_LONG.description],
      [{ name: "a", link: `https://${at(T.STUDIO_TEXT.link - 7)}` }, T.TOO_LONG.link],
      [{ name: "a", link: "enki.art" }, T.BAD_LINK], [{ name: "a", link: "javascript:alert(1)" }, T.BAD_LINK],
      [{ name: "a", link: "ftp://enki.art" }, T.BAD_LINK], [{ name: "a", link: "https://" }, T.BAD_LINK],
      [{ name: 7 }, "Bad request"], [{ name: "a", description: ["x"] }, "Bad request"],
    ] as const) {
      expect(await api.create(body), JSON.stringify(body).slice(0, 60)).toEqual([400, err(sentence)]);
    }
    for (const raw of ["null", "[]", "\"x\"", "{"]) {
      const res = await createProject(new NextRequest("http://enki.test/api/studio/projects", { method: "POST", headers: { "X-Session-Token": "me" }, body: raw }), { params: Promise.resolve({}) });
      expect([res.status, await res.json()], raw).toEqual([400, err("Bad request")]);
    }
    expect([rows("studio_projects"), db.reads]).toEqual([[], []]);
    // At the lengths themselves, a yes.
    expect((await api.create({ name: at(T.STUDIO_TEXT.name), description: at(T.STUDIO_TEXT.description), link: `https://${at(T.STUDIO_TEXT.link - 8)}` }))[0]).toBe(201);
    // A scheme in any case, as a phone's keyboard or a copied link has it, kept lower-cased (SQL 53's CHECK); the rest
    // as typed.
    for (const [name, typed, kept] of [["b", "HTTPS://Enki.art/Launch", "https://Enki.art/Launch"], ["c", "Http://enki.art", "http://enki.art"]]) {
      expect(await api.create({ name, link: typed }), typed).toEqual([201, { project: expect.objectContaining({ link: kept }) }]);
    }
  });

  it(`holds one name per account (case and spaces ignored) and ${T.MAX_PROJECTS} projects, by SQL 53's answers`, async () => {
    await made("Moonlight");
    expect(await api.create({ name: " MOONLIGHT " })).toEqual([409, err(T.PROJECT_NAME_TAKEN)]);
    expect((await api.create({ name: "Moonlight" }, "her"))[0]).toBe(201);
    for (let i = 1; i < T.MAX_PROJECTS; i++) await made(`p${i}`);
    expect(await api.create({ name: "one more" })).toEqual([409, err(T.PROJECTS_FULL)]);
    expect(rows("studio_projects").filter((p) => p.user_id === ME)).toHaveLength(T.MAX_PROJECTS);
  });

  it("reads one project whole: assets newest first, characters, styles and master prompts oldest first, contents newest first with their counts and covers", async () => {
    const moon = await made();
    const a1 = await madeIn(moon, "assets", { image: dataUrl(RED) });
    tick();
    const a2 = await madeIn(moon, "assets", { image: dataUrl(BLUE) });
    const [r1, r2, gone] = [render(ME, { prompt_id: "p-1" }), render(), render()];
    const c1 = await madeIn(moon, "characters", { name: "Rex", imageId: r1 });
    tick();
    const c2 = await madeIn(moon, "characters", { name: "Mira", assetId: a1 });
    tick();
    const c3 = await madeIn(moon, "characters", { name: "Ghost", imageId: gone });
    // Deleted from the gallery after it became a character: the card says so.
    rows("generated_images").find((r) => r.id === gone)!.deleted_at = now();
    const s1 = await madeIn(moon, "styles", { name: "Bold", palette: ["#7D1D33"] });
    tick();
    const s2 = await madeIn(moon, "styles", { name: "Soft" });
    const m1 = await madeIn(moon, "master-prompts", { name: "Brand", prompt: "moody" });
    tick();
    const k1 = await madeIn(moon, "contents", { name: "Launch", styleId: s1, masterPromptId: m1 });
    tick();
    const k2 = await madeIn(moon, "contents", { name: "Teaser" });
    const renders = [r2, ...Array.from({ length: 5 }, () => render())];
    for (const r of renders) { tick(); await api.file(k1, [r]); }
    rows("generated_images").find((r) => r.id === renders[5])!.deleted_at = now();
    // Hers, beside: never in mine.
    const hers = await made("Hers", "her");
    await madeIn(hers, "styles", { name: "Hers" }, "her");

    const [status, body] = await api.project(moon);
    expect(status).toBe(200);
    const asset = (id: string, bytes: Buffer) => ({ id, projectId: moon, url: signed(`studio/${ME}/${moon}/${sha(bytes)}.webp`), thumb: signed(`studio/${ME}/${moon}/${sha(bytes)}.tile.webp`), hash: sha(bytes), createdAt: expect.any(String) });
    expect(body.project).toMatchObject({ id: moon, name: "Moonlight" });
    expect(body.assets).toEqual([asset(a2, BLUE), asset(a1, RED)]);
    expect(body.characters).toEqual([
      { id: c1, projectId: moon, name: "Rex", picture: pictureOfRender(r1), source: "render", imageId: r1, assetId: null, sheetPromptId: null, createdAt: expect.any(String) },
      { id: c2, projectId: moon, name: "Mira", picture: { url: asset(a1, RED).url, thumb: asset(a1, RED).thumb }, source: "asset", imageId: null, assetId: a1, sheetPromptId: null, createdAt: expect.any(String) },
      { id: c3, projectId: moon, name: "Ghost", picture: null, source: "render", imageId: gone, assetId: null, sheetPromptId: null, createdAt: expect.any(String) },
    ]);
    expect((body.styles as Row[]).map((s) => [s.id, s.palette])).toEqual([[s1, ["#7d1d33"]], [s2, []]]);
    expect((body.masterPrompts as Row[]).map((m) => m.id)).toEqual([m1]);
    // Newest first; the deleted render left out of the count and the cover; the cover the 4 newest of 5.
    const covers = [renders[4], renders[3], renders[2], renders[1]].map((r) => pictureOfRender(r).thumb);
    expect(body.contents).toEqual([
      { id: k2, projectId: moon, name: "Teaser", description: null, link: null, styleId: null, masterPromptId: null, createdAt: expect.any(String), updatedAt: expect.any(String), count: 0, cover: [] },
      { id: k1, projectId: moon, name: "Launch", description: null, link: null, styleId: s1, masterPromptId: m1, createdAt: expect.any(String), updatedAt: expect.any(String), count: 5, cover: covers },
    ]);
    expect(await api.project(hers)).toEqual([404, NOT_FOUND]);
    expect(await api.project(moon, "her")).toEqual([404, NOT_FOUND]);
  });

  it("changes only the fields sent, clears one sent as null, keeps the name unique, and is the owner's only", async () => {
    const moon = (await api.create({ name: "Moonlight", description: "A brand.", link: "https://enki.art" }))[1].project as Row;
    tick();
    const [status, body] = await api.patchProject(String(moon.id), { link: null, name: " Moon " });
    expect([status, body.project]).toEqual([200, { ...moon, name: "Moon", link: null, updatedAt: expect.any(String) }]);
    expect((body.project as Row).updatedAt).not.toBe(moon.updatedAt);
    expect(await api.patchProject(String(moon.id), { name: "" })).toEqual([400, err(T.NAME_NEEDED)]);
    expect(await api.patchProject(String(moon.id), { link: "ftp://x" })).toEqual([400, err(T.BAD_LINK)]);
    fake.state.failNext = { table: "studio_projects", op: "update", code: "23505" };
    expect(await api.patchProject(String(moon.id), { name: "Taken" })).toEqual([409, err(T.PROJECT_NAME_TAKEN)]);
    expect(await api.patchProject(String(moon.id), { name: "Hers" }, "her")).toEqual([404, NOT_FOUND]);
    expect(rows("studio_projects")[0]).toMatchObject({ name: "Moon", description: "A brand.", link: null });
  });

  it("deletes the owner's project and its pictures' files, nobody else's", async () => {
    const moon = await made();
    await madeIn(moon, "assets", { image: dataUrl(RED) });
    await madeIn(moon, "assets", { image: dataUrl(BLUE) });
    const hers = await made("Hers", "her");
    await madeIn(hers, "assets", { image: dataUrl(GREEN) }, "her");
    expect(await api.deleteProject(hers)).toEqual([404, NOT_FOUND]);
    expect(await api.deleteProject(moon, "her")).toEqual([404, NOT_FOUND]);
    store.calls = [];
    expect(await api.deleteProject(moon)).toEqual([200, { deleted: true }]);
    const base = `studio/${ME}/${moon}`;
    expect(store.calls).toEqual([`remove reference-uploads ${base}/${sha(RED)}.webp ${base}/${sha(RED)}.tile.webp ${base}/${sha(BLUE)}.webp ${base}/${sha(BLUE)}.tile.webp`]);
    expect([...store.files.keys()].every((p) => p.startsWith(`studio/${HER}/`))).toBe(true);
    expect(rows("studio_projects").map((p) => p.id)).toEqual([hers]);
    expect(await api.project(moon)).toEqual([404, NOT_FOUND]);
    expect(await api.deleteProject(moon)).toEqual([404, NOT_FOUND]);
    // A file left behind is no failure: the project is gone either way.
    const again = await made("Again");
    await madeIn(again, "assets", { image: dataUrl(RED) });
    store.failRemove = true;
    expect(await api.deleteProject(again)).toEqual([200, { deleted: true }]);
  });
});

describe("assets", () => {
  it("keeps a picture and its 256 px tile in SQL 51's private bucket under the project; the same picture again is the same row, with no second upload", async () => {
    const moon = await made();
    store.calls = [];
    const [status, body] = await api.add(moon, "assets", { image: dataUrl(RED) });
    const [path, tile] = [`studio/${ME}/${moon}/${sha(RED)}.webp`, `studio/${ME}/${moon}/${sha(RED)}.tile.webp`];
    expect(store.calls).toEqual([
      `upload reference-uploads ${path} image/webp upsert=true`,
      `upload reference-uploads ${tile} image/webp upsert=true`,
      `sign reference-uploads ${REFERENCE_SIGN_TTL}`,
    ]);
    expect((await sharp(store.files.get(tile)!.bytes).metadata()).width).toBe(256);
    expect([status, body]).toEqual([201, { asset: { id: UUID, projectId: moon, url: signed(path), thumb: signed(tile), hash: sha(RED), createdAt: expect.any(String) } }]);
    expect(rows("studio_assets")).toEqual([expect.objectContaining({ project_id: moon, user_id: ME, path, thumb_path: tile, content_hash: sha(RED) })]);
    store.calls = [];
    expect(await api.add(moon, "assets", { image: dataUrl(RED) })).toEqual([200, body]);
    expect(store.calls).toEqual([`sign reference-uploads ${REFERENCE_SIGN_TTL}`]);
    // Another project of mine takes the same picture as its own row and files.
    const other = await made("Other");
    expect((await api.add(other, "assets", { image: dataUrl(RED) }))[0]).toBe(201);
    expect(store.files.has(`studio/${ME}/${other}/${sha(RED)}.webp`)).toBe(true);
  });

  it("refuses anything that is not a PNG, JPEG or WebP picture, storing nothing", async () => {
    const moon = await made();
    store.calls = [];
    for (const body of [{}, { image: 7 }, { image: "https://elsewhere.example/a.webp" }, { image: `data:image/png;base64,${RED.toString("base64")}` }, null]) {
      expect(await api.add(moon, "assets", body), JSON.stringify(body)).toEqual([400, err("Only a PNG, JPEG or WebP image under 4 MB can be saved.")]);
    }
    expect([store.calls, rows("studio_assets")]).toEqual([[], []]);
  });

  it(`holds ${T.MAX_PROJECT_ASSETS} a project and ${T.MAX_STUDIO_ASSETS} an account before anything is stored; the picture already there is a yes at the cap`, async () => {
    const [p1, p2, p3] = [await made("One"), await made("Two"), await made("Three")];
    const seed = (p: string, n: number, tag: string) => {
      for (let i = 0; i < n; i++) rows("studio_assets").push({ id: crypto.randomUUID(), project_id: p, user_id: ME, path: `x/${tag}${i}`, thumb_path: null, content_hash: `${tag}${i}`, created_at: now() });
    };
    seed(p1, T.MAX_PROJECT_ASSETS - 1, "a");
    expect((await api.add(p1, "assets", { image: dataUrl(RED) }))[0]).toBe(201);
    store.calls = [];
    expect(await api.add(p1, "assets", { image: dataUrl(BLUE) })).toEqual([409, err(T.PROJECT_ASSETS_FULL)]);
    expect(store.calls).toEqual([]);
    expect((await api.add(p1, "assets", { image: dataUrl(RED) }))[0]).toBe(200);
    seed(p2, T.MAX_PROJECT_ASSETS, "b");
    seed(p3, T.MAX_STUDIO_ASSETS - 2 * T.MAX_PROJECT_ASSETS - 1, "c");
    expect((await api.add(p3, "assets", { image: dataUrl(BLUE) }))[0]).toBe(201);
    store.calls = [];
    expect(await api.add(p3, "assets", { image: dataUrl(GREEN) })).toEqual([409, err(T.STUDIO_ASSETS_FULL)]);
    expect(store.calls).toEqual([]);
    // Another account's count is its own.
    const hers = await made("Hers", "her");
    expect((await api.add(hers, "assets", { image: dataUrl(GREEN) }, "her"))[0]).toBe(201);
  });

  it("an add beside this one: the same picture is that row and keeps its files; a cap it met is the cap's sentence, and this one's files go", async () => {
    const moon = await made();
    const race = async (first: Buffer, second: Buffer) => {
      let release!: () => void;
      // The first add's insert waits (after its picture read and two counts) while the second runs whole.
      fake.state.holdNext = { table: "studio_assets", until: new Promise<void>((r) => (release = r)), skip: 3 };
      const held = api.add(moon, "assets", { image: dataUrl(first) });
      await vi.waitFor(() => expect(fake.state.holdNext).toBeNull());
      const beside = await api.add(moon, "assets", { image: dataUrl(second) });
      release();
      return [await held, beside];
    };
    const [same, beside] = await race(RED, RED);
    expect(beside[0]).toBe(201);
    expect(same).toEqual([200, beside[1]]);
    expect(rows("studio_assets")).toHaveLength(1);
    expect(store.files.has(`studio/${ME}/${moon}/${sha(RED)}.webp`)).toBe(true);
    expect(store.calls.some((c) => c.startsWith("remove"))).toBe(false);

    for (let i = 1; i < T.MAX_PROJECT_ASSETS - 1; i++) rows("studio_assets").push({ id: crypto.randomUUID(), project_id: moon, user_id: ME, path: `x/${i}`, thumb_path: null, content_hash: `h${i}`, created_at: now() });
    store.calls = [];
    const [full, last] = await race(BLUE, GREEN);
    expect([last[0], full]).toEqual([201, [409, err(T.PROJECT_ASSETS_FULL)]]);
    expect(store.files.has(`studio/${ME}/${moon}/${sha(BLUE)}.webp`)).toBe(false);
    expect(store.calls).toContain(`remove reference-uploads studio/${ME}/${moon}/${sha(BLUE)}.webp studio/${ME}/${moon}/${sha(BLUE)}.tile.webp`);
  });

  it("keeps no row when the picture could not be stored; the picture is its own tile when only the tile failed", async () => {
    const moon = await made();
    store.failUpload = new RegExp(`${sha(RED)}\\.webp$`);
    expect(await api.add(moon, "assets", { image: dataUrl(RED) })).toEqual([503, err(T.NOT_SAVED)]);
    expect(rows("studio_assets")).toEqual([]);
    store.failUpload = /\.tile\.webp$/;
    const [status, body] = await api.add(moon, "assets", { image: dataUrl(RED) });
    expect([status, (body.asset as Row).thumb]).toEqual([201, signed(`studio/${ME}/${moon}/${sha(RED)}.webp`)]);
    store.failSign = true;
    expect(await api.add(moon, "assets", { image: dataUrl(BLUE) })).toEqual([503, err(T.NOT_SAVED)]);
    expect(await api.project(moon)).toEqual([500, err(T.NOT_READ)]);
    // The list needs no address but the covers': the menu still has its projects, with no cover (BLUE's row is kept: only
    // its answer could not be signed).
    expect(await api.list()).toEqual([200, { projects: [expect.objectContaining({ id: moon, counts: { assets: 2, characters: 0, contents: 0 }, cover: [] })] }]);
  });

  it("a picture whose files are gone (left out of every answer, yet counted) is stored again when it is added again, as the same row", async () => {
    const moon = await made();
    const [, first] = await api.add(moon, "assets", { image: dataUrl(RED) });
    const [path, tile] = [`studio/${ME}/${moon}/${sha(RED)}.webp`, `studio/${ME}/${moon}/${sha(RED)}.tile.webp`];
    // A delete of this picture beside an add of it removed the files after the add stored them.
    store.files.delete(path);
    store.files.delete(tile);
    expect((await api.project(moon))[1].assets).toEqual([]);
    // A full project: the row is there, so it needs no room.
    for (let i = 1; i < T.MAX_PROJECT_ASSETS; i++) rows("studio_assets").push({ id: crypto.randomUUID(), project_id: moon, user_id: ME, path: `x/${i}`, thumb_path: null, content_hash: `h${i}`, created_at: now() });
    store.calls = [];
    expect(await api.add(moon, "assets", { image: dataUrl(RED) })).toEqual([200, first]);
    expect(store.calls.filter((c) => c.startsWith("upload"))).toEqual([
      `upload reference-uploads ${path} image/webp upsert=true`, `upload reference-uploads ${tile} image/webp upsert=true`,
    ]);
    expect([rows("studio_assets").length, (await api.project(moon))[1].assets]).toEqual([T.MAX_PROJECT_ASSETS, [first.asset]]);
  });

  it("deletes the owner's asset and its files; one a character is made of stays, and so do its files", async () => {
    const moon = await made();
    const used = await madeIn(moon, "assets", { image: dataUrl(RED) });
    const free = await madeIn(moon, "assets", { image: dataUrl(BLUE) });
    await madeIn(moon, "characters", { name: "Mira", assetId: used });
    expect(await api.remove("assets", free, "her")).toEqual([404, NOT_FOUND]);
    store.calls = [];
    expect(await api.remove("assets", free)).toEqual([200, { deleted: true }]);
    expect(store.calls).toEqual([`remove reference-uploads studio/${ME}/${moon}/${sha(BLUE)}.webp studio/${ME}/${moon}/${sha(BLUE)}.tile.webp`]);
    expect(await api.remove("assets", used)).toEqual([409, err(T.ASSET_IN_USE)]);
    expect([rows("studio_assets").map((a) => a.id), store.files.has(`studio/${ME}/${moon}/${sha(RED)}.webp`)]).toEqual([[used], true]);
    expect(await api.remove("assets", free)).toEqual([404, NOT_FOUND]);
    // An asset has nothing to change.
    expect(await api.patch("assets", used, { name: "x" })).toEqual([404, NOT_FOUND]);
  });

  it(`is rate limited per account: ${T.STUDIO_UPLOADS_PER_MIN} pictures a minute, apart from the other writes`, async () => {
    const moon = await made();
    for (let i = 0; i < T.STUDIO_UPLOADS_PER_MIN; i++) expect((await api.add(moon, "assets", { image: dataUrl(RED) }))[0]).toBeLessThan(300);
    expect(await api.add(moon, "assets", { image: dataUrl(RED) })).toEqual([429, err("Too many requests")]);
    expect((await api.add(moon, "styles", { name: "Bold" }))[0]).toBe(201);
    const hers = await made("Hers", "her");
    expect((await api.add(hers, "assets", { image: dataUrl(RED) }, "her"))[0]).toBe(201);
  });
});

describe("characters", () => {
  it("are made of one of the caller's own renders (with the sheet it was made with) or one of the project's assets, never both or neither", async () => {
    const moon = await made();
    const other = await made("Other");
    const mine = await madeIn(moon, "assets", { image: dataUrl(RED) });
    const elsewhere = await madeIn(other, "assets", { image: dataUrl(BLUE) });
    const hers = await made("Hers", "her");
    const herAsset = await madeIn(hers, "assets", { image: dataUrl(GREEN) }, "her");
    rows("prompts").push({ id: "a1b2c3d4-0000-4000-8000-000000000001" });
    const r = render();
    const [status, body] = await api.add(moon, "characters", { name: " Rex ", imageId: r, sheetPromptId: "a1b2c3d4-0000-4000-8000-000000000001" });
    expect([status, body]).toEqual([201, { character: { id: UUID, projectId: moon, name: "Rex", picture: pictureOfRender(r), source: "render", imageId: r, assetId: null, sheetPromptId: "a1b2c3d4-0000-4000-8000-000000000001", createdAt: expect.any(String) } }]);
    const [, fromAsset] = await api.add(moon, "characters", { name: "Mira", assetId: mine });
    expect(fromAsset.character).toMatchObject({ source: "asset", picture: { url: signed(`studio/${ME}/${moon}/${sha(RED)}.webp`), thumb: signed(`studio/${ME}/${moon}/${sha(RED)}.tile.webp`) } });

    const before = rows("studio_characters").length;
    for (const [bodyOf, sentence] of [
      [{ name: "X" }, T.ONE_PICTURE], [{ name: "X", imageId: null, assetId: null }, T.ONE_PICTURE], [{ name: "X", imageId: r, assetId: mine }, T.ONE_PICTURE],
      [{ name: "X", imageId: render(HER) }, T.NOT_YOUR_RENDER],
      [{ name: "X", imageId: render(ME, { is_uploaded: true }) }, T.NOT_YOUR_RENDER],
      [{ name: "X", imageId: render(ME, { deleted_at: now() }) }, T.NOT_YOUR_RENDER],
      [{ name: "X", imageId: "not-a-render" }, T.NOT_YOUR_RENDER],
      [{ name: "X", assetId: elsewhere }, T.NOT_IN_PROJECT], [{ name: "X", assetId: herAsset }, T.NOT_IN_PROJECT], [{ name: "X", assetId: 7 }, T.NOT_IN_PROJECT],
      [{ name: "X", imageId: r, sheetPromptId: crypto.randomUUID() }, T.SHEET_GONE],
      [{ name: "X", imageId: r, sheetPromptId: "sheet" }, "Bad request"],
      [{ name: " ", imageId: r }, T.NAME_NEEDED],
    ] as const) {
      expect(await api.add(moon, "characters", bodyOf), JSON.stringify(bodyOf)).toEqual([400, err(sentence)]);
    }
    expect(rows("studio_characters")).toHaveLength(before);
  });

  it(`holds ${T.MAX_CHARACTERS} a project; a name changes, nothing else; the owner's only`, async () => {
    const moon = await made();
    const ids = [];
    for (let i = 0; i < T.MAX_CHARACTERS; i++) ids.push(await madeIn(moon, "characters", { name: `c${i}`, imageId: render() }));
    expect(await api.add(moon, "characters", { name: "one more", imageId: render() })).toEqual([409, err(T.CHARACTERS_FULL)]);
    const [status, body] = await api.patch("characters", ids[0], { name: " Mira ", imageId: render() });
    expect([status, (body.character as Row).name, (body.character as Row).imageId]).toEqual([200, "Mira", rows("studio_characters")[0].image_id]);
    expect(await api.patch("characters", ids[0], {})).toEqual([400, err(T.NAME_NEEDED)]);
    expect(await api.patch("characters", ids[0], { name: "Hers" }, "her")).toEqual([404, NOT_FOUND]);
    expect(await api.remove("characters", ids[0], "her")).toEqual([404, NOT_FOUND]);
    expect(await api.remove("characters", ids[0])).toEqual([200, { deleted: true }]);
    expect(rows("studio_characters")).toHaveLength(T.MAX_CHARACTERS - 1);
  });
});

describe("styles and master prompts", () => {
  it(`a style keeps its words and up to ${T.MAX_PALETTE} colours, lower-cased; a PATCH keeps what it does not send; ${T.MAX_STYLES} a project`, async () => {
    const moon = await made();
    const [status, body] = await api.add(moon, "styles", { name: "Bold", words: " warm film grain ", palette: [" #7D1D33", "#cba24a"] });
    expect([status, body]).toEqual([201, { style: { id: UUID, projectId: moon, name: "Bold", words: "warm film grain", palette: ["#7d1d33", "#cba24a"], createdAt: expect.any(String), updatedAt: expect.any(String) } }]);
    const id = (body.style as Row).id as string;
    for (const palette of [Array(T.MAX_PALETTE + 1).fill("#000000"), ["red"], ["#7d1d3"], "#7d1d33", [7]]) {
      expect(await api.add(moon, "styles", { name: "Bad", palette }), JSON.stringify(palette)).toEqual([400, err(T.BAD_PALETTE)]);
      expect(await api.patch("styles", id, { palette }), JSON.stringify(palette)).toEqual([400, err(T.BAD_PALETTE)]);
    }
    expect(await api.add(moon, "styles", { name: "Long", words: "x".repeat(T.STUDIO_TEXT.words + 1) })).toEqual([400, err(T.TOO_LONG.words)]);
    tick();
    const [, renamed] = await api.patch("styles", id, { name: "Bolder" });
    expect(renamed.style).toMatchObject({ name: "Bolder", words: "warm film grain", palette: ["#7d1d33", "#cba24a"] });
    expect((renamed.style as Row).updatedAt).not.toBe((body.style as Row).updatedAt);
    // All the colours a style may have, a yes (the styles below are made with as many).
    const full = Array(T.MAX_PALETTE).fill("#cba24a");
    expect(await api.patch("styles", id, { palette: full })).toEqual([200, { style: expect.objectContaining({ palette: full }) }]);
    expect((await api.patch("styles", id, { palette: null, words: null }))[1].style).toMatchObject({ palette: [], words: "" });
    expect(await api.patch("styles", id, { name: "Hers" }, "her")).toEqual([404, NOT_FOUND]);
    for (let i = 1; i < T.MAX_STYLES; i++) await madeIn(moon, "styles", { name: `s${i}`, palette: Array(T.MAX_PALETTE).fill("#000000") });
    expect(await api.add(moon, "styles", { name: "one more" })).toEqual([409, err(T.STYLES_FULL)]);
    expect(await api.remove("styles", id, "her")).toEqual([404, NOT_FOUND]);
    expect(await api.remove("styles", id)).toEqual([200, { deleted: true }]);
  });

  it(`a master prompt needs its text, up to ${T.STUDIO_TEXT.prompt} characters; ${T.MAX_MASTER_PROMPTS} a project`, async () => {
    const moon = await made();
    expect(await api.add(moon, "master-prompts", { name: "Brand" })).toEqual([400, err(T.PROMPT_NEEDED)]);
    expect(await api.add(moon, "master-prompts", { name: "Brand", prompt: "x".repeat(T.STUDIO_TEXT.prompt + 1) })).toEqual([400, err(T.TOO_LONG.prompt)]);
    const [status, body] = await api.add(moon, "master-prompts", { name: "Brand", prompt: "  moody, cinematic  " });
    expect([status, body]).toEqual([201, { masterPrompt: { id: UUID, projectId: moon, name: "Brand", prompt: "moody, cinematic", createdAt: expect.any(String), updatedAt: expect.any(String) } }]);
    const id = (body.masterPrompt as Row).id as string;
    expect((await api.patch("master-prompts", id, { prompt: "bright" }))[1].masterPrompt).toMatchObject({ name: "Brand", prompt: "bright" });
    expect(await api.patch("master-prompts", id, { prompt: " " })).toEqual([400, err(T.PROMPT_NEEDED)]);
    expect(await api.patch("master-prompts", id, { prompt: "x" }, "her")).toEqual([404, NOT_FOUND]);
    for (let i = 1; i < T.MAX_MASTER_PROMPTS; i++) await madeIn(moon, "master-prompts", { name: `m${i}`, prompt: "p" });
    expect(await api.add(moon, "master-prompts", { name: "one more", prompt: "p" })).toEqual([409, err(T.MASTER_PROMPTS_FULL)]);
    expect(await api.remove("master-prompts", id)).toEqual([200, { deleted: true }]);
  });
});

describe("content pieces", () => {
  it("take this project's style and master prompt or none, a name unique in the project, and 50 a project", async () => {
    const moon = await made();
    const other = await made("Other");
    const style = await madeIn(moon, "styles", { name: "Bold" });
    const brand = await madeIn(moon, "master-prompts", { name: "Brand", prompt: "p" });
    const otherStyle = await madeIn(other, "styles", { name: "Bold" });
    const hers = await made("Hers", "her");
    const herStyle = await madeIn(hers, "styles", { name: "Hers" }, "her");
    const [status, body] = await api.add(moon, "contents", { name: "Launch", description: " The drop. ", link: "https://enki.art/launch", styleId: style, masterPromptId: brand });
    expect([status, body]).toEqual([201, { content: { id: UUID, projectId: moon, name: "Launch", description: "The drop.", link: "https://enki.art/launch", styleId: style, masterPromptId: brand, createdAt: expect.any(String), updatedAt: expect.any(String), count: 0, cover: [] } }]);
    for (const refs of [{ styleId: otherStyle }, { styleId: herStyle }, { masterPromptId: style }, { styleId: "x" }]) {
      expect(await api.add(moon, "contents", { name: "Teaser", ...refs }), JSON.stringify(refs)).toEqual([400, err(T.NOT_IN_PROJECT)]);
    }
    expect(await api.add(moon, "contents", { name: " launch " })).toEqual([409, err(T.CONTENT_NAME_TAKEN)]);
    expect((await api.add(other, "contents", { name: "Launch" }))[0]).toBe(201);
    for (let i = 1; i < T.MAX_CONTENTS; i++) {
      if (i % 40 === 0) nextMinute();
      await madeIn(moon, "contents", { name: `k${i}` });
    }
    expect(await api.add(moon, "contents", { name: "one more" })).toEqual([409, err(T.CONTENTS_FULL)]);
    expect(await api.add(moon, "contents", { name: "Hers" }, "her")).toEqual([404, NOT_FOUND]);
  });

  it("read whole: the piece, its project's name, its renders newest first (a deleted one left out), all of them past one read's 100", async () => {
    const moon = await made();
    const piece = await madeIn(moon, "contents", { name: "Launch" });
    const [a, b, c] = [render(ME, { prompt_id: "p-a" }), render(), render(ME, { preview_url: null })];
    for (const r of [a, b, c]) { tick(); await api.file(piece, [r]); }
    rows("generated_images").find((r) => r.id === b)!.deleted_at = now();
    const [status, body] = await api.content(piece);
    expect(status).toBe(200);
    expect(body.project).toEqual({ id: moon, name: "Moonlight" });
    expect(body.images).toEqual([
      { imageId: c, promptId: null, url: `https://cdn.test/${c}.png`, thumb: `https://cdn.test/${c}.t.webp`, addedAt: expect.any(String) },
      { imageId: a, promptId: "p-a", ...pictureOfRender(a), addedAt: expect.any(String) },
    ]);
    expect(body.content).toMatchObject({ id: piece, name: "Launch", count: 2, cover: [`https://cdn.test/${c}.t.webp`, pictureOfRender(a).thumb] });
    // 150 filed: read 100 ids at a time, every one answered.
    const many = await madeIn(moon, "contents", { name: "Many" });
    for (let i = 0; i < 150; i++) rows("studio_content_images").push({ content_id: many, user_id: ME, image_id: render(), added_at: now() });
    const reads = db.reads.length;
    const [, full] = await api.content(many);
    expect([(full.images as Row[]).length, (full.content as Row).count]).toEqual([150, 150]);
    expect((full.content as Row).cover).toEqual((full.images as Row[]).slice(0, 4).map((i) => i.thumb));
    expect(db.reads.slice(reads).filter((t) => t === "generated_images")).toHaveLength(2);
    expect(await api.content(piece, "her")).toEqual([404, NOT_FOUND]);
    expect(await api.content(crypto.randomUUID())).toEqual([404, NOT_FOUND]);
  });

  it("change only what is sent, their style and master prompt checked against their own project; deleting one leaves its renders", async () => {
    const moon = await made();
    const other = await made("Other");
    const style = await madeIn(moon, "styles", { name: "Bold" });
    const otherStyle = await madeIn(other, "styles", { name: "Soft" });
    const piece = await madeIn(moon, "contents", { name: "Launch", description: "The drop.", styleId: style });
    await madeIn(moon, "contents", { name: "Teaser" });
    const r = render();
    await api.file(piece, [r]);
    expect(await api.patchContent(piece, { styleId: otherStyle })).toEqual([400, err(T.NOT_IN_PROJECT)]);
    expect(await api.patchContent(piece, { name: "Hers" }, "her")).toEqual([404, NOT_FOUND]);
    // Not even a refusal of my style: to her, my piece is none at all.
    expect(await api.patchContent(piece, { styleId: style }, "her")).toEqual([404, NOT_FOUND]);
    const [status, body] = await api.patchContent(piece, { name: "Launch day", masterPromptId: null });
    expect([status, body.content]).toEqual([200, expect.objectContaining({ name: "Launch day", description: "The drop.", styleId: style, masterPromptId: null, count: 1, cover: [pictureOfRender(r).thumb] })]);
    expect((await api.patchContent(piece, { styleId: null }))[1].content).toMatchObject({ styleId: null });
    fake.state.failNext = { table: "studio_contents", op: "update", code: "23505" };
    expect(await api.patchContent(piece, { name: "Teaser" })).toEqual([409, err(T.CONTENT_NAME_TAKEN)]);
    expect(await api.deleteContent(piece, "her")).toEqual([404, NOT_FOUND]);
    expect(await api.deleteContent(piece)).toEqual([200, { deleted: true }]);
    expect(await api.deleteContent(piece)).toEqual([404, NOT_FOUND]);
    expect(rows("generated_images").map((g) => g.id)).toEqual([r]);
  });
});

describe("filing renders in a content piece", () => {
  it("files the caller's own renders, each once a piece; those filed before in that piece count as filed", async () => {
    const moon = await made();
    const piece = await madeIn(moon, "contents", { name: "Launch" });
    const [a, b, c] = [render(), render(), render()];
    expect(await api.file(piece, [a, b])).toEqual([200, { filed: [a, b] }]);
    expect(await api.file(piece, [b, c, c])).toEqual([200, { filed: [b, c] }]);
    expect(rows("studio_content_images").map((r) => [r.content_id, r.user_id, r.image_id])).toEqual([[piece, ME, a], [piece, ME, b], [piece, ME, c]]);
    // Filed in another piece too: in each its own.
    const other = await madeIn(moon, "contents", { name: "Spring" });
    expect(await api.file(other, [a])).toEqual([200, { filed: [a] }]);
    expect(rows("studio_content_images").filter((r) => r.image_id === a).map((r) => r.content_id)).toEqual([piece, other]);
    expect(await api.unfile(piece, b)).toEqual([200, { removed: true }]);
    expect(await api.unfile(piece, b)).toEqual([404, NOT_FOUND]);
    expect(await api.unfile(piece, a, "her")).toEqual([404, NOT_FOUND]);
    expect(rows("studio_content_images").filter((r) => r.content_id === piece).map((r) => r.image_id)).toEqual([a, c]);
  });

  it("takes a render's id in upper case as the same render: filed once, filed again without a refusal", async () => {
    const piece = await madeIn(await made(), "contents", { name: "Launch" });
    const r = render();
    expect(await api.file(piece, [r.toUpperCase()])).toEqual([200, { filed: [r] }]);
    expect(await api.file(piece, [r, r.toUpperCase()])).toEqual([200, { filed: [r] }]);
    expect(rows("studio_content_images").map((x) => x.image_id)).toEqual([r]);
  });

  it("files all or none: one render that is not the caller's own (hers, an upload, a deleted one) files nothing", async () => {
    const piece = await madeIn(await made(), "contents", { name: "Launch" });
    const mine = render();
    for (const other of [render(HER), render(ME, { is_uploaded: true }), render(ME, { deleted_at: now() }), "not-a-render"]) {
      expect(await api.file(piece, [mine, other]), other).toEqual([400, err(T.NOT_YOUR_RENDER)]);
    }
    expect(rows("studio_content_images")).toEqual([]);
    for (const ids of [[], Array.from({ length: T.MAX_FILE_AT_ONCE + 1 }, () => render()), "x", null]) {
      expect(await api.file(piece, ids), JSON.stringify(ids)).toEqual([400, err("Nothing to file")]);
    }
    // 8 at once, the same one twice counted once.
    const eight = Array.from({ length: T.MAX_FILE_AT_ONCE }, () => render());
    expect((await api.file(piece, [...eight, eight[0]]))[0]).toBe(200);
    expect(await api.file(piece, [render()], "her")).toEqual([404, NOT_FOUND]);
  });

  it(`holds ${T.MAX_CONTENT_IMAGES} a piece, by SQL 53's answer; filing again what is there is never refused`, async () => {
    const piece = await madeIn(await made(), "contents", { name: "Launch" });
    const filed = Array.from({ length: T.MAX_CONTENT_IMAGES - 1 }, () => render());
    filed.forEach((image_id) => rows("studio_content_images").push({ content_id: piece, user_id: ME, image_id, added_at: now() }));
    const [last, over] = [render(), render()];
    expect(await api.file(piece, [filed[0], last, over])).toEqual([409, err(T.CONTENT_IMAGES_FULL)]);
    expect(await api.file(piece, [filed[0], last])).toEqual([200, { filed: [filed[0], last] }]);
    expect(await api.file(piece, [filed[1], last])).toEqual([200, { filed: [filed[1], last] }]);
    expect(rows("studio_content_images")).toHaveLength(T.MAX_CONTENT_IMAGES);
  });
});

describe("every route", () => {
  const ID = "0b5f2c1e-2222-4222-8333-444455556666";
  const every = (t: string | null) => [
    api.list(t), api.create({ name: "x" }, t), api.project(ID, t), api.patchProject(ID, { name: "x" }, t), api.deleteProject(ID, t),
    ...T.PROJECT_KINDS.map((k) => api.add(ID, k, { name: "x", image: dataUrl(RED) }, t)),
    ...["characters", "styles", "master-prompts"].map((k) => api.patch(k, ID, { name: "x" }, t)),
    ...T.ITEM_KINDS.map((k) => api.remove(k, ID, t)),
    api.content(ID, t), api.patchContent(ID, { name: "x" }, t), api.deleteContent(ID, t), api.file(ID, [ID], t), api.unfile(ID, ID, t),
  ];

  it("answers a guest 401 and reads nothing", async () => {
    for (const [status, body] of await Promise.all(every(null))) expect([status, body]).toEqual([401, err("Not signed in")]);
    expect([db.reads, store.calls]).toEqual([[], []]);
  });

  it("answers someone else's row, an id that is none and a kind that is none 404, writing nothing", async () => {
    const hers = await made("Hers", "her");
    const asset = await madeIn(hers, "assets", { image: dataUrl(RED) }, "her");
    const character = await madeIn(hers, "characters", { name: "Mira", assetId: asset }, "her");
    const style = await madeIn(hers, "styles", { name: "Bold" }, "her");
    const brand = await madeIn(hers, "master-prompts", { name: "Brand", prompt: "p" }, "her");
    const piece = await madeIn(hers, "contents", { name: "Launch" }, "her");
    const r = render(HER);
    await api.file(piece, [r], "her");
    const snapshot = JSON.stringify(fake.tables);
    const files = store.files.size;
    for (const [status, body] of [
      await api.project(hers), await api.patchProject(hers, { name: "Mine" }), await api.deleteProject(hers),
      ...await Promise.all(T.PROJECT_KINDS.map((k) => api.add(hers, k, { name: "x", image: dataUrl(BLUE), imageId: render() }))),
      await api.patch("characters", character, { name: "x" }), await api.patch("styles", style, { name: "x" }), await api.patch("master-prompts", brand, { name: "x" }),
      await api.remove("assets", asset), await api.remove("characters", character), await api.remove("styles", style), await api.remove("master-prompts", brand),
      await api.content(piece), await api.patchContent(piece, { name: "x" }), await api.deleteContent(piece),
      await api.file(piece, [render()]), await api.unfile(piece, r),
    ]) expect([status, body]).toEqual([404, NOT_FOUND]);
    // My renders read above are new rows; nothing of hers changed.
    const tables = JSON.parse(snapshot);
    for (const t of Object.keys(tables).filter((t) => t.startsWith("studio_"))) expect(rows(t), t).toEqual(tables[t]);
    expect(store.files.size).toBe(files);
    // An id that is no uuid and a kind that is none are answered before any read (Postgres would refuse the id: 22P02).
    db.reads = [];
    for (const [status, body] of [
      await api.project("nope"), await api.patchProject("nope", { name: "x" }), await api.deleteProject("nope"), await api.add("nope", "styles", { name: "x" }),
      await api.add(hers, "projects", { name: "x" }), await api.add(hers, "nope", { name: "x" }),
      await api.patch("nope", style, { name: "x" }), await api.patch("contents", piece, { name: "x" }), await api.remove("contents", piece), await api.remove("nope", style),
      await api.patch("styles", "nope", { name: "x" }), await api.remove("styles", "nope"),
      await api.content("nope"), await api.patchContent("nope", { name: "x" }), await api.deleteContent("nope"), await api.file("nope", [r]), await api.unfile(piece, "nope"),
    ]) expect([status, body]).toEqual([404, NOT_FOUND]);
    expect(db.reads).toEqual([]);
  });

  it("before SQL 53 runs, says so in one sentence (503) and stores nothing", async () => {
    notReady = true;
    for (const [status, body] of await Promise.all(every("me"))) expect([status, body]).toEqual([503, err(T.STUDIO_NOT_READY)]);
    expect(store.calls).toEqual([]);
    notReady = false;
    for (const code of ["PGRST205", "42P01"]) {
      fake.state.failing = { table: "studio_projects", code };
      expect(await api.list()).toEqual([503, err(T.STUDIO_NOT_READY)]);
      expect(await api.create({ name: "x" })).toEqual([503, err(T.STUDIO_NOT_READY)]);
    }
  });

  it("an unreachable database is the outage 503, a session that cannot be looked up too, never a guest; any other failure is a 500 with its sentence", async () => {
    const moon = await made();
    fake.state.failing = { table: "studio_projects", code: "ECONNREFUSED" };
    for (const [status, body] of [await api.list(), await api.create({ name: "x" }), await api.project(moon), await api.deleteProject(moon), await api.add(moon, "styles", { name: "x" })]) {
      expect([status, body.code]).toEqual([503, "DB_UNAVAILABLE"]);
    }
    for (const [status, body] of await Promise.all(every("down"))) expect([status, body.code]).toEqual([503, "DB_UNAVAILABLE"]);
    fake.state.failing = { table: "studio_projects", code: "XX000" };
    expect(await api.list()).toEqual([500, err(T.NOT_READ)]);
    expect(await api.project(moon)).toEqual([500, err(T.NOT_READ)]);
    expect(await api.create({ name: "x" })).toEqual([500, err(T.NOT_SAVED)]);
    expect(await api.deleteProject(moon)).toEqual([500, err(T.NOT_DELETED)]);
    fake.state.failing = null;
    fake.state.failNext = { table: "studio_assets", op: "delete", code: "XX000" };
    expect(await api.remove("assets", moon)).toEqual([500, err(T.NOT_DELETED)]);
  });

  it(`is rate limited per account: ${T.STUDIO_WRITES_PER_MIN} writes a minute across Studio's routes, every write counted; reads are not`, async () => {
    const moon = await made();
    for (let i = 1; i < T.STUDIO_WRITES_PER_MIN; i++) expect((await api.patchProject(moon, { description: `d${i}` }))[0]).toBe(200);
    // Every write but a picture's (counted apart, above), each refused before it reads anything.
    db.reads = [];
    for (const [status, body] of await Promise.all([
      api.create({ name: "x" }), api.patchProject(moon, { name: "x" }), api.deleteProject(moon),
      ...T.PROJECT_KINDS.filter((k) => k !== "assets").map((k) => api.add(moon, k, { name: "x" })),
      ...["characters", "styles", "master-prompts"].map((k) => api.patch(k, ID, { name: "x" })),
      ...T.ITEM_KINDS.map((k) => api.remove(k, ID)),
      api.patchContent(ID, { name: "x" }), api.deleteContent(ID), api.file(ID, [ID]), api.unfile(ID, ID),
    ])) expect([status, body]).toEqual([429, err("Too many requests")]);
    expect(db.reads).toEqual([]);
    expect((await api.project(moon))[0]).toBe(200);
    expect((await api.list())[0]).toBe(200);
    expect((await api.create({ name: "Hers" }, "her"))[0]).toBe(201);
  });
});
