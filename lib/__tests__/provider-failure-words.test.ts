import { describe, expect, it } from "vitest";
import { providerFailure } from "@/lib/generation/record";

/**
 * A provider's error can repeat the request. With an artist's text in the request (a marketplace prompt, a draft) a
 * failure keeps only the error's class, as staff read failures and the artist's words are no one else's (ENC review,
 * 2026-10-27).
 */
const ECHO = "400 Bad Request: input 'a lighthouse at dusk, oil on linen, in the manner of the artist' is too long";

describe("a provider's error words on a failure", () => {
  it("keep only their class when an artist's text rode along", () => {
    expect(providerFailure(ECHO, true)).toBe("provider: request");
    expect(providerFailure("Your request was rejected by the safety system: a lighthouse at dusk", true)).toBe("provider: content");
    for (const e of [ECHO, "fetch failed: a lighthouse at dusk"]) expect(providerFailure(e, true)).not.toContain("lighthouse");
  });

  it("stay as they are for the buyer's own text", () => {
    expect(providerFailure(ECHO, false)).toBe(ECHO);
  });
});
