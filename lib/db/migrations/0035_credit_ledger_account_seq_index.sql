-- #250: supporting index for GET /ledger/my/statement.
--
-- The statement pages one account's postings by seq DESC with a keyset
-- cursor; without this the read walks credit_ledger_account_asset_idx and
-- sorts, which grows with the account's whole history on every page.
CREATE INDEX IF NOT EXISTS credit_ledger_account_seq_idx
  ON credit_ledger (account, asset, seq DESC);
