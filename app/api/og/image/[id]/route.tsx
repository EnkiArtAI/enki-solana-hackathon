import { ImageResponse } from "next/og";
import { getSupabaseServerClient } from "@/lib/supabaseServer";
import { fitInto, publicImage, type PublicImage } from "@/lib/share/public-image";

/**
 * The social card of one public image (SHR, Kev 2026-10-17): what X,
 * WhatsApp, Discord or Telegram show for a pasted /i/<id> link. The image
 * whole on the brand ground, "Made with Enki" beneath. Public like
 * /api/og/[id]: a crawler has no session. It draws the original, as the
 * prompt card does: the card renderer reads PNG and JPEG, not the WebP
 * previews. Anything not public is the brand card.
 */
export const runtime = "nodejs";

const W = 1200;
const H = 630;
const FOOT = 96;

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let img: PublicImage | null = null;
  try {
    img = await publicImage(getSupabaseServerClient(), id);
  } catch (e) {
    console.warn("[og] image lookup failed, serving brand card:", e instanceof Error ? e.message : e);
  }
  const line = img ? `${img.prompt ? `${img.prompt.title} · ` : ""}${img.owner ? `by @${img.owner}` : "Made with Enki"}` : "Artists' prompts, your images";
  // Sized explicitly: the renderer throws on an image it could not load and
  // has no size for, so a dead link would break the card (review 2026-10-17).
  const box = fitInto(img?.width ?? null, img?.height ?? null, W - 80, H - FOOT - 40);

  return new ImageResponse(
    (
      <div style={{ width: W, height: H, display: "flex", flexDirection: "column", background: "#0b0918", color: "#f3f0ff", fontFamily: "sans-serif" }}>
        <div style={{ width: W, height: H - FOOT, display: "flex", alignItems: "center", justifyContent: "center" }}>
          {img ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={img.url} alt="" width={box.w} height={box.h} style={{ width: box.w, height: box.h, objectFit: "contain" }} />
          ) : (
            <div style={{ fontSize: 44, color: "#9d7bff" }}>Enki Art</div>
          )}
        </div>
        <div style={{ height: FOOT, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 40px", borderTop: "1px solid #2a2448" }}>
          {/* ONE text child: Satori refuses multi-child nodes without display:flex. */}
          <div style={{ fontSize: 28, fontWeight: 700, maxWidth: 820, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>{line}</div>
          <div style={{ fontSize: 24, fontWeight: 700, color: "#9d7bff", letterSpacing: 2 }}>MADE WITH ENKI</div>
        </div>
      </div>
    ),
    {
      width: W,
      height: H,
      // An image made private again leaves the shared cache within the hour.
      headers: { "Cache-Control": "public, max-age=300, s-maxage=3600" },
    },
  );
}
