-- Bluesky handle <-> OBC bot attestation, mirroring the npub pair.
--
-- Deliberately only this table: the enum value and the columns, nothing that
-- depends on another table existing. A migration runs in one transaction, and
-- coupling unrelated objects into it is how a rollback loses the thing you
-- actually came to add (see 0020).

ALTER TYPE auth_challenge_kind ADD VALUE IF NOT EXISTS 'bsky_bind_challenge';

ALTER TABLE user_bots ADD COLUMN IF NOT EXISTS bsky_handle varchar;
ALTER TABLE user_bots ADD COLUMN IF NOT EXISTS bsky_verified_at timestamptz;

-- A handle attests to at most one bot. Partial, so the many NULLs coexist —
-- the same shape as idx_user_bots_npub_unique.
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_bots_bsky_unique
  ON user_bots (bsky_handle) WHERE bsky_handle IS NOT NULL;
