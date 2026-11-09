"use client";

/**
 * Deep-link door only, as /creators/[id]: a community's page renders inside the shell, its menu beside it, so /c/<handle>
 * (the link its page copies, Kev, 2026-10-30: "harbour AND gallery for people interested in a community") forwards to
 * /home's Communities panel on it. Back from there goes to the directory, then to Explore (DEC-543's rule).
 */
import { use, useEffect } from "react";
import { useRouter } from "next/navigation";
import { panelLink } from "@/lib/ui/kit/shell-nav";
import { handleParam } from "@/lib/ui/communities/links";

export default function CommunityDoor({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = use(params);
  const router = useRouter();
  useEffect(() => {
    const h = handleParam(decodeURIComponent(handle));
    router.replace(panelLink(`${window.location.origin}/home`, { id: "communities", ...(h && { community: h }) }));
  }, [handle, router]);
  return null;
}
