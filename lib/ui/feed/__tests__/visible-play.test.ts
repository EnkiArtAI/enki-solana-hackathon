import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COVER_SWEEP_MS, DWELL_MS, MAX_PLAYING, holdSource, pickPlaying, startPlaying, stopPlaying } from "../visible-play";
import { FeedPlayer } from "@/components/enki/FeedVideo";

/**
 * Which cards of the wall play, and how one plays. The observer, real scrolling, autoplay and what is fetched are driven
 * in headless Edge (DEC-2026-11-03-66), with a real preview.mp4. Blind spot: Edge is not iOS Safari; its decoder limit and
 * Low Power Mode's NotAllowedError are stood in for here by a rejected play().
 */
const READER = { saveData: false, reducedMotion: false };
const card = (key: string, visible: number, distance: number) => ({ key, visible, distance });
const read = (...p: string[]) => readFileSync(join(__dirname, "..", "..", "..", "..", ...p), "utf8").split("\r\n").join("\n");

describe("the pick", () => {
  it("is at most 6, the nearest the middle first, whatever the order they were seen in", () => {
    const cards = [9, 3, 7, 1, 8, 2, 6, 4, 5].map((d) => card(`c${d}`, 1, d));
    expect(MAX_PLAYING).toBe(6);
    expect([...pickPlaying(cards, READER)]).toEqual(["c1", "c2", "c3", "c4", "c5", "c6"]);
    // A shorter list is all of it, and the input keeps its order.
    expect([...pickPlaying(cards.slice(0, 2), READER)]).toEqual(["c3", "c9"]);
    expect(cards[0].key).toBe("c9");
  });

  it("wants half a card on screen: exactly half counts, less does not, however near", () => {
    expect([...pickPlaying([card("a", 0.5, 9), card("b", 0.49, 1)], READER)]).toEqual(["a"]);
  });

  it("drops a card that left, and the next one takes its place", () => {
    const all = [1, 2, 3, 4, 5, 6, 7].map((d) => card(`c${d}`, 1, d));
    expect(pickPlaying(all, READER).has("c7")).toBe(false);
    const left = all.map((c) => (c.key === "c1" ? { ...c, visible: 0 } : c));
    const picked = pickPlaying(left, READER);
    expect(picked.has("c1")).toBe(false);
    expect(picked.has("c7")).toBe(true);
    expect(picked.size).toBe(6);
  });

  it("is nothing under Save-Data or reduced motion", () => {
    const cards = [card("a", 1, 1)];
    expect(pickPlaying(cards, { saveData: true, reducedMotion: false }).size).toBe(0);
    expect(pickPlaying(cards, { saveData: false, reducedMotion: true }).size).toBe(0);
    expect(pickPlaying(cards, READER).size).toBe(1);
  });
});

describe("one player", () => {
  const video = (play: () => Promise<void> | undefined) => ({ muted: false, play: vi.fn(play) });

  it("is muted before it plays", () => {
    const v = video(() => { expect(v.muted).toBe(true); return Promise.resolve(); });
    startPlaying(v as never, () => {});
    expect(v.play).toHaveBeenCalledOnce();
  });

  it("gives up on a refusal, so the poster stays; its own stop is no refusal", async () => {
    for (const [name, times] of [["NotAllowedError", 1], ["NotSupportedError", 1], ["AbortError", 0]] as const) {
      const refused = vi.fn();
      startPlaying(video(() => Promise.reject(Object.assign(new Error(name), { name }))) as never, refused);
      await new Promise((r) => setTimeout(r));
      expect(refused).toHaveBeenCalledTimes(times);
    }
    const refused = vi.fn();
    startPlaying(video(() => Promise.resolve()) as never, refused);
    // An old browser's play() returns nothing.
    startPlaying(video(() => undefined) as never, refused);
    await new Promise((r) => setTimeout(r));
    expect(refused).not.toHaveBeenCalled();
  });

  it("gives its decoder back when it stops", () => {
    const calls: string[] = [];
    stopPlaying({ pause: () => calls.push("pause"), removeAttribute: (a: string) => calls.push(`remove ${a}`), load: () => calls.push("load") } as never);
    expect(calls).toEqual(["pause", "remove src", "load"]);
  });

  it("has its address back when the effect runs again on the same element, and is not reloaded when it never left", () => {
    const attrs = new Map([["src", "https://v/a.mp4"]]);
    const v = { getAttribute: (k: string) => attrs.get(k) ?? null, setAttribute: vi.fn((k: string, x: string) => { attrs.set(k, x); }), removeAttribute: (k: string) => { attrs.delete(k); }, pause() {}, load() {} };
    holdSource(v as never, "https://v/a.mp4");
    expect(v.setAttribute).not.toHaveBeenCalled();
    stopPlaying(v as never);
    expect(attrs.get("src")).toBeUndefined();
    holdSource(v as never, "https://v/a.mp4");
    expect(attrs.get("src")).toBe("https://v/a.mp4");
    // A new address on one player: React wrote it, the cleanup took it, the effect holds it.
    stopPlaying(v as never);
    holdSource(v as never, "https://v/b.mp4");
    expect(attrs.get("src")).toBe("https://v/b.mp4");
  });

  it("both players hold their address before they start, and the feed's effect hears a new one", () => {
    for (const file of [read("components", "enki", "FeedVideo.tsx"), read("components", "image-view", "StageVideo.tsx")]) {
      expect(file.indexOf("holdSource(el, src);")).toBeGreaterThan(-1);
      expect(file.indexOf("holdSource(el, src);")).toBeLessThan(file.indexOf("startPlaying(el,"));
    }
    expect(read("components", "enki", "FeedVideo.tsx")).toContain("}, [src, onRefused]);");
  });

  it("a card under something else holds no place: asked of what lies on top, and again every sweep, until no wall is left", () => {
    const file = read("components", "enki", "FeedVideo.tsx");
    expect(file).toContain('el.closest(".feed-card")?.contains(top)');
    expect(file).toContain("return onTop(key, r) ?");
    expect(file).toContain("sweep ??= setInterval(() => { if (!moving) repick(); }, COVER_SWEEP_MS);");
    expect(file).toContain("clearInterval(sweep);");
    expect(COVER_SWEEP_MS).toBe(500);
  });

  it("a flick starts nothing: picked only once the wall has held still, gone from the screen stopped at once", () => {
    const file = read("components", "enki", "FeedVideo.tsx");
    expect(DWELL_MS).toBe(200);
    expect(file).toContain("moving = setTimeout(repick, DWELL_MS);");
    expect(file).toContain("watched.get(e.target)?.(false);");
    expect(file.slice(file.indexOf("new IntersectionObserver"), file.indexOf("threshold:"))).toContain("settle();");
  });

  it("is a silent inline loop that loads nothing by itself", () => {
    const html = renderToStaticMarkup(createElement(FeedPlayer, { src: "https://v/preview.mp4", onRefused: () => {} }));
    expect(html).toBe('<video src="https://v/preview.mp4" muted="" playsInline="" loop="" preload="none"></video>');
    expect(html).not.toMatch(/autoplay|controls/i);
  });
});

describe("the card", () => {
  const CARD = read("components", "enki", "FeedCard.tsx");
  const CSS = read("components", "enki", "feed.css");

  it("plays the preview, never a file with sound, only for a card with a video, over its picture and under its button", () => {
    expect(CARD).toContain("{card.video && <FeedVideo src={card.video.preview} />}");
    expect(CARD).not.toMatch(/v720|v1080/);
    expect(CARD.indexOf('className="feed-card-img"')).toBeLessThan(CARD.indexOf("<FeedVideo"));
    expect(CARD.indexOf("<FeedVideo")).toBeLessThan(CARD.indexOf('className="feed-card-hit"'));
    expect(CSS).toContain(".feed-card-video { position: absolute; inset: 0; }");
    expect(CSS).toContain(".feed-card-video video { display: block; width: 100%; height: 100%; object-fit: cover; opacity: 0; transition: opacity 0.2s ease; }");
    expect(CSS).toContain(".feed-card-video video.is-playing { opacity: 1; }");
  });
});
