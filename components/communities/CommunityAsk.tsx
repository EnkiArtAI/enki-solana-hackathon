"use client";

import { notify } from "@/components/kit/notify";
import { useCommunitiesApi } from "@/hooks/useCommunities";
import type { CommunityChip } from "@/lib/communities/types";
import CommunityDialog from "./CommunityDialog";
import PostDialog, { type PostRender } from "./PostDialog";

/** What a render's ⋯ menu asked for, in the menu's place (a dialog never opens inside a menu that a press outside it
 *  closes): a community started from its picker, which the render joins as it comes back, or Post to Showroom. */
export type RenderAsk = { create: string } | { post: PostRender };

export default function CommunityAsk({ ask, id, onClose }: { ask: RenderAsk; /** The render's row. */ id: string; onClose: () => void }) {
  const api = useCommunitiesApi();
  if ("post" in ask) return <PostDialog render={ask.post} onClose={onClose} />;
  const join = (c: CommunityChip) => {
    onClose();
    api.addLink("image", id, c.id).then(() => notify(`Linked to c/${c.handle}`), (e: Error) => notify(e.message, { tone: "error" }));
  };
  return <CommunityDialog name={ask.create} onClose={onClose} onPick={join} onDone={join} />;
}
