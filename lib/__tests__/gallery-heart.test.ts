import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";

/**
 * The heart in a profile gallery (Kev, 2026-10-15): the rows carry the
 * viewer's hearts, the wall shows one on every image the database holds, and
 * the profile sets it at once, in order per image, with the read's own
 * headers, restoring what was shown when the server refuses.
 */
const ROOT = join(__dirname, "..", "..");
const src = (...p: string[]) => readSource(join(ROOT, ...p));

describe("the gallery's heart", () => {
  it("the gallery's rows carry the viewer's hearts, read in one query", () => {
    const g = src("app", "api", "generations", "route.ts");
    expect(g).toContain('const liked = v.userId ? await likedAmong(supabase, v.userId, "generated_image", rows.map((r) => String(r.id))) : new Set<string>();');
    expect(g).toContain("liked: liked.has(String(row.id)),");
    expect(src("components", "gallery", "GalleryWall.tsx")).toContain("liked: g.liked === true,");
  });

  it("the profile shows the heart at once, sets it on the server, and puts it back when refused", () => {
    const p = src("components", "profile", "ProfileView.tsx");
    expect(p).toContain("onLike={isAuthed ? likeImage : undefined}");
    expect(p).toContain("body: JSON.stringify({ liked }),");
    expect(p).toContain("setGalleryItems((prev) => prev.map((c) => (c.id === id ? { ...c, liked: state.mine } : c)));");
  });

  it("the like carries the read's own headers, so an 18+ image the viewer may see is likeable", () => {
    const p = src("components", "profile", "ProfileView.tsx");
    const like = p.slice(p.indexOf("const likeImage"), p.indexOf("const removeFromGallery"));
    expect(like).toContain('headers: { "Content-Type": "application/json", ...viewerHeaders() },');
    expect(like).not.toContain("sessionAuthHeaders");
  });

  it("clicks on one image go out in order, only the latest answer shows, a refusal restores what was shown", () => {
    const p = src("components", "profile", "ProfileView.tsx");
    const like = p.slice(p.indexOf("const likeImage"), p.indexOf("const removeFromGallery"));
    expect(like).toContain("const queued = (likeQueue.current.get(id) ?? Promise.resolve()).then(send);");
    expect(like).toContain("if (likeTurn.current.get(id) !== turn) return;");
    expect(like).toContain("const before = galleryItems.find((c) => c.id === id)?.liked === true;");
    expect(like).toContain("setGalleryItems((prev) => prev.map((c) => (c.id === id ? { ...c, liked: before } : c)));");
    expect(like).not.toContain("liked: !liked");
  });

  it("only an image the database holds gets a heart, alone or in the bar", () => {
    const w = src("components", "gallery", "GalleryWall.tsx");
    expect(w).toContain("{onLike && c.visibility && (");
    expect(w).toContain("const held = markedItems.filter((c) => c.visibility); const on = !held.every((c) => c.liked); for (const c of held) void onLike(c.id, on);");
  });
});
