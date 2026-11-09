import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";

/**
 * A reference still being read, or one whose read failed, has no picture yet
 * (ReferenceStrip hands "" along). An <img src=""> asks the browser for the
 * page itself (Kev, 2026-10-14, the console error), so the tile shows nothing
 * until there is a picture.
 */
describe("a reference tile without a picture", () => {
  it("renders no img at all", () => {
    const tiles = readSource(join(__dirname, "..", "..", "components", "kit", "ReferenceTiles.tsx"));
    expect(tiles).toContain('{it.src && <img src={it.src} alt="" draggable={false} />}');
    expect(tiles.split('{it.src && <img src={it.src}')).toHaveLength(3);
    expect(tiles).not.toMatch(/<img src=\{it\.src\}[^/]*\/>\s*<\/button>/);
  });
});
