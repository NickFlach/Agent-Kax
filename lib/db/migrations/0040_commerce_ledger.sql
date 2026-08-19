-- #265 (KAX-ADR-0002, v0.2): the fiat ledger, DARK — no route posts to it.
--
-- A SEPARATE chain from credit_ledger on purpose: one linear chain and one
-- global advisory lock per ledger, an asset-blind verifyChain, and a fiat
-- asset never enters ALLOWED_ASSETS. The known defect this avoids repeating:
-- floor_ledger landed as a third value store with no reconciliation, single-
-- entry, float4 — so this one ships double-entry, integer cents, hash-chained,
-- WITH its reconciliation query in the same PR.
CREATE TABLE IF NOT EXISTS commerce_ledger (
  seq         bigserial PRIMARY KEY,
  entry_hash  text NOT NULL UNIQUE,
  prev_hash   text NOT NULL,
  tx_id       text NOT NULL,
  currency    varchar(8) NOT NULL,          -- explicit ISO currency; 'usd' in v0.2
  account     text NOT NULL,                -- grammar in lib/commerceLedger.ts
  amount_cents bigint NOT NULL,             -- signed integer cents
  kind        varchar(32) NOT NULL,
  ref         text,
  created_at  timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS commerce_ledger_account_idx ON commerce_ledger (account, currency);
CREATE INDEX IF NOT EXISTS commerce_ledger_tx_idx ON commerce_ledger (tx_id);
CREATE INDEX IF NOT EXISTS commerce_ledger_ref_idx ON commerce_ledger (ref);
CREATE UNIQUE INDEX IF NOT EXISTS commerce_ledger_prev_hash_uq ON commerce_ledger (prev_hash);

CREATE TABLE IF NOT EXISTS commerce_ledger_txids (
  tx_id         text PRIMARY KEY,
  postings_hash text NOT NULL,
  head          text NOT NULL,
  entry_count   integer NOT NULL,
  actor         text,
  decision_id   text,
  created_at    timestamp NOT NULL DEFAULT now()
);

-- Append-only at the database level, the 0012/0034 pattern.
CREATE OR REPLACE FUNCTION commerce_ledger_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'commerce_ledger is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS commerce_ledger_no_mutate ON commerce_ledger;
CREATE TRIGGER commerce_ledger_no_mutate
  BEFORE UPDATE OR DELETE ON commerce_ledger
  FOR EACH ROW EXECUTE FUNCTION commerce_ledger_append_only();

DROP TRIGGER IF EXISTS commerce_ledger_txids_no_mutate ON commerce_ledger_txids;
CREATE TRIGGER commerce_ledger_txids_no_mutate
  BEFORE UPDATE OR DELETE ON commerce_ledger_txids
  FOR EACH ROW EXECUTE FUNCTION commerce_ledger_append_only();
