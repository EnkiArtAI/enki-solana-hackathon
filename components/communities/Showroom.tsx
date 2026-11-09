"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useBetaAccess } from "@/components/BetaGate";
import ConfirmDialog from "@/components/kit/ConfirmDialog";
import FullscreenViewer from "@/components/kit/FullscreenViewer";
import PillMenu from "@/components/kit/PillMenu";
import Seal from "@/components/kit/Seal";
import { notify } from "@/components/kit/notify";
import { Icon } from "@/components/enki-shell/icons";
import { useCommunitiesApi, useCommunityShowroom, useShowroomPost } from "@/hooks/useCommunities";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import type { CommunityChip, ShowroomPost } from "@/lib/communities/types";
import { openCreator } from "@/lib/openCreator";
import { openLogin } from "@/lib/openLogin";
import { viewerHeaders } from "@/lib/session-headers";
import { openCommunity } from "@/lib/ui/communities/links";
import { formatAgo } from "@/lib/ui/kit/format";
import PostDialog from "./PostDialog";
import { WorkPanel } from "./WorksGrid";
import "@/components/studio/studio.css";
import "./communities.css";

/* A minute clock for "2h ago": read through a store, never in render (as the image view's). */
const minuteNow = () => Math.floor(Date.now() / 60_000) * 60_000;
const everyMinute = (tick: () => void) => { const t = setInterval(tick, 60_000); return () => clearInterval(t); };

/** The image's heart, the likes route every image uses (/api/images/[id]/likes): its count, and the viewer's own. */
function Heart({ imageId, count, signedIn }: { imageId: string; count: number; signedIn: boolean }) {
  const queryClient = useQueryClient();
  const key = ["image-like", imageId];
  const { data } = useQuery({
    queryKey: key, enabled: signedIn, staleTime: 60_000, retry: false,
    queryFn: async () => (await (await fetch(`/api/images/${encodeURIComponent(imageId)}/likes`, { headers: viewerHeaders() })).json()) as { count: number; mine: boolean },
  });
  const state = data ?? { count, mine: false };
  const flip = async () => {
    if (!signedIn) return openLogin();
    const res = await fetch(`/api/images/${encodeURIComponent(imageId)}/likes`, {
      method: "POST", headers: { "Content-Type": "application/json", ...viewerHeaders() }, body: JSON.stringify({ liked: !state.mine }),
    }).catch(() => null);
    if (!res?.ok) return notify("Couldn't save the like", { tone: "error" });
    queryClient.setQueryData(key, await res.json());
  };
  return (
    <button type="button" className="st-btn st-btn--small cm-heart" aria-pressed={state.mine} aria-label={state.mine ? "Unlike" : "Like"} onClick={() => void flip()}>
      <Icon name="heart" size={14} stroke={1.8} />{state.count}
    </button>
  );
}

/** One post: its render at its own ratio, title, caption, who and when, its other communities, the heart, an answer
 *  with your own version, and its answers in a strip under it. */
function PostCard({ post, handle, staff, signedIn, now, onAnswer, onView, onAll }: {
  post: ShowroomPost;
  handle: string;
  staff: boolean;
  signedIn: boolean;
  now: number;
  onAnswer: (p: ShowroomPost) => void;
  onView: (items: ShowroomPost[], i: number) => void;
  onAll: (p: ShowroomPost) => void;
}) {
  const router = useRouter();
  const api = useCommunitiesApi();
  const [more, setMore] = useState(false);
  const [ask, setAsk] = useState<"delete" | null>(null);
  const others = post.communities.filter((c) => c.handle !== handle);
  const fail = (e: Error) => notify(e.message, { tone: "error" });
  const options = [
    ...(staff && !post.mine ? [{ key: "hide", label: `Hide from c/${handle}` }] : []),
    ...(post.mine || staff ? [{ key: "delete", label: "Delete post" }] : []),
  ];
  return (
    <article className="cm-post">
      <button type="button" className="cm-post-pic" aria-label={`Open ${post.title}`} onClick={() => onView([post], 0)}>
        {/* eslint-disable-next-line @next/next/no-img-element -- a stored render */}
        <img src={post.work.url} alt="" loading="lazy" draggable={false} width={post.work.width ?? undefined} height={post.work.height ?? undefined} />
      </button>
      <div className="cm-post-body">
        <div className="cm-post-top">
          <h3 className="cm-post-title">{post.title}</h3>
          {options.length > 0 && (
            <span className="st-more">
              <PillMenu trigger={<Icon name="dots" size={15} stroke={2} />} ariaLabel="More" title={post.title} value={null} options={options}
                onPick={(k) => (k === "delete" ? setAsk("delete")
                  : void api.hide(handle, { kind: "post", id: post.id, hidden: true }).then(() => notify(`Hidden from c/${handle}`), fail))} />
            </span>
          )}
        </div>
        {post.caption && (
          <>
            <p className="cm-post-caption" data-clamp={more ? undefined : ""}>{post.caption}</p>
            {post.caption.length > 160 && <button type="button" className="cm-link" onClick={() => setMore(!more)}>{more ? "Less" : "More"}</button>}
          </>
        )}
        <div className="cm-post-meta">
          <button type="button" className="cm-by" disabled={!post.author.handle} onClick={() => post.author.handle && openCreator(post.author.handle, router)}>
            <span aria-hidden><Seal handle={post.author.handle ?? "?"} /></span>
            <span>{post.author.handle ? `@${post.author.handle}` : "A closed account"}</span>
          </button>
          <span className="cm-by-when">{now ? formatAgo(post.createdAt, now) : ""}</span>
        </div>
        {others.length > 0 && (
          <div className="cm-chips" aria-label="Also in">
            {others.map((c) => <button key={c.id} type="button" className="cm-chip" title={c.name} onClick={() => openCommunity(c.handle, router)}>c/{c.handle}</button>)}
          </div>
        )}
        <div className="cm-post-acts">
          <Heart imageId={post.work.imageId} count={post.work.likes} signedIn={signedIn} />
          <button type="button" className="st-btn st-btn--small" onClick={() => (signedIn ? onAnswer(post) : openLogin())}>
            <Icon name="plus" size={13} stroke={2} />Answer with your version
          </button>
        </div>
      </div>
      {post.answers > 0 && (
        <div className="cm-answers">
          <span className="kit-label">{post.answers} version{post.answers === 1 ? "" : "s"}</span>
          <div className="cm-answers-row">
            {post.latestAnswers.map((a, i) => (
              <button key={a.id} type="button" className="cm-answer" aria-label={`${a.title} by ${a.author.handle ? `@${a.author.handle}` : "someone"}`} onClick={() => onView(post.latestAnswers, i)}>
                {/* eslint-disable-next-line @next/next/no-img-element -- a stored render */}
                <img src={a.work.thumb} alt="" loading="lazy" draggable={false} />
              </button>
            ))}
          </div>
          {post.answers > post.latestAnswers.length && <button type="button" className="cm-link" onClick={() => onAll(post)}>See all</button>}
        </div>
      )}
      {ask === "delete" && (
        <ConfirmDialog title={`Delete ${post.title}?`} text="The post goes. Its render stays in its owner's gallery, and its answers become posts of their own."
          confirmLabel="Delete post" onCancel={() => setAsk(null)} onConfirm={() => { setAsk(null); api.deletePost(post.id).then(() => notify("Post deleted"), fail); }} />
      )}
    </article>
  );
}

/** Every answer of one post, read alone, in the viewer. */
function AllVersions({ id, onClose, onView }: { id: string; onClose: () => void; onView: (items: ShowroomPost[], i: number) => void }) {
  const { data, error } = useShowroomPost(id);
  useEffect(() => {
    if (error) notify(error, { tone: "error" });
    else if (data) onView(data.post.latestAnswers, 0);
    if (error || data) onClose();
    // Once, as the read answers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, error]);
  return null;
}

/**
 * A community's Showroom (Kev, 2026-10-30: "people would also like to just create together and share artpieces they
 * have done ... decoupled from prompts completely"; "to gather creations and play with each others creations too"):
 * posts of people's own renders, newest first, each with its answers, the versions others made of it.
 */
export default function Showroom({ community, staff, works, onWorks }: {
  community: CommunityChip;
  staff: boolean;
  /** Its works, for the empty Showroom's way on. */
  works: number;
  onWorks: () => void;
}) {
  const { access, role } = useBetaAccess();
  const signedIn = access === "ok" && role !== "team";
  const { items, loading, error, more, loadMore, loadingMore } = useCommunityShowroom(community.handle);
  const phone = useMediaQuery("(max-width: 767.98px)");
  const now = useSyncExternalStore(everyMinute, minuteNow, () => 0);
  const [dialog, setDialog] = useState<{ parent?: ShowroomPost } | null>(null);
  const [viewing, setViewing] = useState<{ items: ShowroomPost[]; i: number } | null>(null);
  const [all, setAll] = useState<string | null>(null);
  const post = () => (signedIn ? setDialog({}) : openLogin());
  const shown = viewing?.items[viewing.i];

  return (
    <div className="cm-tab">
      <div className="cm-tab-bar">
        <button type="button" className="st-btn st-btn--cta" onClick={post}><Icon name="plus" size={14} stroke={2} />Post a piece</button>
      </div>
      {error ? <p className="cm-err" role="alert">{error}</p>
        : !loading && !items.length ? (
          <div className="st-empty">
            <Icon name="image" size={28} stroke={1.5} />
            <h2 className="kit-title">No posts yet.</h2>
            <p>Post one of your renders.</p>
            {works > 0 && <button type="button" className="cm-link" onClick={onWorks}>See all {works} works →</button>}
          </div>
        ) : (
          <div className="cm-posts">
            {items.map((p) => (
              <PostCard key={p.id} post={p} handle={community.handle} staff={staff} signedIn={signedIn} now={now}
                onAnswer={(parent) => setDialog({ parent })} onView={(list, i) => setViewing({ items: list, i })} onAll={(p2) => setAll(p2.id)} />
            ))}
          </div>
        )}
      {more && <div className="cm-more"><button type="button" className="st-btn" disabled={loadingMore} onClick={loadMore}>{loadingMore ? "Loading…" : "Show more"}</button></div>}
      {dialog && <PostDialog community={community} parent={dialog.parent} onClose={() => setDialog(null)} />}
      {all && <AllVersions id={all} onClose={() => setAll(null)} onView={(list, i) => setViewing({ items: list, i })} />}
      {viewing && shown && (
        <FullscreenViewer items={viewing.items.map((p) => ({ key: p.id, src: p.work.url }))} index={viewing.i}
          onIndex={(i) => setViewing({ ...viewing, i })} onClose={() => setViewing(null)}
          layout={phone ? "stacked" : "side"} nav={phone ? "dots" : "thumbs"}
          panel={<><p className="cm-vpanel-by">{shown.title}</p><WorkPanel work={{ ...shown.work, owner: shown.author }} /></>} />
      )}
    </div>
  );
}
