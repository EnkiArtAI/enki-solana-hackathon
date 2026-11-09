import { beforeEach, describe, expect, it, vi } from "vitest";
import { readSource } from "@/lib/__tests__/_read-source";
import { join } from "node:path";

/**
 * A premium prompt's words outside its variables never reach a share card
 * (Kev, 2026-11-03: "nur die variablen zu sehen"). The card has no read of its
 * own: this holds the real route's answer, for a visitor and for the creator
 * alike, and what the card makes of it.
 */
type Row = Record<string, unknown>;
let tables: Record<string, Row[]>;
let renders: Row[] = [];

function chain(table: string) {
  // Only the 18+ filter is honoured: a read narrowed to is_adult = false loses an 18+ row, as the database would.
  let adultOff = false;
  const rows = () => (tables[table] ?? []).filter((r) => !adultOff || r.is_adult !== true);
  const q: Record<string, unknown> = {
    maybeSingle: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
    single: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
    then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: rows(), error: null, count: rows().length }).then(ok),
  };
  q.eq = (column: string, value: unknown) => { if (column === "is_adult" && value === false) adultOff = true; return q; };
  for (const m of ["select", "neq", "in", "is", "not", "or", "ilike", "gte", "lte", "gt", "lt", "order", "range", "limit", "contains", "overlaps"]) q[m] = () => q;
  return q;
}

const SECRET = "ZZ-the-artists-secret-words-ZZ";
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => ({ from: chain }) }));
vi.mock("@/lib/crypto", () => ({ decryptString: () => "ZZ-the-artists-secret-words-ZZ" }));
vi.mock("@/lib/session-user", async (orig) => ({
  ...(await orig<typeof import("@/lib/session-user")>()),
  resolveOwnerIds: async (_s: unknown, token: string | null) => (token === "owner-token" ? ["owner-1"] : null),
}));

import { GET } from "../../../app/api/prompts/[id]/route";
import { contentFrom } from "../content";

const LIVE = { is_listed: true, listing_status: "active", deleted_at: null, creator_id: "owner-1", title: "Neon koi", description: null, ai_model: "Flux", showcase_images: ["https://b/1.png"] };
const paid: Row = { id: "p1", prompt_type: "paid", price_usd_cents: 150, public_prompt_text: SECRET, encrypted_content: "ct", encrypted_content_iv: "iv", encrypted_content_tag: "tag", ...LIVE };
const free: Row = { ...paid, id: "f1", prompt_type: "free", price_usd_cents: 0 };
const variable: Row = { id: "v1", name: "animal", label: "animal", description: "", data_type: "text", default_value: "a koi", is_required: true, position: 0, options: null };

function read(row: Row, token?: string) {
  tables = { prompts: [row], prompt_variables: [variable], users: [], user_wallets: [], generated_images: renders };
  const req = new Request(`http://localhost/api/prompts/${row.id}`, { headers: token ? { "X-Session-Token": token } : {} });
  return GET(req, { params: Promise.resolve({ id: String(row.id) }) });
}
async function answer(row: Row, token?: string) {
  const res = await read(row, token);
  expect(res.status).toBe(200);
  return (await res.json()).prompt as Row;
}

beforeEach(() => { tables = {}; renders = []; });

describe("the card over the real route's answer", () => {
  it.each([["a visitor", undefined], ["the creator", "owner-token"]])("a premium prompt's words reach neither the answer nor the card, for %s", async (_who, token) => {
    const api = await answer(paid, token);
    expect(JSON.stringify(api)).not.toContain(SECRET);
    const c = contentFrom(api, "kiri", "https://enki.gallery");
    expect(JSON.stringify(c)).not.toContain(SECRET);
    expect(c.words).toBeNull();
    expect(c.variables).toEqual([{ name: "animal", example: "a koi" }]);
    expect(c.images.map((i) => i.full)).toEqual(["https://b/1.png"]);
  });

  it("a free prompt's card does hold its words, so the absence above means something", async () => {
    const c = contentFrom(await answer(free), "kiri", "https://enki.gallery");
    expect(c.words).toBe(SECRET);
  });
});

describe("an 18+ prompt's card, for its creator (Kev, 2026-11-04: \"sharepopup soll auch für 18+ prompts kommen ofc\")", () => {
  const adult: Row = { ...paid, id: "a1", is_adult: true };

  it("reaches the card with its images and previews, with no 18+ pill and no confirmed age asked of its creator", async () => {
    renders = [{ id: "r1", user_id: "owner-1", storage_url: "https://b/1.png", preview_url: "https://b/1-p.webp", thumbnail_url: null, is_adult: true }];
    const c = contentFrom(await answer(adult, "owner-token"), "kiri", "https://enki.gallery");
    expect(c.images).toEqual([{ src: "https://b/1-p.webp", full: "https://b/1.png" }]);
    expect(c.link).toBe("https://enki.gallery/generator/a1");
  });

  it("an 18+ video reaches it too, with its poster", async () => {
    const video = { ...adult, media_type: "video", showcase_video: { preview: "https://b/v.mp4", v720: "https://b/v720.mp4", poster: "https://b/p.webp" } };
    expect(contentFrom(await answer(video, "owner-token"), "kiri", "https://enki.gallery").poster).toBe("https://b/p.webp");
  });

  it("anyone else gets what a missing prompt gets, so the test above measures the creator's way past that door", async () => {
    expect((await read(adult)).status).toBe(404);
    expect((await read(adult, "someone-else")).status).toBe(404);
  });
});

describe("the wiring", () => {
  const src = (...p: string[]) => readSource(join(__dirname, "..", "..", "..", ...p));

  it("a release offers the share over the page it opens: not a listing update, not after the editor was left, and an 18+ prompt like any other", () => {
    const editor = src("components", "prompt-editor", "PromptEditor.tsx");
    const left = editor.indexOf("if (!mounted.current) return;"), offer = editor.indexOf("if (!updating) offerShare(data.id, imageValues(starredJobs));"), page = editor.indexOf("router.push(promptPage(data.id));");
    expect(left).toBeGreaterThan(-1);
    expect(offer).toBeGreaterThan(left);
    expect(page).toBeGreaterThan(offer);
  });

  it("the host sits inside the gate, beside the notices", () => {
    const providers = src("providers", "index.tsx");
    const open = providers.indexOf("<BetaGate>"), host = providers.indexOf("<ShareHost />"), close = providers.indexOf("</BetaGate>");
    expect(open).toBeGreaterThan(-1);
    expect(host).toBeGreaterThan(open);
    expect(close).toBeGreaterThan(host);
  });
});
