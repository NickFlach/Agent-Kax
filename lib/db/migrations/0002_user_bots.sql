-- 2026-05-11 — wallet-primary auth: one wallet user → many attached OBC bots
--
-- Companion to 0001_wallet_and_agent_auth.sql. Additive + idempotent.
-- Apply manually: psql $DATABASE_URL -f 0002_user_bots.sql
-- (or rely on `pnpm --filter @workspace/db run push`, which syncs the
-- drizzle schema).
--
-- Notes:
--   * users.obc_bot_id from 0001 is intentionally preserved (not dropped).
--     It's used to grandfather any legacy `obc_agent:<userId>` sessions
--     that were issued between 0001 and this migration. The OIDC strip
--     task removes it.
--   * Backfills any existing users.obc_bot_id values into user_bots so
--     legacy obc_agent users don't lose their attached bot when they
--     eventually link a wallet.

CREATE TABLE IF NOT EXISTS user_bots (
  id            VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       VARCHAR NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  obc_bot_id    VARCHAR NOT NULL UNIQUE,
  display_name  VARCHAR,
  attached_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_bots_user ON user_bots (user_id);

-- Backfill: every existing users.obc_bot_id becomes a user_bots row,
-- pointed at the same user. ON CONFLICT keeps the migration idempotent.
-- Bot ids are normalized to lowercase here to match the application's
-- write path (lowercased before INSERT) and keep the UNIQUE semantics
-- meaningful even if any historic mixed-case ids leaked in.
INSERT INTO user_bots (user_id, obc_bot_id, display_name, attached_at)
SELECT id, lower(obc_bot_id), display_name, COALESCE(created_at, NOW())
FROM users
WHERE obc_bot_id IS NOT NULL
ON CONFLICT (obc_bot_id) DO NOTHING;
