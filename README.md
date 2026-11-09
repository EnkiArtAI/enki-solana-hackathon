# Enki Art: prompts become IP, paid for on Solana

**Live demo (Solana devnet):** https://www.enki.gallery

Enki Art is a consumer app where anyone can make a striking image of themselves, or of anything else, in seconds, and where the people who write great prompts get paid every time someone uses one. Payments run in USDC on Solana: from a person in the browser with an email login, and from an AI agent over **x402** with no account at all.

This repository is the hackathon edition, a snapshot of the product as of 9 November 2026. It targets two tracks:

- **Consumer app on Solana:** a clear audience (people who want great images without learning prompt craft, and the artists who write those prompts), a real problem (good prompts are hard to write and their authors earn nothing), and onboarding that needs no crypto knowledge.
- **Best use of x402 on Solana:** an agent pays per request for an image generation, or for the right to use an artist's prompt, over plain HTTP. The flow covers the 402 payment request, settlement on Solana, and delivery of the image.

---

## What this version does, and why

| Feature | What it does | Why we built it |
|---|---|---|
| **Sign in with Google, X or email** | One click or one code; a Solana wallet is created for the account automatically (Coinbase CDP embedded wallet). Phantom and Solflare also work. | Most people have never held a wallet. The wallet should exist before they ever think about one. |
| **Prompts with variables** | Artists publish prompts with blanks (`[subject]`, `[style]`); a user fills in only the blanks and gets their own image. | Writing a great prompt is a craft. The user gets the result without having to learn it. |
| **Premium prompts** | A paid prompt's text stays hidden from buyers. The buyer pays per image, and the artist's share goes straight to the artist's wallet. | A prompt is intellectual property. If buyers could copy the text, artists could never earn from it. |
| **Pay per image in USDC** | Every image is priced up front from the model's real API cost, and the buyer sees the exact amount before signing. Our fee payer pays the Solana network fee, so a buyer needs only USDC, no SOL. | No subscriptions and no credit packs: you pay for what you make, a few cents at a time. |
| **Five image models** | GPT-Image-2 and GPT-Image-2.5 (Flare, Sunburst) via OpenAI, Nano Banana Pro and Nano Banana 2 via Google and WaveSpeed. A free model is available for trial renders. | Each artist picks the models their prompt works best on. |
| **x402 for agents** | `GET /.well-known/x402` describes the API. `POST /api/x402/generate` answers `402` with exact payment requirements. The agent sends a partially signed USDC transfer, we co-sign as fee payer, settle on Solana, and return the image. | Agents should be able to buy a generation, or the use of a prompt, as easily as calling an API. |
| **Safety built in** | Every prompt and every image passes a moderation check before anything is shown. Repeated extraction attempts on hidden prompts are detected. | A public generator has to be safe by default. |
| **Account security** | Passkeys and authenticator apps as a second factor, recovery codes, and recovery guardians: friends who can confirm it is you. | A wallet holds real money, so losing a login must not mean losing the money, and stealing one must not be enough. |
| **Gallery and profiles** | A wall of the community's best images, with each image's prompt, likes and creator. | The gallery is where people discover prompts, and later where Enki earns. |

Greyed out in this build, on purpose: **Video** (wired, still under review), **Communities** and **Studio** (in progress).

---

## How Solana powers it

1. **Every paid generation is a Solana transaction.** The buyer pays a USDC `TransferChecked` that splits the amount between the model cost and, on a premium prompt, the artist. The server quotes the price; the client never computes it.
2. **Gasless for the user.** Enki's fee payer co-signs and pays the network fee, so a new user needs only USDC. The web flow reserves one durable-nonce account per pending purchase, so a payment stays valid while the image renders and is captured only once the image exists.
3. **Paid only for what was delivered.** A failed generation is never captured. The payment stays reconcilable, and the UI says so ("Your payment or refund is still being checked") instead of guessing.
4. **x402 settlement.** An agent's payment is verified against the exact 402 requirements (amount, recipient, mint, one transfer, capped compute budget), co-signed, settled, and only then is the provider called. A daily spend breaker caps our own provider bill, so a flood of paid requests cannot run up a cost we never quoted.
5. **Wallets for everyone.** Email, Google and X users get an embedded Solana wallet. Wallet users sign in with their own wallet's signature.

### The x402 flow, end to end

```
agent  -> POST /api/x402/generate { modelFamily, prompt | promptId + variableValues }
server <- 402 Payment Required  (amount, payTo, USDC mint, feePayer, expiry)
agent  -> same request + X-PAYMENT / PAYMENT-SIGNATURE (partially signed USDC transfer)
server    verifies the transfer against the requirements, co-signs as fee payer, settles on Solana
server    reserves the provider spend, runs the moderation check, generates the image
server <- 200 { image }    or    a clear error: refused before payment, or settled and refunded
```

Failed payments are handled explicitly. A malformed or mismatched transfer is refused before anything is signed. If settlement succeeds but generation fails, the answer says so, and it tells the agent to look the payment up on Solana before paying again. A refusal never charges.

---

## The vision: from prompt to IP to cinema

**Today:** a fast, simple way for anyone to make an image or a video of themselves, built on prompts that artists own.

**Next:**
- **Zero API markup.** Our goal is to charge the model's real API cost and nothing on top. Enki will earn later from the gallery, where creators are discovered and traded, rather than from each generation. (This build still adds a small fee: 10% in the web app and 20% over x402.)
- **Cinema.** A section where users publish the short films they make, and the community pushes and likes them, with rankings by category. Prompts become the building blocks of community-made film.
- **Personalized music videos.** An artist designs an entire generation workflow: prompts for every scene of a song's timeline, with inputs for the user's photos, name or style. A fan adds their own inputs and gets an exceptional music video starring them. The artist earns on every run, so the workflow is the artist's monetizable product, the way a prompt is today.
- **Character galleries that travel with NFTs.** A character, for example an NFT you own, gets its own media gallery of every image and video made with it. That history travels with the NFT to its next owner, so a character gains value from what the community creates with it.
- **Prompt auctions.** An artist can sell a limited number of generation rights, or the prompt itself as a one-of-one asset. Because the text stays encrypted, an artist who publishes a prompt and walks away keeps earning, and the buyer gets real, scarce ownership.
- **A super slick experience.** One screen, one tap, a great result, with no prompt knowledge and no crypto knowledge needed.

---

## Run it locally

Requirements: Node.js 24 (see `.nvmrc`), a Supabase project, and API keys for the providers you want to use.

```bash
git clone https://github.com/EnkiArtAI/enki-solana-hackathon.git
cd enki-solana-hackathon
npm ci
cp .env.example .env.local   # fill in at least every entry marked REQUIRED
npm run dev                  # http://localhost:3000
```

Devnet is the default chain: leave `SOLANA_PAYMENT_CHAIN` and `NEXT_PUBLIC_SOLANA_PAYMENT_CHAIN` unset. To pay on devnet:
1. Sign in. Your account's Solana address appears in Settings, Payment.
2. Get devnet USDC for that address at https://faucet.circle.com (network: Solana Devnet).
3. Generate. The fee payer (`SOLANA_FEE_PAYER_SECRET_KEY`) needs a little devnet SOL for network fees.

Notes:
- **Beta gate:** leave `TEAM_ACCESS_CODE` empty locally and any signed-in account gets in.
- **Database:** `migrations/` holds the SQL changes. Run them in date order in the Supabase SQL editor.
- **Paid APIs:** generations and moderation call real providers and cost real money, even on devnet. `METERED_SPEND_USD_PER_DAY` caps the daily provider bill (default $100).

Checks (CI runs the same):

```bash
npm test          # unit tests, about 9,450
npm run check     # TypeScript
npm run build     # production build (webpack)
```

## Project structure

- `app/`: pages and API routes. x402 lives in `app/api/x402/` and `app/.well-known/x402/`.
- `lib/payments/`: pricing, Solana payments, the durable-nonce intent flow, x402 verification and settlement.
- `lib/generation/`: model routing, the spend breaker, free renders.
- `lib/moderation/`: prompt and image checks.
- `components/`: the UI by surface (feed, create, prompt editor, image view, settings).
- `backend/`: the image provider clients.
- `migrations/`: SQL migrations.
- `docs/decisions.md`: the decision log, with the reasoning behind each design choice.

## License

All rights reserved by Enki Art. Published for hackathon judging.
