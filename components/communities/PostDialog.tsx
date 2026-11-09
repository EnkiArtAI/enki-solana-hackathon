"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useBetaAccess } from "@/components/BetaGate";
import { notify } from "@/components/kit/notify";
import { useStepUp } from "@/components/StepUpProvider";
import StudioDialog from "@/components/studio/StudioDialog";
import { useOwnRenders } from "@/components/image-view/useOwnRenders";
import { CommunityError, useCommunitiesApi } from "@/hooks/useCommunities";
import { useViewerWallets } from "@/hooks/useViewerWallets";
import {
  ALREADY_POSTED, COMMUNITY_TEXT, MAKE_PUBLIC_FIRST, PICK_A_COMMUNITY, TITLE_NEEDED, TOO_LONG,
  type CommunityChip, type ShowroomPost,
} from "@/lib/communities/types";
import { sessionAuthHeaders } from "@/lib/session-headers";
import { addPick } from "@/lib/ui/communities/picker";
import CommunityDialog from "./CommunityDialog";
import CommunityPicker from "./CommunityPicker";
import "@/components/studio/studio.css";
import "./communities.css";

/** The render a post shows: one of the poster's own, by its row. */
export type PostRender = { id: string; thumb: string; public: boolean };
/** Said after a refused post, when the box had made its render public on the way. */
export const BACK_TO_PRIVATE = "Your render is private again.";
export const STAYED_PUBLIC = "Your render stayed public; its viewer can make it private.";

/**
 * Post to a community's Showroom (Kev, 2026-10-30: "people would also like to just create together and share artpieces
 * they have done. so we might need some sort of a showroom, decoupled from prompts completely"): one of your own renders
 * (no uploads in v1), a title, a caption and its communities; or an answer to a post with your own version, which
 * takes the post's communities. Posting shows the render to everyone: a private one is made public on the way, by the
 * box that says so (on by default); unticked, Post waits.
 */
export default function PostDialog({ community, parent, render: chosen, onClose, onDone }: {
  /** The community it is posted from (prefilled). */
  community?: CommunityChip;
  /** Answers this post. */
  parent?: ShowroomPost;
  /** Picked already (a render's ⋯ menu): no first step. */
  render?: PostRender;
  onClose: () => void;
  onDone?: (post: ShowroomPost) => void;
}) {
  const api = useCommunitiesApi();
  const queryClient = useQueryClient();
  const { guarded } = useStepUp();
  const { userId } = useBetaAccess();
  const { userKey } = useViewerWallets();
  const mine = useOwnRenders({ userKey: chosen ? null : (userId ?? userKey), promptId: null, jobs: [], all: true });
  const [render, setRender] = useState<PostRender | null>(chosen ?? null);
  const [title, setTitle] = useState("");
  const [caption, setCaption] = useState("");
  const [picks, setPicks] = useState<CommunityChip[]>(parent ? parent.communities : community ? [community] : []);
  const [makePublic, setMakePublic] = useState(true);
  const [posted, setPosted] = useState<ReadonlySet<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // "+ Create c/…" from its picker: that dialog in this one's place (never one over the other), back with the new pick.
  const [creating, setCreating] = useState<string | null>(null);
  const renders = mine.rows.filter((r) => !r.isUploaded && (r.thumbnail_url ?? r.image_urls[0] ?? r.image_url));
  const step = render ? "details" : "render";
  const blocked = !!render && !render.public && !makePublic;

  const send = async () => {
    if (!render || busy) return;
    const t = title.trim();
    if (!t) return setError(TITLE_NEEDED);
    if (t.length > COMMUNITY_TEXT.title) return setError(TOO_LONG.title);
    if (caption.length > COMMUNITY_TEXT.caption) return setError(TOO_LONG.caption);
    if (!parent && !picks.length) return setError(PICK_A_COMMUNITY);
    if (blocked) return setError(MAKE_PUBLIC_FIRST);
    setBusy(true);
    setError(null);
    const id = render.id;
    // Who sees it, by the route the viewer's own Public switch uses; its galleries read it anew (useImageViewModel setPublic).
    const show = async (visibility: "public" | "private") => {
      const res = await guarded(`make-${visibility}:${id}`, (h) => fetch(`/api/images/${encodeURIComponent(id)}`, {
        method: "PATCH", headers: { "Content-Type": "application/json", ...sessionAuthHeaders(), ...h }, body: JSON.stringify({ visibility }),
      })).catch(() => null);
      void queryClient.invalidateQueries({ queryKey: ["user-generations"] });
      void queryClient.invalidateQueries({ queryKey: ["prompt-public-images"] });
      return res;
    };
    let madePublic = false;
    try {
      if (!render.public) {
        const res = await show("public");
        if (!res?.ok) throw new Error(((await res?.json().catch(() => null)) as { error?: string } | null)?.error ?? MAKE_PUBLIC_FIRST);
        madePublic = true;
      }
      const out = await api.post({ imageId: id, title: t, caption: caption.trim() || null, parentId: parent?.id ?? null, ...(!parent && { communityIds: picks.map((p) => p.id) }) });
      notify(parent ? "Your version is posted" : `Posted to ${picks.length === 1 ? `c/${picks[0].handle}` : `${picks.length} communities`}`);
      onDone?.(out.post);
      onClose();
    } catch (e) {
      if (e instanceof CommunityError && e.message === ALREADY_POSTED) setPosted(new Set([...posted, id]));
      let why = (e as Error).message;
      // The box made it public to post it, nothing more (review 2026-10-30): the post refused, it goes back to private.
      if (madePublic) {
        if ((await show("private"))?.ok) why += " " + BACK_TO_PRIVATE;
        else { setRender({ ...render, public: true }); why += " " + STAYED_PUBLIC; }
      }
      setError(why);
    } finally {
      setBusy(false);
    }
  };

  if (creating !== null) {
    const back = (c?: CommunityChip) => { setCreating(null); if (c) setPicks(addPick(picks, { id: c.id, handle: c.handle, name: c.name })); };
    return <CommunityDialog name={creating} onClose={() => back()} onPick={back} onDone={back} />;
  }
  return (
    <StudioDialog step={step} onClose={onClose}
      title={parent ? "Answer with your version" : "Post a piece"}
      marks={!chosen && <><span data-on={step === "render" || undefined}>1 Render</span> · <span data-on={step === "details" || undefined}>2 Post</span></>}
      foot={step === "render" ? (
        <><button type="button" className="st-btn st-btn--quiet" onClick={onClose}>Cancel</button><span /></>
      ) : (
        <>
          <button type="button" className="st-btn st-btn--quiet" onClick={() => (chosen ? onClose() : setRender(null))}>{chosen ? "Cancel" : "Back"}</button>
          <button type="button" className="st-btn st-btn--cta" disabled={busy || posted.has(render!.id)} aria-disabled={blocked || undefined}
            title={blocked ? MAKE_PUBLIC_FIRST : undefined} onClick={() => void send()}>
            {busy ? "Posting…" : "Post"}
          </button>
        </>
      )}>
      {step === "render" ? (
        <>
          <p className="st-line">Pick one of your renders. Uploads cannot be posted.</p>
          {mine.failed ? <p className="st-err" role="alert">Couldn&apos;t read your renders.</p>
            : mine.loading ? <p className="st-line">Reading your renders…</p>
            : !renders.length ? <p className="st-line">You have no renders yet. Make one in Create, then post it here.</p>
            : (
              <div className="cm-render-pick" role="listbox" aria-label="Your renders">
                {renders.map((r) => (
                  <button key={r.id} type="button" role="option" aria-selected={false} className="cm-render-tile" disabled={posted.has(r.id)}
                    onClick={() => setRender({ id: r.id, thumb: r.thumbnail_url ?? r.image_urls[0] ?? r.image_url ?? "", public: r.visibility === "public" })}>
                    {/* eslint-disable-next-line @next/next/no-img-element -- the viewer's own render */}
                    <img src={r.thumbnail_url ?? r.image_urls[0] ?? r.image_url ?? ""} alt="" loading="lazy" draggable={false} />
                    {posted.has(r.id) && <span className="cm-new">Posted</span>}
                  </button>
                ))}
              </div>
            )}
        </>
      ) : (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element -- the viewer's own render */}
          <img className="cm-post-preview" src={render!.thumb} alt="" draggable={false} />
          <label className="st-field">
            <span className="st-field-head"><span className="kit-label">Title</span><span className="st-count">{title.trim().length} / {COMMUNITY_TEXT.title}</span></span>
            <input data-autofocus className="st-input" value={title} placeholder="What is it?" onChange={(e) => { setTitle(e.target.value); setError(null); }} />
          </label>
          <label className="st-field">
            <span className="st-field-head"><span className="kit-label">Caption · optional</span><span className="st-count">{caption.length} / {COMMUNITY_TEXT.caption}</span></span>
            <textarea className="st-input st-area" rows={3} value={caption} onChange={(e) => setCaption(e.target.value)} />
          </label>
          <div className="st-field">
            <span className="kit-label">Communities</span>
            {parent ? (
              <>
                <p className="st-line">Answers {parent.communities.map((c) => `c/${c.handle}`).join(", ")} · {parent.title}</p>
                <p className="st-note">An answer shows under the post, in every community it is in.</p>
              </>
            ) : <CommunityPicker value={picks} onChange={(p) => { setPicks(p); setError(null); }} text={`${title} ${caption}`} onCreate={setCreating} />}
          </div>
          {!render!.public && (
            <label className="cm-check">
              <input type="checkbox" checked={makePublic} onChange={(e) => { setMakePublic(e.target.checked); setError(null); }} />
              <span>Make this render public. Posting shows it to everyone.</span>
            </label>
          )}
          {blocked && <p className="st-note" role="status">{MAKE_PUBLIC_FIRST}</p>}
          {posted.has(render!.id) && <p className="st-note">{ALREADY_POSTED}</p>}
        </>
      )}
      {error && error !== MAKE_PUBLIC_FIRST && error !== ALREADY_POSTED && <p className="st-err" role="alert">{error}</p>}
    </StudioDialog>
  );
}
