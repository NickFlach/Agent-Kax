-- npub↔bot attestation (ADR-0043 Phase 0, Plane 1). Binds a self-sovereign
-- Nostr key (npub) to an already-attached OBC bot, so KAX can attest the
-- binding: the KEY is portable, the REPUTATION (KAX ledger, OBC elder status)
-- stays anchored here and queryable.
--
-- The binding is the third leg of a three-legged proof (see auth-agent.ts):
--   1. wallet JWT      → proves the KAX user
--   2. user_bots row   → proves bot↔user (existing artifact-nonce flow)
--   3. Schnorr sig     → proves control of the npub AND commits it to this
--                        exact bot+user+nonce (this column records the result)
--
-- One npub binds to at most one bot (partial UNIQUE, non-null only). A bot
-- carries at most one npub (the column lives on user_bots). Rebinding is an
-- explicit UPDATE by the same owner; there is no silent takeover because the
-- verify path re-checks the user_bots owner.

-- New challenge variant for the binding nonce. Safe in this file's
-- transaction: PG forbids USING a freshly-added enum value in the same tx,
-- and this migration never inserts a row with kind = 'npub_bind_challenge'
-- (that happens at runtime, in the endpoint's own transaction).
ALTER TYPE "auth_challenge_kind" ADD VALUE IF NOT EXISTS 'npub_bind_challenge';

ALTER TABLE user_bots
  ADD COLUMN IF NOT EXISTS npub TEXT,
  ADD COLUMN IF NOT EXISTS npub_verified_at TIMESTAMP WITH TIME ZONE;

-- An npub may attest to only one bot. Partial so the many NULLs don't collide.
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_bots_npub_unique
  ON user_bots (npub)
  WHERE npub IS NOT NULL;
