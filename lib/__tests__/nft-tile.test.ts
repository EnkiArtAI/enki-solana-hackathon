import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import NftTile from "@/components/enki/NftTile";

/** What a tile draws by what the hook holds. The picture is a marker string, no real image; the hook's own reads are driven in a browser (nft-unread.mjs). */
const nft = { id: "n1", name: "Madlad", image: "https://x.test/a.png", thumb: "https://x.test/t.png", proof: "p" } as never;
const tile = (check?: Record<string, unknown>, unread = false) => renderToString(createElement(NftTile, {
  nft, on: false, onUse: () => {}, className: "c", picture: createElement("img", { src: "MARKER" }),
  checks: { checks: check ? { n1: check } : {}, busy: new Set(), note: null, setNote: () => {}, failed: {}, unread, ask: async () => undefined } as never,
}));
const RED = { verdict: "refused", why: "This picture can't be used on Enki.", left: 5, opensAt: null, picture: true };
const GREEN = { verdict: "allowed", why: null, left: 0, opensAt: null, picture: true };

describe("NftTile", () => {
  it("a verdict read: as it says", () => {
    expect(tile(RED)).toContain("MARKER");
    expect(tile(GREEN)).toContain("MARKER");
    expect(tile({ ...RED, picture: false })).not.toContain("MARKER");
  });
  it("no verdict and none being read wrong: a grey tile draws", () => {
    expect(tile()).toContain("MARKER");
  });
  it("no verdict because the verdicts could not be read: no picture, the plain placeholder", () => {
    const html = tile(undefined, true);
    expect(html).not.toContain("MARKER");
    expect(html).toContain("nft-tile-blank");
  });
  it("a verdict beats the failed read", () => {
    expect(tile(GREEN, true)).toContain("MARKER");
    expect(tile({ ...RED, picture: false }, true)).not.toContain("MARKER");
  });
});
