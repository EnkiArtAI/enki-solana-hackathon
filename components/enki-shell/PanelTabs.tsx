"use client";

import type { ReactNode } from "react";
import Segmented from "@/components/kit/Segmented";
import { tabOf } from "@/lib/ui/kit/shell-nav";

/** A panel of tabs, Studio's and Inbox's (Kev, 2026-10-30): the switch in the look of Explore's row, at the panel's top
 *  and staying there while the page under it scrolls, then the picked tab's page as it was on its own. It shows `tab`,
 *  the address's (a deep link, the phone's bell, a pick), when it is one of `tabs`, else the first; a pick goes to
 *  `onTab`, which writes it into the address, so Back from a page opened on a tab comes back to that tab. */
export default function PanelTabs<K extends string>({ tabs, tab: asked, onTab, label, children }: {
  tabs: ReadonlyArray<{ key: K; label: string }>;
  tab?: string;
  onTab: (tab: K) => void;
  label: string;
  children: (tab: K) => ReactNode;
}) {
  const tab = tabOf(tabs, asked);
  return (
    <>
      <div className="ek-panel-tabs ek-tuck-hide">
        <Segmented slide role="tablist" ariaLabel={label} value={tab} onChange={onTab} options={[...tabs]} />
      </div>
      {children(tab)}
    </>
  );
}
