"use client";

import { DIRECTORY_SORT_TABS, tabOf, type PanelAt } from "@/lib/ui/kit/shell-nav";
import CommunityPage from "./CommunityPage";
import Directory from "./Directory";

/**
 * The menu's Communities (Kev, 2026-10-30: "wo sehe ich denn die communities, in welcher menüleiste"): a panel, as
 * Studio, by the address. ?panel=communities is the directory on its sort (?tab=), &c=<handle> one community's page on
 * its tab. A card pressed is a page of its own (pushed); a sort or a tab picked, a redirect, a delete stay in place.
 */
export default function CommunitiesPanel({ at, onOpen, onTab, onBack, onReplace }: {
  at: PanelAt;
  /** A community's page, pushed. */
  onOpen: (handle: string) => void;
  /** A sort or a tab, in place. */
  onTab: (tab: string) => void;
  onBack: () => void;
  /** Another community's page in place of this one (a redirect), or the directory (null, after a delete). */
  onReplace: (handle: string | null) => void;
}) {
  if (at.community) {
    return <CommunityPage key={at.community} handle={at.community} tab={at.tab} onTab={onTab} onBack={onBack} onReplace={onReplace} />;
  }
  return <Directory sort={tabOf(DIRECTORY_SORT_TABS, at.tab)} onSort={onTab} onOpen={onOpen} />;
}
