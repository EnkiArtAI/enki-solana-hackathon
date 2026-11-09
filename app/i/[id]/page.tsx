import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { publicImage } from "@/lib/share/public-image";
import { publicReferences } from "@/lib/public-references";

/**
 * The share page of one public image (SHR, Kev 2026-10-17): a pasted
 * /i/<id> link unfurls on X, WhatsApp, Discord or Telegram as the image
 * with "Made with Enki". The proxy lets link-preview bots read it without
 * the team cookie; people see it once the beta gate is off. Only an image
 * its owner made public (lib/share/public-image.ts); anything else is the
 * brand card and a 404.
 */
const DESCRIPTION = "Made with Enki: artists' prompts, your images.";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const img = await publicImage(getSupabaseServerClient(), id).catch(() => null);
  if (!img) return { title: "Enki Art", description: DESCRIPTION, openGraph: { images: ["/og-image.jpg"] } };
  const title = `${img.prompt?.title ?? "An image"}${img.owner ? ` by @${img.owner}` : ""} · Enki Art`;
  const og = `/api/og/image/${encodeURIComponent(img.id)}`;
  return {
    title,
    description: DESCRIPTION,
    openGraph: { title, description: DESCRIPTION, type: "website", url: `/i/${encodeURIComponent(img.id)}`, images: [{ url: og, width: 1200, height: 630, alt: title }] },
    twitter: { card: "summary_large_image", title, description: DESCRIPTION, images: [og] },
  };
}

export default async function SharedImagePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = getSupabaseServerClient();
  const img = await publicImage(supabase, id).catch(() => null);
  if (!img) notFound();
  // The references its owner shows with it (DEC-514), each a link to the picture; a failed read shows none.
  const refs = ((await publicReferences(supabase, [img.id]).catch(() => null))?.get(img.id) ?? []).filter((u) => u.startsWith("https://"));
  return (
    <main style={{ minHeight: "100dvh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, padding: "24px 16px", background: "#0b0918", color: "#f3f0ff", fontFamily: "system-ui, sans-serif" }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={img.shown} alt={img.prompt?.title ?? "An image made with Enki"} width={img.width ?? undefined} height={img.height ?? undefined}
        style={{ maxWidth: "min(100%, 960px)", maxHeight: "78dvh", width: "auto", height: "auto", borderRadius: 12 }} />
      <p style={{ margin: 0, fontSize: 14, opacity: 0.75 }}>
        {img.prompt ? `${img.prompt.title} · ` : ""}{img.owner ? `by @${img.owner} · ` : ""}Made with Enki
      </p>
      {refs.length > 0 && (
        <div role="group" aria-label="Reference images" style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 8 }}>
          {refs.map((src, i) => (
            <a key={`${i}:${src}`} href={src} target="_blank" rel="noopener noreferrer" title={`Reference image ${i + 1}`}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={src} alt={`Reference image ${i + 1}`} width={48} height={48} loading="lazy"
                style={{ display: "block", objectFit: "cover", borderRadius: 8 }} />
            </a>
          ))}
        </div>
      )}
      <a href={img.prompt ? `/generator/${encodeURIComponent(img.prompt.id)}` : "/"}
        style={{ padding: "10px 18px", borderRadius: 999, background: "#9d7bff", color: "#0b0918", fontWeight: 600, textDecoration: "none" }}>
        {img.prompt ? "Make one with this prompt" : "Discover Enki"}
      </a>
    </main>
  );
}
