-- Studio projects (Kev, 2026-10-30: "At the end i want basically within studio a collection of projects containing
-- different content pieces that all access the same reference images, characters, styles and master prompts ...
-- styles and master prompts must also be set up there, so that the brand ID stays the same"). Read and written only by
-- app/api/studio/** and lib/studio/server.ts (service role); the shapes, caps and sentences are lib/studio/types.ts.
--
--   studio_projects        a project (a brand): name, description, link. Unique name per account.
--   studio_assets          its pictures (logos, products, places), one row per picture and project.
--   studio_characters      its characters: one of the owner's renders (made with a character sheet, a prompt) or one
--                          of the project's assets.
--   studio_styles          its styles: words for a prompt and up to 6 colours.
--   studio_master_prompts  its master prompts.
--   studio_contents        its content pieces (a launch, a post, a campaign), each with one style and one master prompt.
--   studio_content_images  the owner's renders filed in a content piece. A render stays the gallery's: deleting a piece
--                          or a project never deletes one.
--
-- Every child row carries its project's owner, held equal to the project's by a composite foreign key, so no row can
-- name another account's project, and no character another project's asset, whatever a route sends. A project is
-- deleted for good with everything in it (the route removes its files after). The pictures are kept in SQL 51's PRIVATE
-- bucket "reference-uploads" under studio/<user>/<project>/<sha256>.<ext> and .tile.webp, read through addresses
-- signed for an hour; this file makes that bucket with SQL 51's exact settings, so 53 runs before or after 51.
--
-- VERIFIED live 2026-10-30 by Claude, read-only (GET/HEAD): 133 tables and views; none named studio_*, projects,
-- characters, collections, folders, styles, brand_kits or project_assets (all 404); reference_uploads answers 404 and
-- the bucket reference-uploads 400, so SQL 51 has not run; the buckets are "profiles" and "generations" (both public);
-- users.id, prompts.id and generated_images.id are uuid primary keys; generated_images has user_id, is_uploaded and
-- deleted_at; PostgREST 14.5 (the Postgres version is not determined, so nothing here needs Postgres 15).
-- Service role only. Re-runnable.
BEGIN;

CREATE TABLE IF NOT EXISTS public.studio_projects (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  name        text        NOT NULL CONSTRAINT studio_projects_name_len CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
  description text        CONSTRAINT studio_projects_description_len CHECK (char_length(description) <= 500),
  link        text        CONSTRAINT studio_projects_link_web CHECK (char_length(link) <= 300 AND link ~ '^https?://'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  -- What the children's keys point at: (project, owner).
  CONSTRAINT studio_projects_owner UNIQUE (id, user_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS studio_projects_one_name ON public.studio_projects (user_id, lower(btrim(name)));

CREATE TABLE IF NOT EXISTS public.studio_assets (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid        NOT NULL,
  user_id      uuid        NOT NULL,
  -- In the bucket reference-uploads: the picture, and its tile (a WebP of at most 256 px), null when none was stored.
  path         text        NOT NULL,
  thumb_path   text,
  -- sha256 of the picture's bytes: the same picture added to the project again is this row.
  content_hash text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT studio_assets_project FOREIGN KEY (project_id, user_id) REFERENCES public.studio_projects (id, user_id) ON DELETE CASCADE,
  CONSTRAINT studio_assets_one_per_picture UNIQUE (project_id, content_hash),
  CONSTRAINT studio_assets_in_project UNIQUE (id, project_id)
);
CREATE INDEX IF NOT EXISTS studio_assets_user ON public.studio_assets (user_id);

CREATE TABLE IF NOT EXISTS public.studio_characters (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid        NOT NULL,
  user_id         uuid        NOT NULL,
  name            text        NOT NULL CONSTRAINT studio_characters_name_len CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
  -- A render deleted from the gallery for good takes its character with it.
  image_id        uuid        REFERENCES public.generated_images(id) ON DELETE CASCADE,
  asset_id        uuid,
  -- The character sheet it was rendered with; kept as none once that prompt is gone.
  sheet_prompt_id uuid        REFERENCES public.prompts(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT studio_characters_project FOREIGN KEY (project_id, user_id) REFERENCES public.studio_projects (id, user_id) ON DELETE CASCADE,
  -- The asset is this project's; NO ACTION, so deleting a used asset alone is refused (23503) while a project's delete,
  -- which takes both, goes through.
  CONSTRAINT studio_characters_asset FOREIGN KEY (asset_id, project_id) REFERENCES public.studio_assets (id, project_id),
  CONSTRAINT studio_characters_one_picture CHECK (num_nonnulls(image_id, asset_id) = 1)
);
CREATE INDEX IF NOT EXISTS studio_characters_project ON public.studio_characters (project_id);

CREATE TABLE IF NOT EXISTS public.studio_styles (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid        NOT NULL,
  user_id    uuid        NOT NULL,
  name       text        NOT NULL CONSTRAINT studio_styles_name_len CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
  words      text        NOT NULL DEFAULT '' CONSTRAINT studio_styles_words_len CHECK (char_length(words) <= 400),
  -- Up to 6 colours, each "#rrggbb" in lower case.
  palette    text[]      NOT NULL DEFAULT '{}'
             CONSTRAINT studio_styles_palette CHECK (cardinality(palette) <= 6 AND array_to_string(palette, ',') ~ '^(#[0-9a-f]{6}(,#[0-9a-f]{6})*)?$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT studio_styles_project FOREIGN KEY (project_id, user_id) REFERENCES public.studio_projects (id, user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS studio_styles_project ON public.studio_styles (project_id);

CREATE TABLE IF NOT EXISTS public.studio_master_prompts (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid        NOT NULL,
  user_id    uuid        NOT NULL,
  name       text        NOT NULL CONSTRAINT studio_master_prompts_name_len CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
  prompt     text        NOT NULL CONSTRAINT studio_master_prompts_prompt_len CHECK (char_length(btrim(prompt)) BETWEEN 1 AND 4000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT studio_master_prompts_project FOREIGN KEY (project_id, user_id) REFERENCES public.studio_projects (id, user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS studio_master_prompts_project ON public.studio_master_prompts (project_id);

CREATE TABLE IF NOT EXISTS public.studio_contents (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       uuid        NOT NULL,
  user_id          uuid        NOT NULL,
  name             text        NOT NULL CONSTRAINT studio_contents_name_len CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
  description      text        CONSTRAINT studio_contents_description_len CHECK (char_length(description) <= 500),
  link             text        CONSTRAINT studio_contents_link_web CHECK (char_length(link) <= 300 AND link ~ '^https?://'),
  -- The route checks they are this project's (a composite key could not SET NULL one column before Postgres 15).
  style_id         uuid        REFERENCES public.studio_styles(id) ON DELETE SET NULL,
  master_prompt_id uuid        REFERENCES public.studio_master_prompts(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT studio_contents_project FOREIGN KEY (project_id, user_id) REFERENCES public.studio_projects (id, user_id) ON DELETE CASCADE,
  CONSTRAINT studio_contents_owner UNIQUE (id, user_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS studio_contents_one_name ON public.studio_contents (project_id, lower(btrim(name)));
CREATE INDEX IF NOT EXISTS studio_contents_style ON public.studio_contents (style_id);
CREATE INDEX IF NOT EXISTS studio_contents_master_prompt ON public.studio_contents (master_prompt_id);

CREATE TABLE IF NOT EXISTS public.studio_content_images (
  content_id uuid        NOT NULL,
  user_id    uuid        NOT NULL,
  -- One of the owner's renders (the route checks it is theirs and no upload); deleted for good, its filings go.
  image_id   uuid        NOT NULL REFERENCES public.generated_images(id) ON DELETE CASCADE,
  added_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (content_id, image_id),
  CONSTRAINT studio_content_images_content FOREIGN KEY (content_id, user_id) REFERENCES public.studio_contents (id, user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS studio_content_images_image ON public.studio_content_images (image_id);

-- One cap for every table: TG_ARGV[0] is the column counted by (user_id, project_id or content_id), TG_ARGV[1] the cap
-- (lib/studio/types.ts, as small as Kev put the saved references, 2026-10-30: "500 refs pro konto sind schon ein
-- bisschen viel ... eher bei 50"). Counted one write at a time per counted value, so two at once cannot both slip under
-- it. A BEFORE INSERT trigger fires for an upsert's conflicting row too, so the routes never insert a row that is there.
CREATE OR REPLACE FUNCTION public.studio_cap() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  owner uuid := (to_jsonb(NEW) ->> TG_ARGV[0])::uuid;
  n     int;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(TG_TABLE_NAME || ':' || TG_ARGV[0] || ':' || owner::text, 0));
  EXECUTE format('SELECT count(*) FROM public.%I WHERE %I = $1', TG_TABLE_NAME, TG_ARGV[0]) INTO n USING owner;
  IF n >= TG_ARGV[1]::int THEN
    -- The routes answer each cap's sentence by this message (lib/studio/server.ts CAPS).
    RAISE EXCEPTION 'studio cap % %', TG_TABLE_NAME, TG_ARGV[0] USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS studio_projects_cap ON public.studio_projects;
CREATE TRIGGER studio_projects_cap BEFORE INSERT ON public.studio_projects FOR EACH ROW EXECUTE FUNCTION public.studio_cap('user_id', '10');
DROP TRIGGER IF EXISTS studio_assets_cap_project ON public.studio_assets;
CREATE TRIGGER studio_assets_cap_project BEFORE INSERT ON public.studio_assets FOR EACH ROW EXECUTE FUNCTION public.studio_cap('project_id', '20');
DROP TRIGGER IF EXISTS studio_assets_cap_account ON public.studio_assets;
CREATE TRIGGER studio_assets_cap_account BEFORE INSERT ON public.studio_assets FOR EACH ROW EXECUTE FUNCTION public.studio_cap('user_id', '50');
DROP TRIGGER IF EXISTS studio_characters_cap ON public.studio_characters;
CREATE TRIGGER studio_characters_cap BEFORE INSERT ON public.studio_characters FOR EACH ROW EXECUTE FUNCTION public.studio_cap('project_id', '12');
DROP TRIGGER IF EXISTS studio_styles_cap ON public.studio_styles;
CREATE TRIGGER studio_styles_cap BEFORE INSERT ON public.studio_styles FOR EACH ROW EXECUTE FUNCTION public.studio_cap('project_id', '6');
DROP TRIGGER IF EXISTS studio_master_prompts_cap ON public.studio_master_prompts;
CREATE TRIGGER studio_master_prompts_cap BEFORE INSERT ON public.studio_master_prompts FOR EACH ROW EXECUTE FUNCTION public.studio_cap('project_id', '6');
DROP TRIGGER IF EXISTS studio_contents_cap ON public.studio_contents;
CREATE TRIGGER studio_contents_cap BEFORE INSERT ON public.studio_contents FOR EACH ROW EXECUTE FUNCTION public.studio_cap('project_id', '50');
DROP TRIGGER IF EXISTS studio_content_images_cap ON public.studio_content_images;
CREATE TRIGGER studio_content_images_cap BEFORE INSERT ON public.studio_content_images FOR EACH ROW EXECUTE FUNCTION public.studio_cap('content_id', '200');

-- Service role only.
ALTER TABLE public.studio_projects       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.studio_assets         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.studio_characters     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.studio_styles         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.studio_master_prompts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.studio_contents       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.studio_content_images ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.studio_projects, public.studio_assets, public.studio_characters, public.studio_styles,
  public.studio_master_prompts, public.studio_contents, public.studio_content_images FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.studio_cap() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.studio_cap() TO service_role;

-- SQL 51's private bucket, with SQL 51's exact settings (migrations/2026-10-29-reference-uploads.sql), so 53 runs before
-- or after 51: no public address, only the service role writes (it needs no policy), 4 MB a file.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('reference-uploads', 'reference-uploads', false, 4194304, ARRAY['image/png', 'image/jpeg', 'image/webp'])
ON CONFLICT (id) DO UPDATE
  SET public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

COMMIT;

-- Read back (seven tables, eight caps, RLS on everywhere, anon reads nothing, the bucket private):
--   SELECT to_regclass('public.studio_projects') AS p, to_regclass('public.studio_assets') AS a, to_regclass('public.studio_characters') AS c, to_regclass('public.studio_styles') AS s, to_regclass('public.studio_master_prompts') AS m, to_regclass('public.studio_contents') AS ct, to_regclass('public.studio_content_images') AS ci;
--   SELECT tgname FROM pg_trigger WHERE tgname LIKE 'studio_%_cap%' ORDER BY tgname;
--   SELECT relname, relrowsecurity FROM pg_class WHERE relname LIKE 'studio_%' AND relkind = 'r' ORDER BY relname;
--   SELECT has_table_privilege('anon', 'public.studio_projects', 'select') AS anon_reads;
--   SELECT id, public, file_size_limit, allowed_mime_types FROM storage.buckets WHERE id = 'reference-uploads';

-- Rollback (every project, asset row, character, style, master prompt, content piece and filing is forgotten; renders
-- stay in their owners' galleries). The bucket stays (it is SQL 51's too, and emptying it now deletes Studio's
-- pictures as well): delete its folder "studio" on the dashboard's Storage page.
--   DROP TABLE IF EXISTS public.studio_content_images, public.studio_contents, public.studio_characters,
--     public.studio_assets, public.studio_styles, public.studio_master_prompts, public.studio_projects;
--   DROP FUNCTION IF EXISTS public.studio_cap();
