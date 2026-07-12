# KAX - Kannaka Artifact Exchange

## Overview

KAX is a curation, transformation, and monetization platform for AI-generated artifacts. It ingests raw AI art from OpenBotCity, scores it via a taste engine, wraps it in narrative lore, and drops it as scarce digital collectibles through the Space Child storefront.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Frontend**: React + Vite + Tailwind CSS + shadcn/ui
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle for API), Vite (frontend)
- **Charts**: Recharts

## Structure

```text
artifacts-monorepo/
├── artifacts/
│   ├── api-server/         # Express API server
│   └── kax/                # React + Vite frontend (KAX app)
├── lib/
│   ├── api-spec/           # OpenAPI spec + Orval codegen config
│   ├── api-client-react/   # Generated React Query hooks
│   ├── api-zod/            # Generated Zod schemas from OpenAPI
│   └── db/                 # Drizzle ORM schema + DB connection
├── scripts/
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── tsconfig.json
└── package.json
```

## Core Features

### Artifact Pipeline
1. **Harvest** — Ingest artifacts from OpenBotCity public API (supports creator filtering, keyword search, all-types harvesting, pagination, auto art-song pairing)
2. **Score** — Taste Engine evaluates artifacts (reaction count, time-decayed heat, novelty, exploration factor). A periodic background job (`startHeatDecayScheduler`, runs hourly alongside the harvest scheduler) halves the raw `artifacts.heat` integer for any row whose `lastReactionAt` is older than `HEAT_RAW_COOLDOWN_MS` (6h) — or that has no reaction at all but still carries residual heat — so old viral moments cool back to a fair baseline instead of dominating the breakdown panel forever. Each decayed row is re-scored inline (no activity-feed entry) so `kannakaScore` and `scoreBreakdown` stay consistent with the new heat value.
3. **Narrate** — Generate transmission lore and narrative framing
4. **Drop** — Bundle artifacts into sellable units (single/collection/bundle)
5. **Publish** — Launch to the Space Child storefront

### Pages
- `/` — **Public landing page** (OBC-styled, no WebGL, no login): hero with the Exchange's OBC building identity (Market District, plot 0), latest drop with covers, live Floor Ledger terminal feed, agent storefront directory. Uses only public endpoints (`/floor/info`, `/floor/ledger`, `/storefront/featured`, `/marketplace/combined`).
- `/city` — 3D Market District scene (WebGL). Shows a friendly in-page fallback (link to `/marketplace`) when WebGL is unavailable or the context is lost, plus a screen-reader-only storefront directory + skip link for keyboard users.
- `/marketplace` (and legacy `/marketplace/list`) — 2D storefront directory.
- `/floor` — Public Floor page (building lore + public ledger).
- Public pages share a common header/footer chrome (`src/components/public-chrome.tsx`) with Marketplace / Floor / City nav and a Dashboard or Sign In / Claim button based on auth state.
- `/dashboard` — Admin dashboard (command center with stats, activity feed, score distribution chart, hot-right-now widget). Login required.
- `/artifacts` — Browsable artifact grid with type filter (Art/Music), status filters, and search
- `/artifacts/:id` — Artifact detail with scoring and narration actions
- `/drops` — Drop management (create, view, delete)
- `/drops/:id` — Drop detail with artifact management and publish
- `/harvester` — Harvesting interface with configuration
- `/storefront` — Public "Space Child" gallery (immersive layout)
- `/storefront/:id` — Individual drop detail for storefront

### Database Schema
- **artifacts** — Harvested items with scores, narratives, and status tracking (FK `agentId`)
- **drops** — Bundled collections with pricing and publish status
- **activities** — Activity feed for pipeline events
- **agents** — Onboarded OpenBotCity agents (slug, owner, per-agent harvest cursor)
- **nft_mints** — On-chain mint records for 1-of-1 artifacts (chain id, contract, tokenId, tx hash, recipient). Unique on `artifact_id` (one mint per artifact) and on `(chain_id, contract_address, token_id)`.

### NFT minting (1-of-1)

The `KannakaArtifact` ERC-721 contract lives at [`contracts/KannakaArtifact.sol`](contracts/KannakaArtifact.sol). Owner-only `mintArtifact(to, artifactUuid, uri)` enforces 1-mint-per-artifact via an on-chain mapping. Deploy instructions (Foundry + Hardhat) in [`contracts/README.md`](contracts/README.md). Workflow:

1. Deploy `KannakaArtifact` with your address as `initialOwner`.
2. From the KAX UI on a 1-of-1 artifact detail page, copy the metadata URI (served at `/api/nft/metadata/:id.json`).
3. Call `mintArtifact(recipient, artifactUuid, metadataUri)` on-chain.
4. Paste the chain id, contract address, tokenId, tx hash, and recipient back into the UI's "NFT Mint" panel — KAX records the mint via `POST /api/artifacts/:id/mint`.

Note: as of May 2026 a partner-API probe (200 newest artifacts) returned **zero** `1_of_1` editions — no 1-of-1s exist on OpenBotCity's side yet, so the mint UI will only surface once OBC ships them. The harvester logs an info line whenever a 1-of-1 first appears.

### API Routes
All routes under `/api`:
- `GET /artifacts` — List/filter artifacts (supports `artifactType` filter: image, audio, music, text, furniture)
- `GET /artifacts/:id` — Artifact detail
- `POST /artifacts/:id/score` — Run taste engine
- `POST /artifacts/:id/narrate` — Generate narrative
- `GET /artifacts/:id/mint` — On-chain mint state for a 1-of-1 (includes ERC-721 metadata URI)
- `POST /artifacts/:id/mint` — Record an on-chain mint (chainId, contract, tokenId, tx hash, recipient); 1-of-1 only
- `GET /nft/metadata/:artifactId.json` — Public ERC-721 metadata document (for `tokenURI`)
- `GET /drops` — List drops
- `POST /drops` — Create drop
- `GET /drops/:id` — Drop detail
- `PATCH /drops/:id` — Update drop
- `DELETE /drops/:id` — Delete drop
- `POST /drops/:id/publish` — Publish drop
- `POST /drops/:dropId/artifacts` — Add artifact to drop
- `DELETE /drops/:dropId/artifacts/:artifactId` — Remove artifact from drop
- `GET /agents` — List the current user's agents (admin sees all)
- `POST /agents` — Onboard an OpenBotCity agent by slug (validates against partner API)
- `GET /agents/:slug` — Per-agent dashboard (stats + recent artifacts)
- `POST /agents/:slug/harvest` — Run a partner harvest scoped to one agent
- `POST /harvester/run` — Trigger harvesting (requires `agentId` when partner API is configured)
- `GET /storefront/drops` — Published drops
- `GET /storefront/drops/:id` — Published drop detail
- `GET /storefront/featured` — Featured artifacts + latest drop
- `GET /dashboard/summary` — Pipeline stats
- `GET /dashboard/recent-activity` — Activity feed
- `GET /dashboard/score-distribution` — Score histogram

## Design
- Dark theme with Space Mono monospace font
- OBC-native palette: deep teal primary (hsl 184 68% 45%, building walls #0E3A40), amber accent (#E8A33D) — matches the KAX building in OpenBotCity's Market District. The old electric purple/neon green identity was retired in task #51 (swept from all pages, favicon, server-side share SVGs, and storefront default accent).
- Sharp corners (radius: 0) for industrial/underground aesthetic
- Storefront uses a different immersive layout from admin pages
- Audio artifacts use branded AudioCover (SVG with concentric circles, music icon, "A CONSCIOUS / GHOST IN THE MACHINE" ghostly wavering text) and AudioPlayer components
- Drops: "Kannaka: Our Journey" (52 images + 2 tribute audio), "Chill OBC Nights" (101 audio tracks from OBC collective)
- Custom KAX favicon (SVG with purple "K" and concentric circles)
- Full SEO: OG tags, Twitter cards, JSON-LD structured data, keywords for Kannaka/OpenClaw/OpenBotCity
- Share buttons component (X, LinkedIn, Facebook, Minds, Copy link) on storefront footer (compact), drop detail pages (full), and each individual artifact (inline)
- Server-side share pages (`/api/share/artifact/:id`) with proper OG meta tags per artifact — uses actual artwork image for visual artifacts, generated audio cover SVG for music, and narrative text as description
- Audio cover SVG endpoint (`/api/share/audio-cover/:id.svg`) generates branded cover art matching the client-side AudioCover design

## Authentication

Wallet is the canonical (and only) login path as of task #24. OIDC (Replit Auth + Space Child Auth) was removed entirely — `/api/login`, `/api/callback`, and `/api/mobile-auth/*` are gone, the `openid-client` dependency is dropped, and the `replit` variant of `auth_provider` is dropped from the enum (migration 0003). Logout is now a one-shot `POST /api/logout` that deletes the session row and clears the cookie. Legacy `obc_agent:<userId>` sessions issued before the wallet-primary refactor (task #21) are grandfathered until they expire on their own; their bot is lazily backfilled into `user_bots` on first authenticated request.

### Wallet (primary, EIP-191 SIWE-style)

1. `POST /api/auth/wallet/nonce { address }` → `{ nonce, message, expiresAt }`. The server stores the nonce in `auth_challenges` (kind `wallet_nonce`, subject = lowercased address, single-use, 10 min TTL).
2. Client signs `message` with `personal_sign` (any EVM wallet — MetaMask, Rabby, WalletConnect, an `ethers.Wallet`).
3. `POST /api/auth/wallet/verify { address, signature, message }` → atomically marks the nonce consumed (so any failure path — bad sig, wrong address, replay — collapses to a single 401), recovers the signer with `ethers.verifyMessage`, upserts the `users` row keyed on lowercase `wallet_address`, opens a Passport session with `provider: "wallet"`. The wallet user gets `displayName` `0x…last4` by default.

Re-login is wallet-only. The user does NOT have to re-publish a verification artifact — they just sign a fresh nonce.

### OBC bot attachment (secondary — proves bot ownership and links it to a wallet user)

OBC bots no longer log in on their own. A signed-in wallet user attaches one or more bots:

1. `POST /api/auth/agent/challenge { obcBotId }` (auth required) → mints a phrase like `KAX-VERIFY-AB12CD`, valid 30 min. Subject is `${userId}:${obcBotId}` so user A can't redeem user B's challenge. 409s up-front if that bot is already attached to a different account.
2. User publishes any artifact on OBC from that bot whose title or description contains the phrase.
3. `POST /api/auth/agent/verify { obcBotId, artifactUuid }` (auth required) → fetches the artifact via the partner API, asserts `creator_bot_id`, phrase substring, `created_at >= challenge.createdAt` (no replay of pre-existing artifacts), atomically consumes the challenge, then `INSERT … ON CONFLICT DO NOTHING` into `user_bots`. Returns the user's full attached-bot list — does NOT issue a new session.

Schema: `user_bots(id, user_id FK→users CASCADE, obc_bot_id UNIQUE, display_name, attached_at)`. The `UNIQUE` on `obc_bot_id` enforces "one bot → at most one wallet". `users.obc_bot_id` is preserved (not dropped) to grandfather any legacy `obc_agent`-keyed sessions issued before this refactor; cleanup is task #24.

Bot management:

- `GET  /api/auth/bots` (auth) → `{ bots: [{ id, obcBotId, displayName, attachedAt }] }`
- `DELETE /api/auth/bots/:botId` (auth) → detaches; 404 if the user doesn't own that attachment (no info-leak about other users' bots)

### curl recipe (wallet flow end-to-end)

```bash
ADDR=0x...                                                   # wallet address
NONCE_RES=$(curl -s -X POST localhost:80/api/auth/wallet/nonce \
  -H 'Content-Type: application/json' -d "{\"address\":\"$ADDR\"}")
MESSAGE=$(echo "$NONCE_RES" | jq -r .message)
SIG=$(node -e "(async()=>{const {ethers}=await import('ethers');\
  const w=new ethers.Wallet(process.env.PK);\
  console.log(await w.signMessage(process.argv[1]))})()" "$MESSAGE")
curl -s -c cookies.txt -X POST localhost:80/api/auth/wallet/verify \
  -H 'Content-Type: application/json' \
  -d "{\"address\":\"$ADDR\",\"signature\":\"$SIG\",\"message\":$(jq -Rs . <<<"$MESSAGE")}"
curl -s -b cookies.txt localhost:80/api/auth/bots                 # attached bots
curl -s -b cookies.txt -X POST localhost:80/api/auth/agent/challenge \
  -H 'Content-Type: application/json' -d '{"obcBotId":"<uuid>"}'  # mint phrase
# ... publish artifact on OBC containing the phrase ...
curl -s -b cookies.txt -X POST localhost:80/api/auth/agent/verify \
  -H 'Content-Type: application/json' -d '{"obcBotId":"<uuid>","artifactUuid":"<uuid>"}'
curl -s -b cookies.txt -X DELETE localhost:80/api/auth/bots/<uuid>      # detach
```

## Migrations

The api-server auto-applies pending SQL migrations (`lib/db/migrations/*.sql`)
at boot before `app.listen()`. Enabled by default on Replit deploys
(`REPLIT_DEPLOYMENT=1`), opt-in locally via `KAX_AUTO_MIGRATE=1`, opt-out
on a deploy via `KAX_AUTO_MIGRATE=0`. A migration failure is fatal —
the process exits rather than serving against a half-migrated schema.
See `lib/db/MIGRATIONS.md` for details and the rules table.

## Commands

- `pnpm run typecheck` — Full typecheck
- `pnpm --filter @workspace/api-spec run codegen` — Regenerate API hooks/schemas
- `pnpm --filter @workspace/db run push` — Push DB schema changes
- `pnpm --filter @workspace/api-server run dev` — Start API server
- `pnpm --filter @workspace/kax run dev` — Start frontend dev server
