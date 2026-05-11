-- 2026-05-11 — wallet + OBC-agent auth identities
--
-- Additive migration. Existing Replit-authenticated users keep working;
-- new auth paths use the new columns + table.
--
-- Apply manually: psql $DATABASE_URL -f 0001_wallet_and_agent_auth.sql
-- (or run via drizzle-kit migrate once you've generated metadata).

-- 1. New auth provider enum + column on users.
DO $$ BEGIN
  CREATE TYPE auth_provider AS ENUM ('replit', 'wallet', 'obc_agent');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS wallet_address VARCHAR UNIQUE,
  ADD COLUMN IF NOT EXISTS obc_bot_id VARCHAR UNIQUE,
  ADD COLUMN IF NOT EXISTS auth_provider auth_provider NOT NULL DEFAULT 'replit';

-- 2. auth_challenges — short-lived SIWE nonces + agent verification phrases.
DO $$ BEGIN
  CREATE TYPE auth_challenge_kind AS ENUM ('wallet_nonce', 'agent_challenge');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS auth_challenges (
  id             VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  kind           auth_challenge_kind NOT NULL,
  challenge      TEXT NOT NULL,
  claim_subject  VARCHAR NOT NULL,
  consumed       BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at     TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_auth_challenges_kind_subject ON auth_challenges (kind, claim_subject);
CREATE INDEX IF NOT EXISTS idx_auth_challenges_expires      ON auth_challenges (expires_at);
