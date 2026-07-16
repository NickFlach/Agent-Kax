-- Idempotency registry for the credit ledger (ADR-0041 Phase 2 hardening).
-- One row per transaction, inserted in the SAME DB transaction as the postings.
-- Makes POST retries exactly-once: a replayed txId returns the original result
-- instead of double-applying (the adversarial review's #1 blocker — the ledger
-- is otherwise anti-idempotent because a retry chains from a moved head and
-- appends fresh rows).

CREATE TABLE IF NOT EXISTS credit_ledger_txids (
  tx_id         TEXT PRIMARY KEY,
  postings_hash TEXT NOT NULL,     -- canonical hash of the submitted postings
  head          TEXT NOT NULL,     -- chain head hash after this transaction
  entry_count   INTEGER NOT NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Append-only, like credit_ledger and floor_ledger: a recorded transaction's
-- idempotency record must never be rewritten.
CREATE OR REPLACE FUNCTION credit_ledger_txids_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'credit_ledger_txids is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS credit_ledger_txids_no_mutate ON credit_ledger_txids;
CREATE TRIGGER credit_ledger_txids_no_mutate
  BEFORE UPDATE OR DELETE ON credit_ledger_txids
  FOR EACH ROW EXECUTE FUNCTION credit_ledger_txids_append_only();
