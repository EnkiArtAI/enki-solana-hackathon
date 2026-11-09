-- Licence fees Enki owes for the renders it sells over x402 (Kev, 2026-10-17:
-- "verkäufer-modell für künstlerprompts"). On x402 Enki sells the render: the
-- buyer pays Enki the full price in one transfer, and the artist's, the
-- referrer's and the author's shares become licence fees Enki owes and pays
-- after delivery. The x402 route writes one row per role once a render was
-- delivered (lib/payments/licence-credits.ts); a withheld or failed render
-- writes nothing. A payout run sets payout_id on the rows it paid.
--
-- source is the payment ('x402:<transaction signature>'), so (source, role)
-- makes a retried insert a no-op and one payment never owes a role twice.
-- owner is the recipient as the 402 priced it: a Solana wallet, or the owner
-- of an author's vault (a PDA). mint is the USDC mint of the chain the buyer
-- paid on (x402 settles on mainnet while the escrow stays on devnet), so a
-- credit is paid in the USDC it was earned in. micro is micro-USDC.
-- prompt_id and payout_id have no foreign key on purpose: a deleted prompt
-- still owes what it earned, and payouts have no table yet.
--
-- The server's service role may read and add rows, nothing else: an owed fee
-- is never edited or deleted by a bug. The payout run will need
-- GRANT UPDATE (payout_id) when it is built.
--
-- Probed live 2026-10-18 (read-only): licence_credits absent (PGRST205).
-- Run BEFORE deploying the merchant-model code: until it exists every
-- delivered artist render logs "licence credit(s) NOT recorded".
-- Re-runnable: IF NOT EXISTS; REVOKE and GRANT repeat harmlessly.

CREATE TABLE IF NOT EXISTS public.licence_credits (
  source      text        NOT NULL,
  role        text        NOT NULL CONSTRAINT licence_credits_role_check CHECK (role IN ('artist', 'referrer', 'author')),
  owner       text        NOT NULL,
  mint        text        NOT NULL,
  micro       bigint      NOT NULL CONSTRAINT licence_credits_micro_check CHECK (micro > 0),
  prompt_id   uuid,
  payout_id   uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source, role)
);

-- What a payout run reads: one recipient's unpaid credits in one mint.
CREATE INDEX IF NOT EXISTS licence_credits_unpaid_idx
  ON public.licence_credits (owner, mint) WHERE payout_id IS NULL;

-- No policy: nobody but the service role (which bypasses RLS) sees a row.
ALTER TABLE public.licence_credits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.licence_credits FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON TABLE public.licence_credits TO service_role;

COMMENT ON TABLE public.licence_credits IS
  'Licence fees Enki owes artists, referrers and authors for renders it sold over x402; one row per payment and role.';

-- Rollback (drops every recorded credit; run it only before the first x402 artist render):
--   DROP TABLE IF EXISTS public.licence_credits;
