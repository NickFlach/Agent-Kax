-- Double-entry, append-only, hash-chained credit ledger (ADR-0041 Phase 2).
-- Balances are derived (SUM(amount) per account+asset); amounts are integer
-- minor units (bigint). Each entry chains to the previous via prev_hash; the
-- UNIQUE(prev_hash) makes forks impossible, and an append-only trigger makes
-- the whole thing immutable against any writer.

CREATE TABLE IF NOT EXISTS credit_ledger (
  seq        BIGSERIAL PRIMARY KEY,
  entry_hash TEXT NOT NULL UNIQUE,
  prev_hash  TEXT NOT NULL,
  tx_id      TEXT NOT NULL,
  asset      TEXT NOT NULL,
  account    TEXT NOT NULL,
  amount     BIGINT NOT NULL,
  kind       TEXT NOT NULL,
  ref        TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS credit_ledger_account_asset_idx ON credit_ledger (account, asset);
CREATE INDEX IF NOT EXISTS credit_ledger_tx_idx ON credit_ledger (tx_id);
CREATE UNIQUE INDEX IF NOT EXISTS credit_ledger_prev_hash_uq ON credit_ledger (prev_hash);

-- Append-only: reject UPDATE/DELETE for every writer (a trigger, not a REVOKE,
-- because the app owns the table and owners bypass grants). Mirrors the
-- floor_ledger immutability from migration 0012.
CREATE OR REPLACE FUNCTION credit_ledger_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'credit_ledger is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS credit_ledger_no_mutate ON credit_ledger;
CREATE TRIGGER credit_ledger_no_mutate
  BEFORE UPDATE OR DELETE ON credit_ledger
  FOR EACH ROW EXECUTE FUNCTION credit_ledger_append_only();
