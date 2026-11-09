"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { useBetaAccess } from "@/components/BetaGate";
import { stashEditorSeed } from "@/components/enki-shell/editorBridge";
import EnkiDetailPanel from "@/components/enki/EnkiDetailPanel";
import ViewerPanel from "@/components/image-view/ViewerPanel";
import { useOpenRender } from "@/components/image-view/useOpenRender";
import { useOwnRenders } from "@/components/image-view/useOwnRenders";
import { copyText, useImageViewModel, type Shot } from "@/components/image-view/useImageViewModel";
import FullscreenViewer from "@/components/kit/FullscreenViewer";
import { notify, useToastOffset } from "@/components/kit/notify";
import { useStepUp } from "@/components/StepUpProvider";
import StudioSheet from "@/components/studio/StudioSheet";
import StudioStrip from "@/components/studio/StudioStrip";
import { StudioFiling } from "@/components/studio/useFiling";
import { BarCommunities, CommunityLinking } from "@/components/communities/CommunityLinking";
import type { CommunityChip } from "@/lib/communities/types";
import { useBookmarkIndex } from "@/hooks/useBookmarkIndex";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useViewerWallets } from "@/hooks/useViewerWallets";
import { librarySeed } from "@/lib/editor/editor-seed";
import { openLogin } from "@/lib/openLogin";
import { sessionAuthHeaders } from "@/lib/session-headers";
import { sendToVideo } from "@/lib/ui/create/handoff";
import { promptName, recreatePlan, shotId, wallItems, wallShot, withoutRow, type OwnRow, type WallItem } from "@/lib/ui/create/image";
import { referenceRefusal, type TileFacts } from "@/lib/ui/create/tile-actions";
import type { GenerationsPage } from "@/lib/ui/image-view/history";
import type { ImageViewSeed } from "@/lib/ui/image-view/seed";
import { IV_MOBILE } from "@/lib/ui/kit/breakpoints";
import ImageBar from "./ImageBar";
import ImageWall from "./ImageWall";
import { ViewerActs, type TileActs } from "./TileActions";
import "@/components/image-view/image-view.css";

/**
 * Create > Image after Sume's image page (Kev, 2026-10-30: "it has to look exactly like on sume, with the generate
 * looking like our quick create with the create prompt zusatz"): the viewer's images on a wall, the generate bar over the
 * window's foot. The bar is the blank image composer (useImageViewModel "blank"), so its jobs land at the wall's top and
 * its Generate is every other surface's; Recreate on an image loads that image's setup into the bar. A click on a
 * picture opens it in the image view's viewer, as the profile's wall does, and so does its "Your render is ready"
 * notice (useOpenRender, as the blank image view took it before this page). In a Studio project (StudioScope) the bar
 * carries its strip, the renders started in a content piece are filed there, and a character sheet the address names
 * opens in the image view over the wall. Each finished picture carries its actions (TileActions: the rail, Reference and
 * Animate, ⋯), and the viewer Recreate, Reference and Animate too.
 */
export default function CreateImage() {
  const m = useImageViewModel("blank");
  const phone = useMediaQuery(IV_MOBILE);
  const { userId } = useBetaAccess();
  const { userKey } = useViewerWallets();
  // The account first, as the image view reads its renders (an email login has no wallet key); every prompt's.
  const mine = useOwnRenders({ userKey: m.guest ? null : (userId ?? userKey), promptId: null, jobs: m.jobs, all: true });
  const prompt = useRef<HTMLTextAreaElement>(null);
  const wall = useRef<HTMLDivElement>(null);
  const [lift, setLift] = useState<number | null>(null);
  useToastOffset(lift);
  // Someone's listed prompt: its image view on that render, as the profile's Recreate opens it.
  const [open, setOpen] = useState<ImageViewSeed | null>(null);
  // The picture in the viewer, by shotId: a job keeps its place once its row is in.
  const [viewing, setViewing] = useState<string | null>(null);
  // The renders deleted here, by row and by job: they leave the wall at once.
  const [gone, setGone] = useState<ReadonlySet<string>>(() => new Set());
  const router = useRouter();
  const queryClient = useQueryClient();
  const { guarded } = useStepUp();
  const marks = useBookmarkIndex(!m.guest);
  // The communities the next renders go to, kept while Create is open (CommunityLinking links each once its row is in).
  const [communities, setCommunities] = useState<CommunityChip[]>([]);

  const items = wallItems(m.jobs, mine.rows as OwnRow[], gone);
  const shots = items.flatMap((it) => wallShot(it) ?? []);
  const at = viewing ? shots.findIndex((s) => shotId(s) === viewing) : -1;
  const view = (s: Shot) => {
    const shot = shots.find((x) => shotId(x) === shotId(s));
    if (!shot) return;
    m.seen(shot);
    setViewing(shotId(shot));
  };
  useOpenRender(m, view, wall);

  const recreate = (item: WallItem) => {
    const plan = recreatePlan(item, m.jobs);
    if (!plan) return;
    if ("open" in plan) return setOpen(plan.open);
    if (plan.reset) m.resetSettings();
    m.select(plan.shot);
    if (plan.text !== null) m.setText(plan.text);
    m.setCount(plan.count);
    if (plan.unrecorded) notify("Its settings were not recorded: only its words are in the bar");
    prompt.current?.focus({ preventScroll: true });
  };

  const acts: TileActs = {
    guest: m.guest,
    marks,
    recreate,
    // A picture's words to the editor, as the bar's own "Make it a prompt →" carries the bar's.
    prompt: (words) => {
      if (m.guest) return openLogin();
      const seed = librarySeed({ name: promptName(words), prompt_text: words });
      if (seed) stashEditorSeed(seed, userId);
      router.push("/editor");
    },
    // Into the bar's references as a picked one (Kev, 2026-10-30: "wird als reference image eingefügt unten im editor"),
    // inside the generator's room.
    reference: (f: TileFacts) => {
      if (m.guest) return openLogin();
      const why = referenceRefusal({ cap: m.cap, room: m.room, refs: m.refs, pending: m.pending, name: m.core.entry?.name ?? "This generator" }, f.src);
      if (why) return notify(why);
      m.addUrls([f.src]);
    },
    animate: (f: TileFacts) => router.push(sendToVideo({ url: f.url, thumb: f.thumb })),
    // The profile's delete (DELETE /api/images/[id], step-up when the account asks for it); a cancelled step-up is silent,
    // an ended session signs in again (review 2026-10-30: it failed without a word).
    remove: async (item) => {
      if (item.kind !== "row") return;
      const id = item.row.id;
      const res = await guarded(`delete-work:${id}`, (h) =>
        fetch(`/api/images/${encodeURIComponent(id)}`, { method: "DELETE", headers: { ...sessionAuthHeaders(), ...h } }),
      ).catch(() => null);
      if (res?.status === 401) {
        if ((await res.json().catch(() => null))?.stepUp) return;
        notify("Sign in again to delete this image", { tone: "error" });
        return openLogin();
      }
      if (!res?.ok) return notify("Couldn't delete this image", { tone: "error" });
      setGone((g) => new Set([...g, id, ...(item.job ? [item.job.id] : [])]));
      // Off the rows read as well, so the wall opened again does not draw it from them; then read again (a page one
      // short would end "Load older").
      queryClient.setQueriesData<InfiniteData<GenerationsPage>>({ queryKey: ["user-generations"] }, (d) => withoutRow(d, id));
      void queryClient.invalidateQueries({ queryKey: ["user-generations"] });
      notify("Image deleted");
    },
  };
  const viewed = at >= 0 ? items.find((it) => it.key === shots[at].key) : undefined;

  return (
    <>
      <ImageWall root={wall} items={items} state={mine} acts={acts}
        onOpen={(item) => { const s = wallShot(item); if (s) view(s); }}
        onCancel={(job) => m.cancel({ key: `job:${job.id}`, kind: "job", job, ratio: job.setup.aspectRatio })}
        onCopy={(job) => copyText(job.setup.prompt, "Prompt copied")} />
      <ImageBar model={m} phone={phone} promptRef={prompt} onLift={setLift}
        top={<StudioStrip tool="image" text={m.text ?? ""} setText={m.setText} />}
        afterPlus={!m.guest && <BarCommunities picks={communities} onPicks={setCommunities} text={m.text ?? ""} />} />
      <StudioFiling jobs={m.jobs} rows={mine.rows} />
      <CommunityLinking jobs={m.jobs} rows={mine.rows} picks={communities} />
      {open ? <EnkiDetailPanel key={`${open.promptId}:${open.recreateImageId ?? ""}`} seed={open} onClose={() => setOpen(null)} /> : <StudioSheet />}
      {at >= 0 && (
        // Closing leaves the bar as it is: looking at a picture is not Recreate.
        <FullscreenViewer items={shots.map((s) => ({ key: s.key, src: s.src, ratio: s.ratio }))} index={at}
          onIndex={(i) => view(shots[i])} onClose={() => setViewing(null)}
          layout={phone ? "stacked" : "side"} nav={phone ? "dots" : "thumbs"}
          panel={<ViewerPanel model={m} shot={shots[at]} phone={phone} onAgain={() => setViewing(null)}
            more={viewed && <ViewerActs item={viewed} acts={acts} onClose={() => setViewing(null)} />} />} />
      )}
    </>
  );
}
