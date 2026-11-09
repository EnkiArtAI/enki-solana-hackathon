"use client";

import { useState, type ReactNode } from "react";
import { Bookmark, Download, Link2, RotateCw, Share } from "lucide-react";
import BookmarkPicker from "@/components/enki/BookmarkPicker";
import BottomSheet from "@/components/kit/BottomSheet";
import ValueList from "@/components/kit/ValueList";
import { downloadImage, shareImage, shareWithLink } from "@/components/kit/share";
import { ReportButton } from "@/components/ReportButton";
import { madeWith } from "@/lib/ui/image-view/made-with";
import KeepInStudio from "@/components/studio/KeepInStudio";
import CommunityLinks from "@/components/communities/CommunityLinks";
import { PRIVATE_RENDERS_LINE } from "@/lib/communities/types";
import { copyText, metaOf, useAgain, type ImageViewModel, type Shot } from "./useImageViewModel";
import RefThumbs from "./RefThumbs";

/**
 * The fullscreen viewer's panel (handoff §2): what the image was made with (a
 * free prompt's words, a premium prompt's settings and values; DEC-508), its meta, then Regenerate with that render's
 * own price (disabled until there is one), Download, Bookmark, and Share
 * image beside Share + prompt. The viewer's own recorded renders carry the
 * Public switch and, once public, the references switch; someone else's
 * public image carries Report and the references its owner shares. The blank
 * composer keeps Regenerate, Download and Share image.
 */
export default function ViewerPanel({ model: m, shot, onAgain, phone = false, more }: {
  model: ImageViewModel;
  shot: Shot;
  /** Its place among the page's images, for the file name. */
  /** Regenerate or Retry was pressed: the viewer closes first, so no wallet prompt or low-balance question opens under it. */
  onAgain: () => void;
  phone?: boolean;
  /** A surface's own actions after these (Create > Image: Recreate, Reference, Animate). */
  more?: ReactNode;
}) {
  const [sheet, setSheet] = useState(false);
  const { job, record } = shot;
  const again = useAgain(m, job);
  const url = shot.original ?? shot.src;
  const meta = metaOf(shot, m.now);
  // A free prompt's words, a premium prompt's settings (DEC-508).
  const made = madeWith(shot, m);
  const link = m.promptId && `${location.origin}/generator/${encodeURIComponent(m.promptId)}`;

  return (
    <div className="iv-vpanel">
      {made?.kind === "text" ? (
        <div className="iv-vprompt">
          <p className="iv-vprompt-text">{made.text}</p>
          <button type="button" className="iv-vprompt-copy" onClick={() => copyText(made.text, "Copied the prompt")}>Copy prompt</button>
        </div>
      ) : made ? (
        <>
          <p className="iv-vsettings"><span>{made.label}</span>{made.settings.join(" · ")}</p>
          {made.rows.length > 0 && <ValueList rows={made.rows} tone="stage" onCopy={(r) => copyText(r.value, `Copied ${r.name}`)} />}
        </>
      ) : (
        <p className="iv-vnote">No values are stored for this image</p>
      )}
      {/* Below the prompt, the references its owner shares (DEC-514). */}
      {shot.references && shot.references.length > 0 && (
        <div className="iv-vrefs">
          <span>References</span>
          <RefThumbs refs={shot.references} phone={phone} overViewer className="iv-vrefs-row" />
        </div>
      )}
      {meta && <p className="iv-vmeta">{meta}</p>}

      {record && (
        <label className="iv-public">
          <input type="checkbox" role="switch" checked={record.visibility === "public"}
            onChange={(e) => void m.setPublic(record, e.target.checked)} />
          <span className="iv-switch" aria-hidden />
          <span className="iv-public-text">
            Public
            <span>
              {record.visibility !== "public" ? "Only you see it"
                : record.prompt_id === m.promptId ? "Shown under this prompt and on your profile" : "Shown on your profile"}
            </span>
          </span>
        </label>
      )}
      {/* Once public, its references may go along (Kev, 2026-10-29: "check if the reference images used to render shall
          also made public with a small hint, that this helps people your process more"). */}
      {record && record.visibility === "public" && (record.settings?.references?.length ?? 0) > 0 && (
        <label className="iv-public">
          <input type="checkbox" role="switch" checked={record.referencesPublic === true}
            onChange={(e) => void m.setReferencesPublic(record, e.target.checked)} />
          <span className="iv-switch" aria-hidden />
          <span className="iv-public-text">
            Show the references
            <span>Helps others learn your process</span>
          </span>
        </label>
      )}
      {shot.publicId && !m.guest && (
        <ReportButton targetType="generation" targetId={shot.publicId} className="iv-vreport">Report this image</ReportButton>
      )}

      <KeepInStudio shot={shot} promptId={m.promptId} guest={m.guest} />
      {/* Your own render's communities (the agreed shape, 2026-10-30: "the tile ⋯ menu / viewer of an own render"), on the
          stage; a new community is started from the menu's Communities or a picker outside the viewer (no dialog opens
          over it). */}
      {record && !record.isUploaded && !m.guest && (
        <CommunityLinks kind="image" id={record.id} tone="stage" create={false} text={record.prompt_text ?? ""}
          note={record.visibility === "public" ? undefined : PRIVATE_RENDERS_LINE} />
      )}
      <div className="iv-vacts">
        {again && (
          <button type="button" className="iv-vact kit-hit" data-primary disabled={!again.ready}
            onClick={() => {
              onAgain();
              again.press();
            }}>
            <RotateCw size={18} strokeWidth={2} aria-hidden />{again.label}
            {again.price && <span className="iv-vprice">{again.price}</span>}
          </button>
        )}
        {url && (
          <button type="button" className="iv-vact kit-hit" onClick={() => void downloadImage(url, m.title)}>
            <Download size={18} strokeWidth={2} aria-hidden />Download
          </button>
        )}
        {m.promptId && !m.guest && (
          <button type="button" className="iv-vact kit-hit" onClick={() => setSheet(true)}>
            <Bookmark size={18} strokeWidth={2} fill={m.saved ? "currentColor" : "none"} aria-hidden />{m.saved ? "Saved" : "Bookmark"}
          </button>
        )}
        {url && (
          <button type="button" className="iv-vact kit-hit" title="Anyone with the link can open this image" onClick={() => void shareImage(url)}>
            <Share size={18} strokeWidth={2} aria-hidden />Share image
          </button>
        )}
        {url && link && (
          <button type="button" className="iv-vact kit-hit" title="The image and a link to this prompt" onClick={() => void shareWithLink(url, link, m.title)}>
            <Link2 size={18} strokeWidth={2} aria-hidden />Share + prompt
          </button>
        )}
        {more}
      </div>

      {/* A sheet, not the floating picker: that one sits at the popover layer, under the viewer. */}
      {m.promptId && (
        <BottomSheet open={sheet} title="Save to" onClose={() => setSheet(false)}>
          {sheet && (
            <div className="iv-sheet-bmp">
              <BookmarkPicker promptId={m.promptId} imageUrl={url} onClose={() => setSheet(false)} onChange={m.bookmarked} />
            </div>
          )}
        </BottomSheet>
      )}
    </div>
  );
}
