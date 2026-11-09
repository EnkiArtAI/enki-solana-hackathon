import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { madeWith } from "@/lib/ui/image-view/made-with";
import type { GenerationRow } from "@/lib/ui/image-view/history";
import type { ImageSetup } from "@/lib/ui/image-view/setups";
import type { Job } from "@/lib/ui/kit/render-queue";

/**
 * DEC-508 (Kev, 2026-10-29: "'No values are stored for this image': always show the prompt there for images in image
 * UI. if premium prompt, show the settings in there").
 */
const job = (over: Partial<ImageSetup> = {}) => ({
  setup: { model: { name: "Nano Banana" }, aspectRatio: "3:4", resolution: "2K", prompt: "a fox in [snow]", rows: [{ name: "Weather", value: "snow" }], ...over },
}) as unknown as Job<ImageSetup>;
const record = (over: Partial<GenerationRow> = {}) => ({
  settings: { modelId: "m1", aspectRatio: "1:1", resolution: "1K", boost: false }, model_name: "Seedream", variable_values: { weather: "rain", photo: "data:x" }, prompt_text: null, ...over,
}) as unknown as GenerationRow;
const free = { premium: false, publicText: "a fox in [weather]", promptSettings: ["Nano Banana", "3:4", "2K"], fields: [{ key: "weather", label: "Weather" }] };
const premium = { ...free, premium: true, publicText: null };

describe("what the viewer's panel says an image was made with", () => {
  it("is a free prompt's words: the exact text sent for the viewer's own render, else the prompt's own text", () => {
    expect(madeWith({ job: job() }, free)).toEqual({ kind: "text", text: "a fox in [snow]" });
    expect(madeWith({ record: record({ prompt_text: "a fox in rain" }) }, free)).toEqual({ kind: "text", text: "a fox in rain" });
    // A creator example, someone else's image, or the viewer's own render whose text the server keeps back.
    expect(madeWith({}, free)).toEqual({ kind: "text", text: "a fox in [weather]" });
    expect(madeWith({ record: record() }, free)).toEqual({ kind: "text", text: "a fox in [weather]" });
    expect(madeWith({}, { ...free, publicText: null })).toBeNull();
  });

  it("is a premium prompt's settings: the render's own with the values the viewer filled in, never its text", () => {
    expect(madeWith({ job: job({ prompt: "Fox, Weather: snow" }) }, premium)).toEqual(
      { kind: "settings", label: "Made with", settings: ["Nano Banana", "3:4", "2K"], rows: [{ name: "Weather", value: "snow" }] });
    // A recorded render: its generator, ratio and size, and its values by the prompt's labels; an image variable's data never.
    expect(madeWith({ record: record() }, premium)).toEqual(
      { kind: "settings", label: "Made with", settings: ["Seedream", "1:1", "1K"], rows: [{ name: "Weather", value: "rain" }] });
  });

  it("is the prompt's own settings, said as such, where the image carries none of its own (an example, someone else's)", () => {
    expect(madeWith({}, premium)).toEqual({ kind: "settings", label: "This prompt's settings", settings: ["Nano Banana", "3:4", "2K"], rows: [] });
    expect(madeWith({ record: record({ settings: null }) }, premium)).toMatchObject({ kind: "settings", label: "This prompt's settings" });
    expect(madeWith({}, { ...premium, promptSettings: [] })).toBeNull();
  });

  it("stands in the viewer's panel in place of the note, which stays only where nothing is known", () => {
    const PANEL = readFileSync(join(__dirname, "..", "..", "..", "..", "components", "image-view", "ViewerPanel.tsx"), "utf8");
    expect(PANEL).toContain("const made = madeWith(shot, m);");
    expect(PANEL).toContain('<button type="button" className="iv-vprompt-copy" onClick={() => copyText(made.text, "Copied the prompt")}>Copy prompt</button>');
    expect(PANEL).toContain('<p className="iv-vsettings"><span>{made.label}</span>{made.settings.join(" · ")}</p>');
    expect(PANEL).toContain('<p className="iv-vnote">No values are stored for this image</p>');
    expect(PANEL).not.toContain("This render used no variables");
  });
});
