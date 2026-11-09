import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { readSource } from "@/lib/__tests__/_read-source";
import { downloadName } from "@/lib/ui/kit/format";

/**
 * Marking and deleting in the gallery (Kev, 2026-10-15): a checkbox on each
 * tile's top-left corner on hover, a bar below the screen while any are
 * marked ("N selected | Download | heart | bin | x"), a heart on the top-right
 * corner that stays red once on, and an "are you sure" before anything is
 * deleted: a marked set, the viewer's Remove, the library's Delete.
 */
const ROOT = join(__dirname, "..", "..");
const WALL = readSource(join(ROOT, "components", "gallery", "GalleryWall.tsx"));
const CSS = readFileSync(join(ROOT, "components", "gallery", "gallery-wall.css"), "utf8");
const PROFILE = readSource(join(ROOT, "components", "profile", "ProfileView.tsx"));
const DIALOG = readSource(join(ROOT, "components", "kit", "ConfirmDialog.tsx"));

describe("marking", () => {
  it("puts a checkbox on the tile's top-left corner, for the owner, that marks without opening", () => {
    expect(WALL).toContain('<button type="button" className="gw-mark" role="checkbox" aria-checked={marked.has(c.id)} aria-label="Select"');
    expect(WALL).toContain("onClick={(e) => { e.stopPropagation(); toggleMark(c.id); }}");
    expect(WALL).toContain("{onRemove && (\n                    <button type=\"button\" className=\"gw-mark\"");
    expect(CSS).toMatch(/\.gw-mark \{ left: 8px;/);
    expect(CSS).toContain('.gw-shot:hover .gw-mark, .gw-shot:hover .gw-heart, .gw-mark[aria-checked="true"], .gw-heart--on { opacity: 1; }');
  });

  it("shows the bar while any are marked: the count, Download, heart, bin, clear", () => {
    const bar = WALL.slice(WALL.indexOf('<div className="gw-bar"'), WALL.indexOf("{confirm && ("));
    expect(WALL).toContain("{markedItems.length > 0 && (");
    expect(bar).toContain('<span className="gw-bar-count">{markedItems.length} selected</span>');
    expect(bar).toContain('for (const c of markedItems) await downloadImage(c.originalUrl ?? c.imageUrl, c.promptTitle ?? "");');
    expect(bar).toContain("const held = markedItems.filter((c) => c.visibility); const on = !held.every((c) => c.liked); for (const c of held) void onLike(c.id, on);");
    expect(bar).toContain("onClick={() => setConfirm({ ids: markedItems.map((c) => c.id) })}");
    expect(bar).toContain("onClick={() => setMarked(new Set())}");
    expect(CSS).toMatch(/\.gw-bar \{\s*position: fixed; left: 50%; bottom: 20px;/);
  });

  it("asks before deleting, then removes every marked image and unmarks it", () => {
    expect(WALL).toContain('title={confirm.ids.length === 1 ? "Delete this image?" : `Delete ${confirm.ids.length} images?`}');
    expect(WALL).toContain("for (const id of ids) await onRemove?.(id);");
    expect(WALL).toContain("onClick={() => { setSelectedId(null); setConfirm({ ids: [selected.id] }); }}");
    expect(WALL).not.toContain("void onRemove(selected.id)");
  });
});

describe("escape with images marked", () => {
  it("clears the marks and nothing else, while no image and no are-you-sure is open", () => {
    expect(WALL).toContain("if (!marked.size || selectedId || confirm) return;");
    expect(WALL).toContain('const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.defaultPrevented) { e.stopPropagation(); setMarked(new Set()); } };');
  });
});

describe("download names", () => {
  it("carry the file's own id after the prompt's title, so a batch never collides (format.test.ts has the shape)", () => {
    expect(downloadName("Misty Harbor", "1792100285989_r22xj00", "image/png")).toBe("enki-misty-harbor-1792100285989_r22xj00.png");
    expect(WALL).toContain('onClick={() => void downloadImage(selected.originalUrl ?? selected.imageUrl, selected.promptTitle ?? "")}');
  });
});

describe("the heart", () => {
  it("sits on the tile's top-right corner, red while on, only when liking is wired", () => {
    expect(WALL).toContain('className={"gw-heart" + (c.liked ? " gw-heart--on" : "")}');
    expect(WALL).toContain("onClick={(e) => { e.stopPropagation(); void onLike(c.id, !c.liked); }}");
    expect(WALL).toContain("{onLike && c.visibility && (\n                    <button type=\"button\" className={\"gw-heart\"");
    expect(CSS).toContain(".gw-heart--on { color: #ff3b5c; }");
    expect(CSS).toMatch(/\.gw-heart \{ right: 8px;/);
  });
});

describe("the are-you-sure", () => {
  it("cancels on Escape and the backdrop, confirms on Enter, and never lets Escape reach the panel behind", () => {
    expect(DIALOG).toContain('if (e.key === "Escape") { e.stopPropagation(); onCancel(); }');
    expect(DIALOG).toContain('if (e.key === "Enter") { e.stopPropagation(); onConfirm(); }');
    expect(DIALOG).toContain('window.addEventListener("keydown", onKey, true);');
    expect(DIALOG).toContain('<div className="kit-confirm-scrim" onClick={onCancel}>');
    expect(DIALOG).toContain("cancel.current?.focus();");
  });

  it("guards the library's Delete too", () => {
    expect(PROFILE).toContain('title="Delete from library" onClick={() => setLibraryDelete(it.id)}>Delete</button>');
    expect(PROFILE).toContain("onConfirm={() => { const id = libraryDelete; setLibraryDelete(null); void deleteLibraryItem(id); }}");
  });
});
