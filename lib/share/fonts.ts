/**
 * The twelve fonts of a share card, one weight each, Latin only, from
 * public/fonts/share (licences beside them). They load through the FontFace API
 * when Share opens: next/font would attach all twelve to every route.
 */
export const SHARE_FONTS = [
  ["Inter", "inter-latin-500-normal", 500],
  ["Playfair Display", "playfair-display-latin-500-normal", 500],
  ["Space Grotesk", "space-grotesk-latin-500-normal", 500],
  ["Bebas Neue", "bebas-neue-latin-400-normal", 400],
  ["Oswald", "oswald-latin-500-normal", 500],
  ["Lora", "lora-latin-500-normal", 500],
  ["Anton", "anton-latin-400-normal", 400],
  ["Archivo Black", "archivo-black-latin-400-normal", 400],
  ["Caveat", "caveat-latin-500-normal", 500],
  ["Pacifico", "pacifico-latin-400-normal", 400],
  ["Permanent Marker", "permanent-marker-latin-400-normal", 400],
  ["DM Mono", "dm-mono-latin-500-normal", 500],
] as const;

export const fontStack = (name = "Inter") => `'${name}',sans-serif`;
export const fontWeight = (name = "Inter") => SHARE_FONTS.find((f) => f[0] === name)?.[2] ?? 500;

const loading = new Map<string, Promise<unknown>>();
let arrived = 0;

/** How many faces have arrived: text measured before one did was measured in the fallback. */
export const fontsArrived = () => arrived;

/** Resolves when each is in, or has failed: a card then draws in the fallback, on the page and in the export alike. */
export async function loadFonts(names: readonly string[]): Promise<void> {
  await Promise.all(names.map((name) => {
    const known = loading.get(name);
    if (known) return known;
    const row = SHARE_FONTS.find((f) => f[0] === name);
    if (!row) return null;
    const face = new FontFace(name, `url(/fonts/share/${row[1]}.woff2) format("woff2")`, { weight: String(row[2]) });
    const load = face.load().then(() => {
      document.fonts.add(face);
      arrived++;
    }).catch(() => { loading.delete(name); });
    loading.set(name, load);
    return load;
  }));
}

let ruler: CanvasRenderingContext2D | null = null;

/** Text width by a canvas at a fixed size, scaled: a card's numbers stay linear in its size (see text-layout). */
export function measurer(font?: string) {
  const css = `${fontWeight(font)} 100px ${fontStack(font)}`;
  return (text: string, size: number) => {
    ruler ??= document.createElement("canvas").getContext("2d")!;
    ruler.font = css;
    ruler.textRendering = "geometricPrecision";
    return (ruler.measureText(text).width * size) / 100;
  };
}
