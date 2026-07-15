#!/bin/bash
set -e
pnpm install --frozen-lockfile

# Apply schema changes with the hand-rolled, idempotent migration runner —
# NEVER `drizzle-kit push`. Prod's schema is the source of truth managed by
# lib/db/migrations/*.sql via src/migrate.ts (see drizzle.config.ts for why).
#
# `drizzle-kit push` cannot express the `ALTER TYPE ... ADD VALUE 'prediction'`
# that migration 0009 applied: it tries to REBUILD the floor_deal_kind enum via
# a column cast and fails with
#   invalid input value for enum floor_deal_kind: "prediction"
# on the rows that already, correctly, use that value. That is what broke the
# post-#74 deploy on 2026-07-14.
#
# Non-fatal by design: the api-server also auto-migrates at boot
# (REPLIT_DEPLOYMENT=1), so a hiccup here must never block a merge/deploy.
pnpm --filter db run migrate || echo "[post-merge] migrate reported an issue (non-fatal; boot auto-migrate will retry)"
