import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SEAL_PALETTES, sealOf } from "../seal";

/** Everyone's picture on Enki is their seal (Kev, 2026-10-26: "avatar A, i dont want no profile images on enki"). */
const HANDLES = ["neon_palette", "kiri", "marvel", "enki_judge", "rainman", "nyx", "studio_kev", "ana.ruiz", "tomo", "lea_k", "b0ris", "hello_world"];

describe("a seal", () => {
  it("is the same for a handle every time, in any case or with stray spaces", () => {
    expect(sealOf("kiri")).toEqual(sealOf("kiri"));
    expect(sealOf(" Kiri ")).toEqual(sealOf("kiri"));
  });

  it("differs from person to person: twelve handles, at least eight different seals and four palettes", () => {
    const seals = HANDLES.map((h) => JSON.stringify(sealOf(h)));
    expect(new Set(seals).size).toBe(12);
    expect(new Set(HANDLES.map((h) => JSON.stringify(sealOf(h).parts))).size).toBeGreaterThanOrEqual(8);
    expect(new Set(HANDLES.map((h) => sealOf(h).bg)).size).toBeGreaterThanOrEqual(4);
  });

  it("is drawn in one of Enki's six palettes, the initial in its ink", () => {
    for (const h of HANDLES) {
      const s = sealOf(h);
      const palette = SEAL_PALETTES.find(([bg]) => bg === s.bg);
      expect(palette, h).toBeDefined();
      expect(s.fg).toBe(palette![1]);
      for (const p of s.parts) expect([palette![1], palette![2]], h).toContain(p.kind === "circle" ? p.fill : p.kind === "line" ? p.stroke : p.stroke ?? p.fill);
    }
  });

  it("carries two motifs, the horizon behind the waves behind the sun", () => {
    const kinds = (h: string) => sealOf(h).parts.map((p) => (p.kind === "circle" ? "sun" : p.kind === "line" ? "star" : "d" in p && p.d.includes(" A ") ? "horizon" : "d" in p && p.d.includes(" Q ") ? "waves" : "wedges"));
    for (const h of HANDLES) {
      const order = [...new Set(kinds(h))];
      expect(order, h).toHaveLength(2);
      const depth = ["horizon", "waves", "sun", "wedges", "star"];
      expect(depth.indexOf(order[0]), h).toBeLessThan(depth.indexOf(order[1]));
    }
  });

  it("shows the handle's first letter, E when it has none", () => {
    expect(sealOf("neon_palette").initial).toBe("N");
    expect(sealOf("_42x").initial).toBe("X");
    expect(sealOf("").initial).toBe("E");
    expect(sealOf("0x42").initial).toBe("X");
  });
});

describe("where a person shows", () => {
  const read = (...p: string[]) => readFileSync(join(__dirname, "..", "..", "..", "..", ...p), "utf8");
  it("has no picture to upload: Edit profile shows the seal the username draws", () => {
    const profile = read("components", "profile", "ProfileView.tsx");
    expect(profile).toContain('<Seal handle={dHandle.trim() || me.handle || ""} />');
    expect(profile).not.toContain('fd.append("avatar"');
    expect(profile).not.toMatch(/Change picture|Zoom picture|avatarImg/);
  });

  // The profile shows its picture when it has one, an imported creator's X picture (Kev, 2026-10-31; profile-avatar.test.ts).
  it("every other surface draws their seal, none a picture", () => {
    for (const [file, use] of [
      [["components", "enki-shell", "MessagesPanel.tsx"], '<Seal handle={peer.handle || peer.name || ""} />'],
      [["components", "enki-shell", "EnkiSidebar.tsx"], '<span className="ek-avatar"><Seal handle={account.handle} /></span>'],
      [["components", "enki", "EnkiFeedPage.tsx"], '<span className="feed-creator-initial"><Seal handle={c.handle} /></span>'],
      [["app", "admin", "page.tsx"], '<Seal handle={profile?.handle || handle || ""} />'],
      [["components", "image-view", "ReviewsPanel.tsx"], '<span className="iv-av" aria-hidden><Seal handle={row.handle} /></span>'],
      [["app", "leaderboard", "page.tsx"], "<Seal handle={r.handle} />"],
    ] as const) {
      const src = read(...file);
      expect(src, file.join("/")).toContain(use);
      expect(src, file.join("/")).not.toMatch(/<img src=\{[^}]*avatarUrl/);
    }
  });
});
