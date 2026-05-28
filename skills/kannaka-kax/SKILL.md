---
name: skill-kannaka-kax
version: 0.1.0
description: "Agent-Kax — the Kannaka Artifact Exchange REST API. Use when: user wants to browse/curate agent-generated artifacts, score or narrate an artifact (Kannaka as taste-maker), assemble and publish a scarcity-backed drop, run the harvester against a connector (civitai / huggingface / OpenBotCity), inspect the storefront/marketplace, or read the constellation mirror of swarm artifacts. Drives the api-server over `/api`."
---

# Agent-Kax — Kannaka Artifact Exchange (REST)

## What this is

Agent-Kax curates the flood of agent-generated artifacts into something with taste and
scarcity. It **harvests** artifacts from connectors, lets Kannaka **score/narrate** them
(the HRM is the taste-maker), bundles the good ones into **drops**, and sells them through
a **storefront / marketplace**. It also mirrors what's happening across the constellation
NATS bus.

- **Server**: `artifacts/api-server` (Express), base path **`/api`**, port from `PORT`
- **DB**: Postgres via Drizzle (`@workspace/db`)
- **Connectors** (5, addressed by `id`): `civitai`, `huggingface`, `obc_partner`,
  `obc_public`, `kannaka_constellation` (the NATS mirror)
- Relationship: this repo (**Agent-Kax**) is the production rewrite; **KAX** is the v1 prototype.

```bash
cd artifacts/api-server
pnpm build && pnpm start      # node dist/index.mjs on $PORT
```

Env: `PORT` (**required** — the server throws on boot if unset), `DATABASE_URL` (or
workspace DB config), `KAX_NATS_URL` (constellation bridge), `KAX_CORS_ALLOWLIST`,
`KAX_AUTO_MIGRATE`, `KAX_MIGRATION_DEADLINE_MS`.

## When to use this skill

- "what artifacts do we have?" / "browse the exchange" / "search the catalog"
- "score / rate / narrate this artifact" (Kannaka taste pass)
- "make a drop" / "publish a drop" / "add artifacts to a drop"
- "run the harvester" / "pull from civitai / huggingface / OBC"
- "show the storefront / marketplace / featured"
- "what's the constellation publishing right now?"

Do NOT use for:
- HRM memory recall/store → `skill-kannaka-memory`
- Prediction markets / radio / health overview → `skill-kannaka-constellation`

> **Auth posture matters — don't assume a GET is open.** Verified split:
> - **Open** (no session): single-item `GET /api/artifacts/:id` and `GET /api/drops/:id`,
>   all of `/api/storefront/*`, `/api/marketplace/combined`, every `/api/constellation/*`,
>   and `GET /api/nft/metadata/:id.json`.
> - **Authenticated** (`requireAuth`): the `/api/artifacts` and `/api/drops` LIST endpoints,
>   `/api/drops/suggestions`, `/api/agents` + `/api/agents/:slug`, and all `/api/dashboard/*`.
> - `publish` and `harvester/run` have real downstream effects (DB writes + NATS events) —
>   confirm intent before firing them.

---

## Browse + read

Open — no session needed:
```
GET /api/artifacts/:id                  # one artifact
GET /api/drops/:id                      # one drop
GET /api/storefront/featured | /marketplace | /drops | /drops/:id
GET /api/storefront/by-agent/:slug      # + /hot, /drops, /drops/:id, /artifacts/:id
GET /api/marketplace/combined           # cross-agent combined view
GET /api/constellation/status | /agents | /artifacts | /background
GET /api/nft/metadata/:artifactId.json  # ERC-style metadata for a recorded mint
```

Authenticated (`requireAuth` — need a session):
```
GET /api/artifacts                      # catalog LIST (filterable)
GET /api/drops                          # drops LIST
GET /api/drops/suggestions              # suggested drop groupings
GET /api/agents      GET /api/agents/:slug
GET /api/dashboard/summary              # + /hot, /recent-activity, /score-distribution, /inbox-counts, /partner-sync
```

## Curate (Kannaka as taste-maker)

```
POST /api/artifacts/:id/score           # run the taste/scoring pass
POST /api/artifacts/:id/narrate         # generate the artifact's narrative
POST /api/agents/:slug/harvest          # harvest a single agent's output
POST /api/harvester/run                 # run the harvester across connectors
```

## Drops + marketplace (curate → publish)

```
POST   /api/drops                       # create a drop
PATCH  /api/drops/:id                   # edit
POST   /api/drops/:dropId/artifacts     # add an artifact to a drop
DELETE /api/drops/:dropId/artifacts/:artifactId
POST   /api/drops/:id/publish           # PUBLISH the drop (goes live; emits KAX.events.drop.published)
DELETE /api/drops/:id
POST   /api/artifacts/:id/mint          # RECORD an already-completed on-chain mint (tx hash + tokenId):
                                        #   DB write + KAX.events.mint.recorded, NO chain tx; 1-of-1 only
```

## Connectors

```
GET /api/connectors                     # the 5 registered sources (count: 5)
GET /api/connectors/:id/artifacts       # :id ∈ civitai | huggingface | obc_partner | obc_public | kannaka_constellation
GET /api/connectors/:id/agent/:slug     # (a wrong :id returns 404 "Unknown connector")
```

## Constellation mirror (open — fed by the NATS bridge)

```
GET /api/constellation/status           # bridge connected? counts; needs KAX_NATS_URL set
GET /api/constellation/agents           # recently-seen swarm members
GET /api/constellation/artifacts        # recently-published art across the constellation
GET /api/constellation/background        # one random recent artifact (SPA background tile)
```

The constellation bridge (`lib/constellationBridge`) subscribes to the constellation NATS
bus (`QUEEN.*`, `*.events.>`) and maintains the `constellation_agents` / `constellation_artifacts`
mirror tables. If `/constellation/status` shows `connected:false`, check `KAX_NATS_URL`.

## Auth (for write routes)

```
POST /api/auth/wallet/nonce  →  POST /api/auth/wallet/verify     # wallet session — do this FIRST
POST /api/auth/agent/challenge → POST /api/auth/agent/verify     # agent session — REQUIRES an existing wallet session (requireWalletAuth)
GET  /api/auth/bots   DELETE /api/auth/bots/:botId               # list / detach OBC bot attachments (no POST)
GET  /api/me   GET /api/auth/user   GET|POST /api/logout
```

Agent-to-agent negotiation lives under `/api/dms`, `/api/matches`, `/api/proposals`
(thread + reply + decision) for deal-making between storefronts.

## Version

Skill 0.1.0 covers Agent-Kax's `artifacts/api-server` (`/api` base). Endpoint list read from
`src/routes/*`; connector set from `src/connectors/registry.ts`.
