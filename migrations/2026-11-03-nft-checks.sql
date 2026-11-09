-- SQL 65: what the click-check found for each NFT of each account (Kev, 2026-11-03: "keep all NFTs first ausgegraut und erst
-- beim anclicken darauf prüfen wir bei zb reference images ob die zur generierung zugelassen werden und speichern sie als
-- zugelassen oder abgelehnt ab"). app/api/wallet/nfts/check reads and writes it. One row an account and NFT:
--   verdict: allowed or refused, never which refusal: a child-safety case lives in automod_events alone (lib/moderation/image-case).
--   why: the sentence the tile says, for a refused one and for an 18+ one; empty for a plain allowed one.
--   no_picture: the tile draws a plain placeholder in place of the picture: a child-safety verdict, and a file that cannot be read
--     (DEC-2026-11-04-02). Private: the client gets only picture: false. Only an allowed verdict clears it.
--   renew_day, renewals: how many renewals the UTC day renew_day has used; the limits are constants in lib/nft-check.
-- A failed check writes nothing. The row is display and convenience only: the generation routes judge a reference on every
-- request, whatever it says.
--
-- VERIFIED live 2026-11-03 by Claude, read-only: nft_checks answers 404 PGRST205, no table with "nft" in its name in the API
-- schema; users.id is a uuid and its primary key (OpenAPI). Again 2026-11-04, before no_picture was added here: 404 PGRST205.
-- Until this runs: every NFT tile stays grey, the tiles say to run this file, nothing is judged and nothing crashes; no NFT
-- can be taken as a reference or ticked in Filter by NFT. Service role only. Re-runnable.

CREATE TABLE IF NOT EXISTS public.nft_checks (
  user_id          uuid        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  nft_id           text        NOT NULL,
  verdict          text        NOT NULL CHECK (verdict IN ('allowed', 'refused')),
  why              text,
  no_picture       boolean     NOT NULL DEFAULT false,
  first_checked_at timestamptz NOT NULL DEFAULT now(),
  checked_at       timestamptz NOT NULL DEFAULT now(),
  renew_day        date        NOT NULL DEFAULT ((now() AT TIME ZONE 'UTC')::date),
  renewals         integer     NOT NULL DEFAULT 0 CHECK (renewals >= 0),
  PRIMARY KEY (user_id, nft_id)
);

ALTER TABLE public.nft_checks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.nft_checks FROM PUBLIC, anon, authenticated;
-- Said out loud: Supabase announced an end to default grants on new tables for existing projects (changelog 45329).
GRANT SELECT, INSERT, UPDATE ON public.nft_checks TO service_role;

-- Check:
--   SELECT verdict, no_picture, count(*) FROM public.nft_checks GROUP BY verdict, no_picture;

-- Rollback (every tile is grey again and asks anew; a child-safety case stays in automod_events):
--   DROP TABLE IF EXISTS public.nft_checks;
