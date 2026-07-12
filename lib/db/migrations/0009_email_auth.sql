-- 2026-07-12 — task #52: email + password sign-in alongside wallet.
--
-- Adds:
--   1. users.password_hash — scrypt-hashed password for the email door.
--      Nullable: wallet-only users have no password until they link one.
--   2. 'email' variant on auth_provider — rows created via
--      POST /auth/email/register.
--
-- NOTE: the migration runner wraps each file in BEGIN/COMMIT. Postgres
-- allows ALTER TYPE ... ADD VALUE inside a transaction (PG 12+) only if
-- the new value is not used in the same transaction — so this file must
-- not INSERT/UPDATE any row with auth_provider = 'email'.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "password_hash" varchar;

ALTER TYPE "auth_provider" ADD VALUE IF NOT EXISTS 'email';
