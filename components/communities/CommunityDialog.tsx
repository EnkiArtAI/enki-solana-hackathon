"use client";

import { useState } from "react";
import { notify } from "@/components/kit/notify";
import StudioDialog from "@/components/studio/StudioDialog";
import { Icon } from "@/components/enki-shell/icons";
import { CommunityError, useCommunitiesApi, useCommunityTypeahead, useDebounced } from "@/hooks/useCommunities";
import { checkHandle, slugify } from "@/lib/communities/handle";
import {
  CLOSE_MATCHES, COMMUNITY_TEXT, HANDLE_TAKEN, MAX_ALIASES, NAME_NEEDED, TOO_LONG,
  type CommunityCard, type CommunityDetail,
} from "@/lib/communities/types";
import { compact, openCommunity } from "@/lib/ui/communities/links";
import { Cover } from "./CommunityCard";
import "@/components/studio/studio.css";
import "./communities.css";

/** How many of the communities already on Enki show under the name while it is typed. */
const ALREADY = 3;

/** A community already on Enki, as the dialog offers it: Open and Join, or Pick where a picker opened the dialog. */
function Already({ card, onPick, onDone }: { card: CommunityCard; onPick?: (c: CommunityCard) => void; onDone: () => void }) {
  const api = useCommunitiesApi();
  const join = () => api.join(card.handle).then(() => notify(`Joined c/${card.handle}`), (e: Error) => notify(e.message, { tone: "error" }));
  return (
    <div className="cm-closest-row">
      <span aria-hidden><Cover card={card} /></span>
      <span className="cm-closest-text"><b>c/{card.handle}</b><small>{card.name} · {compact(card.works)} works · {compact(card.members)} members</small></span>
      {onPick ? <button type="button" className="st-btn st-btn--small" onClick={() => onPick(card)}>Pick</button> : (
        <>
          <button type="button" className="st-btn st-btn--small st-btn--quiet" onClick={() => { onDone(); openCommunity(card.handle); }}>Open</button>
          <button type="button" className="st-btn st-btn--small" onClick={() => void join()}>Join</button>
        </>
      )}
    </div>
  );
}

/**
 * Start a community, or edit one (Kev, 2026-10-30: "es sollte permissionless erstellt werden"; "ich hab kb, dass es aber
 * auch duplikate gibt wie gundam 1, gundam 2"): its name, its c/handle (the name's slug until edited, checked as typed;
 * fixed once it exists), a description, and in edit its search words. Under the name, the communities already on Enki
 * with a close name; a create that the server finds close to others shows them and asks once more ("Es gibt schon
 * c/gundam (1.2k) - trotzdem neu?", agreed): "Make a new one anyway".
 */
export default function CommunityDialog({ edit, name: typed = "", onPick, onClose, onDone }: {
  /** Edit this one (its creator, an admin). */
  edit?: CommunityDetail;
  /** The words a "+ Create c/…" carried. */
  name?: string;
  /** Opened from a picker: a community already on Enki is picked instead of opened. */
  onPick?: (c: CommunityCard) => void;
  onClose: () => void;
  onDone: (c: CommunityDetail) => void;
}) {
  const api = useCommunitiesApi();
  const [name, setName] = useState(edit?.name ?? typed);
  const [handle, setHandle] = useState<string | null>(null);
  const [description, setDescription] = useState(edit?.description ?? "");
  const [aliases, setAliases] = useState<string[]>(edit?.aliases ?? []);
  const [word, setWord] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [close, setClose] = useState<CommunityCard[] | null>(null);
  const [taken, setTaken] = useState<CommunityCard | null>(null);
  // The handle follows the name until it is edited (Kev's agreed shape: "c/<handle>").
  const shownHandle = handle ?? slugify(name);
  const handleWhy = !edit && shownHandle ? checkHandle(shownHandle) : null;
  const settled = useDebounced(edit ? "" : name.trim(), 300);
  const already = (useCommunityTypeahead(settled, ALREADY).data?.communities ?? []).slice(0, ALREADY);
  const trimmed = name.trim();
  const tooLong = trimmed.length > COMMUNITY_TEXT.name ? TOO_LONG.name : description.length > COMMUNITY_TEXT.description ? TOO_LONG.description : null;

  const addWord = () => {
    const w = slugify(word);
    if (!w || aliases.includes(w) || aliases.length >= MAX_ALIASES) return setWord("");
    setAliases([...aliases, w]);
    setWord("");
  };
  const save = async (confirmed = false) => {
    if (busy) return;
    if (trimmed.length < 2) return setError(NAME_NEEDED);
    if (tooLong || handleWhy) return setError(tooLong ?? handleWhy);
    setBusy(true);
    setError(null);
    try {
      const desc = description.trim() || null;
      const out = edit
        ? await api.patch(edit.handle, { name: trimmed, description: desc, aliases })
        : await api.create({ name: trimmed, handle: shownHandle || undefined, description: desc, confirmed });
      if (!edit) notify(`c/${out.community.handle} is on Enki`);
      onDone(out.community);
    } catch (e) {
      const extra = e instanceof CommunityError ? e.extra : {};
      if (extra.closest) setClose(extra.closest as CommunityCard[]);
      if (extra.existing) setTaken(extra.existing as CommunityCard);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const anyway = !!close?.length && !taken;
  const listed = (taken ? [taken] : close ?? already).filter((c) => c.handle !== edit?.handle);

  return (
    <StudioDialog title={edit ? `Edit c/${edit.handle}` : "Start a community"} onClose={onClose}
      foot={<>
        <button type="button" className="st-btn st-btn--quiet" onClick={onClose}>Cancel</button>
        <button type="button" className="st-btn st-btn--cta" disabled={busy || !!taken} onClick={() => void save(anyway)}>
          {busy ? "Saving…" : edit ? "Save" : anyway ? "Make a new one anyway" : "Create"}
        </button>
      </>}>
      <label className="st-field">
        <span className="st-field-head"><span className="kit-label">Name</span><span className="st-count">{trimmed.length} / {COMMUNITY_TEXT.name}</span></span>
        <input data-autofocus className="st-input" value={name} maxLength={COMMUNITY_TEXT.name + 10} placeholder="Gundam, Pepe, Brett…"
          aria-invalid={error === NAME_NEEDED || undefined}
          onChange={(e) => { setName(e.target.value); setClose(null); setTaken(null); setError(null); }} />
      </label>
      {listed.length > 0 && (
        <div className="cm-closest" role="group" aria-label="Already on Enki">
          <span className="kit-label">{taken ? HANDLE_TAKEN : close ? "Close names" : "Already on Enki"}</span>
          {close && !taken && <p className="cm-note">{CLOSE_MATCHES}</p>}
          {listed.map((c) => <Already key={c.id} card={c} onPick={onPick} onDone={onClose} />)}
        </div>
      )}
      <label className="st-field">
        <span className="kit-label">Handle</span>
        <span className="cm-handle-field">
          <span aria-hidden>c/</span>
          <input className="st-input" value={edit ? edit.handle : shownHandle} disabled={!!edit} aria-label="Handle, after c/" aria-invalid={handleWhy ? true : undefined}
            spellCheck={false} autoCapitalize="none" maxLength={40}
            onChange={(e) => { setHandle(e.target.value.toLowerCase()); setClose(null); setTaken(null); setError(null); }} />
        </span>
        {edit ? <span className="st-note">A handle stays as it was made.</span> : handleWhy ? <span className="st-err">{handleWhy}</span> : null}
      </label>
      <label className="st-field">
        <span className="st-field-head"><span className="kit-label">Description · optional</span><span className="st-count">{description.length} / {COMMUNITY_TEXT.description}</span></span>
        <textarea className="st-input st-area" rows={3} value={description} placeholder="What gathers here?" onChange={(e) => setDescription(e.target.value)} />
      </label>
      {edit && (
        <div className="st-field">
          <span className="st-field-head"><span className="kit-label">Search words</span><span className="st-count">{aliases.length} / {MAX_ALIASES}</span></span>
          <div className="cm-picker-box">
            {aliases.map((a) => (
              <span key={a} className="cm-pick"><span>{a}</span>
                <button type="button" className="cm-pick-x" aria-label={`Remove ${a}`} onClick={() => setAliases(aliases.filter((x) => x !== a))}><Icon name="x" size={12} stroke={2.4} /></button>
              </span>
            ))}
            <input className="cm-picker-input" value={word} disabled={aliases.length >= MAX_ALIASES} placeholder={aliases.length ? "" : "bitcoin for c/btc"} aria-label="Add a search word"
              onChange={(e) => setWord(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); addWord(); } }} onBlur={addWord} />
          </div>
          <span className="st-note">Other words people may search it by.</span>
        </div>
      )}
      {error && error !== handleWhy && !close && !taken && <p className="st-err" role="alert">{error}</p>}
    </StudioDialog>
  );
}
