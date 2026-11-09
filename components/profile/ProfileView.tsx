"use client";

import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useActiveAccount } from "thirdweb/react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useCdpAddress } from "@/hooks/useCdpAddress";
import { useSolanaAuth } from "@/hooks/useSolanaAuth";
import { sessionAuthHeaders, viewerHeaders } from "@/lib/session-headers";
import EnkiDetailPanel from "@/components/enki/EnkiDetailPanel";
import PromptWall from "@/components/enki/PromptWall";
import EnkiFilters from "@/components/enki/EnkiFilters";
import Segmented from "@/components/kit/Segmented";
import BookmarksPanel from "@/components/enki-shell/BookmarksPanel";
import { toFeedCard, type FeedCard } from "@/lib/ui/feed/card";
import { generatorAliases, generatorGroups } from "@/lib/ui/feed/generators";
import { failureSentence } from "@/lib/search/client";
import { stashEditorSeed } from "@/components/enki-shell/editorBridge";
import { librarySeed } from "@/lib/editor/editor-seed";
import { notify } from "@/components/kit/notify";
import { useBetaAccess } from "@/components/BetaGate";
import { openLogin } from "@/lib/openLogin";
import { listCreations, removeCreation, serverUrls, subscribeCreations } from "@/lib/creations";
import GalleryWall, { GALLERY_PAGE, rowsOf, toGalleryItem, type GalleryItem } from "@/components/gallery/GalleryWall";
import { leaveQuickCreateSeed } from "@/lib/ui/quick-create-seed";
import ConfirmDialog from "@/components/kit/ConfirmDialog";
import { useModelCatalogue } from "@/hooks/useModelLimits";
import type { ImageViewSeed } from "@/lib/ui/image-view/seed";
import { useStepUp } from "@/components/StepUpProvider";
import { useSearchParams, useRouter } from "next/navigation";
import { ArrowLeft, ChevronRight, ImageOff, Pencil, Loader2, ZoomIn, Heart, Flag, MessageCircle, Search, X } from "lucide-react";
import { offerStyleEditor } from "@/lib/share/after-release";
import NftFilter, { NftWall } from "@/components/profile/NftFilter";
import type { Nft } from "@/components/enki/NftGrid";
import { MessageButton } from "@/components/profile/MessageButton";
import { FollowButtons } from "@/components/profile/FollowButtons";
import { IgnoreButton } from "@/components/profile/IgnoreButton";
import { ReportButton } from "@/components/ReportButton";
import Seal from "@/components/kit/Seal";
import { CARD, CTA, LABEL, PILL, TITLE } from "@/components/enki-window";
import "@/components/enki/enki.css";
import { encodeCanvas } from "@/lib/shrink-image";
import { lockScroll } from "@/lib/ui/kit/controls";

const PROFILE_STATS = [["Prompts", "totalPrompts"], ["Uses", "uses"], ["Followers", "followers"], ["This month", "usesMonth"]] as const;
const SHELF_SORTS = [{ key: "performance", label: "Performance" }, { key: "newest", label: "Date" }] as const;
type ShelfSort = (typeof SHELF_SORTS)[number]["key"];
type ShelfPage = { prompts?: unknown[]; hasMore?: boolean; nextCursor?: string };

type Me = {
  handle: string | null;
  bio: string | null;
  avatarUrl: string | null;
  coverUrl: string | null;
  promptCount?: number | null;
};

/* ── Image focus editing ──────────────────────────────────────────────
   The banner is pan/zoomable in edit mode. z = 1 fits the image
   to the frame (full width first, never letterboxed), higher z zooms in.
   ox/oy are the image's top-left inside the frame, clamped so the frame
   stays covered; null means centered. On save the visible crop is baked
   into the uploaded file, so no focal metadata is stored anywhere. */
type ImgState = {
  src: string;
  iw: number;
  ih: number;
  z: number;
  ox: number | null;
  oy: number | null;
  changed: boolean;
};

const clampOff = (v: number, frame: number, size: number) => Math.min(0, Math.max(frame - size, v));

function imgLayout(s: ImgState, fw: number, fh: number) {
  const sc = Math.max(fw / s.iw, fh / s.ih) * s.z;
  const w = s.iw * sc;
  const h = s.ih * sc;
  return {
    sc, w, h,
    ox: clampOff(s.ox ?? (fw - w) / 2, fw, w),
    oy: clampOff(s.oy ?? (fh - h) / 2, fh, h),
  };
}

function loadImageState(src: string, changed = false): Promise<ImgState | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve({ src, iw: img.naturalWidth, ih: img.naturalHeight, z: 1, ox: null, oy: null, changed });
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

async function exportCrop(s: ImgState, fw: number, fh: number, outW: number, outH: number): Promise<File | null> {
  const img = new Image();
  img.crossOrigin = "anonymous";
  const ok = await new Promise<boolean>((res) => {
    img.onload = () => res(true);
    img.onerror = () => res(false);
    img.src = s.src;
  });
  if (!ok || !img.naturalWidth) return null;
  const { sc, ox, oy } = imgLayout(s, fw, fh);
  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(img, -ox / sc, -oy / sc, fw / sc, fh / sc, 0, 0, outW, outH);
  try {
    // WebP, or a JPEG on Safari, which encodes no WebP: labelled as what it is (lib/shrink-image).
    const blob = await encodeCanvas(canvas, 0.85);
    return blob ? new File([blob], `image.${blob.type.split("/")[1]}`, { type: blob.type }) : null;
  } catch {
    return null; // canvas tainted (source without CORS) — needs a fresh file
  }
}

const heroBtn: React.CSSProperties = {
  height: 44, padding: "0 20px", borderRadius: 999,
  display: "inline-flex", alignItems: "center", gap: 8,
  fontSize: 14, fontWeight: 600, cursor: "pointer",
  // Longhand: Follow and the bell set and drop borderColor, which React refuses beside a `border`.
  background: "transparent", borderWidth: 1.5, borderStyle: "solid", borderColor: "var(--enki-rule)", color: "var(--enki-ink)",
};

const overlayChip: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 6,
  fontSize: 12, fontWeight: 600, padding: "7px 12px", borderRadius: 999,
  background: "rgba(0,0,0,0.6)", color: "#fff", cursor: "pointer", border: "none",
};

/**
 * Edit profile — its own popup. The banner is pan/zoomable right in the
 * modal (drag to reposition, slider to zoom); the preview crops at the same
 * aspect ratio as the page banner, and the visible crop is baked into the
 * uploaded file on save. No profile picture: the seal follows the username
 * (Kev, 2026-10-26: "i dont want no profile images on enki").
 */
function EditProfileModal({ me, pageBannerW, pageBannerH, onClose, onSaved }: {
  me: Me;
  pageBannerW: number;
  pageBannerH: number;
  onClose: () => void;
  onSaved: (m: Me) => void;
}) {
  const [dHandle, setDHandle] = useState(me.handle ?? "");
  const [dBio, setDBio] = useState(me.bio ?? "");
  const [bannerImg, setBannerImg] = useState<ImgState | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [fw, setFw] = useState(512); // measured modal banner width
  const dragRef = useRef<{ startX: number; startY: number; ox: number; oy: number } | null>(null);

  // Banner preview height follows the page banner's aspect, so what you
  // frame here is exactly what the profile shows.
  const fh = Math.max(64, Math.round((fw * pageBannerH) / Math.max(320, pageBannerW)));
  const AVM = 128; // the seal's frame (square)

  useEffect(() => {
    if (me.coverUrl) loadImageState(me.coverUrl).then(setBannerImg);
  }, [me.coverUrl]);

  useEffect(() => {
    const measure = () => { if (frameRef.current) setFw(frameRef.current.clientWidth); };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  // The share editor opens over this and stays over it: it hears first, this after it, and the panel not at all.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.defaultPrevented) { e.stopPropagation(); onClose(); } };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const pickImage = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    loadImageState(URL.createObjectURL(f), true).then((s) => {
      if (s) setBannerImg(s);
      else setErr("Couldn't read that image. Try a PNG, JPG or WebP.");
    });
  };

  const beginDrag = (e: React.PointerEvent) => {
    if (!bannerImg) return;
    const l = imgLayout(bannerImg, fw, fh);
    dragRef.current = { startX: e.clientX, startY: e.clientY, ox: l.ox, oy: l.oy };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const moveDrag = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d || !bannerImg) return;
    const l = imgLayout(bannerImg, fw, fh);
    setBannerImg({
      ...bannerImg,
      ox: clampOff(d.ox + e.clientX - d.startX, fw, l.w),
      oy: clampOff(d.oy + e.clientY - d.startY, fh, l.h),
      changed: true,
    });
  };
  const endDrag = () => { dragRef.current = null; };

  // Zoom around the frame center so the picture doesn't jump while zooming.
  const setZoom = (z: number) => {
    if (!bannerImg) return;
    const before = imgLayout(bannerImg, fw, fh);
    const ratio = z / bannerImg.z;
    setBannerImg({
      ...bannerImg,
      z,
      ox: fw / 2 - (fw / 2 - before.ox) * ratio,
      oy: fh / 2 - (fh / 2 - before.oy) * ratio,
      changed: true,
    });
  };

  const save = async () => {
    setErr(null);
    setBusy(true);
    try {
      const fd = new FormData();
      const nh = dHandle.trim().toLowerCase();
      if (nh && nh !== (me.handle ?? "")) fd.append("handle", nh);
      if (dBio.trim() !== (me.bio ?? "").trim()) fd.append("bio", dBio);
      if (bannerImg?.changed) {
        const f = await exportCrop(bannerImg, fw, fh, 1600, Math.round((1600 * fh) / fw));
        if (!f) throw new Error("Couldn't process the banner. Pick the file again and retry.");
        fd.append("cover", f);
      }
      if ([...fd.keys()].length === 0) { onClose(); return; }
      const res = await fetch("/api/users/profile", { method: "POST", headers: sessionAuthHeaders(), body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Could not save");
      onSaved(data as Me);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not save");
      setBusy(false);
    }
  };

  const bannerL = bannerImg ? imgLayout(bannerImg, fw, fh) : null;

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, zIndex: 400, display: "flex",
        alignItems: "center", justifyContent: "center",
        background: "rgba(0, 0, 0, 0.5)", backdropFilter: "blur(6px)", WebkitBackdropFilter: "blur(6px)", padding: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(600px, 100%)", maxHeight: "92vh", overflowY: "auto",
          background: "var(--enki-paper)", border: "1px solid var(--enki-rule)",
          borderRadius: CARD.borderRadius, boxShadow: "0 30px 80px rgba(0,0,0,0.35)",
        }}
      >
        {/* Banner cropper */}
        <div
          ref={frameRef}
          style={{
            height: fh, borderRadius: `${CARD.borderRadius}px ${CARD.borderRadius}px 0 0`, position: "relative", overflow: "hidden",
            background: "linear-gradient(135deg, var(--enki-paper-3), var(--enki-paper-2))",
            cursor: bannerImg ? "grab" : "default", touchAction: "none",
          }}
          onPointerDown={beginDrag}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
        >
          {bannerImg && bannerL && (
            <img
              src={bannerImg.src}
              alt=""
              draggable={false}
              style={{ position: "absolute", left: bannerL.ox, top: bannerL.oy, width: bannerL.w, height: bannerL.h, maxWidth: "none", userSelect: "none", pointerEvents: "none" }}
            />
          )}
          <label style={{ ...overlayChip, position: "absolute", top: 10, left: 10 }} onPointerDown={(e) => e.stopPropagation()}>
            <input type="file" accept="image/png,image/jpeg,image/webp" onChange={pickImage} style={{ display: "none" }} />
            <Pencil size={11} /> {bannerImg ? "Change banner" : "Add banner"}
          </label>
          {bannerImg && (
            <span
              style={{ ...overlayChip, position: "absolute", bottom: 10, right: 10, cursor: "default" }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <ZoomIn size={12} />
              <input
                type="range"
                min={1}
                max={4}
                step={0.01}
                value={bannerImg.z}
                onChange={(e) => setZoom(Number(e.target.value))}
                style={{ width: 110, accentColor: "#fff" }}
                aria-label="Zoom banner"
              />
            </span>
          )}
        </div>
        {bannerImg && (
          <div style={{ padding: "6px 24px 0", fontSize: 11.5, color: "var(--enki-ink-3)" }}>
            Drag the banner to reposition it. The slider zooms.
          </div>
        )}

        <div style={{ padding: "0 24px 24px" }}>
          {/* The seal, as the username draws it */}
          <div style={{ display: "flex", alignItems: "flex-end", gap: 14, marginTop: bannerImg ? 8 : -36 }}>
            <div style={{ width: AVM + 10, height: AVM + 10, borderRadius: 26, overflow: "hidden", border: "5px solid var(--enki-paper)", background: "var(--enki-paper)" }}>
              <Seal handle={dHandle.trim() || me.handle || ""} />
            </div>
            <div style={{ paddingBottom: 8, fontSize: 11.5, color: "var(--enki-ink-3)" }}>Your seal comes from your username.</div>
          </div>

          <h2 style={{ ...TITLE, margin: "14px 0 18px" }}>Edit profile</h2>

          <div style={{ display: "grid", gap: 14 }}>
            <div>
              <div style={{ ...LABEL, marginBottom: 6 }}>Username</div>
              <input
                value={dHandle}
                onChange={(e) => setDHandle(e.target.value)}
                maxLength={20}
                className="st-input"
                placeholder="your_name"
              />
              <div style={{ fontSize: 12, color: "var(--enki-ink-3)", marginTop: 5 }}>
                3 to 20 characters. Letters, numbers or _
              </div>
            </div>
            <div>
              <div style={{ ...LABEL, marginBottom: 6 }}>Bio</div>
              <textarea
                value={dBio}
                onChange={(e) => setDBio(e.target.value)}
                maxLength={280}
                rows={4}
                className="st-input"
                style={{ resize: "vertical" }}
                placeholder="A visitor on the canvas of time."
              />
              <div style={{ fontSize: 12, color: "var(--enki-ink-3)", marginTop: 5, textAlign: "right" }}>
                {dBio.length}/280
              </div>
            </div>
            <button type="button" data-a="share-style" onClick={offerStyleEditor} className="st-input" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", textAlign: "left", cursor: "pointer" }}>
              Your share style<ChevronRight size={15} aria-hidden />
            </button>
          </div>

          {err && (
            <div style={{ marginTop: 12, fontSize: 13, color: "var(--enki-danger)" }}>{err}</div>
          )}

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 20 }}>
            <button style={{ ...PILL, width: "auto", minHeight: 40, padding: "0 20px", cursor: "pointer" }} onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button
              style={{ ...CTA, width: "auto", minHeight: 40, padding: "0 20px", cursor: "pointer", minWidth: 96 }}
              onClick={save}
              disabled={busy}
            >
              {busy ? <Loader2 size={15} style={{ animation: "spin 1s linear infinite" }} /> : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function useSafeActiveAccount() {
  try { return useActiveAccount(); } catch { return null; }
}

export default function ProfilePage({ onBack, isOwnProfile = true, handle }: { onBack?: () => void; isOwnProfile?: boolean; handle?: string } = {}) {
  /* ONE profile layout for everyone (Kev, 2026-08-24: "so ähnlich müssen
     auch andere profile angezeigt werden nur ohne deren likes"). `handle`
     switches this page to a FOREIGN view: same hero, same tabs minus the
     private ones, data loaded for that creator instead of the session. */
  const own = handle ? false : isOwnProfile;
  // History is a PRIVATE tab: only the profile owner sees it, never visitors.
  // Likes is PRIVATE like History: only the owner's view carries the tab,
  // and the route it reads derives the list from the SESSION — a visitor
  // cannot request anyone else's likes (Kev, 2026-08-23).
  /* Library is PRIVATE too (Kev, 2026-09-05): the owner's saved prompts and
     workflows, one click from the editor. */
  const TABS = own
    ? ["Released", "Gallery", "Library", "Likes", "Bookmarks", "Reviews", "About", "History"]
    : ["Released", "Gallery", "Reviews", "About"];
  const router = useRouter();
  const [activeTab, setActiveTab] = useState("Released");
  // The magnifier in the tab bar: finds in this profile's Released (the server, by title) and Gallery (what is loaded).
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [term, setTerm] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setTerm(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);
  const closeSearch = () => { setSearchOpen(false); setSearch(""); setTerm(""); };
  // Filter by NFT: while one is checked, the checked ones show in place of the tab.
  const [checkedNfts, setCheckedNfts] = useState<Nft[]>([]);
  const showNfts = checkedNfts.length > 0;
  // A term, or the NFTs coming and going, changes the wall under whoever is deep in it: back to the wall's start, its tabs stuck, or the first matches lie out of sight above.
  const contentRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const content = contentRef.current;
    const tabs = content?.previousElementSibling;
    if (!content || !tabs) return;
    const past = tabs.getBoundingClientRect().bottom - content.getBoundingClientRect().top;
    if (past > 0) (content.closest(".ek-panel-body") ?? window).scrollBy(0, -past);
  }, [term, showNfts]);
  // The private Likes tab — fetched lazily the first time it opens.
  const [myLikes, setMyLikes] = useState<Array<{ promptId: string; title: string; imageUrl: string | null }> | null>(null);
  useEffect(() => {
    if (activeTab !== "Likes" || myLikes !== null) return;
    fetch("/api/prompts/likes/mine", { headers: viewerHeaders() })
      .then((r) => (r.ok ? r.json() : { likes: [] }))
      .then((d) => setMyLikes(d.likes ?? []))
      .catch(() => setMyLikes([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);
  // The private library — fetched lazily the first time its tab opens.
  type LibItem = { id: string; name: string; kind: string; updated_at: string; graph: unknown; prompt_text: string | null };
  const [library, setLibrary] = useState<LibItem[] | null>(null);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const loadLibrary = async () => {
    setLibraryError(null);
    try {
      const r = await fetch("/api/library", { headers: { ...sessionAuthHeaders() } });
      const d = (await r.json().catch(() => ({}))) as { items?: LibItem[]; error?: string };
      if (!r.ok) { setLibrary([]); setLibraryError(d.error || `Couldn't load your library (HTTP ${r.status}).`); return; }
      setLibrary(Array.isArray(d.items) ? d.items : []);
    } catch { setLibrary([]); setLibraryError("Couldn't load your library."); }
  };
  useEffect(() => {
    if (activeTab !== "Library" || library !== null) return;
    void loadLibrary();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);
  const { guarded } = useStepUp();
  const deleteLibraryItem = async (id: string) => {
    // Step-up 2FA once the user has a factor (MFA-3); a cancel leaves the item.
    const res = await guarded(`delete-library:${id}`, (h) =>
      fetch(`/api/library?id=${encodeURIComponent(id)}`, { method: "DELETE", headers: { ...sessionAuthHeaders(), ...h } }),
    );
    if (res.ok) setLibrary((l) => (l ?? []).filter((x) => x.id !== id));
  };
  // Nothing leaves the library without an "are you sure" (Kev, 2026-10-15).
  const [libraryDelete, setLibraryDelete] = useState<string | null>(null);
  const searchParams = useSearchParams();

  const account = useSafeActiveAccount();
  const { publicKey: solanaPublicKey } = useWallet();
  const { address: cdpAddress } = useCdpAddress();
  // Session-backed Solana identity: after a page load the wallet ADAPTER is
  // disconnected (autoConnect off) but the signed session lives on — without
  // it this page showed "Guest / not connected" to logged-in wallet users.
  const { isAuthenticated: solanaSessionActive, walletAddress: solanaSessionAddress } = useSolanaAuth();
  const walletAddress =
    account?.address ??
    (solanaSessionActive ? solanaSessionAddress : null) ??
    solanaPublicKey?.toBase58() ??
    cdpAddress ?? null;

  // The user's name, bio and images live in the DB. The gate check already
  // fetched them at app boot, so the profile paints instantly from that cache
  // and only the prompt count arrives with the background refresh — no more
  // blank header or default-bio flash.
  const { access, role, userId: seedOwner, setHandle: setSidebarHandle, profile: gateProfile, setProfile: setGateProfile } = useBetaAccess();
  // The verdict every other page uses: a connected wallet without a session is signed out here too (Kev, 2026-10-21).
  const isAuthed = access === "ok" && role !== "team";
  // The checks belong to one profile, as one viewer sees it; so does the menu's read (the key on NftFilter).
  const nftScope = `${handle ?? ""}:${seedOwner ?? ""}`;
  const [nftScopeWas, setNftScopeWas] = useState(nftScope);
  if (nftScopeWas !== nftScope) { setNftScopeWas(nftScope); setCheckedNfts([]); }
  const [me, setMe] = useState<Me | null>(!handle && gateProfile ? { ...gateProfile } : null);
  useEffect(() => {
    if (!handle && gateProfile) setMe((cur) => cur ?? { ...gateProfile });
  }, [gateProfile, handle]);

  /* Foreign profile: the creator's PUBLIC data, plus their payout wallet —
     which keys the gallery below (generations are stored by wallet). */
  const [creatorWallet, setCreatorWallet] = useState<string | null>(null);
  const [creatorId, setCreatorId] = useState<string | null>(null);
  // Both profiles' numbers (and a foreign profile's hero) read this; FollowButtons reads it again after a change.
  const shelf = handle ?? gateProfile?.handle ?? null;
  const { data: creatorProfile } = useQuery({
    queryKey: ["creator-profile", shelf],
    enabled: !!shelf,
    queryFn: async () => {
      const res = await fetch(`/api/creators/${encodeURIComponent(shelf ?? "")}/profile`, { headers: viewerHeaders() });
      if (!res.ok) throw new Error("Failed to load the profile");
      return res.json();
    },
  });
  const stats = creatorProfile?.stats as Partial<Record<(typeof PROFILE_STATS)[number][1], number | null>> | undefined;
  useEffect(() => {
    if (!handle || !creatorProfile) return;
    const d = creatorProfile;
    setMe({
      handle: d.creator?.username ?? handle,
      bio: d.creator?.bio ?? null,
      avatarUrl: d.creator?.avatarUrl ?? null,
      coverUrl: d.creator?.coverImageUrl ?? null,
      promptCount: d.stats?.totalPrompts ?? 0,
    });
    setCreatorWallet(d.creator?.wallet ?? null);
    setCreatorId(d.creator?.id ? String(d.creator.id) : null);
  }, [handle, creatorProfile]);

  // Clicking the banner or avatar opens it full-size in a lightbox.
  // Its src is null for the seal of someone without a picture.
  const [lightbox, setLightbox] = useState<{ src: string | null } | null>(null);
  // A picture that no longer loads (an imported creator's X picture, replaced on X) shows the seal.
  const [avatarFailed, setAvatarFailed] = useState(false);
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setLightbox(null); } };
    window.addEventListener("keydown", onKey, true);
    const release = lockScroll(document.documentElement, window.innerWidth);
    return () => { window.removeEventListener("keydown", onKey, true); release(); };
  }, [lightbox]);

  // Edit profile pops its own UI (modal); the page banner is measured on open
  // so the modal's banner preview crops at the exact same aspect ratio.
  const [editOpen, setEditOpen] = useState(false);
  const bannerRef = useRef<HTMLDivElement | null>(null);
  const [pageBannerW, setPageBannerW] = useState(1200);
  const [pageBannerH, setPageBannerH] = useState(320);
  const startEdit = () => {
    if (!me) return;
    if (bannerRef.current) {
      setPageBannerW(bannerRef.current.clientWidth);
      setPageBannerH(bannerRef.current.clientHeight); // responsive height
    }
    setEditOpen(true);
  };
  useEffect(() => {
    if (handle) return; // foreign profile: the creator fetch above owns `me`
    if (!isAuthed) { setMe(null); return; }
    let dead = false;
    (async () => {
      try {
        const res = await fetch("/api/users/handle?stats=1", { headers: sessionAuthHeaders() });
        if (!res.ok) return; // the cached gate profile stays on screen
        const data = (await res.json()) as Partial<Me>;
        if (dead) return;
        const fresh: Me = {
          handle: data.handle ?? null,
          bio: data.bio ?? null,
          avatarUrl: data.avatarUrl ?? null,
          coverUrl: data.coverUrl ?? null,
          promptCount: data.promptCount ?? 0,
        };
        setMe(fresh);
        setGateProfile({ handle: fresh.handle, bio: fresh.bio, avatarUrl: fresh.avatarUrl, coverUrl: fresh.coverUrl });
      } catch { /* the cached gate profile stays on screen */ }
    })();
    return () => { dead = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthed]);

  const displayName = me ? (me.handle ?? "Unnamed") : " ";
  // Every profile has a bio — new accounts start with the canvas line. While
  // nothing is loaded yet, show nothing instead of flashing the default line.
  const bio = me ? (me.bio && me.bio.trim()) || "A visitor on the canvas of time." : "";

  const catalogue = useModelCatalogue();
  const generators = useMemo(() => generatorGroups(catalogue), [catalogue]);
  // Released's controls under the tabs (Kev, 2026-11-03). The server sorts and narrows, so they reach past the loaded pages.
  const [shelfSort, setShelfSort] = useState<ShelfSort>("performance");
  const [shelfCategory, setShelfCategory] = useState<string | null>(null);
  const [shelfGenerators, setShelfGenerators] = useState<string[]>([]);
  const narrowed = !!term || !!shelfCategory || shelfGenerators.length > 0;

  // Both profiles read one creator's shelf, page by page until the server runs dry. Wait for the own handle rather
  // than requesting the public feed; the cache follows the current creator. The old wall stays while a control's
  // answer is on its way, so the page does not collapse under the pointer.
  const { data, error, isError, isFetching, isFetchingNextPage, isFetchNextPageError, isPending, isPlaceholderData, hasNextPage, fetchNextPage, refetch } = useInfiniteQuery({
    queryKey: ["/api/marketplace/prompts", "profile", term, shelfSort, shelfCategory, shelfGenerators.join(","), shelf],
    enabled: !!shelf,
    placeholderData: (previous) => previous,
    initialPageParam: 0,
    queryFn: async ({ pageParam }: { pageParam: number }): Promise<ShelfPage> => {
      if (!shelf) return { prompts: [] };
      const params = new URLSearchParams({ limit: "24", sortBy: shelfSort, creator: shelf, stats: "1", cursor: String(pageParam) });
      if (term) params.set("query", term);
      if (shelfCategory) params.set("category", shelfCategory);
      for (const m of generatorAliases(shelfGenerators, catalogue)) params.append("models", m);
      const res = await fetch(`/api/marketplace/prompts?${params.toString()}`, { headers: viewerHeaders(), credentials: "include" });
      if (!res.ok) throw new Error(await failureSentence(res, "Couldn't load prompts"));
      return res.json();
    },
    getNextPageParam: (last: ShelfPage) => {
      const next = last.nextCursor ? parseInt(last.nextCursor, 10) : undefined;
      return Number.isNaN(next) ? undefined : next;
    },
    staleTime: 60_000,
  });

  // The same shelf as Home's cards (Kev, 2026-10-27: "exactly the same as on the main page"; DEC-456), each prompt
  // once: a prompt that moves up while someone scrolls comes back on a later page.
  const cards = useMemo<FeedCard[]>(() => {
    const seen = new Set<string>();
    return (data?.pages ?? []).flatMap((page) => page.prompts ?? []).flatMap((raw: unknown) => {
      const card = toFeedCard(raw);
      if (!card || seen.has(card.id)) return [];
      seen.add(card.id);
      return [card];
    });
  }, [data]);
  // The wall asks again after each page while its end is near; that is why this changes when a page lands.
  const moreShelf = useCallback(() => { if (!isFetchingNextPage) void fetchNextPage(); }, [fetchNextPage, isFetchingNextPage]);
  // The tab's number: the profile's total, or with a term or filter what is loaded, once that is all of it.
  const lastPageIn = !!data && !isPlaceholderData && !hasNextPage;
  const releasedCount = !narrowed && stats?.totalPrompts != null ? stats.totalPrompts : lastPageIn ? cards.length : null;

  // Gallery state: the wall (components/gallery/GalleryWall), paged from the server.
  const [galleryItems, setGalleryItems] = useState<GalleryItem[]>([]);
  const [galleryLoading, setGalleryLoading] = useState(true);
  // The next offset to ask for, or null once the server ran dry.
  const [galleryNext, setGalleryNext] = useState<number | null>(null);
  const [galleryMore, setGalleryMore] = useState(false);

  /* The gallery's key: own view reads the session wallet, a foreign view
     reads the creator's public wallet from their profile. */
  const galleryWallet = handle ? creatorWallet : walletAddress;
  useEffect(() => {
    if (!galleryWallet) { setGalleryItems([]); setGalleryLoading(false); return; }
    let cancelled = false;
    const load = async () => {
      setGalleryLoading(true);
      // Local (unsynced) creations exist only for the device's own user.
      const local = handle ? [] : listCreations(galleryWallet);
      try {
        const res = await fetch(`/api/generations?userId=${encodeURIComponent(galleryWallet)}&limit=${GALLERY_PAGE}&offset=0`, { headers: viewerHeaders() });
        if (!res.ok) throw new Error("Failed");
        const gens = rowsOf(await res.json());
        const dbMapped = gens.map(toGalleryItem).filter((c): c is GalleryItem => c !== null);
        // Both URLs of a row: the browser kept the original, the row shows the preview.
        const dbUrls = serverUrls(gens);
        const localOnly = local.filter((c) => c.imageUrl && !dbUrls.has(c.imageUrl));
        const merged = [...dbMapped, ...localOnly].sort(
          (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );
        if (!cancelled) {
          setGalleryItems(merged);
          setGalleryNext(gens.length < GALLERY_PAGE ? null : gens.length);
        }
      } catch {
        if (!cancelled) { setGalleryItems(local); setGalleryNext(null); }
      } finally {
        if (!cancelled) setGalleryLoading(false);
      }
    };
    load();
    // Live refresh only for the device's own creations.
    const unsub = handle ? () => {} : subscribeCreations(galleryWallet, () => load());
    return () => { cancelled = true; unsub(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [galleryWallet, handle]);

  // The next page of the wall, asked for when its end scrolls into view.
  const loadMoreGallery = useCallback(async () => {
    if (galleryNext === null || !galleryWallet || galleryMore) return;
    setGalleryMore(true);
    try {
      const res = await fetch(`/api/generations?userId=${encodeURIComponent(galleryWallet)}&limit=${GALLERY_PAGE}&offset=${galleryNext}`, { headers: viewerHeaders() });
      if (!res.ok) throw new Error("Failed");
      const gens = rowsOf(await res.json());
      const more = gens.map(toGalleryItem).filter((c): c is GalleryItem => c !== null);
      setGalleryItems((prev) => {
        const seen = new Set(prev.map((c) => c.id));
        return [...prev, ...more.filter((c) => !seen.has(c.id))];
      });
      setGalleryNext(gens.length < GALLERY_PAGE ? null : galleryNext + gens.length);
    } catch {
      setGalleryNext(null);
    } finally {
      setGalleryMore(false);
    }
  }, [galleryNext, galleryWallet, galleryMore]);

  /* Recreate (Kev, 2026-10-15): a render from someone's listed prompt opens that
     prompt's image view on this very render, settings and references loaded; a
     render made in Quick Create goes back there as it was made. */
  const [recreate, setRecreate] = useState<ImageViewSeed | null>(null);
  const recreateFrom = (c: GalleryItem) => {
    // Someone else's open prompt: its image view, for more constellations. Own or gone: Quick Create.
    if (c.promptKind === "market" && c.promptId) {
      setRecreate({ promptId: c.promptId, imageUrl: c.imageUrl, recreateImageId: c.id });
      return;
    }
    leaveQuickCreateSeed({
      prompt: c.text ?? "", modelId: c.made?.model ?? null, aspectRatio: c.made?.ratio ?? null,
      resolution: c.made?.resolution ?? null, references: c.references ?? [],
    });
    onBack?.();
  };
  // The generator's name beside the image, from the catalogue; the id otherwise.
  const galleryNamed = useMemo(() => galleryItems.map((c) => (
    c.modelName || !c.made?.model ? c : { ...c, modelName: catalogue.find((m) => m.id === c.made?.model)?.name ?? null }
  )), [galleryItems, catalogue]);
  const galleryShown = useMemo(() => {
    const needle = term.toLowerCase();
    if (!needle) return galleryNamed;
    return galleryNamed.filter((c) => [c.promptTitle, c.text, c.modelName, c.artist?.handle].some((s) => s?.toLowerCase().includes(needle)));
  }, [galleryNamed, term]);

  /* The heart on an image (Kev, 2026-10-15): red at once, then set on the
     server; a refusal puts it back and says so. Any signed-in viewer may like
     an image they can see; the route checks that. */
  // Per image: the requests go out one after another (the server then ends on the last click), and only
  // the latest click's answer is shown; a refusal restores what the heart showed before that click.
  const likeQueue = useRef(new Map<string, Promise<unknown>>());
  const likeTurn = useRef(new Map<string, number>());
  const likeImage = async (id: string, liked: boolean) => {
    const before = galleryItems.find((c) => c.id === id)?.liked === true;
    const turn = (likeTurn.current.get(id) ?? 0) + 1;
    likeTurn.current.set(id, turn);
    setGalleryItems((prev) => prev.map((c) => (c.id === id ? { ...c, liked } : c)));
    const send = () => fetch(`/api/images/${encodeURIComponent(id)}/likes`, {
      method: "POST",
      // The read's own headers: an 18+ image the viewer may see must be likeable too.
      headers: { "Content-Type": "application/json", ...viewerHeaders() },
      body: JSON.stringify({ liked }),
    }).then(async (res) => (res.ok ? ((await res.json().catch(() => null)) as { mine?: boolean } | null) : null), () => null);
    const queued = (likeQueue.current.get(id) ?? Promise.resolve()).then(send);
    likeQueue.current.set(id, queued);
    const state = await queued;
    if (likeTurn.current.get(id) !== turn) return;
    if (typeof state?.mine !== "boolean") {
      setGalleryItems((prev) => prev.map((c) => (c.id === id ? { ...c, liked: before } : c)));
      notify("Couldn't save the like", { tone: "error" });
      return;
    }
    setGalleryItems((prev) => prev.map((c) => (c.id === id ? { ...c, liked: state.mine } : c)));
  };

  // Owner only: Remove (step-up 2FA when the user has a factor) and Publish.
  const removeFromGallery = async (id: string) => {
    if (!own || !galleryWallet) return;
    try {
      const res = await guarded(`delete-work:${id}`, (h) =>
        fetch(`/api/images/${encodeURIComponent(id)}`, { method: "DELETE", headers: { ...sessionAuthHeaders(), ...h } }),
      );
      if (res.status === 401) return;
    } catch {
      // ignore
    }
    removeCreation(galleryWallet, id);
    setGalleryItems((prev) => prev.filter((c) => c.id !== id));
  };
  const setGalleryVisibility = async (id: string, visibility: "public" | "private") => {
    const res = await fetch(`/api/images/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...sessionAuthHeaders() },
      body: JSON.stringify({ visibility }),
    }).catch(() => null);
    if (res?.ok) setGalleryItems((prev) => prev.map((c) => (c.id === id ? { ...c, visibility } : c)));
  };

  // No profile for visitors — signed-out users get a login prompt instead.
  // A FOREIGN profile is public: guests may look at an artist's page.
  if (own && !isAuthed) {
    return (
      <div className="enki" style={{ minHeight: "60vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
        <div style={{ textAlign: "center", maxWidth: 380 }}>
          <h1 className="kit-title" style={{ fontSize: 34, margin: "0 0 10px" }}>Your profile lives behind the door.</h1>
          <p style={{ fontSize: 14, lineHeight: 1.6, color: "var(--enki-ink-3)", margin: "0 0 22px" }}>
            Log in and this page fills with your prompts, your gallery and your numbers.
          </p>
          {/* The app's call to action, the windows' CTA as .ek-btn draws it, with no border since DEC-2026-11-08-21 (Kev,
              2026-10-27: the old orange "vorherige UI"); inline, as /profile renders without the shell's stylesheet. */}
          <a href="/?login=1" onClick={(e) => { e.preventDefault(); openLogin(); }} style={{
            ...CTA, display: "inline-flex", alignItems: "center", justifyContent: "center", width: "auto", padding: "0 28px",
            textDecoration: "none",
          }}>
            Log in
          </a>
        </div>
      </div>
    );
  }

  return (
    /* .enki reserves 120px for the old fixed topbar — the profile starts at 0
       and brings its own slim X-style bar instead. */
    <div className="enki" style={{ paddingTop: 0 }}>
      {/* ─── Slim top bar: back arrow, name, prompt count. It gives way while the phone header is tucked
          (ek-tuck-hide, enki-shell.css), so only its small burger stays. ─── */}
      <div className="ek-tuck-hide" style={{
        position: "sticky", top: "var(--ek-page-top, 0px)", zIndex: 60, // below the 2FA bar outside the shell
        display: "flex", alignItems: "center", gap: 14,
        height: 52, padding: "0 12px",
        background: "color-mix(in oklab, var(--enki-paper) 84%, transparent)",
        backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)",
      }}>
        <button
          onClick={() => (onBack ? onBack() : window.history.back())}
          aria-label="Back"
          title="Back"
          style={{
            width: 36, height: 36, borderRadius: "50%", border: "none", cursor: "pointer",
            background: "transparent", color: "var(--enki-ink)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = "color-mix(in oklab, var(--enki-ink) 9%, transparent)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
        >
          <ArrowLeft size={19} />
        </button>
        {me && (
          <div style={{ lineHeight: 1.25 }}>
            <div style={{ fontSize: 15, fontWeight: 700 }}>{me.handle ?? "Unnamed"}</div>
            <div style={{ fontSize: 11.5, color: "var(--enki-ink-3)" }}>
              {stats?.totalPrompts ?? me.promptCount ?? 0} {(stats?.totalPrompts ?? me.promptCount) === 1 ? "prompt" : "prompts"}
            </div>
          </div>
        )}
      </div>

      {/* ─── Profile Header Section ─── */}
      <div style={{ position: "relative" }}>
        {/* Banner — the user's own image, or the subtle pattern until they set one */}
        <div
          ref={bannerRef}
          style={{ height: "clamp(190px, 42vw, 320px)", background: "var(--enki-paper-3)", position: "relative", overflow: "hidden", cursor: me?.coverUrl ? "zoom-in" : undefined }}
          onClick={() => { if (me?.coverUrl) setLightbox({ src: me.coverUrl }); }}
        >
          {me?.coverUrl ? (
            <div style={{ position: "absolute", inset: 0, backgroundImage: `url(${me.coverUrl})`, backgroundSize: "cover", backgroundPosition: "center" }} />
          ) : (
            <div style={{
              position: "absolute",
              inset: 0,
              opacity: 0.1,
              backgroundImage: "radial-gradient(circle at 2px 2px, var(--enki-ink) 1px, transparent 0)",
              backgroundSize: "40px 40px"
            }} />
          )}
        </div>

        {/* Hero Content Container */}
        <div className="pf-wrap" style={{
          padding: "0 clamp(16px, 4vw, 40px)",
          position: "relative",
          marginTop: "clamp(-80px, -12vw, -44px)"
        }}>
          <div style={{ display: "flex", alignItems: "flex-end", gap: "clamp(14px, 3vw, 32px)", marginBottom: "clamp(20px, 4vw, 40px)", flexWrap: "wrap" }}>
            {/* The person's picture, else the seal Enki gives everyone without one (Kev, 2026-10-31: "wenn du ... noch kein
                profilbild reingepackt hast, wird dir eins von enki zugeteilt"). */}
            <button type="button" aria-label="Show the picture" disabled={!me}
              onClick={() => setLightbox({ src: me?.avatarUrl && !avatarFailed ? me.avatarUrl : null })}
              style={{
              width: "clamp(104px, 24vw, 160px)",
              height: "clamp(104px, 24vw, 160px)",
              padding: 0,
              borderRadius: 32,
              background: "#111",
              overflow: "hidden",
              boxShadow: "0 20px 40px rgba(0,0,0,0.1)",
              border: "8px solid var(--enki-paper)",
              cursor: "zoom-in",
              zIndex: 2,
              flexShrink: 0,
            }}>
              {me && (me.avatarUrl && !avatarFailed
                ? <img src={me.avatarUrl} alt="" onError={() => setAvatarFailed(true)} style={{ display: "block", width: "100%", height: "100%", objectFit: "cover" }} />
                : <Seal handle={me.handle ?? ""} />)}
            </button>

            {/* Title & Actions */}
            <div style={{ flex: 1, paddingBottom: 10, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
                {/* Shrinks on a phone and breaks a long handle, never past the edge (Kev, 2026-10-13: "skewed wenn browser zu schmal"). */}
                <h1 className="serif" style={{ fontSize: "clamp(32px, 9vw, 72px)", fontWeight: 400, margin: 0, lineHeight: 1, minWidth: 0, overflowWrap: "anywhere" }}>
                  <em>{displayName}</em>
                </h1>
                {/* Edit is the owner's; a foreign profile can be messaged, followed with its bell (not your own, which
                    the creator panel can open too; DEC-507, DEC-511), reported, and ignored (not your own either; Kev,
                    2026-10-29). */}
                {own && (
                  <div className="pf-actions" style={{ display: "flex", gap: 12, alignItems: "center" }}>
                    <button style={{ ...heroBtn, borderColor: "var(--enki-ink)" }} onClick={startEdit} disabled={!me}>
                      <Pencil size={15} /> Edit profile
                    </button>
                  </div>
                )}
                {!own && creatorId && (
                  <div className="pf-actions" style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                    {creatorId !== seedOwner && (
                      <>
                        <MessageButton to={creatorId} name={displayName} signedIn={isAuthed} style={{ ...heroBtn, height: 40, padding: "0 16px", fontSize: 13 }}>
                          <MessageCircle size={14} /> Message
                        </MessageButton>
                        <FollowButtons user={creatorId} name={displayName} signedIn={isAuthed} style={{ ...heroBtn, height: 40, padding: "0 16px", fontSize: 13 }} />
                      </>
                    )}
                    <ReportButton targetType="user" targetId={creatorId} style={{ ...heroBtn, height: 40, padding: "0 16px", fontSize: 13 }}>
                      <Flag size={14} /> Report
                    </ReportButton>
                    {creatorId !== seedOwner && (
                      <IgnoreButton user={creatorId} name={displayName} signedIn={isAuthed} style={{ ...heroBtn, height: 40, padding: "0 16px", fontSize: 13 }} />
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Bio & Stats — collapses to one column on narrow screens instead
              of squeezing the bio into a one-character waterfall. */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 300px), 1fr))", gap: "clamp(24px, 6vw, 80px)", marginBottom: "clamp(28px, 5vw, 60px)" }}>
            <div style={{ fontSize: 18, lineHeight: 1.6, color: "var(--enki-ink-3)", maxWidth: 640, fontStyle: "italic", minWidth: 0, overflowWrap: "anywhere" }}>
              {bio.slice(0, 280)}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "24px 40px" }}>
              {PROFILE_STATS.map(([label, key]) => (
                <div key={label}>
                  <div className="serif" style={{ fontSize: 32, lineHeight: 1, marginBottom: 4 }}>{stats?.[key]?.toLocaleString("en-US") ?? "—"}</div>
                  <div style={LABEL}>{label}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* ─── Tabs & Filter Section ─── It stays while the phone header tucks (Kev, 2026-10-27: the menu "verschwindet
          ... zwischen meinen eigenschaften und den images"); stuck, it then stops under the small burger
          (--pf-tabs-top, enki-shell.css; DEC-458), paper over the strip above it (pf-tabs; DEC-466). */}
      <div className="pf-tabs" style={{
        borderTop: "1px solid var(--enki-rule)",
        borderBottom: "1px solid var(--enki-rule)",
        background: "var(--enki-paper)",
        position: "sticky",
        top: "var(--pf-tabs-top, calc(52px + var(--ek-page-top, 0px)))", // below the slim top bar
        zIndex: 40
      }}>
        <div className="pf-wrap" style={{
          padding: "0 clamp(16px, 4vw, 40px)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between"
        }}>
          {/* One row that scrolls sideways on a phone instead of wrapping into two (Kev, 2026-10-13); from a tablet up it wraps (nft-filter.css). */}
          <div className="kit-noscroll pf-tab-row" style={{ display: "flex", alignItems: "center", columnGap: "clamp(14px, 3vw, 32px)", overflowX: "auto", minWidth: 0 }}>
            {TABS.map(tab => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                style={{
                  padding: "20px 0",
                  background: "none",
                  border: "none",
                  borderBottom: activeTab === tab ? "2px solid var(--enki-ink)" : "2px solid transparent",
                  color: activeTab === tab ? "var(--enki-ink)" : "var(--enki-ink-3)",
                  fontSize: 14,
                  fontWeight: activeTab === tab ? 600 : 400,
                  cursor: "pointer",
                  transition: "all 0.2s ease",
                  flexShrink: 0,
                  whiteSpace: "nowrap"
                }}
              >
                {tab}
                {tab === "Released" && releasedCount !== null && (
                  <span className="mono" style={{ fontSize: 11, marginLeft: 8, opacity: 0.6 }}>{releasedCount}</span>
                )}
                {tab === "Gallery" && galleryShown.length > 0 && (
                  <span className="mono" style={{ fontSize: 11, marginLeft: 8, opacity: 0.6 }}>{galleryShown.length}</span>
                )}
              </button>
            ))}

            {/* The owner's alone: nobody's unmoderated wallet pictures on someone else's screen (DEC-2026-11-03-57). */}
            {own && <NftFilter key={nftScope} viewer={seedOwner} checked={checkedNfts} onChecked={setCheckedNfts} />}
          </div>

          <div className="pf-actions" style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0, marginLeft: 16 }}>
            {searchOpen && (
              <input autoFocus type="text" enterKeyHint="search" value={search} aria-label="Search this profile" placeholder="Search this profile"
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); closeSearch(); } }}
                className="st-input" style={{ width: "clamp(120px, 24vw, 260px)", minHeight: 0, padding: "7px 12px", fontSize: 13 }} />
            )}
            <button type="button" aria-label={searchOpen ? "Close the search" : "Search this profile"} title={searchOpen ? "Close the search" : "Search this profile"}
              onClick={() => {
                if (searchOpen) return closeSearch();
                setSearchOpen(true);
                if (activeTab !== "Released" && activeTab !== "Gallery") setActiveTab("Released");
              }}
              style={{ width: 36, height: 36, borderRadius: "50%", border: "none", background: "transparent", color: "var(--enki-ink)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
              {searchOpen ? <X size={18} aria-hidden /> : <Search size={18} aria-hidden />}
            </button>
          </div>
        </div>
      </div>

      {/* ─── Content Section ─── */}
      <div ref={contentRef} className="pf-wrap" style={{ padding: "clamp(16px, 4vw, 40px)" }}>
        {showNfts ? (
          <NftWall nfts={checkedNfts} />
        ) : activeTab === "Released" ? (
          <>
            {/* In the page's flow, so it scrolls away under the tabs (feed.css overrides the filter bar's fixed place). */}
            <div className="pf-controls kit-focus" data-busy={isPlaceholderData || undefined}>
              <Segmented slide role="radiogroup" ariaLabel="Sort these prompts" value={shelfSort} onChange={setShelfSort} options={[...SHELF_SORTS]} />
              <EnkiFilters active={shelfCategory ? [shelfCategory] : []} onPick={setShelfCategory} search={false}
                generators={generators} generatorFilter={shelfGenerators} onGeneratorFilter={setShelfGenerators} />
            </div>
            {isError && cards.length === 0 && !isFetching ? (
              <section className="feed-note" role="alert">
                <h2 className="kit-title">Couldn&apos;t load these prompts.</h2>
                <p>{error?.message}</p>
                <button type="button" className="ek-btn kit-hit" onClick={() => void refetch()}>Try again</button>
              </section>
            ) : (
              <PromptWall cards={cards} numbers more={hasNextPage && !isError} onMore={moreShelf}
                loading={cards.length > 0 ? isFetchingNextPage : !!shelf && (isFetching || isPending)}
                onEdit={own ? (c) => router.push(`/editor?id=${encodeURIComponent(c.id)}`) : undefined}
                note={
                  <div style={{ padding: "40px 0", textAlign: "center" }}>
                    <div className="kit-title" style={{ fontSize: 24, overflowWrap: "anywhere" }}>
                      {term ? `No prompt here matches "${term}"${shelfCategory || shelfGenerators.length > 0 ? " with these filters" : ""}.`
                        : narrowed ? "No prompt here matches these filters."
                        : "Nothing to show in Released yet."}
                    </div>
                  </div>
                } />
            )}
            {/* A later page failed: what is loaded stays, and only this asks again, never the wall by itself. */}
            {isError && cards.length > 0 && !isFetching && (
              <p className="feed-wall-note" role="alert">
                {error?.message} <button type="button" className="ek-btn kit-hit" onClick={() => void (isFetchNextPageError ? fetchNextPage() : refetch())}>Try again</button>
              </p>
            )}
          </>
        ) : activeTab === "Gallery" ? (
          <GalleryWall items={galleryShown} loading={galleryLoading} hasMore={galleryNext !== null} loadingMore={galleryMore}
            onMore={() => void loadMoreGallery()}
            onRemove={own ? removeFromGallery : undefined} onVisibility={own ? setGalleryVisibility : undefined}
            onRecreate={own ? recreateFrom : undefined}
            onLike={isAuthed ? likeImage : undefined}
            onOpenPrompt={(c) => { if (c.promptId) setRecreate({ promptId: c.promptId, imageUrl: c.imageUrl }); }}
            emptyText={term ? `No image here matches "${term}".` : own ? undefined : "Nothing public here yet."} />
        ) : activeTab === "Library" ? (
          library === null ? (
            <div style={{ padding: "60px 0", textAlign: "center", color: "var(--enki-ink-3)" }}>Loading…</div>
          ) : libraryError ? (
            <div style={{ padding: "80px 0", textAlign: "center" }}>
              <div className="kit-title" style={{ fontSize: 24 }}>Couldn't load your library.</div>
              <p style={{ fontSize: 14, color: "var(--enki-ink-3)", maxWidth: 440, margin: "8px auto 0" }}>{libraryError}</p>
              <button type="button" className="ek-btn" style={{ marginTop: 16, minHeight: 40 }} onClick={() => void loadLibrary()}>Try again</button>
            </div>
          ) : library.length === 0 ? (
            <div style={{ padding: "80px 0", textAlign: "center" }}>
              <div className="kit-title" style={{ fontSize: 24 }}>Your library is empty.</div>
              <p style={{ fontSize: 14, color: "var(--enki-ink-3)", maxWidth: 440, margin: "8px auto 0" }}>
                Only you see this tab. Saved prompt text opens in the editor. Older workflows stay in your library.
              </p>
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 12, padding: "18px 0" }}>
              {library.map((it) => { const seed = librarySeed(it); return (
                <div key={it.id} style={{ border: "1px solid var(--enki-rule)", borderRadius: 12, background: "var(--enki-paper-2)", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                    <span style={{ fontWeight: 700, fontSize: 14, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>{it.name}</span>
                    <span style={LABEL}>{it.kind}</span>
                  </div>
                  <div style={{ fontSize: 12, color: "var(--enki-ink-3)", overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>{seed?.promptText ?? "This saved workflow can’t be opened in the new editor yet."}</div>
                  <div style={{ display: "flex", gap: 8, marginTop: 2 }}>
                    {seed && <button type="button" className="ek-btn" style={{ minHeight: 32, flex: 1 }} onClick={() => {
                      if (stashEditorSeed(seed, seedOwner)) router.push("/editor");
                      else notify("Couldn't open this prompt. Try again.", { tone: "error" });
                    }}>Open in editor</button>}
                    <button type="button" style={{ minHeight: 32, padding: "0 10px", border: "1px solid var(--enki-rule)", borderRadius: 8, background: "transparent", color: "var(--enki-ink-3)", cursor: "pointer" }} title="Delete from library" onClick={() => setLibraryDelete(it.id)}>Delete</button>
                  </div>
                </div>
              ); })}
            </div>
          )
        ) : activeTab === "Bookmarks" ? (
          /* The owner's bookmarks, here instead of a menu entry (Kev, 2026-10-13): the categories, then a category as the feed's wall. */
          <BookmarksPanel />
        ) : activeTab === "Likes" ? (
          /* The liked prompts exactly as Home shows them (Kev, 2026-10-13). */
          <PromptWall ids={(myLikes ?? []).map((l) => l.promptId)} loading={myLikes === null}
            note={
              <div style={{ padding: "80px 0", textAlign: "center" }}>
                <div className="kit-title" style={{ fontSize: 24 }}>Nothing liked yet.</div>
                <p style={{ fontSize: 14, color: "var(--enki-ink-3)", maxWidth: 420, margin: "8px auto 0" }}>
                  Only you see this tab. Tap the heart on any image and it lands here.
                </p>
              </div>
            } />
        ) : activeTab === "History" ? (
          <div style={{ padding: "80px 0", textAlign: "center" }}>
            <div className="kit-title" style={{ fontSize: 24 }}>
              Your history is private.
            </div>
            <p style={{ fontSize: 14, color: "var(--enki-ink-3)", marginTop: 8, maxWidth: 420, margin: "8px auto 0" }}>
              Only you see this tab. It&apos;ll hold what you&apos;ve unlocked and generated over time.
            </p>
          </div>
        ) : (
          <div style={{ padding: "80px 0", textAlign: "center" }}>
            <div className="kit-title" style={{ fontSize: 24 }}>
              {`Nothing to show in ${activeTab} yet.`}
            </div>
          </div>
        )}
      </div>

      {/* ─── Modals ─── */}
      {/* On the body, over the menu too: the panel's own layer stops at the sidebar (Kev, 2026-11-02: "the left side bar
          must be ausgeblendet"). As large as the window holds, centred, the rest of the app out of sight. */}
      {lightbox && createPortal(
        <div
          role="dialog" aria-modal="true" aria-label="Picture"
          onClick={() => setLightbox(null)}
          style={{
            position: "fixed", inset: 0, zIndex: 500,
            background: "#000", cursor: "zoom-out",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}
        >
          {lightbox.src ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img src={lightbox.src} alt="" style={{ width: "94vw", height: "94vh", objectFit: "contain" }} />
          ) : (
            <div style={{ width: "min(88vw, 88vh)", height: "min(88vw, 88vh)", borderRadius: 32, overflow: "hidden" }}>
              <Seal handle={me?.handle ?? ""} />
            </div>
          )}
        </div>,
        document.body,
      )}
      {editOpen && me && (
        <EditProfileModal
          me={me}
          pageBannerW={pageBannerW}
          pageBannerH={pageBannerH}
          onClose={() => setEditOpen(false)}
          onSaved={(next) => {
            setMe({ ...next, promptCount: me?.promptCount ?? 0 });
            setGateProfile({ handle: next.handle, bio: next.bio, avatarUrl: next.avatarUrl, coverUrl: next.coverUrl });
            setSidebarHandle(next.handle);
            setEditOpen(false);
          }}
        />
      )}
      {recreate && (
        <EnkiDetailPanel key={`${recreate.promptId}:${recreate.recreateImageId ?? ""}`} seed={recreate} onClose={() => setRecreate(null)} />
      )}
      {libraryDelete && (
        <ConfirmDialog title="Delete this prompt from your library?" text="Only your saved copy goes; a released prompt stays released."
          onConfirm={() => { const id = libraryDelete; setLibraryDelete(null); void deleteLibraryItem(id); }} onCancel={() => setLibraryDelete(null)} />
      )}
    </div>
  );
}
