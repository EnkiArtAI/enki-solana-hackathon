"use client";

import { useState, type MouseEvent } from "react";
import { useRouter } from "next/navigation";
import Segmented from "@/components/kit/Segmented";
import { useBetaAccess } from "@/components/BetaGate";
import { stashEditorSeed } from "@/components/enki-shell/editorBridge";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useReferenceLibrary } from "@/hooks/useReferenceLibrary";
import { useVideoRun } from "@/hooks/useVideoRun";
import { librarySeed } from "@/lib/editor/editor-seed";
import { IV_MOBILE } from "@/lib/ui/kit/breakpoints";
import { promptName } from "@/lib/ui/create/image";
import { mediaLink } from "@/lib/ui/feed/world";
import { VIDEO_MAKING, jobRunning, type VideoJobView } from "@/lib/video/job-view";
import { openLogin } from "@/lib/openLogin";
import StudioStrip from "@/components/studio/StudioStrip";
import type { StudioScopeValue } from "@/components/studio/StudioScope";
import VideoComposer from "./VideoComposer";
import { useVideoDraft } from "./useVideoDraft";
import "@/components/remix/remix.css";
import "./video.css";

type Tab = "history" | "how";
const TABS: Array<{ key: Tab; label: string }> = [{ key: "history", label: "History" }, { key: "how", label: "How it works" }];
const HOW: ReadonlyArray<[string, string]> = [
  ["Add a frame or a reference", "Words alone are enough. Give a first and a last frame, or pictures and clips to follow, where the model takes them."],
  ["Pick a model", "Each one has its own lengths, sizes and sound. The price is on Generate before you press it."],
  ["Get your video", "It shows up in History, ready to watch."],
];
/** Explore on Videos, where the How it works tab sends a buyer without an idea (Kev, 2026-10-30: "don't know what to
    create? become inspired by our creators ... ein link quasi ... als image der zu Explore -> videos führt"). */
export const EXPLORE_VIDEOS = mediaLink("/home", "", "videos");

/** One of History's: a spinner while it is made, its sentence if it ended without a video, the player once delivered, with its sound under the control. */
export function JobCard({ job }: { job: VideoJobView }) {
  const running = jobRunning(job.status);
  return (
    <li className="vg-job" data-state={job.status}>
      {job.video ? (
        <video className="vg-job-video" controls playsInline preload="none" poster={job.video.poster} src={job.video.v720}
          style={job.video.width && job.video.height ? { aspectRatio: `${job.video.width} / ${job.video.height}` } : undefined} />
      ) : running ? <span className="vg-job-wait"><span className="kit-spinner" aria-hidden /></span> : null}
      <p className="vg-job-line">
        <span className="vg-model-name">{job.label ?? "Video"}</span>
        {running ? <span role="status">{VIDEO_MAKING}</span> : job.why ? <span role="alert">{job.why}</span> : null}
      </p>
    </li>
  );
}

/**
 * Create > Video, after Sume's video page (Kev, 2026-10-30: "die UI für image und video generations die genauso
 * aussehen sollten wie bei sume"), in Remix's frame (remix.css): the composer on the left, History | How it works on its
 * right; on a phone one column, the composer first. History holds the buyer's videos, under way or made. The tabs glide as Create's
 * and Explore's rows do (Kev, 2026-10-30: "switch between history und how it works must be as responsive as between the
 * other pills"); How it works spans the area, its words larger, over a picture that opens Explore's videos.
 */
export default function VideoView({ guest, studio }: { guest: boolean; studio?: StudioScopeValue | null }) {
  const router = useRouter();
  const { userId } = useBetaAccess();
  const d = useVideoDraft();
  const library = useReferenceLibrary(!guest);
  const run = useVideoRun({ enabled: !guest });
  const phone = useMediaQuery(IV_MOBILE);
  const [tab, setTab] = useState<Tab>("history");
  /* The words to the prompt editor on Video (Kev, 2026-11-03: "nur dass create prompt einen zusatz zum switchen hat"), as
     Quick Create's "Make it a prompt" carries them (GenerateLauncher makePrompt); a guest signs in first. */
  const makePrompt = () => {
    if (guest) return openLogin();
    const seed = librarySeed({ name: promptName(d.prompt), prompt_text: d.prompt, media: "video" });
    if (seed) stashEditorSeed(seed, userId);
    router.push("/editor");
  };
  // A plain click stays in the app, as the menu's Explore does; a modified one opens the link as a link.
  const toExplore = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    router.push(EXPLORE_VIDEOS, { scroll: false });
    window.scrollTo({ top: 0 });
  };
  return (
    <section className="rx vg" aria-label="Video">
      {/* In a Studio project: its strip and its words over the composer; no filing yet (no video route). */}
      {studio && <StudioStrip scope={studio} tool="video" text={d.prompt} setText={d.setPrompt} />}
      <VideoComposer d={d} guest={guest} phone={phone} library={library} onMakePrompt={makePrompt} run={run} />
      <div className="rx-lib">
        <Segmented slide role="tablist" ariaLabel="Your videos or how it works" value={tab} onChange={setTab} options={TABS} />
        {tab === "history" ? (run.jobs.length ? (
          <ul className="vg-jobs">{run.jobs.map((job) => <JobCard key={job.id} job={job} />)}</ul>
        ) : (
          <section className="rx-empty">
            <h3 className="kit-title">No videos yet.</h3>
            <p>The videos you make show up here.</p>
          </section>
        )) : (
          <>
            <ol className="vg-how">
              {HOW.map(([title, line], i) => (
                <li key={title} className="vg-how-card">
                  <span className="kit-label">Step {i + 1}</span>
                  <h3 className="kit-title">{title}</h3>
                  <p>{line}</p>
                </li>
              ))}
            </ol>
            <a className="vg-inspire" href={EXPLORE_VIDEOS} onClick={toExplore}>
              {/* One of Enki's own pictures, as on the landing page (public/previews). */}
              {/* eslint-disable-next-line @next/next/no-img-element -- a static picture under the words */}
              <img className="vg-inspire-img" src="/previews/crystal-purple.webp" alt="" loading="lazy" />
              <span className="kit-title">Don&apos;t know what to create?</span>
              <span className="vg-inspire-go">Get inspired by our creators →</span>
            </a>
          </>
        )}
      </div>
    </section>
  );
}
