"use client";

import { useEffect, useSyncExternalStore } from "react";
import dynamic from "next/dynamic";
import { dismissShare, shareOffer, subscribeShare } from "@/lib/share/after-release";

const SharePopup = dynamic(() => import("./SharePopup"), { ssr: false });

/** The share a release offers, over whatever page it opened (lib/share/after-release); inside the gate: none over its wall. */
export default function ShareHost() {
  const offer = useSyncExternalStore(subscribeShare, shareOffer, () => null);
  useEffect(() => dismissShare, []);
  return offer && <SharePopup key={offer.promptId} offer={offer} />;
}
