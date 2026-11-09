"use client";

/**
 * The Prompt Editor (plan §2.1; it replaces Create Prompt 1 and 2): write a
 * prompt with [variables] and references, render tests, star the set that
 * shows it best, release it. One tree for every width; prompt-editor.css
 * switches between two columns and the Craft | Verify tabs.
 *
 * Wired only to the backend that exists (plan §5). A test render is the
 * creator's own draft: runGeneration with `authoring`, never a promptId. Every
 * price is a server quote. The draft lives in this browser. The one server
 * write is Release, POST /api/prompt with `release: true`; after the first one
 * the editor stays, on /editor?id=, and the next release updates (R13).
 */
import { useEffect, useEffectEvent, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { useBetaAccess } from "@/components/BetaGate";
import { useStepUp } from "@/components/StepUpProvider";
import { WalletPickerModal } from "@/components/WalletPickerModal";
import NftPickerModal from "@/components/enki/NftPickerModal";
import AddFundsPopover from "@/components/kit/AddFundsPopover";
import Segmented from "@/components/kit/Segmented";
import { notify } from "@/components/kit/notify";
import { useGrowOnly } from "@/components/kit/useGrowOnly";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useDiceRoll } from "@/hooks/useDiceRoll";
import { useGenerationCore } from "@/hooks/useGenerationCore";
import { refreshHoldings, useHoldings } from "@/hooks/useHoldings";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useModelCatalogue, useModelLimits, type CatalogueEntry } from "@/hooks/useModelLimits";
import { useReferenceReads, type NftPick } from "@/hooks/useReferenceReads";
import { useRenderQueue } from "@/hooks/useRenderQueue";
import { quoteLabel, useServerQuotes } from "@/hooks/useServerQuotes";
import { useVideoRoutes } from "@/hooks/useVideoRoutes";
import { useVideoRun } from "@/hooks/useVideoRun";
import { useViewerWallets } from "@/hooks/useViewerWallets";
import {
  editorRequest, editorSetup, generateBlock, readyRefs,
  type EditorSetup, type GenerateBlock, type RenderPicks,
} from "@/lib/editor/generate-checks";
import { insertToken, parseTokens, removeRefAt, varNames } from "@/lib/editor/prompt-tokens";
import { MAX_QUOTES, quoteBatch, quoteIn, quoteRequest } from "@/lib/editor/quote-batch";
import { MAKE_VIDEO_FIRST, listingOnly, mediaOf, namesReference, releaseBlock, releaseBody, starsNeeded, storedRefs, updateBody, type Listing, type ReleaseBody } from "@/lib/editor/release";
import { imageValues, offerShare } from "@/lib/share/after-release";
import { suggestedName, type VariableRange } from "@/lib/editor/selection-variable";
import { starred, toggleStar, variationKey, variations, type Variation } from "@/lib/editor/variations";
import { openLogin } from "@/lib/openLogin";
import { sessionAuthHeaders } from "@/lib/session-headers";
import { COARSE, TABS } from "@/lib/ui/kit/breakpoints";
import { promptPage } from "@/lib/ui/image-view/open-link";
import { openAddFunds } from "@/lib/ui/kit/controls";
import { balanceView, chipLabel, estimatedQuote } from "@/lib/ui/kit/price";
import { parseRatio } from "@/lib/ui/kit/ratio";
import { quotaText } from "@/lib/ui/kit/render-queue";
import { refToken } from "@/lib/ui/kit/tile";
import { videoRowOf } from "@/lib/ui/image-view/video";
import { fillPrompt } from "@/lib/editor/prompt-tokens";
import { VIDEO_MAKING, jobRunning } from "@/lib/video/job-view";
import { videoCanRun, VIDEO_NOT_AVAILABLE, fitSettings, startSettings, videoPrice } from "@/lib/video/models";
import VideoSettingsRow from "@/components/create/video/VideoSettingsRow";
import EditorHeader, { type EditorTab, type PaneProps } from "./EditorHeader";
import GenerateBar from "./GenerateBar";
import GeneratorRow from "./GeneratorRow";
import ListingRow, { modeTitle } from "./ListingRow";
import { useReleaseCommunities } from "@/components/communities/ReleaseCommunities";
import LiveShowcase from "./LiveShowcase";
import LiveStrip from "./LiveStrip";
import { forViewer } from "@/lib/ui/image-view/models";
import PromptField from "./PromptField";
import PullBar from "./PullBar";
import ReferenceStrip from "./ReferenceStrip";
import ReleaseBar from "./ReleaseBar";
import RenderPreview from "./RenderPreview";
import type { EditorJob, TileActs } from "./ResultTile";
import SplitDivider, { useSplit } from "./SplitDivider";
import VariableList from "./VariableList";
import VerifyPane from "./VerifyPane";
import { blankVariable, usePromptEditor, variableFrom } from "./usePromptEditor";
import { promptKey, usePromptLoad } from "./usePromptLoad";
import "./prompt-editor.css";
import "./verify.css";

/** The most references a prompt is saved with (app/api/prompt). */
const SAVE_REFS = 14;
/** The editor's references are read into this visit only; a video's are its saved library's, in Create > Video. */
const VIDEO_REFS_NOT_YET = "References go on a video from Create > Video for now. Take them out to test here.";
/* Video is greyed until it is ready (Kev, 2026-11-08: "deaktivier die video funktion zunächst, also bei create prompt, grau sie aus"). */
const MEDIA = [{ key: "image", label: "Image" }, { key: "video", label: "Video · soon", disabled: true, title: "Video comes later" }] satisfies Array<{ key: NonNullable<Listing["media"]>; label: string; disabled?: boolean; title?: string }>;

/** What Generate runs: the editor as it is, or a job again (Regenerate; Retry takes a failed one's place). */
type Source = { job?: EditorJob; retry?: boolean };
type Ask = { text: string; ok: string; cancel: string; run: () => void };

export const leaveText = (n: number) =>
  `${n} image${n === 1 ? " is" : "s are"} still rendering. They're still charged and saved to your gallery, but won't appear here. Leave?`;

const onResize = (on: () => void) => {
  window.addEventListener("resize", on);
  return () => window.removeEventListener("resize", on);
};
const sameListing = (a: Listing, b: Listing) =>
  a.title === b.title && a.mode === b.mode && a.price === b.price && a.category === b.category && a.modelIds.join() === b.modelIds.join()
  && (a.allowReferences !== false) === (b.allowReferences !== false);
const fieldOf = (name: string, field: "name" | "value") => `[data-pe-name="${CSS.escape(name)}"] [data-pe-field="${field}"]`;

export default function PromptEditor({ promptId }: {
  /** A released prompt of this account to edit (?id=). */
  promptId?: string;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { guarded } = useStepUp();
  const { access, role, userId } = useBetaAccess();
  // Team-cookie browsing is looking around, not an account (EnkiHome).
  const signedIn = access === "ok" && role !== "team";
  const { userKey, payer } = useViewerWallets();
  const id = promptId ?? null;
  const { state, doc, dispatch, commit, store, decideSeed } = usePromptEditor(userKey, id, signedIn ? userId : null);
  const { listing, picks, history } = state;

  const catalogue = useModelCatalogue();
  // Pollinations (the free host) for admins only (lib/ui/image-view/models forViewer).
  const media = mediaOf(listing);
  const isVideo = media === "video";
  const models = useMemo(() => forViewer(catalogue, role).filter((m) => m.mediaType === media), [catalogue, role, media]);
  /* The test generator: the one picked in the bar, else the first on offer; always one this viewer may use, so a draft
     or a prompt made on the free host does not render on it for a non-admin (review 2026-10-26). */
  // An Open video prompt has every row on offer and no picks: the first stands, or Generate has nothing to run on (an image's bar is as it was).
  const core = useGenerationCore([listing.testId, ...listing.modelIds, ...(isVideo && listing.mode === "free" ? models.map((m) => m.id) : [])].find((id) => id && models.some((m) => m.id === id)) ?? undefined);
  /* A free prompt runs on every generator (Kev, 2026-10-14: "all generators
     must be usable, which needs to be displayed"); a premium one on the ones
     picked. The picks stay in the listing while it is free, for a switch
     back, and `effective` is what Release and its checks read. */
  // A free prompt offers every image generator, the admins' free host too: Release checks the starred renders against
  // this list, and a viewer's own earlier renders on it must not block a release they cannot fix (review 2026-10-26).
  const offeredIds = useMemo(() => (listing.mode === "free" ? catalogue.filter((m) => m.mediaType === media).map((m) => m.id) : listing.modelIds), [listing.mode, listing.modelIds, catalogue, media]);
  const effective = useMemo((): Listing => ({ ...listing, modelIds: offeredIds }), [listing, offeredIds]);
  // What the test bar offers: the generators on offer, in catalogue order.
  const offered = models.filter((m) => offeredIds.includes(m.id));
  const test = core.entry;
  const { accept } = useModelLimits(test?.id);
  const cap = Math.min(SAVE_REFS, test?.maxRefs ?? SAVE_REFS);

  const editing = promptId !== undefined;
  const load = usePromptLoad(editing ? promptId : null, catalogue);
  const { loaded } = load;
  if (loaded && state.seeded !== loaded.id) dispatch({ type: "seed", loaded });
  // Its communities, beside the category; set once it is released (send).
  const communities = useReleaseCommunities(editing ? promptId : null, `${listing.title} ${doc.prompt}`);

  const reads = useReferenceReads();
  const queue = useRenderQueue<EditorSetup>({
    toRequest: (s) => editorRequest(s, catalogue, readyRefs(state.refs, s.refIds) ?? []),
    persist: store.jobs,
    freeModelSelected: signedIn && test?.free === true,
    quotaKey: signedIn ? userId : null,
  });
  /* A video's test render (Kev, 2026-11-03: "allow also only the creation of 1 video"): its job lives on the server, and shows here
     as a job of this visit's, with the words and values it was pressed with; its tile and its star are an image's, its picture the
     poster, and the viewer plays it. A reload keeps the video in Create > Video's History, not in Verify: the setup is this visit's. */
  const videoRun = useVideoRun({ enabled: isVideo && signedIn });
  const [videoSetups, setVideoSetups] = useState<Readonly<Record<string, EditorSetup>>>({});
  const videoJobs = useMemo(() => videoRun.jobs.flatMap((v): EditorJob[] => {
    const setup = videoSetups[v.id];
    if (!setup) return [];
    return [{
      id: v.id, createdAt: Date.parse(v.createdAt), status: v.video ? "ready" : jobRunning(v.status) ? "rendering" : "failed", sent: true, setup, seen: true,
      imageUrl: v.video?.poster, videoUrl: v.video?.v720, imageId: v.imageId ?? undefined, error: v.why ? { message: v.why, charged: "no" } : undefined,
    }];
  }), [videoRun.jobs, videoSetups]);
  const jobs = useMemo(() => [...queue.jobs, ...videoJobs], [queue.jobs, videoJobs]);
  const groups = useMemo(() => variations(jobs, state.order), [jobs, state.order]);
  const rendering = jobs.filter((j) => j.status === "rendering").length;

  const tabs = useMediaQuery(TABS);
  const vh = useSyncExternalStore(onResize, () => window.innerHeight, () => 800);
  const { isHeld, hold, release } = useGrowOnly();
  const { measure, split } = useSplit();

  const [tab, setTab] = useState<EditorTab>("craft");
  // Below 1024 px the panes are the tabs' panels (EditorHeader).
  const uid = useId();
  const panes: Record<EditorTab, string> = { craft: `${uid}craft`, verify: `${uid}verify` };
  const pane = (t: EditorTab): PaneProps => ({ id: panes[t], role: tabs ? "tabpanel" : undefined, "aria-labelledby": tabs ? `${panes[t]}-tab` : undefined });
  const [viewer, setViewer] = useState<string | null>(null);
  const [funds, setFunds] = useState<Source | null>(null);
  const [walletOpen, setWalletOpen] = useState(false);
  const [nftOpen, setNftOpen] = useState(false);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [refDrag, setRefDrag] = useState<string | null>(null);
  const [releasing, setReleasing] = useState(false);
  const [openStacks, setOpenStacks] = useState<ReadonlySet<string>>(() => new Set());
  // Names the "+ Variable" pill made up, shown red until the row is edited or left.
  const [suggested, setSuggested] = useState<ReadonlySet<string>>(() => new Set());

  const root = useRef<HTMLDivElement>(null);
  const caretKnown = useRef(false);
  // A release that answers after the editor was left must not bring it back.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // Runs once after the next render: focus a field that is only there now.
  const after = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    const run = after.current;
    after.current = null;
    run?.();
  });

  // ── Prices: one server batch for every figure shown (lib/editor/quote-batch).
  const entryOf = (j: EditorJob) => catalogue.find((m) => m.id === j.setup.modelId);
  const viewerJob = viewer ? jobs.find((j) => j.id === viewer) : undefined;
  const again = viewerJob ?? funds?.job;
  const againAsk = again && entryOf(again)?.mediaType !== "video" ? quoteRequest(entryOf(again), again.setup, again.setup.refIds.length) : null;
  const refCount = doc.refIds.length;
  // A video's prices are its own (useVideoRoutes): never an image quote for a video row.
  const base = isVideo ? [] : quoteBatch(catalogue, test, picks, refCount);
  // The job a viewer may run again is asked too, ahead of the menus (at most MAX_QUOTES).
  const batch = !againAsk || base.some((q) => JSON.stringify(q) === JSON.stringify(againAsk))
    ? base : [againAsk, ...base].slice(0, MAX_QUOTES);
  const quotes = useServerQuotes(signedIn ? batch : []);
  // The catalogue's estimate stands in until the server answers (Kev, 2026-10-13); the intent charges the server's price.
  const price = (entry: CatalogueEntry | undefined, at: RenderPicks, n: number) => quoteIn(batch, quotes, quoteRequest(entry, at, n)) ?? estimatedQuote(entry);
  const chipQuote = price(test, picks, refCount);
  const { balance, ready } = useHoldings(payer);
  const balanceUsd = payer && ready ? balance : null;

  // ── Moving focus, and the tab it sits in.
  const toCraft = (then: () => void) => {
    if (tab === "craft") return then();
    setTab("craft");
    after.current = then;
  };
  const focus = (selector: string) => toCraft(() => root.current?.querySelector<HTMLElement>(selector)?.focus());
  const openMenu = (selector: string) => toCraft(() => root.current?.querySelector<HTMLButtonElement>(`${selector} .kit-pill`)?.click());

  // ── Generate.
  const act = (b: GenerateBlock, from: Source) => {
    if (b.toast) notify(b.toast);
    if (b.check === "balance") refreshHoldings();
    if (b.focus) focus(fieldOf(b.focus.variable, b.check === "values" ? "value" : "name"));
    if (b.open === "login") openLogin();
    if (b.open === "primary") openMenu(".pe-gen-row");
    if (b.open === "wallet") setWalletOpen(true);
    if (b.open === "add-funds") setFunds(from);
  };
  /**
   * Generate, Regenerate and Retry: every check first, and a job only
   * when every one passes (R12). The check that stopped it, or null once the
   * job runs.
   */
  const attempt = (from: Source, lowBalanceOk = false): GenerateBlock | null => {
    const { job } = from;
    if (isVideo || (job && entryOf(job)?.mediaType === "video")) {
      if (!signedIn) { openLogin(); return { check: "login", open: "login" }; }
      // Regenerate and Retry run the job exactly as it was made (D7): its words, its generator, its settings, whatever the bar says now.
      const row = job ? videoRowOf(job.setup.modelName) : videoRow;
      const settings = job ? job.setup.video : videoPicks;
      const toast = job
        ? row && settings && (rateOf(row.id)?.available ?? []).includes(settings.resolution) ? null : VIDEO_NOT_AVAILABLE
        : videoStop ?? (!doc.prompt.trim() ? "Write a prompt first" : null);
      // The tile and a release read the video's own shape and size, not the image pills' left in the draft.
      const setup: EditorSetup | undefined = job?.setup ?? (test && settings ? { ...editorSetup(doc, test, picks), resolution: settings.resolution as EditorSetup["resolution"], ratio: settings.aspect, video: settings } : undefined);
      if (toast || !setup || !row || !settings) {
        notify(toast ?? VIDEO_NOT_AVAILABLE);
        return { check: "generator", toast: toast ?? VIDEO_NOT_AVAILABLE };
      }
      void videoRun.press({ modelId: row.id, settings, words: fillPrompt(setup.prompt, setup.vars) }).then((id) => {
        if (!id) return;
        setVideoSetups((s) => {
          const next = { ...s, [id]: setup };
          // A retry takes the failed one's place.
          if (from.retry && job) delete next[job.id];
          return next;
        });
      });
      return null;
    }
    if (job && from.retry && job.error?.payment) {
      if (!signedIn) { openLogin(); return { check: "login", open: "login" }; }
      if (!job.error.payment.generationSubmitted && readyRefs(state.refs, job.setup.refIds) === null) {
        const toast = "Wait for the reference images before continuing this payment.";
        notify(toast);
        return { check: "refs-ready", toast };
      }
      queue.retry(job.id);
      return null;
    }
    const entry = job ? entryOf(job) : test;
    if (entry?.free && (!queue.freeQuota || queue.freeQuota.exhausted)) {
      const toast = queue.freeQuota?.exhausted ? "Your 2 free images are used. Top up and choose a paid generator to keep going." : "The free allowance could not be checked yet. Please try again.";
      notify(toast);
      return { check: "generator", toast };
    }
    const content = job ? job.setup : doc;
    const at = job ? job.setup : picks;
    const block = generateBlock({
      doc: content,
      refs: state.refs,
      reading: !job && reads.loading,
      signedIn,
      entry,
      picks: at,
      quote: price(entry, at, content.refIds.length),
      wallet: !!payer,
      balanceUsd,
      lowBalanceOk,
    });
    if (block || !entry) {
      if (block) act(block, from);
      return block ?? { check: "generator" };
    }
    const setup = job ? job.setup : editorSetup(doc, entry, picks);
    const variation = variationKey(setup);
    dispatch({ type: "generated", variation });
    if (job && from.retry) queue.retry(job.id);
    else queue.runBatch([setup]);
    // Two columns: Verify shows where it landed. A tab stays on Craft.
    if (!tabs) after.current = () => root.current?.querySelector(`[data-pe-group="${CSS.escape(variation)}"]`)?.scrollIntoView({ block: "nearest" });
    return null;
  };
  const block = isVideo ? null : generateBlock({
    doc, refs: state.refs, reading: reads.loading, signedIn, entry: test, picks, quote: chipQuote,
    wallet: !!payer, balanceUsd, lowBalanceOk: true,
  });

  // ── The doc.
  const createVariable = (range: VariableRange) => {
    const name = suggestedName(range.name, varNames(doc.prompt));
    setSuggested((s) => new Set(s).add(name));
    // The suggestion is selected in its field, so typing replaces it.
    after.current = () => {
      const field = root.current?.querySelector<HTMLInputElement>(fieldOf(name, "name"));
      field?.focus();
      field?.select();
    };
    commit(variableFrom(range, name));
  };
  const named = (name: string) => setSuggested((s) => (s.has(name) ? new Set([...s].filter((n) => n !== name)) : s));
  const addVariable = () => {
    if (varNames(doc.prompt).includes("")) return focus(fieldOf("", "name"));
    after.current = () => root.current?.querySelector<HTMLElement>(fieldOf("", "name"))?.focus();
    commit(blankVariable);
  };
  const promptArea = () => root.current?.querySelector<HTMLTextAreaElement>('[data-pe-field="prompt"]') ?? null;
  /** Where the next token goes: the caret once the field has had it (it keeps it while blurred), else the end. */
  const caretAt = () => {
    const ta = promptArea();
    return caretKnown.current && ta ? ta.selectionEnd : null;
  };
  const addRef = (src: Blob | NftPick) => {
    void reads.read(src).then((data) => {
      if (!data) return notify("That image couldn't be read", { tone: "error" });
      const refId = crypto.randomUUID();
      dispatch({ type: "ref", id: refId, ref: { data, stored: null, state: "ready" } });
      // Uploading writes its token into the prompt (handoff §4.6), at the caret (Kev, 2026-10-15), and the caret
      // moves behind it, so several images line up where they were dropped.
      const at = caretAt();
      commit((d) => {
        const next = insertToken(d.prompt, at === null ? d.prompt.length : Math.min(at, d.prompt.length), refToken(d.refIds.length));
        after.current = () => promptArea()?.setSelectionRange(next.caret, next.caret);
        return { refIds: [...d.refIds, refId], prompt: next.text };
      });
    });
  };
  /** A reference taken out leaves the caret where it stood, so the next image goes back there (Kev, 2026-10-15). */
  const removeRefImage = (refId: string) => {
    commit((d) => {
      const cut = removeRefAt(d.prompt, d.refIds.indexOf(refId) + 1);
      if (cut.caret !== null) {
        const at = cut.caret;
        caretKnown.current = true;
        after.current = () => promptArea()?.setSelectionRange(at, at);
      }
      return { prompt: cut.text, refIds: d.refIds.filter((r) => r !== refId) };
    });
  };
  const tileClick = (refId: string) => {
    const n = doc.refIds.indexOf(refId) + 1;
    const ta = promptArea();
    const token = parseTokens(doc.prompt).find((t) => t.kind === "ref" && t.n === n);
    if (token) {
      ta?.focus();
      ta?.setSelectionRange(token.start, token.end);
      return;
    }
    const next = insertToken(doc.prompt, caretAt() ?? doc.prompt.length, refToken(n - 1));
    after.current = () => ta?.setSelectionRange(next.caret, next.caret);
    commit({ prompt: next.text });
  };
  const loadValues = (job: EditorJob) => {
    const s = job.setup;
    hold(["prompt", ...Object.keys(s.vars).map((n) => `var:${n}`)]);
    commit((d) => ({ prompt: s.prompt, vars: { ...d.vars, ...s.vars }, kinds: { ...d.kinds, ...s.kinds }, refIds: s.refIds, aiNames: [] }));
    setViewer(null);
    setTab("craft");
    notify("Values loaded into the editor");
  };
  const loadGroup = (g: Variation) => {
    const s = g.jobs[0].setup;
    hold(["prompt"]);
    commit((d) => ({ prompt: s.prompt, kinds: { ...d.kinds, ...s.kinds }, refIds: s.refIds }));
    setTab("craft");
    notify("Prompt loaded into the editor");
  };

  // ── Vary: the AI writes the named text values and never renders (handoff §4.7).
  const dice = useDiceRoll({
    variables: varNames(doc.prompt).filter((n) => n && (doc.kinds[n] ?? "text") === "text"),
    context: doc.prompt,
  });
  const vary = async () => {
    if (!signedIn) return openLogin();
    const values = await dice.roll();
    if (!values) return;
    commit((d) => {
      const names = new Set(varNames(d.prompt));
      const got = Object.entries(values).filter(([n]) => names.has(n));
      return { vars: { ...d.vars, ...Object.fromEntries(got) }, aiNames: got.map(([n]) => n) };
    });
    notify("New values written by the AI — check them, then Generate");
  };

  // ── Listing and stars.
  const setListing = (patch: Partial<Listing>) => dispatch({ type: "set", patch: { listing: { ...listing, ...patch } } });
  /** Image | Video: the words and the variables stay; the generators on offer were the other medium's rows, so they start over. A released prompt keeps what it makes. */
  const switchMedia = (next: NonNullable<Listing["media"]>) => {
    if (next !== media) setListing({ media: next, modelIds: [], testId: null });
  };
  /** A generator on or off the offer, in catalogue order; a test generator taken off the offer falls back to the first on it. */
  const toggleModel = (id: string) => {
    if (listing.mode === "free") return;
    const on = listing.modelIds.includes(id) ? listing.modelIds.filter((m) => m !== id) : [...listing.modelIds, id];
    const modelIds = models.filter((m) => on.includes(m.id)).map((m) => m.id);
    setListing({ modelIds, testId: listing.testId && modelIds.includes(listing.testId) ? listing.testId : null });
  };
  /** The All row: every generator on offer at once, or none when every one already is (a checkbox for the lot); the
      test generator stays only while it is on offer. One change, so it is one undo step. */
  const offerAll = () => {
    // Nothing to put on offer before the catalogue has come: never read that as "all are on" (review 2026-10-26).
    if (listing.mode === "free" || !models.length) return;
    const modelIds = models.every((m) => listing.modelIds.includes(m.id)) ? [] : models.map((m) => m.id);
    setListing({ modelIds, testId: listing.testId && modelIds.includes(listing.testId) ? listing.testId : null });
  };
  const switchMode = (mode: Listing["mode"]) => {
    if (mode === listing.mode) return;
    const go = () => {
      // The stars stay: Free takes at least one, Premium at least four, neither has a most.
      dispatch({ type: "set", patch: { listing: { ...listing, mode } } });
      if (window.matchMedia(COARSE).matches) notify(modeTitle({ ...listing, mode }));
    };
    if (mode === "free" && state.seeded) setAsk({ text: "Open makes your prompt text public. Continue?", ok: "Make it Open", cancel: "Keep Premium", run: go });
    else go();
  };
  const star = (jobId: string) => {
    const r = toggleStar(state.stars, jobs, jobId, Date.now());
    if (r.stars !== state.stars) dispatch({ type: "set", patch: { stars: r.stars } });
    if (r.toast) notify(r.toast);
  };
  const show = (jobId: string) => {
    setViewer(jobId);
    queue.markSeen(jobId);
  };
  const rerun = (job: EditorJob, retry: boolean) => {
    const stopped = attempt({ job, retry });
    // It closes once the job runs, and for a wallet, add-funds or login prompt, which must not sit under it.
    if (!stopped || stopped.open) setViewer(null);
    if (!stopped && !retry) notify("Rendering again with the same values");
  };
  const acts: TileActs = { stars: state.stars, open: (j) => show(j.id), load: loadValues, star, cancel: queue.cancel };

  // ── Release.
  // Stars count in the medium at hand: an image's never releases a video prompt, nor the other way round.
  const starredJobs = starred(state.stars, jobs).filter((j) => (entryOf(j)?.mediaType === "video") === isVideo);
  const updating = !!loaded && state.seeded === loaded.id && listingOnly(doc, effective, loaded, starredJobs.length);
  const verdict = releaseBlock({ listing: effective, starred: starredJobs, loaded: updating ? loaded.doc : null, busy: releasing });
  const send = async ({ body, refIds }: { body: ReleaseBody; refIds: string[] }) => {
    setReleasing(true);
    try {
      // A new prompt asks for the second factor once the user has one (MFA-4).
      const res = await guarded("add-prompt", (h) => fetch("/api/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...sessionAuthHeaders(), ...h },
        body: JSON.stringify(body),
      }));
      const data = (await res.json().catch(() => ({}))) as { id?: string; adult?: boolean; error?: string; referenceImages?: unknown; stepUp?: boolean; referencesNote?: string | null };
      if (!res.ok || !data.id) {
        if (data.stepUp) {
          notify("Not confirmed — nothing was published");
          return;
        }
        if (res.status === 401) openLogin();
        const why = data.error ?? "Release failed — nothing was published";
        notify(res.status === 409 ? `${why} · release again` : why, { tone: "error" });
        return;
      }
      dispatch({ type: "released", stored: storedRefs(refIds, data.referenceImages) });
      notify(`${body.title} is live${body.price ? ` · $${body.price.toFixed(2)} per render` : ""}${data.adult ? " · marked 18+, shown only to viewers who may see 18+" : ""}${data.referencesNote ? ` · ${data.referencesNote}` : ""}`);
      // Its communities, now that it has its id; the release stands either way (the prompt route is not touched), and
      // its editor (?id=) sets them again.
      const unlinked = await communities.save(data.id);
      if (unlinked) notify(`Released. Communities not saved: ${unlinked}`, { tone: "error" });
      void queryClient.invalidateQueries({ queryKey: ["/api/prompts"] });
      // Home and creator shelves must read the new listing even while their cache is fresh.
      void queryClient.invalidateQueries({ queryKey: ["/api/marketplace/prompts"] });
      // And the profile's own count of them, which is otherwise fresh for good.
      void queryClient.invalidateQueries({ queryKey: ["creator-profile"] });
      void queryClient.invalidateQueries({ queryKey: promptKey(data.id) });
      // The Image View's copy of it, which the owner may render from next.
      void queryClient.invalidateQueries({ queryKey: [`/api/prompts/${data.id}`] });
      void queryClient.invalidateQueries({ queryKey: ["prompt-public-images", data.id] });
      /* Released: the editor is cleared and the prompt opens as its image,
         beside the menu (Kev, 2026-10-13: "direkt zum Image geleitet werden,
         Prompt Editor freigeräumt"). The draft goes, so the next Create Prompt
         starts empty; unless the editor was left meanwhile. */
      store.clear();
      if (!mounted.current) return;
      // Kev, 2026-11-03: the congratulation with the share step, over the page it opens. An 18+ prompt too (Kev, 2026-11-04: "wir grenzen niemanden aus").
      if (!updating) offerShare(data.id, imageValues(starredJobs));
      router.push(promptPage(data.id));
    } catch {
      notify("Release failed — check your connection and try again", { tone: "error" });
    } finally {
      setReleasing(false);
    }
  };
  const releaseNow = () => {
    if (!signedIn) return openLogin();
    if (verdict) {
      if (verdict.message) notify(verdict.message);
      if (verdict.focus === "title") root.current?.querySelector<HTMLElement>('[data-pe-field="title"]')?.focus();
      else if (verdict.focus === "price") focus('[data-pe-field="price"]');
      else if (verdict.focus) focus(fieldOf(verdict.focus.variable, verdict.check === "values" ? "value" : "name"));
      if (verdict.open) openMenu(verdict.open === "offer" ? ".pe-gen-row" : ".pe-category");
      return;
    }
    const made = updating && loaded
      ? { body: updateBody({ listing: effective, saved: loaded.saved, id: loaded.id, catalogue: models }), refIds: loaded.doc.refIds }
      : releaseBody({ listing: effective, starred: starredJobs, refs: state.refs, id: id ?? undefined, catalogue: models });
    if ("error" in made) return notify(made.error, { tone: "error" });
    void send(made);
  };

  // ── Leaving while renders run: they are still charged, and they land in the gallery, not here.
  // Back is the page before, as every Back (Kev, 2026-10-30: "wenn ich auf jeglichen Back knopf gehe, so soll ich zum
  // vorherigen menü kommen"); Explore only for an editor opened fresh, as Settings' Back does.
  const out = () => (window.history.length > 1 ? router.back() : router.push("/home"));
  const leave = () => {
    if (!rendering) return out();
    setAsk({ text: leaveText(rendering), ok: "Leave", cancel: "Stay", run: out });
  };
  const busy = rendering > 0;
  useEffect(() => {
    if (!busy) return;
    const guard = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [busy]);

  // ⌘Z / ⇧⌘Z / Ctrl+Y undo the doc; the title and the price keep their own field undo.
  const onKey = useEffectEvent((e: KeyboardEvent) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey || viewer) return;
    if (e.target instanceof Element && e.target.closest("[data-native-undo]")) return;
    const k = e.key.toLowerCase();
    const forward = k === "y" || (k === "z" && e.shiftKey);
    if (k !== "z" && !forward) return;
    e.preventDefault();
    dispatch({ type: forward ? "redo" : "undo" });
  });
  useEffect(() => {
    const on = (e: KeyboardEvent) => onKey(e);
    document.addEventListener("keydown", on);
    return () => document.removeEventListener("keydown", on);
  }, []);

  // Video: the test generator's capability row, its settings as it takes them, each price from its rate (a creator's own test pays no artist).
  // A video's tile stays on Image too, and its Regenerate needs its price.
  const { rateOf } = useVideoRoutes(isVideo || videoJobs.length > 0);
  const videoRow = isVideo ? videoRowOf(test?.name) : null;
  const videoPicks = videoRow && fitSettings(videoRow, picks.video ?? startSettings(videoRow));
  const videoRunnable = Boolean(videoRow && videoPicks && videoCanRun(videoRow, rateOf(videoRow.id), videoPicks));
  // With no test generator picked, "not available" is said only where none on offer could run.
  const videoSomewhere = isVideo && models.some((m) => (rateOf(videoRowOf(m.name)?.id ?? "")?.available ?? []).length > 0);
  const videoStop = !videoRunnable ? (!videoRow && videoSomewhere ? "Pick a generator first" : VIDEO_NOT_AVAILABLE) : refCount ? VIDEO_REFS_NOT_YET : null;

  // ── What the screen says.
  const anyReady = jobs.some((j) => j.status === "ready");
  // A paid render says nothing under the button: its price is on it; nor does a missing generator, the bar's pill says so (Kev, 2026-10-13).
  // Nor an empty prompt, whose press still says it (Kev, 2026-10-29: "remove > Write a prompt first"; DEC-498).
  const costLeft = (doc.prompt.trim() ? block?.toast : undefined)
    ?? (!signedIn ? "Sign in to generate"
      : isVideo ? videoStop ?? (videoJobs.some((j) => j.status === "rendering") ? VIDEO_MAKING : null)
      : !test ? null
      : test.free ? (queue.freeQuota?.exhausted ? "Your 2 free images are used. Top up and pick a paid generator to continue." : queue.note ? quotaText(queue.note) : queue.freeQuota ? `${test.name} · ${queue.freeQuota.remaining} of 2 free images left` : "Checking your free images…")
      : null);
  const bal = balanceView({ payer, ready, balance, free: !test || test.free, quote: chipQuote });
  /* A balance below the price: Generate turns red, carries the balance beside
     the price, and its press opens Add funds instead of a render (Kev, 2026-10-13). */
  const short = bal?.short ? bal.text : null;
  const pending = signedIn && !!test && !test.free && !chipQuote;
  const fundsQuote = funds ? (funds.job ? price(entryOf(funds.job), funds.job.setup, funds.job.setup.refIds.length) : chipQuote) : null;
  const againEntry = viewerJob && entryOf(viewerJob);
  const againVideo = againEntry?.mediaType === "video" ? videoRowOf(againEntry.name) : null;
  const againPrice = againVideo && viewerJob?.setup.video ? videoPrice(againVideo, rateOf(againVideo.id), viewerJob.setup.video) ?? "…"
    : againEntry?.mediaType === "video" ? "…"
    : againEntry?.free ? "$0.00" : quoteLabel(viewerJob && price(againEntry, viewerJob.setup, viewerJob.setup.refIds.length)) ?? "…";
  const restoredOver = state.restored && !!loaded && state.seeded === loaded.id
    && !(listingOnly(doc, effective, loaded, 0) && sameListing(effective, loaded.listing));
  const [min, max] = tabs ? [200, 420] : [400, Math.round(vh * 0.72)];
  const videoPriceOf = (m: CatalogueEntry) => {
    const row = videoRowOf(m.name);
    return row ? videoPrice(row, rateOf(row.id), fitSettings(row, videoPicks ?? startSettings(row))) : "…";
  };

  return (
    <div ref={root} className="pe-root kit-focus" data-tab={tab} style={{ "--pe-split": `${split.value}px` } as CSSProperties}>
      <PullBar target={root} asks={busy} onClose={leave} />
      <EditorHeader title={listing.title} onTitle={(title) => setListing({ title })}
        done={[!!doc.prompt.trim(), anyReady, state.released]}
        active={state.released || anyReady ? 2 : jobs.length ? 1 : 0}
        tab={tab} onTab={setTab} tabs={tabs} panes={panes} rendering={rendering} onBack={leave}
        notice={restoredOver && loaded && (
          <p className="pe-notice">
            Restored your unsaved changes ·{" "}
            <button type="button" onClick={() => dispatch({ type: "seed", loaded, discard: true })}>Discard</button>
          </p>
        )} />
      <div ref={measure} className="pe-body">
        {editing && load.missing ? (
          <div className="pe-state">
            <p>This prompt can&apos;t be opened here (not found, or not yours).</p>
            <button type="button" className="pe-add kit-hit" onClick={leave}>Back</button>
          </div>
        ) : editing && load.failed ? (
          <div className="pe-state">
            <p>Couldn&apos;t load this prompt.</p>
            <button type="button" className="pe-add kit-hit" onClick={load.retry}>Try again</button>
          </div>
        ) : editing && load.loading ? (
          <div className="pe-state" aria-busy="true" aria-label="Loading the prompt">
            <span className="pe-skel" /><span className="pe-skel" /><span className="pe-skel pe-skel--tall" />
          </div>
        ) : (
          <>
            <div className="pe-craft" {...pane("craft")}>
              {/* The very first choice (Kev, 2026-11-03: "create prompt einen zusatz zum switchen hat zwischen image and video
                  ganz am anfang"). Shut on a released prompt. The title sits outside the inert part: an inert element takes no hover, so its reason could never show. */}
              <div className="pe-row pe-media" data-locked={editing || undefined} title={editing ? "A released prompt keeps what it makes" : undefined}>
                <div className="pe-media-in" inert={editing || undefined}>
                  <Segmented slide role="radiogroup" ariaLabel="What this prompt makes" value={media} onChange={switchMedia} options={MEDIA} />
                </div>
              </div>
              <ListingRow listing={listing} onMode={switchMode} onPrice={(p) => setListing({ price: p })}
                onReferences={(allowReferences) => setListing({ allowReferences })} referencesNamed={namesReference(doc)}
                onCategory={(category) => setListing({ category })} extra={communities.pill} />
              <GeneratorRow models={models} selected={offeredIds} locked={listing.mode === "free"} prices={models.map((m) => price(m, picks, refCount))}
                labels={isVideo ? models.map(videoPriceOf) : undefined} onToggle={toggleModel} onAll={offerAll} />
              <PromptField value={doc.prompt} refCount={refCount} min={min} max={max} growOnly={isHeld("prompt")} noun={media}
                onUserInput={() => release("prompt")} onEdit={(prompt, key) => commit({ prompt }, key)}
                onCreateVariable={createVariable} onAddVariable={addVariable}
                onFocus={() => { caretKnown.current = true; }}
                history={{
                  canUndo: history.past.length > 0,
                  canRedo: history.future.length > 0,
                  undo: () => dispatch({ type: "undo" }),
                  redo: () => dispatch({ type: "redo" }),
                }}
                refDrag={refDrag} />
              <VariableList doc={doc} commit={commit} isHeld={isHeld} release={release} onAdd={addVariable}
                suggested={suggested} onNamed={named} />
              <ReferenceStrip doc={doc} refs={state.refs} pending={reads.pending} cap={cap} accept={accept}
                nft={tabs ? "tile" : "link"} onAddFiles={(files) => files.forEach(addRef)}
                onRemove={removeRefImage}
                onTile={tileClick} onNft={() => setNftOpen(true)} onDragToken={setRefDrag} />
              <GenerateBar
                live={<LiveStrip jobs={jobs} stars={state.stars} onOpen={(j) => show(j.id)} onCancel={queue.cancel} onAll={() => setTab("verify")} />}
                models={offered} testId={test?.id ?? null}
                tags={isVideo ? Object.fromEntries(offered.map((m) => [m.id, videoPriceOf(m)])) : undefined}
                video={!isVideo ? undefined : videoRow && videoPicks ? (
                  <VideoSettingsRow m={videoRow} s={videoPicks} onSet={(next) => dispatch({ type: "set", patch: { picks: { ...picks, video: { ...videoPicks, ...next } } } })}
                    price={(r) => videoPrice(videoRow, rateOf(videoRow.id), fitSettings(videoRow, { ...videoPicks, resolution: r }))} />
                ) : null}
                onTest={(testId) => setListing({ testId: testId === offeredIds[0] ? null : testId })}
                core={core} picks={picks} onPicks={(patch) => dispatch({ type: "set", patch: { picks: { ...picks, ...patch } } })}
                prices={{
                  models: offered.map((m) => price(m, picks, refCount)),
                  tiers: core.tiers.map((t) => price(test, { ...picks, resolution: t.tier }, refCount)),
                  qualities: (["low", "medium", "high"] as const).map((quality) => price(test, { ...picks, quality }, refCount)),
                }}
                vary={{ onVary: () => void vary(), rolling: dice.rolling, unavailable: dice.unavailable }}
                generate={isVideo ? {
                  label: "✦ Generate",
                  chip: signedIn && videoRow && videoPicks ? videoPrice(videoRow, rateOf(videoRow.id), videoPicks) : null,
                  dimmed: signedIn && (videoStop !== null || videoRun.busy),
                  onPress: () => attempt({}),
                  size: tabs ? "block" : "bar",
                } : {
                  label: "✦ Generate",
                  chip: chipLabel({ signedIn, free: !!test?.free, quote: chipQuote, pending }),
                  chipPending: pending,
                  dimmed: !!block?.toast,
                  short,
                  onPress: short === null ? () => attempt({}) : openAddFunds,
                  size: tabs ? "block" : "bar",
                }}
                cost={{ left: costLeft }}>
                {funds && fundsQuote && (
                  <AddFundsPopover balanceUsd={balanceUsd ?? 0} totalUsd={fundsQuote.totalUsd} onAddFunds={openAddFunds}
                    onTryAnyway={() => attempt(funds, true)} onClose={() => setFunds(null)} />
                )}
              </GenerateBar>
            </div>
            <SplitDivider split={split} />
            <VerifyPane pane={pane("verify")} groups={groups} need={starsNeeded(listing)} noun={media} wide={(parseRatio(picks.ratio) ?? 1) > 1}
              open={openStacks} acts={acts} onLoad={loadGroup} onCraft={() => setTab("craft")}
              onToggle={(key) => setOpenStacks((o) => {
                const next = new Set(o);
                if (!next.delete(key)) next.add(key);
                return next;
              })}
              showcase={loaded && state.seeded === loaded.id && <LiveShowcase photos={loaded.saved.uploadedPhotos} />}
              release={
                <ReleaseBar need={starsNeeded(listing)} ratio={picks.ratio} listingOnly={updating} first={isVideo ? MAKE_VIDEO_FIRST : undefined}
                  short={starred(state.stars, jobs).length > starredJobs.length ? `Only ${media}s count here` : isVideo ? "Star the video to release it" : undefined}
                  photos={updating && loaded
                    ? loaded.saved.uploadedPhotos.map((src) => ({ key: src, src, ratio: null }))
                    : starredJobs.map((j) => ({ key: j.id, src: j.imageUrl ?? "", ratio: j.setup.ratio }))}
                  released={state.released} blocked={!!verdict && verdict.check !== "busy"} busy={releasing} anyReady={anyReady}
                  mode={listing.mode} onRelease={releaseNow} onMore={() => setTab("craft")} />
              } />
          </>
        )}
      </div>
      {viewerJob && viewerJob.status !== "rendering" && (
        <RenderPreview job={viewerJob} groups={groups} stars={state.stars} price={againPrice} stacked={tabs}
          onShow={show} onClose={() => setViewer(null)} onUse={loadValues} onStar={star} onRun={rerun}
          onRemove={(jobId) => {
            queue.drop(jobId);
            // A video's job is the server's, not the queue's: without its setup its tile is gone from this visit.
            setVideoSetups((s) => {
              const next = { ...s };
              delete next[jobId];
              return next;
            });
            setViewer(null);
          }} />
      )}
      <WalletPickerModal inApp open={walletOpen} onClose={() => setWalletOpen(false)} />
      {nftOpen && (
        <NftPickerModal max={Math.max(0, cap - refCount - reads.pending.length)} onClose={() => setNftOpen(false)}
          onPick={(nfts) => nfts.forEach(addRef)} />
      )}
      <AlertDialog open={!!state.pendingSeed} onOpenChange={(open) => { if (!open) decideSeed(false); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Replace your unsaved draft?</AlertDialogTitle>
            <AlertDialogDescription>The saved prompt text will replace this draft. Your library entry stays unchanged.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep my draft</AlertDialogCancel>
            <AlertDialogAction onClick={() => decideSeed(true)}>Replace draft</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={!!ask} onOpenChange={(open) => { if (!open) setAsk(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Are you sure?</AlertDialogTitle>
            <AlertDialogDescription>{ask?.text}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{ask?.cancel}</AlertDialogCancel>
            <AlertDialogAction onClick={() => ask?.run()}>{ask?.ok}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
