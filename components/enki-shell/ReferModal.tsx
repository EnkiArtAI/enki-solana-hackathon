"use client";

/* Refer a prompt (Earn money): paste a post, see what it holds, press the
   check mark, and it is live (Kev, 2026-10-14: "input prompt, loading
   screen, verify, press checkmark, loaded"). A post on X is read by the
   server (app/api/referrals/preview): its prompt is shown as it is and
   cannot be edited, its pictures become the prompt's, its name and shelf
   come named by the model and may be changed, and POST /api/prompt with the
   sealed preview publishes it. A post on another site goes to the
   moderators' queue, as before (Kev, 2026-10-05). */

import { useState, useEffect } from "react";
import { Icon } from "./icons";
import FullscreenViewer from "@/components/kit/FullscreenViewer";
import { sessionAuthHeaders } from "@/lib/session-headers";
import { useStepUp } from "@/components/StepUpProvider";
import { parseReferralLink, REFERRAL_PLATFORM_NAME } from "@/lib/referral-link";
import { ENKI_CATEGORIES } from "@/lib/categories";
import { isRealTitle } from "@/lib/prompt-title";
import { LABEL } from "@/components/enki-window";

/** The layout's mono, LABEL's face, as Settings' numbers (DEC-2026-11-08-06). */
const MONO = LABEL.fontFamily;
const NOT_SENT = "The link could not be sent in. Try again.";
const NOT_READ = "The post could not be read. Try again.";
const NOT_PUBLISHED = "The prompt could not be published. Try again.";

/** What the preview route answers beside the sealed token. */
export interface ImportShown {
  prompt: string;
  title: string;
  category: string;
  tags: string[];
  adult: boolean;
  /** Catalogue names the post names; empty = every generator. */
  generators: string[];
  photos: string[];
  source: { url: string; handle: string };
}

type Step =
  | { at: "link" }
  | { at: "reading" }
  | { at: "verify"; token: string; shown: ImportShown }
  | { at: "publishing"; token: string; shown: ImportShown }
  | { at: "sent" };

interface ReferModalProps {
  onClose: () => void;
  /** The prompt is live: the shell opens it. */
  onPublished: (promptId: string) => void;
  /** Browsing without a login: the popup opens, the button stays grey. */
  guest?: boolean;
}

/** The server's own sentence from a refused answer, else ours. */
async function reason(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  return typeof body?.error === "string" && body.error ? body.error : fallback;
}

export default function ReferModal({ onClose, onPublished, guest = false }: ReferModalProps) {
  const { guarded } = useStepUp();
  const [url, setUrl] = useState("");
  const [step, setStep] = useState<Step>({ at: "link" });
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("");
  const [generator, setGenerator] = useState("");
  /** The image generators on offer, by catalogue name, for the select. */
  const [generators, setGenerators] = useState<string[]>([]);
  /* The post's pictures open full screen, one at a time, ← → and a swipe
     paging through them (Kev, 2026-10-14); Esc closes the viewer alone,
     so the dialog's own Esc stands back while one is open. */
  const [opened, setOpened] = useState<number | null>(null);

  // ESC cancels/closes the refer dialog; while a picture is open full screen, Esc is the viewer's alone.
  useEffect(() => {
    // While publishing, the step-up dialog may sit on top: its Esc is its own.
    if (opened !== null || step.at === "publishing") return;
    /* CAPTURE phase: the modal is the topmost surface, so its ESC must win.
       As a bubble listener it ran AFTER the sidebar's document-level ESC —
       the burger menu behind the scrim closed first while this dialog stayed
       (Kev, 2026-08-22). Window capture fires before any document listener,
       and stopPropagation keeps ESC from ever reaching the background. */
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, opened, step.at]);

  // Read as the server reads it, so the button is live only for a link it takes.
  const link = parseReferralLink(url);
  // A site the queue has no name for gets no chip.
  const platform = link && link.platform !== "other" ? REFERRAL_PLATFORM_NAME[link.platform] : null;
  const ready = Boolean(link) && !guest && step.at === "link";

  /** The catalogue's image generators, once, for the verify step. */
  const loadGenerators = async (shown: ImportShown) => {
    const rows = (await fetch("/api/models", { headers: sessionAuthHeaders() }).then((r) => (r.ok ? r.json() : [])).catch(() => [])) as { name?: unknown; media_type?: unknown }[];
    const names = rows.flatMap((r) => (typeof r.name === "string" && r.media_type !== "video" ? [r.name] : []));
    setGenerators(names);
    setGenerator(shown.generators.find((g) => names.includes(g)) ?? (names.includes("Nano Banana Pro") ? "Nano Banana Pro" : names[0] ?? ""));
  };

  const send = async () => {
    if (!link || !ready) return;
    setError(null);
    // Another site: the moderators' queue, and one short line that it arrived.
    if (link.platform !== "x") {
      setStep({ at: "reading" });
      try {
        const res = await fetch("/api/referrals", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...sessionAuthHeaders() },
          credentials: "include",
          body: JSON.stringify({ url: link.url }),
        });
        if (res.ok) return setStep({ at: "sent" });
        setError(await reason(res, NOT_SENT));
      } catch {
        setError(NOT_SENT);
      }
      return setStep({ at: "link" });
    }
    // X: the server reads the post and hands it back sealed.
    setStep({ at: "reading" });
    try {
      const res = await fetch("/api/referrals/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...sessionAuthHeaders() },
        credentials: "include",
        body: JSON.stringify({ url: link.url }),
      });
      if (!res.ok) {
        setError(await reason(res, NOT_READ));
        return setStep({ at: "link" });
      }
      const { token, preview: shown } = (await res.json()) as { token: string; preview: ImportShown };
      setTitle(shown.title);
      setCategory(shown.category);
      await loadGenerators(shown);
      setStep({ at: "verify", token, shown });
    } catch {
      setError(NOT_READ);
      setStep({ at: "link" });
    }
  };

  const publish = async () => {
    if (step.at !== "verify" || !isRealTitle(title)) return;
    const { token, shown } = step;
    setError(null);
    setStep({ at: "publishing", token, shown });
    try {
      // A new prompt asks for the second factor once the user has one (MFA-4).
      const res = await guarded("add-prompt", (h) => fetch("/api/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...sessionAuthHeaders(), ...h },
        credentials: "include",
        // The text and pictures are the sealed preview's; the server ignores content here.
        body: JSON.stringify({
          imported: token, title: title.trim(), category, aiModel: generator,
          aiModels: shown.generators.length ? shown.generators : generators,
          promptType: "free-prompt", price: 0, release: true, content: "", photoCount: shown.photos.length,
          uploadedPhotos: [], referenceImages: [],
        }),
      }));
      if (!res.ok) {
        setError(await reason(res, NOT_PUBLISHED));
        return setStep({ at: "verify", token, shown });
      }
      const { id } = (await res.json()) as { id?: string };
      if (!id) throw new Error("no id");
      onPublished(id);
    } catch {
      setError(NOT_PUBLISHED);
      setStep({ at: "verify", token, shown });
    }
  };

  const verifying = step.at === "verify" || step.at === "publishing";
  const shown = verifying ? step.shown : null;

  return (
    <div className="ek-modal-scrim" onClick={onClose}>
      {shown && opened !== null && (
        <FullscreenViewer items={shown.photos.map((src) => ({ key: src, src }))} index={opened} onIndex={setOpened}
          onClose={() => setOpened(null)} layout="stacked" nav="dots"
          panel={<span style={{ fontSize: 12, color: "var(--enki-ink-3)" }}>From @{shown.source.handle || "the post"}</span>} />
      )}
      <div className="ek-modal" style={{ maxWidth: verifying ? 520 : 420, maxHeight: "calc(100vh - 48px)", display: "flex", flexDirection: "column" }} onClick={(e) => e.stopPropagation()}>
        <div className="ek-modal-body" style={{ paddingTop: 16, overflowY: "auto" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 12 }}>
            <span style={{ width: 28, height: 28, borderRadius: "50%", background: "rgba(var(--ember-rgb), 0.12)", color: "var(--enki-ember)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              <Icon name="link" size={14} stroke={2} />
            </span>
            <span className="ek-modal-title" style={{ flex: 1 }}>Refer a prompt</span>
            <button className="ek-modal-x" onClick={onClose} aria-label="Close"><Icon name="x" size={15} stroke={2} /></button>
          </div>

          {step.at === "sent" ? (
            <div role="status" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, padding: "10px 0 14px", textAlign: "center" }}>
              <span style={{ width: 46, height: 46, borderRadius: "50%", background: "#E8F8EE", color: "#1F8A5B", display: "flex", alignItems: "center", justifyContent: "center", animation: "ek-pop 0.3s ease-out" }}>
                <Icon name="check" size={24} stroke={2.6} />
              </span>
              <span style={{ fontSize: 13.5, fontWeight: 600, color: "var(--enki-ink)" }}>Prompt sent in for checks.</span>
              <span style={{ fontSize: 12, color: "var(--enki-ink-3)" }}>We&apos;ll release it shortly.</span>
            </div>
          ) : step.at === "reading" ? (
            <div role="status" aria-busy="true" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, padding: "16px 0 18px", textAlign: "center" }}>
              <span className="kit-spinner" aria-hidden />
              <span style={{ fontSize: 13, color: "var(--enki-ink-2)" }}>Reading the post…</span>
            </div>
          ) : shown ? (
            <form onSubmit={(e) => { e.preventDefault(); void publish(); }} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <span className="ek-ed-lab">Prompt{shown.adult && <span style={{ marginLeft: 8, color: "var(--enki-ember)" }}>18+</span>}</span>
              <pre style={{ margin: 0, maxHeight: 160, overflowY: "auto", padding: "8px 10px", border: "1px solid var(--enki-rule)", borderRadius: 9, background: "var(--enki-paper-2)", whiteSpace: "pre-wrap", wordBreak: "break-word", font: "400 12px/1.5 var(--font-sans), sans-serif", color: "var(--enki-ink)" }}>
                {shown.prompt}
              </pre>
              {shown.photos.length > 0 && (
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }} aria-label="The post's images">
                  {shown.photos.map((src, i) => (
                    <button key={src} type="button" onClick={() => setOpened(i)} aria-label={`Open image ${i + 1} of ${shown.photos.length}`}
                      style={{ padding: 0, border: "1px solid var(--enki-rule)", borderRadius: 8, background: "none", cursor: "zoom-in", overflow: "hidden", width: 64, height: 64 }}>
                      <img src={src} alt="" style={{ width: 64, height: 64, objectFit: "cover", display: "block" }} />
                    </button>
                  ))}
                </div>
              )}
              <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <span className="ek-ed-lab" style={{ margin: 0 }}>Name</span>
                <input className="st-input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} aria-label="Name" />
              </label>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                <label style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
                  <span className="ek-ed-lab" style={{ margin: 0 }}>Category</span>
                  <select className="st-input" value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category">
                    {ENKI_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </label>
                <label style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
                  <span className="ek-ed-lab" style={{ margin: 0 }}>Primary generator</span>
                  <select className="st-input" value={generator} onChange={(e) => setGenerator(e.target.value)} aria-label="Primary generator">
                    {generators.map((g) => <option key={g} value={g}>{g}</option>)}
                  </select>
                </label>
              </div>
              <span style={{ fontSize: 11, color: "var(--enki-ink-3)" }}>
                Offered on every generator · from @{shown.source.handle || "the post"}
              </span>
              {error && <span role="alert" style={{ display: "block", fontSize: 10, color: "var(--enki-danger)", fontWeight: 600 }}>{error}</span>}
              <button type="submit" className="ek-btn" disabled={step.at === "publishing" || !isRealTitle(title)} aria-busy={step.at === "publishing" || undefined}>
                <Icon name="check" size={14} stroke={2.4} /> {step.at === "publishing" ? "Publishing…" : "Publish"}
              </button>
            </form>
          ) : (
            <form onSubmit={(e) => { e.preventDefault(); void send(); }}>
              <p style={{ margin: "0 0 10px", fontSize: 12, color: "var(--enki-ink-3)" }}>
                Paste a post with a prompt. From X it is read on the spot, with its pictures; if the prompt sits in a reply, paste that reply.
              </p>
              <div className="st-input" style={{ display: "flex", alignItems: "center", gap: 7, ...(url && !link ? { borderColor: "var(--enki-danger)" } : null) }}>
                <Icon name="link" size={13} stroke={2} style={{ color: "var(--enki-ink-3)", flexShrink: 0 }} />
                <input
                  type="url"
                  placeholder="https://x.com/…  ·  instagram.com/p/…"
                  value={url}
                  onChange={(e) => { setUrl(e.target.value); setError(null); }}
                  autoFocus
                  aria-label="Link to the post"
                  style={{ flex: 1, minWidth: 0, border: "none", background: "transparent", outline: "none", font: "inherit", color: "inherit" }}
                />
                {platform && (
                  <span style={{ fontFamily: MONO, fontSize: 8.5, fontWeight: 700, color: "#1F5C38", background: "#E8F8EE", borderRadius: 4, padding: "2px 6px", flexShrink: 0 }}>{platform}</span>
                )}
              </div>
              {url && !link && <span style={{ display: "block", fontSize: 10, color: "var(--enki-danger)", marginTop: 3 }}>Enter a full link starting with https://</span>}
              {error && <span role="alert" style={{ display: "block", fontSize: 10, color: "var(--enki-danger)", fontWeight: 600, marginTop: 3 }}>{error}</span>}

              <button
                type="submit"
                title={guest ? "Sign in to refer a prompt" : undefined}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center", gap: 7, width: "100%", minHeight: 34,
                  marginTop: 12, border: "none", borderRadius: 999, cursor: ready ? "pointer" : "default",
                  background: ready ? "var(--cta-solid)" : "var(--enki-paper-3)",
                  color: ready ? "var(--cta-ink)" : "var(--enki-ink-2)", fontSize: 12, fontWeight: 600,
                }}
                disabled={!ready}
              >
                <Icon name="send" size={12} stroke={2} /> {link?.platform === "x" ? "Read the post" : "Send in"}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
