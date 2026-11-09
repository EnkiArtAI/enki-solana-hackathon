"use client";

import { useState, type CSSProperties } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { EyeOff } from "lucide-react";
import { notify } from "@/components/kit/notify";
import { openLogin } from "@/lib/openLogin";
import { sessionAuthHeaders } from "@/lib/session-headers";
import { IGNORES_KEY, useIgnores } from "@/hooks/useIgnores";

/**
 * Ignore on someone else's profile (Kev, 2026-10-29: "an 'ignore' function so that i dont see the prompts and images
 * of the person anymore ... no ban function"): their prompts and images leave my feed, search and a prompt's images;
 * Show ignored on the feed brings them back, Settings → Profile lists them. A guest is asked to log in. Every change
 * reads the list, the feed and a prompt's images again.
 */
export function IgnoreButton({ user, name, signedIn, style }: { user: string; name: string; signedIn: boolean; style: CSSProperties }) {
  const queryClient = useQueryClient();
  const { data } = useIgnores(signedIn);
  const [busy, setBusy] = useState(false);
  const ignored = !!data?.some((p) => p.id === user);

  const change = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/ignores", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...sessionAuthHeaders() },
        body: JSON.stringify({ user, ignore: !ignored }),
      });
      if (!res.ok) notify(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "That did not work. Try again.");
      else if (!ignored) notify(`${name}'s prompts and images are out of your feed. Show ignored brings them back.`);
    } catch {
      notify("Network hiccup. Try again.");
    } finally {
      // The button only waits for its own list: a shelf with many pages loaded reads them all again behind it.
      const list = queryClient.invalidateQueries({ queryKey: IGNORES_KEY });
      void queryClient.invalidateQueries({ queryKey: ["/api/marketplace/prompts"] });
      void queryClient.invalidateQueries({ queryKey: ["prompt-public-images"] });
      await list;
      setBusy(false);
    }
  };

  return (
    <button type="button" style={ignored ? { ...style, borderColor: "var(--enki-ink)" } : style} disabled={busy} aria-pressed={ignored}
      title={ignored ? `Show ${name}'s prompts and images again` : `Hide ${name}'s prompts and images from your feed`}
      onClick={() => (signedIn ? void change() : openLogin())}>
      <EyeOff size={14} aria-hidden /> {ignored ? "Ignored" : "Ignore"}
    </button>
  );
}
