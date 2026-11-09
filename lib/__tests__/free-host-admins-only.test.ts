import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { readSource } from "./_read-source";
import { fakeDb } from "./_fake-supabase";
import { mayUseFreeHost } from "@/lib/generation/free-quota";
import { DbUnreachableError } from "@/lib/db-error";

/**
 * The free host (Pollinations) is the admins' test generator (Kev, 2026-10-27: "pollination ja nur für admins
 * freigeben"). The Image View hides it from everyone else (forViewer); /api/generate-free refuses everyone else too.
 */
const ADMIN = "11111111-1111-4111-8111-111111111111";
const BETA = "22222222-2222-4222-8222-222222222222";
const users = [{ id: ADMIN, role: "admin" }, { id: BETA, role: "beta" }];

describe("who may render on the free host", () => {
  it("an admin, and no one else: not a mod, a member, a trial tester or a signed-out caller", async () => {
    const db = fakeDb({ users: [...users, { id: "m", role: "mod" }, { id: "t", role: "trial" }] });
    expect(await mayUseFreeHost(db.client, ADMIN)).toBe(true);
    for (const id of [BETA, "m", "t", "nobody"]) expect(await mayUseFreeHost(db.client, id)).toBe(false);
    expect(await mayUseFreeHost(db.client, null)).toBe(false);
  });

  it("never answers yes when the account cannot be read", async () => {
    const down = fakeDb({ users }, { users: { message: "fetch failed" } });
    await expect(mayUseFreeHost(down.client, ADMIN)).rejects.toBeInstanceOf(DbUnreachableError);
    const broken = fakeDb({ users }, { users: { message: "permission denied", code: "42501" } });
    await expect(mayUseFreeHost(broken.client, ADMIN)).rejects.toThrow("role lookup failed");
  });
});

describe("/api/generate-free", () => {
  const ROUTE = readSource(join(__dirname, "..", "..", "app", "api", "generate-free", "route.ts"));

  it("refuses a non-admin before the step-up, the prompt check, the daily claim and the provider", () => {
    const gate = ROUTE.indexOf("if (!(await mayUseFreeHost(supabaseForChecks, quotaUserId))) {");
    expect(gate).toBeGreaterThan(ROUTE.indexOf("const quotaUserId = await resolveRecordingUserId(supabaseForChecks, request);"));
    expect(ROUTE.slice(gate)).toMatch(/^if \(!\(await mayUseFreeHost\(supabaseForChecks, quotaUserId\)\)\) \{\s+return NextResponse\.json\(\{ error: `\$\{model\.name\} is for admins only\. Nothing was generated\.` \}, \{ status: 403 \}\);/);
    for (const later of ["await requireActionStepUp(", "await checkPrompt(", "await freeGenerationDecision(", "await generateImageWithPollinations("]) {
      expect(ROUTE.indexOf(later), later).toBeGreaterThan(gate);
    }
  });
});
