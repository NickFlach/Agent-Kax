-- #246: supporting index for the per-account inflow primitive.
--
-- accountInflow / accountInflowTx sum positive postings for one
-- (account, asset, kind) since an instant. The Tx variant runs INSIDE
-- postTransaction's advisory lock, so it must be a single indexed read —
-- a seq scan under the lock would serialize every ledger append behind a
-- table walk that grows with history.
CREATE INDEX IF NOT EXISTS credit_ledger_account_kind_created_idx
  ON credit_ledger (account, asset, kind, created_at);
