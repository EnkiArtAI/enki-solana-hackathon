# Intent rail: handoff (updated 2026-10-20)

Branch `feat/intent-rail`, on top of `fix/x402-2026-10-18` (push that one first). Neither is merged. Every decision with its evidence is in `docs/decisions.md`, DEC-2026-10-18-68 to DEC-2026-10-19-222.

## What it is

The web checkout pays on one of two rails, chosen per order by `lib/payments/rail.ts`:

- **escrow** when `SOLANA_ESCROW_PROGRAM_ID` is set and that program is deployed on the payment chain (devnet today);
- **intent** (durable nonce) otherwise, which is mainnet until escrow v2 is deployed there.

The order's row keeps its rail, so flipping the switch never strands an order in flight.

Intent flow:

1. `/authorize` opens one unit row and one nonce account per image (`open_intent_batch` RPC: at most 8 open per buyer; overall, what the fee payer's balance carries, at most 400). Enki builds and partially signs one USDC transfer per unit; the whole price goes to Enki and the artist's share is credited once the image is delivered (the x402 merchant model).
2. The buyer signs all of them in one wallet window (`signAllTransactions`).
3. `/submit` checks each transaction is the one built, fully signed and payable, then stores it sealed. Nothing is broadcast yet.
4. `/api/generate-image` claims the unit and re-checks that the buyer's USDC covers every open unit. It renders, runs the image check, then captures (broadcasts the held payment). It delivers only when that capture is confirmed and booked. Rejected, unknown or lost captures withhold the image.
5. The */5 cron (`/api/cron/sweep-payments`) settles everything that ended without an answer. It closes nonces (rent back) and books any payment the buyer broadcast themselves as paid, not delivered, with a refund owed.

Kev's rules built in:

- no image without a confirmed capture;
- 8 open units per buyer;
- the buyer's USDC must cover all open units;
- 5 failed captures in 30 minutes pause the buyer for 30 minutes;
- 13 units ordered and dropped (not paid) within an hour pause new orders for an hour;
- signed intent transactions are never stored on the device.

## State

- VERIFIED: SQL 37 (`migrations/2026-10-18-intent-rail.sql`) has run live. Nothing since needs a migration.
- VERIFIED at `b1c56204`: the full suite 4377 passed (359 files), the PGlite migration test 13 passed, the production build 83 of 83 pages (exit 0), and the per-fix gate (every payment, route, checkout, queue and moderation test that touches the rail) 1983 passed (130 files) with `tsc` exit 0.
- 33 adversarial review rounds. Findings per round: 13, 18, 16, 18, 12, 10, 6, 12, 7, 7, 10, 10, 6, 7, 11, 12, 13, 10, 5, 4, 11, 14, 9, 9, 7, 5, 2, 1, 14, 9, 8, 5, 2; high ones: 0, 1, 1, 7, 5, 1, none in rounds 7 to 13, 1, 5, 3, none in rounds 18 to 29, 1 in round 30 (a signature the node refuses read as an outage, latent since round 3), none since. Round 33 found no defect in the code, only two test gaps. Every confirmed finding is fixed (rounds 4 to 33: DEC-127 to 284), reverted with its reason (DEC-266), named as a residual below, or waits on Kev. Each fix's test was proven able to fail with an in-memory mutant.
- Who is to blame for an image that was not paid (the two pauses) follows one rule: a void counts against the buyer only for a cause the buyer controls (their cancel, an unsigned order, a refused prompt or image, USDC gone, a payment they sent themselves that failed); everything else, including any provider or judge failure whose cause is unclear, is Enki's (`provider_failed`).

## Open, for you

1. **Device test**, never done on real hardware:
   - Phantom (desktop) and the Android wallet app: one and four images, declining in the wallet, and "Tap again" after a reload;
   - after a reload, "Check existing payment" must clear the order.
2. **Decisions waiting on Kev**:
   - an artist's prompt refused for its own content is counted against the buyer, who never sees the text: by the provider's content filter (DEC-145), and by our own moderation at the render (round 28, DEC-266); not counting it opens a loop Enki pays for, so the fix is a product change (for example pausing such a prompt for review);
   - an admin list for refund-owed rows (today they show only in a person's failure history in admin People);
   - checking the concurrency cap before the paid prompt and reference checks (DEC-175).
3. **Known residuals** (in the DEC entries): the 8-per-buyer cap counts the session owner, not the paying wallet; two orders of one buyer opened at the same moment can both pass /authorize's coverage (it runs outside open_intent_batch's lock), and /submit's coverage then refuses one of them, voided "rejected" and counted: the over-order is the buyer's (two orders, one balance), only which order fails depends on timing; refusing it at /authorize with nothing opened needs the USDC sum under that lock, a migration (DEC-274); a node minutes behind a nonce's creation could still answer "gone" (DEC-157, DEC-163); a capture judged while a node lags is voided as Enki's by the sweep, losing the buyer's blame (after three re-reads, DEC-166); escrow's status route fails on a delivered unit whose image row is gone; the Enki-side voids on a database error (DEC-183, DEC-185) are writes too, so an outage that fails them leaves the units to the buyer's cancel or the sweep; /submit's answer after an RPC failure still says "Nothing was charged" if a payment the buyer broadcast themselves landed: the chain cannot be asked then (DEC-198; the refund row is still written); a shared address still over its per-address limit after the client's one resend leaves a /submit's units to the sweep and a render's unit to the batch's cancel, counted as the buyer's (DEC-222); a unit voided "rejected" whose own broadcast landed counts toward the dropped pause until its void is settled and booked (DEC-181) (DEC-194); a creator renaming a slot between a buyer's load and the render makes that buyer's refused units count as theirs (DEC-208); a slider's shortest value is taken as one character, a lower bound (DEC-209, DEC-212, DEC-214: checkboxes and optional multi-selects send nothing, an image its stored default, a pick the shortest of its options and its default); WaveSpeed documents no prompt limit, so a prompt it refuses for length stays a request voided as Enki's (DEC-210); an embedded (CDP) wallet that fails to sign twice (CDP down, or our wallet token route answering 503) cancels the order as the buyer's, counted toward the 13-unit pause, because the server cannot tell that /cancel from a take-back (Kev, 2026-10-21: kept as a residual, with one retry; DEC-257, DEC-258); a refusal before the render claims its unit settles the void after the answer, so a payment of that unit the buyer broadcast themselves is still answered "Nothing was charged" there, and only the order status and the refund row (written by the settle) show it (DEC-259).

## Before the intent rail takes mainnet orders (Kev)

- `SOLANA_PLATFORM_WALLET` must be a wallet whose key we hold. The current A8fc8 treasury key is lost.
- That wallet needs a USDC account. Send it any USDC once. Until it has one, `/authorize` refuses with "Payments are paused for a moment on our side".
- `SOLANA_PAYMENT_CHAIN=solana` and `NEXT_PUBLIC_SOLANA_PAYMENT_CHAIN=solana`. The second one decides which chain the phone wallet signs for.
- `SOLANA_ESCROW_PROGRAM_ID`: unset, or a mainnet id once escrow v2 is deployed. A devnet id on mainnet falls back to intents.
- The fee payer needs SOL. Each open unit parks about 0.00145 SOL of rent until its nonce closes and spends about 0.000055 SOL of fees; `/authorize` opens only what the balance carries above 0.01 SOL kept for x402.

## Where things are

| | |
|---|---|
| Rail switch | `lib/payments/rail.ts` |
| Checkout (authorize, submit, status, cancel) | `lib/payments/intent-checkout.ts` |
| Limits and coverage | `lib/payments/authorize-flow.ts` |
| Claim, capture, sweeps | `lib/payments/authorization.ts`, `lib/payments/settle.ts` |
| Transaction build | `lib/payments/authorize-tx.ts` |
| Generate route | `app/api/generate-image/route.ts` |
| Browser checkout | `lib/generation-checkout.ts` |
| Signer | `hooks/usePaymentSigner.ts` |
| Migration | `migrations/2026-10-18-intent-rail.sql` (PGlite test: `lib/__tests__/intent-rail-migration.test.ts`) |

When you touch `app/api/generate-image/route.ts`, run every test that reads it (`grep -l "generate-image" lib/__tests__`). Source pins live in about 10 files.
