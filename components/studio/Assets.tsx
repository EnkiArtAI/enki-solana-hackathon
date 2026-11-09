"use client";

import { useState, type DragEvent } from "react";
import ConfirmDialog from "@/components/kit/ConfirmDialog";
import { notify } from "@/components/kit/notify";
import { Icon } from "@/components/enki-shell/icons";
import { StudioError, useStudioApi } from "@/hooks/useStudio";
import { MAX_PROJECT_ASSETS, type Asset } from "@/lib/studio/types";

/** What the bucket takes (SQL 51's): PNG, JPEG, WebP. */
export const ASSET_TYPES = "image/png,image/jpeg,image/webp";

/**
 * Pictures into a project (Kev, 2026-10-30: "beim click auf Next wird nach assets gefragt die ich rein laden kann"): read
 * as the reference picker reads them (shrunk to 1024 px), stored one after another, each a greyed tile while it goes. A
 * full project stops the rest and says why.
 */
export function useAssetUpload(projectId: string) {
  const api = useStudioApi();
  const [pending, setPending] = useState<string[]>([]);
  const add = async (files: File[]) => {
    const pics = files.filter((f) => ASSET_TYPES.split(",").includes(f.type));
    if (pics.length < files.length) notify("Pictures only: PNG, JPEG or WebP", { tone: "error" });
    const shown = pics.map((f) => URL.createObjectURL(f));
    setPending((p) => [...p, ...shown]);
    let full = false;
    for (const [i, f] of pics.entries()) {
      if (!full) {
        try {
          if (!(await api.addAsset(projectId, f))) notify("Couldn't read that image", { tone: "error" });
        } catch (e) {
          notify((e as Error).message, { tone: "error" });
          full = e instanceof StudioError && e.status === 409;
        }
      }
      URL.revokeObjectURL(shown[i]);
      setPending((p) => p.filter((u) => u !== shown[i]));
    }
  };
  return { pending, add };
}

/** Files dropped on `onFiles`'s target; the target lights while they hover. */
export function useDrop(onFiles: (files: File[]) => void) {
  const [over, setOver] = useState(false);
  return {
    over,
    bind: {
      onDragOver: (e: DragEvent) => { e.preventDefault(); setOver(true); },
      onDragLeave: () => setOver(false),
      onDrop: (e: DragEvent) => { e.preventDefault(); setOver(false); onFiles([...e.dataTransfer.files]); },
    },
  };
}

/** One asset: its tile (a press opens it), its × asking first. A character made from it keeps it (ASSET_IN_USE). */
export function AssetTile({ asset, projectName, onOpen }: { asset: Asset; projectName: string; onOpen?: () => void }) {
  const api = useStudioApi();
  const [asking, setAsking] = useState(false);
  return (
    <div className="st-tile">
      <button type="button" className="st-tile-pic" aria-label="Open this picture" onClick={onOpen} disabled={!onOpen}>
        {/* eslint-disable-next-line @next/next/no-img-element -- a signed tile */}
        <img src={asset.thumb} alt="" loading="lazy" draggable={false} />
      </button>
      <button type="button" className="st-x kit-hit" aria-label="Delete this picture" title="Delete" onClick={() => setAsking(true)}>
        <Icon name="x" size={12} stroke={2.4} />
      </button>
      {asking && (
        <ConfirmDialog title="Delete this picture?" text={`It leaves ${projectName}.`} onCancel={() => setAsking(false)}
          onConfirm={() => {
            setAsking(false);
            api.deleteItem("assets", asset.id).catch((e: Error) => notify(e.message, { tone: "error" }));
          }} />
      )}
    </div>
  );
}

/** A tile still being stored. */
export const PendingTile = ({ src }: { src: string }) => (
  // eslint-disable-next-line @next/next/no-img-element -- a local preview
  <div className="st-tile" data-pending><span className="st-tile-pic"><img src={src} alt="" draggable={false} /></span></div>
);

/** "3 / 20" */
export const assetCount = (n: number) => `${n} / ${MAX_PROJECT_ASSETS}`;
