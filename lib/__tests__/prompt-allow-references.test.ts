import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import type { SupabaseClient } from "@supabase/supabase-js";
import { pglitePostgrest } from "./_pglite-postgrest";
import { readSource } from "./_read-source";

/**
 * A premium prompt's reference images, its creator's to switch off (Kev, 2026-11-01: "die sind bei jedem free image ein
 * muss, wobei bei premium images das eingestellt werden kann"), on a real Postgres with SQL 62, and without it: the saves
 * and reads a day before the migration work as today, the save only says the setting was not kept. A free prompt ignores
 * it; a text that names "Reference image k" keeps them, whatever was asked. Generated SQL only; every check is stubbed.
 */
const pgs = vi.hoisted(() => ({ client: null as unknown, iv: 0 }));
const who = vi.hoisted(() => ({ ME: "00000000-0000-4000-8000-000000000001", BUYER: "00000000-0000-4000-8000-000000000002" }));
vi.hoisted(() => { process.env.AUTH_PEPPER = Buffer.alloc(32, 7).toString("base64"); });
vi.mock("next/server", async (original) => ({ ...(await original<typeof import("next/server")>()), after: () => {} }));
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => pgs.client }));
vi.mock("@/lib/crypto", () => ({
  encryptString: (text: string) => ({ encrypted: text, iv: `iv-${++pgs.iv}`, authTag: "tag", kid: "k1" }),
  decryptString: ({ encrypted }: { encrypted: string }) => encrypted,
}));
vi.mock("@/lib/session-user", async (original) => {
  const of = (t: string | null) => (t === "me" ? who.ME : t === "buyer" ? who.BUYER : null);
  return {
    ...(await original<typeof import("@/lib/session-user")>()),
    resolveSessionUserId: async (_s: unknown, t: string | null) => of(t),
    resolveSessionUserWithBan: async (_s: unknown, t: string | null) => ({ userId: of(t), ban: null }),
    resolveOwnerIds: async (_s: unknown, t: string | null) => (of(t) ? [of(t)] : null),
  };
});
vi.mock("@/lib/moderation", () => ({ moderate: async () => ({ allowed: true }), screenFirst: () => null, CLIENT_BLOCK_MESSAGE: "blocked" }));
vi.mock("@/lib/moderation-enforcement", () => ({ recordModerationEvent: async () => {} }));
vi.mock("@/lib/moderation/warnings", () => ({ recordWarning: async () => ({}), warningMessage: () => "warned" }));
vi.mock("@/lib/moderation/prompt-check", async (original) => ({
  ...(await original<typeof import("@/lib/moderation/prompt-check")>()),
  checkPrompt: async () => ({ verdict: "clear" }),
}));
vi.mock("@/lib/moderation/prompt-pause", () => ({ isPaused: async () => false }));
vi.mock("@/lib/adult-content", () => ({ showsAdultRender: async () => false, mayShowAdult: () => true, viewer: async () => null }));
vi.mock("@/lib/rate-limit", async (original) => ({ ...(await original<typeof import("@/lib/rate-limit")>()), checkRequestRateLimit: () => ({ allowed: true }) }));
vi.mock("@/lib/mfa", () => ({ enrolledFactors: async () => [] }));
vi.mock("@/lib/notifications", () => ({ notifyFollowers: async () => {} }));
vi.mock("@/lib/generation/small-renditions", () => ({ ensureShowcaseRenditions: async () => {} }));

import { GET as editorRead, POST as save } from "../../app/api/prompt/route";
import { GET as detail } from "../../app/api/prompts/[id]/route";
import { allowsReferences, columnMissing } from "@/lib/prompt-references";

const { ME, BUYER } = who;
const ROOT = join(__dirname, "..", "..");
const SQL = readFileSync(join(ROOT, "migrations", "2026-11-02-prompt-allow-references.sql"), "utf8");
const STUBS = `
  create table public.users (id uuid primary key, origin text, deleted_at timestamptz, account_status text default 'active');
  insert into public.users (id) values ('${ME}'), ('${BUYER}');
  create table public.bans (user_id uuid, lifted_at timestamptz, expires_at timestamptz);
  create table public.user_wallets (user_id uuid, address text, chain_family text, removed_at timestamptz);
  insert into public.user_wallets values ('${ME}', 'So1anaWa11etOfTheCreator111111111111111111', 'solana', null);
  create table public.prompts (id uuid primary key default gen_random_uuid(), creator_id uuid, title text, description text, ai_model text, ai_settings jsonb,
    encrypted_content text, encrypted_content_iv text, encrypted_content_tag text, encrypted_content_kid text, is_listed boolean default false, listing_status text default 'draft',
    delisted_at timestamptz, listed_at timestamptz, published_at timestamptz, deleted_at timestamptz, showcase_images jsonb default '[]', showcase_before_images jsonb default '[]',
    is_adult boolean default false, category text, tags text[], price_usd_cents int, aspect_ratio text, photo_count int, prompt_type text, resolution text,
    is_free_showcase boolean default false, public_prompt_text text, updated_at timestamptz, created_at timestamptz);
  create table public.prompt_variables (id uuid primary key default gen_random_uuid(), prompt_id uuid, name text, label text, description text, data_type text, default_value text,
    is_required boolean, position int, min_value numeric, max_value numeric, options jsonb, created_at timestamptz, updated_at timestamptz, deleted_at timestamptz);
  create table public.generated_images (id uuid primary key default gen_random_uuid(), storage_url text, user_id uuid, deleted_at timestamptz);
`;

let db: PGlite;
const BASE = { title: "Dusk portrait", content: "A portrait at dusk", aiModel: "Nano Banana Pro", category: "Portrait", promptType: "premium-prompt", price: 0.4, release: true };
const post = async (body: Record<string, unknown>, token = "me") => {
  const res = await save(new Request("http://enki.test/api/prompt", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Session-Token": token }, body: JSON.stringify({ ...BASE, ...body }),
  }));
  return { status: res.status, ...(await res.json()) } as { status: number; id: string; referencesNote: string | null; error?: string };
};
const stored = async (id: string) => (await db.query<{ allow_references: boolean; is_listed: boolean }>(`select allow_references, is_listed from public.prompts where id = $1`, [id])).rows[0];
const shown = async (id: string, token?: string) => {
  const res = await detail(new Request(`http://enki.test/api/prompts/${id}`, { headers: token ? { "X-Session-Token": token } : {} }), { params: Promise.resolve({ id }) });
  return { status: res.status, allow: ((await res.json()) as { prompt?: { allowReferences?: boolean } }).prompt?.allowReferences };
};
const forEditor = async (id: string) => {
  const res = await editorRead(new Request(`http://enki.test/api/prompt?id=${id}`, { headers: { "X-Session-Token": "me" } }));
  return { status: res.status, allow: ((await res.json()) as { allowReferences?: boolean }).allowReferences };
};

beforeAll(async () => {
  db = await PGlite.create();
  await db.exec(STUBS);
  pgs.client = pglitePostgrest(db).client;
}, 60_000);
afterAll(async () => { await db.close(); });
beforeEach(async () => { await db.exec(`truncate public.prompts, public.prompt_variables`); });

describe("before SQL 62", () => {
  beforeAll(async () => { await db.exec(`alter table public.prompts drop column if exists allow_references`); });

  it("a prompt saved with the switch off still saves and lists; the setting is not kept, and the answer says so", async () => {
    const r = await post({ allowReferences: false });
    expect(r.status).toBe(200);
    expect(r.referencesNote).toBe("the reference images setting is not saved yet, so it stays as it was");
    const { rows } = await db.query<{ is_listed: boolean }>(`select is_listed from public.prompts where id = $1`, [r.id]);
    expect(rows[0].is_listed).toBe(true);
  });

  it("a save with the switch on or without it says nothing, as today; an update too", async () => {
    const r = await post({ allowReferences: true });
    expect([r.status, r.referencesNote]).toEqual([200, null]);
    const again = await post({ id: r.id, allowReferences: true });
    expect([again.status, again.referencesNote]).toEqual([200, null]);
    const none = await post({ id: r.id });
    expect([none.status, none.referencesNote]).toEqual([200, null]);
  });

  it("no read breaks: a buyer's page and the creator's editor answer as today, allowed", async () => {
    const { id } = await post({});
    expect(await shown(id, "buyer")).toEqual({ status: 200, allow: true });
    expect(await forEditor(id)).toEqual({ status: 200, allow: true });
    await expect(allowsReferences(pgs.client as SupabaseClient, id)).resolves.toBe(true);
  });
});

describe("with SQL 62", () => {
  beforeAll(async () => { await db.exec(SQL); });

  it("gives every prompt there is the switch on, and cannot hold none", async () => {
    await db.exec(`alter table public.prompts drop column allow_references;
      insert into public.prompts (creator_id, title, prompt_type) values ('${ME}', 'Old', 'paid');`);
    await db.exec(SQL);
    await db.exec(SQL); // running it again changes nothing
    const { rows } = await db.query<{ allow_references: boolean }>(`select allow_references from public.prompts`);
    expect(rows).toEqual([{ allow_references: true }]);
    await expect(db.exec(`update public.prompts set allow_references = null`)).rejects.toThrow(/null value/);
  });

  it("the rollback at the file's end drops it", async () => {
    const rollback = SQL.match(/-- Rollback: (.*)/)?.[1] ?? "";
    await db.exec(rollback);
    expect((await db.query(`select 1 from information_schema.columns where table_name = 'prompts' and column_name = 'allow_references'`)).rows).toHaveLength(0);
    await db.exec(SQL);
  });

  it("a new premium prompt is on by default", async () => {
    const r = await post({});
    expect((await stored(r.id)).allow_references).toBe(true);
    expect(r.referencesNote).toBeNull();
  });

  it("the switch off is kept, a buyer reads it, its creator is as ever, the editor reads the stored value back", async () => {
    const r = await post({ allowReferences: false });
    expect(r.referencesNote).toBeNull();
    expect(await stored(r.id)).toMatchObject({ allow_references: false, is_listed: true });
    expect(await shown(r.id, "buyer")).toEqual({ status: 200, allow: false });
    expect(await shown(r.id)).toEqual({ status: 200, allow: false });
    expect(await shown(r.id, "me")).toEqual({ status: 200, allow: true });
    expect(await forEditor(r.id)).toEqual({ status: 200, allow: false });
  });

  it("an update switches it both ways; a save that does not send it leaves it", async () => {
    const { id } = await post({});
    await post({ id, allowReferences: false });
    expect((await stored(id)).allow_references).toBe(false);
    await post({ id, title: "Another title" });
    expect((await stored(id)).allow_references).toBe(false);
    await post({ id, allowReferences: true });
    expect((await stored(id)).allow_references).toBe(true);
  });

  it("a text that names a reference keeps them whatever was asked, and the answer says so", async () => {
    const r = await post({ content: "The sitter of Reference image 1 at dusk", allowReferences: false });
    expect(r.referencesNote).toBe("its text names a reference image, so buyers keep adding theirs");
    expect((await stored(r.id)).allow_references).toBe(true);
    expect(await shown(r.id, "buyer")).toEqual({ status: 200, allow: true });
  });

  it("a text edited to name a reference turns a switched-off prompt back on, sent or not", async () => {
    const { id } = await post({ allowReferences: false });
    const r = await post({ id, content: "Now with Reference image 2" });
    expect((await stored(id)).allow_references).toBe(true);
    expect(r.referencesNote).toBeNull();
  });

  it("a value that names a reference counts as well: it reaches the render's text", async () => {
    const r = await post({ content: "A portrait of [sitter]", allowReferences: false,
      variables: [{ name: "sitter", label: "sitter", type: "text", defaultValue: "the person in Reference image 1", position: 0 }] });
    expect(r.status).toBe(200);
    expect((await stored(r.id)).allow_references).toBe(true);
  });

  it("a value in the editor's own bracketed form counts too, any case: the value field keeps its brackets", async () => {
    for (const defaultValue of ["the person in [Reference image 1]", "the person in [reference image 2]"]) {
      const r = await post({ content: "A portrait of [sitter]", allowReferences: false,
        variables: [{ name: "sitter", label: "sitter", type: "text", defaultValue, position: 0 }] });
      expect(r.referencesNote).toBe("its text names a reference image, so buyers keep adding theirs");
      expect((await stored(r.id)).allow_references).toBe(true);
    }
  });

  it("a value's other brackets name nothing", async () => {
    const r = await post({ content: "A portrait of [sitter]", allowReferences: false,
      variables: [{ name: "sitter", label: "sitter", type: "text", defaultValue: "the person in [Character 1]", position: 0 }] });
    expect(r.referencesNote).toBeNull();
    expect((await stored(r.id)).allow_references).toBe(false);
  });

  it("a free prompt ignores it: saved as on, nothing to say, always allowed", async () => {
    const r = await post({ promptType: "free-prompt", allowReferences: false });
    expect(r.referencesNote).toBeNull();
    expect((await stored(r.id)).allow_references).toBe(true);
    await db.exec(`update public.prompts set allow_references = false`);
    await expect(allowsReferences(pgs.client as SupabaseClient, r.id)).resolves.toBe(true);
    expect(await shown(r.id, "buyer")).toEqual({ status: 200, allow: true });
    expect((await post({ promptType: "free-prompt", content: "With Reference image 1", allowReferences: false })).referencesNote).toBeNull();
  });

  it("a prompt made Open from a switched-off premium one is on again", async () => {
    const { id } = await post({ allowReferences: false });
    await post({ id, promptType: "free-prompt", price: 0 });
    expect((await stored(id)).allow_references).toBe(true);
  });

  it("a prompt is never listed before its setting is written", () => {
    const src = readSource(join(ROOT, "app", "api", "prompt", "route.ts"));
    const setting = src.indexOf("update({ allow_references: allowReferences })");
    expect(setting).toBeGreaterThan(0);
    expect(setting).toBeLessThan(src.indexOf('is_listed: true, listing_status: "active"'));
    // Only onto the text this very save wrote and judged, as the listing write below it.
    expect(src).toMatch(/update\({ allow_references: allowReferences }\)\s+\.eq\("id", promptId\)\.eq\("encrypted_content_iv", enc\.iv\)/);
  });
});

describe("the setting's read", () => {
  const client = (error: { code?: string; message: string }) => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error }) }) }) }),
  }) as unknown as SupabaseClient;

  it("takes a missing column as today, on a read (42703) and on a write (PGRST204), the codes PostgREST answered live", async () => {
    expect([columnMissing({ code: "42703" }), columnMissing({ code: "PGRST204" }), columnMissing({ code: "XX000" }), columnMissing(null)]).toEqual([true, true, false, false]);
    await expect(allowsReferences(client({ code: "42703", message: "no column" }), "p")).resolves.toBe(true);
  });

  it("goes no further on any other failure: a paid route must not guess it", async () => {
    await expect(allowsReferences(client({ code: "XX000", message: "down" }), "p")).rejects.toMatchObject({ code: "XX000" });
  });
});
