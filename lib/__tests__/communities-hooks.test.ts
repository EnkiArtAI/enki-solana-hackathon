import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Communities' reads and writes as the pages get them (hooks/useCommunities), against a stubbed fetch: a refused write
 * is thrown as the route's own sentence with what came with it, the 503 before SQL 54 is "not ready" (every surface says
 * COMMUNITIES_NOT_READY by it), and a write reads Communities anew, the feed too after a prompt's links (Explore's filter
 * and a community's Prompts read it). Review 2026-10-30: this module was mocked away in every test.
 */
const qc = vi.hoisted(() => ({ invalidateQueries: vi.fn(async () => {}) }));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => qc, useQuery: vi.fn(), useInfiniteQuery: vi.fn() }));
vi.mock("@/lib/session-headers", () => ({ viewerHeaders: () => ({ "x-viewer": "v" }) }));

import { CommunityError, isNotReady, useCommunitiesApi } from "@/hooks/useCommunities";
import { CLOSE_MATCHES, COMMUNITIES_NOT_READY, NOT_SAVED } from "@/lib/communities/types";

const answer = (status: number, body: unknown) => vi.fn(async () => ({ ok: status < 400, status, json: async () => body }));
const keys = () => qc.invalidateQueries.mock.calls.map((c) => (c as unknown as [{ queryKey: string[] }])[0].queryKey);

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe("a refused call", () => {
  it("is thrown as the route's sentence, its status and what came with it kept, and reads nothing anew", async () => {
    vi.stubGlobal("fetch", answer(409, { error: CLOSE_MATCHES, closest: [{ handle: "gundam" }] }));
    const e = await useCommunitiesApi().create({ name: "Gundam 2" }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(CommunityError);
    expect([(e as CommunityError).message, (e as CommunityError).status, (e as CommunityError).extra]).toEqual([CLOSE_MATCHES, 409, { closest: [{ handle: "gundam" }] }]);
    expect(qc.invalidateQueries).not.toHaveBeenCalled();
  });

  it("is \"not ready\" as the 503 before SQL 54, and a write's own sentence when the network is gone", async () => {
    vi.stubGlobal("fetch", answer(503, { error: COMMUNITIES_NOT_READY }));
    expect(isNotReady(await useCommunitiesApi().join("gundam").catch((x: unknown) => x))).toBe(true);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
    const e = (await useCommunitiesApi().leave("gundam").catch((x: unknown) => x)) as CommunityError;
    expect([e.message, e.status, isNotReady(e)]).toEqual([NOT_SAVED, 0, false]);
  });
});

describe("a write", () => {
  it("sends its body as JSON with the viewer's headers, and reads Communities anew; a prompt's links the feed too", async () => {
    vi.stubGlobal("fetch", answer(200, { items: [] }));
    await useCommunitiesApi().setLinks({ kind: "prompt", ids: ["p1"], communityIds: ["c1"] });
    expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual(["/api/communities/links", {
      method: "PUT", headers: { "Content-Type": "application/json", "x-viewer": "v" }, body: JSON.stringify({ kind: "prompt", ids: ["p1"], communityIds: ["c1"] }),
    }]);
    expect(keys()).toEqual([["communities"], ["/api/marketplace/prompts"]]);
    qc.invalidateQueries.mockClear();
    await useCommunitiesApi().setLinks({ kind: "image", ids: ["r1"], communityIds: [] });
    expect(keys()).toEqual([["communities"]]);
  });
});
