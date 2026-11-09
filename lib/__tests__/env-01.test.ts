import { describe, it, expect, afterEach, vi } from "vitest";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { readSource } from "@/lib/__tests__/_read-source";
import { stubRequiredEnv } from "@/lib/__tests__/_required-env";
import { providerKeyMissing, PROVIDER_NAME } from "@/lib/generation/provider-health";

/**
 * ENV-01: every missing setting answers with one clear sentence, never an
 * empty 500, and names what is missing, never the variable. Production has
 * every key (nothing is missing live); this is for an environment that does not.
 */

afterEach(() => vi.unstubAllEnvs());
const src = (...p: string[]) => readSource(join(__dirname, "..", "..", ...p));

describe("the proxy, for every API call", () => {
  const visit = async (path: string) => {
    const { proxy } = await import("../../proxy");
    return proxy(new NextRequest(`http://enki.test${path}`));
  };

  it("lets an API call through when the required settings are there", async () => {
    stubRequiredEnv();
    vi.stubEnv("TEAM_ACCESS_CODE", "");
    expect((await visit("/api/prompts")).headers.get("x-middleware-next")).toBe("1");
  });

  it.each([
    ["SUPABASE_URL", "The database"],
    ["SUPABASE_SERVICE_ROLE_KEY", "The database"],
    ["AUTH_PEPPER", "Sign-in"],
    ["FIELD_ENCRYPTION_KEY_B64", "Encryption"],
  ])("answers 503 with a sentence when %s is missing or blank, gate or no gate", async (key, what) => {
    stubRequiredEnv();
    vi.stubEnv(key, "  ");
    for (const gate of ["", "team-code"]) {
      vi.stubEnv("TEAM_ACCESS_CODE", gate);
      const res = await visit("/api/generate-free");
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe(`${what} is not configured on this environment`);
      expect(body.error).not.toContain(key);
    }
  });

  it("lets the crons through, so the database alarm still mails when the database settings are missing", async () => {
    stubRequiredEnv();
    vi.stubEnv("SUPABASE_URL", "");
    vi.stubEnv("FIELD_ENCRYPTION_KEY_B64", "");
    vi.stubEnv("TEAM_ACCESS_CODE", "team-code");
    for (const cron of ["/api/cron/db-health", "/api/cron/sweep-payments"]) {
      expect((await visit(cron)).headers.get("x-middleware-next")).toBe("1");
    }
  });

  it("leaves pages alone: only /api answers the sentence", async () => {
    stubRequiredEnv();
    vi.stubEnv("SUPABASE_URL", "");
    vi.stubEnv("TEAM_ACCESS_CODE", "");
    expect((await visit("/home")).headers.get("x-middleware-next")).toBe("1");
  });
});

describe("the paid hosts", () => {
  it("knows a host has no key the way the services read it", () => {
    vi.stubEnv("GOOGLE_GEMINI_API_KEY", "");
    vi.stubEnv("GEMINI_API_KEY", "");
    expect(providerKeyMissing("gemini")).toBe(true);
    vi.stubEnv("GEMINI_API_KEY", "g");
    expect(providerKeyMissing("gemini")).toBe(false);
    // OPENAI_API_KEYS is read as the first of a comma list.
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEYS", " ,second");
    expect(providerKeyMissing("openai")).toBe(true);
    vi.stubEnv("OPENAI_API_KEYS", "first,second");
    expect(providerKeyMissing("openai")).toBe(false);
    vi.stubEnv("WAVESPEED_API_KEY", " ");
    expect(providerKeyMissing("wavespeed")).toBe(true);
    // The free host needs none.
    expect(providerKeyMissing("pollinations")).toBe(false);
    expect(PROVIDER_NAME).toEqual({ gemini: "Google Gemini", openai: "OpenAI", wavespeed: "WaveSpeed" });
  });

  it("the agent rail says it before any money moves", () => {
    const agent = src("app", "api", "x402", "generate", "route.ts");
    const said = agent.indexOf("if (providerKeyMissing(route.provider)) {");
    expect(said).toBeGreaterThan(-1);
    expect(agent).toContain('return NextResponse.json({ error: `${PROVIDER_NAME[route.provider] ?? "This host"} is not configured on this environment — nothing was charged` }, { status: 503 });');
    expect(said).toBeLessThan(agent.indexOf("const settled = await submitAndConfirm("));
  });

  it("routing passes over a keyless host", () => {
    expect(src("lib", "generation", "models.ts")).toContain("const usable = candidates.filter((c) => !providerKeyMissing(c.providerKey));");
  });
});

describe("the other places", () => {
  it("the wallet sign-in says a missing signing key instead of an empty 500", () => {
    const jwt = src("app", "api", "auth", "wallet", "jwt", "route.ts");
    expect(jwt).toMatch(/try \{\n\s+jwt = await mintWalletJwt\(\{ id: userId, email: cred\?\.email, username: user\?\.handle \?\? null \}\);\n\s+\} catch \{\n\s+return NextResponse\.json\(\{ error: "Wallet sign-in is not configured on this environment" \}, \{ status: 503 \}\);/);
  });

  it("the access code says it is not configured, as a 503", async () => {
    vi.stubEnv("TEAM_ACCESS_CODE", "");
    const { POST } = await import("../../app/api/gate/route");
    const res = await POST(new NextRequest("http://enki.test/api/gate", { method: "POST", body: JSON.stringify({ code: "x" }) }));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe("The access code is not configured on this environment");
  });
});
