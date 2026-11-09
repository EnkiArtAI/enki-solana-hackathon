"use client";

import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import Segmented from "@/components/kit/Segmented";
import RemixView from "@/components/remix/RemixView";
import VideoView from "@/components/create/video/VideoView";
import { StudioScope, useCreateScope } from "@/components/studio/StudioScope";
import { useBetaAccess } from "@/components/BetaGate";
import { TOOLS, type Tool } from "@/lib/ui/feed/world";
import { createAt, createLink } from "@/lib/ui/studio/links";
import "./feed.css";

// Client-only, as every Image View mount (EnkiDetailPanel's ImageView): the composer reads the window.
const CreateImage = dynamic(() => import("@/components/create/image/CreateImage"), { ssr: false });

/**
 * Create (Kev, 2026-10-30, on an icon rail with Explore, Create, Studio and Inbox: "explore und create links ist
 * super"): Image | Video | Remix in the place and look of Explore's row, the tool right under it. Image is Sume's image
 * page in Enki's look, the viewer's images over a generate bar (CreateImage); Video is the video composer after Sume's, its Generate dimmed
 * until a video route exists; Remix is the Remix view as built (DEC-538). Each pick is its own history entry, so Back
 * returns to the tool before. In a Studio project's context (?project=&content=, Kev, 2026-10-30: "a collection of
 * projects containing different content pieces that all access the same reference images, characters, styles and
 * master prompts") the picks keep it, and Image works inside it (StudioScope); Video shows its strip only.
 */
export default function CreateView({ tool }: { tool: Tool }) {
  const router = useRouter();
  const { access, role } = useBetaAccess();
  const authed = access === "ok" && role !== "team";
  const at = createAt(useSearchParams());
  const scope = useCreateScope(authed ? at : null);
  const pick = (next: Tool) => {
    if (next === tool) return;
    router.push(createLink(next, at), { scroll: false });
    window.scrollTo({ top: 0 });
  };
  return (
    <div className="feed feed--create kit-focus" data-menu-autohide>
      <div className="feed-world">
        <Segmented slide role="tablist" ariaLabel="Image, video or remix" value={tool} onChange={pick} options={[...TOOLS]} />
      </div>
      {tool === "image" ? (
        // Always the provider, the scope or none: a scope coming or going never remounts the composer.
        <div className="feed-create-image"><StudioScope value={scope}><CreateImage /></StudioScope></div>
      ) : tool === "video" ? <VideoView guest={!authed} studio={scope} /> : <RemixView guest={!authed} />}
    </div>
  );
}
