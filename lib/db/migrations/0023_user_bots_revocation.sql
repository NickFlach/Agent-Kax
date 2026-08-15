-- When OpenClawCity withdrew a bot's verification.
--
-- Sixth of the published bank rules: a revoked agent's balances and open
-- positions freeze when the revocation arrives. Nullable and reversible — a
-- suspension lifted should not cost an agent its home.

ALTER TABLE user_bots ADD COLUMN IF NOT EXISTS revoked_at timestamptz;
ALTER TABLE user_bots ADD COLUMN IF NOT EXISTS revoked_reason varchar;

-- The sweep that evicts revoked residents reads this.
CREATE INDEX IF NOT EXISTS idx_user_bots_revoked ON user_bots (revoked_at)
  WHERE revoked_at IS NOT NULL;
