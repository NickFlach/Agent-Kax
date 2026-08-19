-- #247 (KAX-ADR-0001 Phase 1a): the immutable decision record, DARK.
--
-- Every consequential economic action must eventually produce a decision row
-- traceable to the exact policy that authorized it. Phase 1a lands the RECORD
-- with no writers and no policy engine: the shape exists, the trigger makes it
-- append-only, and #248 wires the first writer. policy_id stays a bare bigint
-- until Phase 1b adds the policies table and its FK.
--
-- capability/decision/reason_code are varchar, NEVER pgEnum — an enum makes
-- every new value a migration, and reason codes are exactly the kind of list
-- that grows in a hotfix.
CREATE TABLE IF NOT EXISTS authority_decisions (
  id             bigserial PRIMARY KEY,
  decision_id    text NOT NULL UNIQUE,
  actor          text NOT NULL,          -- principal, from lib/actor.ts
  on_behalf_of   text,                   -- set when a service acts for a principal
  principal      text,                   -- the authorizing owner, when known
  capability     varchar(64) NOT NULL,   -- varchar, NEVER a pgEnum
  resource       text,
  channel        varchar(32),
  asset          text,
  amount_minor   bigint,
  decision       varchar(24) NOT NULL,   -- allow | deny | require_approval
  reason_code    varchar(48),            -- policy_missing | principal_unparseable | revoked | ...
  tx_id          text,
  postings_hash  text,
  policy_id      bigint,                 -- null in Phase 1a; FK added in Phase 1b
  policy_document_hash text,
  correlation_id text,
  expires_at     timestamp,
  created_at     timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS authority_decisions_actor_idx ON authority_decisions (actor, created_at DESC);
CREATE INDEX IF NOT EXISTS authority_decisions_tx_idx ON authority_decisions (tx_id);

-- Append-only, enforced at the DATABASE level (pattern from
-- 0012_floor_ledger_append_only.sql): on managed Postgres the app connects as
-- the table owner and owners bypass GRANT/REVOKE, so a trigger is the guard
-- that fires for everyone. A decision, once recorded, is history — a
-- correction is a new superseding row, never an edit.
CREATE OR REPLACE FUNCTION authority_decisions_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'authority_decisions is append-only: % on a decision record is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS authority_decisions_no_mutate ON authority_decisions;
CREATE TRIGGER authority_decisions_no_mutate
  BEFORE UPDATE OR DELETE ON authority_decisions
  FOR EACH ROW EXECUTE FUNCTION authority_decisions_append_only();
