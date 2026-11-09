-- The exact amount a paid generation was bought for, in micro-USDC (Kev,
-- 2026-10-18: "store defo exact usdc amount"). amount_paid_cents rounds to
-- whole cents: the x402 render of 0.00756 USDC (7,560 micro) reads 1 cent.
-- amount_paid_cents stays as it is for the readers that only ask whether a
-- render was paid; this column is the amount.
--
-- Written by both paid rails (lib/generation/record.ts): x402 the amount the
-- payment carried, web the payment intent's total_micro. A free render
-- leaves it NULL. generation_failures gets the same column for an x402
-- payment that settled and delivered nothing (provider failure, image
-- withheld or not stored, outcome unknown): the exact amount a refund returns.
-- The web rail's failures keep intent_id, whose total_micro is exact.
--
-- Probed live 2026-10-18 (read-only): generations.amount_paid_micro and
-- generation_failures.amount_paid_micro absent (42703); 0 paid x402 failures.
-- Run BEFORE deploying the code that writes them: until they exist every PAID
-- render's record fails, and so does every paid x402 failure row (the free
-- renders and the other failures are untouched).
--
-- The three x402 renders before it are filled from the chain: each amount is
-- the USDC the treasury received in that transaction (public RPC, VERIFIED
-- 2026-10-18). They were the only paid rows (live: 3, all x402).
--
-- Re-runnable: IF NOT EXISTS; the fills touch only rows still NULL.

ALTER TABLE public.generations
  ADD COLUMN IF NOT EXISTS amount_paid_micro bigint
  CONSTRAINT generations_amount_paid_micro_check CHECK (amount_paid_micro >= 0);

COMMENT ON COLUMN public.generations.amount_paid_micro IS
  'What the buyer paid for this render, in micro-USDC (exact; amount_paid_cents is rounded). NULL for a free render.';

ALTER TABLE public.generation_failures
  ADD COLUMN IF NOT EXISTS amount_paid_micro bigint
  CONSTRAINT generation_failures_amount_paid_micro_check CHECK (amount_paid_micro >= 0);

COMMENT ON COLUMN public.generation_failures.amount_paid_micro IS
  'What a settled x402 payment carried, in micro-USDC, for a render that was not delivered: the amount a refund returns.';

UPDATE public.generations SET amount_paid_micro = 109920
  WHERE transaction_hash = '2F7fvNT2QhAkdtSm2b8G7YpjefF9bgPaBELssfPzapS8VMgEwAxMM8VXx7FHYFMkq9TfzFDg7GouTUkcMNYQJpb4' AND amount_paid_micro IS NULL;
UPDATE public.generations SET amount_paid_micro = 115560
  WHERE transaction_hash = '3eRxhJRgowZsfLo5D99zXTHedgz7BPrpohHV9H9dLLAQY52R4J54yzFPqnGwVr5wUiHdy9b5RPNYgjNig9BeHyot' AND amount_paid_micro IS NULL;
UPDATE public.generations SET amount_paid_micro = 7560
  WHERE transaction_hash = '4482szeun4LRxjzrHC9EEc4hWRt7ceKB8DmL5tccG7jy2mQvqH7BxFHZEyUy5wjJEmuNn6kT3E1Qk8fTYJrkycL6' AND amount_paid_micro IS NULL;

-- Read back:
--   SELECT transaction_hash, amount_paid_cents, amount_paid_micro FROM public.generations WHERE rail = 'x402';
-- A paid x402 render made after 2026-10-18 08:10 UTC and before the deploy has no exact amount yet; list them and
-- fill each from its transaction on chain (the treasury's USDC delta):
--   SELECT transaction_hash FROM public.generations WHERE rail = 'x402' AND amount_paid_micro IS NULL;

-- Rollback (loses the exact amounts; amount_paid_cents stays):
--   ALTER TABLE public.generations DROP COLUMN IF EXISTS amount_paid_micro;
--   ALTER TABLE public.generation_failures DROP COLUMN IF EXISTS amount_paid_micro;
