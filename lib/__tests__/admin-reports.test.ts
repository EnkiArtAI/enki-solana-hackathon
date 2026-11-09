import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { join } from "node:path";
import { readSource } from "./_read-source";
import { fakePostgrest } from "./_fake-postgrest";

/**
 * Reports show up in the admin panel (Kev, 2026-10-08). An image report names
 * the image's owner, its strike goes to that owner, and Hide makes the image
 * private: gone from every public read, still the owner's.
 */

const db = vi.hoisted(() => ({ current: null as ReturnType<typeof import("./_fake-postgrest").fakePostgrest> | null }));
vi.mock("@/lib/supabaseServer", () => ({ getSupabaseServerClient: () => db.current!.client }));
vi.mock("@/lib/session-user", () => ({ resolveSessionUserId: async () => "admin-1" }));
// A paused prompt's words as the decrypting reader returns them (DEC-476).
const words = vi.hoisted(() => ({ read: vi.fn(async (_s: unknown, _id: string) => ({ ok: true as const, text: "a koi of [colour] neon, the secret recipe", variables: [], adult: false, listed: false })) }));
vi.mock("@/lib/generation/prompt-text", async (orig) => ({
  ...(await orig<typeof import("@/lib/generation/prompt-text")>()),
  loadPromptText: (...a: [unknown, string]) => words.read(...a),
}));

import { GET, POST } from "../../app/api/admin/route";

const IMAGE = "aaaaaaaa-0000-4000-8000-000000000002";
const act = async (action: string, id = "rep-1") => {
  const res = await POST(new NextRequest("http://enki.test/api/admin", { method: "POST", body: JSON.stringify({ resource: "reports", action, id }) }));
  return { status: res.status, body: await res.json() };
};

beforeEach(() => {
  db.current = fakePostgrest();
  db.current.tables.users = [{ id: "admin-1", role: "admin" }, { id: "owner", role: "user" }];
  db.current.tables.generated_images = [{ id: IMAGE, user_id: "owner", visibility: "public" }];
  db.current.tables.reports = [
    { id: "rep-1", target_type: "generation", target_uuid: IMAGE, reason: "obscene", status: "pending" },
    { id: "rep-2", target_type: "prompt", target_uuid: "p1", reason: "spam", status: "pending" },
  ];
  db.current.tables.strikes = [];
});

describe("an image report in the admin panel", () => {
  it("Hide makes the image private and closes the report", async () => {
    expect(await act("hide")).toEqual({ status: 200, body: { ok: true } });
    expect(db.current!.tables.generated_images[0].visibility).toBe("private");
    expect(db.current!.tables.reports[0]).toMatchObject({ status: "actioned", decided_by: "admin-1" });
  });

  it("Hide is for images only", async () => {
    expect((await act("hide", "rep-2")).status).toBe(400);
    expect(db.current!.tables.reports[1].status).toBe("pending");
  });

  it("a strike goes to the image's owner, not to the image id", async () => {
    expect((await act("strike")).status).toBe(200);
    expect(db.current!.tables.strikes).toEqual([expect.objectContaining({ user_id: "owner", reason: "Report: obscene", related_target_uuid: IMAGE })]);
  });

  it("an image that is gone gets no strike: dismiss instead", async () => {
    db.current!.tables.generated_images = [];
    expect((await act("strike")).status).toBe(400);
    expect(db.current!.tables.strikes).toEqual([]);
  });
});

describe("the Reports tab", () => {
  it("lists the most urgent first, then the newest, naming an image by its owner", async () => {
    db.current!.tables.users.push({ id: "reporter", handle: "rita" }, { id: "creator", handle: "carl" });
    db.current!.tables.users[1].handle = "olga";
    db.current!.tables.prompts = [{ id: "p1", title: "Sunset" }];
    // As the database answers them: newest first.
    db.current!.tables.reports = [
      { id: "r-low", target_type: "prompt", target_uuid: "p1", reason: "spam", severity: "low", status: "pending", reporter_user_id: "reporter", created_at: "2026-10-08T12:00:00Z" },
      { id: "r-high-new", target_type: "user", target_uuid: "creator", reason: "hate", severity: "high", status: "pending", reporter_user_id: "reporter", details: "slurs in bio", created_at: "2026-10-08T11:00:00Z" },
      { id: "r-high-old", target_type: "user", target_uuid: "creator", reason: "hate", severity: "high", status: "pending", reporter_user_id: "reporter", created_at: "2026-10-08T10:00:00Z" },
      { id: "r-crit", target_type: "generation", target_uuid: IMAGE, reason: "child_safety", severity: "critical", status: "pending", reporter_user_id: "reporter", created_at: "2026-10-08T09:00:00Z" },
      { id: "r-done", target_type: "user", target_uuid: "creator", reason: "spam", severity: "low", status: "dismissed", reporter_user_id: "reporter", created_at: "2026-10-08T13:00:00Z" },
    ];
    db.current!.tables.generated_images[0].preview_url = "https://blob/i.preview.webp";
    const res = await GET(new NextRequest("http://enki.test/api/admin"));
    const { reports } = await res.json();
    // Each once, though the urgent ones are read twice (urgent and newest).
    expect(reports.map((r: { id: string }) => r.id)).toEqual(["r-crit", "r-high-new", "r-high-old", "r-low"]);
    expect(reports[0]).toMatchObject({ type: "image", target: "Image by @olga", href: "https://blob/i.preview.webp", reason: "child_safety", reporter: "rita" });
    expect(reports[1]).toMatchObject({ type: "profile", target: "@carl", href: "/creators/creator", details: "slurs in bio" });
    expect(reports[3]).toMatchObject({ type: "prompt", target: "Sunset", href: "/generator/p1" });
  });

  const ROUTE = readSource(join(__dirname, "..", "..", "app", "api", "admin", "route.ts"));
  const PAGE = readSource(join(__dirname, "..", "..", "app", "admin", "page.tsx"));

  it("reads every urgent report besides the newest, critical first, so none drowns below the hundred newest", () => {
    expect(ROUTE).toContain('return (urgent ? q.in("severity", ["critical", "high"]).order("severity", { ascending: true }) : q).order("created_at", { ascending: false }).limit(urgent ? 1000 : 100);');
    expect(ROUTE).toContain('.eq("status", "pending");');
  });

  it("looks targets and handles up a slice at a time, so hundreds of reports never make a URL the gateway refuses", () => {
    expect(ROUTE).toContain('const data = await inChunks(uniq, (chunk) => supabase.from("users").select("id, handle").in("id", chunk));');
    expect(ROUTE).toContain('const data = await inChunks(imageTargets, (chunk) => supabase.from("generated_images").select("id, user_id, preview_url, storage_url").in("id", chunk));');
    expect(ROUTE).toContain('const data = await inChunks(promptTargets, (chunk) => supabase.from("prompts").select("id, title").in("id", chunk));');
  });

  it("links what was reported", () => {
    expect(PAGE).toContain('{r.href ? <a href={r.href} target="_blank" rel="noopener noreferrer" style={{ color: "inherit" }}>{r.target}</a> : r.target}');
  });

  it("shows what the reporter wrote and the reason in words, urgent ones in red", () => {
    expect(PAGE).toContain("{r.details && <span style={{ fontSize: 11, color: \"var(--enki-ink-3)\" }}> · {r.details}</span>}");
    expect(PAGE).toContain("{REPORT_REASONS.find((x) => x.value === r.reason)?.label ?? r.reason}");
    expect(PAGE).toContain('color: r.severity === "critical" || r.severity === "high" ? "var(--enki-danger)"');
    expect(PAGE).toContain('{r.type === "image" && <Pill kind="amber" label="Hide"');
  });
});

// DEC-441: a prompt off sale after a render was refused for its own text waits in the Reports tab for staff.
describe("a prompt paused after a refused render", () => {
  beforeEach(() => {
    db.current!.tables.users.push({ id: "artist", handle: "ada" });
    db.current!.tables.prompts = [{ id: "p9", title: "Neon koi", creator_id: "artist", is_listed: false, delisted_at: null, deleted_at: null }];
    db.current!.tables.prompt_refusals = [
      { id: "f1", prompt_id: "p9", cause: "provider", detail: "OpenAI", paused: false, reviewed_at: null, created_at: "2026-10-27T10:00:00Z" },
      { id: "f2", prompt_id: "p9", cause: "provider", detail: "OpenAI", paused: true, reviewed_at: null, created_at: "2026-10-27T11:00:00Z" },
    ];
    db.current!.tables.admin_actions = [];
  });
  const decide = async (action: string, id = "p9") => {
    const res = await POST(new NextRequest("http://enki.test/api/admin", { method: "POST", body: JSON.stringify({ resource: "prompts", action, id }) }));
    return { status: res.status, body: await res.json() };
  };

  it("is listed with its artist and why, never its text", async () => {
    const { paused } = await (await GET(new NextRequest("http://enki.test/api/admin"))).json();
    expect(paused).toHaveLength(1);
    expect(paused[0]).toMatchObject({ promptId: "p9", title: "Neon koi", artist: "ada" });
    expect(paused[0].refusals.map((r: { cause: string; detail: string }) => [r.cause, r.detail])).toEqual([["provider", "OpenAI"], ["provider", "OpenAI"]]);
    expect(Object.keys(paused[0]).sort()).toEqual(["artist", "creatorId", "promptId", "refusals", "title"]);
  });

  it("Release puts it back on sale, decides its refusals, and is logged", async () => {
    expect(await decide("release")).toEqual({ status: 200, body: { ok: true } });
    expect(db.current!.tables.prompts[0].is_listed).toBe(true);
    expect(db.current!.tables.prompt_refusals.map((r) => [r.decision, r.reviewed_by])).toEqual([["released", "admin-1"], ["released", "admin-1"]]);
    expect(db.current!.tables.admin_actions).toEqual([expect.objectContaining({ action: "prompts.release", actor_id: "admin-1" })]);
  });

  it("Delist takes it down for good", async () => {
    expect((await decide("delist")).status).toBe(200);
    expect(db.current!.tables.prompts[0]).toMatchObject({ is_listed: false, delisted_at: expect.any(String) });
    expect(db.current!.tables.prompt_refusals.every((r) => r.decision === "delisted")).toBe(true);
  });

  it("is refused for any other action, and for a prompt that waits for nothing", async () => {
    expect((await decide("strike")).status).toBe(400);
    expect(db.current!.tables.prompts[0]).toMatchObject({ is_listed: false, delisted_at: null });
    db.current!.tables.prompt_refusals = [];
    expect((await decide("release")).status).toBe(400);
    expect(db.current!.tables.prompts[0].is_listed).toBe(false);
  });

  // DEC-476 (Kev, 2026-10-28, "5 yes"): the admin who decides it may read its words; nobody else, and only while it waits.
  it("gives an admin its text while it waits, logs the read without the words, and refuses a moderator", async () => {
    const read = await decide("text");
    expect(read).toEqual({ status: 200, body: { text: "a koi of [colour] neon, the secret recipe" } });
    expect(words.read).toHaveBeenCalledWith(expect.anything(), "p9");
    expect(db.current!.tables.admin_actions).toEqual([expect.objectContaining({ action: "prompts.text", actor_id: "admin-1" })]);
    expect(JSON.stringify(db.current!.tables.admin_actions)).not.toContain("secret recipe");
    db.current!.tables.users[0].role = "mod";
    words.read.mockClear();
    expect(await decide("text")).toEqual({ status: 403, body: { error: "Admins only" } });
    expect(words.read).not.toHaveBeenCalled();
  });

  it("reads no text of a prompt that waits for nothing", async () => {
    db.current!.tables.prompt_refusals = db.current!.tables.prompt_refusals.map((r) => ({ ...r, paused: false }));
    words.read.mockClear();
    expect((await decide("text")).status).toBe(404);
    expect(words.read).not.toHaveBeenCalled();
  });

  it("shows the text on an admin's tap only, under its row, and hides it on the next", () => {
    const PAGE = readSource(join(__dirname, "..", "..", "app", "admin", "page.tsx"));
    expect(PAGE).toContain('{role === "admin" && <Pill kind="plain" label={pausedText[p.promptId] !== undefined ? "Hide" : "Text"}');
    expect(PAGE).toContain('void post({ resource: "prompts", action: "text", id: p.promptId }, "", (cur) => cur).then((r) => {');
    expect(PAGE).toContain("if (pausedText[p.promptId] !== undefined) return setPausedText(({ [p.promptId]: _gone, ...rest }) => rest);");
    expect(PAGE).toMatch(/\{pausedText\[p\.promptId\] !== undefined && \(\n\s+<pre className="pause-text"/);
  });

  it("shows in the tab with Release and Delist, and counts as an open report", () => {
    const PAGE = readSource(join(__dirname, "..", "..", "app", "admin", "page.tsx"));
    expect(PAGE).toContain('void post({ resource: "prompts", action: "release", id: p.promptId }, "Prompt back on sale."');
    expect(PAGE).toContain('void post({ resource: "prompts", action: "delist", id: p.promptId }, "Prompt delisted."');
    expect(PAGE).toContain("reports: (data?.reports.length ?? 0) + (data?.paused.length ?? 0),");
    expect(PAGE).toContain('{ label: "Open reports", value: d.reports.length + d.paused.length,');
    expect(PAGE).toContain("paused: {pauseSummary(p.refusals)}");
    // The newest refusal's time (pausedPrompts lists them newest first).
    expect(PAGE).toContain('{timeAgo(p.refusals[0]?.at ?? "")}');
  });
});
