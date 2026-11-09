"use client";

/**
 * Everything the Image View shows and does, for every layout (desktop and
 * tablet here, the phone in IV1c): the prompt and what the server knows
 * about it, the composer, the render queue, and which image is on the stage.
 * A layout only arranges it and keeps its own UI state (viewer, rail, tabs).
 *
 * Every price is a server quote; where no route returns a number, none is
 * shown (plan §5). The blank composer (`seed = "blank"`, the launcher) is the
 * same model without a prompt: the buyer's own text, every image generator,
 * nothing preselected, no history and no discussion.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useBetaAccess } from "@/components/BetaGate";
import { notify } from "@/components/kit/notify";
import { useGrowOnly } from "@/components/kit/useGrowOnly";
import { useBookmarkIndex } from "@/hooks/useBookmarkIndex";
import type { Membership } from "@/lib/ui/feed/bookmark-index";
import { useComposerQuote } from "@/hooks/useComposerQuote";
import { useGenerationCore, type GenerationCore } from "@/hooks/useGenerationCore";
import { BALANCE_LOADING, refreshHoldings, useHoldings } from "@/hooks/useHoldings";
import { boostAt, useModelCatalogue, useModelLimits, type CatalogueEntry } from "@/hooks/useModelLimits";
import type { SavedReference } from "@/hooks/useReferenceLibrary";
import { REFS_LOADING, useReferenceReads, type NftPick } from "@/hooks/useReferenceReads";
import { useRenderQueue } from "@/hooks/useRenderQueue";
import { useServerQuotes } from "@/hooks/useServerQuotes";
import { useViewerWallets } from "@/hooks/useViewerWallets";
import type { GenerationQuote, QuoteRequest } from "@/lib/generation-checkout";
import { tiersUpTo, type ResolutionTier } from "@/lib/generation/resolution";
import type { VariableRange } from "@/lib/editor/selection-variable";
import { offeredModels } from "@/lib/offered-models";
import { openLogin } from "@/lib/openLogin";
import { REFS_TOO_LARGE, tooLargeToSend } from "@/lib/request-size";
import { sessionAuthHeaders, viewerHeaders } from "@/lib/session-headers";
import { clipboardText, promptRefusal } from "@/lib/ui/image-view/assemble";
import { loadDiscussion, loadLikes, type Discussion } from "@/lib/ui/image-view/discussion";
import { hasGenerated, pastImages, publicShots, recordOf, type GenerationRow, type PastImage } from "@/lib/ui/image-view/history";
import type { Maker } from "@/lib/ui/image-view/maker";
import { defaultModel, forViewer, isFreePrompt, modelOptions, refCap, refSlots } from "@/lib/ui/image-view/models";
import { ADD_PHOTOS_EVENT, MAX_SLOTS, initialSlots, refsAt, removeSlot as dropSlot, resize as resizeSlots, slotCount } from "@/lib/ui/image-view/slots";
import { matchVariable, parseSegments, type PromptVariable, type Segment } from "@/lib/ui/image-view/segments";
import type { ImageViewSeed } from "@/lib/ui/image-view/seed";
import { againStep, makeSetup, quoteOf, toRequest, type ImageSetup, type JobPrice } from "@/lib/ui/image-view/setups";
import { fieldsFor, initialValues, missingRequired, type Field } from "@/lib/ui/image-view/variables";
import { openAddFunds } from "@/lib/ui/kit/controls";
import { formatAgo } from "@/lib/ui/kit/format";
import { balanceView, chipLabel, estimatedQuote } from "@/lib/ui/kit/price";
import { leaveSummary, quotaText, type Job } from "@/lib/ui/kit/render-queue";
import { announceRender } from "@/lib/ui/kit/render-notices";
import { GENERATION_START_EVENT } from "@/lib/ui/kit/shell-nav";
import { useOwnRenders } from "./useOwnRenders";
import { useVideoPrompt } from "./useVideoPrompt";
import { videoShot } from "@/lib/ui/image-view/video";
import { VIDEO_NOT_AVAILABLE } from "@/lib/video/models";
import type { VideoRenditions } from "@/lib/video/renditions";
import { countImageOpen } from "@/lib/ui/view-beacon";
import type { HuntReach } from "@/lib/hunter/creator-types";

/** GET /api/prompts/[id] → prompt, the fields this view reads. */
interface PromptRecord {
  /** Its reach on X when it was imported (app/api/prompts/[id] sourceReach). */
  sourceReach?: HuntReach | null;
  /** This viewer may add reference images (false: a premium prompt's creator switched them off; absent reads as true). */
  allowReferences?: boolean;
  /** What it makes (SQL 52); absent or "image" on every prompt before it. */
  mediaType?: "image" | "video";
  /** A video prompt's files; its showcaseImages hold the poster, so every picture surface stays safe. */
  showcaseVideo?: VideoRenditions | null;
  title?: string;
  prompt_type?: string | null;
  is_free_showcase?: boolean | null;
  ai_model?: string | null;
  /** The prompt's other settings; `models` names the generators on offer (lib/offered-models). */
  ai_settings?: unknown;
  aspect_ratio?: string | null;
  resolution?: string | null;
  creator_id?: string | null;
  /** One of lib/categories' labels ("Portrait", …). */
  category?: string | null;
  /**
   * Only a free prompt's. When its text could not be decrypted the route
   * still sends the stored 220-character excerpt, which this view cannot
   * tell from the whole text; only a prompt without either reads as missing.
   */
  publicPromptText?: string;
  /** Each with the references its render shows, where it is public with its owner's switch on (DEC-514). */
  showcaseImages?: { url: string; preview?: string | null; thumb?: string | null; view?: string; tiny?: string; references?: string[] }[];
  /** The images the creator released it with; the route sends them to the creator alone (uploads nothing has checked yet, Kev 2026-10-08). */
  beforeImages?: { url: string }[];
  promptData?: { variables?: PromptVariable[] };
}

export type Status = "loading" | "gone" | "failed" | "ready";

/** The prompt read's state: a 404 is a prompt this viewer may not see (unlisted, 18+, hidden creator). */
export function loadState(q: { isPending: boolean; error: Error | null }): Status {
  if (q.error) return /^404\b/.test(q.error.message) ? "gone" : "failed";
  return q.isPending ? "loading" : "ready";
}

/** One image the page can show: a render of this tab, a creator example, a public image made with the prompt, or one of the viewer's own. */
export interface Shot {
  /** "job:<id>", "example:<n>", "community:<id>" or "history:<id>". */
  key: string;
  kind: "job" | "example" | "community" | "history";
  /** What the stage and the viewer show; absent while a job renders and after it failed. */
  src?: string;
  /** The small version, for strips and the rail. */
  thumb?: string;
  /** A video prompt's example: the stage plays this, `src` is its poster. */
  video?: VideoRenditions;
  /** What the stage shows instead of src, when smaller (an example's 1280 px rendition). */
  stage?: string;
  /** What Download saves: the stored original. */
  original?: string;
  /** The ratio asked for, until the picture loads and says its own. */
  ratio: string | null;
  job?: Job<ImageSetup>;
  /** The viewer's own recorded render: it carries the Public switch. */
  record?: GenerationRow;
  /** Someone else's public image: it carries Report. */
  publicId?: string;
  /** Who made a public image, for the strip's hover (never the viewer's own: those are history entries). */
  maker?: Maker;
  /** The references someone else's public image or a creator example was made with, where its owner shows them (DEC-514). */
  references?: string[];
  createdAt?: string;
}

/** What an image says about itself, on the stage and in the viewer. Never a model or a size the server did not return (plan §5 #16, #17). */
export function metaOf(s: Shot, now: number): string | null {
  const j = s.job;
  if (j) {
    if (j.status !== "ready") return j.status === "rendering" ? "rendering…" : null;
    return `${j.setup.model.name} · ${j.size ? `${j.size.w}×${j.size.h}` : j.setup.resolution} · ${j.setup.aspectRatio} · yours`;
  }
  if (s.kind === "history") return `yours · ${formatAgo(s.createdAt ?? "", now)}`;
  return s.kind === "example" ? "creator example" : "made with this prompt";
}

export const copyText = (text: string, said: string) =>
  void navigator.clipboard.writeText(text).then(() => notify(said), () => notify("Couldn't copy that", { tone: "error" }));

/** The grow-only key of the prompt text itself. */
export const PROMPT_KEY = "\u0000prompt";
const GENERATE = "✦ Generate";
/** Images per press: the desktop stepper's range in the handoff (plan D19); the batch runner takes up to 24. */
export const COUNT_MAX = 8;
type Quality = NonNullable<ImageSetup["quality"]>;
const QUALITIES: Quality[] = ["low", "medium", "high"];

/** What every layout of the Image View builds on (desktop and tablet here, the phone in IV1c). */
export interface ImageViewModel {
  /** An imported prompt's reach on X, shown beside its rating as its social performance (Kev, 2026-10-31). */
  reach: HuntReach | null;
  /** The launcher's composer: no prompt, the buyer's own text. */
  blank: boolean;
  promptId: string | null;
  status: Status;
  /** Reads the prompt again, after "Couldn't load this prompt". */
  reload: () => void;
  /** The prompt's title; "New image" in the blank composer. */
  title: string;
  /** The prompt's category ("Portrait", …); null in the blank composer or while unknown. */
  category: string | null;
  /** Who made it, as far as known; null while unknown (never "Unknown Artist"). */
  artist: { handle: string | null; name: string | null } | null;
  /** The text stays the artist's: the buyer fills its variables only. */
  premium: boolean;
  /** A free prompt's own text as it loaded (the buyer's edit aside); null on a premium prompt or while it is missing. */
  publicText: string | null;
  /** The prompt's own generator, ratio and resolution, for the viewer's panel on an image without its own (DEC-508). */
  promptSettings: string[];
  /** A video prompt: `foot` its settings row, null before SQL 67. Null on an image prompt. Generate stays "Not available yet." until an operator is set. */
  video: { foot: ReturnType<typeof useVideoPrompt>["foot"] } | null;
  /** Signed out, or in on a shared team code: no price, no history, "Log in to generate". */
  guest: boolean;
  /** The balance in USD once it is in, where a paid render draws on it; null otherwise. The count wheel locks what it cannot cover. */
  balanceUsd: number | null;
  /** The minute clock "2h ago" is told against. */
  now: number;

  /** What the T view edits: the artist's text, the buyer's edit of it, the blank composer's own; null on a premium prompt. */
  text: string | null;
  /** A free prompt whose text did not load: nothing can be generated from it. */
  textMissing: boolean;
  /** The buyer changed the artist's wording (Reset is offered). */
  edited: boolean;
  setText: (text: string) => void;
  resetText: () => void;
  /** Expert shows the document ("filled", where it has slots or images) or the words to edit ("text"). */
  view: "text" | "filled";
  setView: (view: "text" | "filled") => void;
  segments: Segment[] | null;
  /** A prompt without variables (text-only handoff §1): its text stands in place of the fields, no Easy | Expert. Never the blank composer, never a premium prompt (no text here). */
  plain: boolean;
  /** A plain prompt that names no photo either: no photo area, and no photo travels with it (§2.5). */
  photoless: boolean;
  /** A premium prompt whose creator switched buyers' references off: no photo area, and none travels. */
  photosOff: boolean;
  /** The composer's inputs, in order. */
  fields: Field[];
  variables: PromptVariable[];
  values: Record<string, string>;
  setValue: (key: string, value: string) => void;
  /** The value differs from the prompt's own (the creator's default, "" for a slot without one). */
  changed: (key: string) => boolean;
  /** Back to the prompt's own value. */
  resetValue: (key: string) => void;
  /** Values loaded from an image: the field may grow, not shrink, until typed in (`release`). PROMPT_KEY is the text's. */
  growOnly: (key: string) => boolean;
  release: (key: string) => void;
  /** Copies what is on screen: the text, the filled text, or a premium prompt's "label: value" lines. */
  copyPrompt: () => void;
  /** "+ Variable": the selected words become a [slot] holding them, and its field takes the focus. */
  addVariable: (range: VariableRange) => void;

  core: GenerationCore;
  /** Every image generator on offer (no free host on a premium prompt), with its price at the current settings. */
  models: CatalogueEntry[];
  modelPrices: Array<GenerationQuote | null>;
  pickModel: (id: string) => void;
  /** Clamped to the generator in use. */
  ratio: string;
  setRatio: (ratio: string) => void;
  resolution: ResolutionTier;
  setResolution: (tier: ResolutionTier) => void;
  /** Aligned with core.tiers. */
  tierPrices: Array<GenerationQuote | null>;
  quality: Quality;
  setQuality: (quality: Quality) => void;
  /** Low, medium, high; empty unless the generator has the lever. */
  qualityPrices: Array<GenerationQuote | null>;
  /** Wired and off: no control shows it (Kev, 2026-10-13: the host is picked by itself later). */
  boost: boolean;
  setBoost: (on: boolean) => void;

  /** The buyer's photos in slot order: photo k is "Reference image k". */
  refs: { id: string; src: string }[];
  /** Photo tiles: every slot the text names, every photo, at least one. */
  slotTotal: number;
  /** Slots the text names that still wait for a photo: Generate reads "Add N photos" and opens the picker. 0 on a premium prompt, whose text never reaches here. */
  photosNeeded: number;
  /** Previews of images still being read. */
  pending: string[];
  /** How many images the generator takes here (at most 4); room left; how many are over a smaller generator's cap. */
  cap: number;
  room: number;
  over: number;
  accept: string;
  /** `at`: the new slots' references go in at that text index (Expert's cursor), else after the last one. */
  addFiles: (files: File[], at?: number) => void;
  /** Wallet NFTs, read through our own route; `at` as for files. */
  addNfts: (picks: NftPick[], at?: number) => void;
  /** Images already stored (an earlier reference, an upload), read into data as every reference travels; `at` as for files. */
  addUrls: (urls: string[], at?: number) => void;
  /** The viewer's earlier references and uploads, newest first: the reference picker's Images tab. */
  myImages: PastImage[];
  /** This visit's uploads, in upload order, a saved one under its saved id: the picker shows the unsaved ones (a guest's,
   *  one whose save failed or still runs) first, selected while they are among the refs (Kev, 2026-10-29; DEC-506). */
  uploads: { id: string; src: string }[];
  /** The account's saved references, newest first (SQL 51, DEC-525): after this visit's unsaved uploads, each with its
   *  ×, keyed by its id; a saved upload moves here. */
  library: SavedReference[];
  /** The hashes of the saved references deleted: the picker hides an earlier render's copy of one. */
  deletedRefs: string[];
  /** A saved reference's ×: gone from the list and from this visit's uploads, its files with it. */
  deleteRef: (id: string) => void;
  /** A picker tile pressed: among the refs, its slot goes (as removeSlot); out of them, an upload comes back in, a saved
   *  one is read as it was saved and an earlier image as addUrls reads it, `at` as for files. */
  toggleRef: (key: string, at?: number) => void;
  /** Slot i (0-based) gone with its reference and one " and " (README §5.1); the last slot the text names is only emptied. */
  removeSlot: (i: number) => void;
  replacePhoto: (i: number, file: File) => void;

  /** The job Generate would run now; null without a generator. */
  setup: ImageSetup | null;
  quote: GenerationQuote | null;
  quotePending: boolean;
  /** The Generate chip: "$0.00", the server's total for the whole run, "…", or none. */
  chip: string | null;
  /** One image's price, as the chip writes it: the Premium badge. */
  perImage: string | null;
  /** Images one press makes (1..countMax); one on a free generator. */
  count: number;
  countMax: number;
  setCount: (n: number) => void;
  /** The generator, format, resolution or quality differs from the prompt's own. */
  settingsChanged: boolean;
  /** Back to the prompt's generator, format, resolution and quality; the words and photos stay. */
  resetSettings: () => void;
  /** Dimmed still takes the press, which says what is missing. */
  button: { label: string; dimmed: boolean };
  /** The line under Generate; nothing for a paid render, whose price is on the button. */
  cost: string | null;
  /** The balance while it is below the price: Generate turns red, carries it, and its press opens Add funds (Kev, 2026-10-13). */
  short: string | null;
  generate: () => void;
  /** Open while a paid render waits on the low-balance question. */
  funds: { balanceUsd: number; totalUsd: string } | null;
  tryAnyway: () => void;
  closeFunds: () => void;

  jobs: Job<ImageSetup>[];
  /**
   * Regenerate (a finished job: its setup back in the composer, the same job
   * again, handoff §0) and Retry (a failed one goes, its setup runs at the
   * front), checked against the job's own price as Generate is against the chip's.
   */
  again: (job: Job<ImageSetup>, price: JobPrice) => void;
  /** This tab's renders, newest first. */
  queue: Shot[];
  examples: Shot[];
  community: Shot[];
  /** The viewer's own renders of this prompt, none still in the queue. */
  history: Shot[];
  /** Every finished image in page order: what the viewer pages through. */
  finished: Shot[];
  /** The image on the stage. */
  main: Shot | null;
  /** Puts an image on the stage; a job's values load into the fields. */
  select: (shot: Shot) => void;
  /** A finished render was shown (stage or viewer). */
  seen: (shot: Shot) => void;
  /** Takes a render of this tab out of the queue while its request has not gone out (Kev, 2026-10-13). */
  cancel: (shot: Shot) => void;
  historyState: { loading: boolean; failed: boolean; retry: () => void; more: boolean; loadingOlder: boolean; loadOlder: () => void };
  setPublic: (row: GenerationRow, on: boolean) => Promise<void>;
  /** Shows the references of one of the viewer's public renders beside it, or stops (DEC-514). */
  setReferencesPublic: (row: GenerationRow, on: boolean) => Promise<void>;

  likes: { count: number; mine: boolean } | null;
  toggleLike: () => void;
  discussion: { data: Discussion | undefined; error: string | null; retry: () => void };
  /** A comment ({body}) or a review ({imageId, rating?, body?}); true once the server took it. */
  post: (payload: { body?: string; rating?: number; imageId?: string }) => Promise<boolean>;
  /** The viewer's own recorded renders of this prompt: what a review may show (Kev, 2026-10-13). */
  reviewable: Shot[];
  /** The review composer opens once the viewer has an image of this prompt (checked here only, plan §5 #19). */
  canPost: boolean;
  /** Saved in any of the viewer's bookmark categories, including before this visit. */
  saved: boolean;
  memberships: readonly Membership[];
  /** BookmarkPicker's onChange. */
  bookmarked: (kind: "added" | "removed", category: string) => void;
}

/* A minute clock for "2h ago": read through the store, never in render. */
const minuteNow = () => Math.floor(Date.now() / 60_000) * 60_000;
const everyMinute = (tick: () => void) => {
  const t = setInterval(tick, 60_000);
  return () => clearInterval(t);
};

/** Focuses a field's input, or its token in the [ ] view, once the render it waits for is in (R11: Generate points at it). */
export function focusField(key: string) {
  requestAnimationFrame(() => {
    const at = document.querySelector<HTMLElement>(`[data-iv-field="${CSS.escape(key)}"]`);
    (at?.matches("button, [contenteditable]") ? at : at?.querySelector<HTMLElement>("textarea, input, button"))?.focus();
  });
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function useImageViewModel(seed: ImageViewSeed | "blank"): ImageViewModel {
  const blank = seed === "blank";
  const s = blank ? null : seed;
  const promptId = s?.promptId ?? null;
  const queryClient = useQueryClient();
  const { access, role, userId } = useBetaAccess();
  const guest = !(access === "ok" && role !== "team");
  const { userKey, payer } = useViewerWallets();
  const now = useSyncExternalStore(everyMinute, minuteNow, () => 0);

  /* ── The prompt. The default fetcher (viewerHeaders) under this key: the
     feed reads its state to drop a card that answered 404. */
  const promptQ = useQuery<{ prompt: PromptRecord }>({ queryKey: [`/api/prompts/${promptId}`], enabled: !!promptId });
  const prompt = promptQ.data?.prompt;
  const status: Status = blank ? "ready" : loadState(promptQ);
  const handle = s?.artist?.handle || null;
  const creatorQ = useQuery<{ creator?: { username?: string; displayName?: string } }>({
    queryKey: [`/api/creators/${prompt?.creator_id}/profile`],
    enabled: !!prompt?.creator_id && !handle,
  });
  const artistHandle = handle ?? creatorQ.data?.creator?.username ?? null;
  const artistName = s?.artist?.name ?? creatorQ.data?.creator?.displayName ?? null;

  const premium = !!prompt && !isFreePrompt(prompt);
  const isVideo = prompt?.mediaType === "video";
  const textMissing = !blank && !!prompt && !premium && prompt.publicPromptText == null;
  const publicText = blank ? "" : premium || textMissing ? null : (prompt?.publicPromptText ?? null);
  const variables = prompt?.promptData?.variables ?? [];

  /* ── The composer. Values are the prompt's defaults under the buyer's own
     edits, derived on every render: nothing is copied into state. */
  const [edited, setEdited] = useState<string | null>(null);
  const [view, setView] = useState<"text" | "filled">("filled");
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const grow = useGrowOnly();
  const text = edited ?? publicText;
  const segments: Segment[] | null = text === null ? null : parseSegments(text, variables);
  const fields = fieldsFor(variables, segments);
  const defaults = initialValues(variables);
  const values = { ...defaults, ...overrides };
  const setValue = (key: string, v: string) => setOverrides((o) => ({ ...o, [key]: v }));

  // Pollinations (the free host) for admins only (lib/ui/image-view/models forViewer).
  const catalogue = forViewer(useModelCatalogue(), role);
  const [pick, setPick] = useState("");
  // The generators the artist put on offer (the editor's multi-select); every one before that list existed.
  // A free prompt runs on every generator, whatever its list says (Kev, 2026-10-14: "for all free images, always").
  const offered = premium ? offeredModels(prompt?.ai_settings) : [];
  const models = modelOptions(catalogue, premium, offered);
  const modelName = defaultModel({ catalogue, pick, aiModel: prompt?.ai_model, premium, offered });
  const video = useVideoPrompt({ on: isVideo, catalogue, pick, prompt, premium, offered, promptId, guest });
  const core = useGenerationCore(modelName || undefined);
  const entry = core.entry;
  const [ratioPick, setRatio] = useState("");
  const [resPick, setResolution] = useState("");
  const [quality, setQuality] = useState<Quality>("medium");
  const [boost, setBoost] = useState(false);
  const [countPick, setCount] = useState(1);
  // The daily free allowance is one image, so a free generator makes one at a time.
  const countMax = entry?.free ? 1 : COUNT_MAX;
  const count = Math.min(Math.max(1, countPick), countMax);
  const ratio = core.clampRatio(ratioPick || prompt?.aspect_ratio || "1:1");
  const resolution = core.clampTier(resPick || prompt?.resolution || "2K");
  // A blank composer (Create > Image, the launcher) has no prompt to go back to, so no ↺ (Kev, 2026-10-30: "Set back to
  // the prompts settings bei studio image generators macht keinen sinn. remove that function there fully").
  const settingsChanged = !blank && (modelName !== defaultModel({ catalogue, pick: "", aiModel: prompt?.ai_model, premium, offered })
    || ratio !== core.clampRatio(prompt?.aspect_ratio || "1:1") || resolution !== core.clampTier(prompt?.resolution || "2K")
    || (core.supportsQuality && quality !== "medium"));
  const resetSettings = () => {
    setPick("");
    setRatio("");
    setResolution("");
    setQuality("medium");
  };

  const [refs, setRefs] = useState<{ id: string; src: string }[]>([]);
  const [uploads, setUploads] = useState<{ id: string; src: string }[]>([]);
  const reads = useReferenceReads();
  const cap = refCap(entry);
  // The photo places the text names ("Reference image k", README §5.1); a premium text never reaches the client.
  const textSlots = text === null ? 0 : slotCount(text);
  const plain = text !== null && !blank && fields.length === 0;
  const photoless = plain && textSlots === 0;
  const photosOff = premium && prompt?.allowReferences === false;
  // Nothing shows a photo for a prompt that names none, so none travels, is priced or blocks Generate: not the
  // creator's, not an old render's, not one whose place the buyer reworded away (kept for "Reset").
  const sent = photoless || photosOff ? [] : refs;
  const slots = refSlots(cap, sent.length, photoless || photosOff ? 0 : reads.pending.length);
  const slotTotal = Math.min(MAX_SLOTS, Math.max(1, textSlots, refs.length + reads.pending.length));
  const photosNeeded = Math.max(0, Math.min(textSlots, cap) - refs.length - reads.pending.length);
  /** Photos past the slots the text names each get a reference, after the last one or at `at`, so the text stays in step. */
  const growText = (total: number, at?: number) => {
    if (text === null || total <= textSlots) return;
    setEdited(at === undefined ? (resizeSlots(initialSlots(text), total).text ?? text) : refsAt(text, total, at));
  };
  const { accept } = useModelLimits(entry?.id);
  /* The creator's own reference images stand in the slots once their prompt
     is back in the view, in the order it was released with, ready to be
     swapped for others (Kev, 2026-10-13: "weiterhin alle reference images
     gezeigt werden, was ich dann ändern kann"); read into data once, as every
     reference travels. Never over images the viewer added first. */
  const seeded = useRef<string | null>(null);
  const before = prompt?.beforeImages;
  const readRef = reads.read;
  useEffect(() => {
    if (!promptId || !before?.length || seeded.current === promptId) return;
    seeded.current = promptId;
    void Promise.all(before.map(({ url }) =>
      fetch(url).then((res) => (res.ok ? res.blob() : null)).catch(() => null).then((blob) => (blob ? readRef(blob) : null)),
    )).then((data) => {
      const got = data.flatMap((src) => (src ? [{ id: crypto.randomUUID(), src }] : []));
      if (got.length) setRefs((r) => (r.length ? r : got));
    });
  }, [promptId, before, readRef]);

  const composer = {
    promptId: promptId ?? undefined,
    title: prompt?.title,
    publicText,
    edited,
    variables,
    values,
    model: entry,
    resolution,
    aspectRatio: ratio,
    quality,
    // Off, as no control shows it: Regenerate and Recreate never copy it from a boosted render (plan C1; Kev 2026-10-26:
    // "dass wir boost erstmal eh nicht haben").
    boost,
    refs: sent.map((r) => r.src),
  };
  const setup = isVideo ? null : makeSetup(composer);

  /* ── Prices: the chip prices exactly the job Generate would send; the
     menus price each option at the current settings. Guests get none (the
     quote route needs a session, plan §5 #14). */
  const quote = useComposerQuote(guest || !setup ? null : quoteOf(setup));
  // Until the server answers, the catalogue's estimate lets Generate go (Kev, 2026-10-13); the chip reads … (2026-10-29).
  const quoted = quote.quote ?? (guest ? null : estimatedQuote(setup?.model));
  const ask = (m: CatalogueEntry, res: ResolutionTier, q: Quality = quality): QuoteRequest => ({
    promptId: promptId ?? undefined,
    modelId: m.id,
    resolution: res,
    quality: m.supportsQuality ? q : undefined,
    boost: boost && boostAt(m, res),
    referenceImageCount: sent.length,
  });
  const fit = (m: CatalogueEntry) => {
    const tiers = tiersUpTo(m.maxResolution);
    return tiers.includes(resolution) ? resolution : tiers[tiers.length - 1];
  };
  const priced = guest || isVideo ? [] : models.filter((m) => !m.free).slice(0, 24);
  const pricedQuotes = useServerQuotes(priced.map((m) => ask(m, fit(m))));
  const paidEntry = !guest && !isVideo && entry && !entry.free ? entry : null;
  const tierPrices = useServerQuotes(paidEntry ? core.tiers.map((t) => ask(paidEntry, t.tier)) : []);
  const qualityPrices = useServerQuotes(paidEntry?.supportsQuality ? QUALITIES.map((q) => ask(paidEntry, resolution, q)) : []);

  const holdings = useHoldings(payer);
  const balance = guest ? null : balanceView({ payer, ready: holdings.ready, balance: holdings.balance, free: core.free, quote: quoted, count });

  /* ── The queue. Leaving says where the renders went; the server keeps them all. A finished render announces itself
     wherever the reader is by then (RenderNotices, Kev 2026-10-26): its request outlives this view. */
  const queue = useRenderQueue<ImageSetup>({
    freeModelSelected: !guest && entry?.free === true,
    quotaKey: guest ? null : userId,
    toRequest,
    onLeave: (jobs) => {
      const said = leaveSummary(jobs, blank ? "My Gallery" : "History");
      if (said) notify(said);
      void queryClient.invalidateQueries({ queryKey: ["user-generations"] });
    },
    onReady: (id, imageUrl) => {
      announceRender({ key: `job:${id}`, src: imageUrl, promptId, title: blank ? "New image" : (prompt?.title ?? s?.title ?? "") });
      // Its row is new: a History read before it (on leaving, on opening this prompt again) reads afresh.
      void queryClient.invalidateQueries({ queryKey: ["user-generations"] });
    },
  });
  const { jobs, runBatch, markSeen } = queue;
  // The account first: an email, Google or X login without a wallet has no wallet key, and its renders vanished after a reload (Kev, 2026-10-21).
  const own = useOwnRenders({ userKey: guest ? null : (userId ?? userKey), promptId, jobs });

  /* ── Generate: the first reason it cannot go yet, said on the press (R11). */
  const gate = ((): { label: string; why: string | null; field?: Field; add?: true } => {
    if (guest) return { label: "Log in to generate", why: null };
    if (isVideo) {
      if (!video.available) return { label: GENERATE, why: VIDEO_NOT_AVAILABLE };
      if (textMissing) return { label: GENERATE, why: "This prompt's text could not load. Try again later." };
      const missing = missingRequired(fields, values);
      if (missing) return { label: GENERATE, why: `Fill in ${missing.label} first`, field: missing };
      return { label: GENERATE, why: null };
    }
    if (!setup) return { label: "Pick a generator", why: "Pick a generator first" };
    if (photosNeeded) return { label: `Add ${plural(photosNeeded, "photo")}`, why: null, add: true };
    if (textMissing) return { label: GENERATE, why: "This prompt's text could not load. Try again later." };
    if (reads.loading) return { label: "Loading images…", why: REFS_LOADING };
    if (slots.over) {
      return { label: `Remove ${plural(slots.over, "reference image")}`, why: `${setup.model.name} takes ${cap ? `at most ${plural(cap, "reference image")}` : "no reference images"}` };
    }
    if (quote.unavailable) return { label: "No longer available", why: "This prompt is no longer available" };
    const field = missingRequired(fields, values);
    if (field) return { label: GENERATE, why: `Fill in ${field.label} first`, field };
    const refusal = text === null ? null : promptRefusal(setup.prompt, !setup.model.free);
    if (refusal) return { label: GENERATE, why: refusal };
    if (balance && !holdings.ready) return { label: GENERATE, why: BALANCE_LOADING };
    if (setup.model.free && !queue.freeQuota) return { label: GENERATE, why: "Checking your daily free image allowance…" };
    if (setup.model.free && queue.freeQuota?.exhausted) return { label: "Choose a paid generator", why: "Your daily free image has been used. Choose a paid generator to keep going." };
    return { label: GENERATE, why: null };
  })();

  /** A job (`n` of it, one batch) goes in front of the others; the image on the stage stays (handoff §0), unless there was none. */
  const start = (job: ImageSetup, retried?: string, n = 1) => {
    setSelected((k) => k ?? main?.key ?? null);
    if (retried) queue.retry(retried);
    else runBatch(Array.from({ length: n }, () => job));
    // The shell's menu folds to its rail as a job starts (Kev, 2026-10-30: "... wenn ich anfange zu ... generieren").
    window.dispatchEvent(new Event(GENERATION_START_EVENT));
  };
  const [funds, setFunds] = useState<{ balanceUsd: number; totalUsd: string; go: () => void } | null>(null);
  // Red only once the images are in: a loading button that is also red reads as broken (Kev, 2026-10-14).
  const short = balance?.short && !reads.loading ? balance.text : null;
  const generate = () => {
    if (guest) return openLogin();
    // "Add N photos": the photo area opens its picker (README §5.6); nothing is generated or charged.
    if (gate.add) return void window.dispatchEvent(new Event(ADD_PHOTOS_EVENT));
    // Red button: the balance is below the price, so the press goes to Add funds (Kev, 2026-10-13).
    if (short !== null) return openAddFunds();
    if (gate.why) {
      if (gate.why === BALANCE_LOADING) refreshHoldings();
      notify(gate.why);
      if (gate.field) focusField(gate.field.key);
      return;
    }
    // One press, one video: a premium prompt's words are the artist's, filled on the server.
    if (isVideo) {
      const asked = makeSetup({ ...composer, model: video.entry });
      window.dispatchEvent(new Event(GENERATION_START_EVENT));
      return void video.press(premium ? undefined : asked?.prompt, asked?.variableValues as Record<string, unknown> | undefined);
    }
    const job = makeSetup(composer);
    if (!job) return;
    if (tooLargeToSend(toRequest(job))) return notify(REFS_TOO_LARGE, { tone: "error" });
    start(job, undefined, count);
  };

  // A paid render says nothing under the button: its price is on it (Kev, 2026-10-13).
  const cost = (() => {
    if (guest) return "Sign in to see the price";
    if (isVideo) return video.available ? video.line : VIDEO_NOT_AVAILABLE;
    if (!entry) return "Pick a generator";
    if (!entry.free) return null;
    const yours = blank ? "" : "Open prompt · ";
    return queue.freeQuota?.exhausted ? "Your daily free image is used. Pick a paid generator to continue." : queue.note ? `${quotaText(queue.note)} · pick another generator to keep going` : queue.freeQuota ? `${yours}${entry.name} · ${queue.freeQuota.remaining} daily free image available` : "Checking your daily free image allowance…";
  })();

  /** A job's values back into the fields (only growing them); with `settings`, its generator and settings too (Regenerate). */
  const loadSetup = (job: ImageSetup, settings: boolean) => {
    setOverrides(job.values);
    setEdited(job.edited);
    grow.hold([PROMPT_KEY, ...Object.keys(job.values)]);
    if (!settings) return;
    setPick(job.model.name);
    setRatio(job.aspectRatio);
    setResolution(job.resolution);
    if (job.quality) setQuality(job.quality);
    // The same pictures keep their ids, so the picker's tiles still read as in the prompt (review 2026-10-29, DEC-506).
    setRefs(job.refs.map((src) => ({ id: [...refs, ...uploads].find((r) => r.src === src)?.id ?? crypto.randomUUID(), src })));
  };

  const again = (job: Job<ImageSetup>, price: JobPrice) => {
    if (guest) return openLogin();
    if (job.status === "failed" && job.error?.payment) return queue.retry(job.id);
    const step = againStep(job.setup, price, { payer, ready: holdings.ready, balance: holdings.balance });
    if (step.why) return notify(step.why);
    const retried = job.status === "failed" ? job.id : undefined;
    if (!retried) loadSetup(job.setup, true);
    const go = () => {
      start(job.setup, retried);
      if (!retried) notify("Regenerating with the same setup");
    };
    if (step.funds) return setFunds({ balanceUsd: holdings.balance, totalUsd: step.funds.totalUsd, go });
    go();
  };

  /* ── Images: this tab's renders, the creator's examples, public images
     made with the prompt (none of the viewer's own: those are in the queue
     or the history), and the viewer's history. */
  const imagesQ = useQuery<{ id: string; url: string; thumbnailUrl?: string; maker?: Maker; references?: string[] }[]>({
    queryKey: ["prompt-public-images", promptId],
    queryFn: async () => {
      const res = await fetch(`/api/prompts/${encodeURIComponent(promptId as string)}/images`, { headers: viewerHeaders() });
      return res.ok ? ((await res.json()).images ?? []) : [];
    },
    enabled: !!promptId,
    staleTime: 30_000,
  });
  const jobShots: Shot[] = jobs.map((j) => {
    const record = j.imageUrl ? recordOf(own.rows, j.imageUrl) : undefined;
    // Its tile is a thumb once the render is recorded: it loaded the whole picture for 64 px (review 2026-11-02).
    return {
      key: `job:${j.id}`, kind: "job", src: j.imageUrl, thumb: record?.thumbnail_url ?? j.imageUrl, original: j.imageUrl,
      ratio: j.setup.aspectRatio, job: j, record,
    };
  });
  // The stage and the strips show the WebP renditions; Download hands over the original (Kev, 2026-10-16).
  // An example's stage and tile load small renditions where they exist; fullscreen keeps the preview (Kev, 2026-11-02).
  const examples: Shot[] = (prompt?.showcaseImages ?? []).map(({ url, preview, thumb, view, tiny, references }, i) => ({
    key: `example:${i}`, kind: "example", src: preview ?? url, stage: view, thumb: tiny ?? thumb ?? preview ?? url, original: url, ratio: prompt?.aspect_ratio ?? null, references,
    ...(i === 0 && isVideo && prompt?.showcaseVideo ? videoShot(prompt.showcaseVideo) : {}),
  }));
  /* A render of this tab joins the history as soon as it is recorded (Kev,
     2026-10-13): the rail's entry is then the queue's own shot, same key, with
     the row's time, so picking either lands on one stage image. */
  const madeVideos = new Set(video.delivered.map((j) => j.imageId));
  const history: Shot[] = [...video.delivered.flatMap((j): Shot[] => (j.video ? [{
    key: `video:${j.id}`, kind: "history", src: j.video.poster, thumb: j.video.poster, original: j.video.v720, ratio: null, createdAt: j.createdAt, ...videoShot(j.video),
  }] : [])), ...own.history.filter((r) => !madeVideos.has(r.id)).map((r): Shot => {
    const queuedShot = jobShots.find((s) => s.record?.id === r.id);
    return queuedShot ? { ...queuedShot, createdAt: r.created_at } : {
      key: `history:${r.id}`, kind: "history", src: r.image_urls[0] ?? r.image_url ?? undefined,
      thumb: r.thumbnail_url ?? r.image_urls[0] ?? r.image_url ?? undefined, original: r.image_url ?? r.image_urls[0],
      ratio: null, record: r, createdAt: r.created_at,
    };
  })];
  // Public images made with the prompt; the viewer's own among them are their history entries (publicShots).
  const community: Shot[] = publicShots(imagesQ.data ?? [], own.rows, history, (im) => (
    { key: `community:${im.id}`, kind: "community", src: im.url, thumb: im.thumbnailUrl || im.url, original: im.url, ratio: null, publicId: im.id, maker: im.maker, references: im.references }
  ));
  const all = [...jobShots, ...examples, ...community, ...history];

  const [selected, setSelected] = useState<string | null>(null);
  const main =
    all.find((x) => x.key === selected) ??
    (selected?.startsWith("job:") ? jobShots[0] : undefined) ?? // a retried job's successor
    examples[0] ?? jobShots[0] ?? null;

  /** Marks a finished render seen once it is on the stage or in the viewer; a public image shown there counts as watched (DEC-518). */
  const seen = (x: Shot) => {
    if (x.job?.status === "ready" && !x.job.seen) markSeen(x.job.id);
    if (x.publicId) countImageOpen(x.publicId);
  };
  /* The references a recorded render was sent, read into data as every
     reference travels (Kev, 2026-10-14: "the settings with its reference
     image used for that image is being shown on the left side"); a render
     made without any clears the slots. Only the latest pick lands. */
  const refLoad = useRef(0);
  const loadRecordedRefs = (urls: string[]) => {
    const n = ++refLoad.current;
    if (!urls.length) return setRefs([]);
    void Promise.all(urls.map((url) =>
      fetch(url).then((res) => (res.ok ? res.blob() : null)).catch(() => null).then((blob) => (blob ? readRef(blob) : null)),
    )).then((data) => {
      // By address, as addUrls puts them in: the picker's tiles read as in the prompt.
      if (refLoad.current === n) setRefs(data.flatMap((src, i) => (src ? [{ id: urls[i], src }] : [])));
    });
  };
  /* The image brings its own generator and settings along (Kev, 2026-10-13:
     "the generator that the image was created with as the default, with the
     ratios etc"): a job its whole setup, a creator example the prompt's own,
     a recorded render what GET /api/generations says it was made with. */
  const select = (x: Shot) => {
    setSelected(x.key);
    const recorded = x.record?.settings;
    if (x.job) loadSetup(x.job.setup, true);
    else if (recorded) {
      const own = recorded.modelId ? catalogue.find((m) => m.id === recorded.modelId) : undefined;
      if (own) setPick(own.name);
      setRatio(recorded.aspectRatio ?? "");
      setResolution(recorded.resolution ?? "");
      loadRecordedRefs(recorded.references ?? []);
      // Its values too (README §5.4: a render loads its values, settings and photos); the fields only grow while browsing.
      const made = x.record?.variable_values;
      if (made) {
        setOverrides(made);
        grow.hold(Object.keys(made));
      }
    } else if (x.kind === "example") {
      setPick("");
      setRatio("");
      setResolution("");
    }
    seen(x);
  };

  /* Recreate (Kev, 2026-10-15): opened from the gallery for one recorded render, the
     composer takes that render's settings and references as soon as its row is in. */
  const recreateId = s?.recreateImageId ?? null;
  const recreated = useRef<string | null>(null);
  useEffect(() => {
    if (!recreateId || recreated.current === recreateId) return;
    const shot = history.find((x) => x.record?.id === recreateId);
    if (!shot) return;
    recreated.current = recreateId;
    // After the commit, like a click on the rail: the selection sets several states at once.
    const t = setTimeout(() => select(shot), 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recreateId, history.length]);

  /** Shows one of the viewer's images to others, or hides it again; the rows that show it follow. */
  const setPublic = async (row: GenerationRow, on: boolean) => {
    const res = await fetch(`/api/images/${encodeURIComponent(row.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...sessionAuthHeaders() },
      body: JSON.stringify({ visibility: on ? "public" : "private" }),
    }).catch(() => null);
    if (!res?.ok) {
      const d = await res?.json().catch(() => null);
      return notify(d?.error ?? "Couldn't change who sees this image", { tone: "error" });
    }
    void queryClient.invalidateQueries({ queryKey: ["user-generations"] });
    void queryClient.invalidateQueries({ queryKey: ["prompt-public-images"] });
  };
  const setReferencesPublic = async (row: GenerationRow, on: boolean) => {
    const res = await fetch(`/api/images/${encodeURIComponent(row.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...sessionAuthHeaders() },
      body: JSON.stringify({ references: on }),
    }).catch(() => null);
    if (!res?.ok) {
      const d = await res?.json().catch(() => null);
      return notify(d?.error ?? "Couldn't change who sees the references", { tone: "error" });
    }
    void queryClient.invalidateQueries({ queryKey: ["user-generations"] });
    void queryClient.invalidateQueries({ queryKey: ["prompt-public-images"] });
  };

  /* ── Likes, comments and ratings. */
  const likesKey = ["prompt-likes", promptId];
  const likesQ = useQuery({
    queryKey: likesKey,
    queryFn: () => loadLikes(promptId as string, sessionAuthHeaders()),
    enabled: !!promptId,
  });
  const toggleLike = async () => {
    const was = likesQ.data;
    if (!promptId || !was) return;
    queryClient.setQueryData(likesKey, { count: was.count + (was.mine ? -1 : 1), mine: !was.mine });
    const res = await fetch(`/api/prompts/${encodeURIComponent(promptId)}/likes`, { method: "POST", headers: sessionAuthHeaders() }).catch(() => null);
    const d = await res?.json().catch(() => null);
    if (res?.ok && d) return queryClient.setQueryData(likesKey, { count: Number(d.count) || 0, mine: !!d.mine });
    queryClient.setQueryData(likesKey, was);
    if (res?.status === 401) notify("Sign in to like.");
    else notify(d?.error ?? "Couldn't save the like", { tone: "error" });
  };

  const talkQ = useQuery<Discussion>({
    queryKey: ["prompt-comments", promptId],
    queryFn: () => loadDiscussion(promptId as string),
    enabled: !!promptId,
    staleTime: 30_000,
  });
  const post = async (payload: { body?: string; rating?: number; imageId?: string }): Promise<boolean> => {
    const res = await fetch(`/api/prompts/${encodeURIComponent(promptId as string)}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...sessionAuthHeaders() },
      body: JSON.stringify(payload),
    }).catch(() => null);
    const d = await res?.json().catch(() => null);
    if (res?.ok) {
      notify(payload.rating || payload.imageId ? (d?.updated ? "Review updated" : "Review posted") : "Comment posted");
      void talkQ.refetch();
      return true;
    }
    if (res?.status === 401) notify("Sign in to comment");
    else notify(res?.status === 429 ? "Slow down a moment" : d?.error ?? "Couldn't post that. Try again.", { tone: "error" });
    return false;
  };

  const bookmarks = useBookmarkIndex(!guest && !!promptId);
  const memberships = !guest && promptId ? bookmarks?.get(promptId) ?? [] : [];

  const model: ImageViewModel = {
    blank,
    promptId,
    status,
    reload: () => void promptQ.refetch(),
    title: blank ? "New image" : (prompt?.title ?? s?.title ?? ""),
    category: blank ? null : (prompt?.category ?? null),
    artist: artistHandle || artistName ? { handle: artistHandle, name: artistName } : null,
    reach: prompt?.sourceReach ?? null,
    premium,
    publicText,
    promptSettings: [defaultModel({ catalogue, pick: "", aiModel: prompt?.ai_model, premium, offered }), prompt?.aspect_ratio, prompt?.resolution]
      .filter((x): x is string => !!x),
    video: null,
    guest,
    balanceUsd: balance && holdings.ready ? holdings.balance : null,
    now,

    /* The prompt and the buyer's values. */
    text,
    textMissing,
    edited: edited !== null,
    setText: (t: string) => setEdited(t),
    resetText: () => setEdited(null),
    view,
    setView,
    segments,
    plain,
    photoless,
    photosOff,
    fields,
    variables,
    values,
    setValue,
    changed: (key: string) => (values[key] ?? "") !== (defaults[key] ?? ""),
    resetValue: (key: string) =>
      setOverrides((o) => {
        const next = { ...o };
        delete next[key];
        return next;
      }),
    growOnly: grow.isHeld,
    release: grow.release,
    copyPrompt: () =>
      copyText(clipboardText({ view, text, variables, values }), text === null ? "Your values copied" : "Prompt copied"),
    addVariable: (range: VariableRange) => {
      const t = text ?? "";
      setEdited(`${t.slice(0, range.start)}[${range.name}]${t.slice(range.end)}`);
      const key = matchVariable(variables, range.name)?.name ?? range.name;
      setValue(key, range.name);
      focusField(key);
    },

    /* Generator and settings. */
    core,
    models,
    modelPrices: models.map((m) => pricedQuotes[priced.indexOf(m)] ?? null),
    pickModel: (id: string) => setPick(catalogue.find((m) => m.id === id)?.name ?? ""),
    ratio,
    setRatio,
    resolution,
    setResolution: (t: ResolutionTier) => setResolution(t),
    tierPrices,
    quality,
    setQuality,
    qualityPrices,
    boost,
    setBoost,

    /* References. */
    refs,
    pending: reads.pending,
    cap,
    room: slots.room,
    over: slots.over,
    accept,
    slotTotal,
    photosNeeded,
    addFiles: (files: File[], at?: number) => {
      const take = files.slice(0, slots.room);
      growText(refs.length + reads.pending.length + take.length, at);
      take.forEach(async (f) => {
        const src = await reads.read(f);
        if (!src) return notify("Couldn't read that image", { tone: "error" });
        // It lands in the picker too, selected: deselecting it there takes it out of the prompt again (DEC-506).
        const ref = { id: crypto.randomUUID(), src };
        setUploads((u) => [...u, ref]);
        setRefs((r) => [...r, ref]);
      });
    },
    addUrls: (urls: string[], at?: number) => {
      const take = urls.slice(0, slots.room);
      growText(refs.length + reads.pending.length + take.length, at);
      take.forEach(async (url) => {
        // Pending from the pick on: Generate waits through the download too.
        const src = await reads.read(url);
        // Its address is its id, so the picker's tile knows it is in the prompt.
        if (src) setRefs((r) => [...r, { id: url, src }]);
        else notify("Couldn't read that image", { tone: "error" });
      });
    },
    myImages: pastImages(own.rows),
    uploads,
    // The account's saved references are Create > Video's (Kev, 2026-10-30: "i only want these ref images for videos pls
    // not for images"; "hier werden aber ref content gespeichert"): the image view saves none and lists none.
    library: [],
    deletedRefs: [],
    deleteRef: (id: string) => setUploads((u) => u.filter((x) => x.id !== id)),
    toggleRef: (key: string, at?: number) => {
      const i = refs.findIndex((r) => r.id === key);
      if (i >= 0) return model.removeSlot(i);
      if (slots.room <= 0) return;
      const up = uploads.find((u) => u.id === key);
      // A second press while its download still runs adds nothing (it would land twice).
      if (!up) return reads.pending.some((p) => p.startsWith(`${key}#read-`)) ? undefined : model.addUrls([key], at);
      growText(refs.length + reads.pending.length + 1, at);
      setRefs((r) => [...r, up]);
    },
    addNfts: (picks: NftPick[], at?: number) => {
      growText(refs.length + reads.pending.length + picks.length, at);
      picks.forEach(async (p) => {
        const src = await reads.read(p);
        if (src) setRefs((r) => [...r, { id: crypto.randomUUID(), src }]);
        else notify("NFT image unavailable", { tone: "error" });
      });
    },
    removeSlot: (i: number) => {
      if (i < refs.length) setRefs((r) => r.filter((_, j) => j !== i));
      if (text !== null && i < textSlots && textSlots > 1) setEdited(dropSlot(initialSlots(text), i + 1).text ?? text);
    },
    replacePhoto: (i: number, f: File) => {
      void reads.read(f).then((src) => {
        if (!src) return notify("Couldn't read that image", { tone: "error" });
        // An upload like any other: it lands in the picker too.
        const ref = { id: crypto.randomUUID(), src };
        setUploads((u) => [...u, ref]);
        setRefs((r) => r.map((x, j) => (j === i ? ref : x)));
      });
    },

    /* Price and Generate. */
    setup,
    quote: quoted,
    quotePending: quote.pending,
    chip: chipLabel({ signedIn: !guest, free: core.free, quote: quoted, pending: quote.pending, count }),
    perImage: chipLabel({ signedIn: !guest, free: core.free, quote: quoted, pending: quote.pending }),
    count,
    countMax,
    setCount,
    settingsChanged,
    resetSettings,
    button: { label: gate.label === GENERATE && count > 1 ? `${GENERATE} ${count}` : gate.label, dimmed: gate.why !== null },
    cost,
    short,
    generate,
    funds: funds && { balanceUsd: funds.balanceUsd, totalUsd: funds.totalUsd },
    tryAnyway: () => funds?.go(),
    closeFunds: () => setFunds(null),

    /* The queue and the images. */
    jobs,
    again,
    queue: jobShots,
    examples,
    community,
    history,
    // Each key once: a recorded render is in the queue and in the history under the same key.
    finished: [...new Map(all.filter((x) => x.src).map((x) => [x.key, x])).values()],
    main,
    select,
    seen,
    cancel: (shot) => { if (shot.job) queue.cancel(shot.job.id); },
    historyState: { loading: own.loading, failed: own.failed, retry: own.retry, more: own.more, loadingOlder: own.loadingOlder, loadOlder: own.loadOlder },
    setPublic,
    setReferencesPublic,

    /* Likes, discussion, bookmark. */
    likes: likesQ.data ?? null,
    toggleLike,
    discussion: { data: talkQ.data, error: talkQ.error?.message ?? null, retry: () => void talkQ.refetch() },
    post,
    // Recorded, so each carries its generated_images id, which the server checks against the reviewer.
    reviewable: all.filter((x) => x.record && x.thumb),
    canPost: !guest && hasGenerated(jobs, own.history),
    saved: memberships.length > 0,
    memberships,
    bookmarked: (kind: "added" | "removed", category: string) => {
      notify(kind === "added" ? `Saved to ${category}` : `Removed from ${category}`);
    },
  };
  /* A video prompt: its own generators, prices and settings, no count (ComposeFoot; Kev, 2026-11-03: "allow also only the
     creation of 1 video for premium prompts"), no photos until its route takes them. Laid over the rest here, so what an
     image prompt reads stays line for line as it was. */
  return !isVideo ? model : {
    ...model,
    video: { foot: video.foot },
    models: video.models,
    core: { ...core, entry: video.entry },
    modelPrices: video.modelPrices,
    promptSettings: [video.ownName, prompt?.aspect_ratio, prompt?.resolution].filter((x): x is string => !!x),
    settingsChanged: video.changed,
    resetSettings: () => { resetSettings(); video.reset(); },
    chip: video.chip,
    perImage: video.chip,
    quotePending: video.pending,
    photosOff: true,
    room: 0,
    photosNeeded: 0,
  };
}

/**
 * Regenerate (a finished job) or Retry (a failed one that cannot have been
 * charged); null for any other job. Its own server price, which the button
 * shows and waits for (spec-imageview-mobile D10): the chip prices the
 * composer, which may have moved on since the job ran.
 */
export function useAgain(m: ImageViewModel, job: Job<ImageSetup> | undefined) {
  const existingPayment = job?.status === "failed" && !!job.error?.payment;
  const ok = !!job && (job.status === "ready" || job.error?.charged === "no" || existingPayment);
  const price = useComposerQuote(ok && !existingPayment && !m.guest ? quoteOf(job.setup) : null);
  if (!ok) return null;
  const free = job.setup.model.free;
  // The job's own price, the catalogue's estimate until the server answers.
  const priced = { ...price, quote: price.quote ?? (m.guest ? null : estimatedQuote(job.setup.model)) };
  return {
    label: existingPayment ? "Check payment" : job.status === "ready" ? "Regenerate" : "Retry",
    price: existingPayment ? null : chipLabel({ signedIn: !m.guest, free, quote: priced.quote, pending: price.pending }),
    ready: existingPayment || free || priced.quote !== null,
    press: () => m.again(job, priced),
  };
}

/** The reach's tooltip: the core post's numbers, and the chain's sums when it came through forwards. */
export function reachTitle(r: HuntReach): string {
  const core = `On X: ${r.core.likes} likes, ${r.core.reposts} reposts, ${r.core.quotes} quotes on the original post`;
  return r.chain.posts > 1 ? `${core}; across ${r.chain.posts} posts it was shared through: ${r.chain.likes} likes, ${r.chain.reposts} reposts, ${r.chain.quotes} quotes` : core;
}
