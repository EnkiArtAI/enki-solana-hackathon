import { MAX_FILE_AT_ONCE } from "@/lib/studio/types";
import { recordOf, type GenerationRow } from "@/lib/ui/image-view/history";
import type { Job } from "@/lib/ui/kit/render-queue";

/**
 * Renders filed into the content piece they were started in (Kev, 2026-10-30: "subfolders for every content piece i
 * create"), from Create > Image. A job belongs to the piece Create worked in when the job first showed; the jobs already
 * there when Create opened belong to none (they were started elsewhere). The piece is kept per job, so a panel opened
 * over Create, which drops the piece from the address, files on.
 */
export type StartedIn = Map<string, string | null>;

/** Notes the piece each new job was started in (`content`, null outside one). The first call notes every job as none. */
export function noteJobs(startedIn: StartedIn | null, jobs: ReadonlyArray<Pick<Job<unknown>, "id">>, content: string | null): StartedIn {
  if (!startedIn) return new Map(jobs.map((j) => [j.id, null]));
  for (const j of jobs) if (!startedIn.has(j.id)) startedIn.set(j.id, content);
  return startedIn;
}

/** The key a filing is known by: one render in one piece. */
export const fileKey = (content: string, imageId: string) => `${content}:${imageId}`;

/**
 * What to file now: each finished job of a piece whose recorded row is in (a render's id is its row's) and that is not
 * filed or on its way, in batches of MAX_FILE_AT_ONCE per piece.
 */
export function toFile(
  jobs: ReadonlyArray<Pick<Job<unknown>, "id" | "status" | "imageUrl">>, rows: GenerationRow[], startedIn: StartedIn, filed: ReadonlySet<string>,
): Array<{ content: string; imageIds: string[] }> {
  const by = new Map<string, string[]>();
  for (const job of jobs) {
    const content = startedIn.get(job.id);
    if (!content || job.status !== "ready" || !job.imageUrl) continue;
    const row = recordOf(rows, job.imageUrl);
    if (!row || filed.has(fileKey(content, row.id))) continue;
    const ids = by.get(content) ?? [];
    if (!ids.includes(row.id)) ids.push(row.id);
    by.set(content, ids);
  }
  return [...by].flatMap(([content, ids]) =>
    Array.from({ length: Math.ceil(ids.length / MAX_FILE_AT_ONCE) }, (_, i) => ({ content, imageIds: ids.slice(i * MAX_FILE_AT_ONCE, (i + 1) * MAX_FILE_AT_ONCE) })));
}
