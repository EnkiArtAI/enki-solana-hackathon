import { describe, it, expect, beforeEach } from "vitest";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readSource } from "@/lib/__tests__/_read-source";

/**
 * REC-3 (narrowed scope): the x402 agent route must never label a stored
 * image with the literal pseudo-user "x402-agent", must measure the MIME
 * type it stores from the actual bytes rather than assuming PNG, and must
 * record the generation through the same pipeline REC-1 uses when (and only
 * when) the paying wallet is already linked to a real Enki account — it has
 * no account to record under otherwise (generations.user_id is a NOT NULL
 * FK; see docs/specs/REC-3.md for why that is a decision this PR does not
 * make on its own).
 *
 * The settle-before-generate order is deliberately UNCHANGED by this PR
 * (docs/specs/REC-3.md, the STOP section) — not tested here as a "should be
 * reordered" assertion, because it should not be, yet, by this PR.
 */

const ROOT = join(__dirname, "..", "..");
const AGENT = readSource(join(ROOT, "app", "api", "x402", "generate", "route.ts"));

describe("the x402 route never uses the pseudo-user string", () => {
  it("does not store under the literal 'x402-agent' identity", () => {
    expect(AGENT).not.toMatch(/storeGeneratedImage\([^)]*["']x402-agent["']/);
    expect(AGENT).not.toContain('"x402-agent"');
  });

  it("uses the verified payer's wallet as the storage namespace", () => {
    const payer = AGENT.indexOf("const payerWallet = verified.payer.toBase58();");
    const store = AGENT.indexOf("storeGeneratedImage(dataUrl, payerWallet, storeDeadline(startedAt))");
    expect(payer).toBeGreaterThan(-1);
    expect(store).toBeGreaterThan(payer);
  });
});

describe("the x402 route measures MIME from bytes", () => {
  it("does not hard-code image/png when building the stored data URL", () => {
    expect(AGENT).not.toMatch(/data:image\/png;base64,\$\{buffer\.toString\("base64"\)\}/);
  });

  it("reads the format from the actual bytes before storing", () => {
    expect(AGENT).toMatch(/readImageDimensions\(buffer\)/);
  });
});

describe("the x402 route records through the shared pipeline exactly once, gated on a linked wallet", () => {
  it("calls recordGeneration exactly once, under the account payerAccount answers, asked again on a blip (ENG-07)", () => {
    expect((AGENT.match(/recordGeneration\(supabase,/g) ?? []).length).toBe(1);
    const start = AGENT.search(/const recording = \(async \(\) => \{\s+const recUserId = await payerAccount\(supabase, payerWallet\);/);
    const guard = AGENT.indexOf("if (!recUserId) {\n      await recordGenerationFailure(supabase, {", start);
    const call = AGENT.indexOf("return recordGeneration(supabase, {", guard);
    expect(start).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(start);
    expect(call).toBeGreaterThan(guard);
    // Lost for good: on record with the signature, for support.
    expect(AGENT.slice(guard, call)).toContain(`error: "delivered and paid, but the paying wallet's account could not be found or made: not recorded", txSignature: signature,`);
  });

  it("records before the answer, names the gallery row in it, and never waits long or withholds the image (REC-1)", () => {
    const wait = AGENT.indexOf("})();\n  after(recording);\n  const imageId = await imageIdWithin(recording);");
    const answer = AGENT.indexOf("imageUrl: stored.imageUrl,\n      ...(imageId ? { imageId } : {}),");
    expect(wait).toBeGreaterThan(-1);
    expect(answer).toBeGreaterThan(wait);
  });

  it("never puts a data URL in the gallery row (REC-1)", () => {
    expect(AGENT).toContain('const durable = !recordedUrl.startsWith("data:");');
    expect(AGENT).toContain("...(durable ? { imageUrl: recordedUrl, previewUrl: recordedPreview, thumbnailUrl: recordedThumb } : {}),");
    expect(AGENT).not.toMatch(/\n\s+imageUrl: recordedUrl,\n/);
  });

  it("carries the settlement signature and chain key as the payment link, never a payment_intent_id", () => {
    expect(AGENT).toMatch(/transactionHash:\s*signature/);
    expect(AGENT).toMatch(/chainKey/);
    expect(AGENT).toMatch(/paymentIntentId:\s*null/);
    expect(AGENT).toMatch(/rail:\s*"x402"/);
  });

  it("still calls recordGenerationFailure exactly 5 times: the 4 from before REC-3 and the hidden text read off a render", () => {
    // Pinned already by generation-failures.test.ts; re-asserted here so a
    // regression in THIS file's own suite catches it too, not just there.
    const count = (AGENT.match(/after\(recordGenerationFailure\(/g) ?? []).length;
    expect(count).toBe(5);
  });
});
