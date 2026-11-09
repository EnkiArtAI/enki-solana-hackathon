"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useBetaAccess } from "@/components/BetaGate";
import FeedCard from "@/components/enki/FeedCard";
import MasonryGrid from "@/components/enki/MasonryGrid";
import ConfirmDialog from "@/components/kit/ConfirmDialog";
import PillMenu from "@/components/kit/PillMenu";
import { notify } from "@/components/kit/notify";
import PanelTabs from "@/components/enki-shell/PanelTabs";
import StudioDialog from "@/components/studio/StudioDialog";
import { Icon } from "@/components/enki-shell/icons";
import { useCommunitiesApi, useCommunity, useCommunityPrompts } from "@/hooks/useCommunities";
import { COMMUNITIES_NOT_READY, UNLISTED_LINE, type CommunityChip, type CommunityDetail } from "@/lib/communities/types";
import { openLogin } from "@/lib/openLogin";
import { toFeedCard, type FeedCard as Card } from "@/lib/ui/feed/card";
import { promptPage } from "@/lib/ui/image-view/open-link";
import { COMMUNITY_TABS, panelLink } from "@/lib/ui/kit/shell-nav";
import { communityFilterLink, communityHref, countsLine } from "@/lib/ui/communities/links";
import { Cover } from "./CommunityCard";
import CommunityDialog from "./CommunityDialog";
import CommunityPicker from "./CommunityPicker";
import MembersList from "./MembersList";
import Showroom from "./Showroom";
import WorksGrid from "./WorksGrid";
import "@/components/enki/feed.css";
import "@/components/studio/studio.css";
import "./communities.css";

/** The panel's way up, as Studio's pages have it: its own line at the top left, giving way with the phone header. */
export const Back = ({ onBack }: { onBack: () => void }) => (
  <button type="button" className="ek-panel-back kit-hit ek-tuck-hide" onClick={onBack} aria-label="Back" title="Back">
    <Icon name="chevronLeft" size={20} stroke={2} />
  </button>
);

/** A community's prompts: the feed's cards, filtered (Explore's Community filter shows the same). */
function Prompts({ handle }: { handle: string }) {
  const router = useRouter();
  const { items, loading, error, more, loadMore } = useCommunityPrompts(handle);
  const cards = items.flatMap((raw) => toFeedCard(raw) ?? []);
  // Explore with its filter, the panel left (it keeps the rest of the address, as every panel link).
  const explore = () => router.push(communityFilterLink(panelLink(window.location.href, null), handle));
  return (
    <div className="cm-tab">
      <div className="cm-tab-bar">
        <span className="kit-label">Prompts linked to c/{handle}</span>
        <button type="button" className="cm-link" onClick={explore}>Open in Explore →</button>
      </div>
      {error ? <p className="cm-err" role="alert">{error}</p>
        : !loading && !cards.length ? <p className="cm-note">No prompts here yet. Pick c/{handle} when you release one.</p>
        : (
          <div className="cm-feed">
            <MasonryGrid items={cards} skeletons={loading ? 6 : 0}
              renderItem={(card: Card) => <FeedCard card={card} canBookmark={false} saved={undefined} onOpen={(c) => router.push(promptPage(c.id))} />} />
          </div>
        )}
      {more && <div className="cm-more"><button type="button" className="st-btn" onClick={loadMore}>Show more</button></div>}
    </div>
  );
}

type Ask = "edit" | "merge" | "delete" | "leave" | null;

/**
 * One community (the agreed shape, 2026-10-30): its cover, name, c/handle, description, Join, its members and works, then
 * Showroom | Works | Prompts | Members (Kev: "to gather creations and play with each others creations too"). A merged
 * or look-alike handle gives way to the community it names, in place (`onReplace`), so Back never lands on it.
 */
export default function CommunityPage({ handle, tab, onTab, onBack, onReplace }: {
  handle: string;
  tab?: string;
  onTab: (tab: string) => void;
  onBack: () => void;
  /** Its own page in place of this one: a redirect, or the directory (null) once it is deleted. */
  onReplace: (handle: string | null) => void;
}) {
  const { data, notReady, error, retry } = useCommunity(handle);
  const redirect = data && "redirect" in data ? data.redirect : null;
  useEffect(() => {
    if (redirect) onReplace(redirect);
    // The answer decides, once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [redirect]);
  const c = data && "community" in data ? data.community : null;
  if (!c) {
    return (
      <>
        <Back onBack={onBack} />
        <div className="ek-page cm-page">
          <div className="st-empty">
            <Icon name="users" size={28} stroke={1.5} />
            <h2 className="kit-title">{notReady ? COMMUNITIES_NOT_READY : error ?? (redirect ? "Taking you there…" : "Loading the community…")}</h2>
            {error && <button type="button" className="st-btn" onClick={retry}>Try again</button>}
          </div>
        </div>
      </>
    );
  }
  return <Page key={c.id} c={c} tab={tab} onTab={onTab} onBack={onBack} onReplace={onReplace} />;
}

function Page({ c, tab, onTab, onBack, onReplace }: {
  c: CommunityDetail;
  tab?: string;
  onTab: (tab: string) => void;
  onBack: () => void;
  onReplace: (handle: string | null) => void;
}) {
  const api = useCommunitiesApi();
  const { access, role } = useBetaAccess();
  const signedIn = access === "ok" && role !== "team";
  const [ask, setAsk] = useState<Ask>(null);
  const [into, setInto] = useState<CommunityChip[]>([]);
  const [busy, setBusy] = useState(false);
  const fail = (e: Error) => notify(e.message, { tone: "error" });
  const chip: CommunityChip = { id: c.id, handle: c.handle, name: c.name };

  const join = async () => {
    if (!signedIn) return openLogin();
    setBusy(true);
    await api.join(c.handle).then(() => notify(`Joined c/${c.handle}`), fail);
    setBusy(false);
  };
  const leave = async () => {
    setAsk(null);
    setBusy(true);
    await api.leave(c.handle).then(() => notify(`Left c/${c.handle}`), fail);
    setBusy(false);
  };
  const copy = () => void navigator.clipboard.writeText(window.location.origin + communityHref(c.handle))
    .then(() => notify("Link copied"), () => notify("Couldn't copy that", { tone: "error" }));
  const options = [
    ...(c.canEdit ? [{ key: "edit", label: "Edit" }] : []),
    ...(c.staff === "admin" ? [{ key: "merge", label: "Merge into…" }, { key: "delete", label: "Delete community" }] : []),
  ];
  const target = into[0];

  return (
    <>
      <Back onBack={onBack} />
      <div className="ek-page cm-page kit-focus">
        <header className="cm-head">
          <span className="cm-head-cover"><Cover card={c} /></span>
          <div className="cm-head-main">
            <h1 className="kit-title cm-head-name">{c.name}</h1>
            <span className="cm-head-handle">c/{c.handle}
              <button type="button" className="cm-icon-btn kit-hit" aria-label="Copy its link" title="Copy its link" onClick={copy}><Icon name="link" size={14} stroke={1.8} /></button>
            </span>
            {c.description && <p className="cm-head-desc">{c.description}</p>}
            <p className="cm-head-counts">{countsLine(c)}</p>
            {!c.listed && <p className="cm-unlisted">{UNLISTED_LINE}</p>}
            <div className="cm-head-acts">
              {c.joined ? (
                <button type="button" className="st-btn cm-joined" disabled={busy} onClick={() => setAsk("leave")}><Icon name="check" size={14} stroke={2.2} />Joined</button>
              ) : (
                <button type="button" className="st-btn st-btn--cta" disabled={busy} onClick={() => void join()}>Join</button>
              )}
              {options.length > 0 && (
                <span className="st-more">
                  <PillMenu trigger={<Icon name="dots" size={15} stroke={2} />} ariaLabel="More" title={`c/${c.handle}`} value={null} options={options}
                    onPick={(k) => setAsk(k as Ask)} />
                </span>
              )}
            </div>
          </div>
        </header>
      </div>
      <PanelTabs tabs={COMMUNITY_TABS} tab={tab} onTab={onTab} label="Showroom, works, prompts or members">
        {(t) => (
          <div className="ek-page cm-page kit-focus">
            {t === "showroom" ? <Showroom community={chip} staff={!!c.staff} works={c.works} onWorks={() => onTab("works")} />
              : t === "works" ? <WorksGrid handle={c.handle} staff={!!c.staff} />
              : t === "prompts" ? <Prompts handle={c.handle} />
              : <div className="cm-tab"><MembersList handle={c.handle} /></div>}
          </div>
        )}
      </PanelTabs>

      {ask === "leave" && (
        <ConfirmDialog title={`Leave c/${c.handle}?`} text="Your works stay in it. You can join again any time." confirmLabel="Leave"
          onCancel={() => setAsk(null)} onConfirm={() => void leave()} />
      )}
      {ask === "edit" && <CommunityDialog edit={c} onClose={() => setAsk(null)} onDone={() => setAsk(null)} />}
      {ask === "merge" && !target && (
        <StudioDialog title={`Merge c/${c.handle} into…`} onClose={() => setAsk(null)}
          foot={<><button type="button" className="st-btn st-btn--quiet" onClick={() => setAsk(null)}>Cancel</button><span /></>}>
          <p className="st-line">Pick the community it becomes part of.</p>
          <CommunityPicker mode="single" value={into} onChange={(next) => setInto(next.filter((x) => x.id !== c.id))} label="Merge into" autoFocus create={false} />
        </StudioDialog>
      )}
      {ask === "merge" && target && (
        <ConfirmDialog title={`Merge c/${c.handle} into c/${target.handle}?`}
          text={`Its works, prompts, posts and members move there, and c/${c.handle} sends people to c/${target.handle}.`} confirmLabel="Merge"
          onCancel={() => { setInto([]); setAsk(null); }}
          onConfirm={() => {
            setAsk(null);
            setInto([]);
            api.merge({ from: c.id, into: target.id }).then(() => { notify(`c/${c.handle} is part of c/${target.handle} now`); onReplace(target.handle); }, fail);
          }} />
      )}
      {ask === "delete" && (
        <ConfirmDialog title={`Delete c/${c.handle}?`} text="The community, its members and its links go for good, and its handle is free again. Works, prompts and posts stay where else they are."
          confirmLabel="Delete community" onCancel={() => setAsk(null)}
          onConfirm={() => { setAsk(null); api.remove(c.handle).then(() => { notify(`c/${c.handle} is deleted`); onReplace(null); }, fail); }} />
      )}
    </>
  );
}
