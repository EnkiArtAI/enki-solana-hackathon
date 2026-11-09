import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { readSource } from "@/lib/__tests__/_read-source";

/**
 * Where the prompt check sits: on every generation route, before moderation
 * and before any money moves; an artist's prompt is judged on the buyer's
 * values only.
 */

const ROOT = join(__dirname, "..", "..", "..");
const HUMAN = readSource(join(ROOT, "app", "api", "generate-image", "route.ts"));
const FREE = readSource(join(ROOT, "app", "api", "generate-free", "route.ts"));
const AGENT = readSource(join(ROOT, "app", "api", "x402", "generate", "route.ts"));

const SILENT = /const silent = ((blocked|warnedOut) \|\| )?check\.verdict !== "clear";/;
const WARNED = /return NextResponse\.json\(\{ error: warningMessage\(check\.verdict, outcome\) \}, \{ status: 422 \}\);/;

describe("a real generation failure", () => {
  it("answers exactly like a caught request", () => {
    for (const src of [HUMAN, FREE]) {
      expect(src).not.toMatch(/NextResponse\.json\(\s*\{ error: (geminiResult|result)\.error/);
      expect(src).not.toMatch(/return NextResponse\.json\(\{ error: message \}, \{ status: 500 \}\);/);
    }
    // The fourth: a rendered image whose bytes hold no readable still image (round 10, 2026-10-20); the fifth: a render
    // that spells out the artist's hidden text (ENC review, 2026-10-27).
    expect(HUMAN.split("return NextResponse.json(SILENT_FAILURE, { status: 500 });").length - 1).toBe(5);
    expect(FREE.split("return NextResponse.json(SILENT_FAILURE, { status: 500 });").length - 1).toBe(3);
  });
});

describe("the human rail", () => {
  const check = HUMAN.indexOf("checkPrompt(checked, { hidden: fromArtist, signal: request.signal })");

  it("records an artist's prompt by its id and the buyer's values, never its text", () => {
    expect(HUMAN).toMatch(/const about = fromArtist \? \{ promptId: String\(paid\.prompt_id\) \} : authoring \? \{ withheld: prompt, draft: true \} : \{\};/);
    expect(HUMAN).toMatch(/after\(recordModerationEvent\(verdict, \{ surface: "generate-image", request, prompt: fromArtist \? JSON\.stringify\(sent\) : authoring \? "" : prompt, \.\.\.about \}\)\);/);
    expect(HUMAN).toMatch(/text: authoring \? "" : JSON\.stringify\(sent\), confidence: check\.confidence, \.\.\.about,/);
  });

  it("counts a child-safety hit on a marketplace prompt on the requester's ladder", () => {
    // Kev, 2026-10-03: whoever keeps at it is banned, a buyer of an artist's prompt too.
    // The warning is the hit's one record: one pending case, which its overturn closes.
    const decide = HUMAN.indexOf("const minors = fromArtist && !verdict.allowed ? childSafetyScore(verdict) : null;");
    const record = HUMAN.lastIndexOf('after(recordModerationEvent(verdict, { surface: "generate-image"');
    expect(decide).toBeGreaterThan(-1);
    const human = HUMAN.slice(decide, record);
    // Only a hit at the line: any other block must not become a child-safety warning. Judged again with the buyer's
    // words neutral first: a hit the artist's text makes alone pauses the prompt and warns no buyer (DEC-474).
    expect(human).toMatch(/\n\s+if \(minors !== null\) \{\n\s+const again = await moderate\(\{ prompt: neutralFill\(hiddenTemplate, body\.variableValues, artistVariables\)/);
    expect(human).toMatch(/if \(!again\.allowed && !\(await buyerIsCreator\(\)\)\) \{\n\s+after\(recordModerationEvent\(verdict, \{ surface: "generate-image", request, prompt: JSON\.stringify\(sent\), \.\.\.about \}\)\);\n\s+after\(refusePrompt\(getSupabaseServerClient\(\), \{ promptId: String\(paid\.prompt_id\), cause: "moderation", detail: "minor_sexual", buyerUserId: recordingUserId \}\)\);\n\s+return refuseOurs\(/);
    // A re-judge that could not run warns no one and still leaves the hit on file (review wf_794afa1b-83d).
    expect(human).toMatch(/if \(again\.allowed && again\.tier2Degraded\) \{\n\s+after\(recordModerationEvent\(verdict, \{ surface: "generate-image", request, prompt: JSON\.stringify\(sent\), \.\.\.about \}\)\);\n\s+return refuseOurs\(NextResponse\.json\(\{ error: CLIENT_BLOCK_MESSAGE \}, \{ status: 422 \}\)\);\n\s+\}\n\s+const outcome = await recordWarning\(/);
    expect(human).toMatch(/category: "minor_sexual", text: JSON\.stringify\(sent\), confidence: minors, scores: verdict\.scores, \.\.\.about,/);
    expect(human).toMatch(/return NextResponse\.json\(\{ error: warningMessage\("minor_sexual", outcome\) \}, \{ status: 422 \}\);/);
    // The agent rail counts every hit, its own prompts' too: it has no account to ban for good.
    const agentDecide = AGENT.indexOf("const minors = !verdict.allowed ? childSafetyScore(verdict) : null;");
    expect(agentDecide).toBeGreaterThan(-1);
    const agent = AGENT.slice(agentDecide, AGENT.indexOf("after(recordModerationEvent(verdict, {", agentDecide));
    expect(agent).toMatch(/\n\s+if \(minors !== null\) \{\n\s+await recordWarning\(supabase, \{/);
    expect(agent).toMatch(/category: "minor_sexual", text: JSON\.stringify\(sent\), confidence: minors, scores: verdict\.scores,\n\s+\.\.\.\(input\.promptId \? \{ promptId: input\.promptId \} : \{\}\),/);
    expect(agent).toMatch(/return NextResponse\.json\(\{ error: addressWarningMessage\("minor_sexual"\) \}, \{ status: 422 \}\);/);
    // The agent rail never promises an account suspension it cannot give.
    expect(AGENT).not.toMatch(/warningMessage\(/);
  });

  it("withholds an artist's draft from an editor in every record", () => {
    // Only for the requester's own text: an artist's prompt keeps its values shown.
    // Any session token counts, live, expired or suspended: a draft is never shown; a caller without one hides nothing.
    expect(HUMAN).toMatch(/const authoring = !fromArtist && body\.authoring === true && Boolean\(request\.headers\.get\("X-Session-Token"\)\);/);
    expect(FREE).toMatch(/const authoring = body\?\.authoring === true && Boolean\(request\.headers\.get\("X-Session-Token"\)\);/);
    expect(FREE).toMatch(/\.\.\.\(authoring \? \{ text: "", withheld: prompt, draft: true \} : \{ text: prompt \}\),/);
    expect(FREE).toMatch(/after\(recordModerationEvent\(verdict, \{ surface: "generate-free", request, \.\.\.\(authoring \? \{ prompt: "", withheld: prompt, draft: true \} : \{ prompt \}\) \}\)\);/);
    // The event, and the record of a child-safety hit an artist's text made alone (DEC-474), and of one whose re-judge could not run.
    expect(HUMAN.match(/recordModerationEvent\(/g)).toHaveLength(3);
  });

  it("judges an artist's prompt on the buyer's values and an own prompt whole", () => {
    // The buyer's own values: never a default or an option the artist wrote (round 15, 2026-10-20).
    expect(HUMAN).toMatch(/const checked = fromArtist \? unnamedValues\(textValues\(buyersOwn\(body\.variableValues, artistVariables\)\)\) : \{ prompt \};/);
  });

  it("checks after composing, before moderation and before the charge", () => {
    expect(check).toBeGreaterThan(HUMAN.indexOf("const filled = fillVariables("));
    expect(HUMAN.indexOf("const verdict = first ?? await moderate({ prompt,")).toBeGreaterThan(check);
    expect(HUMAN.indexOf("await claimGenerationEscrowUnit(")).toBeGreaterThan(check);
  });

  it("warns on an explicit or child-safety request", () => {
    expect(HUMAN).toMatch(WARNED);
  });

  it("fails a silent refusal only where a real generation fails: after login, slot and claim", () => {
    const at = HUMAN.indexOf("    if (silent) {");
    expect(at).toBeGreaterThan(HUMAN.indexOf('return NextResponse.json({ error: "Authentication required" }, { status: 401 });'));
    expect(at).toBeGreaterThan(HUMAN.indexOf("consumedUnit = { supabase, claim };"));
    expect(HUMAN.indexOf("generateImagesWithWaveSpeed(shared)")).toBeGreaterThan(at);
    // Voided as the request's own refusal (round 4, 2026-10-19).
    expect(HUMAN).toMatch(/if \(silent\) \{\n[\s\S]{0,600}const answer = await silentFailure\(\);\n(\s+\/\/.*\n)*\s+await failIfClaimed\(check\.verdict === "unavailable" && checkDown\(check\.reason\) \? "provider_failed" : "rejected"\);\n\s+await releaseHeldSlot\(\);\n\s+return answer;/);
  });

  it("has no other, earlier silent answer", () => {
    expect(HUMAN.split("await silentFailure()").length - 1).toBe(1);
    expect(HUMAN.split("return silentFailure();").length - 1).toBe(0);
    expect(AGENT.split("return silentFailure();").length - 1).toBe(1);
    expect(FREE.split("return silentFailure();").length - 1).toBe(1);
  });

  it("counts a caught attempt only once it got that far", () => {
    // Twice on the human rail: where a refused generation fails, and on the
    // 18+ refusal for a signed-in account only (that answer comes before login).
    // Never where the render spells out the hidden text: whose doing that is cannot be told (review wf_866ba07b-01a).
    expect(HUMAN.split("recordExtractionHit(").length - 1).toBe(2);
    expect(HUMAN.lastIndexOf("recordExtractionHit(")).toBeGreaterThan(HUMAN.indexOf("    if (silent) {"));
    expect(HUMAN).toMatch(/if \(check\.verdict === "extraction" && asker\) \{\n\s+after\(recordExtractionHit\(/);
    // On x402 never before the payment is simulated.
    const sim = AGENT.indexOf("const simulated = await simulatePayment(");
    for (let at = AGENT.indexOf("after(recordExtractionHit("); at >= 0; at = AGENT.indexOf("after(recordExtractionHit(", at + 1)) {
      expect(at).toBeGreaterThan(sim);
    }
  });

  it("answers anything else that is refused with the ordinary failure", () => {
    expect(HUMAN).toMatch(SILENT);
  });
});

describe("the free generator", () => {
  const check = FREE.indexOf("await checkPrompt({ prompt }, { hidden: false, signal: request.signal })");

  it("checks the whole prompt before moderation and before rendering", () => {
    expect(check).toBeGreaterThan(-1);
    expect(FREE.indexOf("const verdict = first ?? await moderate({ prompt, surface: \"generate-free\"")).toBeGreaterThan(check);
    expect(FREE.indexOf("generateImageWithPollinations(")).toBeGreaterThan(check);
  });

  it("fails silently only after the sign-in and quota answers", () => {
    const at = FREE.indexOf("    if (silent) {");
    expect(at).toBeGreaterThan(FREE.indexOf('error: "Sign in to generate for free."'));
    expect(FREE.indexOf("await generateImageWithPollinations(")).toBeGreaterThan(at);
  });

  it("gives a slow silent answer the time it needs", () => {
    expect(FREE).toMatch(/export const maxDuration = 300;/);
  });

  it("never silences an account for its address's warnings", () => {
    // Only accounts generate here, and an account is stopped by its own ban.
    expect(FREE).not.toMatch(/addressWarnedOut/);
    expect(FREE.indexOf("decision.reason === \"sign-in\"")).toBeLessThan(FREE.indexOf("if (silent) {"));
  });

  it("warns, and fails closed otherwise", () => {
    expect(FREE).toMatch(WARNED);
    expect(FREE).toMatch(SILENT);
  });
});

describe("the agent rail", () => {
  const check = AGENT.indexOf("await checkPrompt(checked, { hidden })");

  it("judges a marketplace prompt on the agent's values and an own prompt whole", () => {
    // The agent's own values: never an option the artist wrote (round 15, 2026-10-20).
    expect(AGENT).toMatch(/const checked = input\.promptId \? unnamedValues\(textValues\(reqs\.prompt\?\.own \?\? \{\}\)\) : \{ prompt: promptText \};/);
  });

  it("files every warning and hit on the address, never on a session's account", () => {
    expect(AGENT).toMatch(/const asker = byAddress\(request\);/);
    const recorders = [...AGENT.matchAll(/(recordWarning|recordExtractionHit)\(supabase, \{\s*surface: "x402-generate", request(: asker)?,/g)];
    expect(recorders).toHaveLength(3);
    for (const r of recorders) expect(r[2]).toBe(": asker");
  });

  it("records every other moderation decision on the address, a marketplace prompt by its id", () => {
    const decide = AGENT.indexOf("const minors = !verdict.allowed ? childSafetyScore(verdict) : null;");
    const record = AGENT.indexOf("\n  after(recordModerationEvent(verdict, {\n");
    expect(decide).toBeGreaterThan(-1);
    // After the warning branch, so one hit is never two records.
    expect(record).toBeGreaterThan(decide);
    // Unconditionally: blocks and passes alike, as on the human rail.
    expect(AGENT.slice(record, record + 260)).toMatch(/surface: "x402-generate", request: asker,\n\s+\.\.\.\(input\.promptId \? \{ prompt: JSON\.stringify\(sent\), promptId: input\.promptId \} : \{ prompt: promptText \}\),/);
    expect(AGENT.lastIndexOf("return NextResponse.json({ error: CLIENT_BLOCK_MESSAGE }, { status: 422 });")).toBeGreaterThan(record);
    // Before it, a refusal the artist's text makes alone is its own record and the prompt's pause, no warning (DEC-475).
    const artists = AGENT.slice(AGENT.indexOf("const again = input.promptId && reqs.prompt && !first && !verdict.allowed"), decide);
    expect(artists).toContain("? await moderate({ prompt: neutralFill(reqs.prompt.template, input.variableValues, reqs.prompt.variables), surface: \"x402-generate\", adultJudged: false })");
    expect(artists).toMatch(/after\(recordModerationEvent\(verdict, \{ surface: "x402-generate", request: asker, prompt: JSON\.stringify\(sent\), promptId: input\.promptId \}\)\);\n\s+after\(refusePrompt\(supabase, \{ promptId: input\.promptId, cause: "moderation", detail: String\(again\.category \?\? "blocked"\), buyerUserId: null \}\)\);\n\s+return NextResponse\.json\(\{ error: PROMPT_UNAVAILABLE \}, \{ status: 422 \}\);/);
    expect(artists).not.toContain("recordWarning(");
  });

  it("stops a blocked address before checking", () => {
    const blocked = AGENT.indexOf("const blocked = (await agentBlocked(supabase, request)) || (await addressWarnedOut(supabase, request));");
    expect(blocked).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(blocked);
    // Judged like everyone else, so nothing before the silent point differs.
    expect(AGENT).toMatch(/const check = first \? NOT_CHECKED : await checkPrompt\(checked, \{ hidden \}\);/);
    expect(FREE).toMatch(/const check = first \? NOT_CHECKED : await checkPrompt\(\{ prompt \}, \{ hidden: false, signal: request\.signal \}\);/);
    expect(FREE).toMatch(/const silent = check\.verdict !== "clear";/);
  });

  it("fails silently only once the payment is simulated with its signatures, and before it settles", () => {
    const at = AGENT.indexOf("  if (silent) {");
    const sim = AGENT.indexOf("const simulated = await simulatePayment(solanaConnection(chainKey), parsed.tx);");
    expect(sim).toBeGreaterThan(AGENT.indexOf("const signature = cosignAsFeePayer(parsed.tx, feePayer);"));
    expect(at).toBeGreaterThan(AGENT.indexOf("if (!simulated.ok) {", sim));
    expect(AGENT.indexOf("submitAndConfirm(")).toBeGreaterThan(at);
  });

  it("answers a real failure with a fixed sentence, never the provider's", () => {
    // The failure record keeps the provider's text; only the answer must not.
    expect(AGENT).not.toMatch(/error: result\.error \|\| "Image generation failed/);
    expect(AGENT).toMatch(/error: "Image generation failed after your payment settled\.",/);
  });

  it("verifies the payment offline before anything is judged", () => {
    // Kev, 2026-10-06: a junk X-PAYMENT header must not buy a metered prompt
    // check. The offline verification is free and answers everyone alike.
    const verify = AGENT.indexOf("if (!verified.ok) return rejectPayment(reqs, verified.error);");
    expect(verify).toBeGreaterThan(AGENT.indexOf("const reqs = await requirementsFor(input, resource);"));
    expect(AGENT.indexOf("const blocked = (await agentBlocked(supabase, request))")).toBeGreaterThan(verify);
    expect(check).toBeGreaterThan(verify);
    expect(AGENT.split("parseXPayment(paymentHeader, ").length - 1).toBe(1);
    expect(AGENT.split("verifyAgentPayment(parsed.tx,").length - 1).toBe(1);
  });

  it("warns, and fails closed otherwise", () => {
    // On the address: the agent rail has no account to suspend.
    expect(AGENT).toMatch(/return NextResponse\.json\(\{ error: addressWarningMessage\(check\.verdict\) \}, \{ status: 422 \}\);/);
    expect(AGENT).toMatch(SILENT);
  });
});

describe("the 300-character limit", () => {
  it("refuses an over-long value on the human rail before composing", () => {
    // The over-long name is kept: a field whose every choice is too long is the artist's (round 13, 2026-10-20).
    const refuse = HUMAN.indexOf("const longInput = overLong(body.variableValues);\n      if (longInput) {");
    expect(refuse).toBeGreaterThan(-1);
    expect(HUMAN.indexOf("const filled = fillVariables(")).toBeGreaterThan(refuse);
  });

  it("refuses an over-long value on the agent rail in its schema", () => {
    expect(AGENT).toMatch(/variableValues: z\.record\(z\.string\(\), z\.string\(\)\.max\(VALUE_MAX\)\)/);
  });
});

describe("an agent payment that already landed", () => {
  it("is answered as the replay it is, before anything else is decided", () => {
    // Looked up only for a payment that would not settle; a failed lookup is unknown, never "not landed" (review 2026-10-18).
    const lookup = AGENT.indexOf("const landed = simulated.ok ? false : await paymentLanded(solanaConnection(chainKey), signature);");
    const replay = AGENT.indexOf("  if (landed) {", lookup);
    expect(AGENT).not.toMatch(/AlreadyProcessed"\)/);
    expect(lookup).toBeGreaterThan(AGENT.indexOf("const simulated = await simulatePayment("));
    expect(replay).toBeGreaterThan(lookup);
    expect(AGENT.indexOf("  if (silent) {")).toBeGreaterThan(replay);
    expect(AGENT.slice(replay, replay + 300)).toMatch(/This payment transaction was already settled", transaction: signature \}, \{ status: 409 \}/);
  });
});

describe("every record of an artist's prompt request (round 17, 2026-10-20)", () => {
  it("carries what was sent at every site, never only what was judged", () => {
    // Web: two image cases, two warnings, the moderation event and the generation record, and two extraction hits; the
    // record of an artist's child-safety hit (DEC-474), and of one whose re-judge could not run.
    expect(HUMAN.match(/JSON\.stringify\(sent\)/g)?.length).toBe(8);
    expect(HUMAN.match(/values: sent/g)?.length).toBe(2);
    // Agent: two warnings, the moderation event, the image case and five failure records, and one extraction hit
    // (round 18: the image case and the failure records wrote the same values another way); the record of a refusal an
    // artist's text makes alone (DEC-475), and of one whose re-judge could not run.
    expect(AGENT.match(/JSON\.stringify\(sent\)/g)?.length).toBe(12);
    expect(AGENT.match(/values: sent/g)?.length).toBe(1);
    for (const src of [HUMAN, AGENT]) expect(src).not.toMatch(/JSON\.stringify\(checked\)|values: checked/);
    // The request's values are read once, into sent.
    expect(HUMAN.match(/textValues\(body\.variableValues\)/g)?.length).toBe(1);
    expect(AGENT.match(/textValues\(input\.variableValues\)/g)?.length).toBe(1);
  });
});
