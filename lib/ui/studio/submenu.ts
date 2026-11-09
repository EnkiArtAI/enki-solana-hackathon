import { MAX_SUBMENU_PROJECTS } from "@/lib/studio/types";

/**
 * The rows under the menu's Studio item (Kev, 2026-10-30: "wenn ich studio clicke, so klappt sich links darunter
 * dynamisch ein untermenü meiner projekte auf FALLS ich welche hab ... wenn ich kein projekt hab, steht darunter "Create
 * project""): the projects first, then one last row: "All projects · N" when some do not show, else "Create project"
 * while the account is under its cap. `room` is how many rows fit (EnkiSidebar measures it; at least one), so the
 * account row is never pushed off the column.
 */
export type SubRow = { kind: "project"; id: string; name: string } | { kind: "all"; count: number } | { kind: "create" };

export function submenuRows(projects: ReadonlyArray<{ id: string; name: string }>, room: number, atCap: boolean): SubRow[] {
  const fits = Math.max(1, room);
  const rows: SubRow[] = projects.map((p) => ({ kind: "project", id: p.id, name: p.name }));
  if (projects.length <= MAX_SUBMENU_PROJECTS && projects.length + (atCap ? 0 : 1) <= fits) {
    return atCap ? rows : [...rows, { kind: "create" }];
  }
  return [...rows.slice(0, Math.min(MAX_SUBMENU_PROJECTS, fits - 1)), { kind: "all", count: projects.length }];
}
