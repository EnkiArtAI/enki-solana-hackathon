import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { readSource } from "@/lib/__tests__/_read-source";
import { namesReference, releaseBody, updateBody, type Listing, type Saved } from "@/lib/editor/release";
import { loadPrompt, type ServerPrompt } from "@/lib/editor/load-prompt";
import type { Draft } from "@/lib/editor/draft-store";
import type { CatalogueEntry } from "@/hooks/useModelLimits";
import type { Job } from "@/lib/ui/kit/render-queue";
import type { EditorSetup } from "@/lib/editor/generate-checks";

/**
 * The editor's switch for a premium prompt (Kev, 2026-11-01: "bei premium images das eingestellt werden kann"):
 * "Buyers can add reference images", on by default, sent with every release, an update and a restored draft too; a prompt
 * that names a reference stays on and the editor says so. The server's half: lib/__tests__/prompt-allow-references.test.ts.
 */
vi.mock("@/components/kit/PillMenu", () => ({ default: () => null }));
vi.mock("@/components/kit/Segmented", () => ({ default: () => null }));
vi.mock("@/components/prompt-editor/PriceStepper", () => ({ default: () => null }));

import ListingRow from "@/components/prompt-editor/ListingRow";
import { editorReducer, initialEditor } from "@/components/prompt-editor/usePromptEditor";

type El = ReactElement<Record<string, unknown>>;
function* walk(node: ReactNode): Generator<El> {
  if (Array.isArray(node)) for (const n of node) yield* walk(n);
  else if (isValidElement<Record<string, unknown>>(node)) { yield node; yield* walk(node.props.children as ReactNode); }
}
const text = (node: ReactNode): string =>
  Array.isArray(node) ? node.map(text).join("")
    : isValidElement<{ children?: ReactNode }>(node) ? text(node.props.children)
      : typeof node === "string" ? node : "";

const LISTING: Listing = { title: "Dusk", mode: "premium", price: 0.4, category: "Portrait", modelIds: ["m"], testId: null };
const catalogue = [{ id: "m", name: "Nano Banana Pro" }] as unknown as CatalogueEntry[];
const job = { id: "j", imageUrl: "https://x/a.webp", setup: { prompt: "a fox", vars: {}, kinds: {}, refIds: [], ratio: "4:5", resolution: "2K", modelId: "m", modelName: "Nano Banana Pro" } } as unknown as Job<EditorSetup>;
const row = (listing: Listing, named = false, onReferences: (on: boolean) => void = () => {}) =>
  ListingRow({ listing, onMode: () => {}, onPrice: () => {}, onCategory: () => {}, onReferences, referencesNamed: named });
const toggle = (tree: ReactNode) => [...walk(tree)].find((el) => el.props.role === "switch");
const bodyOf = (listing: Listing) => {
  const made = releaseBody({ listing, starred: [job], refs: {}, catalogue });
  if ("error" in made) throw new Error(made.error);
  return made.body;
};

describe("the switch", () => {
  it("shows on a premium prompt, on by default, named as Kev asked", () => {
    const tree = row(LISTING);
    expect(toggle(tree)?.props.checked).toBe(true);
    expect(toggle(tree)?.props.disabled).toBe(false);
    expect(text(tree)).toContain("Buyers can add reference images");
  });

  it("does not show on Open, and neither does its note", () => {
    const tree = row({ ...LISTING, mode: "free" }, true);
    expect(toggle(tree)).toBeUndefined();
    expect(text(tree)).not.toContain("reference image");
  });

  it("reads the listing and hands its change on", () => {
    const seen: boolean[] = [];
    const tree = row({ ...LISTING, allowReferences: false }, false, (on) => seen.push(on));
    expect(toggle(tree)?.props.checked).toBe(false);
    (toggle(tree)?.props.onChange as (e: { target: { checked: boolean } }) => void)({ target: { checked: true } });
    expect(seen).toEqual([true]);
    expect(text(tree)).not.toContain("names a reference");
  });

  it("stays on and says why when the prompt names a reference, whatever the listing holds", () => {
    const tree = row({ ...LISTING, allowReferences: false }, true);
    expect(toggle(tree)?.props.checked).toBe(true);
    expect(toggle(tree)?.props.disabled).toBe(true);
    expect(text(tree)).toContain("Your prompt names a reference image, so buyers always add theirs.");
  });
});

describe("what names a reference", () => {
  it("is the text, as the editor writes it or typed bare, and a value of a slot the text has", () => {
    expect(namesReference({ prompt: "a fox by [Reference image 1]", vars: {} })).toBe(true);
    expect(namesReference({ prompt: "a fox by Reference image 2", vars: {} })).toBe(true);
    expect(namesReference({ prompt: "a fox in [place]", vars: { place: "the room of Reference image 1" } })).toBe(true);
    expect(namesReference({ prompt: "a fox in [place]", vars: { place: "the room of [Reference image 1]" } })).toBe(true);
    expect(namesReference({ prompt: "a fox in [place]", vars: { place: "the room of [Character 1]" } })).toBe(false);
    expect(namesReference({ prompt: "a fox in [place]", vars: { place: "a forest" } })).toBe(false);
    // A value whose slot is gone from the text never reaches a save.
    expect(namesReference({ prompt: "a fox", vars: { old: "Reference image 1" } })).toBe(false);
  });
});

describe("what a release sends", () => {
  it("is the switch: on unless it was turned off, also for a listing without the field", () => {
    expect(bodyOf(LISTING).allowReferences).toBe(true);
    expect(bodyOf({ ...LISTING, allowReferences: true }).allowReferences).toBe(true);
    expect(bodyOf({ ...LISTING, allowReferences: false }).allowReferences).toBe(false);
  });

  it("goes with a listing-only update too", () => {
    const saved: Saved = { content: "a fox", variables: [], referenceImages: [], uploadedPhotos: [], aspectRatio: null, resolution: null, aiModel: "Nano Banana Pro" };
    expect(updateBody({ listing: { ...LISTING, allowReferences: false }, saved, id: "p", catalogue }).allowReferences).toBe(false);
  });

  it("a saved prompt comes back with its switch; a server without it reads as on", () => {
    const server: ServerPrompt = { id: "p", title: "Dusk", content: "a fox", category: "Portrait", aiModel: "Nano Banana Pro", price: 0.4, aspectRatio: null, promptType: "paid-prompt", uploadedPhotos: [], referenceImages: [], resolution: null, variables: [] };
    expect(loadPrompt({ ...server, allowReferences: false }, catalogue).listing.allowReferences).toBe(false);
    expect(loadPrompt(server, catalogue).listing.allowReferences).toBe(true);
  });
});

describe("a draft in this browser", () => {
  const draft = (listing: Listing): Draft => ({ doc: { prompt: "a fox", vars: {}, kinds: {}, aiNames: [], refIds: [] }, listing, picks: initialEditor().picks, stars: {}, order: [] });

  it("keeps the switch through a reload, and a release sends what was restored", () => {
    const stored = JSON.parse(JSON.stringify(draft({ ...LISTING, allowReferences: false }))) as Draft;
    const s = editorReducer(initialEditor(), { type: "restore", key: "k", draft: stored, refs: {} });
    expect(s.listing.allowReferences).toBe(false);
    expect(bodyOf(s.listing).allowReferences).toBe(false);
  });

  it("from before the switch is on", () => {
    const s = editorReducer(initialEditor(), { type: "restore", key: "k", draft: draft(LISTING), refs: {} });
    expect(bodyOf(s.listing).allowReferences).toBe(true);
  });
});

describe("the editor's wiring", () => {
  const EDITOR = readSource(join(__dirname, "..", "..", "..", "components", "prompt-editor", "PromptEditor.tsx"));

  it("saves the switch, reads the doc for a named reference, and says what the save answered", () => {
    expect(EDITOR).toContain("onReferences={(allowReferences) => setListing({ allowReferences })}");
    expect(EDITOR).toContain("referencesNamed={namesReference(doc)}");
    expect(EDITOR).toContain("${data.referencesNote ? ` · ${data.referencesNote}` : \"\"}");
  });

  it("a restored draft that only changed the switch still offers Discard", () => {
    expect(EDITOR).toContain("(a.allowReferences !== false) === (b.allowReferences !== false)");
  });
});
