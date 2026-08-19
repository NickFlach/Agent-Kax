-- #266 (KAX-ADR-0001 Phase 1b): policy storage, versioning, limit reservations.
--
-- authority_policies: IMMUTABLE rows, one per version. An edit INSERTs a new
-- row and stamps superseded_at on the prior one; nothing is UPDATEd in place
-- beyond that single stamp. Decisions reference the policy ROW (policy_id FK,
-- added here — it has been a bare bigint since 0034) plus its document hash,
-- because an integer version alone cannot prove which document authorized a
-- historical action.
CREATE TABLE IF NOT EXISTS authority_policies (
  id             bigserial PRIMARY KEY,
  principal      text NOT NULL,          -- lib/actor.ts spelling, collapsed via botIdOfPrincipal
  version        integer NOT NULL,
  document       jsonb NOT NULL,
  document_hash  text NOT NULL,          -- sha256 of the canonical document
  effective_from timestamp NOT NULL DEFAULT now(),
  superseded_at  timestamp,              -- NULL = the current version
  created_by     text NOT NULL,
  created_at     timestamp NOT NULL DEFAULT now(),
  UNIQUE (principal, version)
);
-- The hot lookup: "the current policy for this principal", one partial-index hit.
CREATE INDEX IF NOT EXISTS authority_policies_current_idx
  ON authority_policies (principal) WHERE superseded_at IS NULL;

-- Immutability with ONE permitted transition: superseded_at NULL -> value,
-- once, with every other column untouched. Everything else is refused at the
-- DATABASE level (0012/0034 pattern: the app connects as table owner, so a
-- trigger is the guard that fires for everyone).
CREATE OR REPLACE FUNCTION authority_policies_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'authority_policies is append-only: DELETE is not permitted';
  END IF;
  IF OLD.superseded_at IS NOT NULL
     OR NEW.superseded_at IS NULL
     OR NEW.id            IS DISTINCT FROM OLD.id
     OR NEW.principal     IS DISTINCT FROM OLD.principal
     OR NEW.version       IS DISTINCT FROM OLD.version
     OR NEW.document      IS DISTINCT FROM OLD.document
     OR NEW.document_hash IS DISTINCT FROM OLD.document_hash
     OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
     OR NEW.created_by    IS DISTINCT FROM OLD.created_by
     OR NEW.created_at    IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'authority_policies rows are immutable except stamping superseded_at once';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS authority_policies_no_mutate ON authority_policies;
CREATE TRIGGER authority_policies_no_mutate
  BEFORE UPDATE OR DELETE ON authority_policies
  FOR EACH ROW EXECUTE FUNCTION authority_policies_immutable();

-- The FK authority_decisions.policy_id has waited for since 0034.
DO $$ BEGIN
  ALTER TABLE authority_decisions
    ADD CONSTRAINT authority_decisions_policy_id_fk
    FOREIGN KEY (policy_id) REFERENCES authority_policies(id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Limit reservations. One usage row per (principal, capability, asset,
-- discrete window), incremented under a ROW-LEVEL lock on that row — NEVER
-- under pg_advisory_xact_lock(0x1ed6e401), so cap accounting does not
-- serialize behind every unrelated ledger append.
CREATE TABLE IF NOT EXISTS authority_usage (
  id          bigserial PRIMARY KEY,
  principal   text NOT NULL,
  capability  varchar(64) NOT NULL,    -- varchar, NEVER a pgEnum
  asset       text NOT NULL,
  window_key  text NOT NULL,           -- 'day:2026-08-18' | 'month:2026-08' (UTC)
  used_minor  bigint NOT NULL DEFAULT 0,
  updated_at  timestamp NOT NULL DEFAULT now(),
  UNIQUE (principal, capability, asset, window_key)
);

-- Individual reservations: reserved -> submitted -> outcome_unknown ->
-- committed | released. Carries the exact canonical posting array to be
-- reproduced byte-for-byte on commit, because canonicalPostingsHash is
-- order-, asset- and ref-sensitive and a differing retry raises
-- LedgerIdempotencyConflict.
CREATE TABLE IF NOT EXISTS authority_reservations (
  id             bigserial PRIMARY KEY,
  reservation_id text NOT NULL UNIQUE,
  usage_id       bigint NOT NULL REFERENCES authority_usage(id),
  principal      text NOT NULL,
  capability     varchar(64) NOT NULL,
  asset          text NOT NULL,
  amount_minor   bigint NOT NULL,
  state          varchar(24) NOT NULL DEFAULT 'reserved',
  tx_id          text,
  postings       jsonb NOT NULL,
  postings_hash  text NOT NULL,
  created_at     timestamp NOT NULL DEFAULT now(),
  updated_at     timestamp NOT NULL DEFAULT now()
);
-- The ageing-alert query: outcome_unknown rows older than a threshold.
CREATE INDEX IF NOT EXISTS authority_reservations_state_idx
  ON authority_reservations (state, created_at);
