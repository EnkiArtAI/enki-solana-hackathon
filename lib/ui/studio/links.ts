import { toolLink, type Tool } from "@/lib/ui/feed/world";
import { panelOf, uuidParam } from "@/lib/ui/kit/shell-nav";

/**
 * Create in a project's context: /home?create=image|video&project=<id>[&content=<id>][&sheet=<promptId>]. The same
 * project and content params as a Studio page's (?panel=studio&project=&content=), each meaning the one the address
 * names. A panel over Create names its own place, so Create under it works in none.
 */
export type CreateAt = { project: string; content: string | null; sheet: string | null };

/** The project, content piece and character sheet Create works in, or none. */
export function createAt(search: { get(name: string): string | null }): CreateAt | null {
  const project = uuidParam(search.get("project"));
  if (!project || panelOf(search)) return null;
  return { project, content: uuidParam(search.get("content")), sheet: uuidParam(search.get("sheet")) };
}

/** Create on `tool`, in the project and content piece `at` names (Image | Video | Remix keep them). */
export function createLink(tool: Tool, at?: { project: string; content?: string | null } | null): string {
  if (!at) return toolLink(tool);
  return `${toolLink(tool)}&project=${encodeURIComponent(at.project)}${at.content ? `&content=${encodeURIComponent(at.content)}` : ""}`;
}

/** Create > Image on a character sheet for a project (the sheet picker's "Use this sheet →"). The sheet's image view
 *  is named too (?prompt=, as EnkiDetailPanel writes it), so the view adds no entry of its own and its Back is one step
 *  back, to the page the sheet was picked on. */
export const sheetLink = (project: string, sheet: string) =>
  `${createLink("image", { project })}&sheet=${encodeURIComponent(sheet)}&prompt=${encodeURIComponent(sheet)}`;

/** `href` without its sheet and the sheet's view: where that view's Back lands when no page of this visit lies before. */
export function withoutSheet(href: string): string {
  const url = new URL(href);
  for (const key of ["sheet", "prompt"]) url.searchParams.delete(key);
  return url.pathname + url.search + url.hash;
}
