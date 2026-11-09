/**
 * The longest prompt each host takes, where its adapter or its documentation
 * says so (round 12, 2026-10-20). A paid order is refused before its claim
 * when the prompt is longer, instead of a host refusing it after, voided as
 * Enki's. Gemini: the adapter's own check. OpenAI: "The maximum length is
 * 32000 characters" (openai-node src/resources/images.ts, on the prompt of
 * the generate and edit requests). WaveSpeed documents none.
 */
import { GEMINI_PROMPT_MAX } from "@/backend/services/gemini-image-generation";

export const OPENAI_PROMPT_MAX = 32_000;

export const PROMPT_MAX: Readonly<Record<string, number>> = { gemini: GEMINI_PROMPT_MAX, openai: OPENAI_PROMPT_MAX };
