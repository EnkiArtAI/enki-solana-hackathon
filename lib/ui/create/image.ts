/**
 * Create > Image (Kev, 2026-10-30: "create > image muss auch die gleiche view haben wie bei sume bei den images sodass du
 * images generieren kannst mit der bar unten während die zentriert auftauchen., wobei sich die images vom
 * gallery-verhalten her genauso anzeigen lassen wie bei profil"): what the wall above the bar shows and what Recreate
 * puts back into the bar. The jobs are the blank composer's render queue (useImageViewModel), the rows the viewer's own
 * GET /api/generations, the profile's source.
 */
import type { Shot } from "@/components/image-view/useImageViewModel";
import { recordOf, type GenerationRow } from "@/lib/ui/image-view/history";
import type { ImageViewSeed } from "@/lib/ui/image-view/seed";
import type { ImageSetup } from "@/lib/ui/image-view/setups";
import { boxRatio, parseRatio } from "@/lib/ui/kit/ratio";
import type { Job } from "@/lib/ui/kit/render-queue";

type ImageJob = Job<ImageSetup>;
/** A row as the route sends it to its owner: what the prompt was ("own" written here, "market" someone's listed one), and
 *  whether it is 18+ (it then has no share page, app/api/generations). */
export type OwnRow = GenerationRow & { prompt_kind?: "own" | "market" | null; isAdult?: boolean };

/**
 * A job's look on the wall (Kev, 2026-10-30: "the grey loading icon when it's not yet in the api queue ... the loading
 * icon when it is being generated ... red if it failed"): waiting in line, its request not sent; running; failed; ready.
 */
export type TileState = "waiting" | "running" | "failed" | "ready";
export const tileState = (j: Pick<ImageJob, "status" | "sent">): TileState =>
  j.status === "rendering" ? (j.sent ? "running" : "waiting") : j.status;

/** One picture on the wall: a job of this visit not recorded yet, or a recorded render (with its job, made this visit). */
export type WallItem =
  | { key: string; kind: "job"; job: ImageJob; src?: string; ratio: number }
  | { key: string; kind: "row"; row: OwnRow; job?: ImageJob; src: string; ratio: number | null };

/**
 * The wall, newest first: this visit's jobs where the queue put them (a new one first), each as its recorded row once
 * the row is in, then the older rows. No upload (it was not generated) and no row without a picture; each image once.
 * A job's ratio is its tile's (boxRatio, as JobTile draws it); a row's the ratio it asked for until the picture says its
 * own (null: unknown). A render deleted here (`gone`, by its row's id and its job's) leaves the wall at once, its job
 * with it, so it does not come back as the job it was while the rows are read again.
 */
export function wallItems(jobs: ImageJob[], rows: OwnRow[], gone: ReadonlySet<string> = new Set()): WallItem[] {
  const shown = new Set<string>();
  const out: WallItem[] = [];
  const add = (row: OwnRow, job?: ImageJob) => {
    const src = row.thumbnail_url ?? row.image_urls[0] ?? row.image_url;
    if (row.isUploaded || !src || shown.has(row.id) || gone.has(row.id)) return;
    shown.add(row.id);
    out.push({ key: `row:${row.id}`, kind: "row", row, job, src, ratio: parseRatio(row.settings?.aspectRatio) });
  };
  for (const job of jobs) {
    if (gone.has(job.id)) continue;
    const row = job.imageUrl ? (recordOf(rows, job.imageUrl) as OwnRow | undefined) : undefined;
    if (row) add(row, job);
    else {
      // The size the free route measured, once in; until then the tile's.
      const size = job.size && job.size.h > 0 ? job.size.w / job.size.h : null;
      out.push({ key: `job:${job.id}`, kind: "job", job, src: job.imageUrl, ratio: size ?? boxRatio(job.setup.aspectRatio) });
    }
  }
  for (const row of rows) add(row);
  return out;
}

/**
 * The rows read (useOwnRenders' pages) without a render deleted here: the wall opened again before the next read draws
 * from them and would show it again (review 2026-10-30: it came back after Video and back, and a second Delete failed).
 */
export function withoutRow<D extends { pages: Array<{ generations: Array<{ id: string }> }> }>(data: D | undefined, id: string): D | undefined {
  return data && { ...data, pages: data.pages.map((p) => ({ ...p, generations: p.generations.filter((g) => g.id !== id) })) };
}

/** The images one press made: one batch runs the same setup object n times (useImageViewModel start). */
export const batchSize = (jobs: ImageJob[], job: ImageJob) => Math.max(1, jobs.filter((j) => j.setup === job.setup).length);

/**
 * What Recreate does (Kev, 2026-10-30: "the "recreate" button ... that then automatically puts all the settings and
 * reference images into the bottom generate bar"). A job of this visit: its whole setup (the words, generator, ratio,
 * size, quality, photos) and the batch's count. A recorded render: the bar back to its defaults first (reset: a row
 * keeps no quality and no count), then what the row says it was made with, its words and one image. A row from before
 * the route sent its settings (settings null) holds only its words, so its generator, ratio, size and references stay
 * the defaults, none of them the last image's (review 2026-10-30: they stayed and were charged for). Someone's listed
 * prompt opens that prompt's image view on this render instead, as the profile's Recreate does (its words are not the
 * viewer's to put into a bar). Null: nothing to recreate (a job still rendering).
 */
export type RecreatePlan = { open: ImageViewSeed } | { shot: Shot; text: string | null; count: number; reset: boolean; unrecorded: boolean };
/** What a row without settings loads: no generator, ratio or size (the defaults stay), no references. */
const NOTHING_RECORDED = { modelId: null, aspectRatio: null, resolution: null, boost: false, references: [] };
export function recreatePlan(item: WallItem, jobs: ImageJob[]): RecreatePlan | null {
  const job = item.job;
  if (job) {
    if (job.status === "rendering") return null;
    return { shot: { key: `job:${job.id}`, kind: "job", job, ratio: job.setup.aspectRatio }, text: null, count: batchSize(jobs, job), reset: false, unrecorded: false };
  }
  if (item.kind !== "row") return null;
  const { row } = item;
  if (row.prompt_kind === "market" && row.prompt_id) return { open: { promptId: row.prompt_id, imageUrl: item.src, recreateImageId: row.id } };
  const record = row.settings ? row : { ...row, settings: NOTHING_RECORDED };
  return { shot: { key: `history:${row.id}`, kind: "history", ratio: null, record }, text: row.prompt_text ?? "", count: 1, reset: true, unrecorded: !row.settings };
}

/**
 * A finished picture as the viewer shows it (FullscreenViewer with the image view's ViewerPanel), as the profile's wall
 * opens one (Kev, 2026-10-30: "vom gallery-verhalten her genauso ... wie bei profil"): the full image, its job of this
 * visit, its row. Null while it renders or after it failed.
 */
export function wallShot(item: WallItem): Shot | null {
  if (item.kind === "job") return item.src ? { key: item.key, kind: "job", job: item.job, src: item.src, ratio: item.job.setup.aspectRatio } : null;
  const { row } = item;
  const src = row.image_urls[0] ?? row.image_url ?? item.src;
  return {
    key: item.key, kind: item.job ? "job" : "history", job: item.job, record: row, src, thumb: item.src, original: row.image_url ?? src,
    ratio: row.settings?.aspectRatio ?? null, createdAt: row.created_at,
  };
}
/** One picture across its recording: a job of this visit keeps its name once its row is in. */
export const shotId = (s: Pick<Shot, "key" | "job">) => (s.job ? `job:${s.job.id}` : s.key);

/** A prompt made from the bar's words is named by its first six until the editor gives it a title (Quick Create's rule). */
export const promptName = (text: string) => text.trim().split(/\s+/).slice(0, 6).join(" ").slice(0, 60);
