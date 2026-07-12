-- 2026-07-12 — task #53: forgot-password reset by email.
--
-- Adds the 'password_reset' variant to auth_challenge_kind. Reset
-- tokens reuse the auth_challenges table: `challenge` holds the sha256
-- hex of the emailed token (never the raw token), claim_subject is the
-- user id, single-use via the `consumed` flag, 30 min TTL.
--
-- NOTE: the migration runner wraps each file in BEGIN/COMMIT. Postgres
-- allows ALTER TYPE ... ADD VALUE inside a transaction (PG 12+) only if
-- the new value is not used in the same transaction — so this file must
-- not INSERT/UPDATE any row with kind = 'password_reset'.

ALTER TYPE "auth_challenge_kind" ADD VALUE IF NOT EXISTS 'password_reset';
