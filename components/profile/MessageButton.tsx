"use client";

import { useState, type CSSProperties, type ReactNode } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { refreshMessages } from "@/hooks/useMessages";
import { DM_MAX_BODY } from "@/lib/dm";
import { openLogin } from "@/lib/openLogin";
import { sessionAuthHeaders } from "@/lib/session-headers";
import { CARD, CTA, FIELD, PILL, ROUND, TEXT, TITLE } from "@/components/enki-window";

/**
 * A direct message from someone's profile (Kev, 2026-10-29: "the message button which is a DM. when clicking it, a lil
 * pop up comes up where i can type in a message, without any anhang"; DEC-507): words only, through the routes the
 * Messages panel uses, open (or find) the conversation, then send. A guest is asked to log in first. Clicks and keys
 * stay inside, as ReportButton's do.
 */
export function MessageButton({ to, name, signedIn, style, children }: {
  /** The other person's user id. */
  to: string;
  name: string;
  signedIn: boolean;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [state, setState] = useState<{ busy?: boolean; error?: string; sent?: boolean }>({});

  const close = () => {
    setOpen(false);
    setText("");
    setState({});
  };
  const send = async () => {
    setState({ busy: true });
    const post = async (body: object) => {
      const res = await fetch("/api/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...sessionAuthHeaders() },
        body: JSON.stringify(body),
      });
      return { ok: res.ok, d: (await res.json().catch(() => ({}))) as { threadId?: string; error?: string } };
    };
    // Once the message itself went out, a lost answer may still have delivered it: say so, never "nothing was sent",
    // or a retry sends it twice (review 2026-10-29).
    let out = false;
    try {
      const thread = await post({ to });
      if (!thread.d.threadId) return setState({ error: thread.d.error ?? "Could not open the conversation. Try again." });
      out = true;
      const sent = await post({ threadId: thread.d.threadId, body: text.trim() });
      if (!sent.ok) return setState({ error: sent.d.error ?? "Could not send the message. Try again." });
      refreshMessages();
      setState({ sent: true });
    } catch {
      if (out) refreshMessages();
      setState({ error: out ? "Network hiccup. It may have gone through: check your Messages before sending again." : "Network hiccup. Nothing was sent." });
    }
  };

  return (
    <span className="contents" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <button type="button" style={style} aria-label={`Message ${name}`} title={`Message ${name}`}
        onClick={() => (signedIn ? setOpen(true) : openLogin())}>
        {children}
      </button>
      <Dialog open={open} onOpenChange={(o) => { if (!o && !state.busy) close(); }}>
        <DialogContent
          className="w-[calc(100%-32px)] max-w-md z-[9999]"
          overlayClassName="z-[9999] bg-black/50 backdrop-blur-[6px]"
          style={CARD}
          closeStyle={ROUND}
          onEscapeKeyDown={(e) => e.stopPropagation()}
        >
          {state.sent ? (
            <div className="grid gap-4">
              <DialogHeader>
                <DialogTitle style={TITLE}>Sent to {name}</DialogTitle>
                <DialogDescription style={{ ...TEXT, color: "var(--enki-ink-2)" }}>The conversation is in your Messages.</DialogDescription>
              </DialogHeader>
              <button type="button" style={PILL} onClick={close}>Close</button>
            </div>
          ) : (
            <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); void send(); }}>
              <DialogHeader>
                <DialogTitle style={TITLE}>Message {name}</DialogTitle>
                <DialogDescription style={{ ...TEXT, color: "var(--enki-ink-2)" }}>Words only. It lands in your Messages and theirs.</DialogDescription>
              </DialogHeader>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                maxLength={DM_MAX_BODY}
                rows={5}
                placeholder={`Write to ${name}`}
                className={FIELD}
                aria-label="Your message"
                autoFocus
              />
              {state.error && <p className="text-sm" style={{ color: "var(--enki-danger)" }}>{state.error}</p>}
              <button type="submit" className="disabled:opacity-50" style={CTA} disabled={!text.trim() || state.busy}>
                {state.busy ? "Sending…" : "Send"}
              </button>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </span>
  );
}
