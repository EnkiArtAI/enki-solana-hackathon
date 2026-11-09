"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useBetaAccess } from "@/components/BetaGate";
import BottomSheet from "@/components/kit/BottomSheet";
import { Icon } from "@/components/enki-shell/icons";
import { useCommunitiesApi, useCommunityTypeahead, useDebounced } from "@/hooks/useCommunities";
import { COMMUNITIES_NOT_READY, COMMUNITY_TEXT, MAX_COMMUNITIES_PER_WORK, TYPEAHEAD_LIMIT, type CommunityChip, type CommunityDetail } from "@/lib/communities/types";
import { openLogin } from "@/lib/openLogin";
import { compact } from "@/lib/ui/communities/links";
import { addPick, createOffer, dropPick, isFull, unpicked, type PickMode } from "@/lib/ui/communities/picker";
import { menuMode, placeMenu } from "@/lib/ui/kit/controls";
import { stepActive } from "@/lib/search/client";
import CommunityDialog from "./CommunityDialog";
import "./communities.css";

/** Said at the cap (Kev, 2026-10-30: "max 18 communities pro werk"). */
export const CAP_LINE = `Up to ${MAX_COMMUNITIES_PER_WORK} communities.`;
/** Typing settles this long before the typeahead asks; a surface's words this long before a suggestion is asked. */
const TYPE_MS = 250;
const SUGGEST_MS = 600;

const chipOf = (c: CommunityChip): CommunityChip => ({ id: c.id, handle: c.handle, name: c.name });

/** The fields whose list is open, each with what closes it. */
const openLists = new WeakMap<EventTarget, () => void>();
/** Esc in a field whose list is open closes that list and nothing under it (agreed: "Esc closes the list"). Every layer
 *  a picker sits in (StudioDialog, BottomSheet, the pill's popover, the fullscreen viewer, a tile's menu) hears Esc on
 *  window or document in the capture phase from when it opened, so a key handler on the field never ran (review
 *  2026-10-30: Esc in the post dialog's picker dropped the typed title). This one listens on window from when the
 *  module loads, before any of them, so it is heard first. */
export function closeListOnEsc(e: KeyboardEvent) {
  const close = e.key === "Escape" && e.target ? openLists.get(e.target) : undefined;
  if (!close) return;
  e.stopImmediatePropagation();
  e.preventDefault();
  close();
}
// Optional: a test's stand-in window may have no listeners (lib/ui/feed/__tests__/world.test.ts loads Explore's filters).
if (typeof window !== "undefined") window.addEventListener?.("keydown", closeListOnEsc, true);

/**
 * The one Communities field (agreed 2026-10-30, Kev: "es wäre schon sinnvoll, wenn man nach der community suchen
 * könnte, wobei einem diese vorgeschlagen wird und man eine aufmachen kann, wenn es keine dazu gibt"): the picks as
 * chips, a field that suggests as it is typed (names and search words, the biggest first), its list under it, never
 * floating, and "+ Create c/<typed>" when nothing matches exactly. ↑ ↓ Enter pick, Backspace on an empty field takes the
 * last chip, Esc closes the list. Several up to 18 with the ones a prompt brings ("from its prompt": × takes the render
 * out of them), or one that a new pick replaces. With the surface's words, a row of suggestions the server reads from
 * them, each one press to add and never added by itself (Kev: "der server wird gewiss den community namen im text nicht
 * exakt erraten. vllt ein bisschen").
 */
export default function CommunityPicker({ value, onChange, mode = "multi", inherited = [], text, label = "Communities", onCreate, create: offers = true, autoFocus, disabled }: {
  value: CommunityChip[];
  onChange: (next: CommunityChip[]) => void;
  mode?: PickMode;
  /** The ids among `value` its prompt brings. */
  inherited?: readonly string[];
  /** The surface's words, for the suggestions. */
  text?: string;
  label?: string;
  /** "+ Create c/…" pressed: the host opens the dialog (a popover or a dialog gives way first); without it the picker
   *  opens it. */
  onCreate?: (name: string) => void;
  /** Offers "+ Create c/…" (not where no dialog can open over it: the fullscreen viewer, "Merge into…"). */
  create?: boolean;
  autoFocus?: boolean;
  disabled?: boolean;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [creating, setCreating] = useState<string | null>(null);
  // Focused once: suggestions are asked from then on, never for a picker nobody opened (review 2026-10-30: the
  // viewer's stage asked for every render paged past). It stays, so a press on a suggestion lands after the blur.
  const [engaged, setEngaged] = useState(false);
  const words = useDebounced(q.trim(), TYPE_MS);
  const read = useTypeahead(words);
  const found = read.data?.communities ?? [];
  const rows = unpicked(found, value);
  const offer = offers && q.trim() && words === q.trim() && read.data ? createOffer(words, found) : null;
  const options = [...rows.map((r) => ({ kind: "pick" as const, r })), ...(offer ? [{ kind: "create" as const, slug: offer }] : [])];
  const listShown = open && !!q.trim() && options.length > 0;
  const full = isFull(value, mode);
  const suggestions = useSuggestions(mode === "multi" && !disabled && engaged ? text : undefined, value);
  // Its list open, Esc closes the list alone (closeListOnEsc).
  useEffect(() => {
    const el = input.current;
    if (!listShown || !el) return;
    openLists.set(el, () => setOpen(false));
    return () => { openLists.delete(el); };
  }, [listShown]);

  const pick = (c: CommunityChip) => {
    onChange(addPick(value, chipOf(c), mode));
    setQ("");
    setActive(-1);
    input.current?.focus({ preventScroll: true });
  };
  const create = (slug: string) => {
    setOpen(false);
    if (onCreate) onCreate(q.trim() || slug);
    else setCreating(q.trim() || slug);
  };
  const choose = (i: number) => {
    const o = options[i];
    if (!o) return;
    if (o.kind === "pick") pick(o.r);
    else create(o.slug);
  };

  if (read.notReady) return <p className="cm-note">{COMMUNITIES_NOT_READY}</p>;
  return (
    <div className="cm-picker">
      <div className="cm-picker-box" onClick={() => input.current?.focus()}>
        {value.map((c) => {
          const from = inherited.includes(c.id);
          return (
            <span key={c.id} className="cm-pick" data-inherited={from || undefined} title={c.name}>
              <span>c/{c.handle}</span>
              {from && <span className="cm-pick-from">from its prompt</span>}
              <button type="button" className="cm-pick-x" disabled={disabled}
                aria-label={from ? `Take it out of c/${c.handle}` : `Remove c/${c.handle}`}
                onClick={(e) => { e.stopPropagation(); onChange(dropPick(value, c.id)); }}>
                <Icon name="x" size={12} stroke={2.4} />
              </button>
            </span>
          );
        })}
        <input ref={input} className="cm-picker-input" value={q} disabled={disabled || full} autoFocus={autoFocus} maxLength={COMMUNITY_TEXT.query}
          placeholder={full ? CAP_LINE : value.length ? "Add another" : mode === "single" ? "Find a community" : "Find or start a community"}
          role="combobox" aria-label={label} aria-autocomplete="list" aria-expanded={listShown} aria-controls={`${id}-list`}
          aria-activedescendant={listShown && active >= 0 ? `${id}-o${active}` : undefined}
          spellCheck={false} autoCapitalize="none"
          onChange={(e) => { setQ(e.target.value); setOpen(true); setActive(-1); }}
          onFocus={() => { setOpen(true); setEngaged(true); }}
          onBlur={() => setOpen(false)}
          onKeyDown={(e) => {
            if (listShown && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
              e.preventDefault();
              setActive(stepActive(active, e.key === "ArrowDown" ? 1 : -1, options.length));
            } else if (e.key === "Enter") {
              e.preventDefault();
              if (listShown) choose(active >= 0 ? active : 0);
            } else if (e.key === "Backspace" && !q && value.length) {
              onChange(dropPick(value, value[value.length - 1].id));
            }
          }} />
      </div>
      {listShown && (
        <ul id={`${id}-list`} className="cm-list" role="listbox" aria-label={label}>
          {options.map((o, i) => (
            // mousedown, not click: the field's blur would close the list before a click lands (as the feed's search).
            <li key={o.kind === "pick" ? o.r.id : "create"} id={`${id}-o${i}`} role="option" aria-selected={i === active}
              className={"cm-row" + (o.kind === "create" ? " cm-row--create" : "")}
              onMouseDown={(e) => { e.preventDefault(); choose(i); }} onMouseEnter={() => setActive(i)}>
              {o.kind === "pick" ? (
                <>
                  <span className="cm-row-handle">c/{o.r.handle}</span>
                  <span className="cm-row-name">{o.r.name}</span>
                  <span className="cm-row-meta">{compact(o.r.works)} works</span>
                </>
              ) : (
                <><span className="cm-row-handle">+ Create c/{o.slug}</span><span className="cm-row-name">a new community</span></>
              )}
            </li>
          ))}
        </ul>
      )}
      {full && <p className="cm-note" role="status">{CAP_LINE}</p>}
      {!full && suggestions.length > 0 && (
        <p className="cm-suggest">
          <span>Suggested:</span>
          {suggestions.map((s) => (
            <button key={s.id} type="button" className="cm-chip" title={s.name} onClick={() => pick(s)}>c/{s.handle} +</button>
          ))}
        </p>
      )}
      {creating !== null && (
        <CommunityDialog name={creating} onClose={() => setCreating(null)}
          onPick={(c) => { setCreating(null); pick(c); }}
          onDone={(c) => { setCreating(null); pick(c); }} />
      )}
    </div>
  );
}

/** The typeahead read, kept while the next words are asked (the list does not blink out between keys). */
function useTypeahead(words: string) {
  const read = useCommunityTypeahead(words, TYPEAHEAD_LIMIT);
  const [last, setLast] = useState(read.data);
  if (read.data && read.data !== last) setLast(read.data);
  return { ...read, data: words ? read.data ?? last : undefined };
}

/** What the server reads from the surface's words (POST /suggest; the words never go into an address), without the
 *  picks; asked once the words held still, while the picker is shown. */
function useSuggestions(text: string | undefined, picks: CommunityChip[]): CommunityChip[] {
  const api = useCommunitiesApi();
  const words = useDebounced(text?.trim() ?? "", SUGGEST_MS);
  const [got, setGot] = useState<CommunityChip[]>([]);
  useEffect(() => {
    if (!words) return;
    let live = true;
    api.suggest({ text: words, exclude: picks.map((p) => p.id) }).then((out) => { if (live) setGot(out.suggestions); }, () => {});
    return () => { live = false; };
    // The words decide; the picks are left out below as they change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [words]);
  return words ? unpicked(got, picks) : [];
}

/**
 * The picker behind a pill (the editor's listing row, Create > Image's bar, Explore's filter): a popover from 1024 px
 * up, a bottom sheet below, as every pill of the kit (PillMenu). Its own Esc and outside press close it; "+ Create c/…"
 * closes it and opens the dialog, whose new community becomes a pick.
 */
export function CommunityPill({ value, onChange, mode = "multi", face, pill = "kit-pill", ariaLabel, title = "Communities", text, note, foot, direction, disabled }: {
  value: CommunityChip[];
  onChange: (next: CommunityChip[]) => void;
  mode?: PickMode;
  /** The pill's own face. */
  face: ReactNode;
  /** The pill's look: the kit's, or the feed's filter pill (feed-pill). */
  pill?: string;
  ariaLabel: string;
  title?: string;
  text?: string;
  /** A line under the picker (Create's "Your renders show in a community once you make them public."). */
  note?: ReactNode;
  /** Under it all ("Open c/apu →"), given what closes the popover or sheet: a foot that leads away closes it first. */
  foot?: (close: () => void) => ReactNode;
  direction?: "up" | "down";
  /** Not open yet (what it holds is still being read). */
  disabled?: boolean;
}) {
  const { access, role } = useBetaAccess();
  const signedIn = access === "ok" && role !== "team";
  const trig = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [pop, setPop] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [creating, setCreating] = useState<string | null>(null);
  const shut = () => { setPop(false); setSheet(false); };
  const footer = foot?.(shut);

  // Placed at its pill before it is painted, inside the window (the kit's placeMenu).
  useLayoutEffect(() => {
    const p = panel.current;
    const t = trig.current;
    if (!pop || !p || !t) return;
    const at = placeMenu(t.getBoundingClientRect(), { width: p.offsetWidth, height: Math.max(p.scrollHeight, 320) }, { width: window.innerWidth, height: window.innerHeight }, direction);
    Object.assign(p.style, { left: `${at.left}px`, top: at.top === undefined ? "" : `${at.top}px`, bottom: at.bottom === undefined ? "" : `${at.bottom}px`, maxHeight: `${at.maxHeight}px` });
  });
  useEffect(() => {
    if (!pop) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!panel.current?.contains(t) && !trig.current?.contains(t)) setPop(false);
    };
    // Ahead of every layer under it (a panel, an image), as the kit's popovers hear it (usePanelPos).
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setPop(false);
      trig.current?.focus({ preventScroll: true });
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", shut);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", shut);
    };
  }, [pop]);

  const picker = (
    <CommunityPicker value={value} onChange={(next) => { onChange(next); if (mode === "single") shut(); }} mode={mode} text={text} label={title}
      // A guest signs in first, as the directory asks (agreed: "joining, creating and posting ask for a login").
      autoFocus onCreate={(name) => { shut(); if (signedIn) setCreating(name); else openLogin(); }} />
  );
  return (
    <>
      <button ref={trig} type="button" className={`${pill} kit-hit kit-focus` + (value.length ? " on" : "")} aria-label={ariaLabel} title={ariaLabel}
        aria-haspopup="dialog" aria-expanded={pop || sheet} disabled={disabled}
        onClick={() => (menuMode(window) === "sheet" ? setSheet(true) : setPop((o) => !o))}>
        {face}
      </button>
      {pop && createPortal(
        <div ref={panel} className="cm-pop kit-focus" role="dialog" aria-label={title}>
          <div className="cm-pop-head"><span className="kit-label">{title}</span></div>
          {picker}
          {note && <p className="cm-note">{note}</p>}
          {footer}
        </div>,
        document.body,
      )}
      <BottomSheet open={sheet} title={title} onClose={() => setSheet(false)}>
        {sheet && <div className="cm-sheet">{picker}{note && <p className="cm-note">{note}</p>}{footer}</div>}
      </BottomSheet>
      {creating !== null && (
        <CommunityDialog name={creating} onClose={() => setCreating(null)}
          onPick={(c) => { setCreating(null); onChange(addPick(value, chipOf(c), mode)); }}
          onDone={(c: CommunityDetail) => { setCreating(null); onChange(addPick(value, chipOf(c), mode)); }} />
      )}
    </>
  );
}
