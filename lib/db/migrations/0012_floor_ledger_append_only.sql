-- ADR-0041: the Floor Ledger is an append-only witness record. Enforce
-- immutability at the DATABASE level (not just app code) so no writer — a
-- stray script, a leaked service token, or a future code path — can rewrite
-- or delete a witnessed settlement. A row is inserted once; corrections are
-- new superseding rows.
--
-- A trigger is used rather than a REVOKE grant because on managed Postgres the
-- app connects as the table owner, and owners bypass GRANT/REVOKE. The trigger
-- fires for everyone. INSERT ... ON CONFLICT DO NOTHING does not fire an UPDATE
-- trigger, so idempotent re-posts still work.

CREATE OR REPLACE FUNCTION floor_ledger_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'floor_ledger is append-only: % on a witnessed deal is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS floor_ledger_no_mutate ON floor_ledger;
CREATE TRIGGER floor_ledger_no_mutate
  BEFORE UPDATE OR DELETE ON floor_ledger
  FOR EACH ROW EXECUTE FUNCTION floor_ledger_append_only();
