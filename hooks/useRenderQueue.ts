"use client";

/**
 * The render queue of every generate surface (plan §1.3). Each Generate is one
 * job; jobs run in parallel, while wallet prompts come one at a time. What an
 * outcome does is decided in lib/ui/kit/render-queue `settle`; this hook only
 * carries it out.
 */
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { runGenerationBatch, type BatchWatch, type GenerationRequest, type GenerationPayment } from "@/lib/generation/run-generation";
import { fetchFreeGenerationQuota, type FreeGenerationQuota } from "@/lib/generation-checkout";
import { usePaymentSigner } from "@/hooks/usePaymentSigner";
import { refreshHoldings } from "@/hooks/useHoldings";
import { openLogin } from "@/lib/openLogin";
import { notify } from "@/components/kit/notify";
import { queueReducer, settle, retryPlan, type FreeQuota, type Job, type QueueAction } from "@/lib/ui/kit/render-queue";
import { serialSigner, trackSigner, type SerialTurn } from "@/lib/ui/kit/serial-signer";

/**
 * Where the editor keeps its jobs across reloads. Pass a stable object; a new
 * one takes the jobs along (the first release moves them to the prompt's id).
 * Another account never reaches it: /editor remounts (lib/editor/editor-mount).
 */
export interface JobStore<S> {
  load(): Promise<Job<S>[]>;
  save(jobs: Job<S>[]): void | Promise<void>;
}

export function useRenderQueue<S>({ toRequest, persist, onLeave, onReady, freeModelSelected = false, quotaKey = null }: {
  toRequest: (setup: S) => GenerationRequest;
  freeModelSelected?: boolean;
  quotaKey?: string | null;
  persist?: JobStore<S>;
  /** Runs when the surface unmounts, with the jobs at that moment. */
  onLeave?: (jobs: Job<S>[]) => void;
  /** Runs when a job's image is in, with the job's id and the image; also after the surface left (the request outlives it). */
  onReady?: (id: string, imageUrl: string) => void;
}) {
  const [jobs, dispatch] = useReducer(queueReducer<S>, []);
  const [note, setNote] = useState<FreeQuota | null>(null);
  const { quota: freeQuota, refresh: refreshQuota } = useFreeGenerationQuota(freeModelSelected, quotaKey);

  // One chain of signatures for the queue's lifetime, always with the current
  // wallet; made on the first Generate, because refs belong to handlers.
  const sign = usePaymentSigner();
  const latestSign = useRef(sign);
  const serial = useRef<SerialTurn | null>(null);

  const latest = useRef({ jobs, onLeave, onReady });
  useEffect(() => {
    latestSign.current = sign;
    latest.current = { jobs, onLeave, onReady };
  });
  useEffect(() => () => latest.current.onLeave?.(latest.current.jobs), []);

  const [loaded, setLoaded] = useState(!persist);
  useEffect(() => {
    if (!persist) return;
    let live = true;
    const done = (saved: Job<S>[]) => {
      if (!live) return;
      dispatch({ type: "restore", jobs: saved });
      setLoaded(true);
    };
    persist.load().then(done, () => done([]));
    return () => {
      live = false;
    };
  }, [persist]);
  useEffect(() => {
    // Not before the saved jobs are in, or the empty start would overwrite them.
    if (persist && loaded) persist.save(jobs);
  }, [persist, loaded, jobs]);

  // Applied to the handlers' copy at once, so a batch in flight reads the queue as it is; true when it changed anything.
  const publish = useCallback((action: QueueAction<S>) => {
    const next = queueReducer(latest.current.jobs, action);
    const changed = next !== latest.current.jobs;
    latest.current.jobs = next;
    dispatch(action);
    return changed;
  }, []);
  // Taken back before their request went out: their batch leaves them out, and their outcome is nobody's news.
  const cancelled = useRef(new Set<string>());

  const execute = useCallback((setups: S[], resume?: GenerationPayment[]) => {
    if (!setups.length) return;
    const ids = setups.map(setup => {
      const id = crypto.randomUUID();
      publish({ type: "enqueue", id, createdAt: Date.now(), setup });
      return id;
    });
    const requests = setups.map(toRequest);
    const watch: BatchWatch = {
      onSend: index => publish({ type: "sent", id: ids[index] }),
      cancelled: index => cancelled.current.has(ids[index]),
    };
    serial.current ??= serialSigner();
    // A cancelled order never opens the wallet, even one that waited its turn behind another prompt.
    // The connect runs in the same one-at-a-time turn as the signatures (it can open the wallet too), and a job
    // cancelled while it waited opens neither (verification 2026-10-18).
    const taken = () => ids.every(id => cancelled.current.has(id));
    const signer = trackSigner(Object.assign((transactions: string[]) => serial.current!(() =>
      taken() ? Promise.reject(new Error("Cancelled before signing")) : latestSign.current(transactions)),
    { prepare: () => serial.current!(() => taken() ? Promise.reject(new Error("Cancelled before signing")) : latestSign.current.prepare?.() ?? Promise.resolve()) }));
    void runGenerationBatch(requests, signer.sign, (outcome, index) => {
      const id = ids[index];
      if (cancelled.current.delete(id)) {
        if (outcome.payment) refreshHoldings();
        return;
      }
      const result = settle(id, outcome, signer.state());
      publish(result.action);
      if (result.action.type === "resolve") latest.current.onReady?.(id, result.action.imageUrl);
      if (result.toast) notify(result.toast, result.action.type === "fail" ? { tone: "error" } : undefined);
      if (result.login) openLogin();
      if (result.note) setNote(result.note);
      if (result.refresh) refreshHoldings();
    }, resume, async payments => {
      const paidIds = ids.filter((_, index) => requests[index].model && !requests[index].model.free);
      payments.forEach((payment, index) => publish({ type: "payment", id: paidIds[index], payment }));
      await persist?.save(latest.current.jobs);
    }, watch).then(() => {
      if (requests.some(request => request.model?.free)) void refreshQuota();
    });
  }, [toRequest, refreshQuota, persist, publish]);
  const runBatch = useCallback((setups: S[]) => execute(setups), [execute]);
  const run = useCallback((setup: S) => execute([setup]), [execute]);
  const retry = useCallback((id: string) => {
    const plan = retryPlan(jobs, id);
    if (!plan) return;
    if ("reason" in plan) return notify(plan.reason);
    for (const job of plan.jobs) dispatch({ type: "drop", id: job.id });
    execute(plan.jobs.map(job => job.setup), plan.resume);
  }, [jobs, execute]);
  const drop = useCallback((id: string) => dispatch({ type: "drop", id }), []);
  /** The X on a tile still in line (Kev, 2026-10-13): the job goes now; a deposit already on its way comes back with the batch's close. */
  const cancel = useCallback((id: string) => {
    const job = latest.current.jobs.find(j => j.id === id);
    if (!publish({ type: "cancel", id })) return;
    cancelled.current.add(id);
    // An intent image is charged only once made (DEC-88): its cancel charged nothing.
    notify(job?.payment && job.payment.paymentScheme !== "intent" ? "Cancelled · its payment is being refunded" : "Cancelled · nothing was charged");
  }, [publish]);
  const markSeen = useCallback((id: string) => dispatch({ type: "seen", id }), []);

  return { jobs, run, runBatch, retry, drop, cancel, markSeen, note, freeQuota };
}

/** The daily allowance is server-owned; no local fallback grants free images. */
export function useFreeGenerationQuota(enabled: boolean, accountKey: string | null = null) {
  const [stored, setStored] = useState<{ key: string | null; quota: FreeGenerationQuota | null }>({ key: accountKey, quota: null });
  const requestEpoch = useRef({ value: 0 });
  const refresh = useCallback(async () => {
    const epoch = ++requestEpoch.current.value;
    const result = await fetchFreeGenerationQuota();
    if (epoch === requestEpoch.current.value) setStored({ key: accountKey, quota: result });
    return result;
  }, [accountKey]);
  useEffect(() => {
    if (!enabled) return;
    const tracker = requestEpoch.current;
    void refresh();
    return () => { tracker.value++; };
  }, [enabled, refresh]);
  return { quota: stored.key === accountKey ? stored.quota : null, refresh };
}