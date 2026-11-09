# Escrow v2: referrer and author shares, paid by the buyer's own transaction

Status: specification for the program change (Kev's decision, 2026-10-14). The
x402 rail already pays these shares without a program change (see §6); the
web rail waits for this program version.

## 1. The rule

A prompt referred from a post on X ("Refer a prompt") earns two people a share
of Enki's fee on every render of that prompt. Nothing is ever held by Enki:
every share leaves the buyer's own transaction, straight to a wallet or to a
vault the program alone controls. This is what keeps Enki out of custody.

Enki's fee today is 10 % of the subtotal (`PRICING_POLICY.enkiFeeBps`). Of
that fee, per render of a referred prompt:

| | Enki | Referrer | Author |
|---|---|---|---|
| from the import on, before the author claimed | 50 % | 25 % | 25 %, into the author's vault |
| after the author claimed | 50 % | 0 | 50 %, straight to the author's wallet |

Amounts are floored to whole micro-USDC; what rounding leaves stays in Enki's
leg, so the legs always add up to the quoted total. The model cost is Enki's
leg as before (it pays the provider); the shares are of the fee only.

- Referrer = the Enki account that referred the post (`hunt_submissions.hunter_user_id`).
  Its Solana wallet is read like an artist's payout wallet (`artistPayoutWallet`).
  Without a Solana wallet there is no referrer leg: nothing is held for later.
- Author = the X account that wrote the post. Identified by X's numeric user id
  (`hunt_submissions.source_author_id`), never by the handle: handles change and
  are reused. Before the claim the author has no wallet, so the share goes into
  a vault per author (§2). After the claim it goes to the claimant's wallet.

## 2. The author vault (new)

One per X author, not per prompt: every imported prompt of the same author pays
into the same vault, and a claim empties it once.

- Owner: a PDA of the escrow program, seeds `["author", u64 little-endian X user id]`.
- Token account: the USDC associated token account of that PDA (off-curve owner).
  Creating it is permissionless, so the frontend's fee payer creates it at the
  first payment that needs it (the x402 route already fronts missing ATAs); the
  program needs no instruction for that. Rent ≈ 0.002 SOL once per author.
- The program can move funds out of the vault in exactly one way: §4
  `claim_author_vault`, to the claimant's wallet. Never to the treasury, never
  to the operator, never anywhere else. This is the property that makes the
  vault non-custodial for Enki: Enki attests who the author is, it cannot take.

## 3. Escrow account v2

Today: `recipient_count: u8`, `recipient_owners: [Pubkey; 2]`, `unit_amounts: [u64; 2]`
(slot 0 treasury, slot 1 artist, the artist slot empty for a free prompt).

v2: four slots, same shape, so a free prompt without shares still uses one slot.

| slot | owner | unit amount |
|---|---|---|
| 0 | treasury (config) | model cost + Enki's part of the fee |
| 1 | artist (the prompt's creator payout wallet) or empty | artist price (0 on a free prompt) |
| 2 | referrer wallet or empty | 25 % of the fee before the claim, else 0 |
| 3 | author wallet (claimed) or the author vault PDA, or empty | 25 % before the claim, 50 % after |

- `recipient_count` is the number of leading non-empty slots the deposit named;
  an empty slot has `EMPTY_RECIPIENT` and amount 0, and slots after the count
  must be empty (as today for slot 1).
- The invariants of v1 stay: `sum(unit_amounts) == unit price`, funded total
  `== units × unit price`, slot 0 owner `== config.treasury_owner`
  (`TreasuryMismatch`), a non-empty slot has a non-zero amount and vice versa
  (`ArtistMismatch` today; one error per slot or one generic `RecipientMismatch`).
- `settle(k)` pays `k × unit_amounts[i]` to each slot's token account, for
  `i < recipient_count`, and refunds the rest to the buyer as today. The
  recipients' token accounts are passed as remaining accounts in slot order;
  settle must verify each is the ATA of the slot's owner for the mint.
- `reclaim` / refunds are unchanged: everything not settled goes back to the buyer.
- Account size grows by 2 × (32 + 8) = 80 bytes; rent is paid by the rent payer
  (operator) as today.

## 4. Two new instructions

`claim_author_vault(x_user_id: u64, claimant: Pubkey)`
- Signer: `config.operator` (the attestation: Enki verified off-chain that the
  claimant's Enki account owns the X account with this id, see §5).
- Accounts: config, the author PDA (seeds above), its USDC token account, the
  claimant's USDC ATA (created idempotently by the instruction if missing, rent
  from the operator), token program, associated token program, system program.
- Effect: transfers the vault's whole balance to the claimant's ATA. Idempotent:
  a second call with an empty vault succeeds and moves nothing.
- Refused when `claimant == config.treasury_owner` or `claimant == config.operator`
  (`VaultToTreasury`): the vault can only ever go to an author.
- Optional but useful: a small `AuthorClaim` account at seeds `["claim", x_user_id]`
  recording `claimant` and the slot, so a later claim by another wallet is
  refused unless the operator explicitly re-attests (`AlreadyClaimed`). Nyx
  decides whether to store this on chain or trust the database alone.

`create_author_vault` is not needed: the ATA is created permissionlessly by
whoever pays first (§2). If Nyx prefers an explicit instruction for symmetry,
it only creates the ATA and must be callable by anyone.

## 5. The claim, off chain

1. The author signs in to Enki and proves the X account: "Log in with X"
   (OAuth) is the proof; if X's free tier does not allow it, the fallback is a
   code the author posts from the account, which Enki reads through FxTwitter.
2. Enki records `hunt_submissions.claimed_by_user_id` / `claimed_at` for every
   row with that `source_author_id`, and the operator sends `claim_author_vault`
   with the claimant's Solana payout wallet.
3. From the next deposit on, the frontend puts the claimant's wallet into slot 3
   with 50 % of the fee, and leaves slot 2 empty.

Built 2026-10-17 (steps 1 and 2, not the operator's `claim_author_vault`): the X
account connected in Settings is the proof; `POST /api/referrals/claim` records the
user on every unclaimed referral of that X id (`lib/referral/claim.ts`), and
`sharesOf` lets a later referral of the same author follow the newest claim. The
x402 rail pays claimed shares to the wallet from then on; the vault balance shows
read-only in Settings until the release exists.
The payee is the user who holds the X account now and claimed it; while nobody does
(a disconnect, a password reset, a deleted account), the author's half goes into the
vault and the referrer's quarter stays ended: a recorded claim never hands it back.

Enki never holds the author's money; it holds a fact (which wallet is the
author's) and tells the program. This is an oracle role, not custody; the
program's refusal to pay the treasury (§4) is the argument. A lawyer with MiCA
experience should read the ToS sentences before the claim goes live.

## 6. The x402 rail (already live, no program)

Since 2026-10-17 Enki sells the render on x402 (Kev: "verkäufer-modell für
künstlerprompts"): an agent pays the whole price to Enki in one
`TransferChecked`, and the artist (if priced), referrer and author (vault or
wallet) shares, with the same amounts as §1, become licence fees Enki owes. They
are written to `licence_credits` once the render was delivered (one row per
payment and role) and paid out later; a withheld or failed render owes nothing.
Until 2026-10-17 each share was a leg of the buyer's own transaction. Code:
`lib/referral/shares.ts` (`shareLegs`, `authorVaultOwner`, `sharesOf`) and
`lib/payments/licence-credits.ts`, used by `app/api/x402/generate/route.ts`.

## 7. Rollout

1. Nyx: program v2 on devnet at the SAME program id (an upgrade, so the author
   PDA seeds keep their owner), IDL exported, CI green.
2. Frontend: re-pin the IDL, regenerate the client, deposit plan with four
   slots, confirmation and lifecycle checks on four slots, the escrow route
   reads `sharesOf` like the x402 route does.
3. In-flight v1 escrows: let them settle or reclaim before the upgrade (the
   cutover guard pattern from the escrow activation), or carry a version byte;
   Nyx's call.
4. Devnet acceptance: an imported prompt rendered three times (before claim,
   after claim, and with a referrer without a wallet), the vault balance and the
   wallets checked after each.

## 8. What is deliberately not here

- No internal ledger of owed amounts (custody). Bookkeeping of what was paid on
  chain may come later and is just a record.
- No retroactive payment for renders before a claim: those shares went to the
  vault, which the claim empties; nothing is owed beyond it.
- No share on prompts that were not referred.
