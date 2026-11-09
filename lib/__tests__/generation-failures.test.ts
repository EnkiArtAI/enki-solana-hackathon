import { describe, it, expect, vi, beforeEach } from "vitest";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readSource } from "@/lib/__tests__/_read-source";

/**
 * Failed generations were recorded nowhere: the admin could not see what broke
 * for whom (Kev, 2026-10-03). recordGenerationFailure is the other half of
 * recordGeneration, called at every failure point after a request was
 * accepted.
 */

let inserted: Record<string, unknown>[];
let failInsert = false;
let rejectInsert = false;
const fake = {
  from: () => ({
    insert: async (row: Record<string, unknown>) => {
      if (failInsert) throw new Error("db down");
      if (rejectInsert) return { error: { message: "relation does not exist" } };
      inserted.push(row);
      return { error: null };
    },
  }),
} as unknown as SupabaseClient;

vi.mock("@/lib/crypto", () => ({ encryptString: () => ({ encrypted: "ct", iv: "iv", authTag: "tag", kid: "k1" }) }));
vi.mock("@/lib/ip-hash", () => ({ getClientIp: () => "1.2.3.4", hashIp: (ip: string | null) => (ip ? `h:${ip}` : null) }));
vi.mock("@/lib/session-user", () => ({ resolveSessionUserId: async () => "user-1" }));
vi.mock("@/lib/generation/derivative-store", () => ({ storeGeneratedImage: async () => null }));

import { recordGenerationFailure } from "@/lib/generation/record";

const base = {
  request: { headers: new Headers({ "X-Session-Token": "t" }) },
  surface: "generate-image" as const,
  modelId: "m1", resolution: "2K", quality: "high", boost: false, aspectRatio: "16:9", referenceImageCount: 2,
  prompt: "a secret-free own prompt", error: "provider said no",
};

beforeEach(() => {
  inserted = [];
  failInsert = false;
  rejectInsert = false;
});

describe("recording a failed generation", () => {
  it("says so in the log when the database refuses the row", async () => {
    rejectInsert = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await recordGenerationFailure(fake, base);
    expect(warn).toHaveBeenCalledWith("[generation-failures] not recorded:", "relation does not exist");
    warn.mockRestore();
  });

  it("keeps who, where and with which settings", async () => {
    await recordGenerationFailure(fake, base);
    expect(inserted[0]).toMatchObject({
      user_id: "user-1", ip_hash: "h:1.2.3.4", surface: "generate-image", model_id: "m1", resolution: "2K",
      quality: "high", boost: false, aspect_ratio: "16:9", reference_image_count: 2, error: "provider said no",
    });
  });

  it("stores what a settled payment carried, exact, and names no amount for an unpaid failure (Kev, 2026-10-18)", async () => {
    await recordGenerationFailure(fake, { ...base, surface: "x402-generate", txSignature: "sig", amountPaidMicro: 7_560 });
    expect(inserted[0]).toMatchObject({ tx_signature: "sig", amount_paid_micro: 7_560 });
    await recordGenerationFailure(fake, base);
    expect(inserted[1]).not.toHaveProperty("amount_paid_micro");
  });

  it("stores the prompt only encrypted", async () => {
    await recordGenerationFailure(fake, base);
    expect(JSON.stringify(inserted[0])).not.toContain("secret-free own prompt");
    expect(inserted[0].prompt_ct).toBe("ct");
  });

  it("cuts a long error", async () => {
    await recordGenerationFailure(fake, { ...base, error: "x".repeat(5000) });
    await recordGenerationFailure(fake, { ...base, prompt: null });
    // An artist's draft: the failure is recorded without any text.
    expect(inserted.at(-1)).not.toHaveProperty("prompt_ct");
    inserted.pop();
    expect(String(inserted[0].error)).toHaveLength(1000);
  });

  it("never throws when the database fails", async () => {
    failInsert = true;
    await expect(recordGenerationFailure(fake, base)).resolves.toBeUndefined();
  });
});

describe("every failure point records it", () => {
  const ROOT = join(__dirname, "..", "..");
  const HUMAN = readSource(join(ROOT, "app", "api", "generate-image", "route.ts"));
  const FREE = readSource(join(ROOT, "app", "api", "generate-free", "route.ts"));
  const AGENT = readSource(join(ROOT, "app", "api", "x402", "generate", "route.ts"));
  const count = (src: string) => (src.match(/after\(recordGenerationFailure\(/g) ?? []).length;

  it("the human rail at the provider failure, the empty result, the unstored image, the image check, the hidden text read off the render, the withheld capture, the refused record, the spend breaker's refusal and the catch-all", () => {
    expect(count(HUMAN)).toBe(9);
    expect(HUMAN).toContain('if (failCtx) after(recordGenerationFailure(getSupabaseServerClientSafe(), { ...failCtx, error: "image check: hidden text" }));');
    // A capture whose outcome is unknown keeps its signature: the sweep settles it from the chain (DEC-88).
    expect(HUMAN).toMatch(/error: `capture \$\{cap\.kind\}, image withheld`, intentId: unit, \.\.\.\(cap\.kind === "unknown" \? \{ txSignature: cap\.signature \} : \{\}\),/);
    // The refused record names its step (devnet 2026-10-13: a provider CHECK refused every WaveSpeed/OpenAI row silently).
    expect(HUMAN).toMatch(/const reason = `record: \$\{e\.reason \?\? "unknown"\}`;/);
  });

  it("the free generator at the provider failure, the image check and the catch-all", () => {
    expect(count(FREE)).toBe(3);
  });

  it("the agent rail when a paid generation fails, when its image cannot be stored, is held back by the image check or spells out the hidden text, and when its payment's confirmation times out, with the signature", () => {
    expect(count(AGENT)).toBe(5);
    expect(AGENT).toContain('error: "image check: hidden text", txSignature: signature, amountPaidMicro: reqs.amountMicro,');
    // Every paid failure keeps the exact amount a refund returns (Kev, 2026-10-18: "store defo exact usdc amount").
    expect(AGENT.split("txSignature: signature, amountPaidMicro: reqs.amountMicro,").length - 1).toBe(6);
    expect(AGENT.split("txSignature: signature").length - 1).toBe(6);
    expect(AGENT).toMatch(/error: "image could not be stored", txSignature: signature,/);
    // A provider's own words only as their class when a marketplace prompt's text rode along (ENC review, 2026-10-27).
    expect(AGENT).toMatch(/error: providerFailure\(result\.error \|\| "generation failed", Boolean\(input\.promptId\)\), txSignature: signature,/);
    expect(HUMAN).toContain('error: providerFailure(geminiResult.error || "generation failed", artistText) }));');
    expect(HUMAN).toContain("const message = providerFailure(e instanceof Error ? e.message : String(e), artistText);");
    expect(HUMAN).toContain("    artistText = fromArtist || authoring;");
    expect(AGENT).toMatch(/error: `image check: \$\{seen\.verdict\}`, txSignature: signature,/);
    expect(AGENT).toMatch(/if \(settled\.pending\) \{\n(\s+\/\/[^\n]*\n)*\s+after\(recordGenerationFailure\([\s\S]{0,400}error: "Payment outcome unknown", txSignature: signature,/);
  });

  it("never stores an artist's text with a failure", () => {
    // sent is the request's values (round 18, 2026-10-20): the buyer's, never the artist's text.
    expect(HUMAN).toMatch(/prompt: fromArtist \? JSON\.stringify\(sent\) : authoring \? null : prompt,/);
    expect(HUMAN).toMatch(/const sent = fromArtist \? textValues\(body\.variableValues\) : \{ prompt \};/);
    // An artist's draft from an editor is the artist's text too.
    expect(FREE).toMatch(/aspectRatio: body\.aspectRatio \|\| "1:1", referenceImageCount: 0, prompt: authoring \? null : prompt,/);
    expect(AGENT).toMatch(/prompt: input\.promptId \? JSON\.stringify\(sent\) : promptText,/);
    expect(AGENT).toMatch(/const sent = input\.promptId \? textValues\(input\.variableValues\) : \{ prompt: promptText \};/);
  });
});
