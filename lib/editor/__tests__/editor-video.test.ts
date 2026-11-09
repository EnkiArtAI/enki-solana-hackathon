import { describe, expect, it, vi } from "vitest";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import PillMenu from "@/components/kit/PillMenu";
import GenerateBar from "@/components/prompt-editor/GenerateBar";
import GeneratorRow from "@/components/prompt-editor/GeneratorRow";
import ListingRow, { modeTitle } from "@/components/prompt-editor/ListingRow";
import VerifyPane from "@/components/prompt-editor/VerifyPane";
import ReleaseBar from "@/components/prompt-editor/ReleaseBar";
import { editorReducer, initialEditor } from "@/components/prompt-editor/usePromptEditor";
import { readSource } from "@/lib/__tests__/_read-source";
import type { CatalogueEntry } from "@/hooks/useModelLimits";
import { renderSettings, editorSetup } from "../generate-checks";
import { mediaOf, type Listing } from "../release";
import type { Draft } from "../draft-store";

/**
 * Create prompt's Image | Video (Kev, 2026-11-03: "gleiches visualisierungprinzip wie bei den bildern für image UI und create
 * prompt, nur dass create prompt einen zusatz zum switchen hat zwischen image and video ganz am anfang"): what the editor's
 * parts do with the medium. The real editor with real clicks is the fxp harness's. Blind spot here: no browser.
 */
const row = (name: string, mediaType: "image" | "video" = "video"): CatalogueEntry => ({ id: `id-${name}`, name, price: 0, mediaType, supportsQuality: true, maxResolution: "2K", ratios: ["1:1"], free: false });
type El = ReactElement<Record<string, unknown>>;
function* walk(node: ReactNode): Generator<El> {
  if (Array.isArray(node)) for (const n of node) yield* walk(n);
  else if (isValidElement<Record<string, unknown>>(node)) { yield node; yield* walk(node.props.children as ReactNode); }
}
const EDITOR = readSource(join(__dirname, "..", "..", "..", "components", "prompt-editor", "PromptEditor.tsx"));

describe("the switch", () => {
  it("stars of the other medium stay, and the bar says why they do not count (DEC-2026-11-03-115)", () => {
    expect(EDITOR).toContain('short={starred(state.stars, jobs).length > starredJobs.length ? `Only ${media}s count here` : isVideo ? "Star the video to release it" : undefined}');
    const said = (short?: string) => renderToStaticMarkup(createElement(ReleaseBar, { need: 1, photos: [], ratio: "16:9", listingOnly: false, released: false, blocked: true, busy: false, anyReady: true, mode: "free", onRelease() {}, onMore() {}, short }));
    expect(said("Only images count here")).toContain("Only images count here");
    expect(said()).toContain("All from one variation");
  });

  it("the mode's words count what this prompt releases: a premium video says 1 video, an image's are as they were (DEC-2026-11-03-113)", () => {
    expect(modeTitle({ mode: "premium", media: "video" })).toBe("Your text stays private; people pay your price on top of the generator. Release with 1 video.");
    expect(modeTitle({ mode: "free", media: "video" })).toBe("Open: your prompt text is public; people pay only the generator. Release with 1 video.");
    expect(modeTitle({ mode: "premium" })).toBe("Your text stays private; people pay your price on top of the generator. Release with 4 images.");
    expect(modeTitle({ mode: "free", media: "image" })).toBe("Open: your prompt text is public; people pay only the generator. Release with 1 image.");
    expect(EDITOR).toContain("notify(modeTitle({ ...listing, mode }))");
  });

  it("the viewer plays a video, never by itself: a creator watches what they star (DEC-2026-11-03-112)", () => {
    const viewer = readFileSync(join(__dirname, "..", "..", "..", "components", "kit", "FullscreenViewer.tsx"), "utf8");
    expect(EDITOR).toContain("videoUrl: v.video?.v720");
    expect(readFileSync(join(__dirname, "..", "..", "..", "components", "prompt-editor", "RenderPreview.tsx"), "utf8")).toContain("video: j.videoUrl,");
    expect(viewer).toContain('src={item.video} poster={item.src} aria-label="This video" controls playsInline preload="none"');
    expect(viewer).not.toMatch(/<video[^>]*autoPlay/);
    expect(viewer).toContain("swipe.current = e.target instanceof HTMLVideoElement ? null :");
  });

  it("Remove on a failed video takes its tile away: video jobs are not the queue's (DEC-2026-11-03-111)", () => {
    expect(EDITOR.slice(EDITOR.indexOf("onRemove={(jobId) => {"), EDITOR.indexOf("<WalletPickerModal"))).toContain("delete next[jobId];");
  });

  it("Regenerate and Retry on a video run the job as it was made: its words, its generator, its settings; no image quote for its row (DEC-2026-11-03-110)", () => {
    expect(EDITOR).toContain("const row = job ? videoRowOf(job.setup.modelName) : videoRow;");
    expect(EDITOR).toContain("const settings = job ? job.setup.video : videoPicks;");
    expect(EDITOR).toContain("words: fillPrompt(setup.prompt, setup.vars)");
    expect(EDITOR).toContain('again && entryOf(again)?.mediaType !== "video" ? quoteRequest');
    expect(EDITOR).toContain("if (from.retry && job) delete next[job.id];");
    expect(EDITOR).toContain("ratio: settings.aspect, video: settings }");
  });

  it("is the very first thing in the craft pane, and shut on a released prompt", () => {
    expect(EDITOR).toMatch(/<div className="pe-craft" \{\.\.\.pane\("craft"\)\}>[\s{}]*<div className="pe-row pe-media" data-locked=\{editing \|\| undefined\} title=\{editing \? "A released prompt keeps what it makes" : undefined\}>\s*<div className="pe-media-in" inert=\{editing \|\| undefined\}>/);
    expect(EDITOR).toContain('<Segmented slide role="radiogroup" ariaLabel="What this prompt makes" value={media} onChange={switchMedia} options={MEDIA} />');
  });

  it("counts stars in the medium at hand: an image's never releases a video prompt, nor the other way round", () => {
    expect(EDITOR).toContain('const starredJobs = starred(state.stars, jobs).filter((j) => (entryOf(j)?.mediaType === "video") === isVideo);');
  });

  it("leaves the words alone: it only sets the listing, and starts the generators over", () => {
    expect(EDITOR).toContain("if (next !== media) setListing({ media: next, modelIds: [], testId: null });");
  });
});

describe("the medium in the editor's state", () => {
  const seed = { kind: "library" as const, title: "Rain", promptText: "Rain over [city]" };

  it("a hand-over on Video opens on Video, with its words and its variable", () => {
    const s = editorReducer(initialEditor(), { type: "library", seed: { ...seed, media: "video" } });
    expect(s.listing.media).toBe("video");
    expect(s.history.present.prompt).toBe("Rain over [city]");
    expect(s.history.present.vars).toEqual({ city: "city" });
  });

  it("a hand-over without one is an image, as ever: no such field", () => {
    expect("media" in editorReducer(initialEditor(), { type: "library", seed }).listing).toBe(false);
    expect("media" in initialEditor().listing).toBe(false);
    expect(mediaOf(initialEditor().listing)).toBe("image");
  });

  it("a draft from before the switch reads as an image; one on Video stays on Video, its settings with it", () => {
    const base = initialEditor();
    const draft = (listing: Partial<Listing>, picks = {}): Draft => ({ doc: base.history.present, listing: { ...base.listing, ...listing }, picks: { ...base.picks, ...picks }, stars: {}, order: [] });
    expect(mediaOf(editorReducer(base, { type: "restore", key: "k", draft: draft({}), refs: {} }).listing)).toBe("image");
    const video = { seconds: 9, aspect: "16:9" as const, resolution: "720p" as const, audio: true, bitrate: "high" as const };
    const back = editorReducer(base, { type: "restore", key: "k", draft: draft({ media: "video" }, { video }), refs: {} });
    expect([back.listing.media, back.picks.video]).toEqual(["video", video]);
  });

  it("a job's setup never carries the video row's settings", () => {
    const picks = { ratio: "1:1", resolution: "2K" as const, boost: false, video: { seconds: 9, aspect: "16:9" as const, resolution: "720p" as const, audio: true, bitrate: "high" as const } };
    expect("video" in renderSettings(row("Nano Banana Pro", "image"), picks)).toBe(false);
    expect("video" in editorSetup({ prompt: "x", vars: {}, kinds: {}, refIds: [] }, row("Nano Banana Pro", "image"), picks)).toBe(false);
  });
});

describe("GeneratorRow", () => {
  const options = (labels?: string[]) => {
    const models = [row("Seedance 2.5"), row("Kling 4.0")];
    const prices = [{ totalMicro: 9_990_000, totalUsd: "9.99", networkFeeUsd: "0", artistUsd: "0", expiresAt: "", appliedRule: null }, null];
    const el = [...walk(GeneratorRow({ models, selected: [], prices, labels, onToggle: vi.fn(), onAll: vi.fn() }))].find((e) => e.type === PillMenu)!;
    return (el.props.options as Array<{ key: string; sub?: string | null }>).slice(1).map((o) => o.sub);
  };
  it("writes a video's price as it is handed; without labels the quotes, as ever", () => {
    expect(options(["$0.45", "…"])).toEqual(["$0.45", "…"]);
    expect(options()).toEqual(["$9.99", null]);
  });
});

describe("GenerateBar", () => {
  const core = { entry: row("Nano Banana Pro", "image"), tiers: [{ tier: "1K" }], ratios: ["1:1"], supportsQuality: true, clampRatio: (x: string) => x, clampTier: (x: string) => x } as never;
  const bar = (video?: ReactNode, tags?: Record<string, string>) => renderToStaticMarkup(createElement(GenerateBar, {
    live: null, models: [row("Nano Banana Pro", "image")], testId: "id-Nano Banana Pro", onTest: vi.fn(), core, picks: { ratio: "1:1", resolution: "1K", boost: false }, onPicks: vi.fn(),
    prices: { models: [null], tiers: [null], qualities: [null, null, null] }, tags, video,
    vary: { onVary: vi.fn(), rolling: false, unavailable: false }, generate: { label: "✦ Generate", chip: "$0.45", dimmed: true, onPress: vi.fn(), size: "bar" }, cost: { left: "Not available yet." },
  }));

  it("has the row where the pills are, Vary and Generate beside it", () => {
    const html = bar(createElement("div", { "data-row": "" }), {});
    expect(html).toContain('data-row=""');
    expect(html).toContain("Vary");
    expect(html).toContain("$0.45");
    // The generator and Vary: none of the image's three.
    expect((html.match(/class="kit-pill/g) ?? []).length).toBe(2);
    // Its name: a video generator has no logo of its own.
    expect(html).toContain("kit-dot");
  });

  it("with no test generator yet, a video has neither row nor the image's pills", () => {
    expect((bar(null, {}).match(/class="kit-pill/g) ?? []).length).toBe(2);
  });

  it("an image prompt keeps its pills", () => {
    const html = bar(undefined, undefined);
    expect(html).not.toContain('data-row=""');
    expect((html.match(/class="kit-pill/g) ?? []).length).toBe(5);
  });
});

describe("the words", () => {
  const listing = (media?: "image" | "video"): Listing => ({ title: "", mode: "premium", price: 1, category: null, modelIds: [], testId: null, ...(media ? { media } : {}) });
  const row = (l: Listing, referencesNamed = true) => renderToStaticMarkup(createElement(ListingRow, { listing: l, onMode: vi.fn(), onPrice: vi.fn(), onCategory: vi.fn(), onReferences: vi.fn(), referencesNamed }));
  const verify = (need: number, noun?: "image" | "video") => renderToStaticMarkup(createElement(VerifyPane, { pane: { id: "p" } as never, groups: [], need, noun, wide: false, open: new Set<string>(), onToggle: vi.fn(), onLoad: vi.fn(), acts: {} as never, onCraft: vi.fn(), showcase: null, release: null }));

  it("Verify says videos on Video, images as ever on Image", () => {
    expect(verify(1, "video")).toContain("Your test videos show up here.");
    expect(verify(1, "video")).toContain("star at least 1 video and release.");
    expect(verify(4)).toContain("Your test images show up here.");
    expect(verify(4)).toContain("star at least 4 images and release.");
  });

  it("the prompt's placeholder takes the noun", () => {
    const src = readSource(join(__dirname, "..", "..", "..", "components", "prompt-editor", "PromptField.tsx"));
    expect(src).toContain("placeholder={`Describe the ${noun} you want to sell as a prompt.");
    expect(EDITOR).toContain('growOnly={isHeld("prompt")} noun={media}');
  });

  it("a video prompt has no buyers' references to switch, nor a note about them; an image prompt keeps both", () => {
    expect(row(listing("video"))).not.toContain("Buyers can add reference images");
    expect(row(listing("video"))).not.toContain("names a reference image");
    expect(row(listing())).toContain("Buyers can add reference images");
    expect(row(listing())).toContain("names a reference image");
    expect(row(listing("image"))).toContain("Buyers can add reference images");
  });
});

describe("ReleaseBar", () => {
  const props = { need: 1, photos: [], ratio: "1:1", listingOnly: false, released: false, blocked: true, busy: false, anyReady: false, mode: "premium" as const, onRelease: vi.fn(), onMore: vi.fn() };
  it("says what a video prompt lacks; an image prompt as ever", () => {
    expect(renderToStaticMarkup(createElement(ReleaseBar, { ...props, first: "Make the video first" }))).toContain("Make the video first");
    expect(renderToStaticMarkup(createElement(ReleaseBar, props))).toContain("Generate first");
  });
});
