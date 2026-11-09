"use client";

/**
 * Settings → Profile → People you ignore (Kev, 2026-10-29: "that must also be place into the profile settings where i
 * see the list of people i ignored"), with Un-ignore. GET /api/ignores is the list; every change reads it again, and
 * the feed and a prompt's images with it.
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import SettingsSection from "@/components/settings/SettingsSection";
import { notify } from "@/components/kit/notify";
import { sessionAuthHeaders } from "@/lib/session-headers";
import { IGNORES_KEY, useIgnores } from "@/hooks/useIgnores";

export default function IgnoredPeople({ num }: { num: string }) {
  const queryClient = useQueryClient();
  const { data: people, error } = useIgnores(true);
  const [busy, setBusy] = useState<string | null>(null);

  const unignore = async (user: string) => {
    setBusy(user);
    try {
      const res = await fetch("/api/ignores", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...sessionAuthHeaders() },
        body: JSON.stringify({ user, ignore: false }),
      });
      if (!res.ok) notify(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Couldn't un-ignore. Try again.");
    } catch {
      notify("Network hiccup. Try again.");
    } finally {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: IGNORES_KEY }),
        queryClient.invalidateQueries({ queryKey: ["/api/marketplace/prompts"] }),
        queryClient.invalidateQueries({ queryKey: ["prompt-public-images"] }),
      ]);
      setBusy(null);
    }
  };

  return (
    <SettingsSection num={num} title="People you ignore">
      <div className="set-section-desc" style={{ paddingBottom: 14, fontSize: 12.5 }}>
        Their prompts and images stay out of your feed, search and the images made with a prompt. Comments, notifications,
        the Hall of Fame and their profile still show them, and Show ignored on the feed brings them back. They are not told.
      </div>
      {error ? (
        <div className="set-section-desc">{error.message}</div>
      ) : !people ? (
        <div className="set-section-desc">Loading…</div>
      ) : people.length === 0 ? (
        <div className="set-section-desc">You ignore nobody. Ignore someone from their profile.</div>
      ) : (
        people.map((p) => (
          <div key={p.id} className="set-list-item">
            <div className="set-item-content">
              {/* As their profile names one without a handle (ProfileView). */}
              <div className="set-item-title">{p.displayName || "Unnamed"}</div>
              {p.handle && <div className="set-item-sub">@{p.handle}</div>}
            </div>
            <button className="set-btn set-btn-outline" disabled={busy === p.id} onClick={() => void unignore(p.id)}>Un-ignore</button>
          </div>
        ))
      )}
    </SettingsSection>
  );
}
