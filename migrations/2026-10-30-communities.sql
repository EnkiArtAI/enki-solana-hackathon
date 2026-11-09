-- Communities (Kev, 2026-10-30: "propose me something, that cant be duplicated and will work as a harbour AND gallery for
-- people interested in a community to gather creations and play with each others creations too"; "es sollte
-- permissionless erstellt werden"; "ein bild kann auch mehreren communities zugeteilt werden ... max 18 communities pro
-- werk"; "people would also like to just create together and share artpieces they have done. so we might need some sort
-- of a showroom, decoupled from prompts completely"; the shape he agreed to with "ja lass mal probieren und iterieren").
-- Read and written only by app/api/communities/** and the Community filter of app/api/marketplace/prompts and app/api/search
-- (service role); the shapes, caps and sentences are lib/communities/types.ts, the handle rules lib/communities/handle.ts.
--
--   communities        c/<handle>: unique by its key (case, separators and look-alike digits collide), merged rows
--                      included, so a merged handle stays taken and redirects (merged_into). Anyone signed in starts one.
--   community_aliases  its search words ("bitcoin" for c/btc).
--   community_members  who joined.
--   showroom_posts     a Showroom post: one of its poster's own renders, once, with a title; an answer (a variation)
--                      names the post it answers.
--   community_links    a prompt, a render or a post in a community (one key column each, exactly one set); shown,
--                      opted_out (its owner took a render out that its prompt brought in) or hidden (a moderator).
--   community_reach    view: every way a render reaches a community: linked directly, made from a listed linked prompt
--                      (inheritance is read here, never written in the render path), or a post's; less opt-outs and hides.
--   community_works    view: every public render in a community, once, in the first 18 it reached ("max 18 communities pro
--                      werk").
--   community_cards    view: one card per live community: counts, listed, cover.
--   showroom_entries   view: the posts whose render may be shown, with the render.
--   community_posts    view: those posts per community.
--   community_suggest  the soft suggestion's lookup, called by POST so a text's words never travel in an address.
--   merge_community    an admin's merge, in one transaction.
--
-- VERIFIED live 2026-10-30 by Claude, read-only (PostgREST GET/HEAD; scratchpad __communities-live.mjs, -live2.mjs):
--   status communities 404  PGRST205 (likewise community, community_members, community_links, community_posts,
--   community_aliases, community_merges, posts, showroom, showroom_posts, groups, tags)
--   prompts {"id":"uuid PK","showcase_images":"jsonb","is_listed":"boolean","listing_status":"text","deleted_at":
--   "timestamp with time zone","is_adult":"boolean","like_count":"integer","published_at":"timestamp with time zone",
--   "creator_id":"uuid FK users.id"}
--   generated_images {"id":"uuid PK","user_id":"uuid FK users.id","prompt_id":"uuid FK prompts.id","generation_id":"uuid FK
--   generations.id","visibility":"text","is_uploaded":"boolean","deleted_at":"timestamp with time zone","is_adult":
--   "boolean","like_count":"integer","published_at":"timestamp with time zone","mime_type":"text", ...}
--   generations {"id":"uuid PK","prompt_id":"uuid FK prompts.id","deleted_at":"timestamp with time zone","user_id":"uuid FK users.id"}
--   users {"id":"uuid PK","handle":"public.citext","role":"text FK roles.key","is_admin":"boolean","deleted_at":
--   "timestamp with time zone","account_status":"text"}
--   status bans 200 */0; status admin_actions 200 */0
--   generated_images.visibility: [["private",54],["public",2]]; count generated_images mime video 200 */0
-- Not determined: the Postgres version (nothing here needs 15) and the indexes on generated_images(prompt_id) and
-- generations(prompt_id). Service role only. Re-runnable.
BEGIN;

-- The key a handle or a search word is unique and found by (agreed 2026-10-30: "case, separators, confusable letters
-- collide"): lib/communities/handle.ts handleKey is the same function; the test compares them.
CREATE OR REPLACE FUNCTION public.community_key(h text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$ SELECT translate(replace(replace(replace(lower(h), '_', ''), 'rn', 'm'), 'vv', 'w'), '013457', 'oleast') $$;

-- Hidden owners, as lib/hidden-owners.ts reads them: a deleted or not active account, or an active ban.
CREATE OR REPLACE FUNCTION public.community_owner_hidden(uid uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = public
AS $$ SELECT EXISTS (SELECT 1 FROM users u WHERE u.id = uid AND (u.deleted_at IS NOT NULL OR coalesce(u.account_status, 'active') <> 'active'))
         OR EXISTS (SELECT 1 FROM bans b WHERE b.user_id = uid AND b.lifted_at IS NULL AND (b.expires_at IS NULL OR b.expires_at > now())) $$;

CREATE TABLE IF NOT EXISTS public.communities (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  handle           text        NOT NULL CONSTRAINT communities_handle_shape
                               CHECK (char_length(handle) BETWEEN 2 AND 30 AND handle ~ '^[a-z0-9]+(_[a-z0-9]+)*$'),
  handle_key       text        GENERATED ALWAYS AS (public.community_key(handle)) STORED,
  core             text        NOT NULL CONSTRAINT communities_core_len CHECK (char_length(core) BETWEEN 1 AND 30),
  name             text        NOT NULL CONSTRAINT communities_name_len CHECK (char_length(btrim(name)) BETWEEN 2 AND 40),
  description      text        CONSTRAINT communities_description_len CHECK (char_length(description) <= 300),
  created_by       uuid        REFERENCES public.users(id) ON DELETE SET NULL,
  -- An admin's delete of the target takes the shells merged into it too (their handles are free again).
  merged_into      uuid        REFERENCES public.communities(id) ON DELETE CASCADE,
  merged_at        timestamptz,
  core_reviewed_at timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT communities_merge_pair CHECK ((merged_into IS NULL) = (merged_at IS NULL) AND merged_into IS DISTINCT FROM id)
);
-- Unique over merged rows too: an old handle stays taken and redirects. text_pattern_ops serves the prefix search.
CREATE UNIQUE INDEX IF NOT EXISTS communities_one_key ON public.communities (handle_key text_pattern_ops);
CREATE INDEX IF NOT EXISTS communities_core ON public.communities (core) WHERE merged_into IS NULL;
CREATE INDEX IF NOT EXISTS communities_created_by ON public.communities (created_by, created_at);
CREATE INDEX IF NOT EXISTS communities_merged_into ON public.communities (merged_into) WHERE merged_into IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.community_aliases (
  community_id uuid        NOT NULL REFERENCES public.communities(id) ON DELETE CASCADE,
  alias        text        NOT NULL CONSTRAINT community_aliases_shape
                           CHECK (char_length(alias) BETWEEN 2 AND 40 AND alias ~ '^[a-z0-9]+(_[a-z0-9]+)*$'),
  alias_key    text        GENERATED ALWAYS AS (public.community_key(alias)) STORED,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (community_id, alias_key)
);
CREATE INDEX IF NOT EXISTS community_aliases_key ON public.community_aliases (alias_key text_pattern_ops);

CREATE TABLE IF NOT EXISTS public.community_members (
  community_id uuid        NOT NULL REFERENCES public.communities(id) ON DELETE CASCADE,
  user_id      uuid        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (community_id, user_id)
);
CREATE INDEX IF NOT EXISTS community_members_user ON public.community_members (user_id);

CREATE TABLE IF NOT EXISTS public.showroom_posts (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- One of the poster's own renders (the trigger below checks), never an upload; one post per render.
  image_id   uuid        NOT NULL REFERENCES public.generated_images(id) ON DELETE CASCADE,
  title      text        NOT NULL CONSTRAINT showroom_posts_title_len CHECK (char_length(btrim(title)) BETWEEN 1 AND 80),
  caption    text        CONSTRAINT showroom_posts_caption_len CHECK (char_length(caption) <= 500),
  -- The post it answers; its answers become posts of their own when it goes.
  parent_id  uuid        REFERENCES public.showroom_posts(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT showroom_posts_one_per_render UNIQUE (image_id),
  CONSTRAINT showroom_posts_not_own_parent CHECK (parent_id IS DISTINCT FROM id)
);
CREATE INDEX IF NOT EXISTS showroom_posts_parent ON public.showroom_posts (parent_id, created_at DESC) WHERE parent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS showroom_posts_user ON public.showroom_posts (user_id, created_at);

CREATE TABLE IF NOT EXISTS public.community_links (
  community_id uuid        NOT NULL REFERENCES public.communities(id) ON DELETE CASCADE,
  prompt_id    uuid        REFERENCES public.prompts(id) ON DELETE CASCADE,
  image_id     uuid        REFERENCES public.generated_images(id) ON DELETE CASCADE,
  post_id      uuid        REFERENCES public.showroom_posts(id) ON DELETE CASCADE,
  user_id      uuid        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  state        text        NOT NULL DEFAULT 'shown' CONSTRAINT community_links_state CHECK (state IN ('shown', 'opted_out', 'hidden')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT community_links_one_item CHECK (num_nonnulls(prompt_id, image_id, post_id) = 1),
  -- Opting out is for a render its prompt brought in.
  CONSTRAINT community_links_opt_out_renders CHECK (state <> 'opted_out' OR image_id IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS community_links_prompt ON public.community_links (community_id, prompt_id) WHERE prompt_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS community_links_image  ON public.community_links (community_id, image_id)  WHERE image_id  IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS community_links_post   ON public.community_links (community_id, post_id)   WHERE post_id   IS NOT NULL;
CREATE INDEX IF NOT EXISTS community_links_by_prompt ON public.community_links (prompt_id) WHERE prompt_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS community_links_by_image  ON public.community_links (image_id)  WHERE image_id  IS NOT NULL;
CREATE INDEX IF NOT EXISTS community_links_by_post   ON public.community_links (post_id)   WHERE post_id   IS NOT NULL;

-- Caps by owner, optionally within a window (TG_ARGV: column, cap, interval or none; lib/communities/types.ts holds the
-- numbers, the test reads them from there). Studio's pattern (SQL 53): counted one write at a time per owner. The routes
-- answer each cap's sentence by its message, 'community cap <table> <column> <window|all>' (lib/communities/server.ts).
CREATE OR REPLACE FUNCTION public.community_cap() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  owner uuid := (to_jsonb(NEW) ->> TG_ARGV[0])::uuid;
  n int;
BEGIN
  IF owner IS NULL THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(TG_TABLE_NAME || ':' || TG_ARGV[0] || ':' || owner::text, 0));
  EXECUTE format('SELECT count(*) FROM public.%I WHERE %I = $1 AND created_at > now() - $2::interval', TG_TABLE_NAME, TG_ARGV[0])
    INTO n USING owner, coalesce(TG_ARGV[2], '1000 years');
  IF n >= TG_ARGV[1]::int THEN
    RAISE EXCEPTION 'community cap % % %', TG_TABLE_NAME, TG_ARGV[0], coalesce(TG_ARGV[2], 'all') USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS communities_cap_day ON public.communities;
CREATE TRIGGER communities_cap_day BEFORE INSERT ON public.communities FOR EACH ROW EXECUTE FUNCTION public.community_cap('created_by', '3', '1 day');
DROP TRIGGER IF EXISTS communities_cap_all ON public.communities;
CREATE TRIGGER communities_cap_all BEFORE INSERT ON public.communities FOR EACH ROW EXECUTE FUNCTION public.community_cap('created_by', '30');
DROP TRIGGER IF EXISTS community_aliases_cap ON public.community_aliases;
CREATE TRIGGER community_aliases_cap BEFORE INSERT ON public.community_aliases FOR EACH ROW EXECUTE FUNCTION public.community_cap('community_id', '10');
DROP TRIGGER IF EXISTS showroom_posts_cap_day ON public.showroom_posts;
CREATE TRIGGER showroom_posts_cap_day BEFORE INSERT ON public.showroom_posts FOR EACH ROW EXECUTE FUNCTION public.community_cap('user_id', '20', '1 day');

-- A post's render is its poster's own and no upload.
CREATE OR REPLACE FUNCTION public.showroom_posts_own_render() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM generated_images g WHERE g.id = NEW.image_id AND g.user_id = NEW.user_id AND g.is_uploaded IS NOT TRUE) THEN
    RAISE EXCEPTION 'showroom post not own render' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS showroom_posts_own_render ON public.showroom_posts;
CREATE TRIGGER showroom_posts_own_render BEFORE INSERT ON public.showroom_posts FOR EACH ROW EXECUTE FUNCTION public.showroom_posts_own_render();

-- A link is its item's owner's (a moderator's hidden row excepted), and an item has up to 18 shown links of its own (Kev,
-- 2026-10-30: "max 18 communities pro werk"; lib/communities/types.ts MAX_COMMUNITIES_PER_WORK; a render's prompt's and
-- post's come in on top: community_works keeps it to the first 18 however it came in). Not on an update of community_id: a
-- merge moves a link without changing how many an item has.
CREATE OR REPLACE FUNCTION public.community_links_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  col  text := CASE WHEN NEW.prompt_id IS NOT NULL THEN 'prompt_id' WHEN NEW.image_id IS NOT NULL THEN 'image_id' ELSE 'post_id' END;
  item uuid := coalesce(NEW.prompt_id, NEW.image_id, NEW.post_id);
  owns boolean;
  n    int;
BEGIN
  -- Assigned apart: an IF's condition ends at its first THEN, so a CASE inside it does not parse (PGlite, 2026-10-30).
  owns := CASE col
    WHEN 'prompt_id' THEN EXISTS (SELECT 1 FROM prompts p WHERE p.id = item AND p.creator_id = NEW.user_id)
    WHEN 'image_id'  THEN EXISTS (SELECT 1 FROM generated_images g WHERE g.id = item AND g.user_id = NEW.user_id AND g.is_uploaded IS NOT TRUE)
    ELSE EXISTS (SELECT 1 FROM showroom_posts s WHERE s.id = item AND s.user_id = NEW.user_id) END;
  IF NEW.state <> 'hidden' AND NOT owns THEN
    RAISE EXCEPTION 'community link not owner' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state = 'shown' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('community_links:' || item::text, 0));
    EXECUTE format('SELECT count(*) FROM public.community_links WHERE %I = $1 AND state = ''shown'' AND community_id <> $2', col)
      INTO n USING item, NEW.community_id;
    IF n >= 18 THEN
      RAISE EXCEPTION 'community cap community_links %', col USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS community_links_guard ON public.community_links;
CREATE TRIGGER community_links_guard BEFORE INSERT OR UPDATE OF state ON public.community_links FOR EACH ROW EXECUTE FUNCTION public.community_links_guard();

-- Every way a render reaches a community: linked directly ('link'), made from a listed linked prompt whose creator is not
-- hidden ('prompt'), or a Showroom post's render ('post'); unless its owner opted it out or a moderator hid it there.
-- linked_at: when that way began. Any render, public or not: lib/communities/server.ts reads a render's places here too.
CREATE OR REPLACE VIEW public.community_reach AS
SELECT w.community_id, w.image_id, w.linked_at, w.via
FROM (
  SELECT l.community_id, l.image_id, l.created_at AS linked_at, 'link'::text AS via
    FROM public.community_links l WHERE l.image_id IS NOT NULL AND l.state = 'shown'
  UNION ALL
  SELECT l.community_id, g.id, l.created_at, 'prompt'
    FROM public.community_links l
    JOIN public.prompts p ON p.id = l.prompt_id AND p.is_listed AND p.listing_status = 'active' AND p.deleted_at IS NULL
                         AND NOT public.community_owner_hidden(p.creator_id)
    JOIN public.generated_images g ON g.prompt_id = l.prompt_id
   WHERE l.state = 'shown'
  UNION ALL
  SELECT l.community_id, sp.image_id, greatest(l.created_at, sp.created_at), 'post'
    FROM public.community_links l JOIN public.showroom_posts sp ON sp.id = l.post_id
   WHERE l.state = 'shown'
) w
WHERE NOT EXISTS (SELECT 1 FROM public.community_links x
                   WHERE x.community_id = w.community_id AND x.image_id = w.image_id AND x.state <> 'shown');

-- Every public render in a community, once, never an upload, a deleted one or a hidden owner's; in the first 18
-- communities it reached, however (Kev, 2026-10-30: "max 18 communities pro werk"; lib/communities/types.ts
-- MAX_COMMUNITIES_PER_WORK): a prompt linked to more later never takes its renders past 18, the earlier ones keep their
-- places. added_at: when it came in (its link, its first going public, its making: the latest of the three); a render
-- reached two ways counts from the earlier.
CREATE OR REPLACE VIEW public.community_works AS
SELECT DISTINCT ON (w.community_id, w.image_id)
  w.community_id, w.image_id, gi.user_id, gi.prompt_id, gi.mime_type, gi.storage_url, gi.preview_url, gi.thumbnail_url,
  gi.width, gi.height, coalesce(gi.is_adult, false) AS is_adult, coalesce(gi.like_count, 0) AS like_count,
  greatest(w.linked_at, coalesce(gi.published_at, gi.created_at)) AS added_at
FROM public.community_reach w
JOIN public.generated_images gi ON gi.id = w.image_id
WHERE gi.visibility = 'public' AND gi.is_uploaded IS NOT TRUE AND gi.deleted_at IS NULL
  AND NOT public.community_owner_hidden(gi.user_id)
  AND (SELECT count(DISTINCT r.community_id) FROM public.community_reach r
        WHERE r.image_id = w.image_id AND (r.linked_at, r.community_id) < (w.linked_at, w.community_id)) < 18
ORDER BY w.community_id, w.image_id, added_at;

-- One card per live community: counts without 18+ works and without hidden members (as lib/hidden-owners.ts: deleted,
-- not active, banned), listed at 5 members or 10 works
-- (lib/communities/types.ts LISTED_MIN_*), and the cover (agreed 2026-10-30, after Kev: "am besten das mit den meisten
-- generierungen"): its listed, non-18+ linked prompt with the most generations shows its first showcase image; else its
-- most-liked work; else its newest.
CREATE OR REPLACE VIEW public.community_cards AS
SELECT c.id, c.handle, c.handle_key, c.core, c.name, c.description, c.created_by, c.created_at, c.core_reviewed_at,
  m.members, w.works, w.works_7d, (m.members >= 5 OR w.works >= 10) AS listed,
  coalesce(pc.url, wc.url) AS cover_url
FROM public.communities c
CROSS JOIN LATERAL (SELECT count(*)::int AS members FROM public.community_members cm
                     WHERE cm.community_id = c.id AND NOT public.community_owner_hidden(cm.user_id)) m
CROSS JOIN LATERAL (
  SELECT count(*)::int AS works, (count(*) FILTER (WHERE cw.added_at > now() - interval '7 days'))::int AS works_7d
    FROM public.community_works cw WHERE cw.community_id = c.id AND NOT cw.is_adult) w
LEFT JOIN LATERAL (
  SELECT p.showcase_images ->> 0 AS url
    FROM public.community_links l JOIN public.prompts p ON p.id = l.prompt_id
   WHERE l.community_id = c.id AND l.state = 'shown'
     AND p.is_listed AND p.listing_status = 'active' AND p.deleted_at IS NULL AND p.is_adult IS NOT TRUE
     AND NOT public.community_owner_hidden(p.creator_id)
     AND jsonb_typeof(p.showcase_images) = 'array' AND (p.showcase_images ->> 0) ~ '^https://'
   ORDER BY (SELECT count(*) FROM public.generations g WHERE g.prompt_id = p.id AND g.deleted_at IS NULL) DESC,
            coalesce(p.like_count, 0) DESC, p.published_at DESC NULLS LAST, p.id
   LIMIT 1) pc ON true
LEFT JOIN LATERAL (
  SELECT coalesce(cw.preview_url, cw.storage_url) AS url
    FROM public.community_works cw
   WHERE cw.community_id = c.id AND NOT cw.is_adult AND coalesce(cw.preview_url, cw.storage_url) ~ '^https://'
   ORDER BY cw.like_count DESC, cw.added_at DESC, cw.image_id
   LIMIT 1) wc ON true
WHERE c.merged_into IS NULL;

-- The Showroom's posts that may be shown (their render public, its own, no upload, not deleted, its poster not hidden),
-- with the render; community_posts: those in each community where their link is shown and no moderator hid the render
-- there.
CREATE OR REPLACE VIEW public.showroom_entries AS
SELECT sp.id, sp.user_id, sp.image_id, sp.title, sp.caption, sp.parent_id, sp.created_at,
  gi.prompt_id, gi.mime_type, gi.storage_url, gi.preview_url, gi.thumbnail_url, gi.width, gi.height,
  coalesce(gi.is_adult, false) AS is_adult, coalesce(gi.like_count, 0) AS like_count
FROM public.showroom_posts sp
JOIN public.generated_images gi ON gi.id = sp.image_id AND gi.user_id = sp.user_id
WHERE gi.visibility = 'public' AND gi.is_uploaded IS NOT TRUE AND gi.deleted_at IS NULL
  AND NOT public.community_owner_hidden(sp.user_id);

CREATE OR REPLACE VIEW public.community_posts AS
SELECT l.community_id, e.*
FROM public.community_links l
JOIN public.showroom_entries e ON e.id = l.post_id
WHERE l.state = 'shown'
  AND NOT EXISTS (SELECT 1 FROM public.community_links x
                   WHERE x.community_id = l.community_id AND x.image_id = e.image_id AND x.state = 'hidden');

-- The soft suggestion (Kev, 2026-10-30: "der server wird gewiss den community namen im text nicht exakt erraten. vllt ein
-- bisschen"): the live communities a text's keys (lib/communities/handle.ts textKeys) name by handle, by a search word or
-- by a handle merged into them, the biggest first. A function, so the route sends the keys in a POST body: a text's
-- words never travel in an address or its logs.
CREATE OR REPLACE FUNCTION public.community_suggest(p_keys text[]) RETURNS TABLE (id uuid, handle text, name text, size int)
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT c.id, c.handle, c.name, c.members + c.works
    FROM community_cards c
   WHERE c.id IN (SELECT coalesce(m.merged_into, m.id) FROM communities m
                   WHERE m.handle_key = ANY (p_keys)
                      OR m.id IN (SELECT a.community_id FROM community_aliases a WHERE a.alias_key = ANY (p_keys)))
   ORDER BY 4 DESC, 2
   LIMIT 50
$$;

-- An admin's merge, in one transaction: links the target lacks move (the target's own row wins, a hide included), an
-- opt-out only with the prompt link it takes a render out of (when the target has that prompt already, the render stays
-- there as its owner left it), members move, communities merged into the one that goes point at the target, and it
-- redirects there. Search words stay on the old row (search maps it to the target).
CREATE OR REPLACE FUNCTION public.merge_community(p_from uuid, p_into uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  moved_links int;
  moved_members int;
BEGIN
  IF p_from = p_into THEN RAISE EXCEPTION 'community merge same' USING ERRCODE = 'check_violation'; END IF;
  PERFORM 1 FROM communities WHERE id IN (p_from, p_into) ORDER BY id FOR UPDATE;
  IF (SELECT count(*) FROM communities WHERE id IN (p_from, p_into) AND merged_into IS NULL) <> 2 THEN
    RAISE EXCEPTION 'community merge gone' USING ERRCODE = 'check_violation';
  END IF;
  DELETE FROM community_links f
   WHERE f.community_id = p_from AND f.state = 'opted_out'
     AND NOT EXISTS (SELECT 1 FROM generated_images g JOIN community_links pl ON pl.prompt_id = g.prompt_id AND pl.community_id = p_from
                      WHERE g.id = f.image_id
                        AND NOT EXISTS (SELECT 1 FROM community_links t WHERE t.community_id = p_into AND t.prompt_id = pl.prompt_id));
  UPDATE community_links f SET community_id = p_into
   WHERE f.community_id = p_from
     AND NOT EXISTS (SELECT 1 FROM community_links t WHERE t.community_id = p_into
                      AND (t.prompt_id = f.prompt_id OR t.image_id = f.image_id OR t.post_id = f.post_id));
  GET DIAGNOSTICS moved_links = ROW_COUNT;
  DELETE FROM community_links WHERE community_id = p_from;
  INSERT INTO community_members (community_id, user_id, created_at)
    SELECT p_into, user_id, created_at FROM community_members WHERE community_id = p_from
    ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS moved_members = ROW_COUNT;
  DELETE FROM community_members WHERE community_id = p_from;
  UPDATE communities SET merged_into = p_into, updated_at = now() WHERE merged_into = p_from;
  UPDATE communities SET merged_into = p_into, merged_at = now(), updated_at = now() WHERE id = p_from;
  RETURN jsonb_build_object('links', moved_links, 'members', moved_members);
END $$;

-- Service role only.
ALTER TABLE public.communities       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.community_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.community_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.showroom_posts    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.community_links   ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.communities, public.community_aliases, public.community_members, public.showroom_posts,
  public.community_links, public.community_reach, public.community_works, public.community_cards, public.showroom_entries,
  public.community_posts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.community_key(text), public.community_owner_hidden(uuid), public.community_cap(),
  public.showroom_posts_own_render(), public.community_links_guard(), public.community_suggest(text[]),
  public.merge_community(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.community_key(text), public.community_owner_hidden(uuid), public.community_cap(),
  public.showroom_posts_own_render(), public.community_links_guard(), public.community_suggest(text[]),
  public.merge_community(uuid, uuid) TO service_role;

COMMIT;

-- Read back (five tables, five views, six triggers, RLS on the tables, anon reads nothing, the key folds look-alikes):
--   SELECT to_regclass('public.communities') AS c, to_regclass('public.community_aliases') AS a, to_regclass('public.community_members') AS m, to_regclass('public.showroom_posts') AS p, to_regclass('public.community_links') AS l, to_regclass('public.community_reach') AS r, to_regclass('public.community_works') AS w, to_regclass('public.community_cards') AS k, to_regclass('public.showroom_entries') AS e, to_regclass('public.community_posts') AS cp;
--   SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND (tgname LIKE 'communit%' OR tgname LIKE 'showroom%') ORDER BY tgname;
--   SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('communities', 'community_aliases', 'community_members', 'showroom_posts', 'community_links') ORDER BY relname;
--   SELECT has_table_privilege('anon', 'public.community_cards', 'select') AS anon_reads;
--   SELECT public.community_key('Gund4m_rn') AS key;

-- Rollback (every community, search word, membership, link and Showroom post is forgotten; renders, prompts and likes
-- stay):
--   DROP VIEW IF EXISTS public.community_posts, public.showroom_entries, public.community_cards, public.community_works, public.community_reach;
--   DROP TABLE IF EXISTS public.community_links, public.showroom_posts, public.community_members, public.community_aliases, public.communities;
--   DROP FUNCTION IF EXISTS public.merge_community(uuid, uuid), public.community_suggest(text[]), public.community_links_guard(), public.showroom_posts_own_render(), public.community_cap(), public.community_owner_hidden(uuid), public.community_key(text);
