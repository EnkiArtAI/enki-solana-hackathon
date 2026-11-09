"use client";

import { useState, useEffect, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Instagram, AlertCircle, ArrowUpRight, CheckCircle2, X } from "lucide-react";

import SettingsLayout from "@/components/settings/SettingsLayout";
import SettingsNav, { TabItem } from "@/components/settings/SettingsNav";
import SettingsSection from "@/components/settings/SettingsSection";
import SettingsToggle from "@/components/settings/SettingsToggle";
import PaymentPanel from "@/components/settings/PaymentPanel";
import RecoveryPanel from "@/components/settings/RecoveryPanel";
import LinkedWallets from "@/components/settings/LinkedWallets";
import IgnoredPeople from "@/components/settings/IgnoredPeople";
import Segmented from "@/components/kit/Segmented";
import { DEFAULT_NOTICE_SECONDS, NOTICE_SECONDS, noticeSeconds, setNoticeSeconds, subscribeNoticeSeconds } from "@/lib/ui/kit/render-notices";
import { useEmailAuth } from "@/hooks/useEmailAuth";
import { useRecoveryStatus } from "@/hooks/useRecoveryStatus";
import { cdpOwnWalletAccount, cdpRuntimeExpected } from "@/lib/cdp-bridge";
import { DELETE_EXPIRED, useAccountDelete, useAccountFlags, useAccountRole, useConnectedAccounts } from "@/components/settings/use-account";
import "@/components/settings/settings.css";

const TABS: TabItem[] = [
  { id: "profile", label: "Profile" },
  { id: "payment", label: "Payment" },
  { id: "recovery", label: "Recovery & 2FA" },
];

// The X (formerly Twitter) logo — lucide ships no brand X icon, so inline it.
function GoogleLogo({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.5h6.5a5.6 5.6 0 0 1-2.4 3.6v3h3.9c2.2-2.1 3.5-5.1 3.5-8.8Z" />
      <path fill="#34A853" d="M12 24c3.2 0 6-1.1 7.9-2.9l-3.9-3c-1 .7-2.4 1.1-4 1.1-3.1 0-5.7-2.1-6.6-4.9h-4v3.1A12 12 0 0 0 12 24Z" />
      <path fill="#FBBC05" d="M5.4 14.3a7.2 7.2 0 0 1 0-4.6V6.6h-4a12 12 0 0 0 0 10.8l4-3.1Z" />
      <path fill="#EA4335" d="M12 4.8c1.8 0 3.3.6 4.6 1.8l3.4-3.4A12 12 0 0 0 1.4 6.6l4 3.1C6.3 6.9 8.9 4.8 12 4.8Z" />
    </svg>
  );
}

function XLogo({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

export default function SettingsPage({ initialTab, focusRamp = false, globalBannerVisible = false, focusGuardians: focusGuardiansProp = false, onBack }: { initialTab?: string; focusRamp?: boolean; globalBannerVisible?: boolean; focusGuardians?: boolean; onBack?: () => void } = {}) {
  const { toast } = useToast();
  const router = useRouter();
  // Back (Kev, 2026-10-13): the shell closes its panel; standalone /settings goes to the page before, or Home when there is none.
  const back = onBack ?? (() => (window.history.length > 1 ? router.back() : router.push("/home")));

  // initialTab lets embedders (sidebar balance chip → Payment) open a tab
  // directly; the URL deep-link below still wins when present.
  const [activeTab, setActiveTab] = useState(
    initialTab && TABS.some((t) => t.id === initialTab) ? initialTab : "profile"
  );
  // One-shot: the scroll+heartbeat fires only for the balance-chip entry.
  // Any manual tab click (including re-opening Payment) must not replay it.
  const [rampFocus, setRampFocus] = useState(focusRamp);
  // Slide the content pane left/right depending on which way the tab moved.
  const [slideDir, setSlideDir] = useState<"l" | "r">("r");
  // Pulse the Guardians area when Recovery is opened via the red banner.
  const [focusGuardians, setFocusGuardians] = useState(focusGuardiansProp);
  const changeTab = (t: string) => {
    const from = TABS.findIndex((x) => x.id === activeTab);
    const to = TABS.findIndex((x) => x.id === t);
    setSlideDir(to >= from ? "r" : "l");
    setRampFocus(false);
    setFocusGuardians(false); // plain tab clicks don't pulse
    setActiveTab(t);
  };

  // Red warning while the account has no confirmed recovery guardian.
  const recovery = useRecoveryStatus();
  /* Linked wallets are for an email account (Kev, 2026-10-08): a wallet
     account's own wallet would lose its remembered connection when the
     adapter disconnects after linking. The sections after it count on. */
  const { isAuthed: emailAuthed } = useEmailAuth();
  const no = (n: number) => String(n + (emailAuthed ? 1 : 0)).padStart(2, "0");

  // The Hall of Fame and 18+ switches (users.hide_from_leaderboard, users.adult_confirmed_at).
  const { hideLb, adult, toggleLeaderboard, toggleAdult } = useAccountFlags();
  // How long a finished render's notice stays (this device; RenderNotices reads it as each notice's time starts).
  const noticeFor = useSyncExternalStore(subscribeNoticeSeconds, noticeSeconds, () => DEFAULT_NOTICE_SECONDS);
  const [saving, setSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);

  // --- Mock States ---
  const [settings, setSettings] = useState({
    showLeaderboardGen: true,
    showLeaderboardEarn: true,
  });
  const [initialSettings, setInitialSettings] = useState({
    showLeaderboardGen: true,
    showLeaderboardEarn: true,
  });

  // --- Change Detection ---
  useEffect(() => {
    const isDifferent = JSON.stringify(settings) !== JSON.stringify(initialSettings);
    setHasChanges(isDifferent);
  }, [settings, initialSettings]);

  // Deep-link support: /settings?tab=billing opens that tab directly (e.g. from
  // an "Add funds" entry point).
  useEffect(() => {
    if (typeof window === "undefined") return;
    let tab = new URLSearchParams(window.location.search).get("tab");
    // The Billing tab merged into Payment — old deep links (PayPal's redirect
    // back lands on ?tab=billing) keep working.
    if (tab === "billing") tab = "payment";
    if (tab && TABS.some((t) => t.id === tab)) setActiveTab(tab);
  }, []);

  const updateSetting = (key: string, value: any) => {
    setSettings(prev => ({ ...prev, [key]: value }));
  };

  const handleSaveSettings = async () => {
    setSaving(true);
    // Mock save delay
    await new Promise(r => setTimeout(r, 800));
    setInitialSettings(settings);
    setHasChanges(false);
    setSaving(false);
    toast({ title: "Settings saved", description: "Your preferences have been updated." });
  };

  // Connected accounts (a Google or X account signs in to this one) and what a connected X account's posts earn.
  const { identities, configured, connectAccount, disconnectAccount, hasX, claim, claimShares } = useConnectedAccounts();
  const prompts = (n: number) => `${n} ${n === 1 ? "prompt" : "prompts"}`;

  // ── Delete account ──────────────────────────────────────────────────────
  const { deleteOpen, setDeleteOpen, deleteConfirm, setDeleteConfirm, deleteBusy, deletePending, setDeletePending, deleteHeld, submitDelete } = useAccountDelete();

  // --- Render Helpers ---
  const titleMap: Record<string, React.ReactNode> = {
    profile: "Profile.",
    payment: "Payment.",
    recovery: <>Recovery <span>&</span> 2FA.</>,
  };

  const descMap: Record<string, string> = {
    profile: "Manage your connected social accounts, linked wallets and visibility settings.",
    payment: "Your balance, your earnings, and the ways money moves in and out — always into your own wallet.",
    recovery: "Keep more than one way back in — a passkey on another device, plus guardians you trust.",
  };

  // The Admin section, for admins and mods only.
  const IS_ADMIN = useAccountRole();

  return (
    <>
      <div>
        <SettingsLayout
          onBack={back}
          title={titleMap[activeTab] || "Settings."}
          description={descMap[activeTab]}
        >
          {/* Persistent (no X) recovery warning — shown ONLY when the global
              top banner isn't already visible (else it's redundant). Inside
              Settings it can't be dismissed, only fixed. */}
          {!globalBannerVisible && recovery !== null && recovery.confirmed === 0 && (
            /* Whole strip is the button → same height on every tab (the old
               inline "Set it up" button changed the row height). */
            <div
              role="alert"
              onClick={() => { if (activeTab !== "recovery") { changeTab("recovery"); setFocusGuardians(true); } }}
              style={{
                display: "flex", alignItems: "center", gap: 10,
                margin: "0 0 18px", padding: "12px 14px", borderRadius: 10,
                background: "#b3271e", color: "#fff", fontSize: 13, fontWeight: 600,
                cursor: activeTab !== "recovery" ? "pointer" : "default",
              }}
            >
              <span style={{ flex: 1 }}>
                No recovery set up. Lose this login and the account is gone.
              </span>
              {activeTab !== "recovery" && (
                <span style={{ fontSize: 12, fontWeight: 700, opacity: 0.9, whiteSpace: "nowrap" }}>Set it up →</span>
              )}
            </div>
          )}
          <SettingsNav
            tabs={TABS}
            activeTab={activeTab}
            onChange={changeTab}
          />

          {/* Keyed so a tab change replays the slide; direction follows the move. */}
          <div key={activeTab} className={`set-tabpane set-slide-${slideDir}`}>

          {/* === PROFILE TAB === */}
          {activeTab === "profile" && (
            <>
              <SettingsSection num="01" title="Connected accounts">
                <div className="set-section-desc" style={{ paddingBottom: 14, fontSize: 12.5 }}>
                  A Google or X account connected here signs you in to this one.
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 10, justifyContent: "flex-start" }}>
                  {([
                    { key: "google", label: "Google", icon: <GoogleLogo size={16} />, bg: "#fff", connect: () => connectAccount("google") },
                    { key: "x", label: "X", icon: <XLogo size={16} />, bg: "#000", connect: () => connectAccount("x") },
                    { key: "instagram", label: "Instagram", icon: <Instagram size={18} />, bg: "linear-gradient(45deg,#f09433,#dc2743,#bc1888)",
                      connect: () => toast({ title: "Almost there", description: "Instagram is not connected yet." }) },
                  ] as const).map((s) => {
                    const linked = identities.find((i) => i.provider === s.key);
                    // A provider this server cannot use shows no Connect; a connected one stays, to disconnect.
                    if (s.key !== "instagram" && !configured[s.key] && !linked) return null;
                    return (
                    <div
                      key={s.key}
                      style={{
                        width: 108,
                        display: "flex", flexDirection: "column", alignItems: "center", gap: 7,
                        border: "1px solid var(--enki-rule)", borderRadius: 10, padding: "12px 8px", textAlign: "center",
                      }}
                    >
                      <span className="set-item-icon" style={{ background: s.bg, color: "#fff", width: 36, height: 36, borderRadius: 10, marginRight: 0, border: "1px solid var(--enki-rule)" }}>{s.icon}</span>
                      <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--enki-ink)" }}>{s.label}</span>
                      {linked ? (
                        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, width: "100%" }}>
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, color: "var(--enki-ink)", maxWidth: "100%", overflow: "hidden" }}>
                            <CheckCircle2 size={12} style={{ color: "#1f8a5b", flexShrink: 0 }} />
                            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{linked.handle ? `@${linked.handle}` : linked.email ?? "Connected"}</span>
                          </span>
                          <button
                            onClick={() => disconnectAccount(s.key)}
                            style={{ fontSize: 10.5, color: "var(--enki-ink-3)", background: "none", border: "none", cursor: "pointer", textDecoration: "underline" }}
                          >
                            Disconnect
                          </button>
                        </div>
                      ) : (
                        <button className="set-btn set-btn-outline" style={{ height: 26, padding: "0 14px", fontSize: 12 }} onClick={s.connect}>
                          Connect
                        </button>
                      )}
                    </div>
                    );
                  })}
                </div>
                {hasX && claim && claim.prompts > 0 && (claim.open > 0 || claim.claimed) && (
                  <div className="set-section-desc" style={{ paddingTop: 14, fontSize: 12.5 }}>
                    {claim.open > 0 ? (
                      <>
                        {prompts(claim.prompts)} from your posts on X {claim.prompts === 1 ? "is" : "are"} on Enki. Claim them, and your share of every render goes{" "}
                        {claim.payoutWallet ? "to your wallet." : "into your author vault until a Solana wallet is on your account."}{" "}
                        <button className="set-btn set-btn-outline" style={{ height: 26, padding: "0 14px", fontSize: 12 }} onClick={claimShares}>
                          Claim
                        </button>
                        <div style={{ fontSize: 11, color: "var(--enki-ink-3)", marginTop: 6 }}>By claiming you confirm that this X account is yours.</div>
                      </>
                    ) : (
                      <>
                        Your share of {prompts(claim.prompts)} from your posts goes{" "}
                        {claim.payoutWallet ? "to your wallet." : "into your author vault until a Solana wallet is on your account."}
                      </>
                    )}
                    {claim.vaultUsd ? (
                      <div style={{ marginTop: 6 }}>
                        ${claim.vaultUsd.toFixed(2)} waits in your author vault. It is paid out to your wallet once the vault release is live.
                      </div>
                    ) : null}
                  </div>
                )}
              </SettingsSection>

              {emailAuthed && <LinkedWallets num="02" />}

              <SettingsSection num={no(2)} title="Hall of Fame">
                <div className="set-list-item">
                  <div className="set-item-content">
                    <div className="set-item-title">Show me on the Hall of Fame</div>
                    <div className="set-item-sub">Appear in the public rankings for generations and earnings.</div>
                  </div>
                  <SettingsToggle
                    checked={hideLb === null ? true : !hideLb}
                    disabled={hideLb === null}
                    onChange={(c) => toggleLeaderboard(c)}
                  />
                </div>
              </SettingsSection>

              <SettingsSection num={no(3)} title="18+ content">
                <div className="set-list-item">
                  <div className="set-item-content">
                    <div className="set-item-title">I am 18 or older</div>
                    <div className="set-item-sub">Adds an 18+ filter to the feed, off until you turn it on, and lets you generate 18+ images. 18+ means sexual content; nudity alone is not 18+.</div>
                  </div>
                  <SettingsToggle
                    checked={adult === true}
                    disabled={adult === null}
                    onChange={(c) => toggleAdult(c)}
                  />
                </div>
              </SettingsSection>

              <SettingsSection num={no(4)} title="Notifications">
                <div className="set-list-item">
                  <div className="set-item-content">
                    <div className="set-item-title">When an image is ready</div>
                    <div className="set-item-sub">How long its notice stays before it goes by itself; ∞ keeps it until you close it. On this device.</div>
                    <div style={{ marginTop: 12 }}>
                      {/* A thumb that glides between the choices, like a switch (Kev, 2026-10-26); ∞ keeps the four equal and short. */}
                      <Segmented slide role="radiogroup" ariaLabel="How long the notice stays" value={String(noticeFor)}
                        onChange={(k) => setNoticeSeconds(NOTICE_SECONDS.find((s) => String(s) === k) ?? DEFAULT_NOTICE_SECONDS)}
                        options={NOTICE_SECONDS.map((s) => (s ? { key: String(s), label: `${s} s` } : { key: "0", label: "∞", title: "Until I close it" }))} />
                    </div>
                  </div>
                </div>
              </SettingsSection>

              <IgnoredPeople num={no(5)} />

              <SettingsSection num={no(6)} title="Danger Zone">
                <div className="set-list-item">
                  <div className="set-item-icon" style={{ color: '#e23b3b', background: '#ffebeb' }}><AlertCircle size={14} /></div>
                  <div className="set-item-content">
                    <div className="set-item-title" style={{ color: '#e23b3b' }}>Delete account</div>
                    <div className="set-item-sub">
                      {recovery && recovery.confirmed > 0
                        ? "Your guardians must approve this first. Everything you made is removed."
                        : "Permanently removes your account and everything you made. Can't be undone."}
                    </div>
                  </div>
                  <button className="set-btn set-btn-danger" onClick={() => setDeleteOpen(true)}>Delete account</button>
                </div>
              </SettingsSection>

              {IS_ADMIN && (
                <SettingsSection num={no(7)} title="Admin">
                  <div className="set-list-item">
                    <div className="set-item-icon" style={{ color: '#f5c542', background: '#fffaeb' }}>⚙</div>
                    <div className="set-item-content">
                      <div className="set-item-title">Admin Panel</div>
                      <div className="set-item-sub">Review imports, reports, feedback, and manage community trust. Only visible to admin wallets.</div>
                    </div>
                    <a href="/admin" className="set-btn set-btn-secondary" style={{ display: "flex", alignItems: "center", gap: 6, textDecoration: "none" }}>
                      Open Admin <ArrowUpRight size={12} />
                    </a>
                  </div>
                </SettingsSection>
              )}
            </>
          )}

          {/* === PAYMENT TAB === */}
          {activeTab === "payment" && <PaymentPanel focusRamp={rampFocus} />}

          {/* === RECOVERY & 2FA TAB === */}
          {activeTab === "recovery" && <RecoveryPanel focus={focusGuardians} />}

          </div>
        </SettingsLayout>
        
        {/* Floating Save Button */}
        <div className={`set-save-floater ${hasChanges ? 'visible' : ''}`}>
          <span>Unsaved changes</span>
          <button onClick={handleSaveSettings} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save Settings"}
          </button>
        </div>

        {/* ── Delete account confirm ── */}
        {deleteOpen && (
          <div className="set-pay-overlay" onClick={() => !deleteBusy && !deletePending && setDeleteOpen(false)}>
            <div className="set-pay-card set-pay-card--fiat" onClick={(e) => e.stopPropagation()}>
              {deletePending ? (
                <div style={{ textAlign: "center" }}>
                  <div className="set-item-title" style={{ marginBottom: 8 }}>{deleteHeld === DELETE_EXPIRED ? "Deletion request expired" : deleteHeld ? "Deletion on hold" : "Waiting for your guardians"}</div>
                  <p className="set-item-sub" style={{ marginBottom: 16 }}>
                    {deleteHeld ?? "We emailed your guardians. Your account is deleted once enough of them approve. You can close this."}
                  </p>
                  <button className="set-btn set-btn-outline" style={{ width: "100%", justifyContent: "center" }} onClick={() => { setDeleteOpen(false); setDeletePending(false); }}>
                    Close
                  </button>
                </div>
              ) : (
                <>
                  <div className="set-item-title" style={{ color: "#e23b3b", marginBottom: 6 }}>Delete your account?</div>
                  {cdpRuntimeExpected() && !cdpOwnWalletAccount() && (
                    <p className="set-item-sub" style={{ marginBottom: 14 }}>
                      Move your funds or export your key first: after deletion you can no longer reach this wallet.
                    </p>
                  )}
                  <p className="set-item-sub" style={{ marginBottom: 14 }}>
                    This removes your account and everything you made, for good.
                    {recovery && recovery.confirmed > 0
                      ? " Your guardians will be asked to approve before it happens."
                      : ""} Type your username to confirm.
                  </p>
                  <input
                    value={deleteConfirm}
                    onChange={(e) => setDeleteConfirm(e.target.value)}
                    placeholder="your_username"
                    autoFocus
                    style={{ width: "100%", height: 40, padding: "0 12px", borderRadius: 8, fontSize: 14, border: "1px solid var(--enki-rule)", background: "transparent", color: "var(--enki-ink)", outline: "none" }}
                  />
                  <button
                    className="set-btn set-btn-danger"
                    style={{ width: "100%", justifyContent: "center", marginTop: 14 }}
                    onClick={submitDelete}
                    disabled={deleteBusy || deleteConfirm.trim().length < 3}
                  >
                    {deleteBusy ? <Loader2 size={14} className="set-spin" /> : (recovery && recovery.confirmed > 0 ? "Request deletion" : "Delete forever")}
                  </button>
                  <button
                    className="set-btn set-btn-outline"
                    style={{ width: "100%", justifyContent: "center", marginTop: 8 }}
                    onClick={() => setDeleteOpen(false)}
                    disabled={deleteBusy}
                  >
                    Cancel
                  </button>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
