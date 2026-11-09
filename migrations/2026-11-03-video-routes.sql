-- SQL 68: which operator runs each video generator, and at what rate (Kev, 2026-11-03: "wir rollen danach die API routes
-- erstmal aus, wir wechseln den betreiber später"). One row per video model; lib/video/routes.ts reads it. A swap of operator
-- is one UPDATE here plus one file in lib/video/adapters/. Nothing else in the code names an operator.
--
-- operator NULL means no route reaches any host, whichever keys are set: Generate says "Not available yet.". A model is
-- available only with an operator, its adapter registered, its key present, rate_operator equal to operator and a rate cell
-- for that resolution, so a rate left over from another operator is not available, never a charge under its cost.
-- cost and audio_cost: micro-USD per output second by resolution, as the provider lists it; audio_cost where sound costs
-- more. clips_added: a held clip's seconds are paid as the output's, at the same rate.
--
-- Seeded with the list rates as researched 2026-10-30, so a price shows while no operator is set. Read each again on the
-- provider's page before setting an operator: Seedance on BytePlus ModelArk, sound at no extra cost; Kling on its Open
-- Platform, 4.0 always with sound, 3.0 dearer with it; Gemini Omni 1.1 Flash on the Gemini API, always with sound and no
-- length field; Wan 3.0 on Alibaba Model Studio Singapore, "(Input-Video-s + Output-s) x Satz", sound at no extra cost.
--
-- VERIFIED live 2026-11-03 by Claude, read-only: video_routes answers 404 PGRST205; models has id, name, price,
-- allowed_ratios, active, created_at, max_reference_images, allowed_filetypes, media_type; six rows, all media_type image.
-- RUN AFTER 67: the rows are joined to models by name, so before 67 this inserts none. Running it again after 67 fills them,
-- and leaves a row Kev has changed as he left it. Until it runs: every video price chip shows "…", Generate says "Not
-- available yet.", and GET /api/video/models answers run: "68-video-routes.sql". Service role only. Re-runnable.

CREATE TABLE IF NOT EXISTS public.video_routes (
  model_id       uuid        PRIMARY KEY REFERENCES public.models(id) ON DELETE CASCADE,
  operator       text,
  provider_model text,
  cost           jsonb       NOT NULL CHECK (jsonb_typeof(cost) = 'object'),
  audio_cost     jsonb       CHECK (audio_cost IS NULL OR jsonb_typeof(audio_cost) = 'object'),
  clips_added    boolean     NOT NULL DEFAULT false,
  rate_operator  text,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT video_routes_operator_whole CHECK (operator IS NULL OR (provider_model IS NOT NULL AND rate_operator IS NOT NULL))
);

ALTER TABLE public.video_routes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.video_routes FROM PUBLIC, anon, authenticated;
-- Said out loud: Supabase announced an end to default grants on new tables for existing projects (changelog 45329).
GRANT SELECT, INSERT, UPDATE ON public.video_routes TO service_role;

INSERT INTO public.video_routes (model_id, cost, audio_cost, clips_added)
SELECT m.id, v.cost::jsonb, v.audio_cost::jsonb, v.clips_added
FROM (VALUES
  ('Seedance 2.5',          '{"480p": 102800, "720p": 231100, "1080p": 568600}', NULL, false),
  ('Seedance 2.0',          '{"480p": 70300, "720p": 151200, "1080p": 374200}', NULL, false),
  ('Kling 4.0',             '{"720p": 157000, "1080p": 235000}', NULL, false),
  ('Kling 3.0',             '{"720p": 84000, "1080p": 112000}', '{"720p": 126000, "1080p": 168000}', false),
  ('Gemini Omni 1.1 Flash', '{"720p": 101400, "1080p": 152000}', NULL, false),
  ('Wan 3.0',               '{"480p": 50000, "720p": 100000, "1080p": 200000}', NULL, true)
) AS v(name, cost, audio_cost, clips_added)
JOIN public.models m ON m.name = v.name AND m.media_type = 'video'
ON CONFLICT (model_id) DO NOTHING;

-- Check (six rows, operator empty):
--   SELECT m.name, r.operator, r.rate_operator, r.cost, r.audio_cost, r.clips_added FROM public.video_routes r JOIN public.models m ON m.id = r.model_id ORDER BY m.name;

-- Rollback (prices show "…" again, Generate stays "Not available yet."):
--   DROP TABLE IF EXISTS public.video_routes;
