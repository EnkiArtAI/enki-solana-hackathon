import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Kev, 2026-11-09: Communities greyed until it is built out; Studio carries a work-in-progress notice (DEC-2026-11-09-02).
describe("not built out yet", () => {
  it("Communities is greyed in the nav and in Create's bar", () => {
    expect(readFileSync("components/enki-shell/EnkiHome.tsx", "utf8")).toContain('{ id: "communities", label: "Communities", icon: "users", soon: true }');
    const side = readFileSync("components/enki-shell/EnkiSidebar.tsx", "utf8");
    expect(side.match(/disabled=\{item\.soon\}/g)).toHaveLength(2);
    expect(readFileSync("components/communities/CommunityLinking.tsx", "utf8")).toContain('note={PRIVATE_RENDERS_LINE} disabled title="Communities are coming soon"');
  });

  it("Studio's overview says it is a work in progress until 14 November 2026", () => {
    expect(readFileSync("components/studio/StudioPanel.tsx", "utf8")).toContain('<p className="st-notice" role="status">Studio is a work in progress and subject to heavy change until 14 November 2026.</p>');
  });
});
