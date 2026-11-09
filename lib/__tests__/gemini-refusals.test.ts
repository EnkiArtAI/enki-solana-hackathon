import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Gemini's answers that hold no image (round 6, 2026-10-20): a refusal of the request's content reads as content (the
 * buyer's, never the breaker's); an answer without an image reads as a request (not an outage). No call goes out.
 */
const s = vi.hoisted(() => ({ answer: null as unknown, thrown: null as unknown }));
vi.mock("@google/genai", () => ({
  GoogleGenAI: class { models = { generateContent: async () => { if (s.thrown) throw s.thrown; return s.answer; } }; },
  Modality: { IMAGE: "IMAGE", TEXT: "TEXT" },
}));

import { generateImagesWithGemini } from "@/backend/services/gemini-image-generation";
import { classifyFailure } from "@/lib/generation/provider-health";

const request = { prompt: "a blue bird", modelVersion: "gemini-3-pro-image-preview", numImages: 1 } as const;

beforeEach(() => { vi.stubEnv("GOOGLE_GEMINI_API_KEY", "test-key-not-a-real-one"); s.thrown = null; });

describe("an answer Gemini gave without an image", () => {
  it.each(["SAFETY", "IMAGE_SAFETY", "PROHIBITED_CONTENT", "IMAGE_PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION", "IMAGE_RECITATION"])(
    "reads a %s refusal as the request's content", async (finishReason) => {
      s.answer = { candidates: [{ finishReason, content: { parts: [] } }] };
      const out = await generateImagesWithGemini(request as never);
      expect(out.success).toBe(false);
      expect(classifyFailure(out.error ?? "").kind).toBe("content");
    });

  it.each(["NO_IMAGE", "STOP", "LANGUAGE", "MAX_TOKENS"])("reads an answer the request caused (%s) as a request, never an outage", async (finishReason) => {
    s.answer = { candidates: [{ finishReason, content: { parts: [{ text: "Here is a description instead." }] } }] };
    const out = await generateImagesWithGemini(request as never);
    expect(out.success).toBe(false);
    expect(classifyFailure(out.error ?? "").kind).toBe("request");
  });
});

describe("Gemini's own trouble (round 7, 2026-10-20)", () => {
  it.each(["OTHER", "IMAGE_OTHER", "UNEXPECTED_TOOL_CALL", undefined])("still reaches the breaker for an unexplained stop (%s)", async (finishReason) => {
    s.answer = { candidates: [{ finishReason, content: { parts: [] } }] };
    const out = await generateImagesWithGemini(request as never);
    expect(classifyFailure(out.error ?? "").kind).toBe("infrastructure");
  });

  it("reads a 403 key restriction as the account's, never the buyer's content", async () => {
    s.thrown = Object.assign(new Error("Requests to this API generativelanguage.googleapis.com are blocked."), { status: 403 });
    const out = await generateImagesWithGemini(request as never);
    expect(classifyFailure(out.error ?? "")).toEqual({ kind: "infrastructure", scope: "provider" });
  });
});
