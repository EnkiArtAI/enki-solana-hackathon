import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";

/**
 * A profile shows its picture, else the seal Enki gives everyone without one (Kev, 2026-10-31: "wenn du ... noch kein
 * profilbild reingepackt hast, wird dir eins von enki zugeteilt"), and the Prompt Hunter takes an imported creator's X
 * picture once, as their account is made ("nur 1x beim ersten import"). The picture itself: creator-profile.test.ts.
 */
const ROOT = join(__dirname, "..", "..");
const VIEW = readSource(join(ROOT, "components", "profile", "ProfileView.tsx"));
const RUN = readSource(join(ROOT, "lib", "hunter", "creator-run.ts"));

describe("a profile's picture", () => {
  it("shows the picture, and the seal when there is none or it no longer loads", () => {
    expect(VIEW).toContain("{me && (me.avatarUrl && !avatarFailed");
    expect(VIEW).toContain("? <img src={me.avatarUrl} alt=\"\" onError={() => setAvatarFailed(true)}");
    expect(VIEW).toContain(": <Seal handle={me.handle ?? \"\"} />)}");
  });

  it("is X's for an imported creator, looked up as the Play makes their account", () => {
    expect(RUN).toContain("profile: (x) => ensureCreatorProfile(supabase, x, (u) => xAvatar(u, asEnki)),");
  });
});
