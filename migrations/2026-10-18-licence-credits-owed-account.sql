-- A licence credit can be owed to an ACCOUNT, not only to a wallet (Kev,
-- 2026-10-18: "all prompts must be accessible"). Every listed prompt sells
-- over x402 now, a priced one whose artist has no payout wallet (or one that
-- must be re-linked) included: Enki takes the price and owes the artist's
-- share to the artist's account, paid once they add a wallet. The x402 route
-- writes user_id on every artist credit and owner = the wallet the share was
-- priced to where there is one (lib/payments/licence-credits.ts).
--
-- user_id has no foreign key, like prompt_id: what an account earned stays
-- owed whatever happens to the row. A credit names its recipient one way or
-- the other (licence_credits_recipient_check).
--
-- Probed live 2026-10-18 (read-only): licence_credits.user_id absent (42703),
-- 0 rows. Run BEFORE deploying fix/x402-2026-10-18: until it exists every
-- credit write fails ("licence credit(s) NOT recorded" in the log), the render
-- is still delivered and paid.
--
-- The grant stays the table's (service role SELECT, INSERT), which covers the
-- new column. Re-runnable: IF NOT EXISTS; the constraint is added once.

ALTER TABLE public.licence_credits ADD COLUMN IF NOT EXISTS user_id uuid;
ALTER TABLE public.licence_credits ALTER COLUMN owner DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'licence_credits_recipient_check') THEN
    ALTER TABLE public.licence_credits
      ADD CONSTRAINT licence_credits_recipient_check CHECK (owner IS NOT NULL OR user_id IS NOT NULL);
  END IF;
END $$;

-- What a payout run reads for an account: its unpaid credits in one mint.
CREATE INDEX IF NOT EXISTS licence_credits_unpaid_user_idx
  ON public.licence_credits (user_id, mint) WHERE payout_id IS NULL AND user_id IS NOT NULL;

COMMENT ON COLUMN public.licence_credits.user_id IS
  'The account owed (artist credits): paid to that account''s wallet at payout time; owner may be NULL when it had none.';

-- Read back:
--   SELECT column_name, is_nullable FROM information_schema.columns
--    WHERE table_name = 'licence_credits' AND column_name IN ('owner', 'user_id');

-- Rollback (only while no row has a NULL owner):
--   DROP INDEX IF EXISTS public.licence_credits_unpaid_user_idx;
--   ALTER TABLE public.licence_credits DROP CONSTRAINT IF EXISTS licence_credits_recipient_check;
--   ALTER TABLE public.licence_credits ALTER COLUMN owner SET NOT NULL;
--   ALTER TABLE public.licence_credits DROP COLUMN IF EXISTS user_id;
