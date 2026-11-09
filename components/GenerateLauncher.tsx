"use client";

import { useEffect, useEffectEvent, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useRouter } from "next/navigation";
import { Sparkles } from "lucide-react";
import { useActiveAccount } from "thirdweb/react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useBetaAccess } from "@/components/BetaGate";
import { openLogin } from "@/lib/openLogin";
import { stashEditorSeed } from "@/components/enki-shell/editorBridge";
import { librarySeed } from "@/lib/editor/editor-seed";
import { useCdpAddress } from "@/hooks/useCdpAddress";
import { useToast } from "@/hooks/use-toast";
import { useModelLimits, type CatalogueEntry } from "@/hooks/useModelLimits";
import GeneratorPill from "@/components/kit/GeneratorPill";
import PillMenu from "@/components/kit/PillMenu";
import { RatioPill, ResolutionPill } from "@/components/kit/SettingsPills";
import { addCreation } from "@/lib/creations";
import EnkiMobileGenerateModal from "@/components/EnkiMobileGenerateModal";
import { awaitsPayment, runGenerationBatch, type GenerationPayment, type GenerationRequest } from "@/lib/generation/run-generation";
import { cancelPaidGeneration, checkPaidGenerationStatus, CheckoutError, readPendingEscrowPayments, storePendingEscrowPayments } from "@/lib/generation-checkout";
import { tiersUpTo, type ResolutionTier } from "@/lib/generation/resolution";
import { useFreeGenerationQuota } from "@/hooks/useRenderQueue";
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel } from "@/components/ui/alert-dialog";
import { usePaymentSigner } from "@/hooks/usePaymentSigner";
import { useServerQuotes, quoteLabel } from "@/hooks/useServerQuotes";
import { useGenerationCore } from "@/hooks/useGenerationCore";
import { DEFAULT_GENERATOR, forViewer } from "@/lib/ui/image-view/models";
import NftPickerModal from "@/components/enki/NftPickerModal";
import { FIELD } from "@/components/enki-window";
import { useReferenceReads, REFS_LOADING, type NftPick } from "@/hooks/useReferenceReads";
import { QUICK_CREATE_EVENT, takeQuickCreateSeed, type QuickCreateSeed } from "@/lib/ui/quick-create-seed";

/* No literals: models, ratios, tiers, prices, the boost lever and the NFT
   reference limit all come from useGenerationCore — the one global source
   every generate surface reads (Kev, 2026-08-22). The old GL_MODELS pair
   (invented $0.10, no Flux) and the five-ratio list were exactly the drift
   that rule exists to end. */

/**
 * GenerateLauncher — the unified "Generate" entry point (ported from pr45) that
 * replaces the old EnkiQuickCreate pill/panel. The launch pill opens the shared
 * EnkiMobileGenerateModal (Generate-only) on all viewports, with
 * reference-image upload + NFT support.
 *
 * Generates the selected model through runGeneration: the free model on the
 * free route, every other model paid through a payment intent. It used to
 * post everything to /api/generate-free, so Nano Banana Pro, its price and
 * its 4K tier were shown and Flux rendered.
 */
export default function GenerateLauncher() {
  const router = useRouter();
  const { access, role, userId } = useBetaAccess();
  const signedIn = access === "ok" && role !== "team";
  const { toast } = useToast();
  const account = useActiveAccount();
  const { publicKey: solanaPublicKey } = useWallet();
  const { address: cdpAddress } = useCdpAddress();
  const userKey = useMemo(
    () => account?.address ?? solanaPublicKey?.toBase58() ?? cdpAddress ?? null,
    [account?.address, solanaPublicKey, cdpAddress]
  );

  const [open, setOpen] = useState(false);
  const [generating, setGenerating] = useState(false);
  const { loading: refsLoading, pending: refsPending, read: readRef } = useReferenceReads();
  // Same model on a priority host — faster, dearer, identical image.
  const [boost, setBoost] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [valueByToken, setValueByToken] = useState<Record<string, string>>({});
  // Starts on the default generator (Kev, 2026-10-13: "just pick a generator as
  // default like NBP"); what is selected is what renders (2026-10-02: "IMMER
  // DAS AUSGEWÄHLTE"), and nothing renders without a selection.
  const [model, setModel] = useState<string>(DEFAULT_GENERATOR);
  const signPayment = usePaymentSigner();
  const core = useGenerationCore(model);
  const { quota: freeQuota, refresh: refreshFreeQuota } = useFreeGenerationQuota(open && signedIn && core.entry?.free === true, signedIn ? userId : null);
  const [mixed, setMixed] = useState<{ base: GenerationRequest; count: number; freeCount: number } | null>(null);
  const [mixedPaidId, setMixedPaidId] = useState("");
  const pendingAccount = signedIn && userId ? userId : null;
  const [pendingState, setPendingState] = useState<{ account: string; requests: GenerationRequest[]; payments: GenerationPayment[] } | null>(null);
  const [pendingLoadedAccount, setPendingLoadedAccount] = useState<string | null>(null);
  const pendingOrder = pendingState?.account === pendingAccount ? pendingState : null;
  const setPendingOrder = (value: { requests: GenerationRequest[]; payments: GenerationPayment[] } | null) =>
    setPendingState(value && pendingAccount ? { ...value, account: pendingAccount } : null);
  useEffect(() => {
    if (!pendingAccount) return;
    let active = true;
    void Promise.resolve().then(() => {
      const payments = readPendingEscrowPayments(sessionStorage, pendingAccount);
      if (active) {
        setPendingState(payments.length ? { account: pendingAccount, requests: [], payments } : null);
        setPendingLoadedAccount(pendingAccount);
      }
    });
    return () => { active = false; };
  }, [pendingAccount]);
  useEffect(() => {
    if (pendingAccount && pendingLoadedAccount === pendingAccount) storePendingEscrowPayments(sessionStorage, pendingAccount, pendingOrder?.payments ?? null);
  }, [pendingAccount, pendingLoadedAccount, pendingOrder]);
  const [resolution, setResolution] = useState("2K");
  const [nftPickerOpen, setNftPickerOpen] = useState(false);
  // Per-model limits (max reference images, allowed filetypes) from the DB.
  const modelLimits = useModelLimits(model);
  const [ratio, setRatio] = useState("1:1");
  // A model switch must never leave a ratio or tier the new model lacks.
  useEffect(() => { if (!core.loading && !core.ratios.includes(ratio)) setRatio(core.clampRatio(ratio)); }, [core, ratio]);
  useEffect(() => { if (!core.loading && core.clampTier(resolution) !== resolution) setResolution(core.clampTier(resolution)); }, [core, resolution]);
  const [referenceImages, setReferenceImages] = useState<string[]>([]);
  const [nftImages, setNftImages] = useState<string[]>([]);
  // Bumped whenever another prompt opens: a read still running lands nowhere.
  const refsEpoch = useRef(0);

  /* Every price shown is a server quote (Kev, 2026-10-02: "ich brauche safe
     überall den server-quote"): the current settings first, then each tier
     for the resolution options. */
  const asTier = (t: string) => (t === "1K" || t === "2K" || t === "4K" ? t : null);
  const refCount = referenceImages.length + nftImages.length;
  const paidEntry = core.entry && !core.entry.free ? core.entry : null;
  const quoteTiers = core.tiers.map((t) => t.tier);
  const quotes = useServerQuotes(
    paidEntry
      ? [resolution, ...quoteTiers].flatMap((t) => {
          const tier = asTier(t);
          return tier ? [{ modelId: paidEntry.id, resolution: tier, boost: core.boostAt(tier) && boost, referenceImageCount: refCount }] : [];
        })
      : [],
  );
  const priceFor = (n: number) => (core.entry?.free ? !freeQuota ? "Checking allowance…" : n <= freeQuota.remaining ? `Free · ${freeQuota.remaining} left` : `${Math.min(n, freeQuota.remaining)} free · choose a paid model for ${n - Math.min(n, freeQuota.remaining)}` : !core.entry ? "" : quoteLabel(quotes[0], n) ?? "…");
  const mixedPaidOptions = core.catalogue.filter(entry => entry.mediaType === "image" && !entry.free && mixed &&
    tiersUpTo(entry.maxResolution).includes(mixed.base.resolution) && entry.ratios.includes(mixed.base.aspectRatio) &&
    (mixed.base.referenceImages?.length ?? 0) <= (entry.maxRefs ?? 0));
  const mixedPaid = mixedPaidOptions.find(entry => entry.id === mixedPaidId);
  const mixedQuotes = useServerQuotes(mixed && mixedPaid ? [{ promptId: mixed.base.promptId, modelId: mixedPaid.id,
    resolution: mixed.base.resolution, boost: false, referenceImageCount: mixed.base.referenceImages?.length ?? 0 }] : []);
  const mixedPaidCount = mixed ? mixed.count - mixed.freeCount : 0;
  const mixedTotal = quoteLabel(mixedQuotes[0], mixedPaidCount);
  const tierLabel = (i: number) => (core.entry?.free ? "Free" : quoteLabel(quotes[i + 1]));
  const [results, setResults] = useState<string[]>([]);

  /* Quick Create's settings are the Image View's pills, and their sheets on a phone (Kev, 2026-10-27: "das gleiche
     verhalten, wie bei create prompt"): each generator priced by the server at the current settings, as there. */
  const offerable = forViewer(core.catalogue, role).filter((m) => m.mediaType === "image");
  const pricedModels = signedIn ? offerable.filter((m) => !m.free).slice(0, 24) : [];
  const fitTier = (m: CatalogueEntry): ResolutionTier => {
    const tiers = tiersUpTo(m.maxResolution);
    return tiers.find((t) => t === resolution) ?? tiers[tiers.length - 1];
  };
  const pricedQuotes = useServerQuotes(pricedModels.map((m) => ({ modelId: m.id, resolution: fitTier(m), boost: false, referenceImageCount: refCount })));
  const settings = (count: number, setCount: (n: number) => void) => (
    <>
      <GeneratorPill models={offerable} value={core.entry?.id ?? null} onChange={setModel}
        prices={offerable.map((m) => pricedQuotes[pricedModels.indexOf(m)] ?? null)} look="logo-name" describe direction="up" />
      <RatioPill core={core} value={ratio} onChange={setRatio} describe />
      <ResolutionPill core={core} value={resolution} onChange={setResolution} prices={paidEntry ? quoteTiers.map((_, i) => quotes[i + 1] ?? null) : []} describe />
      <PillMenu trigger={<span>×{count}</span>} ariaLabel={`${count} image${count === 1 ? "" : "s"} per run`} title="How many images"
        options={Array.from({ length: 8 }, (_, i) => ({ key: String(i + 1), label: `×${i + 1}`, sub: core.entry?.free ? null : quoteLabel(quotes[0], i + 1) }))}
        value={String(count)} onPick={(k) => setCount(Number(k))} sheetHint="Several takes in one go" sheetColumns={4} typed="Or type a number" />
    </>
  );

  /* Recreate from the gallery (Kev, 2026-10-15): a render made here, not with a
     marketplace prompt, comes back as it was made: text, generator, ratio, size
     and the reference images. The gallery leaves the seed in sessionStorage and
     raises the event; the seed is read once, here or on the next mount. */
  const [popped, setPopped] = useState(false);
  const applyQuickSeed = useEffectEvent((seed: QuickCreateSeed) => {
    setPrompt(seed.prompt);
    // A render made on the free host comes back on the default generator unless the viewer is an admin (forViewer).
    if (seed.modelId && offerable.some((m) => m.id === seed.modelId)) setModel(seed.modelId);
    if (seed.aspectRatio) setRatio(seed.aspectRatio);
    if (seed.resolution) setResolution(seed.resolution);
    refsEpoch.current++;
    setReferenceImages([]);
    setNftImages([]);
    setResults([]);
    const epoch = refsEpoch.current;
    for (const url of seed.references ?? []) {
      void fetch(url).then((res) => (res.ok ? res.blob() : null)).catch(() => null).then((blob) => blob && readRef(blob)).then((data) => {
        if (data && epoch === refsEpoch.current) setReferenceImages((prev) => [...prev, data]);
      });
    }
    setPopped(true);
    setOpen(true);
  });
  useEffect(() => {
    const take = () => { const seed = takeQuickCreateSeed(); if (seed) applyQuickSeed(seed); };
    take();
    window.addEventListener(QUICK_CREATE_EVENT, take);
    return () => window.removeEventListener(QUICK_CREATE_EVENT, take);
  }, []);

  /* From a quick image to a prompt (Kev, 2026-10-26: "von quick create rüber zu prompt creation problemlos wechseln"):
     the words go to the editor as an import, its brackets as variables (lib/editor/editor-seed); a guest signs in first. */
  const makePrompt = () => {
    if (!signedIn) return openLogin();
    // Its first six words name it until the editor gives it a title.
    const seed = librarySeed({ name: prompt.trim().split(/\s+/).slice(0, 6).join(" ").slice(0, 60), prompt_text: prompt });
    if (seed) stashEditorSeed(seed, userId);
    closeModal();
    router.push("/editor");
  };

  const closeModal = () => {
    setOpen(false);
    setPopped(false);
    setResults([]);
    setPrompt("");
    setValueByToken({});
  };

  // Detect [bracket] variables; preserve entered values keyed by token.
  const variables = useMemo(() => {
    const seen = new Set<string>();
    const out: {
      id: string;
      name: string;
      label: string;
      type: string;
      defaultValue: string;
      values: string[];
    }[] = [];
    const re = /\[([^\]]+)\]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(prompt)) !== null) {
      const full = m[0];
      if (seen.has(full)) continue;
      seen.add(full);
      out.push({
        id: full,
        name: m[1],
        label: m[1],
        type: "text",
        defaultValue: "",
        values: [valueByToken[full] ?? ""],
      });
    }
    return out;
  }, [prompt, valueByToken]);

  const executeOrder = async (requests: GenerationRequest[], resume?: GenerationPayment[]) => {
    setGenerating(true);
    try {
      const outcomes = await runGenerationBatch(requests, signPayment, (outcome, index) => {
        if (!outcome.ok) return;
        setResults(previous => [outcome.imageUrl, ...previous]);
        if (userKey) {
          addCreation(userKey, { id: crypto.randomUUID(), imageUrl: outcome.imageUrl,
            prompt: requests[index].prompt, createdAt: new Date().toISOString() });
          window.dispatchEvent(new Event("gallery-refresh"));
        }
      }, resume, payments => {
        if (!pendingAccount || !storePendingEscrowPayments(sessionStorage, pendingAccount, payments)) throw new Error("Payment checkpoint unavailable");
        setPendingOrder({ requests: requests.filter(request => request.model && !request.model.free), payments });
      });
      // An expired order, or a unit the server reports finished, leaves no pending banner behind (verification 2026-10-18).
      const unresolved = outcomes.flatMap((outcome, index) => awaitsPayment(outcome) && outcome.payment ? [{ request: requests[index], payment: outcome.payment }] : []);
      setPendingOrder(unresolved.length ? { requests: unresolved.map(item => item.request), payments: unresolved.map(item => item.payment) } : null);
      const completed = outcomes.filter(outcome => outcome.ok).length;
      const failure = outcomes.find(outcome => !outcome.ok);
      toast({ title: completed ? `${completed} image${completed === 1 ? "" : "s"} generated` : "Generation could not finish",
        description: failure && !failure.ok ? failure.error : "Your images are saved to your gallery.",
        ...(completed === 0 ? { variant: "destructive" as const } : {}) });
      if (requests.some(request => request.model?.free)) void refreshFreeQuota();
    } finally { setGenerating(false); }
  };
  const generate = async (count: number) => {
    if (generating || pendingOrder || (pendingAccount && pendingLoadedAccount !== pendingAccount)) return;
    if (!signedIn) return openLogin();
    if (!Number.isInteger(count) || count < 1 || count > 24) return;
    if (refsLoading) return toast({ title: "Images still loading", description: REFS_LOADING });
    const final = prompt.replace(/\[[^\]]+\]/g, token => valueByToken[token] || token);
    if (!final.trim()) return toast({ title: "Enter a prompt", description: "Please enter a prompt before generating.", variant: "destructive" });
    const tier = asTier(resolution);
    if (!core.entry || !tier) return toast({ title: "Pick a model", description: "Choose the model to generate with. Nothing was generated.", variant: "destructive" });
    if (!core.entry.free && !quotes[0]) return toast({ title: "Price unavailable", description: "Wait for the server price before continuing.", variant: "destructive" });
    const refs = [...referenceImages, ...nftImages].filter(Boolean);
    const base: GenerationRequest = {
      model: core.entry, resolution: tier, boost: core.boostAt(tier) && boost, prompt: final.trim(),
      aspectRatio: ratio, referenceImages: refs.length ? refs : undefined,
    };
    if (core.entry.free) {
      // Refresh immediately before planning. The provider route still claims the daily allowance atomically.
      const quota = await refreshFreeQuota();
      if (!quota) return toast({ title: "Allowance unavailable", description: "Your daily free image allowance could not be checked. Please try again.", variant: "destructive" });
      if (count > quota.remaining) {
        setMixedPaidId("");
        setMixed({ base, count, freeCount: Math.min(count, quota.remaining) });
        return;
      }
    }
    await executeOrder(Array.from({ length: count }, () => base));
  };
  const confirmMixedOrder = () => {
    if (!mixed || !mixedPaid || !mixedTotal || generating) return;
    const requests = [
      ...Array.from({ length: mixed.freeCount }, () => mixed.base),
      ...Array.from({ length: mixedPaidCount }, () => ({ ...mixed.base, model: mixedPaid, boost: false })),
    ];
    setMixed(null);
    void executeOrder(requests);
  };
  const checkPendingOrder = async () => {
    if (!pendingOrder || generating) return;
    if (!pendingOrder.requests.length) {
      setGenerating(true);
      try {
        const receipt = await checkPaidGenerationStatus(pendingOrder.payments[0]);
        // On the intent rail nothing is charged without an image (DEC-88); escrow refunds what the deposit did not spend.
        const intent = receipt.paymentScheme === "intent";
        if (receipt.state === "expired") {
          setPendingOrder(null);
          toast({ title: "Payment expired", description: intent ? "This order was not paid. Nothing was charged."
            : "This deposit was not funded. Check your balance before starting another order." });
          return;
        }
        const finished = receipt.unitStatuses?.filter(unit => unit.state === "delivered" || unit.state === "failed");
        const images = receipt.unitStatuses?.flatMap(unit => unit.imageUrl ? [unit.imageUrl] : []) ?? [];
        if (images.length) setResults(previous => [...new Set([...images, ...previous])]);
        if (finished?.length === receipt.units) setPendingOrder(null);
        toast({ title: "Existing payment checked", description: finished?.length === receipt.units
          ? (intent ? "All image requests have finished. Images that did not arrive were not charged, or are refunded." : "All image requests have finished. Any unused payment is being refunded.")
          : "This order was restored after a reload. Check your gallery or cancel the remaining images. No new images were requested." });
      } catch (error) {
        if (error instanceof CheckoutError && error.payment?.state === "expired") setPendingOrder(null);
        toast({ title: "Payment status", description: error instanceof Error ? error.message : "The payment is still being checked." });
      } finally { setGenerating(false); }
      return;
    }
    await executeOrder(pendingOrder.requests, pendingOrder.payments);
  };
  const cancelPendingOrder = async () => {
    if (!pendingOrder || generating) return;
    setGenerating(true);
    try {
      await cancelPaidGeneration(pendingOrder.payments[0]);
      setPendingOrder(null);
      // On the intent rail a cancelled image was never charged; escrow refunds what the deposit did not spend.
      toast({ title: "Remaining images cancelled", description: pendingOrder.payments[0].paymentScheme === "intent"
        ? "Running images may still finish. The rest were not charged." : "Running images may still finish. The unused payment is being refunded." });
    } catch (error) {
      toast({ title: "Cancellation pending", description: error instanceof Error ? error.message : "Check this payment again before starting another order.", variant: "destructive" });
    } finally { setGenerating(false); }
  };
  /* The NFT button opens the WALLET picker — it used to click the hidden
     file input, so "NFTs" opened an upload-from-PC dialog (Kev, 2026-08-22).
     The file input stays for the plain image-upload path only. */
  const pickNFT = () => setNftPickerOpen(true);

  const addToList = (
    files: FileList,
    setList: Dispatch<SetStateAction<string[]>>
  ) => {
    Array.from(files).forEach((file) => {
      // Per-model allowed filetypes + max reference images (models table).
      if (modelLimits.filetypes.length && file.type && !modelLimits.filetypes.includes(file.type)) {
        toast({ title: "File type not supported", description: `${file.name} — this model accepts ${modelLimits.filetypes.map((t) => t.split("/")[1]).join(", ")}.`, variant: "destructive" });
        return;
      }
      const epoch = refsEpoch.current;
      void readRef(file).then((url) => {
        if (url && epoch === refsEpoch.current) {
          setList((prev) => {
            if (prev.length >= modelLimits.maxRefs) {
              toast({ title: "Reference limit reached", description: `This model allows up to ${modelLimits.maxRefs} reference images.` });
              return prev;
            }
            return [...prev, url];
          });
        }
      });
    });
  };

  const addReferenceImages = (files: FileList) => addToList(files, setReferenceImages);

  // Each picked NFT travels as the image itself, read like an upload and held
  // to the same file types and limit: the server judges bytes, never a link.
  const addNfts = (picks: NftPick[]) => {
    const epoch = refsEpoch.current;
    picks.forEach((p) => void readRef(p).then((img) => {
      if (epoch !== refsEpoch.current) return;
      if (!img) {
        toast({ title: "NFT image unavailable", description: "This NFT's image could not be loaded, so it was not added.", variant: "destructive" });
        return;
      }
      const type = /^data:([^;,]*)/i.exec(img)?.[1].toLowerCase() ?? "";
      if (modelLimits.filetypes.length && !modelLimits.filetypes.includes(type)) {
        toast({ title: "File type not supported", description: `This NFT's image is ${type || "no image"} — this model accepts ${modelLimits.filetypes.map((t) => t.split("/")[1]).join(", ")}.`, variant: "destructive" });
        return;
      }
      setNftImages((prev) => {
        if (prev.length + referenceImages.length >= modelLimits.maxRefs) {
          toast({ title: "Reference limit reached", description: `This model allows up to ${modelLimits.maxRefs} reference images.` });
          return prev;
        }
        return [...prev, img];
      });
    }));
  };

  const reorder = (list: string[], from: number, to: number) => {
    if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) {
      return list;
    }
    const next = [...list];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    return next;
  };

  return (
    <>
      <AlertDialog open={!!mixed} onOpenChange={value => { if (!value) setMixed(null); }}>
        <AlertDialogContent className="z-[2000]">
          <AlertDialogHeader>
            <AlertDialogTitle>Choose a model for the paid images</AlertDialogTitle>
            <AlertDialogDescription>
              {mixed?.freeCount ?? 0} image is free. The other {mixedPaidCount} image{mixedPaidCount === 1 ? "" : "s"} require a paid model you choose.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <label htmlFor="mixed-paid-model" className="kit-label" style={{ display: "block", margin: "16px 0 6px" }}>Paid model</label>
          <select id="mixed-paid-model" className={FIELD} value={mixedPaidId} onChange={event => setMixedPaidId(event.target.value)}>
            <option value="">Choose a paid model</option>
            {mixedPaidOptions.map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
          </select>
          {!mixedPaidOptions.length && <p className="kit-confirm-text">No paid model supports these settings. Close this dialog and change the settings.</p>}
          <p role="status" className="kit-confirm-text">{mixedPaid ? mixedTotal ? `${mixed?.freeCount ?? 0} free + ${mixedPaidCount} paid · ${mixedTotal} total` : "Checking the server price…" : "Choose a model to see the total price."}</p>
          <p className="kit-confirm-text">The payment is reserved. Unused images are refunded.</p>
          <AlertDialogFooter>
            <AlertDialogCancel>Back</AlertDialogCancel>
            <button type="button" className="kit-confirm-btn kit-confirm-btn--danger" disabled={!mixedPaid || !mixedTotal || generating} onClick={confirmMixedOrder}>Confirm {mixedTotal ?? "order"}</button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {pendingOrder && <div role="status" style={{ position: "fixed", zIndex: 10015, bottom: 16, left: 16, right: 16, background: "var(--qc-bg)", color: "var(--qc-ink)", padding: 16, borderRadius: 16 }}>
        <p>Your existing payment is being checked. Starting another order is paused.</p>
        <div className="kit-confirm-actions">
          <button type="button" className="kit-confirm-btn" disabled={generating} onClick={() => void checkPendingOrder()}>Check existing payment</button>
          <button type="button" className="kit-confirm-btn" disabled={generating} onClick={() => void cancelPendingOrder()}>Cancel remaining images</button>
        </div>
      </div>}
      {/* The wallet NFT picker — capped by the model's own reference limit. */}
      {nftPickerOpen && (
        <NftPickerModal
          max={Math.max(0, modelLimits.maxRefs - refCount - refsPending.length)}
          onPick={addNfts}
          onClose={() => setNftPickerOpen(false)}
        />
      )}
      <div className={popped ? "qc-pop" : undefined}>
      <EnkiMobileGenerateModal
        isOpen={open}
        onClose={closeModal}
        promptBody={prompt}
        setPromptBody={setPrompt}
        // Text variables inferred from the typed body.
        variables={variables}
        onVariableChange={(id, val) => setValueByToken((prev) => ({ ...prev, [id]: val }))}
        onAddVariable={() => {
          const n = variables.length + 1;
          setPrompt((prev) => `${prev}${prev && !prev.endsWith(" ") ? " " : ""}[var_${n}]`);
        }}
        onRemoveVariable={(name) => setPrompt((prev) => prev.split(`[${name}]`).join("").replace(/\s{2,}/g, " ").trim())}
        models={{ available: offerable.map((m) => ({ id: m.id, name: m.name, price: m.price })), selected: core.entry ? [core.entry.id] : [] }}
        setModel={setModel}
        settings={settings}
        ratios={{ available: core.ratios, selected: ratio }}
        setRatio={setRatio}
        priceFor={priceFor}
        resolution={resolution}
        setResolution={setResolution}
        resolutionOptions={core.tiers.map((t, i) => ({ value: t.tier, label: tierLabel(i) ? `${t.tier} · ${tierLabel(i)}` : t.tier, short: t.tier }))}
        referenceImages={referenceImages}
        pendingReferenceImages={refsPending}
        onAddReferenceImages={addReferenceImages}
        onRemoveReferenceImage={(i) =>
          setReferenceImages((prev) => prev.filter((_, idx) => idx !== i))
        }
        onReorderReferenceImages={(from, to) =>
          setReferenceImages((prev) => reorder(prev, from, to))
        }
        // A model that takes no references (Flux) keeps both add buttons, greyed, and says so (Kev, 2026-10-13).
        onPickNFT={pickNFT}
        referencesNote={modelLimits.maxRefs === 0 ? `${core.entry?.name ?? "This generator"} takes no images` : null}
        nftImages={nftImages}
        onRemoveNFT={(i) => setNftImages((prev) => prev.filter((_, idx) => idx !== i))}
        onReorderNFTs={(from, to) => setNftImages((prev) => reorder(prev, from, to))}
        generateLabel={generating ? "Generating…" : refsLoading ? "Loading images…" : "Generate"}
        onMakePrompt={makePrompt}
        generateBlocked={refsLoading || !!pendingOrder || !!(pendingAccount && pendingLoadedAccount !== pendingAccount) || (core.entry?.free === true && !freeQuota)}
        boost={boost}
        onBoostChange={core.boostAvailable ? setBoost : undefined}
        boostSameHost={!core.boostAt(resolution)}
        hideReleaseTab
        resultImages={results}
        isGenerating={generating}
        onGenerate={generate}
        onOpenPromptEditor={() => router.push("/editor")}
      />
      </div>

      {/* Idle: one round button in a bottom corner (Kev, 2026-10-15: a long
          Generate bar is unfeasible), placed by app/editor/mobile-modal.css;
          pressed, the modal pops out of that corner into the lower middle. */}
      {!open && (
        <div className="ek-generate-launcher">
          <button
            type="button"
            className="ek-generate-fab kit-hit"
            onClick={() => { setPopped(true); setOpen(true); }}
            aria-label="Generate"
            title="Generate"
          >
            <Sparkles size={22} style={{ fill: "var(--qc-ink)" }} />
          </button>
        </div>
      )}
    </>
  );
}
