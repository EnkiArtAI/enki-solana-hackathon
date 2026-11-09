-- The price a generator charges is the bill its priced route sent back last
-- time (Kev, 2026-10-13: "zieh den preis direkt vom api call").
--
-- Every delivered paid render that came with a vendor bill (OpenAI and Google
-- answer with the tokens they billed; WaveSpeed does not) writes one row. The
-- view price_cells is the newest priced bill per family / size / quality /
-- route role: the cell every quote charges. lib/pricing.ts seeds a cell nobody
-- has rendered yet. A bill from a fallback host (priced = false) is kept for
-- the record and never becomes a cell.
--
-- Probed live 2026-10-13: generations.id uuid; no table or view of these
-- names. Additive and idempotent; service role only (RLS on, no policies, the
-- API roles revoked). Run BEFORE deploying the code: until it runs, every
-- quote prices from the table and every observation write logs a failure.
BEGIN;

CREATE TABLE IF NOT EXISTS public.price_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_family text NOT NULL,
  provider text NOT NULL,
  provider_model text NOT NULL,
  resolution text NOT NULL CHECK (resolution IN ('1K', '2K', '4K')),
  quality text,
  role text NOT NULL CHECK (role IN ('normal', 'boost')),
  priced boolean NOT NULL DEFAULT true,
  tokens integer,
  observed_usd numeric(12, 6) NOT NULL CHECK (observed_usd >= 0),
  generation_id uuid REFERENCES public.generations(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS price_observations_cell_idx
  ON public.price_observations (model_family, resolution, quality, role, created_at DESC)
  WHERE priced;
ALTER TABLE public.price_observations ENABLE ROW LEVEL SECURITY;

-- DISTINCT ON reads NULL qualities as equal, so a model without a quality
-- lever has one cell per size and role.
CREATE OR REPLACE VIEW public.price_cells AS
SELECT DISTINCT ON (model_family, resolution, quality, role)
  model_family, resolution, quality, role, provider, provider_model, tokens, observed_usd, created_at
FROM public.price_observations
WHERE priced
ORDER BY model_family, resolution, quality, role, created_at DESC;

REVOKE ALL ON public.price_observations, public.price_cells FROM PUBLIC, anon, authenticated;

COMMIT;

-- Read back: both exist, the view is empty until the first paid render after the deploy.
-- SELECT count(*) FROM public.price_observations; SELECT * FROM public.price_cells;

-- Rollback:
-- DROP VIEW IF EXISTS public.price_cells; DROP TABLE IF EXISTS public.price_observations;
