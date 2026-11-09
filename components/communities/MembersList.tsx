"use client";

import { useRouter } from "next/navigation";
import Seal from "@/components/kit/Seal";
import { useCommunityMembers } from "@/hooks/useCommunities";
import { openCreator } from "@/lib/openCreator";
import "@/components/studio/studio.css";
import "./communities.css";

/** Who joined, newest first; the one who started it says so. A press opens their page, as every creator link does. */
export default function MembersList({ handle }: { handle: string }) {
  const router = useRouter();
  const { items, loading, error, more, loadMore, loadingMore } = useCommunityMembers(handle);
  if (error) return <p className="cm-err" role="alert">{error}</p>;
  if (!loading && !items.length) return <p className="cm-note">No members yet. Join to be the first.</p>;
  return (
    <div className="cm-members">
      {items.map((m, i) => (
        <button key={`${m.handle ?? "gone"}:${i}`} type="button" className="cm-member" disabled={!m.handle} onClick={() => m.handle && openCreator(m.handle, router)}>
          <span aria-hidden><Seal handle={m.handle ?? "?"} /></span>
          <span className="cm-member-name">{m.handle ? `@${m.handle}` : "A closed account"}</span>
          {m.creator && <span className="cm-mark">Started it</span>}
        </button>
      ))}
      {more && <div className="cm-more"><button type="button" className="st-btn" disabled={loadingMore} onClick={loadMore}>{loadingMore ? "Loading…" : "Show more"}</button></div>}
    </div>
  );
}
