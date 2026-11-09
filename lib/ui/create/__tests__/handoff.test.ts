import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendToVideo, takeForVideo } from "../handoff";

// Kev, 2026-10-30: Animate puts a picture "in den letzten video editor ... in den wo noch was frei ist".
describe("Animate's hand-off to Create > Video", () => {
  let store: Map<string, string>;
  beforeEach(() => {
    store = new Map();
    vi.stubGlobal("sessionStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("leaves the picture and answers Create > Video's address; it is taken once", () => {
    expect(sendToVideo({ url: "https://s/a.webp", thumb: "https://s/a-t.webp" })).toBe("/home?create=video");
    expect(takeForVideo()).toEqual({ url: "https://s/a.webp", thumb: "https://s/a-t.webp" });
    expect(takeForVideo()).toBeNull();
  });

  it("takes nothing that is not a picture, and lives without storage", () => {
    store.set("enki:animate", JSON.stringify({ url: "" }));
    expect(takeForVideo()).toBeNull();
    expect(store.has("enki:animate")).toBe(false);
    store.set("enki:animate", "{not json");
    expect(takeForVideo()).toBeNull();
    vi.stubGlobal("sessionStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
    expect(sendToVideo({ url: "https://s/b.webp" })).toBe("/home?create=video");
    expect(takeForVideo()).toBeNull();
  });
});
