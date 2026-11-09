import { describe, it, expect, beforeEach, vi } from "vitest";
import { join } from "node:path";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { fakePostgrest } from "./_fake-postgrest";
import { readSource } from "./_read-source";

/**
 * Kev, 2026-10-29: "show opted-in references must be in there". DEC-514: a public image's references show only where
 * its owner turned "Show the references" on (lib/public-references.ts, the one gate), here on three more surfaces: the
 * profile gallery a visitor opens, the /i/<id> share page, and a prompt's creator examples. Everything else keeps
 * them: an image not public, the switch off, a read that failed. A visitor never gets the owner's own reading.
 */
const db = vi.hoisted(() => ({ current: null as ReturnType<typeof import("./_fake-postgrest").fakePostgrest> | null }));
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => db.current!.client }));
vi.mock("@/lib/session-user", async (orig) => ({
  ...(await orig<typeof import("@/lib/session-user")>()),
  resolveSessionUserId: async (_s: unknown, token: string | null) => (token === "owner-tok" ? OWNER : token === "visitor-tok" ? "visitor" : null),
  resolveOwnerIds: async (_s: unknown, token: string | null) => (token === "owner-tok" ? [OWNER] : token === "visitor-tok" ? ["visitor"] : null),
}));

import { GET as gallery } from "../../app/api/generations/route";
import { GET as detail } from "../../app/api/prompts/[id]/route";
import SharedImagePage, { generateMetadata } from "../../app/i/[id]/page";
import { toGalleryItem } from "@/components/gallery/GalleryWall";

const OWNER = "0b5f2c1e-1111-4222-8333-444455556666";
const OTHER = "0b5f2c1e-1111-4222-8333-777777777777";
const P = "9c1d2e3f-1111-4222-8333-444455556666";
const BLOB = "https://x.public.blob.vercel-storage.com/";
const ref = (generation_id: string, sequence_index: number, name: string) => ({ generation_id, sequence_index, storage_url: `${BLOB}refs/${name}.webp` });
const R = (name: string) => `${BLOB}refs/${name}.webp`;
const image = (id: string, extra: Record<string, unknown> = {}) => ({
  id, user_id: OWNER, generation_id: `gen-${id}`, storage_url: `${BLOB}${id}.png`, preview_url: `${BLOB}${id}.preview.webp`, thumbnail_url: `${BLOB}${id}.thumb.webp`,
  width: 1024, height: 1024, prompt_id: null, description: "", visibility: "public", references_public: false, is_uploaded: false, is_adult: false,
  deleted_at: null, created_at: "2026-10-29T10:00:00Z", ...extra,
});
type Row = Record<string, unknown>;
/** The client's from(), with one table made to throw instead of answering. */
const throwing = (table: string) => {
  const client = db.current!.client as unknown as { from: (t: string) => unknown };
  const from = client.from.bind(client);
  client.from = (t: string) => {
    if (t === table) throw new Error("socket hang up");
    return from(t);
  };
};

beforeEach(() => {
  db.current = fakePostgrest();
  db.current.tables.users = [{ id: OWNER, handle: "kev", deleted_at: null, account_status: "active" }];
  db.current.tables.bans = [];
});

describe("a profile gallery", () => {
  beforeEach(() => {
    const t = db.current!.tables;
    t.generated_images = [
      image("shown", { generation_id: "gen-1", references_public: true }),
      // The same render, its own switch off: references go by image, never by render.
      image("sibling", { generation_id: "gen-1" }),
      image("kept", { generation_id: "gen-2" }),
      image("private", { generation_id: "gen-3", visibility: "private", references_public: true }),
    ];
    t.generations = ["gen-1", "gen-2", "gen-3"].map((id) => ({ id, model_id: null, aspect_ratio: "1:1", resolution: "2K", boost: false }));
    t.generation_reference_images = [ref("gen-1", 0, "r1"), ref("gen-1", 1, "r2"), ref("gen-2", 0, "kept"), ref("gen-3", 0, "private")];
  });
  const read = async (token?: string) => {
    const res = await gallery(new Request(`http://enki.test/api/generations?userId=${OWNER}`, { headers: token ? { "X-Session-Token": token } : {} }));
    const body = await res.json();
    return { status: res.status, text: JSON.stringify(body), rows: body.generations as Row[] };
  };
  const refsOf = (rows: Row[]) => Object.fromEntries(rows.map((g) => [g.id, (g.settings as { references: string[] } | null)?.references]));

  it("gives a visitor the references of a public image whose owner shows them, and none of the others", async () => {
    for (const token of [undefined, "visitor-tok"]) {
      const { rows, text } = await read(token);
      expect(refsOf(rows)).toEqual({ shown: [R("r1"), R("r2")], sibling: [], kept: [] });
      // Never the owner's reading: not of a switch left off, not of a private image.
      expect(text).not.toContain(R("kept"));
      expect(text).not.toContain(R("private"));
      // What the gallery viewer's gw-refs row shows (GalleryWall.tsx).
      expect(toGalleryItem(rows[0] as never)?.references).toEqual([R("r1"), R("r2")]);
    }
  });

  it("gives its owner every reference, whatever the switch says", async () => {
    const { rows } = await read("owner-tok");
    expect(refsOf(rows)).toEqual({ shown: [R("r1"), R("r2")], sibling: [R("r1"), R("r2")], kept: [R("kept")], private: [R("private")] });
  });

  it("shows a visitor none after a failed read, before SQL 43 included, and the images still", async () => {
    db.current!.state.failing = { table: "generation_reference_images", code: "PGRST000" };
    let got = await read();
    expect(got.status).toBe(200);
    expect(refsOf(got.rows)).toEqual({ shown: [], sibling: [], kept: [] });
    db.current!.state.failing = null;
    // The gallery's own read first, then the references gate's, whose column is missing before SQL 43.
    db.current!.state.failNext = { table: "generated_images", op: "select", code: "42703", skip: 1 };
    got = await read();
    expect(got.status).toBe(200);
    expect(refsOf(got.rows)).toEqual({ shown: [], sibling: [], kept: [] });
  });
});

describe("the share page", () => {
  type El = ReactElement<Record<string, unknown>>;
  function* walk(node: ReactNode): Generator<El> {
    if (Array.isArray(node)) for (const n of node) yield* walk(n);
    else if (isValidElement<Record<string, unknown>>(node)) { yield node; yield* walk(node.props.children as ReactNode); }
  }
  const IMG = "1a2b3c4d-1111-4222-8333-444455556666";
  const page = async () => (await SharedImagePage({ params: Promise.resolve({ id: IMG }) })) as El;
  const group = (main: El) => [...walk(main)].find((el) => el.props["aria-label"] === "Reference images");
  beforeEach(() => {
    db.current!.tables.generated_images = [image(IMG, { references_public: true })];
    db.current!.tables.generation_reference_images = [ref(`gen-${IMG}`, 0, "r1"), ref(`gen-${IMG}`, 1, "r2")];
  });

  it("shows the references its owner shows, under the caption, each a link to the full picture", async () => {
    const main = await page();
    const kids = (main.props.children as ReactNode[]).filter(isValidElement) as El[];
    expect(kids.map((k) => k.type)).toEqual(["img", "p", "div", "a"]);
    const links = [...walk(group(main))].filter((el) => el.type === "a");
    expect(links.map((a) => [a.props.href, a.props.target, a.props.rel])).toEqual([
      [R("r1"), "_blank", "noopener noreferrer"], [R("r2"), "_blank", "noopener noreferrer"],
    ]);
    expect([...walk(group(main))].filter((el) => el.type === "img").map((i) => [i.props.src, i.props.alt])).toEqual([
      [R("r1"), "Reference image 1"], [R("r2"), "Reference image 2"],
    ]);
  });

  it("shows none while the switch is off, and links nothing that is not an https picture", async () => {
    db.current!.tables.generated_images = [image(IMG)];
    expect(group(await page())).toBeUndefined();
    db.current!.tables.generated_images = [image(IMG, { references_public: true })];
    db.current!.tables.generation_reference_images = [
      { generation_id: `gen-${IMG}`, sequence_index: 0, storage_url: "javascript:alert(1)" }, ref(`gen-${IMG}`, 1, "r2"),
    ];
    expect([...walk(group(await page()))].filter((el) => el.type === "a").map((a) => a.props.href)).toEqual([R("r2")]);
  });

  it("shows the image without references when their read fails or throws", async () => {
    db.current!.state.failing = { table: "generation_reference_images", code: "PGRST000" };
    let main = await page();
    expect(group(main)).toBeUndefined();
    expect([...walk(main)].some((el) => el.type === "img" && el.props.src === `${BLOB}${IMG}.preview.webp`)).toBe(true);
    db.current!.state.failing = null;
    throwing("generation_reference_images");
    main = await page();
    expect(group(main)).toBeUndefined();
  });

  it("reads them in the page body only: the link preview asks nothing of them", async () => {
    throwing("generation_reference_images");
    // The head would fall back to the brand card if a references read ran in it and threw.
    expect((await generateMetadata({ params: Promise.resolve({ id: IMG }) })).title).toBe("An image by @kev · Enki Art");
  });
});

describe("a prompt's creator examples", () => {
  const U = (n: number) => `${BLOB}showcase-${n}.png`;
  beforeEach(() => {
    const t = db.current!.tables;
    t.prompts = [{ id: P, title: "Neon Koi", creator_id: OWNER, prompt_type: "paid", price_usd_cents: 100, is_listed: true, listing_status: "active",
      deleted_at: null, is_adult: false, showcase_images: [U(1), U(2), U(3), U(4), U(5)] }];
    t.prompt_variables = [];
    t.generated_images = [
      image("s1", { storage_url: U(1), references_public: true }),
      // A second record of the same file, its switch off, takes nothing from the one that shows them.
      image("s1-again", { storage_url: U(1), preview_url: `${BLOB}s1.preview.webp` }),
      image("s2", { storage_url: U(2), visibility: "private", references_public: true }),
      image("s3", { storage_url: U(3) }),
      // The same file on someone else's row is no render of the creator's.
      image("s4", { storage_url: U(4), user_id: OTHER, references_public: true }),
      image("s5", { storage_url: U(5), references_public: true, deleted_at: "2026-10-28T00:00:00Z" }),
    ];
    t.generation_reference_images = ["s1", "s1-again", "s2", "s3", "s4", "s5"].map((id) => ref(`gen-${id}`, 0, id));
  });
  const examples = async (token?: string) => {
    const res = await detail(new Request(`http://enki.test/api/prompts/${P}`, { headers: token ? { "X-Session-Token": token } : {} }), { params: Promise.resolve({ id: P }) });
    return { status: res.status, shown: (await res.json()).prompt?.showcaseImages as { url: string; preview: string | null; references: string[] }[] };
  };

  it("carry the references of the creator's own render where it is public with the switch on, for everyone alike", async () => {
    for (const token of [undefined, "visitor-tok", "owner-tok"]) {
      const { shown } = await examples(token);
      expect(shown.map((s) => [s.url, s.references])).toEqual([[U(1), [R("s1")]], [U(2), []], [U(3), []], [U(4), []], [U(5), []]]);
      // Still with their renditions.
      expect(shown[0].preview).toBe(`${BLOB}s1.preview.webp`);
    }
    // The fake answers whole rows; the live read answers only the columns it names, and the match needs the owner.
    const route = readSource(join(__dirname, "..", "..", "app", "api", "prompts", "[id]", "route.ts"));
    expect(route).toContain('.select("id, storage_url, user_id").in("storage_url", chunk)');
  });

  it("carry none after a failed read, and the prompt still loads", async () => {
    db.current!.state.failing = { table: "generation_reference_images", code: "PGRST000" };
    let got = await examples();
    expect(got.status).toBe(200);
    expect(got.shown.map((s) => s.references)).toEqual([[], [], [], [], []]);
    db.current!.state.failing = null;
    // The renditions' read first, then the one tracing each example to its render.
    db.current!.state.failNext = { table: "generated_images", op: "select", code: "PGRST000", skip: 1 };
    got = await examples();
    expect(got.status).toBe(200);
    expect(got.shown.map((s) => s.references)).toEqual([[], [], [], [], []]);
    expect(got.shown[0].preview).toBe(`${BLOB}s1.preview.webp`);
  });

  it("reach the image view's examples, whose stage and viewer show shot.references", () => {
    const view = readSource(join(__dirname, "..", "..", "components", "image-view", "useImageViewModel.ts"));
    expect(view).toContain("showcaseImages?: { url: string; preview?: string | null; thumb?: string | null; view?: string; tiny?: string; references?: string[] }[];");
    expect(view).toContain("(prompt?.showcaseImages ?? []).map(({ url, preview, thumb, view, tiny, references }, i) => ({");
    expect(view).toContain("original: url, ratio: prompt?.aspect_ratio ?? null, references,\n");
  });
});
