-- Who a customer is, and which way each render came (Kev, 2026-10-14: "wir
-- brauchen fürs Indexen eine Unterscheidung, damit wir sehen wieviel Prozent
-- kam durch Agents, welche durch E-Mails und welche durch Wallets").
--
--   users.origin      email | wallet | agent — set when the account is made:
--                     an invite or signup, a wallet login, or a wallet's first
--                     paid x402 render (the transaction it signed is the same
--                     proof a login gives; agents are full accounts).
--   generations.rail  web | free | x402 | mcp — set by the route that renders.
--
-- Both are backfilled where the past can be read: a password credential says
-- email, a wallet row says wallet; a generation with a payment came through
-- the web rail (nothing else was recorded before this), one without through
-- the free rail. Probed live 2026-10-14: neither column exists. Additive and
-- idempotent.
BEGIN;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS origin text CHECK (origin IN ('email', 'wallet', 'agent'));
UPDATE public.users u SET origin = 'email'
  WHERE u.origin IS NULL AND EXISTS (SELECT 1 FROM public.password_credentials p WHERE p.user_id = u.id);
UPDATE public.users u SET origin = 'wallet'
  WHERE u.origin IS NULL AND EXISTS (SELECT 1 FROM public.user_wallets w WHERE w.user_id = u.id);

ALTER TABLE public.generations
  ADD COLUMN IF NOT EXISTS rail text CHECK (rail IN ('web', 'free', 'x402', 'mcp'));
UPDATE public.generations SET rail = 'web'
  WHERE rail IS NULL AND (payment_intent_id IS NOT NULL OR transaction_hash IS NOT NULL OR amount_paid_cents IS NOT NULL);
UPDATE public.generations SET rail = 'free' WHERE rail IS NULL;
CREATE INDEX IF NOT EXISTS generations_rail_created_idx ON public.generations (rail, created_at);

COMMIT;

-- Read back:
--   SELECT origin, count(*) FROM public.users GROUP BY origin;
--   SELECT rail, count(*) FROM public.generations GROUP BY rail;
-- Rollback: ALTER TABLE public.users DROP COLUMN IF EXISTS origin;
--   DROP INDEX IF EXISTS public.generations_rail_created_idx; ALTER TABLE public.generations DROP COLUMN IF EXISTS rail;
