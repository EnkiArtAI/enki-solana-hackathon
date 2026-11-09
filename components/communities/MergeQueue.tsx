"use client";

import { useState } from "react";
import ConfirmDialog from "@/components/kit/ConfirmDialog";
import { notify } from "@/components/kit/notify";
import { useCommunitiesApi, useMergeQueue } from "@/hooks/useCommunities";
import { COMMUNITIES_NOT_READY, type MergeGroup } from "@/lib/communities/types";
import { compact } from "@/lib/ui/communities/links";
import "@/components/studio/studio.css";
import "./communities.css";

type Row = MergeGroup["communities"][number];
/** The biggest of a group: the default target. */
const biggest = (g: MergeGroup) => [...g.communities].sort((a, b) => b.members + b.works - (a.members + a.works))[0];

/** One group of possible duplicates: a table, a target, its merges one after another (each asked first), or kept apart. */
function Group({ group }: { group: MergeGroup }) {
  const api = useCommunitiesApi();
  const [target, setTarget] = useState<string>(biggest(group).id);
  const [queue, setQueue] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  // The one picked, or the biggest once it left the group (merged or deleted elsewhere, then read anew; review 2026-10-30).
  const into = group.communities.find((c) => c.id === target) ?? biggest(group);
  const others = group.communities.filter((c) => c.id !== into.id);
  const asked = queue[0];
  const fail = (e: Error) => notify(e.message, { tone: "error" });

  const merge = async (from: Row) => {
    setBusy(true);
    const rest = queue.slice(1);
    setQueue([]);
    try {
      await api.merge({ from: from.id, into: into.id });
      notify(`c/${from.handle} merged into c/${into.handle}`);
      // The next one is asked about only once this one went through.
      setQueue(rest);
    } catch (e) {
      fail(e as Error);
    } finally {
      setBusy(false);
    }
  };
  const keep = () => api.keep(group.communities.map((c) => c.id)).then(() => notify(`Kept the "${group.core}" group apart`), fail);

  return (
    <section className="cm-merge-group" aria-label={`Core word ${group.core}`}>
      <div className="cm-merge-head">
        <span className="kit-label">Core “{group.core}” · {group.communities.length}</span>
        <span className="st-head-acts">
          <button type="button" className="st-btn st-btn--small st-btn--quiet" disabled={busy} onClick={() => void keep()}>Keep all apart</button>
          <button type="button" className="st-btn st-btn--small st-btn--cta" disabled={busy || !others.length} onClick={() => setQueue(others)}>
            Merge the others into c/{into.handle}
          </button>
        </span>
      </div>
      <div className="cm-merge-wrap">
        <table className="cm-merge-table">
          <thead><tr><th scope="col">Into</th><th scope="col">Handle</th><th scope="col">Name</th><th scope="col">Members</th><th scope="col">Works</th><th scope="col">Created</th><th scope="col">By</th><th scope="col" /></tr></thead>
          <tbody>
            {group.communities.map((c) => (
              <tr key={c.id}>
                <td><input type="radio" name={`into-${group.core}`} checked={c.id === into.id} aria-label={`Merge into c/${c.handle}`} onChange={() => setTarget(c.id)} /></td>
                <td>c/{c.handle}</td>
                <td>{c.name}</td>
                <td>{compact(c.members)}</td>
                <td>{compact(c.works)}</td>
                <td>{c.createdAt.slice(0, 10)}</td>
                <td>{c.createdBy ? `@${c.createdBy}` : "—"}</td>
                <td>{!c.reviewed && <span className="cm-mark">new</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {asked && (
        <ConfirmDialog title={`Merge c/${asked.handle} into c/${into.handle}?`} confirmLabel="Merge"
          text={`Its works, prompts, posts and members move to c/${into.handle}, and c/${asked.handle} sends people there.`}
          onCancel={() => setQueue([])} onConfirm={() => void merge(asked)} />
      )}
    </section>
  );
}

/**
 * The merge queue (Kev, 2026-10-30: "ich hab kb, dass es aber auch duplikate gibt wie gundam 1, gundam 2"; the agreed
 * shape: duplicates by their core word land in a queue for Kev): live communities sharing a core word while one of them
 * is new to it. Admin only (the route says so too).
 */
export default function MergeQueue() {
  const { data, notReady, error, retry } = useMergeQueue(true);
  if (notReady) return <p className="cm-note">{COMMUNITIES_NOT_READY}</p>;
  if (error) return <p className="cm-err" role="alert">{error} <button type="button" className="cm-link" onClick={retry}>Try again</button></p>;
  if (!data) return <p className="cm-note">Reading the queue…</p>;
  if (!data.groups.length) return <p className="cm-note">No possible duplicates.</p>;
  return <div className="cm-merge">{data.groups.map((g) => <Group key={g.core} group={g} />)}</div>;
}
