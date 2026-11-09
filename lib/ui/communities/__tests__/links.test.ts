import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OPEN_COMMUNITY_EVENT, cardLabel, communityFilterLink, communityFilterOf, communityHref, compact, countsLine, handleParam, openCommunity,
} from "../links";

/**
 * Where a community is in the address and how a card names it (Kev, 2026-10-30: "wo sehe ich denn die communities ...
 * oder wo kann ich nach denen suchen"; "i want at one point to filter for a community").
 */
afterEach(() => vi.unstubAllGlobals());

describe("Explore's Community filter in the address", () => {
  it("is ?community=<handle>, lower-cased, only in a handle's shape", () => {
    const of = (q: string) => communityFilterOf(new URLSearchParams(q));
    expect([of("community=apu"), of("community=Gundam_Wing"), of("q=x")]).toEqual(["apu", "gundam_wing", null]);
    for (const bad of ["", "_a", "a__b", "a b", "../x", "a_"]) expect(of(`community=${encodeURIComponent(bad)}`)).toBeNull();
    expect([handleParam(" Pepe "), handleParam(null), handleParam(undefined)]).toEqual(["pepe", null, null]);
  });

  it("is set or dropped, every other part of the address kept", () => {
    expect(communityFilterLink("/home?q=cats&media=images#x", "apu")).toBe("/home?q=cats&media=images&community=apu#x");
    expect(communityFilterLink("/home?community=apu&q=cats", "pepe")).toBe("/home?community=pepe&q=cats");
    expect(communityFilterLink("/home?community=apu&q=cats", null)).toBe("/home?q=cats");
  });
});

describe("a community's door and its opening", () => {
  it("is /c/<handle>", () => {
    expect(communityHref("gundam_wing")).toBe("/c/gundam_wing");
  });

  it("asks the shell first (enki:open-community, cancelable); without a listener the door opens", () => {
    const sent: Array<{ type: string; detail: unknown; cancelable: boolean }> = [];
    let taken = true;
    vi.stubGlobal("CustomEvent", class { constructor(readonly type: string, readonly o: { detail: unknown; cancelable: boolean }) {} });
    vi.stubGlobal("window", {
      dispatchEvent: (e: { type: string; o: { detail: unknown; cancelable: boolean } }) => { sent.push({ type: e.type, ...e.o }); return !taken; },
      location: { assign: vi.fn() },
    });
    const push = vi.fn();
    openCommunity("apu", { push });
    expect(sent).toEqual([{ type: OPEN_COMMUNITY_EVENT, detail: { handle: "apu" }, cancelable: true }]);
    expect(push).not.toHaveBeenCalled();
    taken = false;
    openCommunity("apu", { push });
    expect(push).toHaveBeenCalledWith("/c/apu");
  });
});

describe("a card's words", () => {
  it("counts compactly: 340, 1.2k, 3.4m", () => {
    expect([compact(0), compact(340), compact(1204), compact(12_400), compact(3_400_000)]).toEqual(["0", "340", "1.2k", "12.4k", "3.4m"]);
  });

  it("says members and works, one or many", () => {
    expect(countsLine({ members: 1204, works: 340 })).toBe("1.2k members · 340 works");
    expect(countsLine({ members: 1, works: 1 })).toBe("1 member · 1 work");
  });

  it("names the card whole for a screen reader", () => {
    expect(cardLabel({ handle: "gundam", name: "Gundam", members: 1204, works: 340 })).toBe("c/gundam, Gundam, 1,204 members, 340 works");
    expect(cardLabel({ handle: "x1", name: "X", members: 1, works: 0 })).toBe("c/x1, X, 1 member, 0 works");
  });
});
