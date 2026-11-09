import {
  BAD_LINK, BAD_PALETTE, CONTENT_NAME_TAKEN, MAX_PALETTE, NAME_NEEDED, PROJECT_NAME_TAKEN, STUDIO_TEXT, TOO_LONG,
} from "@/lib/studio/types";

/**
 * The rules app/api/studio/** holds a project's and a content piece's fields to (lib/studio/types), mirrored so the
 * dialogs say what is wrong under the field before anything is sent. The server's word stands either way.
 */
export type Details = { name: string; description: string; link: string };
export type DetailField = keyof Details;

/** A bare domain ("enki.art") gets https://; anything else stays as typed, for the server to judge. */
export function withScheme(link: string): string {
  const t = link.trim();
  if (!t || /^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return t;
  return /^[^\s/:]+\.[a-z]{2,}(?:[/?#:]\S*)?$/i.test(t) ? `https://${t}` : t;
}

/** The first field the server would refuse, with its sentence; null when it would take them. */
export function detailsProblem(v: Details): { field: DetailField; message: string } | null {
  const name = v.name.trim();
  if (!name) return { field: "name", message: NAME_NEEDED };
  if (name.length > STUDIO_TEXT.name) return { field: "name", message: TOO_LONG.name };
  if (v.description.trim().length > STUDIO_TEXT.description) return { field: "description", message: TOO_LONG.description };
  const link = withScheme(v.link);
  if (link.length > STUDIO_TEXT.link) return { field: "link", message: TOO_LONG.link };
  if (link && !/^https?:\/\/\S+$/i.test(link)) return { field: "link", message: BAD_LINK };
  return null;
}

/** As the API takes them: trimmed, an empty optional one null. */
export function detailsInput(v: Details): { name: string; description: string | null; link: string | null } {
  return { name: v.name.trim(), description: v.description.trim() || null, link: withScheme(v.link) || null };
}

/** The field a server's sentence is about, so it shows under that field (else a toast says it). */
export function fieldOf(message: string): DetailField | null {
  if ([NAME_NEEDED, TOO_LONG.name, PROJECT_NAME_TAKEN, CONTENT_NAME_TAKEN].includes(message)) return "name";
  if (message === TOO_LONG.description) return "description";
  if (message === BAD_LINK || message === TOO_LONG.link) return "link";
  return null;
}

/** "52 / 60" once `value` reaches `from` characters, else nothing. */
export const counter = (value: string, max: number, from: number) => (value.length >= from ? `${value.length} / ${max}` : null);

/** A palette as the server keeps it: lower-case #rrggbb, at most MAX_PALETTE; BAD_PALETTE otherwise. */
export function paletteProblem(palette: readonly string[]): string | null {
  return palette.length > MAX_PALETTE || palette.some((c) => !/^#[0-9a-f]{6}$/.test(c.toLowerCase())) ? BAD_PALETTE : null;
}

/** The link's face on a chip: its host, without www. */
export function hostOf(link: string): string {
  try { return new URL(link).hostname.replace(/^www\./, ""); } catch { return link; }
}
