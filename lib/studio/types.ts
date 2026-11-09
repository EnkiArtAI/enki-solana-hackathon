/**
 * Studio's shared contract (Kev, 2026-10-30: "At the end i want basically within studio a collection of projects
 * containing different content pieces that all access the same reference images, characters, styles and master
 * prompts ... styles and master prompts must also be set up there, so that the brand ID stays the same"): the rows of
 * SQL 53 (migrations/2026-10-30-studio.sql), what app/api/studio/** answers and takes, the caps and the sentences.
 * Read by the routes, the migration's test and the UI alike, so it holds types and constants only: no imports, nothing
 * that runs. Additive changes only, each said in the build report.
 */

/* ── Caps. SQL 53's triggers hold the same numbers (its test reads them from here). A project is a brand, so the caps
   are small, as Kev put the saved references at 50 (2026-10-30: "500 refs pro konto sind schon ein bisschen viel ...
   eher bei 50"). At a cap a write is refused with its sentence below; nothing older is ever dropped. ── */

/** Projects per account. */
export const MAX_PROJECTS = 10;
/** Assets (pictures) per project. */
export const MAX_PROJECT_ASSETS = 20;
/** Assets per account, across its projects: the storage an account can fill (each at most 4 MB, SQL 51's bucket). */
export const MAX_STUDIO_ASSETS = 50;
/** Characters per project. */
export const MAX_CHARACTERS = 12;
/** Styles per project. */
export const MAX_STYLES = 6;
/** Master prompts per project. */
export const MAX_MASTER_PROMPTS = 6;
/** Content pieces per project. */
export const MAX_CONTENTS = 50;
/** Renders filed in one content piece. */
export const MAX_CONTENT_IMAGES = 200;
/** Renders filed in one request: one press of Generate makes at most 8 (useImageViewModel COUNT_MAX). */
export const MAX_FILE_AT_ONCE = 8;
/** Colours in a style's palette. */
export const MAX_PALETTE = 6;
/** Project rows the menu's Studio submenu lists; the rest are under "All projects" (EnkiSidebar). */
export const MAX_SUBMENU_PROJECTS = 4;

/** Longest text per field, in characters (SQL 53's CHECKs hold the same). */
export const STUDIO_TEXT = { name: 60, description: 500, link: 300, words: 400, prompt: 4000 } as const;

/** Writes per account and minute (lib/rate-limit), and picture uploads per account and minute (as app/api/references). */
export const STUDIO_WRITES_PER_MIN = 60;
export const STUDIO_UPLOADS_PER_MIN = 30;

/** Assets live in SQL 51's private bucket (lib/reference-library REFERENCE_BUCKET), which SQL 53 makes too, under
 *  studio/<user>/<project>/<sha256>.<ext> and .tile.webp: never public, read through addresses signed for an hour. */
export const STUDIO_BUCKET = "reference-uploads";
export const STUDIO_PREFIX = "studio";

/** The prompts the character flow offers as sheets: the feed's Characters category (lib/categories), read through
 *  GET /api/marketplace/prompts?category=Characters (listed, active, adult-gated as the feed is). */
export const SHEET_CATEGORY = "Characters";

/* ── Rows, as SQL 53 makes them (snake_case; read by the routes only). Every child row carries its project's owner,
   held equal to the project's by a composite foreign key. ── */

export interface StudioProjectRow {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  link: string | null;
  created_at: string;
  updated_at: string;
}
export interface StudioAssetRow {
  id: string;
  project_id: string;
  user_id: string;
  /** In STUDIO_BUCKET: the picture, and its tile (a WebP of at most 256 px), null when none was stored. */
  path: string;
  thumb_path: string | null;
  /** sha256 of the picture's bytes: the same picture added to a project again is this row. */
  content_hash: string;
  created_at: string;
}
export interface StudioCharacterRow {
  id: string;
  project_id: string;
  user_id: string;
  name: string;
  /** Exactly one of the two: a render of the owner's (generated_images.id) or one of the project's assets. */
  image_id: string | null;
  asset_id: string | null;
  /** The character sheet (prompts.id) it was rendered with; null for an asset, or once that prompt is gone. */
  sheet_prompt_id: string | null;
  created_at: string;
}
export interface StudioStyleRow {
  id: string;
  project_id: string;
  user_id: string;
  name: string;
  /** Words added to a prompt ("warm film grain, soft daylight"); may be empty. */
  words: string;
  /** Up to MAX_PALETTE lower-case hex colours, "#7d1d33". */
  palette: string[];
  created_at: string;
  updated_at: string;
}
export interface StudioMasterPromptRow {
  id: string;
  project_id: string;
  user_id: string;
  name: string;
  prompt: string;
  created_at: string;
  updated_at: string;
}
export interface StudioContentRow {
  id: string;
  project_id: string;
  user_id: string;
  name: string;
  description: string | null;
  link: string | null;
  /** The project's style and master prompt this content piece opens Create with; null for none. */
  style_id: string | null;
  master_prompt_id: string | null;
  created_at: string;
  updated_at: string;
}
export interface StudioContentImageRow {
  content_id: string;
  user_id: string;
  /** generated_images.id: one of the owner's renders, never an upload. */
  image_id: string;
  added_at: string;
}

/* ── What the API answers (camelCase). Times are ISO strings. ── */

/** A picture as the UI shows and reads it: `url` is what goes in as a reference, `thumb` the tile. */
export interface StudioPicture {
  url: string;
  thumb: string;
}

export interface Project {
  id: string;
  name: string;
  description: string | null;
  link: string | null;
  createdAt: string;
  updatedAt: string;
}
/** A project in the list (GET /api/studio/projects): what its folder card and the menu show. */
export interface ProjectSummary extends Project {
  counts: { assets: number; characters: number; contents: number };
  /** Up to 4 of its newest assets' tiles, signed; empty for a project without assets. */
  cover: string[];
}
export interface Asset extends StudioPicture {
  id: string;
  projectId: string;
  hash: string;
  createdAt: string;
}
export interface Character {
  id: string;
  projectId: string;
  name: string;
  /** Null once its render was deleted from the owner's gallery: the card says so and keeps its ×. */
  picture: StudioPicture | null;
  source: "render" | "asset";
  imageId: string | null;
  assetId: string | null;
  sheetPromptId: string | null;
  createdAt: string;
}
export interface Style {
  id: string;
  projectId: string;
  name: string;
  words: string;
  palette: string[];
  createdAt: string;
  updatedAt: string;
}
export interface MasterPrompt {
  id: string;
  projectId: string;
  name: string;
  prompt: string;
  createdAt: string;
  updatedAt: string;
}
export interface Content {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  link: string | null;
  styleId: string | null;
  masterPromptId: string | null;
  createdAt: string;
  updatedAt: string;
  /** Renders filed in it (deleted ones left out). */
  count: number;
  /** Up to 4 of its newest renders' thumbnails. */
  cover: string[];
}
/** A render filed in a content piece. */
export interface ContentImage extends StudioPicture {
  imageId: string;
  /** The prompt it was made with, for "Open its prompt"; null for the blank composer's. */
  promptId: string | null;
  addedAt: string;
}
/** GET /api/studio/projects/[id]: everything one project holds, in one read. Assets newest first; characters, styles
 *  and master prompts oldest first (the first style and master prompt are a new content piece's defaults); contents
 *  newest first. */
export interface ProjectDetail {
  project: Project;
  assets: Asset[];
  characters: Character[];
  styles: Style[];
  masterPrompts: MasterPrompt[];
  contents: Content[];
}
/** GET /api/studio/contents/[id]: the piece, its project's name, and its renders newest first. */
export interface ContentDetail {
  content: Content;
  project: { id: string; name: string };
  images: ContentImage[];
}

/* ── What the API takes. An absent field stays as it is on a PATCH; null clears an optional one. ── */

export interface ProjectInput {
  name: string;
  description?: string | null;
  /** http:// or https:// only; the UI adds https:// to a bare "enki.art". */
  link?: string | null;
}
/** A picture as the reference picker reads it (hooks/useReferenceReads readReference): a PNG, JPEG or WebP data URL. */
export interface AssetInput {
  image: string;
}
export interface CharacterInput {
  name: string;
  /** One of the two. */
  imageId?: string;
  assetId?: string;
  sheetPromptId?: string | null;
}
export interface StyleInput {
  name: string;
  words?: string;
  palette?: string[];
}
export interface MasterPromptInput {
  name: string;
  prompt: string;
}
export interface ContentInput {
  name: string;
  description?: string | null;
  link?: string | null;
  styleId?: string | null;
  masterPromptId?: string | null;
}
export interface FileImagesInput {
  /** 1 to MAX_FILE_AT_ONCE generated_images ids of the caller's own renders. */
  imageIds: string[];
}

/** The children a project's POST /api/studio/projects/[id]/[kind] makes, and the ones /api/studio/[kind]/[id] changes
 *  (PATCH; an asset has none) and deletes. Contents have their own static folder (app/api/studio/contents/[id]). */
export const PROJECT_KINDS = ["assets", "characters", "styles", "master-prompts", "contents"] as const;
export type ProjectKind = (typeof PROJECT_KINDS)[number];
export const ITEM_KINDS = ["assets", "characters", "styles", "master-prompts"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

/** The responses, by route (status 200 unless said). Every failure is { error: <one sentence below> }. */
export interface StudioResponses {
  "GET /projects": { projects: ProjectSummary[] };
  /** 201 */
  "POST /projects": { project: Project };
  "GET /projects/[id]": ProjectDetail;
  "PATCH /projects/[id]": { project: Project };
  "DELETE /projects/[id]": { deleted: true };
  /** 201, or 200 with the row already there for the same picture. */
  "POST /projects/[id]/assets": { asset: Asset };
  /** 201 */
  "POST /projects/[id]/characters": { character: Character };
  "POST /projects/[id]/styles": { style: Style };
  "POST /projects/[id]/master-prompts": { masterPrompt: MasterPrompt };
  "POST /projects/[id]/contents": { content: Content };
  "PATCH /characters/[id]": { character: Character };
  "PATCH /styles/[id]": { style: Style };
  "PATCH /master-prompts/[id]": { masterPrompt: MasterPrompt };
  "DELETE /[kind]/[id]": { deleted: true };
  "GET /contents/[id]": ContentDetail;
  "PATCH /contents/[id]": { content: Content };
  "DELETE /contents/[id]": { deleted: true };
  /** The ids now in the piece, those filed before included. */
  "POST /contents/[id]/images": { filed: string[] };
  /** ?imageId=<uuid> */
  "DELETE /contents/[id]/images": { removed: true };
}

/* ── Sentences, in Enki's voice (as lib/reference-library's). 401 "Not signed in" and 404 "Not found" are the routes'
   usual ones: someone else's row reads as none at all. ── */

/** 503 until SQL 53 has run (PGRST205 / 42P01). */
export const STUDIO_NOT_READY = "Studio is not available yet.";
/** 400 */
export const NAME_NEEDED = "Give it a name.";
export const TOO_LONG = {
  name: `The name can be up to ${STUDIO_TEXT.name} characters.`,
  description: `The description can be up to ${STUDIO_TEXT.description} characters.`,
  link: `The link can be up to ${STUDIO_TEXT.link} characters.`,
  words: `A style's words can be up to ${STUDIO_TEXT.words} characters.`,
  prompt: `A master prompt can be up to ${STUDIO_TEXT.prompt} characters.`,
} as const satisfies Record<keyof typeof STUDIO_TEXT, string>;
export const BAD_LINK = "A link starts with http:// or https://.";
export const BAD_PALETTE = `A palette holds up to ${MAX_PALETTE} colours, each like #7d1d33.`;
export const PROMPT_NEEDED = "Write the master prompt first.";
export const ONE_PICTURE = "A character needs one picture: one of your renders or one of this project's assets.";
export const NOT_YOUR_RENDER = "Only your own renders can go here.";
export const NOT_IN_PROJECT = "That belongs to another project.";
export const SHEET_GONE = "That character sheet is no longer on Enki.";
/** 409 */
export const PROJECT_NAME_TAKEN = "You already have a project with that name.";
export const CONTENT_NAME_TAKEN = "This project already has a content piece with that name.";
export const ASSET_IN_USE = "A character uses this picture. Delete the character first.";
export const PROJECTS_FULL = `You can have up to ${MAX_PROJECTS} projects. Delete one first.`;
export const PROJECT_ASSETS_FULL = `A project holds up to ${MAX_PROJECT_ASSETS} assets. Delete some first.`;
export const STUDIO_ASSETS_FULL = `You can keep up to ${MAX_STUDIO_ASSETS} assets across your projects. Delete some first.`;
export const CHARACTERS_FULL = `A project holds up to ${MAX_CHARACTERS} characters. Delete one first.`;
export const STYLES_FULL = `A project holds up to ${MAX_STYLES} styles. Delete one first.`;
export const MASTER_PROMPTS_FULL = `A project holds up to ${MAX_MASTER_PROMPTS} master prompts. Delete one first.`;
export const CONTENTS_FULL = `A project holds up to ${MAX_CONTENTS} content pieces. Delete one first.`;
export const CONTENT_IMAGES_FULL = `A content piece holds up to ${MAX_CONTENT_IMAGES} images.`;
/** 500 / 503, by what was asked. */
export const NOT_READ = "Could not read your projects.";
export const NOT_SAVED = "Could not save that right now.";
export const NOT_DELETED = "Could not delete that right now.";
