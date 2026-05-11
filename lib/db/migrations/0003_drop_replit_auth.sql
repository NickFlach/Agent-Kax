-- 2026-05-11 — task #24: strip Replit OIDC from the auth surface.
--
-- The `replit` variant of `auth_provider` is gone — every user is
-- either `wallet` (SIWE) or `obc_agent` (grandfathered legacy
-- session). Apply manually:
--   psql $DATABASE_URL -f 0003_drop_replit_auth.sql
-- (or `pnpm --filter @workspace/db run push`, which syncs the
-- drizzle schema and arrives at the same end state).
--
-- Migration order:
--   1. Re-point any users still flagged `replit` onto `wallet` (the
--      new default). They have no wallet_address yet — they'll have
--      to sign in with their wallet to bind one. Their existing
--      session, if still valid, continues to work because session
--      validity is governed by `sessions.expire`, not by
--      `users.auth_provider`.
--   2. Recreate the enum without `replit`. Postgres cannot drop a
--      single value from an enum in-place, so we rename the old type,
--      create the new one, alter the column to use it, drop the old
--      type, and reset the default to `wallet`.

BEGIN;

UPDATE users SET auth_provider = 'wallet' WHERE auth_provider = 'replit';

ALTER TABLE users ALTER COLUMN auth_provider DROP DEFAULT;

ALTER TYPE auth_provider RENAME TO auth_provider_old;

CREATE TYPE auth_provider AS ENUM ('wallet', 'obc_agent');

ALTER TABLE users
  ALTER COLUMN auth_provider TYPE auth_provider
  USING auth_provider::text::auth_provider;

ALTER TABLE users
  ALTER COLUMN auth_provider SET DEFAULT 'wallet';

DROP TYPE auth_provider_old;

COMMIT;
