import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generatorAliases, generatorGroups } from "../generators";

const FLUX = { id: "m1", name: "Flux (free)", mediaType: "image" as const };
const BANANA = { id: "nano-banana-pro", name: "Nano Banana Pro", mediaType: "image" as const };
const SEEDANCE = { id: "m3", name: "Seedance 2.5", mediaType: "video" as const };

describe("the generator filter's groups", () => {
  it("are Image, then Video, each with its own models' ids and names", () => {
    expect(generatorGroups([SEEDANCE, FLUX, BANANA])).toEqual([
      { label: "Image", entries: [{ id: "m1", name: "Flux (free)" }, { id: "nano-banana-pro", name: "Nano Banana Pro" }] },
      { label: "Video", entries: [{ id: "m3", name: "Seedance 2.5" }] },
    ]);
  });
  it("leave out a medium with no models, so an empty catalogue has no groups", () => {
    expect(generatorGroups([FLUX])).toEqual([{ label: "Image", entries: [{ id: "m1", name: "Flux (free)" }] }]);
    expect(generatorGroups([SEEDANCE])).toEqual([{ label: "Video", entries: [{ id: "m3", name: "Seedance 2.5" }] }]);
    expect(generatorGroups([])).toEqual([]);
  });
  it("in Images and Videos are the world's own branch only, in All both", () => {
    const all = [SEEDANCE, FLUX];
    const [image, video] = [{ label: "Image", entries: [{ id: "m1", name: "Flux (free)" }] }, { label: "Video", entries: [{ id: "m3", name: "Seedance 2.5" }] }];
    expect(generatorGroups(all, "all")).toEqual([image, video]);
    expect(generatorGroups(all, "images")).toEqual([image]);
    expect(generatorGroups(all, "videos")).toEqual([video]);
  });
});

describe("the generator filter's aliases", () => {
  it("send the id, the name and the family of each picked generator", () => {
    expect(generatorAliases(["m1"], [FLUX, BANANA])).toEqual(["m1", "Flux (free)", "flux"]);
  });
  it("send a spelling once", () => {
    expect(generatorAliases(["nano-banana-pro"], [BANANA])).toEqual(["nano-banana-pro", "Nano Banana Pro"]);
  });
  it("send every picked generator and nothing for an id the catalogue no longer has", () => {
    expect(generatorAliases(["m1", "gone", "m3"], [FLUX, SEEDANCE])).toEqual(["m1", "Flux (free)", "flux", "m3", "Seedance 2.5", "seedance-2-5"]);
    expect(generatorAliases([], [FLUX])).toEqual([]);
  });
  it("leave out an empty family", () => {
    expect(generatorAliases(["m9"], [{ id: "m9", name: "(soon)", mediaType: "image" }])).toEqual(["m9", "(soon)"]);
  });
});

describe("Home's feed", () => {
  it("takes its groups and its aliases from here, and keeps no copy", () => {
    const feed = readFileSync(join(__dirname, "..", "..", "..", "..", "components", "enki", "EnkiFeedPage.tsx"), "utf8");
    expect(feed).toContain("useMemo(() => groupGenerators(catalogue, media), [catalogue, media])");
    expect(feed).toContain("const models = generatorAliases(genFilter, catalogue);");
    expect(feed).not.toContain("toModelFamily");
  });
});
