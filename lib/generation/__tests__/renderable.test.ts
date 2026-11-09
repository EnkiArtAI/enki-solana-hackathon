import { describe, it, expect, vi, beforeEach } from "vitest";

/** /authorize's preflight mirrors the generate route's own (verification 2026-10-18). */
const s = vi.hoisted(() => ({ model: vi.fn(), route: vi.fn(), keyMissing: vi.fn() }));
vi.mock("@/lib/generation/models", () => ({ resolveModel: (...a: unknown[]) => s.model(...a), chooseRoute: (...a: unknown[]) => s.route(...a) }));
vi.mock("@/lib/generation/provider-health", () => ({ providerKeyMissing: (...a: unknown[]) => s.keyMissing(...a) }));
vi.mock("@/lib/generation/model-family", () => ({ toModelFamily: (name: string) => (name === "GPT Image 2" ? "gpt-image-2" : "other") }));

import { renderableHere } from "@/lib/generation/renderable";

const paid = { model_id: "m-1", model_family: "gpt-image-2", resolution: "2K", quality: null, boost: false, reference_image_count: 1 };
const db = {} as never;

beforeEach(() => {
  vi.clearAllMocks();
  s.model.mockResolvedValue({ id: "m-1", name: "GPT Image 2", supportsQuality: false, supportsResolution: true, maxRefs: 1 });
  s.route.mockResolvedValue({ provider: "openai", providerModel: "gpt-image-2" });
  s.keyMissing.mockReturnValue(false);
});

describe("whether this environment can render a paid intent", () => {
  it("is yes for a resolvable model of the paid family on an implemented, keyed host", async () => {
    expect(await renderableHere(db, paid)).toBe(true);
    expect(s.route).toHaveBeenCalledWith(db, expect.objectContaining({ id: "m-1" }), { boost: false, quality: null, resolution: "2K", referenceImages: 1 });
  });

  it.each([
    ["the model is gone", () => s.model.mockResolvedValue(null)],
    ["the model changed family", () => s.model.mockResolvedValue({ id: "m-1", name: "Something Else", supportsQuality: false, supportsResolution: true })],
    ["no route carries the settings", () => s.route.mockResolvedValue(null)],
    ["the host is not implemented", () => s.route.mockResolvedValue({ provider: "pollinations", providerModel: "flux" })],
    ["the route has no provider model", () => s.route.mockResolvedValue({ provider: "openai", providerModel: null })],
    ["the host has no key here", () => s.keyMissing.mockReturnValue(true)],
    // Round 18: the model takes fewer references now than the order paid for.
    ["the model takes fewer references than were paid", () => s.model.mockResolvedValue({ id: "m-1", name: "GPT Image 2", supportsQuality: false, supportsResolution: true, maxRefs: 0 })],
  ])("is no when %s", async (_label, setUp) => {
    setUp();
    expect(await renderableHere(db, paid)).toBe(false);
  });

  it("is no for an unreadable resolution, before any lookup", async () => {
    expect(await renderableHere(db, { ...paid, resolution: "huge" })).toBe(false);
    expect(s.route).not.toHaveBeenCalled();
  });
});
