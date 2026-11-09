import { describe, expect, it } from "vitest";
import { CLIP_MAX_BYTES, MAX_PHOTOS, clipFileRefusal, clipLengthRefusal, lengthLabel, takePhotos } from "@/lib/remix/inputs";
import { REMIX_MODES } from "@/lib/remix/modes";
import { MY_REMIXES, REMIX_EXAMPLES } from "@/lib/remix/library";
import { COST_MICRO_PER_SECOND, DEFAULT_RESOLUTION, REMIX_RESOLUTIONS, remixCents, remixPrice } from "@/lib/remix/price";

/**
 * Remix's rules (Kev, 2026-10-30, after Sume's): a 4 to 15 s MP4 or MOV clip of at most 200 MB, 1 to 8 PNG, JPEG or
 * WebP photos, and one price table: our Seedance 2.5 video-input cost per second, at cost (Kev, 2026-10-30: "locken
 * user mit seedance ... worauf wir extra nehmen").
 */
describe("the price", () => {
  it("is one table of our cost per source second, 720p unless picked", () => {
    expect(COST_MICRO_PER_SECOND).toEqual({ "480p": 123_000, "720p": 276_500, "1080p": 680_400 });
    expect(REMIX_RESOLUTIONS).toEqual(["480p", "720p", "1080p"]);
    expect(DEFAULT_RESOLUTION).toBe("720p");
  });

  it("is the clip's seconds x our cost, no fee, rounded to the cent, never an estimate", () => {
    // 10 s: $1.23, $2.765, $6.804 (Sume's own 10 s at 720p: $2.766).
    expect(REMIX_RESOLUTIONS.map((r) => remixPrice(10, r))).toEqual(["$1.23", "$2.77", "$6.80"]);
    // 4 s at 480p is $0.492; 15 s at 1080p is $10.206.
    expect(remixPrice(4, "480p")).toBe("$0.49");
    expect(remixPrice(15, "1080p")).toBe("$10.21");
    // 7.43 s is shown and charged as 7.4 s: 7.4 x $0.2765 = $2.0461.
    expect(remixCents(7.43, "720p")).toBe(205);
    expect(remixPrice(7.43, "720p")).toBe("$2.05");
    // To the nearest cent, down ($1.3825) as well as up ($1.5375, $1.106).
    expect(remixCents(5, "720p")).toBe(138);
    expect(remixPrice(12.5, "480p")).toBe("$1.54");
    expect(remixPrice(4, "720p")).toBe("$1.11");
  });
});

describe("the clip", () => {
  const file = (type: string, size = 1000, name = "clip") => ({ type, size, name });

  it("takes MP4 and MOV, a typeless drop by its name, and nothing else", () => {
    expect(clipFileRefusal(file("video/mp4"))).toBeNull();
    expect(clipFileRefusal(file("video/quicktime"))).toBeNull();
    expect(clipFileRefusal(file("", 1000, "Dance.MOV"))).toBeNull();
    expect(clipFileRefusal(file("", 1000, "dance.mp4"))).toBeNull();
    expect(clipFileRefusal(file("video/webm"))).toBe("Pick an MP4 or MOV video.");
    expect(clipFileRefusal(file("", 1000, "dance.webm"))).toBe("Pick an MP4 or MOV video.");
    // The name counts only when the file has no type, and only as its ending.
    expect(clipFileRefusal(file("video/webm", 1000, "dance.mp4"))).toBe("Pick an MP4 or MOV video.");
    expect(clipFileRefusal(file("", 1000, "dance.mp4.webm"))).toBe("Pick an MP4 or MOV video.");
    expect(clipFileRefusal(file("image/png"))).toBe("Pick an MP4 or MOV video.");
  });

  it("takes up to 200 MB", () => {
    expect(CLIP_MAX_BYTES).toBe(209_715_200);
    expect(clipFileRefusal(file("video/mp4", CLIP_MAX_BYTES))).toBeNull();
    expect(clipFileRefusal(file("video/mp4", CLIP_MAX_BYTES + 1))).toBe("This video is over 200 MB. Pick a smaller one.");
  });

  it("is 4 to 15 s long, counted in the tenths it shows", () => {
    expect(clipLengthRefusal(4)).toBeNull();
    expect(clipLengthRefusal(3.96)).toBeNull();
    expect(clipLengthRefusal(15)).toBeNull();
    expect(clipLengthRefusal(15.04)).toBeNull();
    expect(clipLengthRefusal(3.9)).toBe("This clip is 3.9 s long. Pick one of 4 to 15 seconds.");
    expect(clipLengthRefusal(15.1)).toBe("This clip is 15.1 s long. Pick one of 4 to 15 seconds.");
    expect(clipLengthRefusal(42)).toBe("This clip is 42.0 s long. Pick one of 4 to 15 seconds.");
    expect(lengthLabel(7.43)).toBe("7.4 s");
    expect(lengthLabel(10)).toBe("10.0 s");
  });
});

describe("the photos", () => {
  const photo = (type = "image/png") => ({ type, size: 10, name: "p" });

  it("takes PNG, JPEG and WebP, and says when it left any out", () => {
    const [png, jpg, webp, gif] = [photo(), photo("image/jpeg"), photo("image/webp"), photo("image/gif")];
    expect(takePhotos([png, jpg, webp], 0)).toEqual({ take: [png, jpg, webp], why: null });
    expect(takePhotos([png, gif], 0)).toEqual({ take: [png], why: "Only PNG, JPEG or WebP photos." });
  });

  it("takes at most 8 in all", () => {
    expect(MAX_PHOTOS).toBe(8);
    const nine = Array.from({ length: 9 }, () => photo());
    expect(takePhotos(nine, 0).take).toHaveLength(8);
    expect(takePhotos(nine, 0).why).toBe("At most 8 photos: 1 left out.");
    expect(takePhotos([photo(), photo()], 7)).toMatchObject({ why: "At most 8 photos: 1 left out." });
    expect(takePhotos([photo(), photo()], 7).take).toHaveLength(1);
    expect(takePhotos([photo()], 8)).toEqual({ take: [], why: "At most 8 photos: 1 left out." });
    expect(takePhotos([photo(), photo()], 6)).toMatchObject({ why: null });
  });
});

describe("the modes and the lists", () => {
  it("names each mode, its photos and its hint in Enki's words", () => {
    expect(REMIX_MODES.motion).toMatchObject({ label: "Motion transfer", photos: "Add person photo",
      line: "Your photos move the way the clip moves.",
      hint: "A 4-15 s clip and 1-8 photos that move like it. The prompt is optional." });
    expect(REMIX_MODES.swap).toMatchObject({ label: "Object swap", photos: "Add reference image",
      line: "People or things in the clip become the ones in your photos.",
      hint: "A 4-15 s clip and 1-8 photos that take the place of people or things in it. The prompt is optional." });
  });

  it("has no remixes and no examples until the backend exists: no stand-ins", () => {
    expect(MY_REMIXES).toEqual([]);
    expect(REMIX_EXAMPLES).toEqual([]);
  });
});
