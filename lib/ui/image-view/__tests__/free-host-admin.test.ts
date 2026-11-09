import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";
import type { CatalogueEntry } from "@/hooks/useModelLimits";
import { defaultModel, forViewer } from "../models";

/**
 * "wir müssen ohne scheiß das pollinations.ai iwie rausnehmen ... damit nur admins das vllt iwo nutzen können zu
 * testzwecken" (Kev, 2026-10-26): the free host's images carry its link, so only admins may pick it.
 */
const entry = (name: string, free = false) => ({ id: name, name, free, mediaType: "image" }) as CatalogueEntry;
const CATALOGUE = [entry("Flux (free)", true), entry("Nano Banana Pro"), entry("GPT-Image-2")];
const src = (...p: string[]) => readSource(join(__dirname, "..", "..", "..", "..", ...p));

describe("the free host is for admins only", () => {
  it("is left out of what everyone else may generate with", () => {
    for (const role of [null, "beta", "mod", "trial", "team"]) expect(forViewer(CATALOGUE, role).map((m) => m.name)).toEqual(["Nano Banana Pro", "GPT-Image-2"]);
    expect(forViewer(CATALOGUE, "admin")).toEqual(CATALOGUE);
  });

  it("a prompt made on it opens on the default generator instead", () => {
    expect(defaultModel({ catalogue: forViewer(CATALOGUE, "beta"), pick: "", aiModel: "Flux (free)", premium: false })).toBe("Nano Banana Pro");
    expect(defaultModel({ catalogue: forViewer(CATALOGUE, "admin"), pick: "", aiModel: "Flux (free)", premium: false })).toBe("Flux (free)");
  });

  it("is applied wherever generators are offered: the Image View, the editor and Quick Create", () => {
    expect(src("components", "image-view", "useImageViewModel.ts")).toContain("const catalogue = forViewer(useModelCatalogue(), role);");
    expect(src("components", "prompt-editor", "PromptEditor.tsx")).toContain('const models = useMemo(() => forViewer(catalogue, role).filter((m) => m.mediaType === media), [catalogue, role, media]);');
    const launcher = src("components", "GenerateLauncher.tsx");
    expect(launcher).toContain('const offerable = forViewer(core.catalogue, role).filter((m) => m.mediaType === "image");');
    expect(launcher).toContain("models={{ available: offerable.map(");
    expect(launcher).toContain("if (seed.modelId && offerable.some((m) => m.id === seed.modelId)) setModel(seed.modelId);");
  });
});
