"use client";

import { useState } from "react";
import { Bookmark, Flag, Share } from "lucide-react";
import BookmarkPicker from "@/components/enki/BookmarkPicker";
import { ReportButton } from "@/components/ReportButton";
import { copyText, type ImageViewModel } from "./useImageViewModel";

/** The prompt's link: the native share sheet where there is one, else copied. */
async function sharePrompt(title: string, promptId: string) {
  const url = `${location.origin}/generator/${encodeURIComponent(promptId)}`;
  if (typeof navigator.share === "function") {
    try {
      return await navigator.share({ title, url });
    } catch (e) {
      if ((e as Error)?.name === "AbortError") return;
    }
  }
  copyText(url, "Link copied");
}

/**
 * Bookmark, Share and Report on the prompt, beside the desktop title (plan Q16):
 * v2 has no place for them, and Report must stay. Like and Download are gone.
 */
export default function PromptActions({ model: m }: { model: ImageViewModel }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  if (!m.promptId) return null;
  const promptId = m.promptId;

  return (
    <div className="iv-pacts">
      {!m.guest && (
        <button type="button" className="iv-pact kit-hit" data-on={m.saved ? "saved" : undefined} aria-expanded={!!anchor}
          aria-label={m.saved ? "Saved · file it elsewhere" : "Bookmark"} title={m.saved ? "Saved · file it elsewhere" : "Bookmark"}
          onClick={(e) => setAnchor(anchor ? null : e.currentTarget.getBoundingClientRect())}>
          <Bookmark size={15} strokeWidth={1.5} fill={m.saved ? "currentColor" : "none"} aria-hidden />
        </button>
      )}
      <button type="button" className="iv-pact kit-hit" aria-label="Share" title="Share" onClick={() => void sharePrompt(m.title, promptId)}>
        <Share size={15} strokeWidth={1.5} aria-hidden />
      </button>
      <ReportButton targetType="prompt" targetId={promptId} className="iv-pact kit-hit">
        <Flag size={15} strokeWidth={1.5} aria-hidden />
      </ReportButton>
      {anchor && (
        <BookmarkPicker promptId={promptId} imageUrl={m.main?.video?.poster ?? m.main?.original} anchor={anchor} memberships={m.memberships}
          onClose={() => setAnchor(null)} onChange={m.bookmarked} />
      )}
    </div>
  );
}
