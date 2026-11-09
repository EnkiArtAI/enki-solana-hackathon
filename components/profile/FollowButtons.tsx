"use client";

import { useState, type CSSProperties } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, BellRing } from "lucide-react";
import { notify } from "@/components/kit/notify";
import { openLogin } from "@/lib/openLogin";
import { sessionAuthHeaders } from "@/lib/session-headers";

type FollowState = { following: boolean; notify: boolean };

/**
 * Follow on someone else's profile, and once followed the bell left of it (Kev, 2026-10-29: "to the left of it once
 * followed the bell button to turn on notifications upon new post"): their new prompts and public images land in my
 * notifications. The bell starts off. A guest is asked to log in. GET /api/follows is the one source of the state:
 * every change reads it again, and the profile's numbers (Kev, 2026-11-02: following must move the count).
 */
export function FollowButtons({ user, name, signedIn, style }: { user: string; name: string; signedIn: boolean; style: CSSProperties }) {
  const queryClient = useQueryClient();
  const key = ["follow", user];
  const { data } = useQuery({
    queryKey: key,
    queryFn: async (): Promise<FollowState> => {
      const res = await fetch(`/api/follows?user=${encodeURIComponent(user)}`, { headers: sessionAuthHeaders() });
      return res.ok ? res.json() : { following: false, notify: false };
    },
    enabled: signedIn,
  });
  const [busy, setBusy] = useState(false);
  const following = !!data?.following;

  const change = async (body: { follow: boolean } | { notify: boolean }) => {
    setBusy(true);
    try {
      const res = await fetch("/api/follows", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...sessionAuthHeaders() },
        body: JSON.stringify({ user, ...body }),
      });
      if (!res.ok) notify(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "That did not work. Try again.");
    } catch {
      notify("Network hiccup. Try again.");
    } finally {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: key }),
        queryClient.invalidateQueries({ queryKey: ["creator-profile"] }),
      ]);
      setBusy(false);
    }
  };

  const square: CSSProperties = { ...style, width: style.height, padding: 0, justifyContent: "center" };
  return (
    <>
      {following && (
        <button type="button" style={data?.notify ? { ...square, borderColor: "var(--enki-ink)" } : square} disabled={busy}
          aria-pressed={!!data?.notify}
          aria-label={data?.notify ? `Stop notifying me of ${name}'s new posts` : `Notify me of ${name}'s new posts`}
          title={data?.notify ? "Notifications on" : "Notify me of new posts"}
          onClick={() => void change({ notify: !data?.notify })}>
          {data?.notify ? <BellRing size={15} aria-hidden /> : <Bell size={15} aria-hidden />}
        </button>
      )}
      <button type="button" disabled={busy} aria-pressed={following}
        style={following ? style : { ...style, background: "var(--enki-ink)", borderColor: "var(--enki-ink)", color: "var(--enki-paper)" }}
        onClick={() => (signedIn ? void change({ follow: !following }) : openLogin())}>
        {following ? "Following" : "Follow"}
      </button>
    </>
  );
}
