import { describe, it, expect, beforeEach } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { readSource } from "@/lib/__tests__/_read-source";
import { toGalleryItem } from "@/components/gallery/GalleryWall";
import { leaveQuickCreateSeed, takeQuickCreateSeed, QUICK_CREATE_EVENT } from "@/lib/ui/quick-create-seed";

/**
 * The gallery's viewer (Kev, 2026-10-15): the prompt text, or for a bought
 * prompt the values filled in, the generator's name, the reference images, and
 * Recreate on the image's corner, which reopens the surface the image was made
 * on, set up as it was made. Escape closes the image and leaves the profile
 * open. Quick Create idles as one round button in the bottom-right corner.
 */
const ROOT = join(__dirname, "..", "..");
const WALL = readSource(join(ROOT, "components", "gallery", "GalleryWall.tsx"));
const CSS = readFileSync(join(ROOT, "components", "gallery", "gallery-wall.css"), "utf8");
const PROFILE = readSource(join(ROOT, "components", "profile", "ProfileView.tsx"));
const LAUNCHER = readSource(join(ROOT, "components", "GenerateLauncher.tsx"));
const VIEW = readSource(join(ROOT, "components", "image-view", "useImageViewModel.ts"));
const MODAL_CSS = readFileSync(join(ROOT, "app", "editor", "mobile-modal.css"), "utf8");

describe("the viewer's details", () => {
  it("shows the owner's text, else the values of a bought prompt under its title, else that none was recorded", () => {
    const details = WALL.slice(WALL.indexOf('<aside className="gw-details">'), WALL.indexOf("</aside>"));
    // Above the text: the prompt's title opens its view, the artist their page (market prompts only).
    expect(details).toContain('{selected.promptKind === "market" && (selected.promptTitle || selected.artist) && (');
    expect(details).toContain('<button type="button" className="gw-title gw-link" onClick={() => onOpenPrompt(selected)}>{selected.promptTitle}</button>');
    expect(details).toContain('<button type="button" className="gw-artist gw-link" onClick={() => openCreator(selected.artist?.handle ?? "")}>');
    expect(details.indexOf("gw-source")).toBeLessThan(details.indexOf("CopyBox"));
    expect(PROFILE).toContain("onOpenPrompt={(c) => { if (c.promptId) setRecreate({ promptId: c.promptId, imageUrl: c.imageUrl }); }}");
    expect(details).toContain('{selected.text ? (\n                <CopyBox text={selected.text} className="gw-copybox--prompt" />\n              ) : selected.values && Object.keys(selected.values).length ? (');
    expect(details).toContain('<CopyBox key={name} label={name} text={String(value)} />');
    expect(details).toContain('{selected.isUploaded ? "Uploaded image" : "No prompt recorded"}');
    expect(details).not.toContain("selected.prompt}");
  });

  it("names the generator rather than its id, and shows the reference images the render was sent", () => {
    expect(WALL).toContain("[selected.modelName ?? selected.made.model, selected.made.ratio, selected.made.resolution].filter(Boolean)");
    // The generator sits just above the actions; the text takes the room between.
    expect(CSS).toContain(".gw-made { margin-top: auto; padding-top: 8px; }");
    expect(CSS).toContain(".gw-copybox--prompt { flex: 1 1 auto; min-height: 80px; overflow: auto; }");
    expect(CSS).toContain(".gw-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 2px; }");
    expect(toGalleryItem({ id: "4", image_url: "o.png", created_at: "x", prompt_artist: { handle: "amara", name: null } })).toMatchObject({ artist: { handle: "amara", name: null } });
    expect(WALL).toContain('<div className="gw-refs" aria-label="Reference images">');
    expect(PROFILE).toContain("c.modelName || !c.made?.model ? c : { ...c, modelName: catalogue.find((m) => m.id === c.made?.model)?.name ?? null }");
    expect(toGalleryItem({ id: "1", image_url: "o.png", created_at: "x", prompt_text: "a cat", variable_values: { subject: "cat" }, prompt_title: "T", prompt_kind: "market", model_name: "NB",
      settings: { modelId: "m", aspectRatio: "1:1", resolution: "2K", references: ["r1.png", 7 as unknown as string] } }))
      .toMatchObject({ text: "a cat", values: { subject: "cat" }, promptTitle: "T", promptKind: "market", modelName: "NB", references: ["r1.png"] });
    expect(toGalleryItem({ id: "2", image_url: "o.png", created_at: "x" })).toMatchObject({ text: null, values: null, promptKind: null, modelName: null, references: [] });
    // The image row's description ("Attached reference image" and the like) never stands in for the text.
    expect(toGalleryItem({ id: "3", image_url: "o.png", created_at: "x", prompt: "Attached reference image" })).toMatchObject({ text: null, prompt: "Attached reference image" });
  });

  it("keeps Escape to the image: taken in the capture phase and stopped before the profile panel's listener", () => {
    expect(WALL).toContain('if (e.key === "Escape") { e.stopPropagation(); setSelectedId(null); }');
    expect(WALL).toContain('window.addEventListener("keydown", onKey, true);');
    expect(WALL).toContain('window.removeEventListener("keydown", onKey, true);');
  });
});

describe("Recreate", () => {
  it("leads the actions, where Download was, for the owner's rendered images only", () => {
    const actions = WALL.slice(WALL.indexOf('<div className="gw-actions">'), WALL.indexOf("</aside>"));
    expect(actions.indexOf("{onRecreate && !selected.isUploaded && (")).toBeLessThan(actions.indexOf("downloadImage("));
    expect(actions).toContain('<button type="button" className="gw-act gw-act--primary" onClick={() => onRecreate(selected)}');
    expect(WALL).not.toContain("gw-recreate");
    expect(PROFILE).toContain("onRecreate={own ? recreateFrom : undefined}");
  });

  it("frames the text and each value with a copy icon on the top-right corner", () => {
    expect(WALL).toContain('navigator.clipboard.writeText(text).then(() => notify("Copied"), () => notify("Copy failed", { tone: "error" }));');
    expect(WALL).toContain('<button type="button" className="gw-copy" onClick={copy} aria-label={label ? `Copy ${label}` : "Copy"} title="Copy">');
    expect(CSS).toMatch(/\.gw-copy {\s*position: absolute; top: 6px; right: 6px;/);
    expect(CSS).toMatch(/\.gw-copybox {\s*position: relative;[^}]*border: 1px solid/);
  });

  it("opens a listed prompt's image view on that very render, and the view takes its settings and references", () => {
    expect(PROFILE).toContain('if (c.promptKind === "market" && c.promptId) {\n      setRecreate({ promptId: c.promptId, imageUrl: c.imageUrl, recreateImageId: c.id });');
    expect(PROFILE).toContain("<EnkiDetailPanel key={`${recreate.promptId}:${recreate.recreateImageId ?? \"\"}`} seed={recreate} onClose={() => setRecreate(null)} />");
    expect(VIEW).toContain("const shot = history.find((x) => x.record?.id === recreateId);");
    expect(VIEW).toContain("recreated.current = recreateId;");
    expect(VIEW).toContain("const t = setTimeout(() => select(shot), 0);");
  });

  it("sends a Quick Create render back to Quick Create as it was made, and closes the profile", () => {
    expect(PROFILE).toContain("leaveQuickCreateSeed({\n      prompt: c.text ?? \"\", modelId: c.made?.model ?? null, aspectRatio: c.made?.ratio ?? null,\n      resolution: c.made?.resolution ?? null, references: c.references ?? [],\n    });\n    onBack?.();");
    expect(LAUNCHER).toContain("window.addEventListener(QUICK_CREATE_EVENT, take);");
    // Its generator comes back when the viewer may use it (the free host is for admins only, 2026-10-26).
    expect(LAUNCHER).toContain("if (seed.modelId && offerable.some((m) => m.id === seed.modelId)) setModel(seed.modelId);");
    expect(LAUNCHER).toContain("if (data && epoch === refsEpoch.current) setReferenceImages((prev) => [...prev, data]);");
  });
});

describe("the Quick Create seed", () => {
  // Node has no window or sessionStorage: the smallest stand-ins the seed needs.
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    const g = globalThis as { window?: unknown; sessionStorage?: unknown };
    g.window = g.window ?? new EventTarget();
    g.sessionStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
    };
  });
  it("is left once and taken once, and raises the event", () => {
    let raised = 0;
    const on = () => { raised++; };
    window.addEventListener(QUICK_CREATE_EVENT, on);
    leaveQuickCreateSeed({ prompt: "a cat", modelId: "m", references: ["r.png"] });
    window.removeEventListener(QUICK_CREATE_EVENT, on);
    expect(raised).toBe(1);
    expect(takeQuickCreateSeed()).toEqual({ prompt: "a cat", modelId: "m", references: ["r.png"] });
    expect(takeQuickCreateSeed()).toBeNull();
  });
  it("ignores a seed without a prompt", () => {
    sessionStorage.setItem("enki:quick-create-seed", JSON.stringify({ modelId: "m" }));
    expect(takeQuickCreateSeed()).toBeNull();
  });
});

describe("Quick Create idle", () => {
  it("is one round button in the bottom-right corner; pressed, the sheet pops out of that corner", () => {
    expect(LAUNCHER).toContain('<div className="ek-generate-launcher">');
    expect(MODAL_CSS).toContain(".ek-generate-launcher { position: fixed; bottom: calc(24px + env(safe-area-inset-bottom, 0px)); right: 24px; z-index: 150; }");
    expect(LAUNCHER).toContain('className="ek-generate-fab kit-hit"');
    // The old bar's italic "new image" tail is gone.
    expect(LAUNCHER).not.toContain('fontStyle: "italic", fontSize: 15');
    expect(LAUNCHER).toContain('<div className={popped ? "qc-pop" : undefined}>');
    expect(MODAL_CSS).toMatch(/\.ek-generate-fab \{\s*width: 56px; height: 56px; border-radius: 50%;/);
    expect(MODAL_CSS).toMatch(/\.qc-pop \.mobile-modal-sheet \{ animation: qcPop[^}]*transform-origin: 100% 100%; \}/);
  });
});
