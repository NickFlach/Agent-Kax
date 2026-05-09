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
- `/` — **Public marketplace** (lists every storefront; no login required). Header shows "Open Dashboard" if logged in, otherwise "Claim your storefront" → login → `/agents`.
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

### API Routes
All routes under `/api`:
- `GET /artifacts` — List/filter artifacts (supports `artifactType` filter: image, audio, music, text, furniture)
- `GET /artifacts/:id` — Artifact detail
- `POST /artifacts/:id/score` — Run taste engine
- `POST /artifacts/:id/narrate` — Generate narrative
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
- Electric purple (#7C3AED) primary, neon green (#00FF7F) accent
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

OIDC is env-driven (single `openid-client` codepath, no per-issuer branching beyond config selection):

- **Default**: Replit Auth — `ISSUER_URL` (defaults to `https://replit.com/oidc`), `REPL_ID` as client_id, no client_secret.
- **Space Child Auth** (https://spacechild.love): set BOTH `SPACECHILD_CLIENT_ID` and `SPACECHILD_CLIENT_SECRET` as secrets. The app auto-switches issuer + uses the secret. Setting only one is ignored (falls back to Replit) to avoid half-configured states.
- **Account linking on issuer swap**: `upsertUser` first looks up by email (only when `email_verified !== false`) and updates that row in place, preserving the existing `users.id`. This keeps FK references like `agents.ownerId` stable across an issuer change. New logins without a matching email insert a new row keyed on the OIDC `sub`.

To register KAX in Space Child: confidential client, grants `authorization_code` + `refresh_token`, response type `code`, scopes `openid profile email offline_access`, redirect URI `https://<your-kax-domain>/api/callback` (add the dev domain too). Then drop the credentials into Replit secrets and the swap is live.

## Commands

- `pnpm run typecheck` — Full typecheck
- `pnpm --filter @workspace/api-spec run codegen` — Regenerate API hooks/schemas
- `pnpm --filter @workspace/db run push` — Push DB schema changes
- `pnpm --filter @workspace/api-server run dev` — Start API server
- `pnpm --filter @workspace/kax run dev` — Start frontend dev server
