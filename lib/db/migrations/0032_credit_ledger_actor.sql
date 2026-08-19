-- #245: record WHO authorized each ledger transaction.
--
-- The columns live on credit_ledger_txids (per-transaction), NOT on
-- credit_ledger (per-posting), and are deliberately OUTSIDE the hashed tuple:
-- adding a field to computeEntryHash or canonicalPostingsHash would change
-- every entry hash and every stored postings_hash, invalidating the whole
-- existing chain and turning every prior idempotency record into a conflict.
--
-- Nullable: rows recorded before this migration have no actor, and a
-- backfilled guess would be worse than an honest NULL. The write path
-- requires an actor from here on (PostTxInput.actor is a required field).
--
-- decision_id is reserved for #248 (an authority_decisions row per write);
-- added now so the txids row shape changes once, not twice.
--
-- The append-only trigger credit_ledger_txids_no_mutate fires on
-- UPDATE/DELETE only, so ADD COLUMN is unaffected.
ALTER TABLE credit_ledger_txids ADD COLUMN IF NOT EXISTS actor text;
ALTER TABLE credit_ledger_txids ADD COLUMN IF NOT EXISTS decision_id text;
CREATE INDEX IF NOT EXISTS credit_ledger_txids_actor_idx ON credit_ledger_txids (actor);
