"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { notify } from "@/components/kit/notify";
import { useCommunitiesApi, useItemCommunities } from "@/hooks/useCommunities";
import { HIDDEN_BY_MODERATOR, type CommunityChip, type ItemKind, type LinksInput } from "@/lib/communities/types";
import CommunityPicker from "./CommunityPicker";
import "@/components/studio/studio.css";
import "./communities.css";

/** A change is sent once the picks held still this long. */
const SAVE_MS = 400;

/**
 * The communities one of your own works is in (the agreed shape, 2026-10-30: a render's ⋯ menu in Create, the viewer
 * of your own render): the picker, each change saved by itself; the ones its prompt brings marked "from its prompt",
 * where × takes it out of one; the ones a moderator took it out of, said. A render not saved yet waits.
 */
export default function CommunityLinks({ kind, id, text, note, foot, tone, onCreate, create = true }: {
  kind: ItemKind;
  /** Null while the render is being saved. */
  id: string | null;
  /** Its words, for the suggestions. */
  text?: string;
  note?: ReactNode;
  foot?: ReactNode;
  /** On the viewer's dark stage. */
  tone?: "stage";
  /** "+ Create c/…": the host's dialog (the menu holding this gives way first). */
  onCreate?: (name: string) => void;
  create?: boolean;
}) {
  const api = useCommunitiesApi();
  const read = useItemCommunities(kind, id);
  // The picks made here: shown until the server's own answer comes back (dirty while not sent yet).
  const [picks, setPicks] = useState<CommunityChip[] | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [seen, setSeen] = useState(read.data);
  const [item, setItem] = useState(id);
  if (item !== id) {
    // Another work in the same place (the viewer paged on): its own list, never the last one's picks (review
    // 2026-10-30: they were written to the next render). A pick not sent yet goes to its own work, below.
    setItem(id);
    setSeen(read.data);
    setPicks(null);
    setDirty(false);
  } else if (read.data !== seen) {
    setSeen(read.data);
    if (!dirty && !saving) setPicks(null);
  }
  const told = useRef(false);
  const changed = useRef(false);
  // The picks not sent yet, with the work they are for.
  const pending = useRef<LinksInput | null>(null);
  const shown = picks ?? read.data?.communities ?? [];

  const send = () => {
    const input = pending.current;
    if (!input) return;
    pending.current = null;
    setDirty(false);
    changed.current = false;
    setSaving(true);
    api.setLinks(input)
      .then(() => { told.current = false; }, (e: Error) => {
        if (told.current) return;
        told.current = true;
        notify(e.message, { tone: "error" });
      })
      // Communities is read anew before the write answers: the server's list (a hidden one left out; after a failure,
      // the list as it was) takes over, unless a newer pick waits.
      .finally(() => { setSaving(false); setPicks((p) => (changed.current ? p : null)); });
  };
  // The picks, once they held still: the whole list, the prompt's ones included (one left out is opted out of).
  useEffect(() => {
    if (!dirty) return;
    const t = setTimeout(send, SAVE_MS);
    return () => clearTimeout(t);
    // The picks decide; send reads what waits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picks, dirty]);
  // Sent, never dropped, when the work changes under it or it goes (a menu closed within the 400 ms).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => send(), [id, kind]);

  return (
    <div className={"cm-links" + (tone === "stage" ? " cm-links--stage" : "")} data-dim={!id || undefined} aria-busy={saving || undefined}>
      <span className="kit-label">Communities</span>
      {!id ? <p className="cm-note">Saving… It can be linked once it is saved.</p>
        : read.error ? <p className="cm-err" role="alert">{read.error}</p>
        : (
          <>
            <CommunityPicker value={shown} inherited={read.data?.inherited ?? []} text={text} disabled={!read.data && !read.notReady}
              onChange={(next) => { setPicks(next); setDirty(true); changed.current = true; pending.current = { kind, ids: [id], communityIds: next.map((p) => p.id) }; }}
              onCreate={onCreate} create={create} />
            {(read.data?.hidden ?? []).map((h) => <p key={h.id} className="cm-note">c/{h.handle}: {HIDDEN_BY_MODERATOR}</p>)}
            {note && <p className="cm-note">{note}</p>}
          </>
        )}
      {foot}
    </div>
  );
}
