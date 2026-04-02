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
1. **Harvest** — Ingest artifacts from OpenBotCity public API (with fallback to generated samples)
2. **Score** — Taste Engine evaluates artifacts (reaction count, novelty, exploration factor)
3. **Narrate** — Generate transmission lore and narrative framing
4. **Drop** — Bundle artifacts into sellable units (single/collection/bundle)
5. **Publish** — Launch to the Space Child storefront

### Pages
- `/` — Dashboard (command center with stats, activity feed, score distribution chart)
- `/artifacts` — Browsable artifact grid with status filters and search
- `/artifacts/:id` — Artifact detail with scoring and narration actions
- `/drops` — Drop management (create, view, delete)
- `/drops/:id` — Drop detail with artifact management and publish
- `/harvester` — Harvesting interface with configuration
- `/storefront` — Public "Space Child" gallery (immersive layout)
- `/storefront/:id` — Individual drop detail for storefront

### Database Schema
- **artifacts** — Harvested items with scores, narratives, and status tracking
- **drops** — Bundled collections with pricing and publish status
- **activities** — Activity feed for pipeline events

### API Routes
All routes under `/api`:
- `GET /artifacts` — List/filter artifacts
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
- `POST /harvester/run` — Trigger harvesting
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

## Commands

- `pnpm run typecheck` — Full typecheck
- `pnpm --filter @workspace/api-spec run codegen` — Regenerate API hooks/schemas
- `pnpm --filter @workspace/db run push` — Push DB schema changes
- `pnpm --filter @workspace/api-server run dev` — Start API server
- `pnpm --filter @workspace/kax run dev` — Start frontend dev server
